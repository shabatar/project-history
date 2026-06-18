"""YouTrack board activity summarization via LLM.

Builds a prompt from a batch of ActivityItems and a board name, asks the
configured Ollama model to summarize. Falls back to a deterministic local
summary if Ollama is unreachable.

Scoped to YouTrack mode — only called from the /youtrack router, which is
only registered when PT_YOUTRACK_ENABLED is true.
"""

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from app.schemas import ActivityItem
from app.services import llm_budget, ollama_service

logger = logging.getLogger(__name__)

_CHARS_PER_TOKEN = llm_budget.CHARS_PER_TOKEN
_TOKENS_RESERVED = llm_budget.RESERVED_TOKENS
_TOKENS_PER_AGG_LINE = 35
_MIN_CHUNK_ISSUES = 20

_SYSTEM_PREAMBLE = """\
You are an engineering-delivery analyst.  You are summarising activity on a \
YouTrack agile board for **project-progress tracking**.

Board: {board_name}
Period: {since} to {until}
Activity events: {total}

GLOBAL RULES:
- Treat activity events as signals of what the team worked on.  Group events \
  by issue and by theme.
- ALWAYS reference issues by their issue id (e.g. `PROJ-123`) inline when \
  discussing them.  Readers will click these to open the ticket.
- Distinguish between issues that were CREATED, RESOLVED, received COMMENTS, \
  and had state/assignee FIELD CHANGES.
- If the same issue appears in many events, summarise the overall trajectory \
  (e.g. "opened → in progress → done") rather than listing every event.
- Highlight risk: long-lived issues with many state flips, reopened items, \
  issues with many comments but no resolution, blockers.
- DO NOT rank, count, or name "top contributors" / most-active people. \
  The goal is work progress, not individual performance tracking.
- Output valid Markdown.  Do not invent issues or authors not present in the \
  event list below.
"""

_SHORT_INSTRUCTIONS = """
Produce a **concise** summary (aim for 150–300 words).  Use this structure:

## Summary
<!-- 3-5 bullets covering the most important work.  Include issue refs \
(PROJ-123) inline. -->

## Resolved
<!-- Bullet list of issues that were resolved in the period, with refs. \
Write "None" if none. -->

## Risks & Open Items
<!-- Long-lived or reopened issues, blockers; "None" if nothing stands out. -->
"""

_DETAILED_INSTRUCTIONS = """
Produce a **thorough engineering summary**.  Use EXACTLY these section \
headings.  Write "None" under a heading if nothing applies.

## High-Level Summary
<!-- 2-4 sentence overview of what happened on the board -->

## New Work (Created)
<!-- Bullets grouping newly created issues by theme, with refs (PROJ-123). -->

## Completed (Resolved)
<!-- Resolved issues with refs and 1-line description each. -->

## In Flight (State Changes)
<!-- Issues that moved between states during the period.  For each, give \
the state trajectory (e.g. "Open → In Progress → Review"). -->

## Discussion Hotspots
<!-- Issues with the most comments; extract themes if possible. -->

## Risks & Open Items
<!-- Long-lived, reopened, blocked; items needing follow-up. -->

## Suggested Status Update
<!-- 3-5 bullets suitable for a stand-up or weekly status email. -->
"""

_MANAGER_INSTRUCTIONS = """
Produce a **manager-friendly progress update** — non-technical language, \
focused on outcomes.  Use this structure:

## What Got Done
<!-- Bullet list of shipped / resolved work phrased as outcomes, with refs \
(PROJ-123) so readers can open tickets. -->

## In Progress
<!-- Work that was moved forward but not completed -->

## Newly Raised
<!-- New issues that appeared in this period -->

## Blockers & Risks
<!-- Items that could delay delivery or need a decision -->

## Key Metrics
<!-- Counts: created, resolved, in-progress. Do NOT rank or name individuals. -->

## Recommended Status Update
<!-- 2-3 sentences suitable for an executive email or Slack post -->
"""

_STYLE_INSTRUCTIONS = {
    "short": _SHORT_INSTRUCTIONS,
    "detailed": _DETAILED_INSTRUCTIONS,
    "manager": _MANAGER_INSTRUCTIONS,
}



