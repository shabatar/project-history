"""Test summarize route with mocked Ollama responses."""

import pytest
from datetime import datetime
from unittest.mock import patch, AsyncMock

from app.models import CommitRecord, Repository


def _seed_repo_with_commits(db):
    repo = Repository(
        id="sumrepo1",
        name="summary-test",
        remote_url="https://github.com/test/summary.git",
        local_path="/tmp/fake-summary-repo",
        default_branch="main",
        last_synced_at=datetime(2025, 3, 20),
    )
    db.add(repo)
    db.flush()

    commits = [
        CommitRecord(
            repository_id=repo.id,
            commit_hash="a" * 40,
            author_name="Alice",
            author_email="alice@test.com",
            committed_at=datetime(2025, 3, 15, 10, 0),
            subject="Add authentication module",
            body="Implemented JWT-based auth",
            raw_text="",
        ),
        CommitRecord(
            repository_id=repo.id,
            commit_hash="b" * 40,
            author_name="Bob",
            author_email="bob@test.com",
            committed_at=datetime(2025, 3, 16, 14, 0),
            subject="Fix login redirect bug",
            body="",
            raw_text="",
        ),
        CommitRecord(
            repository_id=repo.id,
            commit_hash="c" * 40,
            author_name="Alice",
            author_email="alice@test.com",
            committed_at=datetime(2025, 3, 17, 9, 0),
            subject="Refactor database layer",
            body="Moved to repository pattern",
            raw_text="",
        ),
    ]
    db.add_all(commits)
    db.commit()
    return repo


MOCK_SUMMARY_MD = """\
## High-Level Summary
Authentication and database improvements.

## Bug Fixes
- Fixed login redirect

## Refactors / Cleanup
- Repository pattern migration
"""


def test_create_summary_success(client, db):
    repo = _seed_repo_with_commits(db)

    with patch("app.services.ollama_service.generate", new_callable=AsyncMock) as mock_gen:
        mock_gen.return_value = MOCK_SUMMARY_MD

        resp = client.post("/summaries", json={
            "repository_id": repo.id,
            "start_date": "2025-03-01",
            "end_date": "2025-03-31",
            "model_name": "llama3.1",
            "summary_style": "detailed",
        })

    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "completed"
    assert data["model_name"] == "llama3.1"
    assert data["summary_style"] == "detailed"
    assert data["result"] is not None
    assert data["result"]["commit_count"] == 3
    assert "Authentication" in data["result"]["summary_markdown"]

    # Verify Ollama was called
    mock_gen.assert_called_once()
    prompt = mock_gen.call_args[0][0]
    assert "summary-test" in prompt  # repo name in prompt


def test_create_summary_no_commits(client, db):
    repo = Repository(
        id="emptyrepo",
        name="empty",
        remote_url="https://github.com/test/empty.git",
        local_path="/tmp/fake-empty",
        default_branch="main",
    )
    db.add(repo)
    db.commit()

    with patch("app.services.ollama_service.generate", new_callable=AsyncMock) as mock_gen:
        resp = client.post("/summaries", json={
            "repository_id": repo.id,
            "start_date": "2025-03-01",
            "end_date": "2025-03-31",
        })

    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "completed"
    assert data["result"]["commit_count"] == 0
    assert "No commits" in data["result"]["summary_markdown"]

    # Ollama should NOT be called when there are no commits
    mock_gen.assert_not_called()


def test_create_summary_invalid_repo(client):
    resp = client.post("/summaries", json={
        "repository_id": "nonexistent",
        "start_date": "2025-03-01",
        "end_date": "2025-03-31",
    })
    assert resp.status_code == 404


def test_list_summaries(client, db):
    repo = _seed_repo_with_commits(db)

    with patch("app.services.ollama_service.generate", new_callable=AsyncMock) as mock_gen:
        mock_gen.return_value = "summary 1"
        client.post("/summaries", json={
            "repository_id": repo.id,
            "start_date": "2025-03-01",
            "end_date": "2025-03-15",
        })
        mock_gen.return_value = "summary 2"
        client.post("/summaries", json={
            "repository_id": repo.id,
            "start_date": "2025-03-15",
            "end_date": "2025-03-31",
        })

    resp = client.get("/summaries", params={"repository_id": repo.id})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2


def test_summary_style_validation(client, db):
    repo = _seed_repo_with_commits(db)

    resp = client.post("/summaries", json={
        "repository_id": repo.id,
        "start_date": "2025-03-01",
        "end_date": "2025-03-31",
        "summary_style": "invalid_style",
    })
    assert resp.status_code == 422
