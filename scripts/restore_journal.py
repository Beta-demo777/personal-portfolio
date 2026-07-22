#!/usr/bin/env python3
"""Create and validate the host-side journal for an interrupted restore."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import NoReturn


VERSION = 1
TOKEN_PATTERN = re.compile(r"[0-9a-f]{32}")
PROJECT_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")
PHASES = frozenset(
    {
        "database_creating",
        "database_staged",
        "media_staging",
        "media_staged",
        "backend_stopping",
        "backend_stopped",
        "media_activating",
        "media_active",
        "database_swapping",
        "database_swapped",
        "backend_validating",
        "commit_started",
    }
)
REQUIRED_KEYS = frozenset(
    {
        "version",
        "project_name",
        "token",
        "staged_database",
        "rollback_database",
        "phase",
        "backend_was_active",
    }
)


class JournalError(RuntimeError):
    """A journal cannot be handled without risking the active data."""


def _expected_database_names(token: str) -> tuple[str, str]:
    prefix = token[:16]
    return f"portfolio_restore_{prefix}", f"portfolio_rollback_{prefix}"


def validate_payload(payload: object, expected_project: str) -> dict[str, object]:
    if not PROJECT_PATTERN.fullmatch(expected_project):
        raise JournalError("invalid Compose project name")
    if not isinstance(payload, dict) or set(payload) != REQUIRED_KEYS:
        raise JournalError("journal has an invalid schema")
    if payload["version"] != VERSION:
        raise JournalError("journal has an unsupported version")
    if payload["project_name"] != expected_project:
        raise JournalError("journal belongs to a different Compose project")

    token = payload["token"]
    if not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token):
        raise JournalError("journal has an invalid restore token")
    expected_staged, expected_rollback = _expected_database_names(token)
    if payload["staged_database"] != expected_staged:
        raise JournalError("journal has an invalid staged database name")
    if payload["rollback_database"] != expected_rollback:
        raise JournalError("journal has an invalid rollback database name")
    if payload["phase"] not in PHASES:
        raise JournalError("journal has an invalid restore phase")
    if not isinstance(payload["backend_was_active"], bool):
        raise JournalError("journal has an invalid backend state")
    return payload


def _ensure_directory(directory: Path, *, create: bool) -> None:
    if create:
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    try:
        metadata = directory.lstat()
    except FileNotFoundError as error:
        raise JournalError("journal directory does not exist") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise JournalError("journal directory must be a real directory")
    if metadata.st_uid != os.getuid():
        raise JournalError("journal directory is not owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        try:
            directory.chmod(0o700)
        except OSError as error:
            raise JournalError("journal directory permissions could not be secured") from error
        if stat.S_IMODE(directory.lstat().st_mode) != 0o700:
            raise JournalError("journal directory permissions could not be secured")


def _ensure_file(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise JournalError("no interrupted restore journal exists") from error
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise JournalError("journal must be a regular file")
    if metadata.st_uid != os.getuid():
        raise JournalError("journal is not owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise JournalError("journal permissions must be 0600")
    if metadata.st_nlink != 1:
        raise JournalError("journal must not have additional hard links")


def _remove_stale_temporary_files(path: Path) -> None:
    prefix = f".{path.name}."
    removed = False
    for entry in path.parent.iterdir():
        if not entry.name.startswith(prefix):
            continue
        metadata = entry.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise JournalError("journal temporary file is unsafe")
        entry.unlink()
        removed = True
    if removed:
        _fsync_directory(path.parent)


def read_journal(path: Path, expected_project: str) -> dict[str, object]:
    _ensure_directory(path.parent, create=False)
    _remove_stale_temporary_files(path)
    _ensure_file(path)
    try:
        with path.open("r", encoding="ascii") as source:
            payload = json.load(source)
            if source.read(1) != "":
                raise JournalError("journal contains trailing data")
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise JournalError("journal is unreadable or corrupt") from error
    return validate_payload(payload, expected_project)


def _serialized(payload: dict[str, object]) -> bytes:
    return (json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n").encode(
        "ascii"
    )


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_replacement(path: Path, payload: dict[str, object]) -> None:
    _remove_stale_temporary_files(path)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            descriptor = -1
            output.write(_serialized(payload))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        _fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def create_journal(path: Path, project: str, token: str, phase: str) -> None:
    _ensure_directory(path.parent, create=True)
    if path.exists() or path.is_symlink():
        raise JournalError("an interrupted restore journal already exists; run --recover")
    staged_database, rollback_database = _expected_database_names(token)
    payload: dict[str, object] = {
        "version": VERSION,
        "project_name": project,
        "token": token,
        "staged_database": staged_database,
        "rollback_database": rollback_database,
        "phase": phase,
        "backend_was_active": False,
    }
    validate_payload(payload, project)
    # The project maintenance lock serializes creators. A same-directory
    # replacement gives crash atomicity without a transient second hard link.
    _write_replacement(path, payload)


def update_journal(
    path: Path,
    expected_project: str,
    phase: str,
    backend_was_active: bool | None,
) -> None:
    payload = read_journal(path, expected_project)
    payload["phase"] = phase
    if backend_was_active is not None:
        payload["backend_was_active"] = backend_was_active
    validate_payload(payload, expected_project)
    _write_replacement(path, payload)


def remove_journal(path: Path, expected_project: str) -> None:
    read_journal(path, expected_project)
    try:
        path.unlink()
        _fsync_directory(path.parent)
    except OSError as error:
        raise JournalError("journal could not be removed") from error


def journal_exists(path: Path) -> bool:
    if path.is_symlink():
        raise JournalError("journal path must not be a symbolic link")
    return path.exists()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--project", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--token", required=True)
    create.add_argument("--phase", required=True, choices=sorted(PHASES))

    update = subparsers.add_parser("update")
    update.add_argument("--phase", required=True, choices=sorted(PHASES))
    update.add_argument("--backend-was-active", choices=("true", "false"))

    subparsers.add_parser("read")
    subparsers.add_parser("remove")
    subparsers.add_parser("exists")
    return parser


def _die(message: str) -> NoReturn:
    print(f"restore-journal: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "create":
            create_journal(arguments.file, arguments.project, arguments.token, arguments.phase)
        elif arguments.command == "update":
            backend_was_active = (
                None
                if arguments.backend_was_active is None
                else arguments.backend_was_active == "true"
            )
            update_journal(
                arguments.file,
                arguments.project,
                arguments.phase,
                backend_was_active,
            )
        elif arguments.command == "read":
            payload = read_journal(arguments.file, arguments.project)
            print(
                "\t".join(
                    (
                        str(payload["token"]),
                        str(payload["staged_database"]),
                        str(payload["rollback_database"]),
                        str(payload["phase"]),
                        "true" if payload["backend_was_active"] else "false",
                    )
                )
            )
        elif arguments.command == "remove":
            remove_journal(arguments.file, arguments.project)
        elif arguments.command == "exists":
            raise SystemExit(0 if journal_exists(arguments.file) else 1)
        else:  # pragma: no cover - argparse rejects this path.
            raise AssertionError(f"unsupported command: {arguments.command}")
    except JournalError as error:
        _die(str(error))


if __name__ == "__main__":
    main()
