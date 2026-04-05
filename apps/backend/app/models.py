import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

def _uuid() -> str:
    return uuid.uuid4().hex

class Repository(Base):
    __tablename__ = "repositories"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    remote_url: Mapped[str] = mapped_column(String(2048), nullable=False, unique=True)
    local_path: Mapped[str] = mapped_column(String(2048), nullable=False)
    default_branch: Mapped[str] = mapped_column(String(255), default="main")
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    commits: Mapped[list["CommitRecord"]] = relationship(
        back_populates="repository", cascade="all, delete-orphan"
    )
    summary_jobs: Mapped[list["SummaryJob"]] = relationship(
        back_populates="repository", cascade="all, delete-orphan"
    )

class CommitRecord(Base):
    __tablename__ = "commit_records"
    __table_args__ = (
        UniqueConstraint("repository_id", "commit_hash", name="uq_repo_commit"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    repository_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False
    )
    commit_hash: Mapped[str] = mapped_column(String(40), nullable=False)
    author_name: Mapped[str] = mapped_column(String(255), nullable=False)
    author_email: Mapped[str] = mapped_column(String(255), nullable=False)
    committed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    subject: Mapped[str] = mapped_column(String(500), nullable=False)
    body: Mapped[str] = mapped_column(Text, default="")
    raw_text: Mapped[str] = mapped_column(Text, default="")

    repository: Mapped["Repository"] = relationship(back_populates="commits")

class SummaryJob(Base):
    __tablename__ = "summary_jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    repository_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False
    )
    start_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    branch: Mapped[str | None] = mapped_column(String(255), nullable=True)
    base_branch: Mapped[str | None] = mapped_column(String(255), nullable=True)
    model_name: Mapped[str] = mapped_column(String(255), nullable=False)
    summary_style: Mapped[str] = mapped_column(String(32), default="detailed")
    status: Mapped[str] = mapped_column(String(32), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))

    repository: Mapped["Repository"] = relationship(back_populates="summary_jobs")
    result: Mapped["SummaryResult | None"] = relationship(
        back_populates="summary_job", uselist=False, cascade="all, delete-orphan"
    )

class SummaryResult(Base):
    __tablename__ = "summary_results"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    summary_job_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("summary_jobs.id", ondelete="CASCADE"), nullable=False
    )
    summary_markdown: Mapped[str] = mapped_column(Text, nullable=False)
    commit_count: Mapped[int] = mapped_column(Integer, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))

    summary_job: Mapped["SummaryJob"] = relationship(back_populates="result")

# ── YouTrack Boards ──

class YouTrackConfig(Base):
    """YouTrack server connection. Token comes from env var, not DB."""

    __tablename__ = "youtrack_configs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    base_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))

    boards: Mapped[list["YouTrackBoard"]] = relationship(
        back_populates="config", cascade="all, delete-orphan"
    )

class YouTrackBoard(Base):
    """An agile board being tracked."""

    __tablename__ = "youtrack_boards"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    config_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("youtrack_configs.id", ondelete="CASCADE"), nullable=False
    )
    board_id: Mapped[str] = mapped_column(String(255), nullable=False)
    board_name: Mapped[str] = mapped_column(String(500), default="")
    board_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    config: Mapped["YouTrackConfig"] = relationship(back_populates="boards")
    issue_snapshots: Mapped[list["YouTrackIssueSnapshot"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )

class YouTrackIssueSnapshot(Base):
    """Point-in-time snapshot of an issue on a board."""

    __tablename__ = "youtrack_issue_snapshots"
    __table_args__ = (
        UniqueConstraint("board_id", "issue_id", "synced_at", name="uq_board_issue_sync"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    board_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("youtrack_boards.id", ondelete="CASCADE"), nullable=False
    )
    issue_id: Mapped[str] = mapped_column(String(255), nullable=False)  # e.g. PROJ-123
    summary: Mapped[str] = mapped_column(String(1000), default="")
    state: Mapped[str] = mapped_column(String(255), default="")
    assignee: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))

    board: Mapped["YouTrackBoard"] = relationship(back_populates="issue_snapshots")

