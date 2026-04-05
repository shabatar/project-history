# Project History

[![License: MIT](https://img.shields.io/badge/license-MIT-a78bfa?style=flat-square)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12+-a78bfa?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-a78bfa?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Docker](https://img.shields.io/badge/docker-ready-a78bfa?style=flat-square&logo=docker&logoColor=white)](Dockerfile)
[![React](https://img.shields.io/badge/react-19-a78bfa?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![FastAPI](https://img.shields.io/badge/fastapi-0.135-a78bfa?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)

A self-hosted tool for tracking git repositories, exploring commits, and generating AI-powered summaries.

## Features

- **Repository management** — add repos via SSH or HTTPS from any git host (GitHub, GitLab, Bitbucket, self-hosted). Clone, pull, browse from the UI.
- **Commit explorer** — browse commits across multiple repos simultaneously (merged or side-by-side), filter by date range, search by author/message.
- **AI summaries** — generate commit summaries using a local Ollama model. Short, detailed, or brief styles.
- **YouTrack boards** *(optional)* — track agile boards, sync issues, view activity history with date range filtering.
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

### With Ollama (for AI summaries)

Run [Ollama](https://ollama.com) on your host, then point the container to it:

```bash
# Install and start Ollama
ollama serve &
ollama pull llama3.1

docker run -d \
  --name project-history \
  -p 8000:8000 \
  -v ph-data:/app/data \
  -v ph-repos:/app/repos \
  -e PT_OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  project-history
```

### With YouTrack boards

```bash
docker run -d \
  --name project-history \
  -p 8000:8000 \
  -v ph-data:/app/data \
  -v ph-repos:/app/repos \
  -e PT_YOUTRACK_ENABLED=true \
  -e PT_YOUTRACK_API_TOKEN=perm:your-token \
  project-history
```

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

Open **http://localhost:5173** (proxies API calls to the backend).

### Run tests

```bash
cd apps/frontend && npm test       # vitest + jsdom
cd apps/backend && python -m pytest  # pytest
```

## Configuration

All env vars use the `PT_` prefix. Set them in `apps/backend/.env` or pass via Docker `-e`.

| Variable | Default | Description |
|---|---|---|
| `PT_API_KEY` | *(empty)* | API key for authentication (required if exposed to network) |
| `PT_DATABASE_URL` | `sqlite:///data/app.db` | Database connection string |
| `PT_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `PT_DEFAULT_MODEL` | `llama3.1` | Default LLM model |
| `PT_SSH_KEY_PATH` | *(empty)* | SSH key for private repos (empty = system default) |
| `PT_YOUTRACK_ENABLED` | `false` | Enable YouTrack board tracking module |
| `PT_YOUTRACK_API_TOKEN` | *(empty)* | YouTrack API token (env var only, never stored in DB) |
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
      routers/          API endpoints
      services/         Git, summarization, YouTrack logic
  frontend/             React / TypeScript / Vite
    src/
      pages/            Page components
      components/       Reusable UI components
      lib/              API client, hooks, utilities
```

## License

[MIT](LICENSE)
