"""YouTrack board tracking endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import YouTrackBoard, YouTrackConfig, YouTrackIssueSnapshot
from app.schemas import (
    ActivityRequest,
    BoardActivityResponse,
    BoardSyncResult,
    YouTrackBoardAdd,
    YouTrackBoardRead,
    YouTrackConfigCreate,
    YouTrackConfigRead,
    YouTrackIssueRead,
)
from app.services.youtrack_service import (
    extract_base_url,
    extract_board_id,
    fetch_activities,
    fetch_board_info,
    get_board_project_ids,
    sync_board,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/youtrack", tags=["youtrack"])

def _get_token() -> str:
    """Get YouTrack API token from environment. Never stored in DB."""
    if not settings.youtrack_api_token:
        raise HTTPException(400, "PT_YOUTRACK_API_TOKEN not set. Configure it in .env or environment.")
    return settings.youtrack_api_token

def _get_base_url(db: Session) -> str:
    """Get base URL from DB config or env."""
    cfg = db.query(YouTrackConfig).first()
    return cfg.base_url if cfg else settings.youtrack_base_url

# ── Config ──

@router.get("/config", response_model=YouTrackConfigRead | None)
def get_config(db: Session = Depends(get_db)):
    cfg = db.query(YouTrackConfig).first()
    return cfg

@router.post("/config", response_model=YouTrackConfigRead, status_code=201)
def set_config(body: YouTrackConfigCreate, db: Session = Depends(get_db)):
    existing = db.query(YouTrackConfig).first()
    if existing:
        existing.base_url = body.base_url
        db.commit()
        db.refresh(existing)
        return existing
    cfg = YouTrackConfig(base_url=body.base_url)
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return cfg

@router.delete("/config", status_code=204)
def delete_config(db: Session = Depends(get_db)):
    existing = db.query(YouTrackConfig).first()
    if existing:
        db.delete(existing)
        db.commit()

# ── Boards ──

@router.get("/boards", response_model=list[YouTrackBoardRead])
def list_boards(db: Session = Depends(get_db)):
    return db.query(YouTrackBoard).all()

@router.post("/boards", response_model=YouTrackBoardRead, status_code=201)
def add_board(body: YouTrackBoardAdd, db: Session = Depends(get_db)):
    token = _get_token()
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

@router.post("/boards/{board_db_id}/sync", response_model=BoardSyncResult)
def sync_board_endpoint(board_db_id: str, db: Session = Depends(get_db)):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")
    try:
        changes = sync_board(db, board)
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
    )

@router.post("/sync-all", response_model=list[BoardSyncResult])
def sync_all_boards(db: Session = Depends(get_db)):
    boards = db.query(YouTrackBoard).all()
    results = []
    for board in boards:
        try:
            changes = sync_board(db, board)
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
def get_board_activity(
    board_db_id: str,
    body: ActivityRequest,
    db: Session = Depends(get_db),
):
    board = db.get(YouTrackBoard, board_db_id)
    if not board:
        raise HTTPException(404, "Board not found")

    token = _get_token()
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
        activities = fetch_activities(base_url, token, project_ids, since_ts, until_ts)
    except Exception as e:
        raise HTTPException(502, f"YouTrack activities API error: {e}")

    return BoardActivityResponse(
        board_id=board.id,
        board_name=board.board_name,
        since=body.since,
        until=body.until,
        activities=activities,
    )
