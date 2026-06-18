"""Shared fixtures — in-memory SQLite DB and FastAPI test client."""

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models
from app.database import Base, get_db
from app.main import app

_test_engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)

@event.listens_for(_test_engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


_TestSession = sessionmaker(bind=_test_engine, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def db(monkeypatch):
    """Create fresh tables for every test, yield a session, then drop.

    Background summary jobs open their own session via ``database.SessionLocal``
    and normally run on the event loop; point that at the in-memory test engine
    and run them inline so endpoint responses are deterministic in tests.
    """
    import app.database as database
    from app.services import job_manager

    monkeypatch.setattr(database, "SessionLocal", _TestSession)
    monkeypatch.setattr(job_manager, "run_inline", True)

    Base.metadata.create_all(bind=_test_engine)
    session = _TestSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=_test_engine)


@pytest.fixture()
def client(db):
    """FastAPI TestClient wired to the in-memory DB.

    We skip the app lifespan to avoid init_db() hitting the production engine.
    """

    def _override():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = _override

    from starlette.testclient import TestClient

    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
    app.dependency_overrides.clear()
