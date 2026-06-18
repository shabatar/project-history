"""Run summary generation as in-process background tasks.

Generation can take minutes, so we don't want to hold the HTTP request open for
its whole duration — the client would have to stay connected, and a page refresh
would lose track of it. Instead the request creates the record (status
``running``) and schedules the work here; the work continues independently and
the client polls the record's status. A registry of live tasks lets an explicit
"cancel" endpoint stop a running job.

The manager is model-agnostic: callers pass a ``work`` coroutine that owns its
own DB session and drives the record to ``completed``, plus a ``set_terminal``
callback the manager uses to flag ``failed``/``cancelled`` if the work raises or
is cancelled. Each background task uses a fresh session because the request
session is closed as soon as the request returns.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from app import database
from app.models import ActivitySummary, SummaryJob
from app.repositories.summary_repository import SummaryRepository

logger = logging.getLogger(__name__)

_tasks: dict[str, asyncio.Task] = {}

run_inline = False

WorkFn = Callable[[object], Awaitable[object]]
TerminalFn = Callable[[object, str, str | None], None]


async def launch(key: str, work: WorkFn, set_terminal: TerminalFn) -> None:
    """Schedule ``work`` and track the task.

    Returns as soon as the task is scheduled (production), so the HTTP request
    isn't held open for the whole generation. In inline mode the work runs to
    completion before returning.
    """
    if run_inline:
        await _run(key, work, set_terminal)
        return
    task = asyncio.ensure_future(_run(key, work, set_terminal))
    _tasks[key] = task
    task.add_done_callback(lambda _t, k=key: _tasks.pop(k, None))


async def _run(key: str, work: WorkFn, set_terminal: TerminalFn) -> None:
    db = database.SessionLocal()
    try:
        try:
            await work(db)
        except asyncio.CancelledError:
            logger.info("Job %s cancelled by user", key)
            set_terminal(db, "cancelled", "Cancelled by user.")
            raise
        except Exception as exc:
            logger.error("Job %s failed: %s", key, exc)
            set_terminal(db, "failed", str(exc) or exc.__class__.__name__)
    finally:
        db.close()


def cancel(key: str) -> bool:
    """Cancel a running job. Returns True if a live task was found and cancelled."""
    task = _tasks.get(key)
    if task and not task.done():
        task.cancel()
        return True
    return False


def reconcile_orphans() -> int:
    """On startup, fail any records stranded ``running`` by a previous crash/restart.

    Generation runs in-process, so a ``pending``/``running`` record after a
    restart will never finish — flag it so the UI shows its real state.
    """
    db = database.SessionLocal()
    total = 0
    try:
        total += SummaryRepository(db).reconcile_orphans()

        stranded = (
            db.query(ActivitySummary)
            .filter(ActivitySummary.status.in_(("pending", "running")))
            .all()
        )
        for row in stranded:
            row.status = "failed"
            row.error = "Generation was interrupted (server restarted)."
        if stranded:
            db.commit()
            total += len(stranded)

        if total:
            logger.info("Reconciled %d orphaned summary record(s) -> failed", total)
        return total
    finally:
        db.close()
