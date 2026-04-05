"""Test repository CRUD and duplicate prevention."""


def test_create_repository(client):
    resp = client.post("/repositories", json={"remote_url": "https://github.com/user/repo.git"})
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "repo"
    assert data["remote_url"] == "https://github.com/user/repo.git"
    assert data["is_active"] is True
    assert data["last_synced_at"] is None
    assert data["commit_count"] == 0


def test_duplicate_url_rejected(client):
    url = "https://github.com/user/dup.git"
    resp1 = client.post("/repositories", json={"remote_url": url})
    assert resp1.status_code == 201

    resp2 = client.post("/repositories", json={"remote_url": url})
    assert resp2.status_code == 409
    assert "already exists" in resp2.json()["detail"]


def test_list_repositories(client):
    client.post("/repositories", json={"remote_url": "https://github.com/a/one.git"})
    client.post("/repositories", json={"remote_url": "https://github.com/a/two.git"})

    resp = client.get("/repositories")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_get_repository(client):
    create = client.post("/repositories", json={"remote_url": "https://github.com/a/r.git"})
    repo_id = create.json()["id"]

    resp = client.get(f"/repositories/{repo_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == repo_id


def test_get_nonexistent_404(client):
    resp = client.get("/repositories/nonexistent")
    assert resp.status_code == 404


def test_update_repository(client):
    create = client.post("/repositories", json={"remote_url": "https://github.com/a/upd.git"})
    repo_id = create.json()["id"]

    resp = client.patch(f"/repositories/{repo_id}", json={"default_branch": "develop"})
    assert resp.status_code == 200
    assert resp.json()["default_branch"] == "develop"


def test_delete_repository(client):
    create = client.post("/repositories", json={"remote_url": "https://github.com/a/del.git"})
    repo_id = create.json()["id"]

    resp = client.delete(f"/repositories/{repo_id}")
    assert resp.status_code == 204

    resp = client.get(f"/repositories/{repo_id}")
    assert resp.status_code == 404


def test_local_repo_without_clone(client):
    """A repo added without cloning should be listed with last_synced_at=null."""
    resp = client.post("/repositories", json={"remote_url": "https://github.com/a/local.git"})
    data = resp.json()
    assert data["last_synced_at"] is None
    assert data["last_sync_error"] is None

    listed = client.get("/repositories").json()
    assert len(listed) == 1
    assert listed[0]["last_synced_at"] is None
