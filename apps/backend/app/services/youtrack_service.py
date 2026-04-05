"""YouTrack API client and board sync logic."""

import logging
import re
from datetime import UTC, datetime

import httpx
from sqlalchemy.orm import Session

from app.models import YouTrackBoard, YouTrackConfig, YouTrackIssueSnapshot
from app.schemas import ActivityItem, IssueChange

logger = logging.getLogger(__name__)

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

def sync_board(db: Session, board: YouTrackBoard) -> list[IssueChange]:
    """Fetch current issues, diff against last snapshot, store new snapshot."""
    from app.config import settings as app_settings
    config = board.config
    token = app_settings.youtrack_api_token
    now = datetime.now(UTC)

    # Get previous snapshot
    prev_snapshots = (
        db.query(YouTrackIssueSnapshot)
        .filter(YouTrackIssueSnapshot.board_id == board.id)
        .order_by(YouTrackIssueSnapshot.synced_at.desc())
        .all()
    )

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

    return changes

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
) -> list[ActivityItem]:
    """Fetch issue activities using YouTrack's issue-level history.

    Uses GET /api/issues?query=...&fields=... to get issues updated in the
    date range, then GET /api/issues/{id}/activities to get per-issue history.
    This avoids the activitiesPage endpoint which requires broad permissions.
    """
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    # Build query: issues updated in the date range for the given projects
    project_filter = " ".join(f"project: {{{pid}}}" for pid in project_ids)
    since_str = datetime.fromtimestamp(since_ts / 1000, tz=UTC).strftime("%Y-%m-%d")
    until_str = datetime.fromtimestamp(until_ts / 1000, tz=UTC).strftime("%Y-%m-%d")
    query = f"{project_filter} updated: {since_str} .. {until_str}"

    # Step 1: Get issues updated in the date range
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
    logger.info("Found %d issues updated in %s..%s for projects %s", len(issues), since_str, until_str, project_ids)

    if not issues:
        return []

    all_items: list[ActivityItem] = []

    # Step 2: For each issue, fetch its activities in the date range
    for issue in issues:
        issue_id_readable = issue.get("idReadable", "")
        issue_summary = issue.get("summary", "")
        issue_internal_id = issue.get("id", "")

        try:
            activities = _fetch_issue_activities(
                base_url, headers, issue_internal_id,
                issue_id_readable, issue_summary,
                since_ts, until_ts,
            )
            all_items.extend(activities)
        except Exception as e:
            logger.warning("Failed to fetch activities for %s: %s", issue_id_readable, e)

    all_items.sort(key=lambda a: a.timestamp, reverse=True)
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
    author = author_data.get("name") or author_data.get("login", "")

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
