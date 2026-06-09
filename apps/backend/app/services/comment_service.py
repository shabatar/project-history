from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models import SummaryComment
from app.services import ollama_service

logger = logging.getLogger(__name__)

MAX_SUMMARY_CHARS = 4000
MAX_QA_CHARS = 4000
MAX_PRIOR_PAIRS = 5


def list_comments(
    db: Session,
    summary_type: str,
    summary_id: str,
) -> list[SummaryComment]:
    return (
        db.query(SummaryComment)
        .filter(
            SummaryComment.summary_type == summary_type,
            SummaryComment.summary_id == summary_id,
        )
        .order_by(SummaryComment.created_at)
        .all()
    )


def create_comment(
    db: Session,
    *,
    summary_type: str,
    summary_id: str,
    comment_type: str,
    user_content: str,
) -> SummaryComment:
    comment = SummaryComment(
        summary_type=summary_type,
        summary_id=summary_id,
        comment_type=comment_type,
        user_content=user_content,
        ai_status="none" if comment_type == "note" else "pending",
        created_at=datetime.now(UTC),
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


def get_comment(db: Session, comment_id: str) -> SummaryComment | None:
    return db.get(SummaryComment, comment_id)


def delete_comment(db: Session, comment_id: str) -> bool:
    comment = db.get(SummaryComment, comment_id)
    if not comment:
        return False
    db.delete(comment)
    db.commit()
    return True


def update_comment_response(
    db: Session,
    comment_id: str,
    *,
    ai_response: str,
    ai_status: str,
    ai_error: str | None = None,
    model_name: str | None = None,
) -> SummaryComment | None:
    comment = db.get(SummaryComment, comment_id)
    if not comment:
        return None
    comment.ai_response = ai_response
    comment.ai_status = ai_status
    comment.ai_error = ai_error
    if model_name:
        comment.model_name = model_name
    db.commit()
    db.refresh(comment)
    return comment


def build_prior_qa(
    db: Session,
    summary_type: str,
    summary_id: str,
    exclude_comment_id: str,
) -> list[tuple[str, str]]:
    done_requests = (
        db.query(SummaryComment)
        .filter(
            SummaryComment.summary_type == summary_type,
            SummaryComment.summary_id == summary_id,
            SummaryComment.comment_type == "request",
            SummaryComment.ai_status == "done",
            SummaryComment.id != exclude_comment_id,
        )
        .order_by(SummaryComment.created_at)
        .all()
    )

    pairs: list[tuple[str, str]] = [
        (c.user_content, c.ai_response or "")
        for c in done_requests
        if c.ai_response
    ]

    pairs = pairs[-MAX_PRIOR_PAIRS:]
    total = 0
    kept: list[tuple[str, str]] = []
    for q, a in reversed(pairs):
        chunk = len(q) + len(a)
        if total + chunk > MAX_QA_CHARS:
            break
        kept.insert(0, (q, a))
        total += chunk
    return kept


async def stream_reply(
    db: Session,
    *,
    summary_type: str,
    parent_id: str,
    comment: SummaryComment,
    context_markdown: str,
    model: str,
) -> StreamingResponse:
    comment_id = comment.id

    async def _stream():
        yield json.dumps({"type": "status", "phase": "generating", "model": model}) + "\n"
        prior_qa = build_prior_qa(db, summary_type, parent_id, comment_id)
        try:
            reply = await generate_followup(
                summary_markdown=context_markdown,
                prior_qa=prior_qa,
                question=comment.user_content,
                model=model,
            )
            update_comment_response(
                db, comment_id, ai_response=reply, ai_status="done", model_name=model,
            )
            yield json.dumps({"type": "done", "reply": reply, "comment_id": comment_id}) + "\n"
        except Exception as exc:
            err = str(exc)
            update_comment_response(
                db, comment_id, ai_response="", ai_status="error", ai_error=err,
            )
            yield json.dumps({"type": "error", "detail": err}) + "\n"

    return StreamingResponse(
        _stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
    )


async def generate_followup(
    *,
    summary_markdown: str,
    prior_qa: list[tuple[str, str]],
    question: str,
    model: str,
) -> str:
    summary_excerpt = summary_markdown[:MAX_SUMMARY_CHARS]
    if len(summary_markdown) > MAX_SUMMARY_CHARS:
        summary_excerpt += "\n\n*[summary truncated for context]*"

    prompt = (
        "You are a helpful assistant analyzing project progress. "
        "Answer the question using ONLY the summary and conversation history below. "
        "Be specific, reference issue IDs and facts from the summary where relevant.\n\n"
        f"## Original Summary\n\n{summary_excerpt}\n"
    )

    if prior_qa:
        qa_block = "\n\n---\n\n".join(
            f"**Q:** {q}\n\n**A:** {a}" for q, a in prior_qa
        )
        prompt += f"\n## Previous Questions & Answers\n\n{qa_block}\n"

    prompt += f"\n## New Question\n\n{question}\n\nAnswer:"

    result = await ollama_service.generate(prompt=prompt, model=model)
    if not result.strip():
        raise RuntimeError("LLM returned an empty response")
    return result
