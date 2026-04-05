from fastapi import APIRouter

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
