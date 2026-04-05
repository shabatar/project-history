"""Git service – subprocess-based interface to local git repositories.

Public interface:
    GitService(db).clone_repo(repo)
    GitService(db).update_repo(repo)
    GitService(db).load_commits(repo_id, start_date, end_date)
    GitService(db).get_commit_history(repo_id, start_date, end_date)
    add_repository(remote_url, db)          # convenience, used by router
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.models import CommitRecord, Repository
from app.repositories.commit_repository import CommitRepository
from app.repositories.repo_repository import RepoRepository

logger = logging.getLogger(__name__)

# ── Delimiters ──
# Using NUL-based record/field separators avoids collisions with any content
# that can appear in commit messages.  git's %x00 emits a literal NUL byte.
_RECORD_SEP = "%x00%x00RECORD%x00%x00"  # between commits
_FIELD_SEP = "%x00FIELD%x00"  # between fields inside one commit
_RECORD_SEP_RAW = "\x00\x00RECORD\x00\x00"
_FIELD_SEP_RAW = "\x00FIELD\x00"

# Fields: hash, author-name, author-email, author-date (ISO-strict), subject, body
_GIT_LOG_FORMAT = _FIELD_SEP.join(["%H", "%an", "%ae", "%aI", "%s", "%b"]) + _RECORD_SEP

# ── Low-level subprocess helper ──

_GIT_ENV_ALLOWLIST = {
    # Core system
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
    "TMPDIR", "TEMP", "TMP",
    # SSH credentials
    "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    # Git credential helpers
    "GIT_ASKPASS", "GIT_CREDENTIAL_HELPER",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    # macOS Keychain / 1Password
    "APPLE_CREDENTIAL_MANAGER",
    # GPG
    "GPG_AGENT_INFO", "GNUPGHOME",
}

def _git_env() -> dict[str, str]:
    """Build a minimal, safe environment for git subprocesses.

    Only whitelisted variables are passed through — prevents leaking
    secrets like AWS_SECRET_ACCESS_KEY, API tokens, etc. to git.
    """
    import os
    env: dict[str, str] = {}
    for key in _GIT_ENV_ALLOWLIST:
        val = os.environ.get(key)
        if val is not None:
            env[key] = val

    # SSH agent fallbacks for macOS/1Password
    if "SSH_AUTH_SOCK" not in env:
        for sock in [
            Path.home() / ".1password" / "agent.sock",
            Path("/tmp") / f"ssh-agent-{os.getuid()}",
        ]:
            if sock.exists():
                env["SSH_AUTH_SOCK"] = str(sock)
                break

    # Custom SSH key path
    from app.config import settings
    if settings.ssh_key_path:
        key_path = Path(settings.ssh_key_path).expanduser()
        if key_path.exists():
            env["GIT_SSH_COMMAND"] = f"ssh -i {key_path} -o StrictHostKeyChecking=accept-new"

    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_ATTR_NOSYSTEM"] = "1"
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env["GIT_CONFIG_COUNT"] = "3"
    env["GIT_CONFIG_KEY_0"] = "core.hooksPath"
    env["GIT_CONFIG_VALUE_0"] = "/dev/null"
    env["GIT_CONFIG_KEY_1"] = "core.symlinks"
    env["GIT_CONFIG_VALUE_1"] = "false"
    env["GIT_CONFIG_KEY_2"] = "protocol.file.allow"
    env["GIT_CONFIG_VALUE_2"] = "never"
    return env

async def _run_git(
    args: list[str],
    cwd: Path,
    *,
    check: bool = True,
) -> tuple[str, str, int]:
    """Run a read-only git command and return (stdout, stderr, returncode).

    Uses the user's native git credentials (SSH keys, credential helpers,
    keychain) via environment inheritance. Never writes credentials.
    """
    cmd = ["git"] + args
    logger.debug("Running: %s  (cwd=%s)", " ".join(_sanitize_cmd(cmd)), cwd)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=_git_env(),
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        proc.kill()
        raise GitCommandError(cmd, -1, "Git command timed out after 5 minutes")
    stdout = stdout_bytes.decode(errors="replace")
    stderr = stderr_bytes.decode(errors="replace")
    if check and proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, stderr)
    return stdout, stderr, proc.returncode

class GitCommandError(RuntimeError):
    """A git subprocess returned a non-zero exit code."""

    def __init__(self, cmd: list[str], code: int, stderr: str):
        self.cmd = _sanitize_cmd(cmd)
        self.code = code
        self.stderr = _sanitize_log(stderr)
        super().__init__(
            f"git command failed (exit {code}): {' '.join(self.cmd)}\n{self.stderr.strip()}"
        )

def _sanitize_log(text: str) -> str:
    """Remove credentials from log output."""
    # Strip credentials from URLs: https://user:token@host → https://***@host
    return re.sub(r"https://[^@]+@", "https://***@", text)

def _sanitize_cmd(cmd: list[str]) -> list[str]:
    """Remove credentials from command args for logging."""
    return [re.sub(r"https://[^@]+@", "https://***@", arg) for arg in cmd]

# ── URL validation ──

_SAFE_URL_RE = re.compile(
    r"^(https?://[\w.\-]+/|git@[\w.\-]+:|local://)"
)

def validate_remote_url(url: str) -> None:
    """Reject URLs that could be dangerous (local paths, file://, etc.)."""
    if not _SAFE_URL_RE.match(url):
        raise ValueError(
            f"Unsupported URL scheme: {url!r}. "
            "Use HTTPS (https://...) or SSH (git@host:...) URLs only."
        )

# ── Helpers ──

_SAFE_BRANCH_RE = re.compile(r"^[\w.\-/]+$")

def validate_branch_name(name: str) -> None:
    """Reject branch names containing unsafe characters.

    Only alphanumeric characters, hyphens, underscores, forward slashes,
    and dots are allowed.  This prevents shell-injection via crafted
    branch names passed to git subprocess commands.
    """
    if not name or not _SAFE_BRANCH_RE.match(name):
        raise ValueError(
            f"Invalid branch name: {name!r}. "
            "Only alphanumeric characters, '-', '_', '/', and '.' are allowed."
        )

def _repo_name_from_url(url: str) -> str:
    name = url.rstrip("/").rsplit("/", 1)[-1]
    name = re.sub(r"\.git$", "", name)
    # Sanitize: only alphanumeric, dash, underscore, dot — prevent path traversal
    name = re.sub(r"[^\w.\-]", "_", name)
    if not name or name.startswith("."):
        name = "repo"
    return name

def _resolve_end_date(end_date: str | date | None) -> str:
    """Return an ISO date string.  ``None`` means 'today'."""
    if end_date is None:
        return date.today().isoformat()
    if isinstance(end_date, date):
        return end_date.isoformat()
    return end_date

def _resolve_start_date(start_date: str | date | None) -> str | None:
    if start_date is None:
        return None
    if isinstance(start_date, date):
        return start_date.isoformat()
    return start_date

def _parse_raw_commits(raw_output: str) -> list[dict]:
    """Split git-log output into a list of field dicts."""
    entries: list[dict] = []
    for chunk in raw_output.split(_RECORD_SEP_RAW):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split(_FIELD_SEP_RAW)
        if len(parts) < 5:
            logger.warning("Skipping malformed commit chunk (%d fields)", len(parts))
            continue
        entries.append(
            {
                "commit_hash": parts[0].strip(),
                "author_name": parts[1].strip(),
                "author_email": parts[2].strip(),
                "date_iso": parts[3].strip(),
                "subject": parts[4].strip(),
                "body": parts[5].strip() if len(parts) > 5 else "",
                "raw_text": chunk,
            }
        )
    return entries

# ── Service class ──

class GitService:
    """High-level git operations backed by subprocess calls."""

    def __init__(self, db: Session):
        self._db = db
        self._repo_repo = RepoRepository(db)
        self._commit_repo = CommitRepository(db)

    # ── clone_repo ──

    async def clone_repo(self, repo: Repository) -> Repository:
        """Clone a remote repository into the local repos dir.

        If the directory already exists, fetches all remotes instead.
        Detects the default branch after cloning.
        Uses the system's git credentials (SSH agent, credential helpers,
        keychain) via environment inheritance — no write operations.
        """
        path = Path(repo.local_path).resolve()
        repos_root = settings.repos_dir.resolve()
        if not str(path).startswith(str(repos_root)):
            raise ValueError(f"Clone path {path} is outside repos directory")

        if path.exists():
            logger.info("Directory exists for %s – fetching instead of cloning", repo.name)
            await _run_git(["fetch", "--all", "--prune"], cwd=path)
        else:
            logger.info("Cloning %s", repo.name)
            path.parent.mkdir(parents=True, exist_ok=True)
            await _run_git(
                ["clone", "--no-recurse-submodules", "--", repo.remote_url, str(path)],
                cwd=path.parent,
            )

        branch = await self._detect_default_branch(path)
        if branch:
            self._repo_repo.update(repo, default_branch=branch)

        return self._repo_repo.mark_synced(repo)

    # ── update_repo ──

    async def update_repo(self, repo: Repository) -> Repository:
        """Fetch the latest changes for an already-cloned repository.

        Read-only: fetches from remote and fast-forward merges.
        Uses the system's git credentials via environment inheritance.
        """
        path = Path(repo.local_path)
        if not path.exists():
            raise GitCommandError(
                ["pull"], 1, f"Local path does not exist: {path}"
            )

        logger.info("Updating %s", repo.name)

        await _run_git(["fetch", "--all", "--prune"], cwd=path)

        branch = await self._detect_default_branch(path)
        if branch:
            await _run_git(
                ["merge", "--ff-only", f"origin/{branch}"],
                cwd=path,
            )
            self._repo_repo.update(repo, default_branch=branch)

        return self._repo_repo.mark_synced(repo)

    # ── shared commit storage ──

    def _store_parsed_commits(
        self,
        repo_id: str,
        parsed: list[dict],
        label: str,
    ) -> list[CommitRecord]:
        """Deduplicate and store parsed commit entries. Returns new records only."""
        existing_hashes = self._commit_repo.existing_hashes(repo_id)
        new_records: list[CommitRecord] = []

        for entry in parsed:
            if entry["commit_hash"] in existing_hashes:
                continue
            try:
                committed_at = datetime.fromisoformat(entry["date_iso"])
            except ValueError:
                logger.warning(
                    "Skipping commit %s: unparseable date %r",
                    entry["commit_hash"][:8],
                    entry["date_iso"],
                )
                continue

            new_records.append(CommitRecord(
                repository_id=repo_id,
                commit_hash=entry["commit_hash"],
                author_name=entry["author_name"],
                author_email=entry["author_email"],
                committed_at=committed_at,
                subject=entry["subject"],
                body=entry["body"],
                raw_text=entry["raw_text"],
            ))
            existing_hashes.add(entry["commit_hash"])

        if new_records:
            self._commit_repo.bulk_add(new_records)

        logger.info(
            "%s: %d new commits (%d already existed)",
            label, len(new_records), len(parsed) - len(new_records),
        )
        return new_records

    def _get_repo_and_path(self, repo_id: str) -> tuple[Repository, Path]:
        """Validate repo exists and local path is present."""
        repo = self._repo_repo.get_by_id(repo_id)
        if repo is None:
            raise ValueError(f"Repository {repo_id} not found")
        path = Path(repo.local_path)
        if not path.exists():
            raise GitCommandError(
                ["log"], 1, f"Local path does not exist: {path}"
            )
        return repo, path

    # ── load_commits ──

    async def load_commits(
        self,
        repo_id: str,
        start_date: str | date | None = None,
        end_date: str | date | None = None,
    ) -> list[CommitRecord]:
        """Parse commits from the git log and store new ones in the database.

        Idempotent: commits already present (by repository_id + commit_hash)
        are silently skipped.  ``end_date=None`` is treated as *today*.
        """
        repo, path = self._get_repo_and_path(repo_id)

        since = _resolve_start_date(start_date)
        until = _resolve_end_date(end_date)

        cmd = ["log", f"--pretty=format:{_GIT_LOG_FORMAT}", "--date-order"]
        if since:
            cmd.append(f"--since={since}")
        cmd.append(f"--until={until}")

        stdout, _, _ = await _run_git(cmd, cwd=path)
        if not stdout.strip():
            logger.info("No commits found in range for %s", repo.name)
            return []

        parsed = _parse_raw_commits(stdout)
        return self._store_parsed_commits(repo_id, parsed, f"load_commits({repo.name})")

    # ── get_commit_history ──

    def get_commit_history(
        self,
        repo_id: str,
        start_date: str | date | None = None,
        end_date: str | date | None = None,
        limit: int = 200,
    ) -> list[CommitRecord]:
        """Return already-loaded commits from the database for the given range.

        ``end_date=None`` is treated as *today*.
        """
        since = _resolve_start_date(start_date)
        until = _resolve_end_date(end_date)
        return self._commit_repo.list_by_repo(
            repo_id,
            since=since,
            until=until,
            limit=limit,
        )

    # ── list_branches ──

    async def list_branches(self, repo_id: str) -> list[dict]:
        """List local and remote branches for a repository."""
        repo = self._repo_repo.get_by_id(repo_id)
        if repo is None:
            raise ValueError(f"Repository {repo_id} not found")
        path = Path(repo.local_path)
        if not path.exists():
            raise GitCommandError(["branch"], 1, f"Local path does not exist: {path}")

        stdout, _, _ = await _run_git(
            ["branch", "-a", "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:iso-strict)"],
            cwd=path,
        )
        branches: list[dict] = []
        for line in stdout.strip().splitlines():
            parts = line.split("\t")
            if len(parts) < 1 or not parts[0].strip():
                continue
            name = parts[0].strip()
            # Skip HEAD pointer and bare remote name
            if name in ("origin/HEAD", "origin") or not name:
                continue
            is_remote = name.startswith("origin/")
            display_name = name.removeprefix("origin/") if is_remote else name
            branches.append({
                "name": display_name,
                "short_hash": parts[1].strip() if len(parts) > 1 else "",
                "last_commit_date": parts[2].strip() if len(parts) > 2 else "",
                "is_remote": is_remote,
            })

        # Deduplicate: if a local and remote branch have the same name, keep one
        seen: dict[str, dict] = {}
        for b in branches:
            existing = seen.get(b["name"])
            if existing is None or b["is_remote"]:
                seen[b["name"]] = b
        return sorted(seen.values(), key=lambda b: b["name"])

    # ── load_branch_diff_commits ──

    async def load_branch_diff_commits(
        self,
        repo_id: str,
        branch: str,
        base_branch: str | None = None,
    ) -> list[CommitRecord]:
        """Parse commits in *branch* not in *base_branch* (``git log base..branch``)."""
        repo, path = self._get_repo_and_path(repo_id)

        validate_branch_name(branch)
        base = base_branch or repo.default_branch or "main"
        validate_branch_name(base)
        range_spec = f"origin/{base}..origin/{branch}"
        logger.info("Loading branch diff: %s for %s", range_spec, repo.name)

        cmd = ["log", f"--pretty=format:{_GIT_LOG_FORMAT}", "--date-order", range_spec]
        stdout, _, _ = await _run_git(cmd, cwd=path)
        if not stdout.strip():
            logger.info("No diff commits found for %s", range_spec)
            return []

        parsed = _parse_raw_commits(stdout)
        self._store_parsed_commits(repo_id, parsed, f"branch_diff({range_spec})")

        # Return ALL commits in the range (including previously stored ones)
        all_hashes = {entry["commit_hash"] for entry in parsed}
        return self._commit_repo.list_by_hashes(repo_id, all_hashes)

    # ── private helpers ──

    async def _detect_default_branch(self, path: Path) -> str | None:
        """Try to detect the default branch name.

        Strategy:
          1. Check the symbolic-ref of origin/HEAD (set after clone).
          2. Fall back to the currently checked-out branch.
        """
        # Try origin/HEAD first – most reliable after a fresh clone.
        stdout, _, rc = await _run_git(
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            cwd=path,
            check=False,
        )
        if rc == 0 and stdout.strip():
            # Output looks like "refs/remotes/origin/main"
            return stdout.strip().rsplit("/", 1)[-1]

        # Fallback: current HEAD branch
        stdout, _, rc = await _run_git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd=path,
            check=False,
        )
        if rc == 0 and stdout.strip() and stdout.strip() != "HEAD":
            return stdout.strip()

        return None

