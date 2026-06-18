import asyncio
import logging
import time
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.repositories.repo_repository import RepoRepository
from app.repositories.summary_repository import SummaryRepository
from app.schemas import (
    ItemLabelUpdate,
    OllamaModel,
    OllamaModelPullRequest,
    SummaryCommentCreate,
    SummaryCommentRead,
    SummaryJobCreate,
    SummaryJobWithResult,
)
from app.services import job_manager, ollama_service, summary_service
from app.services import comment_service
from app.services.git_service import GitCommandError, GitService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/summaries", tags=["summaries"])


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
    logger.info("Downloading model '%s' from Ollama…", model_name)
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(
            base_url=settings.ollama_base_url, timeout=1800
        ) as c:
            resp = await c.post("/api/pull", json={"name": model_name, "stream": False})
            resp.raise_for_status()
            logger.info(
                "Model '%s' downloaded successfully (%.1fs)", model_name, time.monotonic() - started,
            )
            return {"status": "ok", "model": model_name}
    except httpx.HTTPStatusError as exc:
        logger.error("Failed to pull model %s: %s", model_name, exc)
        raise HTTPException(502, f"Ollama rejected the pull request (HTTP {exc.response.status_code})")
    except Exception as exc:
        logger.error("Failed to pull model %s: %s", model_name, exc)
        raise HTTPException(502, "Failed to pull model. Is Ollama running?")


@router.post("", response_model=SummaryJobWithResult, status_code=201)
async def create_summary(body: SummaryJobCreate, db: Session = Depends(get_db)):
    repo = RepoRepository(db).get_by_id(body.repository_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    style = body.summary_style or "detailed"
    if style not in ("short", "detailed", "manager", "custom"):
        raise HTTPException(
            status_code=422,
            detail=f"Invalid summary_style '{style}'. Choose: short, detailed, custom",
        )
    if style == "custom" and not (body.custom_prompt or "").strip():
        raise HTTPException(
            status_code=422,
            detail="custom_prompt is required when summary_style is 'custom'",
        )

    is_branch_mode = bool(body.branch)

    if not is_branch_mode and (not body.start_date or not body.end_date):
        raise HTTPException(
            status_code=422,
            detail="Either provide start_date+end_date, or branch for branch-diff mode.",
        )

    summary_repo = SummaryRepository(db)

    if is_branch_mode:
        job = summary_repo.create_job(
            repository_id=body.repository_id,
            model_name=body.model_name or settings.default_model,
            summary_style=style,
            branch=body.branch,
            base_branch=body.base_branch or repo.default_branch,
            custom_prompt=body.custom_prompt if style == "custom" else None,
        )

        async def work(db):
            j = SummaryRepository(db).get_job(job_id)
            branch_commits = await GitService(db).load_branch_diff_commits(
                j.repository_id, branch=j.branch, base_branch=j.base_branch,
            )
            await summary_service.create_and_run_branch_summary(j, branch_commits, db)
    else:
        start, end = body.start_date, body.end_date
        job = summary_repo.create_job(
            repository_id=body.repository_id,
            model_name=body.model_name or settings.default_model,
            summary_style=style,
            start_date=datetime.fromisoformat(start),
            end_date=datetime.fromisoformat(end),
            custom_prompt=body.custom_prompt if style == "custom" else None,
        )

        async def work(db):
            j = SummaryRepository(db).get_job(job_id)
            try:
                await GitService(db).load_commits(j.repository_id, start_date=start, end_date=end)
            except (GitCommandError, ValueError) as exc:
                logger.warning("Auto-load commits failed (continuing with DB): %s", exc)
            await summary_service.create_and_run_summary(j, db)

    job_id = job.id

    def set_terminal(db, status, error):
        j = SummaryRepository(db).get_job(job_id)
        if j:
            SummaryRepository(db).set_status(j, status, error)

    await job_manager.launch(job_id, work, set_terminal)
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


@router.post("/{job_id}/cancel", response_model=SummaryJobWithResult)
def cancel_summary(job_id: str, db: Session = Depends(get_db)):
    repo = SummaryRepository(db)
    job = repo.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Summary job not found")
    if job.status in ("pending", "running"):
        if not job_manager.cancel(job_id):
            repo.set_status(job, "cancelled", error="Cancelled by user.")
            db.refresh(job)
    return job


@router.delete("/{job_id}", status_code=204)
def delete_summary(job_id: str, db: Session = Depends(get_db)):
    repo = SummaryRepository(db)
    job = repo.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Summary job not found")
    job_manager.cancel(job_id)
    repo.delete_job(job)



@router.patch("/{job_id}/label", response_model=SummaryJobWithResult)
def update_summary_label(job_id: str, body: ItemLabelUpdate, db: Session = Depends(get_db)):
    job = SummaryRepository(db).get_job(job_id)
    if not job:
        raise HTTPException(404, "Summary job not found")
    label = body.user_label.strip() if body.user_label else None
    job.user_label = label or None
    db.commit()
    db.refresh(job)
    return job



@router.get("/{job_id}/comments", response_model=list[SummaryCommentRead])
def list_git_comments(job_id: str, db: Session = Depends(get_db)):
    if not SummaryRepository(db).get_job(job_id):
        raise HTTPException(404, "Summary job not found")
    return comment_service.list_comments(db, "git", job_id)


@router.post("/{job_id}/comments", response_model=SummaryCommentRead, status_code=201)
def create_git_comment(
    job_id: str,
    body: SummaryCommentCreate,
    db: Session = Depends(get_db),
):
    if not SummaryRepository(db).get_job(job_id):
        raise HTTPException(404, "Summary job not found")
    return comment_service.create_comment(
        db,
        summary_type="git",
        summary_id=job_id,
        comment_type=body.comment_type,
        user_content=body.user_content,
    )


@router.delete("/{job_id}/comments/{comment_id}", status_code=204)
def delete_git_comment(job_id: str, comment_id: str, db: Session = Depends(get_db)):
    c = comment_service.get_comment(db, comment_id)
    if not c or c.summary_type != "git" or c.summary_id != job_id:
        raise HTTPException(404, "Comment not found")
    comment_service.delete_comment(db, comment_id)


@router.post("/{job_id}/comments/{comment_id}/generate")
async def generate_git_comment_reply(
    job_id: str,
    comment_id: str,
    request: Request,
    tz: str | None = None,
    model: str | None = Query(None),
    db: Session = Depends(get_db),
):
    job = SummaryRepository(db).get_job(job_id)
    if not job or not job.result:
        raise HTTPException(404, "Summary not found or has no result yet")

    c = comment_service.get_request_comment_or_404(db, comment_id, summary_type="git", summary_id=job_id)

    return await comment_service.stream_reply(
        db,
        request=request,
        summary_type="git",
        parent_id=job_id,
        comment=c,
        context_markdown=job.result.summary_markdown,
        model=model or settings.default_model,
        tz=tz,
    )
