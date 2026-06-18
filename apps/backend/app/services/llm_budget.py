"""Model-aware token budgeting, shared by every AI-summary path.

Large inputs (many commits, many activity events) must be chunked to fit the
configured model's context window and then map-reduced. Both the git commit
summariser and the YouTrack activity summariser size their work here so the
behaviour is identical everywhere: query the model's real context length, then
reserve headroom for the prompt scaffold and the generated output.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

CHARS_PER_TOKEN = 4
DEFAULT_CONTEXT_TOKENS = 4_096
RESERVED_TOKENS = 1_800
MIN_BUDGET_TOKENS = 1_024
MAX_BUDGET_TOKENS = 24_000


def estimate_tokens(text: str) -> int:
    """Rough token estimate from character count."""
    return max(1, len(text) // CHARS_PER_TOKEN)


def input_token_budget(
    context_tokens: int,
    *,
    reserved: int = RESERVED_TOKENS,
    floor: int = MIN_BUDGET_TOKENS,
    cap: int = MAX_BUDGET_TOKENS,
) -> int:
    """Tokens available for chunk *input*, after reserving room for output + scaffold."""
    usable = context_tokens - reserved
    return max(floor, min(cap, usable))


async def resolve_context_size(model: str | None, *, default: int = DEFAULT_CONTEXT_TOKENS) -> int:
    """Query the model's context window, falling back to a safe default on error."""
    from app.services import ollama_service

    try:
        ctx = await ollama_service.get_context_size(model)
        if ctx and ctx > 0:
            return ctx
    except Exception as e:
        logger.warning("Context size lookup failed for %s (%s); using default %d", model, e, default)
    return default


async def resolve_token_budget(
    model: str | None,
    *,
    reserved: int = RESERVED_TOKENS,
    floor: int = MIN_BUDGET_TOKENS,
    cap: int = MAX_BUDGET_TOKENS,
    default_context: int = DEFAULT_CONTEXT_TOKENS,
) -> int:
    """One-shot: resolve the model's context window and return a usable input-token budget."""
    ctx = await resolve_context_size(model, default=default_context)
    return input_token_budget(ctx, reserved=reserved, floor=floor, cap=cap)
