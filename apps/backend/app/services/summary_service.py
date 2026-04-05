"""Summarisation service — filtering, token-aware chunking, multi-style prompts,
day-grouped commits, issue extraction, merge pass, and Ollama-unavailable fallback.

Flow:
  1. Fetch commits from DB for (repo, date-range).
  2. Filter out noise (merge-only, trivial typo fixes, etc.).
  3. Extract issue/PR references from subjects and bodies.
  4. Group remaining commits by day.
  5. Chunk the day-groups using a token-budget estimator.
  6. Summarise each chunk with a style-specific prompt (includes references).
  7. If multiple chunks, run a merge pass.
  8. Persist the result.
  If Ollama is unreachable, produce a deterministic local-only fallback.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from itertools import islice
from typing import Sequence

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import CommitRecord, SummaryJob, SummaryResult
from app.repositories.commit_repository import CommitRepository
from app.repositories.repo_repository import RepoRepository
from app.repositories.summary_repository import SummaryRepository
from app.services import ollama_service

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# 1.  Commit filtering
# ═══════════════════════════════════════════════════════════════════════════

_NOISE_PATTERNS: list[re.Pattern] = [
    re.compile(r"^Merge (branch|pull request|remote-tracking)", re.IGNORECASE),
    re.compile(r"^Merge .+ into .+$", re.IGNORECASE),
    re.compile(r"^(fix|correct)\s+(typo|whitespace|spelling)\b", re.IGNORECASE),
    re.compile(r"^(fix|correct)\s+grammar\b", re.IGNORECASE),
    re.compile(r"^formatting[\s:.\-]*$", re.IGNORECASE),
    re.compile(r"^(code\s+)?fmt\b", re.IGNORECASE),
    re.compile(r"^ran?\s+(prettier|black|gofmt|clang-format)", re.IGNORECASE),
    re.compile(r"^bump\s+version\s+to\b", re.IGNORECASE),
    re.compile(r"^(chore|build)\(deps\):\s*bump\b", re.IGNORECASE),
    re.compile(r"^\[bot\]\s", re.IGNORECASE),
    re.compile(r"^auto-?commit", re.IGNORECASE),
]

def _is_noisy(commit: CommitRecord) -> bool:
    subject = commit.subject.strip()
    return any(pat.search(subject) for pat in _NOISE_PATTERNS)

def filter_commits(commits: Sequence[CommitRecord]) -> tuple[list[CommitRecord], int]:
    """Return (kept, filtered_count)."""
    kept: list[CommitRecord] = []
    filtered = 0
    for c in commits:
        if _is_noisy(c):
            filtered += 1
        else:
            kept.append(c)
    return kept, filtered

# ═══════════════════════════════════════════════════════════════════════════
# 2.  Issue / PR reference extraction
# ═══════════════════════════════════════════════════════════════════════════

# Matches: #123, GH-123, org/repo#45, JIRA-456, PROJECT-789
_REF_PATTERNS = [
    re.compile(r"(?:^|[\s(])#(\d+)\b"),                       # #123, (#123)
    re.compile(r"\bGH-(\d+)\b", re.IGNORECASE),               # GH-123
    re.compile(r"([\w.\-]+/[\w.\-]+)#(\d+)"),                 # org/repo#45
    re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b"),                  # JIRA-456, PROJ-123
    re.compile(r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", re.IGNORECASE),
]

class IssueRef:
    """A reference to an issue or PR found in commit messages."""

    __slots__ = ("raw", "commits")

    def __init__(self, raw: str):
        self.raw = raw
        self.commits: list[str] = []  # short hashes

    def __repr__(self) -> str:
        return f"IssueRef({self.raw}, commits={self.commits})"

def extract_references(commits: Sequence[CommitRecord]) -> dict[str, IssueRef]:
    """Scan commit subjects and bodies for issue/PR references.

    Returns a dict keyed by normalised reference string.
    """
    refs: dict[str, IssueRef] = {}

    for c in commits:
        text = f"{c.subject}\n{c.body}"
        found: set[str] = set()

        for pat in _REF_PATTERNS:
            for m in pat.finditer(text):
                # Normalise: use the full match or the most specific group
                if m.lastindex and m.lastindex >= 2:
                    # org/repo#45 pattern
                    raw = f"{m.group(1)}#{m.group(2)}"
                elif m.lastindex:
                    raw = f"#{m.group(1)}" if m.group(1).isdigit() else m.group(1)
                else:
                    raw = m.group(0).strip()
                found.add(raw)

        for raw in found:
            # Normalise GH-N → #N to avoid duplicates
            normalised = re.sub(r"^GH-(\d+)$", r"#\1", raw, flags=re.IGNORECASE)
            if normalised not in refs:
                refs[normalised] = IssueRef(normalised)
            refs[normalised].commits.append(c.commit_hash[:7])

    # Deduplicate commit lists within each ref
    for ref in refs.values():
        ref.commits = list(dict.fromkeys(ref.commits))

    return refs

def _format_references_block(refs: dict[str, IssueRef]) -> str:
    """Format references as a markdown list for inclusion in prompts."""
    if not refs:
        return ""
    lines = ["REFERENCED ISSUES/PRs:"]
    for raw, ref in sorted(refs.items()):
        commits_str = ", ".join(ref.commits[:10])
        lines.append(f"  {raw}  (commits: {commits_str})")
    return "\n".join(lines)

# ═══════════════════════════════════════════════════════════════════════════
# 3.  Day grouping
# ═══════════════════════════════════════════════════════════════════════════

DayGroup = tuple[str, list[CommitRecord]]  # ("2025-03-18", [commits…])

def group_by_day(commits: list[CommitRecord]) -> list[DayGroup]:
    """Return commits grouped by date, oldest day first, commits within a day
    ordered chronologically.  Deterministic."""
    by_day: dict[str, list[CommitRecord]] = defaultdict(list)
    for c in sorted(commits, key=lambda c: c.committed_at):
        day = c.committed_at.strftime("%Y-%m-%d")
        by_day[day].append(c)
    return sorted(by_day.items())

# ═══════════════════════════════════════════════════════════════════════════
# 4.  Token-aware chunking
# ═══════════════════════════════════════════════════════════════════════════

_CHARS_PER_TOKEN = 4

def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)

def _format_commit_line(c: CommitRecord) -> str:
    body_preview = c.body.strip().replace("\n", " ")[:120] if c.body else ""
    line = f"- [{c.commit_hash[:7]}] {c.subject.strip()}  ({c.author_name}, {c.committed_at:%Y-%m-%d})"
    if body_preview:
        line += f"\n  {body_preview}"
    return line

def _format_day_group(day: str, commits: list[CommitRecord]) -> str:
    header = f"### {day} ({len(commits)} commit{'s' if len(commits) != 1 else ''})"
    lines = [_format_commit_line(c) for c in commits]
    return header + "\n" + "\n".join(lines)

def chunk_by_token_budget(
    day_groups: list[DayGroup],
    token_budget: int,
) -> list[list[DayGroup]]:
    """Split day-groups into chunks that each fit within *token_budget*."""
    chunks: list[list[DayGroup]] = []
    current_chunk: list[DayGroup] = []
    current_tokens = 0

    for day, commits in day_groups:
        block = _format_day_group(day, commits)
        block_tokens = _estimate_tokens(block)

        if block_tokens > token_budget:
            if current_chunk:
                chunks.append(current_chunk)
                current_chunk = []
                current_tokens = 0
            chunks.append([(day, commits)])
            continue

        if current_tokens + block_tokens > token_budget and current_chunk:
            chunks.append(current_chunk)
            current_chunk = []
            current_tokens = 0

        current_chunk.append((day, commits))
        current_tokens += block_tokens

    if current_chunk:
        chunks.append(current_chunk)

    return chunks

# ═══════════════════════════════════════════════════════════════════════════
# 5.  Prompt templates — three styles
# ═══════════════════════════════════════════════════════════════════════════

_SYSTEM_PREAMBLE = """\
You are a software-engineering progress analyst.  You are summarising git \
commits for **project-progress tracking**.

