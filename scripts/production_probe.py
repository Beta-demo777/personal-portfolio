#!/usr/bin/env python3
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import sys
import time
from typing import BinaryIO, Callable, Iterator, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import backup_signature


BACKUP_NAME = re.compile(r"^portfolio-backup-\d{8}T\d{6}Z$")
MANIFEST_TIMESTAMP = "%Y-%m-%dT%H:%M:%SZ"
MAX_MANIFEST_BYTES = 16 * 1024
MAX_CHECKSUM_BYTES = 4 * 1024
CHECKSUM_BACKUP_FILES = ("database.dump", "uploads.tar", "manifest.txt")
CHECKSUM_BACKUP_FILE_SET = frozenset(CHECKSUM_BACKUP_FILES)
V3_MANIFEST_KEYS = frozenset(
    {
        "format_version",
        "created_at_utc",
        "application_id",
        "application_backup_compatibility",
        "application_alembic_head",
        "signature_format_version",
        "signature_algorithm",
        "signature_key_id",
        "database_format",
        "database_alembic_head",
        "database_bytes",
        "uploads_format",
        "uploads_bytes",
    }
)
ALEMBIC_REVISION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
CHECKSUM_LINE = re.compile(
    r"(?P<digest>[0-9a-f]{64})  (?P<filename>[A-Za-z0-9][A-Za-z0-9._-]{0,127})\n"
)
HASH_CHUNK_BYTES = 1024 * 1024


@dataclass(frozen=True)
class Target:
    origin: str
    hostname: str
    port: int


@dataclass(frozen=True)
class ProbeResult:
    name: str
    ok: bool
    code: str
    latency_ms: int | None = None
    remaining_seconds: int | None = None
    age_seconds: int | None = None


def parse_origin(value: str) -> Target:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("origin must be an HTTPS origin without credentials, path, query, or fragment")
    try:
        port = parsed.port or 443
    except ValueError as error:
        raise ValueError("origin contains an invalid port") from error
    if not 1 <= port <= 65_535:
        raise ValueError("origin contains an invalid port")
    default_port = port == 443
    host = parsed.hostname
    rendered_host = f"[{host}]" if ":" in host else host
    origin = f"https://{rendered_host}{'' if default_port else f':{port}'}"
    return Target(origin=origin, hostname=host, port=port)


def check_http(
    name: str,
    url: str,
    *,
    timeout_seconds: float,
    max_latency_ms: int,
    expected_media_type: str,
    expected_json_status: str | None = None,
    opener: Callable[..., object] = urlopen,
    monotonic: Callable[[], float] = time.monotonic,
) -> ProbeResult:
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/json;q=0.9",
            "User-Agent": "personal-portfolio-production-probe/1",
        },
        method="GET",
    )
    started = monotonic()
    try:
        response = opener(request, timeout=timeout_seconds)
        with response:
            status_code = int(getattr(response, "status", 0))
            final_url = str(response.geturl())
            media_type = response.headers.get_content_type()
            body = response.read(4097 if expected_json_status is not None else 1)
    except (AttributeError, TypeError, ValueError):
        return ProbeResult(name=name, ok=False, code="HTTP_CONTRACT")
    except HTTPError:
        return ProbeResult(name=name, ok=False, code="HTTP_STATUS")
    except (URLError, TimeoutError, OSError):
        return ProbeResult(name=name, ok=False, code="HTTP_UNAVAILABLE")
    elapsed_ms = max(0, round((monotonic() - started) * 1000))
    if status_code != 200:
        return ProbeResult(name=name, ok=False, code="HTTP_STATUS", latency_ms=elapsed_ms)
    if final_url != url or media_type != expected_media_type:
        return ProbeResult(name=name, ok=False, code="HTTP_CONTRACT", latency_ms=elapsed_ms)
    if expected_json_status is not None:
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return ProbeResult(name=name, ok=False, code="HTTP_CONTRACT", latency_ms=elapsed_ms)
        if len(body) > 4096 or not isinstance(payload, dict) or payload.get("status") != expected_json_status:
            return ProbeResult(name=name, ok=False, code="HTTP_CONTRACT", latency_ms=elapsed_ms)
    if elapsed_ms > max_latency_ms:
        return ProbeResult(name=name, ok=False, code="HTTP_LATENCY", latency_ms=elapsed_ms)
    return ProbeResult(name=name, ok=True, code="OK", latency_ms=elapsed_ms)


def _certificate_expiry(hostname: str, port: int, timeout_seconds: float) -> datetime:
    context = ssl.create_default_context()
    with socket.create_connection((hostname, port), timeout=timeout_seconds) as connection:
        with context.wrap_socket(connection, server_hostname=hostname) as secure_connection:
            certificate = secure_connection.getpeercert()
    not_after = certificate.get("notAfter")
    if not isinstance(not_after, str):
        raise ValueError("certificate has no expiry")
    return datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), tz=timezone.utc)


