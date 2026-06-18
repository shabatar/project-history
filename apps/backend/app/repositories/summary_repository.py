from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import SummaryJob, SummaryResult

class SummaryRepository:
    def __init__(self, db: Session):
        self.db = db

    def create_job(
        self,
        repository_id: str,
        model_name: str,
        summary_style: str = "detailed",
        start_date: datetime | None = None,
        end_date: datetime | None = None,
        branch: str | None = None,
        base_branch: str | None = None,
        custom_prompt: str | None = None,
    ) -> SummaryJob:
        job = SummaryJob(
            repository_id=repository_id,
            start_date=start_date,
            end_date=end_date,
            branch=branch,
            base_branch=base_branch,
            model_name=model_name,
            summary_style=summary_style,
            custom_prompt=custom_prompt,
            status="pending",
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def set_status(self, job: SummaryJob, status: str, error: str | None = None) -> None:
        job.status = status
        if error is not None:
            job.error = error
        self.db.commit()

    def reconcile_orphans(self) -> int:
        """Mark jobs left in a non-terminal state as failed.

        Generation runs in an in-process background task, so any job still
        ``pending``/``running`` after a server restart is orphaned — it will
        never complete. Flag it so the UI shows it as failed, not "running"
        forever.
        """
        orphans = (
            self.db.query(SummaryJob)
            .filter(SummaryJob.status.in_(("pending", "running")))
            .all()
        )
        for job in orphans:
            job.status = "failed"
            job.error = "Generation was interrupted (server restarted)."
        if orphans:
            self.db.commit()
        return len(orphans)

    def add_result(
        self,
        job: SummaryJob,
        summary_markdown: str,
        commit_count: int,
    ) -> SummaryResult:
        result = SummaryResult(
            summary_job_id=job.id,
            summary_markdown=summary_markdown,
            commit_count=commit_count,
            generated_at=datetime.now(UTC),
        )
        job.status = "completed"
        self.db.add(result)
        self.db.commit()
        self.db.refresh(result)
        return result

    def list_jobs(self, repository_id: str | None = None) -> list[SummaryJob]:
        q = self.db.query(SummaryJob)
        if repository_id:
            q = q.filter(SummaryJob.repository_id == repository_id)
        return q.order_by(SummaryJob.created_at.desc()).all()

    def get_job(self, job_id: str) -> SummaryJob | None:
        return self.db.get(SummaryJob, job_id)

    def delete_job(self, job: SummaryJob) -> None:
        self.db.delete(job)
        self.db.commit()
