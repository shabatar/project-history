"""YouTrack API client and board sync logic."""

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from typing import Callable

import httpx
from sqlalchemy.orm import Session

_ACTIVITY_FETCH_WORKERS = 10

# ── Server-side activity cache ─────────────────────────────────────────
# Short-lived memoization so summarize doesn't re-hit YouTrack for an
# activity set the user just fetched. Keyed by (sorted project_ids tuple,
# since_ts, until_ts). TTL is intentionally short — YouTrack data can
# change mid-session, so we only absorb the "fetch then summarize" burst.

_ACTIVITY_CACHE_TTL_S = 600  # 10 minutes
_activity_cache_lock = threading.Lock()
_activity_cache: dict[tuple, tuple[float, list]] = {}


def _activity_cache_key(project_ids: list[str], since_ts: int, until_ts: int) -> tuple:
    return (tuple(sorted(project_ids)), since_ts, until_ts)


def get_cached_activities(
    project_ids: list[str], since_ts: int, until_ts: int,
):
    """Return cached ActivityItem list if fresh, else None."""
    key = _activity_cache_key(project_ids, since_ts, until_ts)
    with _activity_cache_lock:
        entry = _activity_cache.get(key)
        if entry is None:
            return None
        cached_at, items = entry
        if time.monotonic() - cached_at > _ACTIVITY_CACHE_TTL_S:
            _activity_cache.pop(key, None)
            return None
    return items


def _store_activities_in_cache(
    project_ids: list[str], since_ts: int, until_ts: int, items: list,
) -> None:
    key = _activity_cache_key(project_ids, since_ts, until_ts)
    with _activity_cache_lock:
        # Bound the cache size to keep memory predictable — evict oldest.
        if len(_activity_cache) >= 64:
            oldest = min(_activity_cache.items(), key=lambda kv: kv[1][0])[0]
            _activity_cache.pop(oldest, None)
        _activity_cache[key] = (time.monotonic(), items)


def fetch_activities_cached(
    base_url: str,
    token: str,
    project_ids: list[str],
    since_ts: int,
    until_ts: int,
    should_stop: Callable[[], bool] | None = None,
    on_progress: Callable[[dict], None] | None = None,
):
    """Cache-aware wrapper around fetch_activities.

    If a fresh cached result exists for this (project_ids, since, until)
    tuple, return it immediately and emit a single synthetic progress event
    so the streaming UI still has something to show. Otherwise delegate to
    the network-hitting fetch_activities.
    """
    cached = get_cached_activities(project_ids, since_ts, until_ts)
    if cached is not None:
        logger.info(
            "fetch_activities_cached: cache hit (%d events, projects=%s)",
            len(cached), project_ids,
        )
        if on_progress:
            on_progress({
                "phase": "cache_hit",
                "done": len(cached),
                "total": len(cached),
                "events_so_far": len(cached),
            })
        return cached
    return fetch_activities(
        base_url, token, project_ids, since_ts, until_ts,
        should_stop=should_stop, on_progress=on_progress,
    )

from app.models import YouTrackBoard, YouTrackConfig, YouTrackIssueSnapshot
from app.schemas import ActivityItem, IssueChange

logger = logging.getLogger(__name__)


def resolve_token(db: Session) -> str:
    """Env var > decrypted DB. Raises LookupError if neither is set, ValueError if decrypt fails."""
    from app.config import settings
    from app.services.crypto import decrypt

    if settings.youtrack_api_token:
        return settings.youtrack_api_token
    cfg = db.query(YouTrackConfig).first()
    if cfg and cfg.api_token_encrypted:
        return decrypt(cfg.api_token_encrypted)
    raise LookupError("No YouTrack token configured")

def extract_board_id(url: str) -> str | None:
    """Extract the agile board ID from a YouTrack URL.

    Supports:
      https://youtrack.example.com/agiles/123-45/current
      https://youtrack.example.com/agiles/123-45
    """
    m = re.search(r"/agiles/([\w-]+)", url)
    return m.group(1) if m else None

