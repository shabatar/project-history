# Setup & Deployment

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

---

## Docker Compose (recommended)

```bash
cp .env.example .env   # edit as needed
docker compose up -d
```

Open **http://localhost:8000**.

Secrets and config live in `.env` (gitignored). See `.env.example` for all options.

**Any OpenAI-compatible backend** (LocalAI, vLLM, LM Studio, etc.) — set in `.env`:
```
PT_OLLAMA_BASE_URL=http://host.docker.internal:1234
PT_OLLAMA_CLIENT_MODE=openai
PT_DEFAULT_MODEL=my-model
```

**With Ollama inside Docker** (no host install needed):
```bash
docker compose --profile ollama up -d
```
Then go to **Settings → Models** to download a model. Models persist in the `ollama-models` volume.

**GPU acceleration** (Linux + NVIDIA Container Toolkit): uncomment the `deploy` block in `docker-compose.yml`.

**YouTrack** (Boards + Projects in the Activity tab): set `PT_YOUTRACK_ENABLED=true` and credentials in `.env`.

---

## Single container

```bash
docker build -t project-history .

docker run -d \
  --name project-history \
  -p 8000:8000 \
  -v ph-data:/app/data \
  -v ph-repos:/app/repos \
  -e PT_OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  project-history
```

Pass secrets from `.env` to avoid tokens in shell history:
```bash
  -e PT_YOUTRACK_ENABLED=true \
  -e PT_YOUTRACK_BASE_URL="$PT_YOUTRACK_BASE_URL" \
  -e PT_YOUTRACK_API_TOKEN="$PT_YOUTRACK_API_TOKEN"
```

> The YouTrack token can also be set via the UI (Boards page) — stored encrypted at rest.

### SSH keys (private repos)

**Agent forwarding** (recommended — keys never enter the container):
```bash
# macOS
-v /run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock \
-e SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock

# Linux
-v $SSH_AUTH_SOCK:/ssh-agent -e SSH_AUTH_SOCK=/ssh-agent
```

**Dedicated deploy key:**
```bash
ssh-keygen -t ed25519 -f ~/.ssh/project-history-key -N ""
# Add the public key to your git host, then mount:
-v ~/.ssh/project-history-key:/home/app/.ssh/id_ed25519:ro
```

---

## Local development

Requires Python 3.12+, Node.js 22+, and [Ollama](https://ollama.com).

```bash
make install
cp apps/backend/.env.example apps/backend/.env
make dev
```

Open **http://localhost:5173**. `make dev` starts backend and frontend together.

```bash
make test   # run all tests
```

---

## Configuration

All env vars use the `PT_` prefix. Set in `.env` or pass via `-e` to Docker.

| Variable | Default | Description |
|---|---|---|
| `PT_API_KEY` | *(empty)* | API key for authentication (required if exposed to a network) |
| `PT_DATABASE_URL` | `sqlite:///data/app.db` | Database connection string |
| `PT_OLLAMA_BASE_URL` | `http://localhost:11434` | LLM backend URL |
| `PT_OLLAMA_CLIENT_MODE` | `native` | `native` or `openai` (any OpenAI-compatible endpoint) |
| `PT_DEFAULT_MODEL` | `llama3.1` | Default model name |
| `PT_SUMMARY_CHUNK_SIZE` | `80` | Commits per chunk when summarising |
| `PT_SUMMARY_TOKEN_BUDGET` | `3200` | Max tokens per summarisation request |
| `PT_SUMMARY_TEMPERATURE` | `0.3` | LLM sampling temperature |
| `PT_SSH_KEY_PATH` | *(empty)* | SSH key for private repos (empty = system agent) |
| `PT_YOUTRACK_ENABLED` | `false` | Enable YouTrack (adds Boards + Projects to the Activity tab) |
| `PT_YOUTRACK_BASE_URL` | *(empty)* | YouTrack instance URL |
| `PT_YOUTRACK_API_TOKEN` | *(empty)* | YouTrack API token (takes precedence over UI token) |
| `PT_SECRET_KEY` | *(auto-generated)* | Encryption key for secrets at rest |
| `PT_LOG_LEVEL` | `INFO` | Log level |
