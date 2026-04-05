import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.repositories.repo_repository import RepoRepository
from app.repositories.summary_repository import SummaryRepository
from app.schemas import (
    OllamaModel,
    OllamaModelPullRequest,
    SummaryJobCreate,
    SummaryJobWithResult,
)
from app.services import ollama_service, summary_service
from app.services.git_service import GitCommandError, GitService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/summaries", tags=["summaries"])

# ── Models ──

@router.get("/models/available", response_model=list[OllamaModel])
async def list_available_models():
    try:
        models = await ollama_service.list_models()
    except Exception as exc:
        logger.warning("Could not reach Ollama: %s", exc)
        raise HTTPException(
            status_code=502, detail="Cannot connect to Ollama. Is it running?"
        )
    return [
        OllamaModel(
            name=m.get("name", ""),
            size=m.get("size"),
            modified_at=m.get("modified_at"),
        )
        for m in models
    ]

@router.get("/models/running")
async def list_running_models():
    """List currently loaded/running models."""
    try:
        async with httpx.AsyncClient(base_url=settings.ollama_base_url, timeout=10) as c:
            resp = await c.get("/api/ps")
            resp.raise_for_status()
            models = resp.json().get("models", [])
            return [
                {
                    "name": m.get("name", ""),
                    "size": m.get("size"),
                    "size_vram": m.get("size_vram"),
                    "expires_at": m.get("expires_at"),
                }
                for m in models
            ]
    except Exception:
        return []

@router.post("/models/load")
async def load_model(body: OllamaModelPullRequest):
    """Load a model into memory (warm it up)."""
    try:
        async with httpx.AsyncClient(base_url=settings.ollama_base_url, timeout=120) as c:
            resp = await c.post("/api/generate", json={
                "model": body.name,
                "prompt": "",
                "keep_alive": "10m",
            })
            resp.raise_for_status()
            return {"status": "ok", "model": body.name}
    except Exception as exc:
        logger.error("Failed to load model %s: %s", body.name, exc)
        raise HTTPException(502, "Failed to load model. Is Ollama running?")

@router.post("/models/unload")
async def unload_model(body: OllamaModelPullRequest):
    """Unload a model from memory by setting keep_alive to 0."""
    try:
        async with httpx.AsyncClient(base_url=settings.ollama_base_url, timeout=30) as c:
            # Use keep_alive=0 (integer) to immediately unload
            resp = await c.post("/api/generate", json={
                "model": body.name,
                "prompt": "",
                "stream": False,
                "keep_alive": 0,
            })
            resp.raise_for_status()
            return {"status": "ok", "model": body.name}
    except Exception as exc:
        logger.error("Failed to unload model %s: %s", body.name, exc)
        raise HTTPException(502, "Failed to unload model.")

@router.delete("/models/{model_name:path}")
async def delete_model(model_name: str):
    """Delete a model from Ollama."""
    import re as _re
    if not _re.match(r"^[a-zA-Z0-9._:/-]+$", model_name) or len(model_name) > 200:
        raise HTTPException(422, "Invalid model name")
    try:
        async with httpx.AsyncClient(base_url=settings.ollama_base_url, timeout=30) as c:
            resp = await c.request("DELETE", "/api/delete", json={"name": model_name})
            resp.raise_for_status()
            return {"status": "ok", "model": model_name}
    except httpx.HTTPStatusError as exc:
        raise HTTPException(exc.response.status_code, f"Ollama error: {exc.response.status_code}")
    except Exception:
        raise HTTPException(502, "Failed to delete model. Is Ollama running?")

@router.post("/models/pull")
async def pull_model(body: OllamaModelPullRequest):
    """Pull (download) a model from the Ollama library."""
    model_name = body.name
    try:
        async with httpx.AsyncClient(
            base_url=settings.ollama_base_url, timeout=600
        ) as c:
            resp = await c.post("/api/pull", json={"name": model_name, "stream": False})
            resp.raise_for_status()
            return {"status": "ok", "model": model_name}
    except httpx.HTTPStatusError as exc:
        logger.error("Failed to pull model %s: %s", model_name, exc)
        raise HTTPException(502, f"Ollama rejected the pull request (HTTP {exc.response.status_code})")
    except Exception as exc:
        logger.error("Failed to pull model %s: %s", model_name, exc)
        raise HTTPException(502, "Failed to pull model. Is Ollama running?")

# ── Summaries CRUD ──

@router.post("", response_model=SummaryJobWithResult, status_code=201)
async def create_summary(body: SummaryJobCreate, db: Session = Depends(get_db)):
    repo = RepoRepository(db).get_by_id(body.repository_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    style = body.summary_style or "detailed"
    if style not in ("short", "detailed", "manager"):
        raise HTTPException(
            status_code=422,
            detail=f"Invalid summary_style '{style}'. Choose: short, detailed, manager",
        )

    is_branch_mode = bool(body.branch)

    # Validate: need either dates or branch
    if not is_branch_mode and (not body.start_date or not body.end_date):
        raise HTTPException(
            status_code=422,
            detail="Either provide start_date+end_date, or branch for branch-diff mode.",
        )

    summary_repo = SummaryRepository(db)

    if is_branch_mode:
        # Branch-diff mode: load commits from git, then summarize
        try:
            git = GitService(db)
            branch_commits = await git.load_branch_diff_commits(
                body.repository_id,
                branch=body.branch,
                base_branch=body.base_branch,
            )
        except (GitCommandError, ValueError) as exc:
            raise HTTPException(status_code=500, detail=str(exc))

        job = summary_repo.create_job(
            repository_id=body.repository_id,
            model_name=body.model_name or settings.default_model,
            summary_style=style,
            branch=body.branch,
            base_branch=body.base_branch or repo.default_branch,
        )

        try:
            await summary_service.create_and_run_branch_summary(
                job, branch_commits, db
            )
        except Exception as exc:
            logger.error("Branch summary generation failed: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc))
    else:
        # Date-range mode: auto-load commits from git first, then summarize
        try:
            git = GitService(db)
            await git.load_commits(
                body.repository_id,
                start_date=body.start_date,
                end_date=body.end_date,
            )
        except (GitCommandError, ValueError) as exc:
            logger.warning("Auto-load commits failed (continuing with DB): %s", exc)

        job = summary_repo.create_job(
            repository_id=body.repository_id,
            model_name=body.model_name or settings.default_model,
            summary_style=style,
            start_date=datetime.fromisoformat(body.start_date),
            end_date=datetime.fromisoformat(body.end_date),
        )

        try:
            await summary_service.create_and_run_summary(job, db)
        except Exception as exc:
            logger.error("Summary generation failed: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc))

    db.refresh(job)
    return job

@router.get("", response_model=list[SummaryJobWithResult])
def list_summaries(
    repository_id: str | None = Query(None),
    db: Session = Depends(get_db),
):
    return SummaryRepository(db).list_jobs(repository_id)

@router.get("/{job_id}", response_model=SummaryJobWithResult)
def get_summary(job_id: str, db: Session = Depends(get_db)):
    job = SummaryRepository(db).get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Summary job not found")
    return job
