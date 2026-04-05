import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import JSONResponse

from app.database import init_db
from app.logging_config import setup_logging
from app.config import settings
from app.routers import commits, health, repositories, summaries

@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    init_db()
    yield

app = FastAPI(
    title="Project History API",
    version="0.1.0",
    lifespan=lifespan,
)

_ALLOWED_ORIGINS = {
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8000", "http://127.0.0.1:8000",
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_ALLOWED_ORIGINS),
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
    allow_credentials=False,
)

_rate_limit_store: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT = 60
_RATE_WINDOW = 60
_MAX_BODY_SIZE = 1_048_576

@app.middleware("http")
async def security_middleware(request: Request, call_next):
    path = request.url.path
    is_static = path.startswith("/assets") or path == "/favicon.svg"

    # CSRF: reject unknown origins on state-changing requests
    if request.method in ("POST", "PATCH", "DELETE"):
        origin = request.headers.get("Origin", "")
        if origin and origin not in _ALLOWED_ORIGINS:
            return JSONResponse({"detail": "Forbidden origin"}, status_code=403)

    # Rate limiting (skip static)
    if not is_static:
        ip = request.client.host if request.client else "unknown"
        now = time.time()
        _rate_limit_store[ip] = [t for t in _rate_limit_store[ip] if t > now - _RATE_WINDOW]
        if len(_rate_limit_store[ip]) >= _RATE_LIMIT:
            return JSONResponse({"detail": "Rate limit exceeded"}, status_code=429)
        _rate_limit_store[ip].append(now)

    # Body size limit
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > _MAX_BODY_SIZE:
        return JSONResponse({"detail": "Request body too large"}, status_code=413)

    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    )
    return response

if settings.api_key:
    @app.middleware("http")
    async def require_api_key(request: Request, call_next):
        path = request.url.path
        if path.startswith("/assets") or path == "/health" or path == "/favicon.svg":
            return await call_next(request)
        auth = request.headers.get("Authorization", "")
        key = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
        if key != settings.api_key:
            if "text/html" in request.headers.get("Accept", ""):
                return await call_next(request)
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)

app.include_router(health.router)
app.include_router(repositories.router)
app.include_router(commits.router)
app.include_router(summaries.router)
if settings.youtrack_enabled:
    from app.routers import youtrack
    app.include_router(youtrack.router)

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if _STATIC_DIR.is_dir():
    from fastapi.responses import FileResponse
    app.mount("/assets", StaticFiles(directory=_STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        return FileResponse(_STATIC_DIR / "index.html")
