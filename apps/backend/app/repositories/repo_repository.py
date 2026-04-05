from datetime import UTC, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import CommitRecord, Repository

class RepoRepository:
    def __init__(self, db: Session):
        self.db = db

    def list_active(self) -> list[Repository]:
        return (
            self.db.query(Repository)
            .filter(Repository.is_active.is_(True))
            .all()
        )

    def list_not_cloned(self) -> list[Repository]:
        return (
            self.db.query(Repository)
            .filter(
                Repository.is_active.is_(True),
                Repository.last_synced_at.is_(None),
            )
            .all()
        )

    def list_cloned(self) -> list[Repository]:
        return (
            self.db.query(Repository)
            .filter(
                Repository.is_active.is_(True),
                Repository.last_synced_at.isnot(None),
            )
            .all()
        )

    def get_by_id(self, repo_id: str) -> Repository | None:
        return self.db.get(Repository, repo_id)

    def get_by_url(self, remote_url: str) -> Repository | None:
        return (
            self.db.query(Repository)
            .filter(Repository.remote_url == remote_url)
            .first()
        )

    def create(self, name: str, remote_url: str, local_path: str) -> Repository:
        repo = Repository(
            name=name,
            remote_url=remote_url,
            local_path=local_path,
        )
        self.db.add(repo)
        self.db.commit()
        self.db.refresh(repo)
        return repo

    def update(self, repo: Repository, **fields) -> Repository:
        for key, value in fields.items():
            if value is not None:
                setattr(repo, key, value)
        self.db.commit()
        self.db.refresh(repo)
        return repo

    def mark_synced(self, repo: Repository) -> Repository:
        repo.last_synced_at = datetime.now(UTC)
        repo.last_sync_error = None
        self.db.commit()
        self.db.refresh(repo)
        return repo

    def set_sync_error(self, repo: Repository, error: str) -> Repository:
        repo.last_sync_error = error
        self.db.commit()
        self.db.refresh(repo)
        return repo

    def delete(self, repo: Repository) -> None:
        self.db.delete(repo)
        self.db.commit()

    def commit_count(self, repo_id: str) -> int:
        return (
            self.db.query(func.count(CommitRecord.id))
            .filter(CommitRecord.repository_id == repo_id)
            .scalar()
            or 0
        )
