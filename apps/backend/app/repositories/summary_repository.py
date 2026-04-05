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
    ) -> SummaryJob:
        job = SummaryJob(
            repository_id=repository_id,
            start_date=start_date,
            end_date=end_date,
            branch=branch,
            base_branch=base_branch,
            model_name=model_name,
            summary_style=summary_style,
            status="pending",
        )
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)
        return job

    def set_status(self, job: SummaryJob, status: str) -> None:
        job.status = status
        self.db.commit()

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