# ── Module-level convenience (used by routers for add) ──

_MAX_REPOS = 50

def add_repository(remote_url: str, db: Session) -> Repository:
    validate_remote_url(remote_url)
    repo_repo = RepoRepository(db)
    if len(repo_repo.list_active()) >= _MAX_REPOS:
        raise ValueError(f"Maximum of {_MAX_REPOS} repositories reached")
    name = _repo_name_from_url(remote_url)
    local_path = (settings.repos_dir / name).resolve()
    # Ensure path stays within repos_dir (prevent path traversal)
    if not str(local_path).startswith(str(settings.repos_dir.resolve())):
        raise ValueError("Repository name resolves outside repos directory")
    return RepoRepository(db).create(name, remote_url, str(local_path))

async def add_local_repository(local_path: str, db: Session) -> Repository:
    """Register an existing local git repository.

    Validates:
      1. Path exists and is a directory
      2. Path contains a .git directory (is a git repo)
      3. Reads remote URL from git config
      4. Detects default branch
      5. Checks for duplicate remote URL
    """
    path = Path(local_path).resolve()

    if not path.is_dir():
        raise ValueError(f"Path does not exist or is not a directory: {path}")

    git_dir = path / ".git"
    if not git_dir.is_dir():
        raise ValueError(f"Not a git repository (no .git directory): {path}")

    # Read remote URL
    stdout, _, rc = await _run_git(
        ["config", "--get", "remote.origin.url"],
        cwd=path,
        check=False,
    )
    remote_url = stdout.strip() if rc == 0 else ""
    if not remote_url:
        remote_url = f"local://{path}"

    # Check duplicate
    repo_repo = RepoRepository(db)
    existing = repo_repo.get_by_url(remote_url)
    if existing:
        raise ValueError(f"Repository with URL '{remote_url}' already exists")

    # Also check duplicate by path
    existing_by_path = (
        db.query(Repository)
        .filter(Repository.local_path == str(path))
        .first()
    )
    if existing_by_path:
        raise ValueError(f"Repository at path '{path}' already tracked")

    # Detect branch
    stdout, _, rc = await _run_git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd=path,
        check=False,
    )
    branch = stdout.strip() if rc == 0 and stdout.strip() != "HEAD" else "main"

    # Infer name from directory
    name = path.name

    repo = repo_repo.create(name, remote_url, str(path))
    repo_repo.update(repo, default_branch=branch)
    repo = repo_repo.mark_synced(repo)

    logger.info("Added local repository: %s (branch=%s)", name, branch)
    return repo
