# ── Stage 1: Build frontend ──
FROM node:22-alpine AS frontend-build
WORKDIR /build
COPY apps/frontend/package.json apps/frontend/package-lock.json* ./
RUN npm ci
COPY apps/frontend/ ./
RUN npm run build

# ── Stage 2: Production image ──
FROM python:3.12-slim

# Install git + ssh (needed for cloning repos)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r app && useradd -r -g app -m -s /bin/false app

WORKDIR /app

# Python deps
COPY apps/backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend source
COPY apps/backend/app/ ./app/

# Frontend build output → static/
COPY --from=frontend-build /build/dist/ ./static/

# Data & repos dirs owned by non-root user
RUN mkdir -p /app/data /app/repos && \
    chown -R app:app /app/data /app/repos

# Default env
ENV PT_DATABASE_URL=sqlite:////app/data/app.db \
    PT_LOG_LEVEL=INFO \
    PT_OLLAMA_BASE_URL=http://host.docker.internal:11434 \
    PT_DEFAULT_MODEL=llama3.1 \
    PT_YOUTRACK_ENABLED=false

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run as non-root
USER app

# Bind to 0.0.0.0 inside container (Docker port mapping controls external access).
# Set PT_API_KEY to require authentication if exposing to a network.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
