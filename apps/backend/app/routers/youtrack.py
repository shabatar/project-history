"""YouTrack board tracking endpoints."""

import asyncio
import json
import logging
import threading
from typing import Callable

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.database import SessionLocal
from app.models import ActivitySummary, YouTrackBoard, YouTrackConfig, YouTrackIssueSnapshot
from app.schemas import (
    ActivityItem,
    ActivityRequest,
    ActivitySummaryRead,
    ActivitySummaryRequest,
    ActivitySummaryResponse,
    BoardActivityResponse,
    BoardSyncRequest,
    BoardSyncResult,
    ProjectActivityResponse,
    ProjectActivitySummaryResponse,
    YouTrackBoardAdd,
    YouTrackBoardRead,
    YouTrackConfigCreate,
    YouTrackConfigRead,
    YouTrackIssueRead,
    YouTrackProjectRead,
    YouTrackTestRequest,
    YouTrackTestResponse,
)
from app.services import activity_summary_service
from app.services.crypto import encrypt
from app.services.youtrack_service import (
    extract_base_url,
    extract_board_id,
    fetch_activities,
    fetch_activities_cached,
    fetch_board_info,
    get_board_project_ids,
    list_projects,
    resolve_token,
    sync_board,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/youtrack", tags=["youtrack"])


def _get_token(db: Session) -> str:
    """Resolve the YouTrack token: env var wins; otherwise decrypt DB value."""
    try:
        return resolve_token(db)
    except LookupError:
        raise HTTPException(
            400,
            "YouTrack API token is not configured. Set it via the UI (Boards page) "
            "or the PT_YOUTRACK_API_TOKEN env var.",
        )
    except ValueError as e:
        # Decryption failed — secret key likely changed
        raise HTTPException(500, f"Stored token could not be decrypted: {e}")


def _get_base_url(db: Session) -> str:
    cfg = db.query(YouTrackConfig).first()
    return cfg.base_url if cfg else settings.youtrack_base_url


def _config_payload(cfg: YouTrackConfig) -> YouTrackConfigRead:
    if settings.youtrack_api_token:
        source, configured = "env", True
    elif cfg.api_token_encrypted:
        source, configured = "db", True
    else:
        source, configured = None, False
    return YouTrackConfigRead(
        id=cfg.id,
        base_url=cfg.base_url,
        created_at=cfg.created_at,
        token_configured=configured,
        token_source=source,
    )


# ── Config ──

@router.get("/config", response_model=YouTrackConfigRead | None)
def get_config(db: Session = Depends(get_db)):
    cfg = db.query(YouTrackConfig).first()
    return _config_payload(cfg) if cfg else None


@router.post("/config", response_model=YouTrackConfigRead, status_code=201)
def set_config(body: YouTrackConfigCreate, db: Session = Depends(get_db)):
    cfg = db.query(YouTrackConfig).first()
    if cfg:
        cfg.base_url = body.base_url
        if body.api_token is not None:
            cfg.api_token_encrypted = encrypt(body.api_token)
    else:
        cfg = YouTrackConfig(
            base_url=body.base_url,
            api_token_encrypted=encrypt(body.api_token) if body.api_token else None,
        )
        db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return _config_payload(cfg)


@router.delete("/config", status_code=204)
def delete_config(db: Session = Depends(get_db)):
    existing = db.query(YouTrackConfig).first()
    if existing:
        db.delete(existing)
        db.commit()


@router.delete("/config/token", response_model=YouTrackConfigRead)
def clear_token(db: Session = Depends(get_db)):
    """Clear the stored encrypted token. Env-var token (if any) is unaffected."""
    cfg = db.query(YouTrackConfig).first()
    if not cfg:
        raise HTTPException(404, "No YouTrack config. Set a base URL first.")
    cfg.api_token_encrypted = None
    db.commit()
    db.refresh(cfg)
    return _config_payload(cfg)


@router.post("/config/test", response_model=YouTrackTestResponse)
def test_connection(body: YouTrackTestRequest, db: Session = Depends(get_db)):
    """Verify a token works against YouTrack. Does NOT persist anything."""
    cfg = db.query(YouTrackConfig).first()
    base_url = body.base_url or (cfg.base_url if cfg else settings.youtrack_base_url)
    if not base_url:
        raise HTTPException(400, "Provide a base URL or save one first.")

    if body.api_token:
        token = body.api_token
    else:
        try:
            token = resolve_token(db)
        except LookupError:
            raise HTTPException(400, "No token provided and none stored.")
        except ValueError as e:
            raise HTTPException(500, f"Stored token could not be decrypted: {e}")

    try:
        r = httpx.get(
            f"{base_url}/api/users/me",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={"fields": "login,name"},
            timeout=10,
        )
    except httpx.HTTPError as e:
        return YouTrackTestResponse(ok=False, detail=f"Connection failed: {e}")

    if r.status_code == 401 or r.status_code == 403:
        return YouTrackTestResponse(ok=False, detail="Authentication failed (401/403). Token is invalid or lacks permission.")
    if r.status_code >= 400:
        return YouTrackTestResponse(ok=False, detail=f"YouTrack returned HTTP {r.status_code}")

    try:
        data = r.json()
    except ValueError:
        return YouTrackTestResponse(ok=False, detail="Unexpected response body (not JSON). Check the base URL.")

    return YouTrackTestResponse(
        ok=True,
        username=data.get("login") or data.get("name"),
    )


# ── Boards ──

@router.get("/boards", response_model=list[YouTrackBoardRead])
def list_boards(db: Session = Depends(get_db)):
    return db.query(YouTrackBoard).all()


@router.post("/boards", response_model=YouTrackBoardRead, status_code=201)
def add_board(body: YouTrackBoardAdd, db: Session = Depends(get_db)):
    token = _get_token(db)
    cfg = db.query(YouTrackConfig).first()
    if not cfg:
        raise HTTPException(400, "Set YouTrack base URL first")

    board_id = extract_board_id(body.board_url)
    if not board_id:
        raise HTTPException(422, "Could not extract board ID from URL. Expected /agiles/<id>")

    existing = db.query(YouTrackBoard).filter_by(config_id=cfg.id, board_id=board_id).first()
    if existing:
        raise HTTPException(409, f"Board {board_id} is already tracked")

    base_url = cfg.base_url or extract_base_url(body.board_url)
    try:
        info = fetch_board_info(base_url, token, board_id)
    except Exception as e:
        logger.warning("Could not fetch board info for %s: %s", board_id, e)
        info = {"name": board_id}

    board = YouTrackBoard(
        config_id=cfg.id,
        board_id=board_id,
        board_name=info.get("name", board_id),
        board_url=body.board_url,
    )
    db.add(board)
    db.commit()
    db.refresh(board)
    return board


@router.delete("/boards/{board_db_id}", status_code=204)
def remove_board(board_db_id: str, db: Session = Depends(get_db)):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")
    db.delete(board)
    db.commit()


# ── Sync & Issues ──

def _persist_activity_summary(
    *,
    source_type: str,
    source_id: str,
    source_name: str,
    since: str,
    until: str,
    style: str,
    model: str,
    activity_count: int,
    markdown: str,
    used_llm: bool,
) -> str:
    """Persist a generated activity summary in its own short-lived session."""
    db = SessionLocal()
    try:
        row = ActivitySummary(
            source_type=source_type,
            source_id=source_id,
            source_name=source_name,
            since=since,
            until=until,
            summary_style=style,
            model_name=model,
            activity_count=activity_count,
            summary_markdown=markdown,
            used_llm=used_llm,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to persist activity summary: %s", e)
        db.rollback()
        return ""
    finally:
        db.close()


def _parse_since(since: str | None):
    if not since:
        return None
    from datetime import datetime, timezone
    return datetime.strptime(since, "%Y-%m-%d").replace(
        hour=23, minute=59, second=59, tzinfo=timezone.utc
    )


@router.post("/boards/{board_db_id}/sync", response_model=BoardSyncResult)
def sync_board_endpoint(
    board_db_id: str,
    body: BoardSyncRequest | None = None,
    db: Session = Depends(get_db),
):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")
    since_dt = _parse_since(body.since if body else None)
    try:
        changes, baseline = sync_board(db, board, since=since_dt)
    except LookupError:
        raise HTTPException(400, "YouTrack API token is not configured.")
    except Exception as e:
        raise HTTPException(502, f"YouTrack API error: {e}")
    db.refresh(board)
    return BoardSyncResult(
        board_id=board.id,
        board_name=board.board_name,
        total_issues=db.query(YouTrackIssueSnapshot)
        .filter_by(board_id=board.id, synced_at=board.last_synced_at)
        .count(),
        changes=changes,
        baseline_synced_at=baseline,
        since=body.since if body else None,
    )


@router.post("/sync-all", response_model=list[BoardSyncResult])
def sync_all_boards(
    body: BoardSyncRequest | None = None,
    db: Session = Depends(get_db),
):
    since_dt = _parse_since(body.since if body else None)
    boards = db.query(YouTrackBoard).all()
    results = []
    for board in boards:
        try:
            changes, baseline = sync_board(db, board, since=since_dt)
            db.refresh(board)
            total = (
                db.query(YouTrackIssueSnapshot)
                .filter_by(board_id=board.id, synced_at=board.last_synced_at)
                .count()
            )
            results.append(BoardSyncResult(
                board_id=board.id,
                board_name=board.board_name,
                total_issues=total,
                changes=changes,
                baseline_synced_at=baseline,
                since=body.since if body else None,
            ))
        except Exception as e:
            logger.error("Failed to sync board %s: %s", board.board_name, e)
    return results


@router.get("/boards/{board_db_id}/issues", response_model=list[YouTrackIssueRead])
def list_board_issues(board_db_id: str, db: Session = Depends(get_db)):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")
    if not board.last_synced_at:
        return []
    return (
        db.query(YouTrackIssueSnapshot)
        .filter_by(board_id=board.id, synced_at=board.last_synced_at)
        .order_by(YouTrackIssueSnapshot.issue_id)
        .all()
    )


# ── Activity ──

@router.post("/boards/{board_db_id}/activity", response_model=BoardActivityResponse)
async def get_board_activity(
    board_db_id: str,
    body: ActivityRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")

    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")

    from datetime import datetime, timedelta, timezone

    try:
        since_dt = datetime.strptime(body.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        until_dt = datetime.strptime(body.until, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
    except ValueError:
        raise HTTPException(422, "Invalid date format. Use YYYY-MM-DD.")

    if since_dt > until_dt:
        raise HTTPException(422, "'since' date must not be after 'until' date.")

    max_range = timedelta(days=180)
    if until_dt - since_dt > max_range:
        raise HTTPException(
            422,
            f"Date range must not exceed 180 days. Requested: {(until_dt - since_dt).days} days.",
        )

    since_ts = int(since_dt.timestamp() * 1000)
    until_ts = int(until_dt.timestamp() * 1000)

    try:
        project_ids = get_board_project_ids(base_url, token, board.board_id)
    except Exception as e:
        raise HTTPException(502, f"Failed to get board projects: {e}")

    if not project_ids:
        raise HTTPException(404, "No projects found for this board")

    try:
        activities, _cancelled = await _run_with_cancel_watch(
            request, fetch_activities, base_url, token, project_ids, since_ts, until_ts,
        )
    except Exception as e:
        raise HTTPException(502, f"YouTrack activities API error: {e}")

    return BoardActivityResponse(
        board_id=board.id,
        board_name=board.board_name,
        since=body.since,
        until=body.until,
        activities=activities,
    )


@router.post("/boards/{board_db_id}/activity/summarize", response_model=ActivitySummaryResponse)
async def summarize_board_activity(
    board_db_id: str,
    body: ActivitySummaryRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Fetch activity in range, then ask the LLM to summarize it.

    Gated on YouTrack mode: the entire /youtrack router is only registered
    when PT_YOUTRACK_ENABLED is true.
    """
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")

    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")

    from datetime import datetime, timedelta, timezone

    try:
        since_dt = datetime.strptime(body.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        until_dt = datetime.strptime(body.until, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
    except ValueError:
        raise HTTPException(422, "Invalid date format. Use YYYY-MM-DD.")

    if since_dt > until_dt:
        raise HTTPException(422, "'since' date must not be after 'until' date.")
    if until_dt - since_dt > timedelta(days=180):
        raise HTTPException(422, "Date range must not exceed 180 days.")

    since_ts = int(since_dt.timestamp() * 1000)
    until_ts = int(until_dt.timestamp() * 1000)

    try:
        project_ids = get_board_project_ids(base_url, token, board.board_id)
    except Exception as e:
        raise HTTPException(502, f"Failed to get board projects: {e}")
    if not project_ids:
        raise HTTPException(404, "No projects found for this board")

    try:
        activities, _cancelled = await _run_with_cancel_watch(
            request, fetch_activities, base_url, token, project_ids, since_ts, until_ts,
        )
    except Exception as e:
        raise HTTPException(502, f"YouTrack activities API error: {e}")

    style = body.summary_style or "detailed"
    model = body.model_name or settings.default_model

    markdown, used_llm = await activity_summary_service.summarize_activity(
        board_name=board.board_name or board.board_id,
        since=body.since,
        until=body.until,
        activities=activities,
        style=style,
        model=model,
    )

    _persist_activity_summary(
        source_type="board",
        source_id=board.id,
        source_name=board.board_name or board.board_id,
        since=body.since, until=body.until, style=style, model=model,
        activity_count=len(activities), markdown=markdown, used_llm=used_llm,
    )

    from datetime import datetime as _dt, timezone as _tz  # noqa: PLC0415
    return ActivitySummaryResponse(
        board_id=board.id,
        board_name=board.board_name,
        since=body.since,
        until=body.until,
        summary_style=style,
        model_name=model,
        activity_count=len(activities),
        summary_markdown=markdown,
        used_llm=used_llm,
        generated_at=_dt.now(_tz.utc),
    )


# ── Projects ──

@router.get("/projects", response_model=list[YouTrackProjectRead])
def list_youtrack_projects(
    include_archived: bool = False,
    db: Session = Depends(get_db),
):
    """List projects visible to the current token."""
    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")
    try:
        projects = list_projects(base_url, token, include_archived=include_archived)
    except httpx.HTTPStatusError as e:
        if e.response.status_code in (401, 403):
            raise HTTPException(403, "Token lacks permission to list projects.")
        raise HTTPException(502, f"YouTrack API error: {e}")
    except Exception as e:
        raise HTTPException(502, f"YouTrack API error: {e}")
    return projects


async def _run_with_cancel_watch(
    request: Request,
    fn: Callable,
    *args,
    **kwargs,
):
    """Run a blocking callable in a thread and interrupt it when the HTTP
    client disconnects (Axios AbortController from the UI).

    The callable must accept `should_stop: Callable[[], bool] | None` as a kwarg;
    when we signal it, the callable should stop at its next natural checkpoint.

    Note: client-disconnect detection relies on Starlette's
    `request.is_disconnected()`, which only fires reliably when the ASGI server
    surfaces `http.disconnect`. In some dev configs (e.g. uvicorn --reload on
    macOS) the close isn't surfaced until the server attempts a socket write,
    so cancellation may not always propagate server-side — but the UI is
    always freed up by the client-side abort.
    """
    stop = threading.Event()

    async def watcher():
        try:
            while not stop.is_set():
                if await request.is_disconnected():
                    stop.set()
                    logger.info("Client disconnected — signalling cancel on %s", fn.__name__)
                    return
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("Disconnect watcher error: %s", e)

    w = asyncio.create_task(watcher())
    try:
        return await asyncio.to_thread(fn, *args, should_stop=stop.is_set, **kwargs), stop.is_set()
    finally:
        stop.set()
        w.cancel()
        try:
            await w
        except asyncio.CancelledError:
            pass


def _parse_date_range(since: str, until: str, max_days: int = 180):
    from datetime import datetime, timedelta, timezone
    try:
        s = datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        u = datetime.strptime(until, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
    except ValueError:
        raise HTTPException(422, "Invalid date format. Use YYYY-MM-DD.")
    if s > u:
        raise HTTPException(422, "'since' date must not be after 'until' date.")
    if u - s > timedelta(days=max_days):
        raise HTTPException(422, f"Date range must not exceed {max_days} days.")
    return int(s.timestamp() * 1000), int(u.timestamp() * 1000)


@router.post("/projects/{short_name}/activity", response_model=ProjectActivityResponse)
async def get_project_activity(
    short_name: str,
    body: ActivityRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Fetch all activity across an entire project in a date range.

    Cancellation: the per-issue fetch loop is interrupted when the client
    disconnects (Axios AbortController from the UI), saving YouTrack API calls.
    """
    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")

    since_ts, until_ts = _parse_date_range(body.since, body.until)

    # Resolve project name (best-effort; fall back to short_name)
    project_name = short_name
    try:
        projects = list_projects(base_url, token, include_archived=True)
        match = next((p for p in projects if p["short_name"] == short_name), None)
        if match:
            project_name = match["name"]
    except Exception as e:
        logger.warning("Failed to resolve project name for %s: %s", short_name, e)

    try:
        activities, cancelled = await _run_with_cancel_watch(
            request,
            fetch_activities,
            base_url, token, [short_name], since_ts, until_ts,
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(404, f"Project '{short_name}' not found on YouTrack")
        raise HTTPException(502, f"YouTrack activities API error: {e}")
    except Exception as e:
        raise HTTPException(502, f"YouTrack activities API error: {e}")

    if cancelled:
        logger.info("get_project_activity returning after client cancel: %d events", len(activities))

    return ProjectActivityResponse(
        project_short_name=short_name,
        project_name=project_name,
        since=body.since,
        until=body.until,
        activities=activities,
    )


@router.post("/projects/{short_name}/activity/stream")
async def stream_project_activity(
    short_name: str,
    body: ActivityRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """NDJSON stream of progress events and a final 'done' event with the
    full ProjectActivityResponse payload.

    Line types:
      {"type":"status","phase":"listing_issues"|"fetching_activities"|"cancelled"}
      {"type":"progress","done":int,"total":int,"events_so_far":int}
      {"type":"done","response": {...ProjectActivityResponse...}}
      {"type":"error","detail":str}
    """
    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")

    since_ts, until_ts = _parse_date_range(body.since, body.until)

    # Resolve project name (best-effort)
    project_name = short_name
    try:
        projects = list_projects(base_url, token, include_archived=True)
        match = next((p for p in projects if p["short_name"] == short_name), None)
        if match:
            project_name = match["name"]
    except Exception as e:
        logger.warning("Failed to resolve project name for %s: %s", short_name, e)

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue[dict] = asyncio.Queue()
    stop = threading.Event()

    def on_progress(info: dict) -> None:
        # Runs in the worker thread — hand off to the loop safely.
        try:
            asyncio.run_coroutine_threadsafe(queue.put({"type": "progress", **info}), loop)
        except Exception:  # noqa: BLE001
            pass

    async def disconnect_watcher() -> None:
        try:
            while not stop.is_set():
                if await request.is_disconnected():
                    stop.set()
                    logger.info("stream_project_activity: client disconnected")
                    return
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("stream disconnect watcher error: %s", e)

    async def runner() -> None:
        try:
            activities = await asyncio.to_thread(
                fetch_activities,
                base_url, token, [short_name], since_ts, until_ts,
                stop.is_set, on_progress,
            )
            payload = ProjectActivityResponse(
                project_short_name=short_name,
                project_name=project_name,
                since=body.since,
                until=body.until,
                activities=activities,
            )
            await queue.put({"type": "done", "response": payload.model_dump(mode="json")})
        except httpx.HTTPStatusError as e:
            detail = (
                f"Project '{short_name}' not found on YouTrack"
                if e.response.status_code == 404
                else f"YouTrack API error: {e}"
            )
            await queue.put({"type": "error", "detail": detail})
        except Exception as e:  # noqa: BLE001
            await queue.put({"type": "error", "detail": f"YouTrack API error: {e}"})

    async def generate():
        watcher = asyncio.create_task(disconnect_watcher())
        task = asyncio.create_task(runner())
        try:
            # announce start immediately so the client sees "we're working"
            yield json.dumps({"type": "status", "phase": "started", "project_name": project_name, "short_name": short_name}) + "\n"
            while True:
                msg = await queue.get()
                yield json.dumps(msg) + "\n"
                if msg.get("type") in ("done", "error"):
                    break
        finally:
            stop.set()
            watcher.cancel()
            task.cancel()
            for t in (watcher, task):
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            # Prevent intermediate (browser/proxy/CDN) buffering of the stream
            "Cache-Control": "no-cache, no-store, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post(
    "/projects/{short_name}/activity/summarize",
    response_model=ProjectActivitySummaryResponse,
)
async def summarize_project_activity(
    short_name: str,
    body: ActivitySummaryRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Fetch project activity in range, then ask the LLM to summarize it.

    Cancellation: the activity fetch (usually the longest step) is cancelled
    when the client disconnects. If the LLM is already running when the user
    cancels, the response will still be generated but discarded by the client.
    """
    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")

    since_ts, until_ts = _parse_date_range(body.since, body.until)

    project_name = short_name
    try:
        projects = list_projects(base_url, token, include_archived=True)
        match = next((p for p in projects if p["short_name"] == short_name), None)
        if match:
            project_name = match["name"]
    except Exception as e:
        logger.warning("Failed to resolve project name for %s: %s", short_name, e)

    try:
        # Reuse a just-fetched window instead of hitting YouTrack again.
        activities, _cancelled = await _run_with_cancel_watch(
            request,
            fetch_activities_cached,
            base_url, token, [short_name], since_ts, until_ts,
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(404, f"Project '{short_name}' not found on YouTrack")
        raise HTTPException(502, f"YouTrack activities API error: {e}")
    except Exception as e:
        raise HTTPException(502, f"YouTrack activities API error: {e}")

    style = body.summary_style or "detailed"
    model = body.model_name or settings.default_model

    markdown, used_llm = await activity_summary_service.summarize_activity(
        board_name=f"{project_name} ({short_name})",
        since=body.since,
        until=body.until,
        activities=activities,
        style=style,
        model=model,
    )

    _persist_activity_summary(
        source_type="project",
        source_id=short_name,
        source_name=f"{project_name} ({short_name})",
        since=body.since, until=body.until, style=style, model=model,
        activity_count=len(activities), markdown=markdown, used_llm=used_llm,
    )

    from datetime import datetime as _dt, timezone as _tz  # noqa: PLC0415
    return ProjectActivitySummaryResponse(
        project_short_name=short_name,
        project_name=project_name,
        since=body.since,
        until=body.until,
        summary_style=style,
        model_name=model,
        activity_count=len(activities),
        summary_markdown=markdown,
        used_llm=used_llm,
        generated_at=_dt.now(_tz.utc),
    )


# ── Streaming summarize: emits phase/progress events, then final done payload ──

def _stream_summarize(
    *,
    request: Request,
    token: str,
    base_url: str,
    project_ids: list[str],
    display_name: str,
    body: ActivitySummaryRequest,
    since_ts: int,
    until_ts: int,
    build_response: Callable[[list[ActivityItem], str, str, bool], dict],
    persist_source_type: str,
    persist_source_id: str,
):
    """Shared NDJSON generator for summarize streams (project + board)."""
    from datetime import datetime as _dt, timezone as _tz  # noqa: PLC0415

    style = body.summary_style or "detailed"
    model = body.model_name or settings.default_model
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue[dict] = asyncio.Queue()
    stop = threading.Event()

    def on_progress(info: dict) -> None:
        try:
            asyncio.run_coroutine_threadsafe(queue.put({"type": "progress", **info}), loop)
        except Exception:  # noqa: BLE001
            pass

    async def disconnect_watcher() -> None:
        try:
            while not stop.is_set():
                if await request.is_disconnected():
                    stop.set()
                    return
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            raise

    async def runner() -> None:
        try:
            # Reuse a just-fetched window instead of hitting YouTrack again.
            activities = await asyncio.to_thread(
                fetch_activities_cached,
                base_url, token, project_ids, since_ts, until_ts,
                stop.is_set, on_progress,
            )
            await queue.put({"type": "status", "phase": "generating", "model": model, "activity_count": len(activities)})
            markdown, used_llm = await activity_summary_service.summarize_activity(
                board_name=display_name,
                since=body.since,
                until=body.until,
                activities=activities,
                style=style,
                model=model,
            )
            response = build_response(activities, markdown, model, used_llm)
            response["generated_at"] = _dt.now(_tz.utc).isoformat()
            response["summary_style"] = style
            response["model_name"] = model
            response["activity_count"] = len(activities)
            response["summary_markdown"] = markdown
            response["used_llm"] = used_llm
            response["since"] = body.since
            response["until"] = body.until
            saved_id = _persist_activity_summary(
                source_type=persist_source_type,
                source_id=persist_source_id,
                source_name=display_name,
                since=body.since, until=body.until, style=style, model=model,
                activity_count=len(activities), markdown=markdown, used_llm=used_llm,
            )
            if saved_id:
                response["id"] = saved_id
            await queue.put({"type": "done", "response": response})
        except httpx.HTTPStatusError as e:
            detail = f"YouTrack API error: {e}"
            if e.response.status_code == 404:
                detail = f"Resource not found: {e}"
            await queue.put({"type": "error", "detail": detail})
        except Exception as e:  # noqa: BLE001
            await queue.put({"type": "error", "detail": f"Summarize error: {e}"})

    async def generate():
        watcher = asyncio.create_task(disconnect_watcher())
        task = asyncio.create_task(runner())
        try:
            yield json.dumps({"type": "status", "phase": "fetching_activity", "source": display_name}) + "\n"
            while True:
                msg = await queue.get()
                yield json.dumps(msg) + "\n"
                if msg.get("type") in ("done", "error"):
                    break
        finally:
            stop.set()
            watcher.cancel()
            task.cancel()
            for t in (watcher, task):
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-store, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/projects/{short_name}/activity/summarize/stream")
async def stream_summarize_project_activity(
    short_name: str,
    body: ActivitySummaryRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")
    since_ts, until_ts = _parse_date_range(body.since, body.until)

    project_name = short_name
    try:
        projects = list_projects(base_url, token, include_archived=True)
        match = next((p for p in projects if p["short_name"] == short_name), None)
        if match:
            project_name = match["name"]
    except Exception as e:
        logger.warning("Failed to resolve project name for %s: %s", short_name, e)

    def build_response(activities: list[ActivityItem], markdown: str, model: str, used_llm: bool) -> dict:
        return {
            "project_short_name": short_name,
            "project_name": project_name,
        }

    return _stream_summarize(
        request=request,
        token=token,
        base_url=base_url,
        project_ids=[short_name],
        display_name=f"{project_name} ({short_name})",
        body=body,
        since_ts=since_ts,
        until_ts=until_ts,
        build_response=build_response,
        persist_source_type="project",
        persist_source_id=short_name,
    )


@router.post("/boards/{board_db_id}/activity/summarize/stream")
async def stream_summarize_board_activity(
    board_db_id: str,
    body: ActivitySummaryRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")

    token = _get_token(db)
    base_url = _get_base_url(db)
    if not base_url:
        raise HTTPException(400, "YouTrack base URL not configured")
    since_ts, until_ts = _parse_date_range(body.since, body.until)

    try:
        project_ids = get_board_project_ids(base_url, token, board.board_id)
    except Exception as e:
        raise HTTPException(502, f"Failed to get board projects: {e}")
    if not project_ids:
        raise HTTPException(404, "No projects found for this board")

    def build_response(activities: list[ActivityItem], markdown: str, model: str, used_llm: bool) -> dict:
        return {
            "board_id": board.id,
            "board_name": board.board_name,
        }

    return _stream_summarize(
        request=request,
        token=token,
        base_url=base_url,
        project_ids=project_ids,
        display_name=board.board_name or board.board_id,
        body=body,
        since_ts=since_ts,
        until_ts=until_ts,
        build_response=build_response,
        persist_source_type="board",
        persist_source_id=board.id,
    )


# ── Persisted activity summaries (read + list + delete) ──

@router.get("/activity-summaries", response_model=list[ActivitySummaryRead])
def list_activity_summaries(
    limit: int = 100,
    db: Session = Depends(get_db),
):
    return (
        db.query(ActivitySummary)
        .order_by(ActivitySummary.generated_at.desc())
        .limit(max(1, min(limit, 500)))
        .all()
    )


@router.get("/activity-summaries/{summary_id}", response_model=ActivitySummaryRead)
def get_activity_summary(summary_id: str, db: Session = Depends(get_db)):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")
    return row


@router.delete("/activity-summaries/{summary_id}", status_code=204)
def delete_activity_summary(summary_id: str, db: Session = Depends(get_db)):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")
    db.delete(row)
    db.commit()