def check_tls(
    target: Target,
    *,
    now: datetime,
    timeout_seconds: float,
    warning_days: int,
    expiry_loader: Callable[[str, int, float], datetime] = _certificate_expiry,
) -> ProbeResult:
    try:
        expiry = expiry_loader(target.hostname, target.port, timeout_seconds)
    except (OSError, ssl.SSLError, ValueError):
        return ProbeResult(name="tls", ok=False, code="TLS_UNAVAILABLE")
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    remaining = round((expiry.astimezone(timezone.utc) - now).total_seconds())
    if remaining <= 0:
        return ProbeResult(name="tls", ok=False, code="TLS_EXPIRED", remaining_seconds=remaining)
    if remaining <= warning_days * 86_400:
        return ProbeResult(name="tls", ok=False, code="TLS_EXPIRING", remaining_seconds=remaining)
    return ProbeResult(name="tls", ok=True, code="OK", remaining_seconds=remaining)


@contextmanager
def _open_private_regular_file(path: Path) -> Iterator[BinaryIO]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        path_metadata = path.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or not stat.S_ISREG(path_metadata.st_mode)
            or path_metadata.st_nlink != 1
            or (metadata.st_dev, metadata.st_ino) != (path_metadata.st_dev, path_metadata.st_ino)
        ):
            raise ValueError("backup member is not a private regular file")
        stream = os.fdopen(descriptor, "rb")
        descriptor = -1
        with stream:
            yield stream
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _read_private_file(path: Path, *, max_bytes: int) -> bytes:
    with _open_private_regular_file(path) as stream:
        contents = stream.read(max_bytes + 1)
    if len(contents) > max_bytes:
        raise ValueError("backup metadata file is too large")
    return contents


def _sha256_private_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with _open_private_regular_file(path) as stream:
        while chunk := stream.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _manifest_values(contents: bytes) -> dict[str, str]:
    text = contents.decode("ascii")
    values: dict[str, str] = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[a-z][a-z0-9_]*", key) or key in values:
            raise ValueError("manifest is malformed")
        values[key] = value
    return values


def _checksum_values(contents: bytes) -> dict[str, str]:
    text = contents.decode("ascii")
    lines = text.splitlines(keepends=True)
    if len(lines) != len(CHECKSUM_BACKUP_FILES):
        raise ValueError("checksum list has the wrong number of entries")

    values: dict[str, str] = {}
    for expected_filename, line in zip(CHECKSUM_BACKUP_FILES, lines):
        match = CHECKSUM_LINE.fullmatch(line)
        if match is None:
            raise ValueError("checksum list is malformed")
        filename = match.group("filename")
        if filename != expected_filename:
            raise ValueError("checksum list is not in canonical order")
        if filename in values:
            raise ValueError("checksum list contains a duplicate entry")
        values[filename] = match.group("digest")
    if frozenset(values) != CHECKSUM_BACKUP_FILE_SET:
        raise ValueError("checksum list has unexpected members")
    return values


