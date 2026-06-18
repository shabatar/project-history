from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models import CommitRecord


def _day_start(value: str) -> datetime:
    """Parse a 'YYYY-MM-DD' (or ISO datetime) string to the start of that day."""
    return datetime.fromisoformat(value[:10])


class CommitRepository:
    def __init__(self, db: Session):
        self.db = db

    def list_by_repo(
        self,
        repository_id: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = 200,
    ) -> list[CommitRecord]:
        q = self.db.query(CommitRecord).filter(
            CommitRecord.repository_id == repository_id
        )
        if since:
            q = q.filter(CommitRecord.committed_at >= _day_start(since))
        if until:
            q = q.filter(CommitRecord.committed_at < _day_start(until) + timedelta(days=1))
        return q.order_by(CommitRecord.committed_at.desc()).limit(limit).all()

    def list_by_repo_and_range(
        self,
        repository_id: str,
        start: datetime,
        end: datetime,
    ) -> list[CommitRecord]:
        return (
            self.db.query(CommitRecord)
            .filter(
                CommitRecord.repository_id == repository_id,
                CommitRecord.committed_at >= start,
                CommitRecord.committed_at <= end,
            )
            .order_by(CommitRecord.committed_at)
            .all()
        )

    def existing_hashes(self, repository_id: str) -> set[str]:
        return {
            h
            for (h,) in self.db.query(CommitRecord.commit_hash).filter(
                CommitRecord.repository_id == repository_id
            )
        }

    def list_by_hashes(
        self,
        repository_id: str,
        hashes: set[str],
    ) -> list[CommitRecord]:
        if not hashes:
            return []
        return (
            self.db.query(CommitRecord)
            .filter(
                CommitRecord.repository_id == repository_id,
                CommitRecord.commit_hash.in_(hashes),
            )
            .order_by(CommitRecord.committed_at)
            .all()
        )

    def bulk_add(self, records: list[CommitRecord]) -> None:
        self.db.add_all(records)
        self.db.commit()
