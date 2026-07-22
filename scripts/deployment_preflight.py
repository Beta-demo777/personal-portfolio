#!/usr/bin/env python3
"""Read-only deployment preflight checks for the portfolio Compose stack.

The checker deliberately reports labels and failure reasons only.  It never
prints a configured path, a file payload, or output produced by OpenSSL.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
from typing import Mapping, Sequence
from urllib.parse import urlsplit


MAX_SECRET_FILE_BYTES = 16 * 1024
MIN_APP_SECRET_BYTES = 32
SECRET_DIRECTORY_MODE = 0o700
CERT_EXPIRY_WARNING_SECONDS = 30 * 24 * 60 * 60
OPENSSL_TIMEOUT_SECONDS = 15
AI_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")

SECRET_FILE_ENV_NAMES: tuple[str, ...] = (
    "PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE",
    "PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE",
    "PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE",
    "PORTFOLIO_APP_SECRET_KEY_SECRET_FILE",
    "PORTFOLIO_AI_API_KEY_SECRET_FILE",
)

# These names were accepted by earlier revisions and must not silently remain
# in a production .env after moving to file-backed secrets.
LEGACY_SECRET_ENV_NAMES = frozenset(
    {
        "POSTGRES_PASSWORD",
        "POSTGRES_APP_PASSWORD",
        "POSTGRES_RUNTIME_PASSWORD",
        "BLOG_ADMIN_PASSWORD",
        "BLOG_ADMIN_PASSWORD_HASH",
        "BLOG_ADMIN_PASSWORD_FILE",
        "APP_SECRET_KEY",
        "AI_API_KEY",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_RUNTIME_PASSWORD_FILE",
        "BLOG_ADMIN_PASSWORD_HASH_FILE",
        "APP_SECRET_KEY_FILE",
        "AI_API_KEY_FILE",
    }
)

ARGON2ID_V19 = re.compile(
    r"^\$argon2id\$v=19\$m=(?P<memory>[0-9]+),t=(?P<time>[0-9]+),"
    r"p=(?P<parallelism>[0-9]+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$"
)
DNS_SAN = re.compile(r"DNS:([^,\s]+)")


class PreflightError(ValueError):
    """A safe-to-display validation error (no path or secret is included)."""


def _display_label(name: str) -> str:
    """Keep command output stable and free of user-controlled path values."""

    return name.replace("\n", " ").replace("\r", " ")


def _safe_error(label: str, reason: str) -> PreflightError:
    return PreflightError(f"{_display_label(label)}: {reason}")


def _mode_is_private(mode: int, *, exact: bool = False) -> bool:
    permissions = stat.S_IMODE(mode)
    # "0600 or stricter" means a subset of owner read/write permissions; an
    # execute bit is not a stricter substitute for read/write access.
    return permissions == 0o600 if exact else (permissions & ~0o600) == 0


def _parse_dotenv(path: Path) -> dict[str, str]:
    """Parse the small, non-expanding dotenv dialect used by Compose.

    Variable expansion is intentionally unsupported: expanding values could
    make it difficult to prove that a secret-file path is absolute and safe.
    """

    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise _safe_error("root .env", "cannot be read") from error

    values: dict[str, str] = {}
    key_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    for line_number, line in enumerate(raw.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        if "=" not in stripped:
            raise _safe_error("root .env", f"invalid entry at line {line_number}")
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key_pattern.fullmatch(key):
            raise _safe_error("root .env", f"invalid variable name at line {line_number}")
        if key in values:
            raise _safe_error("root .env", f"duplicate variable {key}")
        value = value.strip()
        try:
            # shlex handles both quote styles and escaped characters while
            # avoiding shell execution.  A comment is only special outside a
            # quoted value when preceded by whitespace, matching dotenv use.
            lexer = shlex.shlex(value, posix=True)
            lexer.whitespace_split = True
            lexer.commenters = ""
            tokens = list(lexer)
        except ValueError as error:
            raise _safe_error("root .env", f"invalid value for {key}") from error
        if len(tokens) > 1:
            # Unquoted values containing spaces are not needed by the Compose
            # contract and accepting them would make comment handling unclear.
            raise _safe_error("root .env", f"invalid value for {key}")
        values[key] = tokens[0] if tokens else ""
    return values


def _assert_owner(
    metadata: os.stat_result,
    label: str,
    *,
    subject: str = "file",
) -> None:
    getuid = getattr(os, "getuid", None)
    if getuid is None:
        raise _safe_error(label, "current-user ownership cannot be verified on this platform")
    if metadata.st_uid != getuid():
        raise _safe_error(label, f"{subject} is not owned by the current user")


def _validate_secret_directory(path: Path, label: str) -> None:
    """Require the directory containing a host secret to be private and owned."""

    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise _safe_error(label, "secret directory is missing or inaccessible") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise _safe_error(label, "secret directory must not be a symbolic link")
    if not stat.S_ISDIR(metadata.st_mode):
        raise _safe_error(label, "secret parent must be a directory")
    if stat.S_IMODE(metadata.st_mode) != SECRET_DIRECTORY_MODE:
        raise _safe_error(label, "secret directory mode must be 0700")
    _assert_owner(metadata, label, subject="secret directory")


def _open_regular_file(
    path: Path,
    label: str,
    *,
    exact_mode: bool,
    require_owner: bool = False,
    require_single_link: bool = False,
) -> tuple[int, os.stat_result]:
    """Open a file without following its final symlink and verify its inode."""

    try:
        initial = os.lstat(path)
    except OSError as error:
        raise _safe_error(label, "file is missing or inaccessible") from error
    if stat.S_ISLNK(initial.st_mode):
        raise _safe_error(label, "file must not be a symbolic link")
    if not stat.S_ISREG(initial.st_mode):
        raise _safe_error(label, "file must be a regular file")
    try:
        flags = os.O_RDONLY
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        if nofollow:
            flags |= nofollow
        descriptor = os.open(path, flags)
    except OSError as error:
        raise _safe_error(label, "file cannot be opened") from error
    try:
        metadata = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino) != (initial.st_dev, initial.st_ino):
            raise _safe_error(label, "file changed while it was opened")
        if not stat.S_ISREG(metadata.st_mode):
            raise _safe_error(label, "file must be a regular file")
        if not _mode_is_private(metadata.st_mode, exact=exact_mode):
            expected = "0600" if exact_mode else "0600 or stricter"
            raise _safe_error(label, f"file mode must be {expected}")
        if require_owner:
            _assert_owner(metadata, label)
        if require_single_link and metadata.st_nlink != 1:
            raise _safe_error(label, "file must have exactly one hard link")
        return descriptor, metadata
    except Exception:
        os.close(descriptor)
        raise


def _read_checked_file(
    path: Path,
    label: str,
    *,
    exact_mode: bool = True,
    allow_empty: bool = False,
) -> str:
    descriptor, metadata = _open_regular_file(
        path,
        label,
        exact_mode=exact_mode,
        require_owner=True,
        require_single_link=True,
    )
    try:
        if metadata.st_size > MAX_SECRET_FILE_BYTES:
            raise _safe_error(label, "file exceeds 16 KiB")
        chunks: list[bytes] = []
        remaining = MAX_SECRET_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(8192, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
    except OSError as error:
        raise _safe_error(label, "file cannot be read") from error
    finally:
        os.close(descriptor)
    if len(payload) > MAX_SECRET_FILE_BYTES:
        raise _safe_error(label, "file exceeds 16 KiB")
    try:
        value = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise _safe_error(label, "file must contain UTF-8 text") from error
    value = value.rstrip("\r\n")
    if "\n" in value or "\r" in value or "\x00" in value:
        raise _safe_error(label, "file must contain one text line")
    if not allow_empty and not value.strip():
        raise _safe_error(label, "file must not be empty")
    return value


def _path_is_outside(path: Path, repository: Path) -> bool:
    try:
        path.resolve(strict=True).relative_to(repository.resolve(strict=True))
    except ValueError:
        return True
    return False


def _validate_secret_path(name: str, raw_path: str, repository: Path) -> str:
    if not raw_path:
        raise _safe_error(name, "secret-file path is missing")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise _safe_error(name, "secret-file path must be absolute")
    try:
        if not _path_is_outside(candidate, repository):
            raise _safe_error(name, "secret file must be outside the repository")
    except OSError as error:
        raise _safe_error(name, "secret-file path cannot be resolved") from error
    _validate_secret_directory(candidate.parent, name)
    return _read_checked_file(
        candidate,
        name,
        exact_mode=True,
        allow_empty=name == "PORTFOLIO_AI_API_KEY_SECRET_FILE",
    )


def _validate_argon2id(value: str, label: str) -> None:
    match = ARGON2ID_V19.fullmatch(value)
    if match is None:
        raise _safe_error(label, "must be an Argon2id v=19 hash")
    # Keep this aligned with backend/app/core/config.py.  The preflight only
    # validates the encoded format and bounded cost, never verifies a password.
    if not 19_456 <= int(match.group("memory")) <= 262_144:
        raise _safe_error(label, "Argon2id memory cost is outside the allowed range")
    if not 2 <= int(match.group("time")) <= 10:
        raise _safe_error(label, "Argon2id time cost is outside the allowed range")
    if not 1 <= int(match.group("parallelism")) <= 16:
        raise _safe_error(label, "Argon2id parallelism is outside the allowed range")


def _validate_database_identity(values: Mapping[str, str]) -> None:
    for name in ("POSTGRES_USER", "POSTGRES_DB"):
        value = values.get(name)
        if value is None or not value.strip():
            raise _safe_error("root .env", f"{name} must be set and non-empty")


def _validate_origin_cookie_contract(values: Mapping[str, str]) -> None:
    """Never allow an insecure auth cookie on an HTTPS production origin."""

    # Compose's `:-` defaults apply when a variable is absent or empty.
    public_origin = values.get("PUBLIC_ORIGIN") or "https://beta-demo.top"
    cookie_secure = values.get("AUTH_COOKIE_SECURE") or "true"
    try:
        is_https = urlsplit(public_origin).scheme.lower() == "https"
    except ValueError:
        # The backend's origin parser reports malformed origins at startup.
        # This check only governs the scheme-dependent cookie invariant.
        is_https = False
    false_values = {"0", "false", "f", "no", "n", "off"}
    if is_https and cookie_secure.strip().lower() in false_values:
        raise _safe_error(
            "root .env",
            "AUTH_COOKIE_SECURE must not be false when PUBLIC_ORIGIN uses HTTPS",
        )


def validate_env(repository: Path, env_path: Path | None = None) -> Mapping[str, str]:
    """Validate the root dotenv file and all five host secret files."""

    repository = repository.resolve()
    env_path = env_path or repository / ".env"
    if not env_path.is_absolute():
        env_path = (repository / env_path).resolve()
    descriptor, _metadata = _open_regular_file(env_path, "root .env", exact_mode=False)
    os.close(descriptor)
    values = _parse_dotenv(env_path)
    legacy = sorted(LEGACY_SECRET_ENV_NAMES & values.keys())
    if legacy:
        raise _safe_error("root .env", f"legacy secret variable {legacy[0]} is forbidden")
    _validate_database_identity(values)
    _validate_origin_cookie_contract(values)
    missing = [name for name in SECRET_FILE_ENV_NAMES if not values.get(name)]
    if missing:
        raise _safe_error("root .env", f"missing secret-file variable {missing[0]}")
    for name in SECRET_FILE_ENV_NAMES:
        value = _validate_secret_path(name, values[name], repository)
        if name == "PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE":
            _validate_argon2id(value, name)
        elif name == "PORTFOLIO_APP_SECRET_KEY_SECRET_FILE":
            if len(value.encode("utf-8")) < MIN_APP_SECRET_BYTES:
                raise _safe_error(
                    name,
                    f"secret must contain at least {MIN_APP_SECRET_BYTES} UTF-8 bytes",
                )
    model = values.get("AI_MODEL", "").strip()
    if model and AI_MODEL_PATTERN.fullmatch(model) is None:
        raise _safe_error("root .env", "AI_MODEL contains unsupported characters")
    return values


def _run_openssl(
    arguments: Sequence[str],
    *,
    openssl: str = "openssl",
) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            [openssl, *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=OPENSSL_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise PreflightError("OpenSSL: validation timed out") from error
    except OSError as error:
        raise PreflightError("OpenSSL: executable is unavailable") from error


def _certificate_sans(cert: Path, *, openssl: str = "openssl") -> set[str]:
    result = _run_openssl(("x509", "-in", os.fspath(cert), "-noout", "-text"), openssl=openssl)
    if result.returncode != 0:
        raise PreflightError("TLS certificate: OpenSSL could not parse the certificate")
    try:
        text = result.stdout.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise PreflightError("TLS certificate: OpenSSL returned invalid text") from error
    marker = "X509v3 Subject Alternative Name:"
    lines = text.splitlines()
    try:
        marker_index = next(index for index, line in enumerate(lines) if marker in line)
    except StopIteration:
        raise PreflightError("TLS certificate: Subject Alternative Name extension is missing")
    # OpenSSL may wrap a long extension over several indented lines.  Stop at
    # the next top-level extension while retaining every DNS token.
    sans: set[str] = set()
    marker_line = lines[marker_index]
    marker_indent = len(marker_line) - len(marker_line.lstrip())
    for line in lines[marker_index + 1 :]:
        if not line.strip():
            continue
        indentation = len(line) - len(line.lstrip())
        if indentation <= marker_indent:
            break
        for match in DNS_SAN.finditer(line):
            sans.add(match.group(1).lower())
    return sans


def validate_tls(
    repository: Path,
    *,
    certificate_path: Path | None = None,
    key_path: Path | None = None,
    openssl: str = "openssl",
    warning_seconds: int = CERT_EXPIRY_WARNING_SECONDS,
) -> None:
    """Validate the deployed certificate and private key without printing them."""

    cert = certificate_path or repository / "nginx" / "certs" / "beta-demo.top.pem"
    key = key_path or repository / "nginx" / "certs" / "beta-demo.top.key"
    try:
        cert_stat = os.lstat(cert)
    except OSError as error:
        raise _safe_error("TLS certificate", "certificate is missing or inaccessible") from error
    if stat.S_ISLNK(cert_stat.st_mode):
        raise _safe_error("TLS certificate", "certificate must not be a symbolic link")
    if not stat.S_ISREG(cert_stat.st_mode):
        raise _safe_error("TLS certificate", "certificate must be a regular file")
    _key_descriptor, _key_stat = _open_regular_file(
        key,
        "TLS private key",
        exact_mode=True,
        require_owner=True,
        require_single_link=True,
    )
    os.close(_key_descriptor)

    expiry = _run_openssl(
        ("x509", "-in", os.fspath(cert), "-noout", "-checkend", str(warning_seconds)),
        openssl=openssl,
    )
    if expiry.returncode != 0:
        raise PreflightError("TLS certificate: expires within 30 days or is invalid")
    sans = _certificate_sans(cert, openssl=openssl)
    required_sans = {"beta-demo.top", "www.beta-demo.top"}
    if not {name.lower() for name in required_sans}.issubset(sans):
        raise PreflightError("TLS certificate: required DNS SANs are missing")

    cert_key = _run_openssl(
        ("x509", "-in", os.fspath(cert), "-pubkey", "-noout"), openssl=openssl
    )
    private_key = _run_openssl(
        ("pkey", "-in", os.fspath(key), "-pubout"), openssl=openssl
    )
    if cert_key.returncode != 0 or private_key.returncode != 0:
        raise PreflightError("TLS private key: OpenSSL could not read the key pair")
    if cert_key.stdout != private_key.stdout:
        raise PreflightError("TLS private key: certificate and key do not match")


def run_preflight(
    repository: Path,
    *,
    env_path: Path | None = None,
    certificate_path: Path | None = None,
    key_path: Path | None = None,
    openssl: str = "openssl",
) -> None:
    repository = Path(repository)
    validate_env(repository, env_path)
    validate_tls(
        repository,
        certificate_path=certificate_path,
        key_path=key_path,
        openssl=openssl,
    )


def _arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate portfolio deployment prerequisites")
    parser.add_argument("--repository", "--repo", dest="repository", type=Path, default=Path.cwd())
    parser.add_argument("--env", dest="env_path", type=Path)
    parser.add_argument("--certificate", dest="certificate_path", type=Path)
    parser.add_argument("--key", dest="key_path", type=Path)
    parser.add_argument("--openssl", default="openssl", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _arguments(argv)
    try:
        run_preflight(
            arguments.repository,
            env_path=arguments.env_path,
            certificate_path=arguments.certificate_path,
            key_path=arguments.key_path,
            openssl=arguments.openssl,
        )
    except PreflightError as error:
        print(f"deployment preflight: FAILED: {error}", file=sys.stderr)
        return 1
    except OSError:
        # Avoid exposing the OS's path-bearing exception text.
        print("deployment preflight: FAILED: filesystem check failed", file=sys.stderr)
        return 1
    print("deployment preflight: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
