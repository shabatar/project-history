from datetime import datetime

import re

from pydantic import BaseModel, field_validator

# ── Repository ──

class RepositoryCreate(BaseModel):
    remote_url: str

class RepositoryCreateFromLocal(BaseModel):
    local_path: str

class RepositoryRead(BaseModel):
    id: str
    name: str
    remote_url: str
    default_branch: str
    last_synced_at: datetime | None
    is_active: bool
    commit_count: int = 0

    model_config = {"from_attributes": True}

class BulkActionResult(BaseModel):
    total: int
    succeeded: int
    failed: int
    results: list[RepositoryRead]

class RepositoryUpdate(BaseModel):
    is_active: bool | None = None
    default_branch: str | None = None

    @field_validator("default_branch")
    @classmethod
    def validate_branch(cls, v: str | None) -> str | None:
        if v is not None:
            _check_branch_name(v)
        return v

# ── Commit ──

class CommitRead(BaseModel):
    id: str
    repository_id: str
    commit_hash: str
    author_name: str
    author_email: str
    committed_at: datetime
    subject: str
    body: str

    model_config = {"from_attributes": True}

class ParseCommitsRequest(BaseModel):
    since: str | None = None
    until: str | None = None

_SAFE_BRANCH_RE = re.compile(r"^[\w.\-/]+$")

def _check_branch_name(v: str) -> str:
    if not _SAFE_BRANCH_RE.match(v):
        raise ValueError(
            "Branch name contains unsafe characters. "
            "Only alphanumeric characters, '-', '_', '/', and '.' are allowed."
        )
    return v

class BranchDiffRequest(BaseModel):
    branch: str
    base_branch: str | None = None  # defaults to repo's default_branch

    @field_validator("branch", "base_branch")
    @classmethod
    def validate_branch(cls, v: str | None) -> str | None:
        if v is not None:
            _check_branch_name(v)
        return v

class BranchInfo(BaseModel):
    name: str
    short_hash: str
    last_commit_date: str
    is_remote: bool

# ── Summary ──

class SummaryJobCreate(BaseModel):
    repository_id: str
    start_date: str | None = None  # optional for branch-diff mode
    end_date: str | None = None    # optional for branch-diff mode
    branch: str | None = None      # if set, summarize branch diff
    base_branch: str | None = None # compare against (default: repo default branch)
    model_name: str | None = None
    summary_style: str | None = None  # "short" | "detailed" | "manager"

    @field_validator("branch", "base_branch")
    @classmethod
    def validate_branch(cls, v: str | None) -> str | None:
        if v is not None:
            _check_branch_name(v)
        return v

class SummaryJobRead(BaseModel):
    id: str
    repository_id: str
    start_date: datetime | None
    end_date: datetime | None
    branch: str | None = None
    base_branch: str | None = None
    model_name: str
    summary_style: str
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}

class SummaryResultRead(BaseModel):
    id: str
    summary_job_id: str
    summary_markdown: str
    commit_count: int
    generated_at: datetime

    model_config = {"from_attributes": True}

class SummaryJobWithResult(SummaryJobRead):
    result: SummaryResultRead | None = None

# ── Ollama ──

class OllamaModelPullRequest(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_model_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Model name is required")
        if not re.match(r"^[a-zA-Z0-9._:/-]+$", v):
            raise ValueError(
                "Model name contains invalid characters. "
                "Only alphanumeric characters, dots, colons, hyphens, slashes, and underscores are allowed."
            )
        if len(v) > 200:
            raise ValueError("Model name is too long (max 200 characters)")
        return v

class OllamaModel(BaseModel):
    name: str
    size: int | None = None
    modified_at: str | None = None

# ── YouTrack ──

def _validate_base_url(v: str) -> str:
    v = v.strip().rstrip("/")
    if not re.match(r"^https?://[\w.\-]+(:\d+)?(/[\w.\-/]*)?$", v):
        raise ValueError(
            "Invalid YouTrack base URL. Must be an HTTP(S) URL "
            "(e.g. https://youtrack.example.com)."
        )
    return v


def _validate_token(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > 500:
        raise ValueError("Token is unexpectedly long (max 500 chars).")
    if any(c in v for c in "\r\n\t"):
        raise ValueError("Token must not contain whitespace characters.")
    return v


class YouTrackConfigCreate(BaseModel):
    base_url: str
    # Optional: write-only. When present, stored encrypted at rest.
    # Never returned in any response. Send null/omit to leave the stored token unchanged.
    api_token: str | None = None

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str) -> str:
        return _validate_base_url(v)

    @field_validator("api_token")
    @classmethod
    def validate_api_token(cls, v: str | None) -> str | None:
        return _validate_token(v)


class YouTrackConfigRead(BaseModel):
    """Token is never returned. Consumers get only status flags."""
    id: str
    base_url: str
    created_at: datetime
    token_configured: bool = False
    token_source: str | None = None  # "env" | "db" | None

    model_config = {"from_attributes": True}


class YouTrackTestRequest(BaseModel):
    """Test a token (and optional base URL) without persisting either."""
    base_url: str | None = None
    api_token: str | None = None

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str | None) -> str | None:
        return _validate_base_url(v) if v else None

    @field_validator("api_token")
    @classmethod
    def validate_api_token(cls, v: str | None) -> str | None:
        return _validate_token(v)


