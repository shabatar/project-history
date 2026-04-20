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
from datetime import datetime, timezone

from app.schemas import ActivityItem
from app.services import ollama_service

logger = logging.getLogger(__name__)

_CHAR_PER_TOKEN = 4
_MAX_ACTIVITIES_IN_PROMPT = 400  # hard cap to keep prompts bounded

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
) -> str:
    preamble = _SYSTEM_PREAMBLE.format(
        board_name=board_name, since=since, until=until, total=len(activities),
    )
    instructions = _STYLE_INSTRUCTIONS.get(style, _DETAILED_INSTRUCTIONS)
    # Oldest-first so the LLM can follow the timeline
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


async def summarize_activity(
    *,
    board_name: str,
    since: str,
    until: str,
    activities: list[ActivityItem],
    style: str,
    model: str,
) -> tuple[str, bool]:
    """Return (markdown, used_llm). used_llm=False means the deterministic fallback was used."""
    if not activities:
        md = (
            f"# Board Activity — {board_name}\n"
            f"**Period:** {since} to {until}\n\n"
            "No activity events in this date range."
        )
        return md, False

    # Cap to keep prompts bounded — oldest & newest are preserved.
    capped = activities
    if len(activities) > _MAX_ACTIVITIES_IN_PROMPT:
        half = _MAX_ACTIVITIES_IN_PROMPT // 2
        sorted_by_ts = sorted(activities, key=lambda a: a.timestamp)
        capped = sorted_by_ts[:half] + sorted_by_ts[-half:]
        logger.info(
            "Activity summary capped: %d → %d events (keeping oldest+newest halves)",
            len(activities), len(capped),
        )

    prompt = _build_prompt(
        board_name=board_name, since=since, until=until, style=style, activities=capped,
    )

    try:
        markdown = await ollama_service.generate(prompt=prompt, model=model)
        if not markdown.strip():
            logger.warning("Ollama returned empty response — using fallback")
            return _build_fallback(
                board_name=board_name, since=since, until=until, activities=activities,
            ), False
        return markdown, True
    except Exception as e:
        logger.warning("Ollama generate failed (%s) — using fallback", e)
        return _build_fallback(
            board_name=board_name, since=since, until=until, activities=activities,
        ), False
