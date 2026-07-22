import os
import re
import stat
from pathlib import Path
from typing import Optional

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = (
    BACKEND_ROOT.parent
    if (BACKEND_ROOT.parent / "alembic.ini").is_file()
    else BACKEND_ROOT
)
ENV_FILE = PROJECT_ROOT / ".env"

MAX_SECRET_FILE_BYTES = 16 * 1024
MIN_APP_SECRET_BYTES = 32
MIN_ADMIN_PASSWORD_CHARS = 12
MAX_ADMIN_PASSWORD_CHARS = 256
ARGON2ID_PATTERN = re.compile(
    r"^\$argon2id\$v=19\$m=(?P<memory>\d+),t=(?P<time>\d+),p=(?P<parallelism>\d+)"
    r"\$(?P<salt>[A-Za-z0-9+/]+)\$(?P<digest>[A-Za-z0-9+/]+)$"
)


def _read_secret_file(path: Path, field_name: str) -> str:
    try:
        if path.is_symlink():
            raise ValueError(f"{field_name} must not reference a symbolic link")

        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags)
    except (OSError, ValueError) as error:
        if isinstance(error, ValueError):
            raise
        raise ValueError(f"{field_name} cannot be opened") from error

    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"{field_name} must reference a regular file")
        if metadata.st_mode & 0o022:
            raise ValueError(f"{field_name} must not be writable by group or other users")
        if metadata.st_size > MAX_SECRET_FILE_BYTES:
            raise ValueError(f"{field_name} exceeds the {MAX_SECRET_FILE_BYTES} byte limit")

        with os.fdopen(descriptor, "r", encoding="utf-8", newline="") as secret_file:
            descriptor = -1
            value = secret_file.read(MAX_SECRET_FILE_BYTES + 1).rstrip("\r\n")
    except UnicodeDecodeError as error:
        raise ValueError(f"{field_name} must contain UTF-8 text") from error
    except OSError as error:
        raise ValueError(f"{field_name} cannot be read") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    if not value or not value.strip():
        raise ValueError(f"{field_name} must not be empty")
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError(f"{field_name} must contain exactly one text line")
    return value


def _resolve_secret(
    direct_value: Optional[str],
    file_path: Optional[Path],
    *,
    value_name: str,
    file_name: str,
    required: bool,
) -> Optional[str]:
    if direct_value is not None and file_path is not None:
        raise ValueError(f"{value_name} and {file_name} cannot both be configured")
    if file_path is not None:
        return _read_secret_file(file_path, file_name)
    if direct_value is not None:
        if not direct_value or not direct_value.strip():
            raise ValueError(f"{value_name} must not be empty")
        return direct_value
    if required:
        raise ValueError(f"{value_name} or {file_name} is required")
    return None


def _validate_argon2id_hash(encoded_hash: str) -> None:
    if len(encoded_hash) > 1024:
        raise ValueError("BLOG_ADMIN_PASSWORD_HASH is too long")
    match = ARGON2ID_PATTERN.fullmatch(encoded_hash)
    if match is None:
        raise ValueError("BLOG_ADMIN_PASSWORD_HASH must be an encoded Argon2id v=19 hash")

    memory_cost = int(match.group("memory"))
    time_cost = int(match.group("time"))
    parallelism = int(match.group("parallelism"))
    if not 19_456 <= memory_cost <= 262_144:
        raise ValueError("Argon2id memory cost must be between 19456 and 262144 KiB")
    if not 2 <= time_cost <= 10:
        raise ValueError("Argon2id time cost must be between 2 and 10")
    if not 1 <= parallelism <= 16:
        raise ValueError("Argon2id parallelism must be between 1 and 16")


