import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Optional

from fastapi import Cookie, HTTPException, status

from app.core.config import (
    MAX_ADMIN_PASSWORD_CHARS,
    MIN_ADMIN_PASSWORD_CHARS,
    settings,
)


COOKIE_NAME = "portfolio_admin_session"
MAX_SESSION_TOKEN_CHARS = 1024
MAX_SESSION_PAYLOAD_CHARS = 512
ENCODED_SIGNATURE_CHARS = 43


def require_admin_enabled() -> None:
    if not settings.ADMIN_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin authentication is disabled",
        )


def _secret() -> bytes:
    require_admin_enabled()
    if not settings.APP_SECRET_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin authentication is not configured",
        )
    return settings.APP_SECRET_KEY.encode("utf-8")


def _verify_argon2id(encoded_hash: str, password: str) -> bool:
    try:
        from argon2 import PasswordHasher
        from argon2.exceptions import VerificationError
        from argon2.low_level import Type
    except ImportError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Argon2id password verification is unavailable",
        ) from error

    try:
        return PasswordHasher(type=Type.ID).verify(encoded_hash, password)
    except VerificationError:
        return False


def hash_admin_password(password: str) -> str:
    """Generate an encoded Argon2id hash for administrator configuration."""
    if not MIN_ADMIN_PASSWORD_CHARS <= len(password) <= MAX_ADMIN_PASSWORD_CHARS:
        raise ValueError(
            "Administrator password must contain between "
            f"{MIN_ADMIN_PASSWORD_CHARS} and {MAX_ADMIN_PASSWORD_CHARS} characters"
        )
    try:
        from argon2 import PasswordHasher
        from argon2.low_level import Type
    except ImportError as error:
        raise RuntimeError("argon2-cffi is required to hash administrator passwords") from error
    return PasswordHasher(type=Type.ID).hash(password)


def verify_password(password: str) -> bool:
    require_admin_enabled()
    encoded_hash = settings.BLOG_ADMIN_PASSWORD_HASH
    if not encoded_hash:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin authentication is not configured",
        )
    return _verify_argon2id(encoded_hash, password)


def create_session_token() -> str:
    payload = {
        "role": "admin",
        "exp": int(time.time()) + settings.AUTH_SESSION_HOURS * 3600,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=")
    signature = hmac.new(_secret(), encoded, hashlib.sha256).digest()
    return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def _decode_base64url(value: str, *, max_chars: int) -> bytes:
    if not value or len(value) > max_chars:
        raise ValueError("invalid base64url segment length")
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError as error:
        raise ValueError("base64url segment must be ASCII") from error
    allowed_characters = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    if any(character not in allowed_characters for character in encoded):
        raise ValueError("base64url segment contains invalid characters")
    return base64.b64decode(
        encoded + b"=" * (-len(encoded) % 4),
        altchars=b"-_",
        validate=True,
    )


def require_admin(portfolio_admin_session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME)):
    require_admin_enabled()
    if not portfolio_admin_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required")
    if len(portfolio_admin_session) > MAX_SESSION_TOKEN_CHARS:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")
    try:
        payload_part, signature_part = portfolio_admin_session.split(".", 1)
        if len(signature_part) != ENCODED_SIGNATURE_CHARS:
            raise ValueError("invalid signature length")
        encoded = payload_part.encode("ascii")
        supplied = _decode_base64url(signature_part, max_chars=ENCODED_SIGNATURE_CHARS)
        expected = hmac.new(_secret(), encoded, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, supplied):
            raise ValueError("invalid signature")

        decoded_payload = _decode_base64url(
            payload_part,
            max_chars=MAX_SESSION_PAYLOAD_CHARS,
        )
        payload = json.loads(decoded_payload)
        expires_at = payload.get("exp") if isinstance(payload, dict) else None
        if (
            not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or payload.get("role") != "admin"
            or expires_at <= int(time.time())
        ):
            raise ValueError("expired session")
        return payload
    except (
        binascii.Error,
        UnicodeDecodeError,
        UnicodeEncodeError,
        ValueError,
        TypeError,
        KeyError,
        json.JSONDecodeError,
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")
