import logging

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

def init_db() -> None:
    import os, stat
    from sqlalchemy import inspect, text
    import app.models

    logger.info("Initializing database: %s", settings.database_url)
    Base.metadata.create_all(bind=engine)

    inspector = inspect(engine)
    if "youtrack_configs" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("youtrack_configs")}
        if "api_token_encrypted" not in cols:
            logger.info("Adding youtrack_configs.api_token_encrypted column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE youtrack_configs ADD COLUMN api_token_encrypted TEXT"))
        if "api_token" in cols:
            logger.info("Dropping legacy youtrack_configs.api_token column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE youtrack_configs DROP COLUMN api_token"))

    if "summary_jobs" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("summary_jobs")}
        if "custom_prompt" not in cols:
            logger.info("Adding summary_jobs.custom_prompt column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE summary_jobs ADD COLUMN custom_prompt TEXT"))
        if "error" not in cols:
            logger.info("Adding summary_jobs.error column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE summary_jobs ADD COLUMN error TEXT"))

    if "activity_summaries" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("activity_summaries")}
        if "custom_prompt" not in cols:
            logger.info("Adding activity_summaries.custom_prompt column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE activity_summaries ADD COLUMN custom_prompt TEXT"))
        if "user_label" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE activity_summaries ADD COLUMN user_label VARCHAR(500)"))
        if "status" not in cols:
            logger.info("Adding activity_summaries.status column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE activity_summaries ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'completed'"))
        if "error" not in cols:
            logger.info("Adding activity_summaries.error column")
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE activity_summaries ADD COLUMN error TEXT"))

    if "summary_jobs" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("summary_jobs")}
        if "user_label" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE summary_jobs ADD COLUMN user_label VARCHAR(500)"))

    if "activity_snapshots" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("activity_snapshots")}
        if "user_label" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE activity_snapshots ADD COLUMN user_label VARCHAR(500)"))
        if "view_mode" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE activity_snapshots ADD COLUMN view_mode VARCHAR(16) NOT NULL DEFAULT 'timeline'"))

    if "commit_snapshots" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("commit_snapshots")}
        if "user_label" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE commit_snapshots ADD COLUMN user_label VARCHAR(500)"))

    for d in [settings.data_dir, settings.repos_dir]:
        if d.is_dir():
            try:
                os.chmod(d, stat.S_IRWXU)
            except OSError:
                pass
    db_file = settings.data_dir / "app.db"
    if db_file.exists():
        try:
            os.chmod(db_file, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass

    logger.info("Database tables created successfully")

def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
