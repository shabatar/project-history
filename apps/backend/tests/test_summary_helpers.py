"""Test summary service helper functions: filtering, references, chunking."""

from unittest.mock import MagicMock

from app.services.summary_service import (
    filter_commits,
    extract_references,
    group_by_day,
    chunk_by_token_budget,
)
from datetime import datetime


def _commit(hash: str, subject: str, body: str = "", date: str = "2025-03-15T10:00:00"):
    c = MagicMock()
    c.commit_hash = hash + "0" * (40 - len(hash))
    c.subject = subject
    c.body = body
    c.author_name = "Dev"
    c.author_email = "dev@test.com"
    c.committed_at = datetime.fromisoformat(date)
    c.raw_text = ""
    return c


# ── filter_commits ──

def test_filter_keeps_real_commits():
    commits = [
        _commit("aaa", "Add authentication module"),
        _commit("bbb", "Fix login redirect bug"),
    ]
    kept, filtered = filter_commits(commits)
    assert len(kept) == 2
    assert filtered == 0


def test_filter_removes_merge_commits():
    commits = [
        _commit("aaa", "Merge branch main into feature"),
        _commit("bbb", "Merge pull request #42 from user/branch"),
        _commit("ccc", "Real commit"),
    ]
    kept, filtered = filter_commits(commits)
    assert len(kept) == 1
    assert kept[0].subject == "Real commit"
    assert filtered == 2


def test_filter_removes_typo_formatting_bot():
    commits = [
        _commit("a", "fix typo in README"),
        _commit("b", "formatting"),
        _commit("c", "ran prettier"),
        _commit("d", "Bump version to 1.2.3"),
        _commit("e", "chore(deps): bump lodash"),
        _commit("f", "[bot] auto-commit types"),
        _commit("g", "auto-commit generated"),
        _commit("h", "Actual feature work"),
    ]
    kept, filtered = filter_commits(commits)
    assert len(kept) == 1
    assert filtered == 7


def test_filter_empty_input():
    kept, filtered = filter_commits([])
    assert kept == []
    assert filtered == 0


# ── extract_references ──

def test_extract_github_issue_refs():
    commits = [
        _commit("aaa", "Fix login bug (#42)"),
        _commit("bbb", "Closes #42 — final"),
        _commit("ccc", "No refs here"),
    ]
    refs = extract_references(commits)
    assert "#42" in refs
    assert len(refs["#42"].commits) == 2
    assert "ccc" not in str(refs)


def test_extract_jira_refs():
    commits = [
        _commit("aaa", "Fix PROJ-123 timeout"),
        _commit("bbb", "Implements TASK-456", "Details about TASK-456"),
    ]
    refs = extract_references(commits)
    assert "PROJ-123" in refs
    assert "TASK-456" in refs


def test_extract_cross_repo_refs():
    commits = [_commit("aaa", "Update docs for frontend/ui#15")]
    refs = extract_references(commits)
    assert "frontend/ui#15" in refs


def test_extract_gh_normalized_to_hash():
    commits = [_commit("aaa", "See GH-99 for details")]
    refs = extract_references(commits)
    assert "#99" in refs
    assert "GH-99" not in refs


def test_extract_deduplicates_within_commit():
    commits = [_commit("aaa", "Fix #10", "Fixes #10 completely")]
    refs = extract_references(commits)
    assert "#10" in refs
    assert len(refs["#10"].commits) == 1


def test_extract_no_refs():
    commits = [_commit("aaa", "Simple commit")]
    refs = extract_references(commits)
    assert len(refs) == 0


# ── group_by_day ──

def test_group_by_day_basic():
    commits = [
        _commit("a", "First", date="2025-03-15T10:00:00"),
        _commit("b", "Second", date="2025-03-15T14:00:00"),
        _commit("c", "Third", date="2025-03-16T09:00:00"),
    ]
    groups = group_by_day(commits)
    assert len(groups) == 2
    assert groups[0][0] == "2025-03-15"
    assert len(groups[0][1]) == 2
    assert groups[1][0] == "2025-03-16"
    assert len(groups[1][1]) == 1


def test_group_by_day_empty():
    assert group_by_day([]) == []


def test_group_by_day_sorted_oldest_first():
    commits = [
        _commit("c", "Late", date="2025-03-20T10:00:00"),
        _commit("a", "Early", date="2025-03-10T10:00:00"),
    ]
    groups = group_by_day(commits)
    assert groups[0][0] == "2025-03-10"
    assert groups[1][0] == "2025-03-20"


# ── chunk_by_token_budget ──

def test_chunk_single_group_fits():
    groups = [("2025-03-15", [_commit("a", "Short")])]
    chunks = chunk_by_token_budget(groups, token_budget=5000)
    assert len(chunks) == 1
    assert len(chunks[0]) == 1


def test_chunk_splits_on_budget():
    # Create groups that are large enough to force splitting
    big_groups = [
        (f"2025-03-{10+i:02d}", [_commit(str(i), "x" * 200)])
        for i in range(10)
    ]
    chunks = chunk_by_token_budget(big_groups, token_budget=300)
    assert len(chunks) > 1


def test_chunk_never_splits_a_day():
    groups = [("2025-03-15", [_commit(str(i), "msg") for i in range(50)])]
    chunks = chunk_by_token_budget(groups, token_budget=100)
    # Even though the day exceeds budget, it stays as one chunk
    assert len(chunks) == 1
    assert len(chunks[0]) == 1
    assert len(chunks[0][0][1]) == 50


def test_chunk_empty_input():
    assert chunk_by_token_budget([], token_budget=1000) == []