class YouTrackTestResponse(BaseModel):
    ok: bool
    detail: str | None = None
    username: str | None = None

class YouTrackBoardAdd(BaseModel):
    board_url: str  # e.g. https://youtrack.example.com/agiles/123-45/current

    @field_validator("board_url")
    @classmethod
    def validate_board_url(cls, v: str) -> str:
        v = v.strip()
        if not re.match(r"^https?://[\w.\-]+(:\d+)?/", v):
            raise ValueError(
                "Invalid board URL. Must be an HTTP(S) URL "
                "(e.g. https://youtrack.example.com/agiles/123-45/current)."
            )
        return v

class YouTrackBoardRead(BaseModel):
    id: str
    config_id: str
    board_id: str
    board_name: str
    board_url: str
    last_synced_at: datetime | None

    model_config = {"from_attributes": True}

class YouTrackIssueRead(BaseModel):
    id: str
    board_id: str
    issue_id: str
    summary: str
    state: str
    assignee: str | None
    updated_at: datetime | None
    synced_at: datetime

    model_config = {"from_attributes": True}

class IssueChange(BaseModel):
    issue_id: str
    summary: str
    change_type: str  # "added" | "removed" | "updated"
    old_state: str | None = None
    new_state: str | None = None
    old_assignee: str | None = None
    new_assignee: str | None = None

class BoardSyncRequest(BaseModel):
    """Optional body for sync endpoints. Without `since`, compares against the latest snapshot."""
    since: str | None = None  # YYYY-MM-DD — end-of-day UTC is used

    @field_validator("since")
    @classmethod
    def validate_since(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("since must be YYYY-MM-DD")
        return v


class BoardSyncResult(BaseModel):
    board_id: str
    board_name: str
    total_issues: int
    changes: list[IssueChange]
    baseline_synced_at: datetime | None = None
    since: str | None = None

class ActivityItem(BaseModel):
    timestamp: int  # epoch ms
    issue_id: str
    issue_summary: str
    author: str  # display name, falls back to login
    author_login: str | None = None  # used to build a /users/<login> link
    activity_type: str  # "created" | "resolved" | "comment" | "field_change"
    field: str  # field name for field_change
    old_value: str | None = None
    new_value: str | None = None
    comment_text: str | None = None

class ActivityRequest(BaseModel):
    since: str  # YYYY-MM-DD
    until: str  # YYYY-MM-DD

class BoardActivityResponse(BaseModel):
    board_id: str
    board_name: str
    since: str
    until: str
    activities: list[ActivityItem]


class ActivitySummaryRequest(BaseModel):
    since: str  # YYYY-MM-DD
    until: str  # YYYY-MM-DD
    summary_style: str | None = None  # "short" | "detailed" | "manager"
    model_name: str | None = None

    @field_validator("summary_style")
    @classmethod
    def validate_style(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if v not in ("short", "detailed", "manager"):
            raise ValueError("summary_style must be one of: short, detailed, manager")
        return v


class ActivitySummaryResponse(BaseModel):
    board_id: str
    board_name: str
    since: str
    until: str
    summary_style: str
    model_name: str
    activity_count: int
    summary_markdown: str
    used_llm: bool  # False = deterministic fallback because Ollama was unreachable
    generated_at: datetime


class YouTrackProjectRead(BaseModel):
    id: str
    short_name: str
    name: str
    description: str = ""
    archived: bool = False


class ProjectActivityResponse(BaseModel):
    project_short_name: str
    project_name: str
    since: str
    until: str
    activities: list[ActivityItem]


class ActivitySummaryRead(BaseModel):
    id: str
    source_type: str
    source_id: str
    source_name: str
    since: str
    until: str
    summary_style: str
    model_name: str
    activity_count: int
    summary_markdown: str
    used_llm: bool
    generated_at: datetime

    model_config = {"from_attributes": True}


class ProjectActivitySummaryResponse(BaseModel):
    project_short_name: str
    project_name: str
    since: str
    until: str
    summary_style: str
    model_name: str
    activity_count: int
    summary_markdown: str
    used_llm: bool
    generated_at: datetime

