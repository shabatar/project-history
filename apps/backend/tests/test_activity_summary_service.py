"""Tests for pure functions in activity_summary_service.

No Ollama calls needed — all tested functions are deterministic/pure.
"""

import pytest

from app.services.activity_summary_service import (
    aggregate_by_issue,
    format_aggregated_line,
    chunk_list,
    compute_issue_budget,
    _MIN_CHUNK_ISSUES,
)
from app.schemas import ActivityItem


def _item(
    issue_id: str,
    activity_type: str,
    timestamp: int = 1_000_000,
    issue_summary: str = "",
    field: str | None = None,
    new_value: str | None = None,
    old_value: str | None = None,
) -> ActivityItem:
    return ActivityItem(
        issue_id=issue_id,
        issue_summary=issue_summary,
        activity_type=activity_type,
        timestamp=timestamp,
        author="user",
        field=field or "",
        new_value=new_value,
        old_value=old_value,
        comment_text=None,
    )



class TestAggregateByIssue:
    def test_aggregate_empty(self):
        result = aggregate_by_issue([])
        assert result == []

    def test_aggregate_single_created(self):
        items = [_item("PROJ-1", "created", timestamp=5_000_000)]
        result = aggregate_by_issue(items)
        assert len(result) == 1
        rec = result[0]
        assert rec["issue_id"] == "PROJ-1"
        assert rec["created_at"] == 5_000_000
        assert rec["comment_count"] == 0

    def test_aggregate_resolved(self):
        items = [
            _item("PROJ-1", "created", timestamp=1_000_000),
            _item("PROJ-1", "resolved", timestamp=2_000_000),
        ]
        result = aggregate_by_issue(items)
        assert len(result) == 1
        rec = result[0]
        assert rec["created_at"] == 1_000_000
        assert rec["resolved_at"] == 2_000_000

    def test_aggregate_state_trajectory(self):
        items = [
            _item("PROJ-1", "field_change", timestamp=1_000_000,
                  field="State", new_value="Open", old_value=None),
            _item("PROJ-1", "field_change", timestamp=2_000_000,
                  field="State", new_value="InProgress", old_value="Open"),
            _item("PROJ-1", "field_change", timestamp=3_000_000,
                  field="State", new_value="Done", old_value="InProgress"),
        ]
        result = aggregate_by_issue(items)
        assert result[0]["states"] == ["Open", "InProgress", "Done"]

    def test_aggregate_deduplicates_consecutive_states(self):
        items = [
            _item("PROJ-1", "field_change", timestamp=1_000_000,
                  field="State", new_value="Open"),
            _item("PROJ-1", "field_change", timestamp=2_000_000,
                  field="State", new_value="Open"),
            _item("PROJ-1", "field_change", timestamp=3_000_000,
                  field="State", new_value="Done"),
        ]
        result = aggregate_by_issue(items)
        assert result[0]["states"] == ["Open", "Done"]

    def test_aggregate_comment_count(self):
        items = [
            _item("PROJ-1", "comment", timestamp=1_000_000),
            _item("PROJ-1", "comment", timestamp=2_000_000),
            _item("PROJ-1", "comment", timestamp=3_000_000),
        ]
        result = aggregate_by_issue(items)
        assert result[0]["comment_count"] == 3

    def test_aggregate_multiple_issues(self):
        items = [
            _item("PROJ-1", "created", timestamp=1_000_000),
            _item("PROJ-2", "created", timestamp=2_000_000),
        ]
        result = aggregate_by_issue(items)
        assert len(result) == 2
        ids = {r["issue_id"] for r in result}
        assert ids == {"PROJ-1", "PROJ-2"}

    def test_aggregate_sorted_by_last_ts_desc(self):
        items = [
            _item("PROJ-A", "created", timestamp=1_000_000),
            _item("PROJ-B", "created", timestamp=3_000_000),
        ]
        result = aggregate_by_issue(items)
        assert result[0]["issue_id"] == "PROJ-B"
        assert result[1]["issue_id"] == "PROJ-A"

    def test_aggregate_uses_first_nonempty_summary(self):
        items = [
            _item("PROJ-1", "created", timestamp=1_000_000, issue_summary=""),
            _item("PROJ-1", "comment", timestamp=2_000_000, issue_summary="First non-empty"),
            _item("PROJ-1", "comment", timestamp=3_000_000, issue_summary="Second non-empty"),
        ]
        result = aggregate_by_issue(items)
        assert result[0]["summary"] == "First non-empty"



