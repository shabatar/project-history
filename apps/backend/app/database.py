import logging

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},  # SQLite-specific
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

def init_db() -> None:
    import os, stat
    from sqlalchemy import inspect, text
    import app.models  # noqa: F401 — ensure all models are registered with Base

    logger.info("Initializing database: %s", settings.database_url)
    Base.metadata.create_all(bind=engine)

    # Lightweight migrations for existing SQLite DBs
    inspector = inspect(engine)
    if "youtrack_configs" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("youtrack_configs")}
        if "api_token_encrypted" not in cols:
            logger.info("Adding youtrack_configs.api_token_encrypted column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE youtrack_configs ADD COLUMN api_token_encrypted TEXT"))
        if "api_token" in cols:
            # Legacy plaintext column from an earlier schema — drop it.
            logger.info("Dropping legacy youtrack_configs.api_token column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE youtrack_configs DROP COLUMN api_token"))

    # Owner-only permissions for data and repos directories
    for d in [settings.data_dir, settings.repos_dir]:
        if d.is_dir():
            try:
                os.chmod(d, stat.S_IRWXU)  # 0o700
            except OSError:
                pass  # may fail in Docker with volume mounts
    db_file = settings.data_dir / "app.db"
    if db_file.exists():
        try:
            os.chmod(db_file, stat.S_IRUSR | stat.S_IWUSR)  # 0o600
        except OSError:
            pass

    logger.info("Database tables created successfully")

def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