def extract_base_url(board_url: str) -> str:
    """Guess the YouTrack base URL from a board URL."""
    m = re.match(r"(https?://[^/]+)", board_url)
    return m.group(1) if m else board_url

def fetch_board_info(base_url: str, token: str, board_id: str) -> dict:
    """GET /api/agiles/{id} with minimal fields."""
    url = f"{base_url}/api/agiles/{board_id}"
    r = httpx.get(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        params={"fields": "id,name"},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()

def fetch_board_issues(base_url: str, token: str, board_id: str) -> list[dict]:
    """Fetch all sprint issues for a board via the agiles API.

    Falls back to fetching the board's associated project issues if
    the sprint endpoint doesn't return issues directly.
    """
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    # Try to get the current sprint's issues
    sprints_url = f"{base_url}/api/agiles/{board_id}/sprints"
    r = httpx.get(
        sprints_url,
        headers=headers,
        params={"fields": "id,name,issues(id,idReadable,summary,customFields(name,value(name)))"},
        timeout=30,
    )
    r.raise_for_status()
    sprints = r.json()

    # Collect issues from the most recent sprint that has issues
    for sprint in reversed(sprints):
        issues_raw = sprint.get("issues", [])
        if issues_raw:
            return [_normalize_issue(iss) for iss in issues_raw]

    # Fallback: get the board's project and query issues directly
    board_info_url = f"{base_url}/api/agiles/{board_id}"
    r2 = httpx.get(
        board_info_url,
        headers=headers,
        params={"fields": "projects(id,shortName)"},
        timeout=15,
    )
    r2.raise_for_status()
    projects = r2.json().get("projects", [])
    if not projects:
        return []

    project_short = projects[0].get("shortName", "")
    issues_url = f"{base_url}/api/issues"
    r3 = httpx.get(
        issues_url,
        headers=headers,
        params={
            "query": f"project: {{{project_short}}} sort by: updated desc",
            "fields": "id,idReadable,summary,customFields(name,value(name))",
            "$top": "200",
        },
        timeout=30,
    )
    r3.raise_for_status()
    return [_normalize_issue(iss) for iss in r3.json()]

def _normalize_issue(raw: dict) -> dict:
    """Extract state and assignee from customFields."""
    state = ""
    assignee = None
    for cf in raw.get("customFields", []):
        name = cf.get("name", "")
        val = cf.get("value")
        if name == "State" and isinstance(val, dict):
            state = val.get("name", "")
        elif name == "Assignee" and isinstance(val, dict):
            assignee = val.get("name")
    return {
        "issue_id": raw.get("idReadable", raw.get("id", "")),
        "summary": raw.get("summary", ""),
        "state": state,
        "assignee": assignee,
    }

def sync_board(
    db: Session,
    board: YouTrackBoard,
    since: datetime | None = None,
) -> tuple[list[IssueChange], datetime | None]:
    """Fetch current issues, diff against baseline, store new snapshot.

    Baseline selection:
      - since=None → latest snapshot per issue (existing behavior)
      - since=<datetime> → latest snapshot per issue where synced_at <= since
    Returns (changes, baseline_synced_at). baseline_synced_at is the timestamp
    of the most recent baseline snapshot considered, or None if no baseline
    existed (first sync or no snapshots before `since`).
    """
    config = board.config
    token = resolve_token(db)
    now = datetime.now(UTC)

    # Get previous snapshots (optionally filtered by date)
    q = (
        db.query(YouTrackIssueSnapshot)
        .filter(YouTrackIssueSnapshot.board_id == board.id)
    )
    if since is not None:
        q = q.filter(YouTrackIssueSnapshot.synced_at <= since)
    prev_snapshots = q.order_by(YouTrackIssueSnapshot.synced_at.desc()).all()

    # Deduplicate to latest per issue_id
    prev_by_id: dict[str, YouTrackIssueSnapshot] = {}
    for snap in prev_snapshots:
        if snap.issue_id not in prev_by_id:
            prev_by_id[snap.issue_id] = snap

    # Fetch current issues from YouTrack
    try:
        current_issues = fetch_board_issues(config.base_url, token, board.board_id)
    except Exception as e:
        logger.error("Failed to fetch issues for board %s: %s", board.board_id, e)
        raise

    current_by_id = {iss["issue_id"]: iss for iss in current_issues}

    changes: list[IssueChange] = []

    # Detect added and updated
    for issue_id, iss in current_by_id.items():
        prev = prev_by_id.get(issue_id)
        if not prev:
            changes.append(IssueChange(
                issue_id=issue_id,
                summary=iss["summary"],
                change_type="added",
                new_state=iss["state"],
            ))
        else:
            state_changed = prev.state != iss["state"]
            assignee_changed = prev.assignee != iss.get("assignee")
            summary_changed = prev.summary != iss["summary"]
            if state_changed or assignee_changed or summary_changed:
                changes.append(IssueChange(
                    issue_id=issue_id,
                    summary=iss["summary"],
                    change_type="updated",
                    old_state=prev.state if state_changed else None,
                    new_state=iss["state"] if state_changed else None,
                    old_assignee=prev.assignee if assignee_changed else None,
                    new_assignee=iss.get("assignee") if assignee_changed else None,
                ))

    # Detect removed
    for issue_id, prev in prev_by_id.items():
        if issue_id not in current_by_id:
            changes.append(IssueChange(
                issue_id=issue_id,
                summary=prev.summary,
                change_type="removed",
                old_state=prev.state,
            ))

    # Store new snapshots
    for iss in current_issues:
        snap = YouTrackIssueSnapshot(
            board_id=board.id,
            issue_id=iss["issue_id"],
            summary=iss["summary"],
            state=iss["state"],
            assignee=iss.get("assignee"),
            updated_at=now,
            synced_at=now,
        )
        db.add(snap)

    board.last_synced_at = now
    db.commit()

    baseline_synced_at = max((s.synced_at for s in prev_by_id.values()), default=None)
    return changes, baseline_synced_at

def list_projects(base_url: str, token: str, include_archived: bool = False) -> list[dict]:
    """GET /api/admin/projects — return all projects the token can see.

    Each item: {id, short_name, name, description, archived}.
    """
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    r = httpx.get(
        f"{base_url}/api/admin/projects",
        headers=headers,
        params={"fields": "id,shortName,name,description,archived", "$top": "1000"},
        timeout=30,
    )
    r.raise_for_status()
    raw = r.json()
    projects = [
        {
            "id": p.get("id", ""),
            "short_name": p.get("shortName", ""),
            "name": p.get("name", "") or p.get("shortName", ""),
            "description": p.get("description", "") or "",
            "archived": bool(p.get("archived", False)),
        }
        for p in raw
        if p.get("shortName")
    ]
    if not include_archived:
        projects = [p for p in projects if not p["archived"]]
    projects.sort(key=lambda p: p["short_name"])
    return projects


def get_board_project_ids(base_url: str, token: str, board_id: str) -> list[str]:
    """Get the project short names associated with a board."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    r = httpx.get(
        f"{base_url}/api/agiles/{board_id}",
        headers=headers,
        params={"fields": "projects(id,shortName)"},
        timeout=15,
    )
    r.raise_for_status()
    return [p["shortName"] for p in r.json().get("projects", []) if p.get("shortName")]

def fetch_activities(
    base_url: str,
    token: str,
    project_ids: list[str],
    since_ts: int,
    until_ts: int,
    should_stop: Callable[[], bool] | None = None,
    on_progress: Callable[[dict], None] | None = None,
) -> list[ActivityItem]:
    """Fetch issue activities using YouTrack's issue-level history.

    Uses GET /api/issues?query=...&fields=... to get issues updated in the
    date range, then GET /api/issues/{id}/activities to get per-issue history.
    This avoids the activitiesPage endpoint which requires broad permissions.

    If `should_stop` is provided, it is called before each per-issue fetch;
    returning True aborts the loop early and returns what was gathered so far.

    If `on_progress` is provided, it is called periodically with a dict like
    {"phase": str, "done": int, "total": int, "events_so_far": int}. It is
    always called from the calling thread (i.e. if this fn runs in asyncio.to_thread,
    the callback runs in that same thread).
    """
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    # Build query: issues updated in the date range for the given projects
    project_filter = " ".join(f"project: {{{pid}}}" for pid in project_ids)
    since_str = datetime.fromtimestamp(since_ts / 1000, tz=UTC).strftime("%Y-%m-%d")
    until_str = datetime.fromtimestamp(until_ts / 1000, tz=UTC).strftime("%Y-%m-%d")
    query = f"{project_filter} updated: {since_str} .. {until_str}"

    # Step 1: Get issues updated in the date range
    if on_progress:
        on_progress({"phase": "listing_issues", "done": 0, "total": 0, "events_so_far": 0})
    r = httpx.get(
        f"{base_url}/api/issues",
        headers=headers,
        params={
            "query": query,
            "fields": "id,idReadable,summary",
            "$top": "200",
        },
        timeout=30,
    )
    r.raise_for_status()
    issues = r.json()
    total = len(issues)
    logger.info("Found %d issues updated in %s..%s for projects %s", total, since_str, until_str, project_ids)
    if on_progress:
        on_progress({"phase": "fetching_activities", "done": 0, "total": total, "events_so_far": 0})

    if not issues:
        return []

    all_items: list[ActivityItem] = []

    def _fetch_one(issue: dict) -> list[ActivityItem]:
        issue_id_readable = issue.get("idReadable", "")
        issue_summary = issue.get("summary", "")
        issue_internal_id = issue.get("id", "")
        try:
            return _fetch_issue_activities(
                base_url, headers, issue_internal_id,
                issue_id_readable, issue_summary,
                since_ts, until_ts,
            )
        except Exception as e:
            logger.warning("Failed to fetch activities for %s: %s", issue_id_readable, e)
            return []

    # Step 2: fetch per-issue activities in parallel. Progress reports are
    # emitted on each completion, so the client sees incremental updates.
    cancelled = False
    with ThreadPoolExecutor(max_workers=_ACTIVITY_FETCH_WORKERS) as pool:
        futures = {pool.submit(_fetch_one, issue): idx for idx, issue in enumerate(issues)}
        completed = 0
        for future in as_completed(futures):
            if should_stop and should_stop():
                cancelled = True
                # Best-effort: cancel any still-pending futures; running ones
                # will finish but we won't wait for more progress events.
                for f in futures:
                    if not f.done():
                        f.cancel()
                break
            try:
                all_items.extend(future.result())
            except Exception as e:  # already logged in _fetch_one, but be safe
                logger.warning("Activity future raised: %s", e)
            completed += 1
            if on_progress and (completed == total or completed % 5 == 0):
                on_progress({
                    "phase": "fetching_activities",
                    "done": completed, "total": total, "events_so_far": len(all_items),
                })

    if cancelled:
        logger.info(
            "fetch_activities: cancelled after %d/%d issues (collected %d events)",
            completed, total, len(all_items),
        )
        if on_progress:
            on_progress({"phase": "cancelled", "done": completed, "total": total, "events_so_far": len(all_items)})

    all_items.sort(key=lambda a: a.timestamp, reverse=True)

    # Populate server-side cache only on a clean (non-cancelled) fetch.
    if not cancelled:
        _store_activities_in_cache(project_ids, since_ts, until_ts, all_items)

    return all_items

def _fetch_issue_activities(
    base_url: str,
    headers: dict,
    issue_internal_id: str,
    issue_id_readable: str,
    issue_summary: str,
    since_ts: int,
    until_ts: int,
) -> list[ActivityItem]:
    """Fetch activities for a single issue via GET /api/issues/{id}/activities."""
    fields = (
        "$type,id,timestamp,"
        "targetMember,memberName,"
        "field($type,name),"
        "added($type,id,name,text,login),"
        "removed($type,id,name,text,login),"
        "author(login,name),"
        "category($type,id)"
    )

    r = httpx.get(
        f"{base_url}/api/issues/{issue_internal_id}/activities",
        headers=headers,
        params={
            "fields": fields,
            "categories": "CommentsCategory,CustomFieldCategory,IssueCreatedCategory,IssueResolvedCategory",
            "$top": "100",
        },
        timeout=20,
    )
    r.raise_for_status()
    raw_activities = r.json()

    items: list[ActivityItem] = []
    for raw in raw_activities:
        ts = raw.get("timestamp")
        if not ts or ts < since_ts or ts > until_ts:
            continue

        item = _parse_activity(raw, issue_id_readable, issue_summary)
        if item:
            items.append(item)

    return items

def _parse_activity(raw: dict, issue_id: str, issue_summary: str) -> ActivityItem | None:
    """Parse a single activity item from the per-issue activities response."""
    timestamp = raw.get("timestamp")
    if not timestamp:
        return None

    author_data = raw.get("author") or {}
    author_login = author_data.get("login") or None
    author = author_data.get("name") or author_login or ""

    # Category detection: prefer category.id, fall back to activity $type
    category = raw.get("category") or {}
    cat_id = category.get("id", "")
    act_type = raw.get("$type", "")
    cat_key = cat_id or act_type

    # Human-readable field name: field.name > memberName > targetMember
    field_obj = raw.get("field") or {}
    field_name = field_obj.get("name", "") or raw.get("memberName", "") or raw.get("targetMember", "")

    added = raw.get("added")
    removed = raw.get("removed")

    if "IssueCreated" in cat_key:
        return ActivityItem(
            timestamp=timestamp,
            issue_id=issue_id,
            issue_summary=issue_summary,
            author=author,
            author_login=author_login,
            activity_type="created",
            field="",
            old_value=None,
            new_value=None,
            comment_text=None,
        )

    if "IssueResolved" in cat_key:
        return ActivityItem(
            timestamp=timestamp,
            issue_id=issue_id,
            issue_summary=issue_summary,
            author=author,
            author_login=author_login,
            activity_type="resolved",
            field="",
            old_value=None,
            new_value=None,
            comment_text=None,
        )

    if "Comments" in cat_key:
        comment_text = _extract_comment_text(added)
        return ActivityItem(
            timestamp=timestamp,
            issue_id=issue_id,
            issue_summary=issue_summary,
            author=author,
            author_login=author_login,
            activity_type="comment",
            field="",
            old_value=None,
            new_value=None,
            comment_text=comment_text,
        )

    if "CustomField" in cat_key:
        old_val = _extract_field_value(removed)
        new_val = _extract_field_value(added)
        return ActivityItem(
            timestamp=timestamp,
            issue_id=issue_id,
            issue_summary=issue_summary,
            author=author,
            author_login=author_login,
            activity_type="field_change",
            field=field_name,
            old_value=old_val,
            new_value=new_val,
            comment_text=None,
        )

    return None

def _extract_comment_text(added) -> str | None:
    """Extract comment text from the added field."""
    if isinstance(added, list):
        for a in added:
            if isinstance(a, dict):
                text = a.get("text")
                if text:
                    return text[:500]
    elif isinstance(added, dict):
        text = added.get("text")
        if text:
            return text[:500]
    return None

def _extract_field_value(items) -> str | None:
    """Extract a display value from added/removed field items."""
    if not items:
        return None
    if isinstance(items, list):
        names = []
        for item in items:
            if isinstance(item, dict):
                names.append(item.get("name") or item.get("text") or item.get("login") or str(item.get("id", "")))
            elif isinstance(item, str):
                names.append(item)
        return ", ".join(names) if names else None
    if isinstance(items, dict):
        return items.get("name") or items.get("text") or items.get("login")
    if isinstance(items, str):
        return items
    return str(items) if items else None
