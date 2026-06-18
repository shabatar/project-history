import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import CommitSnapshot
from app.schemas import (
    CommitSnapshotCreate,
    CommitSnapshotRead,
    CommitSnapshotSummarizeRequest,
    ItemLabelUpdate,
    SummaryCommentCreate,
    SummaryCommentRead,
    SummaryJobWithResult,
)
from app.services import comment_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/commit-snapshots", tags=["commit-snapshots"])


def _commit_filter_haystack(cm: dict) -> str:
    """Text a commit is matched against by UI filters — includes the date (ISO +
    human forms) so a date substring filters too, mirroring the frontend."""
    raw = str(cm.get("committed_at", ""))
    date_text = raw
    try:
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        date_text = f"{d:%Y-%m-%d} {d:%a} {d:%b} {d.day} {d.year} {d:%H:%M}"
    except (ValueError, TypeError):
        pass
    return f"{cm.get('subject', '')} {cm.get('author_name', '')} {cm.get('commit_hash', '')} {date_text}"


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
        user_label=(body.user_label or "").strip() or None,
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


@router.post("/{snapshot_id}/summarize", response_model=SummaryJobWithResult, status_code=201)
async def summarize_commit_snapshot(
    snapshot_id: str,
    body: CommitSnapshotSummarizeRequest,
    db: Session = Depends(get_db),
):
    """Generate an AI summary from a saved commit snapshot, persisted as a new git-summary report.

    Summarises the commits stored in the snapshot itself (not re-queried from the DB),
    so it works regardless of the snapshot's date range, branch, or repository state.
    """
    from datetime import datetime

    from app.models import CommitRecord
    from app.repositories.summary_repository import SummaryRepository
    from app.services import job_manager, summary_service

    snap = db.get(CommitSnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Commit snapshot not found")

    style = body.summary_style or "detailed"
    if style not in ("short", "detailed", "manager", "custom"):
        raise HTTPException(422, f"Invalid summary_style '{style}'. Choose: short, detailed, custom")
    if style == "custom" and not (body.custom_prompt or "").strip():
        raise HTTPException(422, "custom_prompt is required when summary_style is 'custom'")

    def _parse_dt(value) -> datetime:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return datetime.now()

    try:
        raw_commits = json.loads(snap.raw_json)
    except (json.JSONDecodeError, TypeError):
        raw_commits = []

    commit_records = [
        CommitRecord(
            repository_id=snap.repository_id,
            commit_hash=c.get("commit_hash", ""),
            author_name=c.get("author_name", ""),
            author_email=c.get("author_email", ""),
            committed_at=_parse_dt(c.get("committed_at")),
            subject=c.get("subject", ""),
            body=c.get("body", "") or "",
        )
        for c in raw_commits
        if isinstance(c, dict)
    ]

    summary_repo = SummaryRepository(db)
    job = summary_repo.create_job(
        repository_id=snap.repository_id,
        model_name=body.model_name or settings.default_model,
        summary_style=style,
        branch=snap.branch,
        base_branch=snap.base_branch,
        start_date=_parse_dt(snap.since) if snap.since else None,
        end_date=_parse_dt(snap.until) if snap.until else None,
        custom_prompt=body.custom_prompt if style == "custom" else None,
    )

    repo_name = snap.repo_name
    job_id = job.id

    async def work(db):
        j = SummaryRepository(db).get_job(job_id)
        await summary_service.create_and_run_snapshot_summary(j, commit_records, repo_name, db)

    def set_terminal(db, status, error):
        j = SummaryRepository(db).get_job(job_id)
        if j:
            SummaryRepository(db).set_status(j, status, error)

    await job_manager.launch(job_id, work, set_terminal)
    db.refresh(job)
    return job


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
    request: Request,
    tz: str | None = None,
    model: str | None = Query(None),
    filters: list[str] = Query(default=[], alias="filter"),
    db: Session = Depends(get_db),
):
    snap = db.get(CommitSnapshot, snapshot_id)
    if not snap:
        raise HTTPException(404, "Commit snapshot not found")

    c = comment_service.get_request_comment_or_404(db, comment_id, summary_type="git-snapshot", summary_id=snapshot_id)

    commits = json.loads(snap.raw_json)
    if filters:
        commits = [
            cm for cm in commits
            if comment_service.matches_terms(_commit_filter_haystack(cm), filters)
        ]
    lines = [f"Repository: {snap.repo_name}"]
    if snap.since or snap.until:
        lines.append(f"Date range: {snap.since or '?'} → {snap.until or '?'}")
    if snap.branch:
        base = f" vs {snap.base_branch}" if snap.base_branch else ""
        lines.append(f"Branch: {snap.branch}{base}")
    lines.append(
        f"Commits shown: {len(commits)} of {snap.commit_count}\n" if filters
        else f"Total commits: {snap.commit_count}\n"
    )
    for entry in commits[:200]:
        date = str(entry.get("committed_at", ""))[:10]
        lines.append(f"- [{date}] {entry.get('author_name', '')} — {entry.get('subject', '')}")

    return await comment_service.stream_reply(
        db,
        request=request,
        summary_type="git-snapshot",
        parent_id=snapshot_id,
        comment=c,
        context_markdown="\n".join(lines),
        model=model or settings.default_model,
        tz=tz,
    )
