# Project History

[![License: MIT](https://img.shields.io/badge/license-MIT-a78bfa?style=flat-square)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12+-a78bfa?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-a78bfa?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Docker](https://img.shields.io/badge/docker-ready-a78bfa?style=flat-square&logo=docker&logoColor=white)](Dockerfile)
[![React](https://img.shields.io/badge/react-19-a78bfa?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![FastAPI](https://img.shields.io/badge/fastapi-0.135-a78bfa?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)

A self-hosted tool for tracking git repositories, exploring commits, and generating AI-powered summaries — with optional YouTrack integration for full-stack engineering activity.

## Features

- **Repository management** — add repos via SSH or HTTPS from any git host (GitHub, GitLab, Bitbucket, self-hosted). Clone, pull, browse from the UI.
- **Commit explorer** — browse commits across multiple repos simultaneously (merged or side-by-side), filter by date range or branch diff, search by author/message. Save commit sets as snapshots.
- **AI summaries** — generate commit summaries using a local Ollama model. Brief, detailed, or fully custom prompt styles.
- **Reports** — a unified history of all AI summaries and commit snapshots. View inline or open the full detail page. Comment and ask AI follow-up questions on any report. Double-click any report name to rename it.
- **YouTrack integration** *(optional)* — track agile boards and projects, sync issues, capture activity snapshots with date range filtering. AI-generated activity summaries with the same comment/follow-up system.
- **Dark mode** — follows system preference.

## Quick start with Docker

Single container — frontend, backend, and database all-in-one.

```bash
docker build -t project-history .

docker run -d \
  --name project-history \
  -p 8000:8000 \
  -v ph-data:/app/data \
  -v ph-repos:/app/repos \
  project-history
```

Open **http://localhost:8000**.

Ollama runs on your host machine, outside Docker — see the next section.

### Ollama setup (required for AI features)

1. Install Ollama: [ollama.com](https://ollama.com)

2. Start the Ollama server:
   ```bash
   ollama serve
   ```

3. Run Project History pointing at your host's Ollama:
   ```bash
   docker run -d \
     --name project-history \
     -p 8000:8000 \
     -v ph-data:/app/data \
     -v ph-repos:/app/repos \
     -e PT_OLLAMA_BASE_URL=http://host.docker.internal:11434 \
     project-history
   ```

4. Open the app, go to **Settings → Models**, and download a model (e.g. `llama3.1`). The download runs in the background — a progress indicator appears while it runs. No models need to be pre-installed; the app guides you from there.

### With YouTrack boards

```bash
docker run -d \
  --name project-history \
  -p 8000:8000 \
  -v ph-data:/app/data \
  -v ph-repos:/app/repos \
  -e PT_YOUTRACK_ENABLED=true \
  -e PT_YOUTRACK_BASE_URL=https://youtrack.example.com \
  -e PT_YOUTRACK_API_TOKEN=perm:your-token \
  project-history
```

> You can also set the token via the UI (Boards page) — it is stored encrypted at rest and the env var takes precedence if both are set.

### SSH keys (private repos)

**Option 1 — SSH agent forwarding** (recommended, keys never enter the container):

```bash
# macOS
-v /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock \
-e SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock

# Linux
-v $SSH_AUTH_SOCK:/ssh-agent -e SSH_AUTH_SOCK=/ssh-agent
```

**Option 2 — dedicated deploy key** (generate a key just for this app):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/project-history-key -N ""
# Add the public key to your git host as a deploy key
-v ~/.ssh/project-history-key:/home/app/.ssh/id_ed25519:ro
```


## Local development

### Prerequisites

- Python 3.12+
- Node.js 22+
- Git
- [Ollama](https://ollama.com) (for AI features)

### Backend

```bash
cd apps/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # edit as needed
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd apps/frontend
npm install
npm run dev
```

Open **http://localhost:5173** (proxies API calls to the backend at port 8000).

### Run both at once

```bash
make dev
```

### Run tests

```bash
cd apps/frontend && npm test       # vitest + jsdom
cd apps/backend && python -m pytest  # pytest
```

## Configuration

All env vars use the `PT_` prefix. Set them in `apps/backend/.env` or pass via Docker `-e`.

| Variable | Default | Description |
|---|---|---|
| `PT_API_KEY` | *(empty)* | API key for authentication (required if exposed to a network) |
| `PT_DATABASE_URL` | `sqlite:///data/app.db` | Database connection string |
| `PT_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `PT_OLLAMA_CLIENT_MODE` | `native` | LLM client mode: `native` (default) or `openai` (OpenAI-compatible endpoint) |
| `PT_DEFAULT_MODEL` | `llama3.1` | Default LLM model name |
| `PT_SUMMARY_CHUNK_SIZE` | `80` | Commits per chunk when summarising |
| `PT_SUMMARY_TOKEN_BUDGET` | `3200` | Max tokens per summarisation request |
| `PT_SUMMARY_TEMPERATURE` | `0.3` | LLM sampling temperature |
| `PT_SSH_KEY_PATH` | *(empty)* | SSH key path for private repos (empty = system SSH agent) |
| `PT_YOUTRACK_ENABLED` | `false` | Enable YouTrack integration |
| `PT_YOUTRACK_BASE_URL` | *(empty)* | YouTrack instance URL |
| `PT_YOUTRACK_API_TOKEN` | *(empty)* | YouTrack API token (env var takes precedence over UI token) |
| `PT_SECRET_KEY` | *(auto-generated)* | Encryption key for secrets at rest. Auto-generated and saved to `data/.secret_key` if not set. |
| `PT_LOG_LEVEL` | `INFO` | Log level |

## Project structure

```
apps/
  backend/              Python / FastAPI
    app/
      main.py           App entry, router registration
      config.py         Settings from environment
      models.py         SQLAlchemy models
      schemas.py        Pydantic request/response schemas
      database.py       DB init and migrations
      routers/          API endpoints (summaries, repos, youtrack, commit-snapshots, …)
      services/         Git, summarisation, YouTrack, comments logic
  frontend/             React / TypeScript / Vite
    src/
      pages/            Page components (CommitWorkbench, Summaries, Activity, Settings, …)
      components/       Reusable UI (CommentsSection, Layout, …)
      lib/              API client, hooks, utilities
      store/            Zustand app state
```

## License

[MIT](LICENSE)
