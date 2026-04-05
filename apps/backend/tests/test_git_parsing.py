"""Test git log parsing and commit deduplication with mocked subprocess."""

import pytest
from datetime import datetime
from unittest.mock import patch, AsyncMock

from app.models import CommitRecord, Repository
from app.services.git_service import GitService, _parse_raw_commits

# ── Raw format constants (must match the service) ──
_RECORD_SEP = "\x00\x00RECORD\x00\x00"
_FIELD_SEP = "\x00FIELD\x00"


def _fake_git_log(*commits: tuple) -> str:
    """Build a fake git-log output string from (hash, name, email, date, subject, body) tuples."""
    chunks = []
    for h, name, email, date, subject, body in commits:
        chunks.append(_FIELD_SEP.join([h, name, email, date, subject, body]))
    return _RECORD_SEP.join(chunks) + _RECORD_SEP


# ── Unit tests for _parse_raw_commits ──


def test_parse_single_commit():
    raw = _fake_git_log(
        ("abc1234" * 6, "Alice", "alice@dev.com", "2025-03-15T10:00:00+00:00", "Add feature", "Some body text"),
    )
    result = _parse_raw_commits(raw)
    assert len(result) == 1
    assert result[0]["commit_hash"].startswith("abc1234")
    assert result[0]["author_name"] == "Alice"
    assert result[0]["subject"] == "Add feature"
    assert result[0]["body"] == "Some body text"


def test_parse_multiple_commits():
    raw = _fake_git_log(
        ("aaa0001" + "0" * 33, "Alice", "a@d.com", "2025-03-15T10:00:00+00:00", "First", ""),
        ("bbb0002" + "0" * 33, "Bob", "b@d.com", "2025-03-16T11:00:00+00:00", "Second", "body2"),
        ("ccc0003" + "0" * 33, "Carol", "c@d.com", "2025-03-17T12:00:00+00:00", "Third", ""),
    )
    result = _parse_raw_commits(raw)
    assert len(result) == 3
    assert [r["author_name"] for r in result] == ["Alice", "Bob", "Carol"]


def test_parse_empty_output():
    assert _parse_raw_commits("") == []
    assert _parse_raw_commits("   ") == []


def test_parse_malformed_skipped():
    """A chunk with too few fields should be silently skipped."""
    raw = _FIELD_SEP.join(["hash", "name"]) + _RECORD_SEP  # only 2 fields
    result = _parse_raw_commits(raw)
    assert len(result) == 0


# ── Integration tests for load_commits (mocked subprocess) ──


def _seed_repo(db) -> Repository:
    repo = Repository(
        id="testrepo1",
        name="test-repo",
        remote_url="https://github.com/test/repo.git",
        local_path="/tmp/fake-repo",
        default_branch="main",
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


@pytest.mark.asyncio
async def test_load_commits_stores_records(db):
    repo = _seed_repo(db)
    fake_output = _fake_git_log(
        ("a" * 40, "Alice", "alice@test.com", "2025-03-15T10:00:00+00:00", "Init commit", ""),
        ("b" * 40, "Bob", "bob@test.com", "2025-03-16T11:00:00+00:00", "Add docs", "Added README"),
    )

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        mock_git.return_value = (fake_output, "", 0)
        with patch("pathlib.Path.exists", return_value=True):
            svc = GitService(db)
            records = await svc.load_commits(repo.id, "2025-03-01", "2025-03-31")

    assert len(records) == 2
    assert records[0].author_name == "Alice"
    assert records[1].subject == "Add docs"
    assert records[1].body == "Added README"

    # Verify persisted in DB
    stored = db.query(CommitRecord).filter(CommitRecord.repository_id == repo.id).all()
    assert len(stored) == 2


@pytest.mark.asyncio
async def test_load_commits_deduplication(db):
    """Running load_commits twice with the same output should not create duplicates."""
    repo = _seed_repo(db)
    fake_output = _fake_git_log(
        ("d" * 40, "Dev", "dev@test.com", "2025-03-18T09:00:00+00:00", "Feature X", ""),
    )

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        mock_git.return_value = (fake_output, "", 0)
        with patch("pathlib.Path.exists", return_value=True):
            svc = GitService(db)
            first = await svc.load_commits(repo.id)
            second = await svc.load_commits(repo.id)

    assert len(first) == 1
    assert len(second) == 0  # no new records

    total = db.query(CommitRecord).filter(CommitRecord.repository_id == repo.id).count()
    assert total == 1


@pytest.mark.asyncio
async def test_load_commits_empty_range(db):
    repo = _seed_repo(db)

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        mock_git.return_value = ("", "", 0)
        with patch("pathlib.Path.exists", return_value=True):
            svc = GitService(db)
            records = await svc.load_commits(repo.id, "2099-01-01", "2099-01-02")

    assert len(records) == 0