Repository: {repo_name}
Period: {start_date} to {end_date}
Chunk: {chunk_index} of {total_chunks}

GLOBAL RULES (apply to every style):
- Commits have ALREADY been pre-filtered to remove merge-only, trivial \
  typo/formatting, bot auto-commits, and isolated version bumps.  Do not \
  mention the filtering.
- Group related commits into coherent work items.
- When a commit message references an issue or PR (e.g. #123, JIRA-456, \
  GH-42, org/repo#10), ALWAYS include that reference in your output next \
  to the relevant work item using the format `#123` or `JIRA-456`.
- Highlight risk: partially finished features, repeated reverts, recurring \
  bug-fix areas, or patterns that suggest instability.
- Flag unfinished work or items that clearly need follow-up.
- Note repetitive themes (e.g. the same module being touched repeatedly).
- Output valid Markdown.
"""

# ── Shared issue-progress section injected into every style ──

_ISSUE_PROGRESS_SECTION = """
## Issue Progress
<!-- For each issue/PR number referenced in the commits, list:
  - The reference (e.g. #123, JIRA-456)
  - What commits contributed to it (use [short-hash] format)
  - Current apparent status: started, in progress, done/closed, or unclear
  If no issues are referenced, write "No issue references found in this batch." -->
"""

_COMMIT_REFS_SECTION = """
## Key Commit References
<!-- List the 5-10 most significant commits by [short-hash] with a one-line \
description of what each does.  Prioritise commits that fix bugs, add features, \
or introduce risk over routine changes. -->
"""

# ── Short ──

_SHORT_INSTRUCTIONS = """
Produce a **concise** summary (aim for 200-400 words).  Use this structure:

## Summary
<!-- 3-5 bullet points covering the most important changes.  Include commit \
refs [abc1234] and issue refs #123 inline. -->
{issue_progress_section}
## Risks & Open Items
<!-- Anything that needs attention — write "None" if nothing stands out -->
"""

# ── Detailed (engineering) ──

_DETAILED_INSTRUCTIONS = """
Produce a **thorough engineering summary**.  Use EXACTLY these section \
headings.  Write "None" under a heading if nothing applies.

## High-Level Summary
<!-- 2-4 sentence overview -->

## Themes / Epics
<!-- Grouped related work streams with bullet points.  Include commit \
refs [abc1234] and issue refs #123 inline with each item. -->

## Bug Fixes
<!-- List of bugs addressed, with commit refs and issue refs -->

## Refactors / Cleanup
<!-- Code quality, tech-debt, and structural improvements -->

## Infra / Tooling
<!-- CI, build, deploy, dependency, and developer-tooling changes -->

## Notable Breaking Changes
<!-- Anything that could break downstream consumers or workflows -->
{issue_progress_section}{commit_refs_section}
## Risks & Open Items
<!-- Unfinished work, repeated failures, items needing follow-up -->

## Suggested Weekly Status Update
<!-- A concise 3-5 bullet summary suitable for a stand-up or status email -->
"""

# ── Manager-friendly ──

_MANAGER_INSTRUCTIONS = """
Produce a **manager-friendly progress update** — non-technical language, \
focused on outcomes and business impact.  Use this structure:

## What Got Done
<!-- Bullet list of accomplished work, phrased in terms of features / \
outcomes.  Include issue refs (#123) where available so readers can \
look up details. -->

## In Progress
<!-- Work that was started but not finished — what is the current state? \
Include issue refs. -->
{issue_progress_section}
## Blockers & Risks
<!-- Anything that could delay delivery or needs a decision -->

## Key Metrics
<!-- Number of commits, active contributors, areas of highest activity -->

## Recommended Status Update
<!-- 2-3 sentences suitable for an executive email or Slack post -->
"""

def _get_style_instructions(style: str, has_refs: bool) -> str:
    """Return style instructions with issue sections conditionally filled."""
    issue_section = _ISSUE_PROGRESS_SECTION if has_refs else """
## Issue Progress
<!-- No issue references found in this batch. -->
"""
    commit_section = _COMMIT_REFS_SECTION

    templates = {
        "short": _SHORT_INSTRUCTIONS,
        "detailed": _DETAILED_INSTRUCTIONS,
        "manager": _MANAGER_INSTRUCTIONS,
    }
    template = templates.get(style, _DETAILED_INSTRUCTIONS)
    return template.format(
        issue_progress_section=issue_section,
        commit_refs_section=commit_section,
    )

# ── Merge prompt ──

_MERGE_PROMPT = """\
You are a software-engineering progress analyst.  Below are partial summaries \
of git commits for the repository **{repo_name}** covering {start_date} to \
{end_date}.

Merge them into ONE coherent summary.

RULES:
- De-duplicate: if the same work item appears in multiple partials, combine.
- Preserve ALL section headings from the partials — do not drop any.
- The "Issue Progress" section must merge issue references from all partials.  \
  If the same issue appears in multiple partials, combine the commit lists and \
  update the status to reflect the overall state.
- The final "Suggested Weekly Status Update" / "Recommended Status Update" \
  must reflect the ENTIRE period.
- Keep highlighting risk, unfinished work, and repetitive themes.

PARTIAL SUMMARIES:
{partials}
"""

def _build_chunk_prompt(
    *,
    repo_name: str,
    start_date: str,
    end_date: str,
    chunk_index: int,
    total_chunks: int,
    style: str,
    day_groups: list[DayGroup],
    refs: dict[str, IssueRef],
) -> str:
    commits_text = "\n\n".join(
        _format_day_group(day, commits) for day, commits in day_groups
    )
    total_commits = sum(len(commits) for _, commits in day_groups)
    preamble = _SYSTEM_PREAMBLE.format(
        repo_name=repo_name,
        start_date=start_date,
        end_date=end_date,
        chunk_index=chunk_index,
        total_chunks=total_chunks,
    )
    instructions = _get_style_instructions(style, bool(refs))
    refs_block = _format_references_block(refs)
    parts = [preamble, instructions, f"\nCOMMITS ({total_commits}):", commits_text]
    if refs_block:
        parts.append(f"\n{refs_block}")
    return "\n".join(parts)

# ═══════════════════════════════════════════════════════════════════════════
# 6.  Local fallback when Ollama is unreachable
# ═══════════════════════════════════════════════════════════════════════════

def _build_fallback_summary(
    repo_name: str,
    start_date: str,
    end_date: str,
    day_groups: list[DayGroup],
    filtered_count: int,
    refs: dict[str, IssueRef],
) -> str:
    """Deterministic, no-LLM summary built from raw commit data."""
    total = sum(len(cs) for _, cs in day_groups)
    authors: dict[str, int] = defaultdict(int)
    for _, cs in day_groups:
        for c in cs:
            authors[c.author_name] += 1
    top_authors = sorted(authors.items(), key=lambda x: -x[1])[:5]

    lines = [
        f"# Commit Summary — {repo_name}",
        f"**Period:** {start_date} to {end_date}  ",
        f"**Commits analysed:** {total} ({filtered_count} noisy commits filtered)  ",
        f"**Active days:** {len(day_groups)}  ",
        "",
        "## Top Contributors",
    ]
    for name, count in top_authors:
        lines.append(f"- {name}: {count} commit{'s' if count != 1 else ''}")

    # Issue progress (deterministic)
    lines += ["", "## Issue Progress"]
    if refs:
        for raw, ref in sorted(refs.items()):
            commits_str = ", ".join(f"`{h}`" for h in ref.commits[:10])
            lines.append(f"- **{raw}** — referenced in {commits_str}")
    else:
        lines.append("No issue references found in this batch.")

    lines += ["", "## Activity by Day"]
    for day, cs in day_groups:
        lines.append(f"### {day} ({len(cs)} commits)")
        for c in islice(cs, 15):
            lines.append(f"- `{c.commit_hash[:7]}` {c.subject.strip()} — *{c.author_name}*")
        if len(cs) > 15:
            lines.append(f"- … and {len(cs) - 15} more")

    lines += [
        "",
        "---",
        "*This is a raw fallback summary generated without an LLM because "
        "Ollama was unreachable.  Re-run when Ollama is available for a "
        "richer analysis.*",
    ]
    return "\n".join(lines)

# ═══════════════════════════════════════════════════════════════════════════
# 7.  Public entry point
# ═══════════════════════════════════════════════════════════════════════════

async def create_and_run_summary(
    job: SummaryJob,
    db: Session,
) -> SummaryResult:
    repo_repo = RepoRepository(db)
    commit_repo = CommitRepository(db)
    summary_repo = SummaryRepository(db)

    repo = repo_repo.get_by_id(job.repository_id)
    if repo is None:
        raise ValueError(f"Repository {job.repository_id} not found")

    summary_repo.set_status(job, "running")

    # ── Fetch & filter ──
    raw_commits = commit_repo.list_by_repo_and_range(
        job.repository_id, job.start_date, job.end_date
    )
    if not raw_commits:
        return summary_repo.add_result(
            job,
            summary_markdown="_No commits found in the selected date range._",
            commit_count=0,
        )

    commits, filtered_count = filter_commits(raw_commits)
    if not commits:
        return summary_repo.add_result(
            job,
            summary_markdown=(
                f"_All {len(raw_commits)} commits in this range were filtered "
                f"as noise (merge-only, trivial typo/formatting, bot commits)._"
            ),
            commit_count=0,
        )

    logger.info(
        "Commits: %d total, %d kept, %d filtered for %s",
        len(raw_commits), len(commits), filtered_count, repo.name,
    )

    # ── Extract issue/PR references ──
    refs = extract_references(commits)
    if refs:
        logger.info(
            "Found %d issue/PR references: %s",
            len(refs), ", ".join(sorted(refs.keys())),
        )

    # ── Group by day (deterministic order) ──
    day_groups = group_by_day(commits)

    start_str = f"{job.start_date:%Y-%m-%d}"
    end_str = f"{job.end_date:%Y-%m-%d}"
    style = job.summary_style or "detailed"

    # ── Token-aware chunking ──
    chunks = chunk_by_token_budget(day_groups, settings.summary_token_budget)
    total_chunks = len(chunks)

    logger.info(
        "Summarising %d commits for %s in %d chunk(s), style=%s, model=%s",
        len(commits), repo.name, total_chunks, style, job.model_name,
    )

    # ── Generate via LLM (with fallback) ──
    try:
        partial_summaries: list[str] = []
        for idx, chunk_groups in enumerate(chunks, 1):
            # Collect refs for commits in this chunk only
            chunk_commits = [c for _, cs in chunk_groups for c in cs]
            chunk_refs = extract_references(chunk_commits)

            prompt = _build_chunk_prompt(
                repo_name=repo.name,
                start_date=start_str,
                end_date=end_str,
                chunk_index=idx,
                total_chunks=total_chunks,
                style=style,
                day_groups=chunk_groups,
                refs=chunk_refs,
            )
            partial = await ollama_service.generate(prompt, model=job.model_name)
            partial_summaries.append(partial)
            logger.info("Chunk %d/%d done (%d chars)", idx, total_chunks, len(partial))

        # ── Merge pass ──
        if total_chunks == 1:
            summary_md = partial_summaries[0]
        else:
            numbered = "\n\n".join(
                f"### Partial {i}\n{text}"
                for i, text in enumerate(partial_summaries, 1)
            )
            merge_prompt = _MERGE_PROMPT.format(
                repo_name=repo.name,
                start_date=start_str,
                end_date=end_str,
                partials=numbered,
            )
            summary_md = await ollama_service.generate(merge_prompt, model=job.model_name)
            logger.info("Merge pass done (%d chars)", len(summary_md))

    except (httpx.ConnectError, httpx.ConnectTimeout, OSError) as exc:
        logger.warning(
            "Ollama unreachable (%s) — falling back to local summary for job %s",
            exc, job.id,
        )
        summary_md = _build_fallback_summary(
            repo.name, start_str, end_str, day_groups, filtered_count, refs
        )
    except Exception as exc:
        logger.error("Summary generation failed for job %s: %s", job.id, exc)
        summary_repo.set_status(job, "failed")
        raise

    result = summary_repo.add_result(job, summary_md, len(commits))
    logger.info("Summary persisted for job %s (%d commits)", job.id, len(commits))
    return result

# ═══════════════════════════════════════════════════════════════════════════
# 8.  Branch-diff summary (no time bounds)
# ═══════════════════════════════════════════════════════════════════════════

_BRANCH_PREAMBLE = """\
You are a software-engineering progress analyst.  You are summarising the \
changes introduced by branch **{branch}** compared to **{base_branch}** in \
the repository **{repo_name}**.

This is a branch comparison, NOT a date-range summary.  Focus on what the \
branch introduces — the "diff" from the base.

Chunk: {chunk_index} of {total_chunks}

GLOBAL RULES:
- Commits have ALREADY been pre-filtered to remove noise.
- Group related commits into coherent work items / features.
- When a commit references an issue or PR, include that reference.
- Highlight risk: partially finished features, reverts, instability patterns.
- Flag anything that looks unfinished or needs follow-up before merge.
- Note if the branch touches a wide area of the codebase (risky merge).
- Output valid Markdown.
"""

def _build_branch_chunk_prompt(
    *,
    repo_name: str,
    branch: str,
    base_branch: str,
    chunk_index: int,
    total_chunks: int,
    style: str,
    day_groups: list[DayGroup],
    refs: dict[str, IssueRef],
) -> str:
    commits_text = "\n\n".join(
        _format_day_group(day, commits) for day, commits in day_groups
    )
    total_commits = sum(len(commits) for _, commits in day_groups)
    preamble = _BRANCH_PREAMBLE.format(
        repo_name=repo_name,
        branch=branch,
        base_branch=base_branch,
        chunk_index=chunk_index,
        total_chunks=total_chunks,
    )
    instructions = _get_style_instructions(style, bool(refs))
    refs_block = _format_references_block(refs)
    parts = [preamble, instructions, f"\nCOMMITS on {branch} vs {base_branch} ({total_commits}):", commits_text]
    if refs_block:
        parts.append(f"\n{refs_block}")
    return "\n".join(parts)

async def create_and_run_branch_summary(
    job: SummaryJob,
    branch_commits: list[CommitRecord],
    db: Session,
) -> SummaryResult:
    """Summarise commits from a branch diff (no date bounds)."""
    repo_repo = RepoRepository(db)
    summary_repo = SummaryRepository(db)

    repo = repo_repo.get_by_id(job.repository_id)
    if repo is None:
        raise ValueError(f"Repository {job.repository_id} not found")

    summary_repo.set_status(job, "running")

    branch = job.branch or "unknown"
    base_branch = job.base_branch or repo.default_branch or "main"

    if not branch_commits:
        return summary_repo.add_result(
            job,
            summary_markdown=f"_No commits found on `{branch}` that are not already in `{base_branch}`._",
            commit_count=0,
        )

    commits, filtered_count = filter_commits(branch_commits)
    if not commits:
        return summary_repo.add_result(
            job,
            summary_markdown=f"_All {len(branch_commits)} commits on `{branch}` were filtered as noise._",
            commit_count=0,
        )

    logger.info(
        "Branch diff %s..%s: %d total, %d kept, %d filtered for %s",
        base_branch, branch, len(branch_commits), len(commits), filtered_count, repo.name,
    )

    refs = extract_references(commits)
    day_groups = group_by_day(commits)
    style = job.summary_style or "detailed"

    chunks = chunk_by_token_budget(day_groups, settings.summary_token_budget)
    total_chunks = len(chunks)

    logger.info(
        "Summarising branch %s vs %s: %d commits in %d chunk(s), style=%s",
        branch, base_branch, len(commits), total_chunks, style,
    )

    try:
        partial_summaries: list[str] = []
        for idx, chunk_groups in enumerate(chunks, 1):
            chunk_commits_flat = [c for _, cs in chunk_groups for c in cs]
            chunk_refs = extract_references(chunk_commits_flat)

            prompt = _build_branch_chunk_prompt(
                repo_name=repo.name,
                branch=branch,
                base_branch=base_branch,
                chunk_index=idx,
                total_chunks=total_chunks,
                style=style,
                day_groups=chunk_groups,
                refs=chunk_refs,
            )
            partial = await ollama_service.generate(prompt, model=job.model_name)
            partial_summaries.append(partial)
            logger.info("Branch chunk %d/%d done (%d chars)", idx, total_chunks, len(partial))

        if total_chunks == 1:
            summary_md = partial_summaries[0]
        else:
            numbered = "\n\n".join(
                f"### Partial {i}\n{text}"
                for i, text in enumerate(partial_summaries, 1)
            )
            merge_prompt = _MERGE_PROMPT.format(
                repo_name=repo.name,
                start_date=f"branch {branch}",
                end_date=f"vs {base_branch}",
                partials=numbered,
            )
            summary_md = await ollama_service.generate(merge_prompt, model=job.model_name)

    except (httpx.ConnectError, httpx.ConnectTimeout, OSError) as exc:
        logger.warning("Ollama unreachable for branch summary: %s", exc)
        summary_md = _build_fallback_summary(
            repo.name, f"branch:{branch}", f"base:{base_branch}",
            day_groups, filtered_count, refs
        )
    except Exception as exc:
        logger.error("Branch summary failed for job %s: %s", job.id, exc)
        summary_repo.set_status(job, "failed")
        raise

    result = summary_repo.add_result(job, summary_md, len(commits))
    logger.info("Branch summary persisted for job %s (%d commits)", job.id, len(commits))
    return result
