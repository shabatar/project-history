import asyncio
import json
import platform
from collections import deque

from fastapi import APIRouter, HTTPException, Query

from app.config import settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check():
    return {"status": "ok"}


@router.get("/features")
async def features():
    import os
    return {
        "youtrack": settings.youtrack_enabled,
        "open_folder": not os.path.exists("/.dockerenv"),
    }


@router.get("/logs")
async def get_logs(limit: int = Query(50, ge=1, le=500)):
    logs_dir = settings.data_dir / "logs"
    log_file = logs_dir / "app.log"

    entries: list[dict] = []
    if log_file.exists():
        try:
            with open(log_file, encoding="utf-8", errors="replace") as fh:
                tail = deque(fh, maxlen=limit)
            for raw in tail:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    entries.append(json.loads(raw))
                except json.JSONDecodeError:
                    entries.append({"ts": "", "level": "RAW", "name": "", "msg": raw})
        except OSError:
            pass

    entries.reverse()
    return {"entries": entries}


@router.post("/logs/open-folder")
async def open_logs_folder():
    import os
    if os.path.exists("/.dockerenv"):
        raise HTTPException(422, "Open folder is not available inside Docker")

    logs_dir = settings.data_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    system = platform.system()
    if system == "Darwin":
        cmd = ["open", str(logs_dir)]
    elif system == "Windows":
        cmd = ["explorer", str(logs_dir)]
    else:
        cmd = ["xdg-open", str(logs_dir)]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() if stderr else "Failed to open folder"
        raise HTTPException(500, detail=detail)

    return {"opened": str(logs_dir)}
