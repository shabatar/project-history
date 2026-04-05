"""Test error handling and edge cases."""

import pytest
from unittest.mock import patch, AsyncMock

from app.models import Repository
from app.services.git_service import GitService, GitCommandError


def _seed_repo(db, cloned: bool = True) -> Repository:
    repo = Repository(
        id="errrepo1",
        name="error-test",
        remote_url="https://github.com/test/error.git",
        local_path="/tmp/nonexistent-repo-path",
        default_branch="main",
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


# ── Clone / Pull errors ──

def test_clone_nonexistent_repo(client):
    resp = client.post("/repositories/nonexistent-id/clone")
    assert resp.status_code == 404


def test_pull_nonexistent_repo(client):
    resp = client.post("/repositories/nonexistent-id/pull")
    assert resp.status_code == 404


def test_pull_uncloned_repo(client, db):
    repo = _seed_repo(db)
    resp = client.post(f"/repositories/{repo.id}/pull")
    assert resp.status_code == 500
    assert "does not exist" in resp.json()["detail"]


# ── Commit parsing errors ──

def test_parse_commits_uncloned_repo(client, db):
    repo = _seed_repo(db)
    resp = client.post(
        f"/repositories/{repo.id}/commits/parse",
        json={"since": "2025-01-01"},
    )
    assert resp.status_code == 500


def test_parse_commits_nonexistent_repo(client):
    resp = client.post(
        "/repositories/nonexistent/commits/parse",
        json={},
    )
    assert resp.status_code == 404


# ── Summary errors ──

def test_summary_nonexistent_repo(client):
    resp = client.post("/summaries", json={
        "repository_id": "nonexistent",
        "start_date": "2025-01-01",
        "end_date": "2025-12-31",
    })
    assert resp.status_code == 404


def test_summary_missing_dates_and_branch(client, db):
    repo = _seed_repo(db)
    resp = client.post("/summaries", json={
        "repository_id": repo.id,
    })
    assert resp.status_code == 422


def test_summary_invalid_style(client, db):
    repo = _seed_repo(db)
    resp = client.post("/summaries", json={
        "repository_id": repo.id,
        "start_date": "2025-01-01",
        "end_date": "2025-12-31",
        "summary_style": "bogus",
    })
    assert resp.status_code == 422


# ── Duplicate repository ──

def test_duplicate_url_returns_409(client):
    url = "https://github.com/test/dup-err.git"
    client.post("/repositories", json={"remote_url": url})
    resp = client.post("/repositories", json={"remote_url": url})
    assert resp.status_code == 409


# ── Branch errors ──

def test_branches_nonexistent_repo(client):
    resp = client.get("/repositories/nonexistent/branches")
    assert resp.status_code == 404


def test_branch_diff_nonexistent_repo(client):
    resp = client.post(
        "/repositories/nonexistent/commits/branch-diff",
        json={"branch": "feature"},
    )
    assert resp.status_code == 404


# ── GitCommandError ──

def test_git_command_error_has_details():
    err = GitCommandError(["git", "pull"], 128, "fatal: not a git repo")
    assert "128" in str(err)
    assert "fatal" in str(err)
    assert err.code == 128