class Settings(BaseSettings):
    POSTGRES_USER: str
    POSTGRES_PASSWORD: Optional[str] = Field(default=None, repr=False)
    POSTGRES_PASSWORD_FILE: Optional[Path] = None
    POSTGRES_DB: str
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    DB_CONNECT_TIMEOUT_SECONDS: int = Field(default=3, ge=1, le=20)
    DB_POOL_TIMEOUT_SECONDS: int = Field(default=3, ge=1, le=20)
    DB_STATEMENT_TIMEOUT_MS: int = Field(default=4_000, ge=100, le=20_000)
    DB_MIGRATION_STATEMENT_TIMEOUT_MS: int = Field(
        default=120_000,
        ge=1_000,
        le=3_600_000,
    )
    API_DOCS_ENABLED: bool = False
    ALLOWED_HOSTS: str = "beta-demo.top,localhost,127.0.0.1,backend"
    ADMIN_ENABLED: bool = True
    ADMIN_WRITES_ENABLED: bool = True
    BLOG_ADMIN_PASSWORD_HASH: Optional[str] = Field(default=None, repr=False)
    BLOG_ADMIN_PASSWORD_HASH_FILE: Optional[Path] = None
    APP_SECRET_KEY: Optional[str] = Field(default=None, repr=False)
    APP_SECRET_KEY_FILE: Optional[Path] = None
    AUTH_COOKIE_SECURE: bool = True
    AUTH_COOKIE_PATH: str = "/backend/api/v1/admin"
    AUTH_SESSION_HOURS: int = Field(default=12, ge=1, le=24)
    ADMIN_LOGIN_MAX_FAILURES: int = Field(default=5, ge=1, le=100)
    ADMIN_LOGIN_WINDOW_SECONDS: int = Field(default=900, ge=1, le=86400)
    ADMIN_LOGIN_LOCKOUT_SECONDS: int = Field(default=900, ge=1, le=86400)
    ADMIN_LOGIN_MAX_CLIENTS: int = Field(default=10000, ge=100, le=1000000)
    AUTH_TRUSTED_PROXY_CIDRS: str = "127.0.0.0/8,::1/128,172.16.0.0/12"
    PUBLIC_ORIGIN: Optional[str] = None
    CSRF_TRUSTED_ORIGINS: str = ""
    UPLOAD_DIR: str = "/app/uploads"
    MAX_UPLOAD_MB: int = Field(default=8, ge=1, le=8)
    MAX_MEDIA_FILES: int = Field(default=1_000, ge=1, le=10_000)
    MAX_CONCURRENT_UPLOADS: int = Field(default=2, ge=1, le=16)
    MAX_IMAGE_PIXELS: int = Field(default=40_000_000, ge=1, le=100_000_000)
    MAX_IMAGE_DIMENSION: int = Field(default=12_000, ge=1, le=50_000)
    MAX_IMAGE_FRAMES: int = Field(default=200, ge=1, le=1_000)
    MAX_IMAGE_TOTAL_PIXELS: int = Field(
        default=80_000_000,
        ge=1,
        le=500_000_000,
    )
    MAX_CONTENT_BYTES: int = Field(
        default=2_097_152,
        ge=65_536,
        le=2_097_152,
    )
    MAX_CONTENT_REVISIONS: int = Field(default=100, ge=1, le=100)

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        extra="ignore",
        hide_input_in_errors=True,
    )

    @field_validator(
        "POSTGRES_PASSWORD",
        "BLOG_ADMIN_PASSWORD_HASH",
        "APP_SECRET_KEY",
        mode="before",
    )
    @classmethod
    def normalize_empty_secret_value(cls, value):
        return None if value == "" else value

    @field_validator(
        "POSTGRES_PASSWORD_FILE",
        "BLOG_ADMIN_PASSWORD_HASH_FILE",
        "APP_SECRET_KEY_FILE",
        mode="before",
    )
    @classmethod
    def normalize_empty_secret_path(cls, value):
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("AUTH_COOKIE_PATH")
    @classmethod
    def validate_auth_cookie_path(cls, value: str) -> str:
        if not value.startswith("/") or value.endswith("/") or any(
            character.isspace() or ord(character) < 32 for character in value
        ):
            raise ValueError("AUTH_COOKIE_PATH must be an absolute path without a trailing slash")
        return value

    @model_validator(mode="after")
    def validate_runtime_database_timeout_budget(self):
        total_runtime_budget_ms = (
            (self.DB_CONNECT_TIMEOUT_SECONDS + self.DB_POOL_TIMEOUT_SECONDS) * 1_000
            + self.DB_STATEMENT_TIMEOUT_MS
        )
        if total_runtime_budget_ms > 25_000:
            raise ValueError(
                "runtime database connect, pool, and statement timeouts must total "
                "at most 25000 ms"
            )
        return self

    @model_validator(mode="after")
    def resolve_and_validate_secrets(self):
        self.POSTGRES_PASSWORD = _resolve_secret(
            self.POSTGRES_PASSWORD,
            self.POSTGRES_PASSWORD_FILE,
            value_name="POSTGRES_PASSWORD",
            file_name="POSTGRES_PASSWORD_FILE",
            required=True,
        )
        self.BLOG_ADMIN_PASSWORD_HASH = _resolve_secret(
            self.BLOG_ADMIN_PASSWORD_HASH,
            self.BLOG_ADMIN_PASSWORD_HASH_FILE,
            value_name="BLOG_ADMIN_PASSWORD_HASH",
            file_name="BLOG_ADMIN_PASSWORD_HASH_FILE",
            required=self.ADMIN_ENABLED,
        )
        self.APP_SECRET_KEY = _resolve_secret(
            self.APP_SECRET_KEY,
            self.APP_SECRET_KEY_FILE,
            value_name="APP_SECRET_KEY",
            file_name="APP_SECRET_KEY_FILE",
            required=self.ADMIN_ENABLED,
        )

        if self.BLOG_ADMIN_PASSWORD_HASH is not None:
            _validate_argon2id_hash(self.BLOG_ADMIN_PASSWORD_HASH)

        if not self.ADMIN_ENABLED:
            return self
        if self.APP_SECRET_KEY is None or len(self.APP_SECRET_KEY.encode("utf-8")) < MIN_APP_SECRET_BYTES:
            raise ValueError(
                f"APP_SECRET_KEY must contain at least {MIN_APP_SECRET_BYTES} bytes"
            )

        # Validate request-boundary configuration at startup so a typo cannot
        # leave authentication available with origin checks failing only later.
        from app.core.login_limiter import parse_trusted_proxy_cidrs
        from app.core.origin import parse_configured_origins

        try:
            parse_configured_origins(self.PUBLIC_ORIGIN, self.CSRF_TRUSTED_ORIGINS)
            parse_trusted_proxy_cidrs(self.AUTH_TRUSTED_PROXY_CIDRS)
        except ValueError as error:
            raise ValueError("administrator request-boundary configuration is invalid") from error
        return self

    @property
    def database_url(self) -> URL:
        return URL.create(
            drivername="postgresql+psycopg2",
            username=self.POSTGRES_USER,
            password=self.POSTGRES_PASSWORD,
            host=self.POSTGRES_HOST,
            port=self.POSTGRES_PORT,
            database=self.POSTGRES_DB,
        )

    def database_connect_args(self, *, migration: bool = False) -> dict[str, object]:
        statement_timeout = (
            self.DB_MIGRATION_STATEMENT_TIMEOUT_MS
            if migration
            else self.DB_STATEMENT_TIMEOUT_MS
        )
        return {
            "connect_timeout": self.DB_CONNECT_TIMEOUT_SECONDS,
            "options": f"-c statement_timeout={statement_timeout}",
        }


settings = Settings(
    _env_file=None
    if os.environ.get("PORTFOLIO_DISABLE_DOTENV", "").strip().lower()
    in {"1", "true", "yes"}
    else ENV_FILE
)
