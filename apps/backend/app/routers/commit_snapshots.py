import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import CommitSnapshot
from app.schemas import CommitSnapshotCreate, CommitSnapshotRead, ItemLabelUpdate, SummaryCommentCreate, SummaryCommentRead
from app.services import comment_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/commit-snapshots", tags=["commit-snapshots"])


@router.post("", response_model=CommitSnapshotRead, status_code=201)
def create_commit_snapshot(body: CommitSnapshotCreate, db: Session = Depends(get_db)):
    raw = json.dumps([c for c in body.commits], default=str)
    snap = CommitSnapshot(
        repository_id=body.repository_id,
        repo_name=body.repo_name,
        since=body.since,
        until=body.until,
        branch=body.branch,
        base_branch=body.base_branch,
        commit_count=len(body.commits),
        raw_json=raw,
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    return snap


@router.get("", response_model=list[CommitSnapshotRead])
def list_commit_snapshots(
    repository_id: str | None = Query(None),
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
):
    q = db.query(CommitSnapshot)
    if repository_id:
        q = q.filter(CommitSnapshot.repository_id == repository_id)
    return q.order_by(CommitSnapshot.created_at.desc()).limit(limit).all()


@router.get("/{snapshot_id}/raw")
def get_commit_snapshot_raw(snapshot_id: str, db: Session = Depends(get_db)):
    snap = db.get(CommitSnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Commit snapshot not found")
    return {"commits": json.loads(snap.raw_json)}


@router.delete("/{snapshot_id}", status_code=204)
def delete_commit_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    snap = db.get(CommitSnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Commit snapshot not found")
    db.delete(snap)
    db.commit()


@router.patch("/{snapshot_id}/label", response_model=CommitSnapshotRead)
def update_commit_snapshot_label(snapshot_id: str, body: ItemLabelUpdate, db: Session = Depends(get_db)):
    snap = db.get(CommitSnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Commit snapshot not found")
    snap.user_label = body.user_label.strip() if body.user_label else None
    db.commit()
    db.refresh(snap)
    return snap


@router.get("/{snapshot_id}/comments", response_model=list[SummaryCommentRead])
def list_commit_snapshot_comments(snapshot_id: str, db: Session = Depends(get_db)):
    if not db.get(CommitSnapshot, snapshot_id):
        raise HTTPException(404, "Commit snapshot not found")
    return comment_service.list_comments(db, "git-snapshot", snapshot_id)


@router.post("/{snapshot_id}/comments", response_model=SummaryCommentRead, status_code=201)
def create_commit_snapshot_comment(
    snapshot_id: str,
    body: SummaryCommentCreate,
    db: Session = Depends(get_db),
):
    if not db.get(CommitSnapshot, snapshot_id):
        raise HTTPException(404, "Commit snapshot not found")
    return comment_service.create_comment(
        db,
        summary_type="git-snapshot",
        summary_id=snapshot_id,
        comment_type=body.comment_type,
        user_content=body.user_content,
    )


@router.delete("/{snapshot_id}/comments/{comment_id}", status_code=204)
def delete_commit_snapshot_comment(snapshot_id: str, comment_id: str, db: Session = Depends(get_db)):
    c = comment_service.get_comment(db, comment_id)
    if not c or c.summary_type != "git-snapshot" or c.summary_id != snapshot_id:
        raise HTTPException(404, "Comment not found")
    comment_service.delete_comment(db, comment_id)


@router.post("/{snapshot_id}/comments/{comment_id}/generate")
async def generate_commit_snapshot_comment_reply(
    snapshot_id: str,
    comment_id: str,
    db: Session = Depends(get_db),
):
    snap = db.get(CommitSnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Commit snapshot not found")

    c = comment_service.get_comment(db, comment_id)
    if not c or c.summary_type != "git-snapshot" or c.summary_id != snapshot_id:
        raise HTTPException(404, "Comment not found")
    if c.comment_type != "request":
        raise HTTPException(400, "Only 'request' comments can generate AI replies")

    commits = json.loads(snap.raw_json)
    lines = [f"Repository: {snap.repo_name}"]
    if snap.since or snap.until:
        lines.append(f"Date range: {snap.since or '?'} → {snap.until or '?'}")
    if snap.branch:
        base = f" vs {snap.base_branch}" if snap.base_branch else ""
        lines.append(f"Branch: {snap.branch}{base}")
    lines.append(f"Total commits: {snap.commit_count}\n")
    for entry in commits[:200]:
        date = str(entry.get("committed_at", ""))[:10]
        lines.append(f"- [{date}] {entry.get('author_name', '')} — {entry.get('subject', '')}")

    return await comment_service.stream_reply(
        db,
        summary_type="git-snapshot",
        parent_id=snapshot_id,
        comment=c,
        context_markdown="\n".join(lines),
        model=settings.default_model,
    )
