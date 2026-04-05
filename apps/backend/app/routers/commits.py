import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.repositories.repo_repository import RepoRepository
from app.schemas import BranchDiffRequest, BranchInfo, CommitRead, ParseCommitsRequest
from app.services.git_service import GitCommandError, GitService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/repositories/{repo_id}", tags=["commits"])

@router.get("/branches", response_model=list[BranchInfo])
async def list_branches(repo_id: str, db: Session = Depends(get_db)):
    if not RepoRepository(db).get_by_id(repo_id):
        raise HTTPException(status_code=404, detail="Repository not found")
    try:
        branches = await GitService(db).list_branches(repo_id)
    except (GitCommandError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return branches

@router.get("/commits", response_model=list[CommitRead])
def list_commits(
    repo_id: str,
    since: str | None = Query(None, description="ISO date, e.g. 2025-01-01"),
    until: str | None = Query(None, description="ISO date (default: today)"),
    limit: int = Query(200, le=5000),
    db: Session = Depends(get_db),
):
    if not RepoRepository(db).get_by_id(repo_id):
        raise HTTPException(status_code=404, detail="Repository not found")

    return GitService(db).get_commit_history(
        repo_id, start_date=since, end_date=until, limit=limit
    )

@router.post("/commits/parse", response_model=list[CommitRead])
async def parse_commits(
    repo_id: str,
    body: ParseCommitsRequest,
    db: Session = Depends(get_db),
):
    if not RepoRepository(db).get_by_id(repo_id):
        raise HTTPException(status_code=404, detail="Repository not found")
    try:
        records = await GitService(db).load_commits(
            repo_id, start_date=body.since, end_date=body.until
        )
    except (GitCommandError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return records

@router.post("/commits/branch-diff", response_model=list[CommitRead])
async def branch_diff_commits(
    repo_id: str,
    body: BranchDiffRequest,
    db: Session = Depends(get_db),
):
    """Parse commits that are in *branch* but not in *base_branch*."""
    if not RepoRepository(db).get_by_id(repo_id):
        raise HTTPException(status_code=404, detail="Repository not found")
    try:
        records = await GitService(db).load_branch_diff_commits(
            repo_id, branch=body.branch, base_branch=body.base_branch
        )
    except (GitCommandError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return records