def _fmt_ts(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def _fmt_date(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _format_activity(item: ActivityItem) -> str:
    ts = _fmt_ts(item.timestamp)
    if item.activity_type == "created":
        return f"- [{ts}] {item.issue_id} CREATED by {item.author}: {item.issue_summary}"
    if item.activity_type == "resolved":
        return f"- [{ts}] {item.issue_id} RESOLVED by {item.author}: {item.issue_summary}"
    if item.activity_type == "comment":
        excerpt = (item.comment_text or "").replace("\n", " ")[:200]
        return f"- [{ts}] {item.issue_id} COMMENT by {item.author}: {excerpt}"
    if item.activity_type == "field_change":
        old = item.old_value or "∅"
        new = item.new_value or "∅"
        return f"- [{ts}] {item.issue_id} {item.field}: {old} → {new} (by {item.author})"
    return f"- [{ts}] {item.issue_id} {item.activity_type} by {item.author}"


def _build_prompt(
    *,
    board_name: str,
    since: str,
    until: str,
    style: str,
    activities: list[ActivityItem],
    custom_prompt: str | None = None,
) -> str:
    preamble = _SYSTEM_PREAMBLE.format(
        board_name=board_name, since=since, until=until, total=len(activities),
    )
    if style == "custom" and custom_prompt:
        instructions = f"\n{custom_prompt.strip()}\n"
    else:
        instructions = _STYLE_INSTRUCTIONS.get(style, _DETAILED_INSTRUCTIONS)
    sorted_items = sorted(activities, key=lambda a: a.timestamp)
    lines = [_format_activity(a) for a in sorted_items]
    events_block = "\n".join(lines)
    return f"{preamble}\n{instructions}\n\nEVENTS ({len(activities)}):\n{events_block}\n"


def _build_fallback(
    *,
    board_name: str,
    since: str,
    until: str,
    activities: list[ActivityItem],
) -> str:
    """Deterministic summary when Ollama is unreachable.

    Intentionally does NOT rank or name "top contributors" — activity is
    reported as work progress, not individual performance.
    """
    by_type: Counter[str] = Counter(a.activity_type for a in activities)
    by_issue: dict[str, list[ActivityItem]] = defaultdict(list)
    for a in activities:
        by_issue[a.issue_id].append(a)

    created = [a for a in activities if a.activity_type == "created"]
    resolved = [a for a in activities if a.activity_type == "resolved"]
    hotspots = sorted(by_issue.items(), key=lambda kv: -len(kv[1]))[:5]

    lines = [
        f"# Board Activity — {board_name}",
        f"**Period:** {since} to {until}  ",
        f"**Events:** {len(activities)} "
        f"(created: {by_type.get('created', 0)}, resolved: {by_type.get('resolved', 0)}, "
        f"comments: {by_type.get('comment', 0)}, field changes: {by_type.get('field_change', 0)})",
        "",
        "## Completed (Resolved)",
    ]
    lines += [f"- {a.issue_id} — {a.issue_summary}" for a in resolved] or ["- None"]

    lines += ["", "## New Work (Created)"]
    lines += [f"- {a.issue_id} — {a.issue_summary}" for a in created] or ["- None"]

    lines += ["", "## Discussion Hotspots"]
    lines += [f"- {iid}: {len(events)} events" for iid, events in hotspots] or ["- None"]

    lines += [
        "",
        "_Ollama was unreachable — this is a deterministic fallback summary built from raw event counts._",
    ]
    return "\n".join(lines)



def aggregate_by_issue(activities: list[ActivityItem]) -> list[dict]:
    """Group events by issue_id and produce compact per-issue records."""
    records: dict[str, dict] = {}

    for item in activities:
        iid = item.issue_id
        if iid not in records:
            records[iid] = {
                "issue_id": iid,
                "summary": "",
                "created_at": None,
                "resolved_at": None,
                "states": [],
                "assignees": [],
                "comment_count": 0,
                "last_ts": item.timestamp,
                "event_count": 0,
            }
        rec = records[iid]
        rec["event_count"] += 1
        if item.timestamp > rec["last_ts"]:
            rec["last_ts"] = item.timestamp

        if not rec["summary"] and item.issue_summary:
            rec["summary"] = item.issue_summary

        if item.activity_type == "created":
            rec["created_at"] = item.timestamp

        elif item.activity_type == "resolved":
            rec["resolved_at"] = item.timestamp

        elif item.activity_type == "comment":
            rec["comment_count"] += 1

        elif item.activity_type == "field_change":
            field = (item.field or "").lower()
            if field == "state" and item.new_value:
                if not rec["states"] or rec["states"][-1] != item.new_value:
                    rec["states"].append(item.new_value)
            elif field in ("assignee", "assignees") and item.new_value:
                if not rec["assignees"] or rec["assignees"][-1] != item.new_value:
                    rec["assignees"].append(item.new_value)

    result = sorted(records.values(), key=lambda r: -r["last_ts"])
    return result


def format_aggregated_line(rec: dict) -> str:
    """Format an aggregated issue record as a compact one-liner."""
    parts = [rec["issue_id"]]

    summary = rec.get("summary", "")
    if summary:
        truncated = summary[:80]
        parts.append(f' "{truncated}"')

    flags = []
    if rec.get("created_at"):
        flags.append(f"created {_fmt_date(rec['created_at'])}")
    if rec.get("resolved_at"):
        flags.append(f"resolved {_fmt_date(rec['resolved_at'])}")
    states = rec.get("states", [])
    if states:
        flags.append(f"state: {'→'.join(states)}")
    assignees = rec.get("assignees", [])
    if assignees:
        flags.append(f"assignee: {'→'.join(assignees)}")
    count = rec.get("comment_count", 0)
    if count > 0:
        word = "comment" if count == 1 else "comments"
        flags.append(f"{count} {word}")

    line = "".join(parts)
    if flags:
        line += " | " + ", ".join(flags)
    return line


def chunk_list(items: list, size: int) -> list[list]:
    """Split list into sublists of at most `size`. If size < 1, treat as 1."""
    if not items:
        return []
    size = max(1, size)
    return [items[i:i + size] for i in range(0, len(items), size)]


def compute_issue_budget(context_tokens: int) -> int:
    """Compute how many aggregated issue lines fit in the context."""
    computed = (context_tokens - _TOKENS_RESERVED) // _TOKENS_PER_AGG_LINE
    return max(_MIN_CHUNK_ISSUES, computed)



def _build_aggregated_prompt(
    board_name: str,
    since: str,
    until: str,
    style: str,
    aggregated: list[dict],
    total_raw_events: int,
    custom_prompt: str | None = None,
) -> str:
    if style == "custom" and custom_prompt:
        style_instructions = f"\n{custom_prompt.strip()}\n"
    else:
        style_instructions = _STYLE_INSTRUCTIONS.get(style, _DETAILED_INSTRUCTIONS)

    issue_lines = "\n".join(f"- {format_aggregated_line(r)}" for r in aggregated)

    return (
        f"You are an engineering-delivery analyst summarising YouTrack activity.\n\n"
        f"Source: {board_name}\n"
        f"Period: {since} to {until}\n"
        f"Issues tracked: {len(aggregated)} (from {total_raw_events} raw events)\n"
        f"\n{style_instructions}\n"
        f"ISSUES (most recently active first):\n{issue_lines}\n"
    )


def _build_chunk_prompt(
    board_name: str,
    since: str,
    until: str,
    chunk: list[dict],
    chunk_idx: int,
    total_chunks: int,
) -> str:
    issue_lines = "\n".join(f"- {format_aggregated_line(r)}" for r in chunk)
    return (
        f"Summarize this batch of YouTrack issues (batch {chunk_idx + 1}/{total_chunks}).\n"
        f"Source: {board_name}, Period: {since} to {until}\n\n"
        f"Be concise. Focus on: what was completed, what's in progress, risks.\n"
        f"Reference issues by ID (PROJ-123). Output markdown.\n\n"
        f"ISSUES:\n{issue_lines}\n"
    )


def _build_meta_prompt(
    board_name: str,
    since: str,
    until: str,
    style: str,
    chunk_summaries: list[str],
    total_issues: int,
    total_raw: int,
    custom_prompt: str | None = None,
) -> str:
    if style == "custom" and custom_prompt:
        style_instructions = f"\n{custom_prompt.strip()}\n"
    else:
        style_instructions = _STYLE_INSTRUCTIONS.get(style, _DETAILED_INSTRUCTIONS)

    batches = ""
    for i, summary in enumerate(chunk_summaries):
        batches += f"--- Batch {i + 1} ---\n{summary}\n"

    return (
        f"You are an engineering-delivery analyst. Combine these batch summaries into one coherent report.\n\n"
        f"Source: {board_name}\n"
        f"Period: {since} to {until}\n"
        f"Coverage: {total_issues} issues, {total_raw} raw events (pre-aggregated)\n"
        f"\n{style_instructions}\n"
        f"BATCH SUMMARIES ({len(chunk_summaries)} batches):\n{batches}"
    )


async def summarize_activity(
    *,
    board_name: str,
    since: str,
    until: str,
    activities: list[ActivityItem],
    style: str,
    model: str,
    custom_prompt: str | None = None,
    on_token: Callable[[str], Awaitable[None]] | None = None,
) -> tuple[str, bool]:
    """Return (markdown, used_llm). used_llm=False means the deterministic fallback was used."""
    if not activities:
        logger.info("summarize_activity: no events for %s [%s → %s]", board_name, since, until)
        md = (
            f"# Board Activity — {board_name}\n"
            f"**Period:** {since} to {until}\n\n"
            "No activity events in this date range."
        )
        return md, False

    logger.info(
        "summarize_activity: start — %s [%s → %s], %d events, style=%s, model=%s",
        board_name, since, until, len(activities), style, model,
    )

    try:
        aggregated = aggregate_by_issue(activities)
        total_raw_events = len(activities)
        logger.info(
            "summarize_activity: aggregated %d raw events → %d issues",
            total_raw_events, len(aggregated),
        )

        context_tokens = await llm_budget.resolve_context_size(model)
        logger.info("summarize_activity: context size for %s = %d tokens", model, context_tokens)

        budget = compute_issue_budget(context_tokens)

        if len(aggregated) <= budget:
            logger.info(
                "summarize_activity: single-pass (%d issues, budget %d)",
                len(aggregated), budget,
            )
            prompt = _build_aggregated_prompt(
                board_name, since, until, style, aggregated, total_raw_events,
                custom_prompt=custom_prompt,
            )
            markdown = await ollama_service.generate_stream(
                prompt=prompt,
                model=model,
                on_token=on_token,
            )
        else:
            chunks = chunk_list(aggregated, budget)
            logger.info(
                "summarize_activity: map-reduce — %d issues, %d chunks (budget=%d)",
                len(aggregated), len(chunks), budget,
            )
            chunk_summaries: list[str] = []
            for i, chunk in enumerate(chunks):
                logger.info(
                    "summarize_activity: chunk %d/%d (%d issues)",
                    i + 1, len(chunks), len(chunk),
                )
                chunk_prompt = _build_chunk_prompt(
                    board_name, since, until, chunk, i, len(chunks),
                )
                chunk_md = await ollama_service.generate(prompt=chunk_prompt, model=model)
                chunk_summaries.append(chunk_md)

            logger.info("summarize_activity: meta-summarizing %d chunks", len(chunk_summaries))
            meta_prompt = _build_meta_prompt(
                board_name, since, until, style, chunk_summaries,
                total_issues=len(aggregated),
                total_raw=total_raw_events,
                custom_prompt=custom_prompt,
            )
            markdown = await ollama_service.generate_stream(
                prompt=meta_prompt,
                model=model,
                on_token=on_token,
            )

        if not markdown.strip():
            logger.warning("Ollama returned empty response — using fallback")
            return _build_fallback(
                board_name=board_name, since=since, until=until, activities=activities,
            ), False
        logger.info(
            "summarize_activity: done — %d chars for %s", len(markdown), board_name,
        )
        return markdown, True

    except Exception as e:
        logger.warning("Ollama generate failed (%s) — using fallback", e)
        return _build_fallback(
            board_name=board_name, since=since, until=until, activities=activities,
        ), False
