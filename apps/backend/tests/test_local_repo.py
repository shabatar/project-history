"""Test adding local git repositories."""

import pytest
from unittest.mock import patch, AsyncMock


def test_local_repo_nonexistent_path(client):
    resp = client.post("/repositories/local", json={"local_path": "/does/not/exist"})
    assert resp.status_code == 422
    assert "does not exist" in resp.json()["detail"]


def test_local_repo_not_git_dir(client, tmp_path):
    """A directory without .git should be rejected."""
    plain_dir = tmp_path / "not-a-repo"
    plain_dir.mkdir()
    resp = client.post("/repositories/local", json={"local_path": str(plain_dir)})
    assert resp.status_code == 422
    assert "Not a git repository" in resp.json()["detail"]


def test_local_repo_valid_git_dir(client, tmp_path):
    """A directory with .git and no remote should be accepted with local:// URL."""
    repo_dir = tmp_path / "my-repo"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        # First call: remote.origin.url → no remote
        # Second call: rev-parse --abbrev-ref HEAD → main
        mock_git.side_effect = [
            ("", "", 1),       # no remote URL
            ("main\n", "", 0), # branch detection
        ]
        resp = client.post("/repositories/local", json={"local_path": str(repo_dir)})

    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "my-repo"
    assert data["default_branch"] == "main"
    assert data["last_synced_at"] is not None
    assert data["remote_url"].startswith("local://")
    assert str(repo_dir) in data["local_path"]


def test_local_repo_with_remote(client, tmp_path):
    """A local repo with a remote URL should use it."""
    repo_dir = tmp_path / "has-remote"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        mock_git.side_effect = [
            ("https://github.com/user/has-remote.git\n", "", 0),  # remote URL
            ("develop\n", "", 0),                                  # branch
        ]
        resp = client.post("/repositories/local", json={"local_path": str(repo_dir)})

    assert resp.status_code == 201
    data = resp.json()
    assert data["remote_url"] == "https://github.com/user/has-remote.git"
    assert data["default_branch"] == "develop"


def test_local_repo_duplicate_path(client, tmp_path):
    """Adding the same path twice should fail."""
    repo_dir = tmp_path / "dup-repo"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        mock_git.side_effect = [("", "", 1), ("main\n", "", 0)]
        resp1 = client.post("/repositories/local", json={"local_path": str(repo_dir)})
        assert resp1.status_code == 201

    with patch("app.services.git_service._run_git", new_callable=AsyncMock) as mock_git:
        mock_git.side_effect = [("", "", 1), ("main\n", "", 0)]
        resp2 = client.post("/repositories/local", json={"local_path": str(repo_dir)})
        assert resp2.status_code == 422
        assert "already" in resp2.json()["detail"]
