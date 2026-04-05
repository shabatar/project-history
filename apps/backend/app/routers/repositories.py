import asyncio
import logging
import platform
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Repository
from app.repositories.repo_repository import RepoRepository
from app.schemas import BulkActionResult, RepositoryCreate, RepositoryCreateFromLocal, RepositoryRead, RepositoryUpdate
from app.services.git_service import GitCommandError, GitService, add_local_repository, add_repository

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/repositories", tags=["repositories"])

def _to_read(repo: Repository, repo_repo: RepoRepository) -> RepositoryRead:
    return RepositoryRead(
        id=repo.id,
        name=repo.name,
        remote_url=repo.remote_url,
        default_branch=repo.default_branch,
        last_synced_at=repo.last_synced_at,
        is_active=repo.is_active,
        commit_count=repo_repo.commit_count(repo.id),
    )

def _get_or_404(repo_repo: RepoRepository, repo_id: str) -> Repository:
    repo = repo_repo.get_by_id(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")
    return repo

# ── CRUD ──

@router.get("", response_model=list[RepositoryRead])
def list_repositories(db: Session = Depends(get_db)):
    repo_repo = RepoRepository(db)
    repos = repo_repo.list_active()
    return [_to_read(r, repo_repo) for r in repos]

@router.post("", response_model=RepositoryRead, status_code=201)
def create_repository(body: RepositoryCreate, db: Session = Depends(get_db)):
    repo_repo = RepoRepository(db)
    if repo_repo.get_by_url(body.remote_url):
        raise HTTPException(status_code=409, detail="Repository already exists")
    repo = add_repository(body.remote_url, db)
    return _to_read(repo, repo_repo)

@router.post("/local", response_model=RepositoryRead, status_code=201)
async def create_from_local(body: RepositoryCreateFromLocal, db: Session = Depends(get_db)):
    """Add an existing local git repository by filesystem path."""
    try:
        repo = await add_local_repository(body.local_path, db)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except GitCommandError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return _to_read(repo, RepoRepository(db))

@router.get("/{repo_id}", response_model=RepositoryRead)
def get_repository(repo_id: str, db: Session = Depends(get_db)):
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)
    return _to_read(repo, repo_repo)

@router.patch("/{repo_id}", response_model=RepositoryRead)
def update_repository(
    repo_id: str, body: RepositoryUpdate, db: Session = Depends(get_db)
):
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)
    repo_repo.update(repo, is_active=body.is_active, default_branch=body.default_branch)
    return _to_read(repo, repo_repo)

@router.delete("/{repo_id}", status_code=204)
def delete_repository(repo_id: str, db: Session = Depends(get_db)):
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)
    repo_repo.delete(repo)

# ── Open in file manager ──

@router.post("/{repo_id}/open")
async def open_in_file_manager(repo_id: str, db: Session = Depends(get_db)):
    """Open the repository's local path in the system file manager."""
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)

    path = Path(repo.local_path).resolve()
    if not path.is_dir():
        raise HTTPException(status_code=422, detail="Local path does not exist")

    # Sandbox: only allow opening paths within known directories
    from app.config import settings
    allowed_roots = [Path(settings.repos_dir).resolve(), Path.home()]
    if not any(path == root or root in path.parents for root in allowed_roots):
        raise HTTPException(status_code=403, detail="Path is outside allowed directories")

    system = platform.system()
    if system == "Darwin":
        cmd = ["open", str(path)]
    elif system == "Windows":
        cmd = ["explorer", str(path)]
    else:
        cmd = ["xdg-open", str(path)]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() if stderr else "Failed to open"
        raise HTTPException(status_code=500, detail=detail)

    return {"opened": str(path)}

# ── Single-repo git actions ──

@router.post("/{repo_id}/clone", response_model=RepositoryRead)
async def clone_repo(repo_id: str, db: Session = Depends(get_db)):
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)
    try:
        repo = await GitService(db).clone_repo(repo)
    except GitCommandError as exc:
        repo_repo.set_sync_error(repo, str(exc))
        raise HTTPException(status_code=500, detail=str(exc))
    return _to_read(repo, repo_repo)

@router.post("/{repo_id}/pull", response_model=RepositoryRead)
async def pull_repo(repo_id: str, db: Session = Depends(get_db)):
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)
    try:
        repo = await GitService(db).update_repo(repo)
    except GitCommandError as exc:
        repo_repo.set_sync_error(repo, str(exc))
        raise HTTPException(status_code=500, detail=str(exc))
    return _to_read(repo, repo_repo)

@router.post("/{repo_id}/refresh-commits", response_model=RepositoryRead)
async def refresh_commits(repo_id: str, db: Session = Depends(get_db)):
    """Re-parse all commits from git log for this repository."""
    repo_repo = RepoRepository(db)
    repo = _get_or_404(repo_repo, repo_id)
    try:
        git = GitService(db)
        await git.load_commits(repo_id)
    except (GitCommandError, ValueError) as exc:
        repo_repo.set_sync_error(repo, str(exc))
        raise HTTPException(status_code=500, detail=str(exc))
    return _to_read(repo, repo_repo)

# ── Bulk actions ──

@router.post("/bulk/clone", response_model=BulkActionResult)
async def bulk_clone(db: Session = Depends(get_db)):
    """Clone all repositories that haven't been cloned yet."""
    repo_repo = RepoRepository(db)
    git = GitService(db)
    not_cloned = repo_repo.list_not_cloned()

    results: list[RepositoryRead] = []
    succeeded = 0
    failed = 0

    for repo in not_cloned:
        try:
            repo = await git.clone_repo(repo)
            succeeded += 1
        except GitCommandError as exc:
            logger.warning("Bulk clone failed for %s: %s", repo.name, exc)
            repo_repo.set_sync_error(repo, str(exc))
            failed += 1
        results.append(_to_read(repo, repo_repo))

    return BulkActionResult(
        total=len(not_cloned),
        succeeded=succeeded,
        failed=failed,
        results=results,
    )

@router.post("/bulk/pull", response_model=BulkActionResult)
async def bulk_pull(db: Session = Depends(get_db)):
    """Pull latest changes for all cloned repositories."""
    repo_repo = RepoRepository(db)
    git = GitService(db)
    cloned = repo_repo.list_cloned()

    results: list[RepositoryRead] = []
    succeeded = 0
    failed = 0

    for repo in cloned:
        try:
            repo = await git.update_repo(repo)
            succeeded += 1
        except GitCommandError as exc:
            logger.warning("Bulk pull failed for %s: %s", repo.name, exc)
            repo_repo.set_sync_error(repo, str(exc))
            failed += 1
        results.append(_to_read(repo, repo_repo))

    return BulkActionResult(
        total=len(cloned),
        succeeded=succeeded,
        failed=failed,
        results=results,
    )
