"""YouTrack board tracking endpoints."""

import asyncio
import json
import logging
import re
import threading
from typing import Callable

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.database import SessionLocal
from app.services import job_manager
from app.models import ActivitySnapshot, ActivitySummary, SummaryComment, TrackedIssue, YouTrackBoard, YouTrackConfig, YouTrackIssueSnapshot
from app.schemas import (
    ActivityItem,
    ActivityRequest,
    ActivitySnapshotCreate,
    ActivitySnapshotRead,
    ActivitySnapshotSummarizeRequest,
    ActivitySummaryRead,
    ActivitySummaryFromEventsRequest,
    BoardActivityResponse,
    BoardSyncRequest,
    BoardSyncResult,
    IssueActivityRequest,
    IssueSearchResult,
    ItemLabelUpdate,
    ProjectActivityResponse,
    SummaryCommentCreate,
    SummaryCommentRead,
    TrackedIssueCreate,
    TrackedIssueRead,
    YouTrackBoardAdd,
    YouTrackBoardRead,
    YouTrackConfigCreate,
    YouTrackConfigRead,
    YouTrackIssueRead,
    YouTrackProjectRead,
    YouTrackTestRequest,
    YouTrackTestResponse,
)
from app.services import activity_summary_service, comment_service
from app.services.crypto import encrypt
from app.services.youtrack_service import (
    extract_base_url,
    extract_board_id,
    fetch_activities,
    fetch_board_info,
    fetch_issues_activity,
    get_issue_state,
    search_issues,
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
    custom_prompt: str | None = None,
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
            custom_prompt=custom_prompt,
            model_name=model,
            activity_count=activity_count,
            summary_markdown=markdown,
            used_llm=used_llm,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id
    except Exception as e:
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
        except Exception as e:
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
        try:
            asyncio.run_coroutine_threadsafe(queue.put({"type": "progress", **info}), loop)
        except Exception:
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
        except Exception as e:
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
        except Exception as e:
            await queue.put({"type": "error", "detail": f"YouTrack API error: {e}"})

    async def generate():
        watcher = asyncio.create_task(disconnect_watcher())
        task = asyncio.create_task(runner())
        try:
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
                except (asyncio.CancelledError, Exception):
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


def _stream_activity_summary(
    *,
    request: Request,
    activities: list[ActivityItem],
    display_name: str,
    since: str,
    until: str,
    style: str,
    model: str,
    custom_prompt: str | None,
    persist_source_type: str,
    persist_source_id: str,
    initial_phase: str = "generating",
) -> StreamingResponse:
    """Summarise a fixed set of activities, streaming NDJSON (status/token/done/error)
    and persisting the result as a new ActivitySummary. Shared by the inline-events
    and saved-snapshot summarize endpoints."""
    from datetime import datetime as _dt, timezone as _tz

    queue: asyncio.Queue[dict] = asyncio.Queue()

    async def runner() -> None:
        try:
            await queue.put({"type": "status", "phase": "generating", "model": model, "activity_count": len(activities)})

            async def on_token(text: str) -> None:
                await queue.put({"type": "token", "text": text})

            markdown, used_llm = await activity_summary_service.summarize_activity(
                board_name=display_name, since=since, until=until, activities=activities,
                style=style, model=model, custom_prompt=custom_prompt, on_token=on_token,
            )
            saved_id = _persist_activity_summary(
                source_type=persist_source_type, source_id=persist_source_id,
                source_name=display_name, since=since, until=until, style=style, model=model,
                activity_count=len(activities), markdown=markdown, used_llm=used_llm,
                custom_prompt=custom_prompt,
            )
            response: dict = {
                "since": since, "until": until, "summary_style": style, "model_name": model,
                "activity_count": len(activities), "summary_markdown": markdown,
                "used_llm": used_llm, "generated_at": _dt.now(_tz.utc).isoformat(),
            }
            if custom_prompt:
                response["custom_prompt"] = custom_prompt
            if saved_id:
                response["id"] = saved_id
            await queue.put({"type": "done", "response": response})
        except Exception as e:
            await queue.put({"type": "error", "detail": f"Summarize error: {e}"})

    async def generate():
        task = asyncio.create_task(runner())
        try:
            yield json.dumps({"type": "status", "phase": initial_phase, "source": display_name}) + "\n"
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    continue
                yield json.dumps(msg) + "\n"
                if msg.get("type") in ("done", "error"):
                    break
        finally:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.post("/activity/summarize/stream")
async def stream_summarize_from_events(
    body: ActivitySummaryFromEventsRequest,
    request: Request,
):
    """Summarise already-fetched events (sent inline) without re-querying YouTrack.

    Used by the Activity view, where the events are already loaded in the browser.
    """
    style = body.summary_style or "detailed"
    return _stream_activity_summary(
        request=request,
        activities=body.activities,
        display_name=body.source_name,
        since=body.since,
        until=body.until,
        style=style,
        model=body.model_name or settings.default_model,
        custom_prompt=body.custom_prompt if style == "custom" else None,
        persist_source_type=body.source_type,
        persist_source_id=body.source_id,
    )



@router.post("/activity-snapshots", response_model=ActivitySnapshotRead, status_code=201)
def create_activity_snapshot(body: ActivitySnapshotCreate, db: Session = Depends(get_db)):
    raw = json.dumps([a.model_dump() for a in body.activities], default=str)
    snap = ActivitySnapshot(
        source_type=body.source_type,
        source_id=body.source_id,
        source_name=body.source_name,
        since=body.since,
        until=body.until,
        activity_count=len(body.activities),
        raw_json=raw,
        view_mode=body.view_mode if body.view_mode in ("timeline", "by-issue") else "timeline",
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    return snap


@router.get("/activity-snapshots", response_model=list[ActivitySnapshotRead])
def list_activity_snapshots(
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
):
    return (
        db.query(ActivitySnapshot)
        .order_by(ActivitySnapshot.created_at.desc())
        .limit(limit)
        .all()
    )


@router.get("/activity-snapshots/{snapshot_id}/raw")
def get_activity_snapshot_raw(snapshot_id: str, db: Session = Depends(get_db)):
    snap = db.get(ActivitySnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Activity snapshot not found")
    return {"activities": json.loads(snap.raw_json)}


@router.post("/activity-snapshots/{snapshot_id}/summarize", response_model=ActivitySummaryRead, status_code=201)
async def summarize_activity_snapshot(
    snapshot_id: str,
    body: ActivitySnapshotSummarizeRequest,
    db: Session = Depends(get_db),
):
    """Summarise a saved activity snapshot in the background.

    Returns immediately with a ``running`` ActivitySummary; generation continues
    server-side (surviving a page refresh) and the client polls for completion.
    """
    snap = db.get(ActivitySnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Activity snapshot not found")

    activities = [ActivityItem(**item) for item in json.loads(snap.raw_json)]
    style = body.summary_style or "detailed"
    model = body.model_name or settings.default_model
    custom_prompt = body.custom_prompt if style == "custom" else None
    display_name = snap.user_label or snap.source_name

    row = ActivitySummary(
        source_type=snap.source_type,
        source_id=snap.source_id,
        source_name=display_name,
        since=snap.since,
        until=snap.until,
        summary_style=style,
        custom_prompt=custom_prompt,
        model_name=model,
        activity_count=len(activities),
        summary_markdown="",
        used_llm=True,
        status="running",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    summary_id = row.id

    async def work(bg_db):
        markdown, used_llm = await activity_summary_service.summarize_activity(
            board_name=display_name, since=snap.since, until=snap.until,
            activities=activities, style=style, model=model, custom_prompt=custom_prompt,
        )
        r = bg_db.get(ActivitySummary, summary_id)
        if r is not None:
            r.summary_markdown = markdown
            r.used_llm = used_llm
            r.status = "completed"
            bg_db.commit()

    def set_terminal(bg_db, status, error):
        r = bg_db.get(ActivitySummary, summary_id)
        if r is not None:
            r.status = status
            r.error = error
            bg_db.commit()

    await job_manager.launch(summary_id, work, set_terminal)
    db.refresh(row)
    return row


@router.post("/activity-summaries/{summary_id}/cancel", response_model=ActivitySummaryRead)
def cancel_activity_summary(summary_id: str, db: Session = Depends(get_db)):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")
    if row.status in ("pending", "running"):
        if not job_manager.cancel(summary_id):
            row.status = "cancelled"
            row.error = "Cancelled by user."
            db.commit()
    return get_activity_summary(summary_id, db)


@router.delete("/activity-snapshots/{snapshot_id}", status_code=204)
def delete_activity_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    snap = db.get(ActivitySnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Activity snapshot not found")
    db.delete(snap)
    db.commit()


@router.patch("/activity-snapshots/{snapshot_id}/label", response_model=ActivitySnapshotRead)
def update_activity_snapshot_label(snapshot_id: str, body: ItemLabelUpdate, db: Session = Depends(get_db)):
    snap = db.get(ActivitySnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Activity snapshot not found")
    snap.user_label = body.user_label.strip() if body.user_label else None
    db.commit()
    db.refresh(snap)
    return snap



@router.get("/activity-snapshots/{snapshot_id}/comments", response_model=list[SummaryCommentRead])
def list_snapshot_comments(snapshot_id: str, db: Session = Depends(get_db)):
    if not db.get(ActivitySnapshot, snapshot_id):
        raise HTTPException(404, "Activity snapshot not found")
    return comment_service.list_comments(db, "activity-snapshot", snapshot_id)


@router.post(
    "/activity-snapshots/{snapshot_id}/comments",
    response_model=SummaryCommentRead,
    status_code=201,
)
def create_snapshot_comment(
    snapshot_id: str,
    body: SummaryCommentCreate,
    db: Session = Depends(get_db),
):
    if not db.get(ActivitySnapshot, snapshot_id):
        raise HTTPException(404, "Activity snapshot not found")
    return comment_service.create_comment(
        db,
        summary_type="activity-snapshot",
        summary_id=snapshot_id,
        comment_type=body.comment_type,
        user_content=body.user_content,
    )


@router.delete("/activity-snapshots/{snapshot_id}/comments/{comment_id}", status_code=204)
def delete_snapshot_comment(
    snapshot_id: str, comment_id: str, db: Session = Depends(get_db)
):
    c = comment_service.get_comment(db, comment_id)
    if not c or c.summary_type != "activity-snapshot" or c.summary_id != snapshot_id:
        raise HTTPException(404, "Comment not found")
    comment_service.delete_comment(db, comment_id)


_ISSUE_ID_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")
_TOKENS_PER_EVENT_LINE = 30


async def _resolve_event_line_budget(model: str) -> int:
    """How many raw event lines fit the model's context (after scaffold/output)."""
    from app.services import llm_budget

    tokens = await llm_budget.resolve_token_budget(model, reserved=2_000)
    return max(80, tokens // _TOKENS_PER_EVENT_LINE)


def _build_snapshot_reply_context(
    snap, events: list, question: str, tz: str | None, max_lines: int,
) -> str:
    """Build the LLM context for an activity-snapshot follow-up question.

    If the question references specific issue IDs (e.g. "PROJ-123"), that issue's
    *entire* activity is surfaced up-front (grouped by issue), regardless of the
    overall event cap — so questions about a specific issue always have full
    context. The remaining activity follows in chronological order (capped).
    """
    from datetime import datetime as _dt, timezone as _utc

    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo(tz) if tz else _utc.utc
    except Exception:
        zone = _utc.utc

    def fmt_ts(ms) -> str:
        try:
            return _dt.fromtimestamp(int(ms) / 1000, tz=zone).strftime("%Y-%m-%d %H:%M %Z")
        except Exception:
            return str(ms)

    def ts(ev) -> int:
        try:
            return int(ev.get("timestamp") or 0)
        except Exception:
            return 0

    def line(ev, *, with_issue: bool) -> str:
        bits = [fmt_ts(ev.get("timestamp"))]
        if with_issue and ev.get("issue_id"):
            bits.append(str(ev["issue_id"]))
        if ev.get("activity_type"):
            bits.append(str(ev["activity_type"]))
        if ev.get("field"):
            bits.append(f"field={ev['field']}")
        if ev.get("old_value") or ev.get("new_value"):
            bits.append(f"{ev.get('old_value') or '∅'} → {ev.get('new_value') or '∅'}")
        if ev.get("comment_text"):
            bits.append(f"comment: {str(ev['comment_text'])[:200]}")
        if ev.get("author"):
            bits.append(f"by {ev['author']}")
        return "  " + " | ".join(bits)

    dict_events = [e for e in events if isinstance(e, dict)]
    chrono = sorted(dict_events, key=ts)

    parts = [
        f"Activity snapshot: {snap.source_name} | range {snap.since} → {snap.until} "
        f"| {len(dict_events)} event(s) shown. Each line begins with the event's real "
        f"timestamp; events are in chronological order (oldest first). Use the "
        f"timestamps — not the current date or line position — for time/ordering answers.",
    ]

    present_ids = {e.get("issue_id") for e in dict_events if e.get("issue_id")}
    mentioned = set(_ISSUE_ID_RE.findall(question or ""))
    focus_ids = [i for i in sorted(mentioned) if i in present_ids]

    if focus_ids:
        parts.append("\n## Activity for the issue(s) you asked about")
        for iid in focus_ids:
            iss_events = sorted((e for e in dict_events if e.get("issue_id") == iid), key=ts)
            summary = next((e.get("issue_summary") for e in iss_events if e.get("issue_summary")), "")
            parts.append(f"\n### {iid}" + (f" — {summary}" if summary else ""))
            parts.extend(line(e, with_issue=False) for e in iss_events)
        missing = sorted(mentioned - set(focus_ids))
        if missing:
            parts.append(f"\n(No activity for {', '.join(missing)} in this snapshot.)")

    rest = [e for e in chrono if e.get("issue_id") not in focus_ids]
    if not rest:
        return "\n".join(parts)

    header = "Other activity" if focus_ids else "Activity"
    if len(rest) <= max_lines:
        parts.append(f"\n## {header}")
        parts.extend(line(e, with_issue=True) for e in rest)
    else:
        items: list[ActivityItem] = []
        for e in rest:
            try:
                items.append(ActivityItem(**e))
            except Exception:
                continue
        agg = activity_summary_service.aggregate_by_issue(items)
        parts.append(
            f"\n## {header} — {len(rest)} events across {len(agg)} issues, "
            f"summarized one line per issue (most recent first):"
        )
        for rec in agg[:max_lines]:
            parts.append("  " + activity_summary_service.format_aggregated_line(rec))
        if len(agg) > max_lines:
            parts.append(f"  (… {len(agg) - max_lines} less-recent issue(s) omitted)")

    return "\n".join(parts)


_EVENT_HAY_FIELDS = ("issue_id", "issue_summary", "author", "comment_text", "old_value", "new_value", "field")


@router.post("/activity-snapshots/{snapshot_id}/comments/{comment_id}/generate")
async def generate_snapshot_comment_reply(
    snapshot_id: str,
    comment_id: str,
    request: Request,
    tz: str | None = None,
    model: str | None = Query(None),
    filters: list[str] = Query(default=[], alias="filter"),
    type_filter: str | None = Query(default=None, alias="type"),
    db: Session = Depends(get_db),
):
    snap = db.get(ActivitySnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Activity snapshot not found")

    c = comment_service.get_request_comment_or_404(db, comment_id, summary_type="activity-snapshot", summary_id=snapshot_id)

    try:
        events = json.loads(snap.raw_json)
    except Exception:
        events = []

    events = [e for e in events if isinstance(e, dict)]
    if type_filter and type_filter != "all":
        events = [e for e in events if e.get("activity_type") == type_filter]
    if filters:
        def _hay(e: dict) -> str:
            return " ".join(str(e[k]) for k in _EVENT_HAY_FIELDS if e.get(k))
        events = [e for e in events if comment_service.matches_terms(_hay(e), filters)]

    max_lines = await _resolve_event_line_budget(model or settings.default_model)
    return await comment_service.stream_reply(
        db,
        summary_type="activity-snapshot",
        parent_id=snapshot_id,
        comment=c,
        context_markdown=_build_snapshot_reply_context(snap, events, c.user_content, tz, max_lines),
        model=model or settings.default_model,
        tz=tz,
        request=request,
    )



def _enrich_with_comment_count(rows: list[ActivitySummary], db: Session) -> list[dict]:
    """Add comment_count to each ActivitySummary row for the list response."""
    from sqlalchemy import func
    ids = [r.id for r in rows]
    if not ids:
        return []
    counts = dict(
        db.query(SummaryComment.summary_id, func.count(SummaryComment.id))
        .filter(SummaryComment.summary_type == "activity", SummaryComment.summary_id.in_(ids))
        .group_by(SummaryComment.summary_id)
        .all()
    )
    result = []
    for r in rows:
        d = ActivitySummaryRead.model_validate(r).model_dump()
        d["comment_count"] = counts.get(r.id, 0)
        result.append(d)
    return result


@router.get("/activity-summaries", response_model=list[ActivitySummaryRead])
def list_activity_summaries(
    limit: int = 100,
    db: Session = Depends(get_db),
):
    rows = (
        db.query(ActivitySummary)
        .order_by(ActivitySummary.generated_at.desc())
        .limit(max(1, min(limit, 500)))
        .all()
    )
    return _enrich_with_comment_count(rows, db)


@router.get("/activity-summaries/{summary_id}", response_model=ActivitySummaryRead)
def get_activity_summary(summary_id: str, db: Session = Depends(get_db)):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")
    d = ActivitySummaryRead.model_validate(row).model_dump()
    from sqlalchemy import func
    count = db.query(func.count(SummaryComment.id)).filter(
        SummaryComment.summary_type == "activity", SummaryComment.summary_id == summary_id,
    ).scalar() or 0
    d["comment_count"] = count
    return d


@router.delete("/activity-summaries/{summary_id}", status_code=204)
def delete_activity_summary(summary_id: str, db: Session = Depends(get_db)):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")
    db.delete(row)
    db.commit()


@router.patch("/activity-summaries/{summary_id}/label", response_model=ActivitySummaryRead)
def update_activity_summary_label(summary_id: str, body: ItemLabelUpdate, db: Session = Depends(get_db)):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")
    row.user_label = body.user_label.strip() if body.user_label else None
    db.commit()
    db.refresh(row)
    return get_activity_summary(summary_id, db)



@router.get("/activity-summaries/{summary_id}/comments", response_model=list[SummaryCommentRead])
def list_activity_comments(summary_id: str, db: Session = Depends(get_db)):
    if not db.get(ActivitySummary, summary_id):
        raise HTTPException(404, "Activity summary not found")
    return comment_service.list_comments(db, "activity", summary_id)


@router.post(
    "/activity-summaries/{summary_id}/comments",
    response_model=SummaryCommentRead,
    status_code=201,
)
def create_activity_comment(
    summary_id: str,
    body: SummaryCommentCreate,
    db: Session = Depends(get_db),
):
    if not db.get(ActivitySummary, summary_id):
        raise HTTPException(404, "Activity summary not found")
    return comment_service.create_comment(
        db,
        summary_type="activity",
        summary_id=summary_id,
        comment_type=body.comment_type,
        user_content=body.user_content,
    )


@router.delete("/activity-summaries/{summary_id}/comments/{comment_id}", status_code=204)
def delete_activity_comment(
    summary_id: str, comment_id: str, db: Session = Depends(get_db)
):
    c = comment_service.get_comment(db, comment_id)
    if not c or c.summary_type != "activity" or c.summary_id != summary_id:
        raise HTTPException(404, "Comment not found")
    comment_service.delete_comment(db, comment_id)


@router.post("/activity-summaries/{summary_id}/comments/{comment_id}/generate")
async def generate_activity_comment_reply(
    summary_id: str,
    comment_id: str,
    request: Request,
    tz: str | None = None,
    model: str | None = Query(None),
    db: Session = Depends(get_db),
):
    row = db.get(ActivitySummary, summary_id)
    if not row:
        raise HTTPException(404, "Activity summary not found")

    c = comment_service.get_request_comment_or_404(db, comment_id, summary_type="activity", summary_id=summary_id)

    return await comment_service.stream_reply(
        db,
        request=request,
        summary_type="activity",
        parent_id=summary_id,
        comment=c,
        context_markdown=row.summary_markdown,
        model=model or settings.default_model,
        tz=tz,
    )


@router.get("/issues/search", response_model=list[IssueSearchResult])
def search_yt_issues(
    q: str = Query(..., min_length=1, max_length=200),
    db: Session = Depends(get_db),
):
    token = _get_token(db)
    cfg = db.query(YouTrackConfig).first()
    if not cfg:
        raise HTTPException(400, "YouTrack not configured")
    try:
        results = search_issues(cfg.base_url, token, q)
        return results
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"YouTrack API error: {e.response.status_code}")


@router.get("/tracked-issues", response_model=list[TrackedIssueRead])
def list_tracked_issues(db: Session = Depends(get_db)):
    return db.query(TrackedIssue).order_by(TrackedIssue.added_at.desc()).all()


@router.post("/tracked-issues", response_model=TrackedIssueRead, status_code=201)
def add_tracked_issue(body: TrackedIssueCreate, db: Session = Depends(get_db)):
    existing = db.query(TrackedIssue).filter(TrackedIssue.issue_id == body.issue_id).first()
    if existing:
        return existing
    issue = TrackedIssue(
        issue_id=body.issue_id,
        summary=body.summary,
        state=body.state,
        assignee=body.assignee,
        project_short_name=body.project_short_name,
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)
    return issue


@router.delete("/tracked-issues/{tracked_id}", status_code=204)
def remove_tracked_issue(tracked_id: str, db: Session = Depends(get_db)):
    issue = db.query(TrackedIssue).filter(TrackedIssue.id == tracked_id).first()
    if issue:
        db.delete(issue)
        db.commit()


@router.post("/tracked-issues/{tracked_id}/refresh", response_model=TrackedIssueRead)
def refresh_tracked_issue(tracked_id: str, db: Session = Depends(get_db)):
    from datetime import UTC, datetime
    tracked = db.query(TrackedIssue).filter(TrackedIssue.id == tracked_id).first()
    if not tracked:
        raise HTTPException(404, "Tracked issue not found")
    token = _get_token(db)
    cfg = db.query(YouTrackConfig).first()
    if not cfg:
        raise HTTPException(400, "YouTrack not configured")
    try:
        data = get_issue_state(cfg.base_url, token, tracked.issue_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"YouTrack API error: {e.response.status_code}")
    if data:
        tracked.summary = data["summary"]
        tracked.state = data["state"]
        tracked.assignee = data["assignee"]
        tracked.last_refreshed_at = datetime.now(UTC)
        db.commit()
        db.refresh(tracked)
    return tracked


@router.post("/issues/activity", response_model=list[ActivityItem])
async def fetch_issue_activity(body: IssueActivityRequest, db: Session = Depends(get_db)):
    from datetime import UTC, datetime
    token = _get_token(db)
    cfg = db.query(YouTrackConfig).first()
    if not cfg:
        raise HTTPException(400, "YouTrack not configured")
    since_ts = int(datetime.strptime(body.since, "%Y-%m-%d").replace(tzinfo=UTC).timestamp() * 1000)
    until_ts = int(datetime.strptime(body.until, "%Y-%m-%d").replace(tzinfo=UTC).timestamp() * 1000) + 86_400_000
    tracked = db.query(TrackedIssue).filter(TrackedIssue.issue_id.in_(body.issue_ids)).all()
    summaries = {t.issue_id: t.summary for t in tracked}
    try:
        items = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: fetch_issues_activity(cfg.base_url, token, body.issue_ids, since_ts, until_ts, summaries),
        )
        return items
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"YouTrack API error: {e.response.status_code}")


@router.get("/issues/{issue_id}/commits")
def get_commits_for_issue(issue_id: str, db: Session = Depends(get_db)):
    from sqlalchemy import or_
    from app.models import CommitRecord, Repository
    from app.schemas import CommitRead
    import re as _re
    if not _re.match(r"^[A-Za-z0-9\-_]+$", issue_id):
        raise HTTPException(400, "Invalid issue ID format")
    pattern = f"%{issue_id}%"
    commits = (
        db.query(CommitRecord)
        .join(Repository, CommitRecord.repository_id == Repository.id)
        .filter(
            or_(
                CommitRecord.subject.ilike(pattern),
                CommitRecord.body.ilike(pattern),
            ),
            Repository.is_active == True,
        )
        .order_by(CommitRecord.committed_at.desc())
        .limit(200)
        .all()
    )
    return [CommitRead.model_validate(c) for c in commits]
