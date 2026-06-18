from pathlib import Path

from pydantic_settings import BaseSettings

_PROJECT_ROOT = Path(__file__).resolve().parent.parent

class Settings(BaseSettings):
    app_name: str = "Project History"
    data_dir: Path = _PROJECT_ROOT / "data"
    repos_dir: Path = _PROJECT_ROOT / "repos"
    database_url: str = ""

    ollama_base_url: str = "http://localhost:11434"
    ollama_client_mode: str = "native"
    default_model: str = "llama3.1"

    summary_chunk_size: int = 80
    summary_token_budget: int = 3200
    summary_temperature: float = 0.3

    ssh_key_path: str = ""

    git_timeout: int = 300
    git_network_timeout: int = 3600

    youtrack_enabled: bool = False
    youtrack_base_url: str = ""
    youtrack_api_token: str = ""

    api_key: str = ""

    rate_limit: int = 600
    rate_limit_window: int = 60

    log_level: str = "INFO"

    model_config = {"env_prefix": "PT_", "env_file": ".env"}

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.repos_dir.mkdir(parents=True, exist_ok=True)
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'app.db'}"

settings = Settings()