class TestFormatAggregatedLine:
    def _make_rec(self, **kwargs) -> dict:
        defaults = {
            "issue_id": "PROJ-123",
            "summary": "",
            "created_at": None,
            "resolved_at": None,
            "states": [],
            "assignees": [],
            "comment_count": 0,
            "last_ts": 1_000_000,
            "event_count": 1,
        }
        defaults.update(kwargs)
        return defaults

    def test_format_with_all_fields(self):
        rec = self._make_rec(
            issue_id="PROJ-123",
            summary="Fix login redirect",
            created_at=1740787200000,
            resolved_at=1741996800000,
            states=["Open", "In Progress", "Done"],
            comment_count=3,
        )
        line = format_aggregated_line(rec)
        assert "PROJ-123" in line
        assert "Fix login redirect" in line
        assert "created" in line
        assert "resolved" in line
        assert "Open→In Progress→Done" in line
        assert "3 comments" in line

    def test_format_no_flags(self):
        rec = self._make_rec(issue_id="PROJ-99", summary="Simple issue")
        line = format_aggregated_line(rec)
        assert "PROJ-99" in line
        assert "Simple issue" in line
        assert "|" not in line

    def test_format_truncates_long_summary(self):
        long_summary = "X" * 79 + "UNIQUE_TAIL_CHARS"
        rec = self._make_rec(issue_id="PROJ-1", summary=long_summary)
        line = format_aggregated_line(rec)
        assert long_summary[:80] in line
        assert "UNIQUE_TAIL_CHARS" not in line

    def test_format_comment_plural(self):
        rec1 = self._make_rec(issue_id="PROJ-1", comment_count=1)
        assert "1 comment" in format_aggregated_line(rec1)
        assert "1 comments" not in format_aggregated_line(rec1)

        rec3 = self._make_rec(issue_id="PROJ-2", comment_count=3)
        assert "3 comments" in format_aggregated_line(rec3)



class TestChunkList:
    def test_chunk_empty(self):
        assert chunk_list([], 5) == []

    def test_chunk_smaller_than_size(self):
        items = [1, 2, 3]
        result = chunk_list(items, 10)
        assert result == [[1, 2, 3]]

    def test_chunk_exact(self):
        items = list(range(6))
        result = chunk_list(items, 3)
        assert result == [[0, 1, 2], [3, 4, 5]]

    def test_chunk_remainder(self):
        items = list(range(7))
        result = chunk_list(items, 3)
        assert result == [[0, 1, 2], [3, 4, 5], [6]]

    def test_chunk_size_one(self):
        items = [1, 2, 3]
        result = chunk_list(items, 1)
        assert result == [[1], [2], [3]]

    def test_chunk_size_zero(self):
        items = [1, 2, 3]
        result = chunk_list(items, 0)
        assert result == [[1], [2], [3]]



class TestComputeIssueBudget:
    def test_budget_small_context(self):
        result = compute_issue_budget(4096)
        assert result == 65
        assert result >= _MIN_CHUNK_ISSUES

    def test_budget_large_context(self):
        result = compute_issue_budget(32768)
        assert result == 884
        assert result > _MIN_CHUNK_ISSUES

    def test_budget_minimum(self):
        result = compute_issue_budget(100)
        assert result == _MIN_CHUNK_ISSUES