def _newest_backup_directory(root: Path) -> Path:
    root_metadata = root.stat()
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise ValueError("backup root is not a directory")
    candidates = sorted(
        (
            entry
            for entry in root.iterdir()
            if BACKUP_NAME.fullmatch(entry.name) and not entry.is_symlink() and entry.is_dir()
        ),
        key=lambda entry: entry.name,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError("no published backup found")
    return candidates[0]


def check_backup(
    root: Path,
    *,
    now: datetime,
    max_age_hours: float,
    public_keys: tuple[Path, ...] = (),
    key_configuration_error: bool = False,
) -> ProbeResult:
    if key_configuration_error:
        return ProbeResult(name="backup", ok=False, code="BACKUP_SIGNATURE_CONFIG")
    try:
        backup = _newest_backup_directory(root)
    except FileNotFoundError:
        return ProbeResult(name="backup", ok=False, code="BACKUP_MISSING")
    except (OSError, ValueError):
        return ProbeResult(name="backup", ok=False, code="BACKUP_INVALID")

    try:
        manifest_contents = _read_private_file(
            backup / "manifest.txt", max_bytes=MAX_MANIFEST_BYTES
        )
        values = _manifest_values(manifest_contents)
        format_version = values.get("format_version")
        if format_version in ("1", "2"):
            return ProbeResult(name="backup", ok=False, code="BACKUP_UNSIGNED")
        if (
            format_version != "3"
            or frozenset(values) != V3_MANIFEST_KEYS
            or values.get("application_id") != "personal-portfolio"
            or values.get("application_backup_compatibility") != "1"
            or ALEMBIC_REVISION.fullmatch(
                values.get("application_alembic_head", "")
            )
            is None
            or values.get("database_format") != "postgresql_custom"
            or ALEMBIC_REVISION.fullmatch(
                values.get("database_alembic_head", "")
            )
            is None
            or values.get("uploads_format") != "tar"
            or values.get("signature_format_version")
            != backup_signature.SIGNATURE_FORMAT_VERSION
            or values.get("signature_algorithm") != backup_signature.SIGNATURE_ALGORITHM
        ):
            raise ValueError("backup identity or signature metadata is invalid")
        backup_signature.verify(
            backup / "SHA256SUMS",
            backup / "SHA256SUMS.sig",
            public_keys,
            values.get("signature_key_id", ""),
            forbidden_roots=(Path(__file__).resolve().parent.parent, root),
        )
        checksum_values = _checksum_values(
            _read_private_file(backup / "SHA256SUMS", max_bytes=MAX_CHECKSUM_BYTES)
        )
        database_digest, database_size = _sha256_private_file(backup / "database.dump")
        uploads_digest, uploads_size = _sha256_private_file(backup / "uploads.tar")
        actual_checksums = {
            "database.dump": database_digest,
            "uploads.tar": uploads_digest,
            "manifest.txt": hashlib.sha256(manifest_contents).hexdigest(),
        }
        if actual_checksums != checksum_values:
            raise ValueError("backup checksum mismatch")
        if (
            not re.fullmatch(r"[0-9]+", values["database_bytes"])
            or not re.fullmatch(r"[0-9]+", values["uploads_bytes"])
            or int(values["database_bytes"]) != database_size
            or int(values["uploads_bytes"]) != uploads_size
        ):
            raise ValueError("backup payload size metadata is invalid")

        created_at = datetime.strptime(values.get("created_at_utc", ""), MANIFEST_TIMESTAMP).replace(
            tzinfo=timezone.utc
        )
    except backup_signature.SignatureConfigurationError:
        return ProbeResult(name="backup", ok=False, code="BACKUP_SIGNATURE_CONFIG")
    except backup_signature.UntrustedSignatureError:
        return ProbeResult(name="backup", ok=False, code="BACKUP_UNTRUSTED")
    except backup_signature.InvalidSignatureError:
        return ProbeResult(name="backup", ok=False, code="BACKUP_SIGNATURE_INVALID")
    except (OSError, UnicodeError, ValueError):
        return ProbeResult(name="backup", ok=False, code="BACKUP_INVALID")

    age = round((now - created_at).total_seconds())
    if age < -300:
        return ProbeResult(name="backup", ok=False, code="BACKUP_FROM_FUTURE", age_seconds=age)
    if age > max_age_hours * 3600:
        return ProbeResult(name="backup", ok=False, code="BACKUP_STALE", age_seconds=age)
    return ProbeResult(name="backup", ok=True, code="OK", age_seconds=max(0, age))


def _positive_float(value: str) -> float:
    parsed = float(value)
    if not 0 < parsed <= 1_000_000:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def _positive_integer(value: str) -> int:
    parsed = int(value)
    if not 0 < parsed <= 1_000_000:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe the public site, backend readiness, TLS expiry, and backup freshness."
    )
    parser.add_argument("--origin", default="https://beta-demo.top")
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument(
        "--public-key",
        type=Path,
        action="append",
        default=[],
        help=(
            "independent backup verification public key; repeat for rotation, "
            "or set PORTFOLIO_BACKUP_PUBLIC_KEY_FILES"
        ),
    )
    parser.add_argument("--timeout-seconds", type=_positive_float, default=5.0)
    parser.add_argument("--max-http-latency-ms", type=_positive_integer, default=5_000)
    parser.add_argument("--tls-warning-days", type=_positive_integer, default=30)
    parser.add_argument("--max-backup-age-hours", type=_positive_float, default=26.0)
    return parser


def _configured_public_keys(
    command_line_keys: list[Path],
    environ: Mapping[str, str] = os.environ,
) -> tuple[tuple[Path, ...], bool]:
    keys = list(command_line_keys)
    if "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES" in environ:
        configured = environ["PORTFOLIO_BACKUP_PUBLIC_KEY_FILES"]
        parts = configured.split(":")
        if not configured or any(not part for part in parts):
            return (), True
        keys.extend(Path(part) for part in parts)
    return tuple(keys), False


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        target = parse_origin(arguments.origin)
    except ValueError as error:
        build_parser().error(str(error))

    now = datetime.now(timezone.utc)
    public_keys, key_configuration_error = _configured_public_keys(arguments.public_key)
    results = [
        check_http(
            "public_http",
            f"{target.origin}/",
            timeout_seconds=arguments.timeout_seconds,
            max_latency_ms=arguments.max_http_latency_ms,
            expected_media_type="text/html",
        ),
        check_http(
            "backend_readiness",
            f"{target.origin}/backend/health/ready",
            timeout_seconds=arguments.timeout_seconds,
            max_latency_ms=arguments.max_http_latency_ms,
            expected_media_type="application/json",
            expected_json_status="ready",
        ),
        check_tls(
            target,
            now=now,
            timeout_seconds=arguments.timeout_seconds,
            warning_days=arguments.tls_warning_days,
        ),
        check_backup(
            arguments.backup_root,
            now=now,
            max_age_hours=arguments.max_backup_age_hours,
            public_keys=public_keys,
            key_configuration_error=key_configuration_error,
        ),
    ]
    healthy = all(result.ok for result in results)
    payload = {
        "checked_at_utc": now.strftime(MANIFEST_TIMESTAMP),
        "checks": [asdict(result) for result in results],
        "status": "ok" if healthy else "failed",
    }
    json.dump(payload, sys.stdout, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0 if healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
