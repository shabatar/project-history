from pathlib import Path

from pydantic_settings import BaseSettings

_PROJECT_ROOT = Path(__file__).resolve().parent.parent  # apps/backend

class Settings(BaseSettings):
    app_name: str = "Project History"
    data_dir: Path = _PROJECT_ROOT / "data"
    repos_dir: Path = _PROJECT_ROOT / "repos"
    database_url: str = ""

    # Ollama
    ollama_base_url: str = "http://localhost:11434"
    ollama_client_mode: str = "native"  # "native" | "openai"
    default_model: str = "llama3.1"

    # Summarisation tuning
    summary_chunk_size: int = 80  # max commits per LLM call (fallback)
    summary_token_budget: int = 3200  # approx token budget per chunk prompt
    summary_temperature: float = 0.3

    # Git SSH
    ssh_key_path: str = ""  # e.g. ~/.ssh/id_rsa — empty = system default

    # YouTrack integration (optional)
    youtrack_enabled: bool = False
    youtrack_base_url: str = ""    # e.g. https://youtrack.example.com
    youtrack_api_token: str = ""   # set via env var, never stored in DB

    # API access control (optional — if set, all endpoints require this key)
    api_key: str = ""  # set PT_API_KEY to require authentication

    log_level: str = "INFO"

    model_config = {"env_prefix": "PT_", "env_file": ".env"}

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.repos_dir.mkdir(parents=True, exist_ok=True)
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'app.db'}"

settings = Settings()
