# Project History

[![License: MIT](https://img.shields.io/badge/license-MIT-a78bfa?style=flat-square)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12+-a78bfa?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-a78bfa?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Docker](https://img.shields.io/badge/docker-ready-a78bfa?style=flat-square&logo=docker&logoColor=white)](Dockerfile)
[![React](https://img.shields.io/badge/react-19-a78bfa?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![FastAPI](https://img.shields.io/badge/fastapi-0.135-a78bfa?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)

A self-hosted tool for tracking git repositories, exploring commits, and generating AI-powered summaries — with optional YouTrack integration for full-stack engineering activity.

## Features

- **Repositories** — add repos via SSH or HTTPS, clone, pull, browse from the UI.
- **Commit explorer** — browse commits across multiple repos, filter by date range or branch diff, save snapshots.
- **AI summaries** — summarise commits using a local LLM with brief, detailed, or custom prompts.
- **Reports** — unified history of summaries and snapshots with inline comments and AI follow-ups.
- **YouTrack** *(optional)* — boards, projects, activity snapshots, and AI-generated activity summaries.

## Docker

```bash
cp .env.example .env
docker compose up -d
```

Open **http://localhost:8000**.

## Local setup

**Install prerequisites:**

- **Python 3.12+** — [python.org/downloads](https://www.python.org/downloads)
- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Ollama** — [ollama.com](https://ollama.com/download)

```bash
git clone https://github.com/shabatar/project-history.git
cd project-history
make install
cp apps/backend/.env.example apps/backend/.env
make dev
```

Open **http://localhost:5173**.

## Configuration

For most setups `.env` can be empty — defaults connect to Ollama on the host at `localhost:11434`.

**Enable YouTrack** (adds Boards and Projects to the Activity tab):
```env
PT_YOUTRACK_ENABLED=true
PT_YOUTRACK_BASE_URL=https://youtrack.example.com
PT_YOUTRACK_API_TOKEN=perm:your-token
```

**Different LLM backend (any OpenAI-compatible endpoint):**
```env
PT_OLLAMA_BASE_URL=http://localhost:1234
PT_OLLAMA_CLIENT_MODE=openai
PT_DEFAULT_MODEL=my-model
```

**Lock down with an API key** (recommended if exposed to a network):
```env
PT_API_KEY=your-secret
```

Full configuration reference in [DEV.md](DEV.md).

## License

[MIT](LICENSE)
