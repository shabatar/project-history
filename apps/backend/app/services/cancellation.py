"""Bind long-running work to the HTTP client's connection.

FastAPI/Starlette does not cancel an in-flight request handler the moment a
client disconnects — a long ``await`` (e.g. an Ollama generation) runs to
completion regardless, so a UI "Cancel" that just aborts the fetch doesn't stop
the work or its side effects. These helpers poll ``request.is_disconnected()``
and cancel the work task, which propagates into the httpx call and stops Ollama.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, TypeVar

from fastapi import Request

T = TypeVar("T")

_POLL_INTERVAL_S = 0.4


async def run_cancellable(request: Request, coro: Awaitable[T]) -> T:
    """Await ``coro``, cancelling it if the client disconnects.

    Returns the coroutine's result, or raises ``asyncio.CancelledError`` if the
    client went away (so callers can skip persisting a half/finished result).
    """
    task: asyncio.Task = asyncio.ensure_future(coro)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=_POLL_INTERVAL_S)
            if task in done:
                return task.result()
            if await request.is_disconnected():
                raise asyncio.CancelledError()
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
