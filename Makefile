.PHONY: install backend frontend dev test test-backend test-frontend lint clean help

BACKEND  := apps/backend
FRONTEND := apps/frontend
VENV     := .venv/bin

# ── Primary targets ──

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: install-backend install-frontend ## Install all dependencies

backend: ## Start backend (uvicorn, reload)
	cd $(BACKEND) && $(VENV)/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

frontend: ## Start frontend (vite dev server)
	cd $(FRONTEND) && npm run dev

dev: ## Start backend + frontend concurrently
	@echo "Starting backend and frontend..."
	@make -j2 backend frontend

test: test-backend test-frontend ## Run all tests

# ── Backend ──

install-backend: ## Install backend Python dependencies
	cd $(BACKEND) && python3 -m venv .venv && \
		$(VENV)/pip install -q -r requirements.txt

test-backend: ## Run backend tests
	cd $(BACKEND) && $(VENV)/python -m pytest tests/ -v

lint-backend: ## Lint backend
	cd $(BACKEND) && $(VENV)/python -m py_compile app/main.py

# ── Frontend ──

install-frontend: ## Install frontend npm dependencies
	cd $(FRONTEND) && npm install

test-frontend: ## Run frontend tests
	cd $(FRONTEND) && npx vitest run

lint-frontend: ## Lint frontend
	cd $(FRONTEND) && npm run lint

build-frontend: ## Production build of frontend
	cd $(FRONTEND) && npm run build

# ── Utilities ──

lint: lint-backend lint-frontend ## Lint everything

clean: ## Remove build artifacts and caches
	rm -rf $(FRONTEND)/dist $(FRONTEND)/node_modules/.tmp
	rm -rf $(BACKEND)/.pytest_cache $(BACKEND)/__pycache__
	find $(BACKEND) -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

db-reset: ## Delete the SQLite database (starts fresh)
	rm -f $(BACKEND)/data/app.db
	@echo "Database deleted. It will be recreated on next backend start."

check-ollama: ## Verify Ollama is running and list models
	@ollama --version 2>/dev/null || (echo "ERROR: ollama not found. Install from https://ollama.com" && exit 1)
	@curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 || (echo "ERROR: Ollama is not running. Start it with: ollama serve" && exit 1)
	@echo "Ollama is running. Available models:"
	@ollama list
