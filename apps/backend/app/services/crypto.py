"""Symmetric encryption for at-rest secrets (e.g. YouTrack API token).

Key source precedence:
  1. PT_SECRET_KEY env var (urlsafe base64-encoded 32-byte Fernet key)
  2. File at {data_dir}/.secret_key — auto-generated on first use, 0600 perms
"""

import logging
import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

logger = logging.getLogger(__name__)

_KEY_FILENAME = ".secret_key"
_cached_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    env_key = os.environ.get("PT_SECRET_KEY", "").strip()
    if env_key:
        return env_key.encode()

    key_path: Path = settings.data_dir / _KEY_FILENAME
    if key_path.exists():
        return key_path.read_bytes().strip()

    key = Fernet.generate_key()
    key_path.write_bytes(key)
    try:
        os.chmod(key_path, stat.S_IRUSR | stat.S_IWUSR)  # 0o600
    except OSError:
        pass
    logger.info("Generated new secret key at %s (chmod 600)", key_path)
    return key


def _fernet() -> Fernet:
    global _cached_fernet
    if _cached_fernet is None:
        try:
            _cached_fernet = Fernet(_load_or_create_key())
        except ValueError as e:
            raise RuntimeError(
                "Invalid PT_SECRET_KEY — must be a urlsafe base64-encoded 32-byte key. "
                "Generate one with: python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'"
            ) from e
    return _cached_fernet


def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string, return a urlsafe base64 ciphertext string."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(ciphertext: str) -> str:
    """Decrypt a ciphertext produced by encrypt(). Raises ValueError if tampered or wrong key."""
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise ValueError("Failed to decrypt — ciphertext is invalid or secret key has changed") from e
