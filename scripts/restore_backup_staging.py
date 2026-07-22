#!/usr/bin/env python3
"""Create and remove a private, stable snapshot of restore backup inputs."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from typing import NoReturn


REQUIRED_FILES = ("database.dump", "uploads.tar", "manifest.txt", "SHA256SUMS")
OPTIONAL_FILES = ("SHA256SUMS.sig",)
ALLOWED_FILES = frozenset((*REQUIRED_FILES, *OPTIONAL_FILES))
STAGING_PREFIX = ".portfolio-restore-backup-"
PROJECT_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")


class StagingError(RuntimeError):
    """The backup cannot be staged without following an unsafe filesystem object."""


def _project_prefix(project: str) -> str:
    if not PROJECT_PATTERN.fullmatch(project):
        raise StagingError("invalid Compose project name")
    return f"{STAGING_PREFIX}{len(project)}-{project}-"


def _is_staging_name(name: str, prefix: str) -> bool:
    return name.startswith(prefix) and bool(
        re.fullmatch(r"[0-9a-f]{32}", name[len(prefix) :])
    )


def _directory_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    if not nofollow or not directory:
        raise StagingError("this platform does not support secure directory opening")
    return os.O_RDONLY | nofollow | directory | getattr(os, "O_CLOEXEC", 0)


def _file_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not nofollow:
        raise StagingError("this platform does not support no-follow file opening")
    return (
        os.O_RDONLY
        | nofollow
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _validate_private_directory(metadata: os.stat_result, description: str) -> None:
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise StagingError(f"{description} must be a real directory")
    if metadata.st_uid != os.getuid():
        raise StagingError(f"{description} is not owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        raise StagingError(f"{description} permissions must be 0700")


def _ensure_private_parent(path: Path) -> int:
    try:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        metadata = path.lstat()
    except OSError as error:
        raise StagingError("staging parent could not be created or inspected") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise StagingError("staging parent must be a real directory")
    if metadata.st_uid != os.getuid():
        raise StagingError("staging parent is not owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        try:
            path.chmod(0o700)
            metadata = path.lstat()
        except OSError as error:
            raise StagingError("staging parent permissions could not be secured") from error
    _validate_private_directory(metadata, "staging parent")
    try:
        descriptor = os.open(path, _directory_flags())
    except OSError as error:
        raise StagingError("staging parent could not be opened safely") from error
    try:
        _validate_private_directory(os.fstat(descriptor), "staging parent")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def _open_source_directory(path: Path) -> int:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise StagingError("backup directory does not exist or cannot be inspected") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise StagingError("backup path must be a real directory, not a symbolic link")
    try:
        descriptor = os.open(path, _directory_flags())
    except OSError as error:
        raise StagingError("backup directory could not be opened safely") from error
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
        metadata.st_dev,
        metadata.st_ino,
    ):
        os.close(descriptor)
        raise StagingError("backup directory changed while it was being opened")
    return descriptor


def _validate_source_file(metadata: os.stat_result, name: str) -> None:
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise StagingError(f"required backup input must be a regular file: {name}")
    if metadata.st_nlink != 1:
        raise StagingError(f"required backup input must have exactly one hard link: {name}")


def _stable_metadata(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _copy_required_file(source_directory: int, staging_directory: int, name: str) -> None:
    try:
        before = os.stat(name, dir_fd=source_directory, follow_symlinks=False)
    except OSError as error:
        raise StagingError(f"required backup input is missing or unreadable: {name}") from error
    _validate_source_file(before, name)

    try:
        source = os.open(name, _file_flags(), dir_fd=source_directory)
    except OSError as error:
        raise StagingError(f"required backup input could not be opened safely: {name}") from error
    destination = -1
    try:
        opened = os.fstat(source)
        _validate_source_file(opened, name)
        if _stable_metadata(opened) != _stable_metadata(before):
            raise StagingError(f"required backup input changed while it was being opened: {name}")

        destination = os.open(
            name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=staging_directory,
        )
        copied = 0
        while True:
            block = os.read(source, 1024 * 1024)
            if not block:
                break
            view = memoryview(block)
            while view:
                written = os.write(destination, view)
                if written <= 0:
                    raise StagingError(f"backup input copy made no progress: {name}")
                copied += written
                view = view[written:]
        after = os.fstat(source)
        _validate_source_file(after, name)
        if _stable_metadata(after) != _stable_metadata(opened) or copied != opened.st_size:
            raise StagingError(f"required backup input changed while it was being copied: {name}")
        os.fchmod(destination, 0o400)
        os.fsync(destination)
        if stat.S_IMODE(os.fstat(destination).st_mode) != 0o400:
            raise StagingError(f"staged backup input permissions could not be secured: {name}")
    except OSError as error:
        raise StagingError(f"required backup input could not be copied safely: {name}") from error
    finally:
        if destination >= 0:
            os.close(destination)
        os.close(source)


def _copy_optional_file(source_directory: int, staging_directory: int, name: str) -> None:
    try:
        os.stat(name, dir_fd=source_directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError as error:
        raise StagingError(f"optional backup input could not be inspected: {name}") from error
    _copy_required_file(source_directory, staging_directory, name)


def _new_staging_directory(parent: int, prefix: str) -> tuple[str, int]:
    for _ in range(128):
        name = f"{prefix}{secrets.token_hex(16)}"
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            continue
        try:
            descriptor = os.open(name, _directory_flags(), dir_fd=parent)
            _validate_private_directory(os.fstat(descriptor), "backup staging directory")
        except Exception:
            try:
                os.rmdir(name, dir_fd=parent)
            except OSError:
                pass
            raise
        return name, descriptor
    raise StagingError("a unique backup staging directory could not be created")


def _discard_open_staging(parent: int, name: str, staging: int) -> None:
    try:
        for entry in os.listdir(staging):
            try:
                os.unlink(entry, dir_fd=staging)
            except OSError:
                pass
    finally:
        os.close(staging)
        try:
            os.rmdir(name, dir_fd=parent)
            os.fsync(parent)
        except OSError:
            pass


def stage_backup(backup: Path, staging_parent: Path, project: str) -> Path:
    backup = Path(os.path.abspath(backup))
    staging_parent = Path(os.path.abspath(staging_parent))
    prefix = _project_prefix(project)
    source = _open_source_directory(backup)
    parent = _ensure_private_parent(staging_parent)
    staging_name = ""
    staging = -1
    try:
        staging_name, staging = _new_staging_directory(parent, prefix)
        try:
            for name in REQUIRED_FILES:
                _copy_required_file(source, staging, name)
            for name in OPTIONAL_FILES:
                _copy_optional_file(source, staging, name)
            os.fsync(staging)
            return staging_parent / staging_name
        except Exception:
            _discard_open_staging(parent, staging_name, staging)
            staging = -1
            raise
    finally:
        if staging >= 0:
            os.close(staging)
        os.close(parent)
        os.close(source)


def _remove_staging_entry(parent: int, name: str) -> None:
    staging = -1
    try:
        try:
            staging = os.open(name, _directory_flags(), dir_fd=parent)
        except FileNotFoundError:
            return
        except OSError as error:
            raise StagingError("backup staging directory could not be opened safely") from error
        _validate_private_directory(os.fstat(staging), "backup staging directory")
        entries = set(os.listdir(staging))
        if not entries.issubset(ALLOWED_FILES):
            raise StagingError("backup staging directory contains unexpected entries")
        for entry in entries:
            metadata = os.stat(entry, dir_fd=staging, follow_symlinks=False)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or metadata.st_nlink != 1
                or stat.S_IMODE(metadata.st_mode) not in (0o400, 0o600)
            ):
                raise StagingError(f"staged backup input is unsafe: {entry}")
        for entry in entries:
            os.unlink(entry, dir_fd=staging)
        os.fsync(staging)
        os.close(staging)
        staging = -1
        os.rmdir(name, dir_fd=parent)
        os.fsync(parent)
    except OSError as error:
        raise StagingError("backup staging directory could not be removed safely") from error
    finally:
        if staging >= 0:
            os.close(staging)


def remove_staging(path: Path, staging_parent: Path, project: str) -> None:
    path = Path(os.path.abspath(path))
    staging_parent = Path(os.path.abspath(staging_parent))
    prefix = _project_prefix(project)
    if path.parent != staging_parent or not _is_staging_name(path.name, prefix):
        raise StagingError("refusing to remove a path outside the staging parent")

    parent = _ensure_private_parent(staging_parent)
    try:
        _remove_staging_entry(parent, path.name)
    finally:
        os.close(parent)


def remove_stale_staging(staging_parent: Path, project: str) -> None:
    staging_parent = Path(os.path.abspath(staging_parent))
    prefix = _project_prefix(project)
    parent = _ensure_private_parent(staging_parent)
    try:
        for name in os.listdir(parent):
            if _is_staging_name(name, prefix):
                _remove_staging_entry(parent, name)
    finally:
        os.close(parent)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    stage = subparsers.add_parser("stage")
    stage.add_argument("--backup", type=Path, required=True)
    stage.add_argument("--staging-parent", type=Path, required=True)
    stage.add_argument("--project", required=True)
    remove = subparsers.add_parser("remove")
    remove.add_argument("--staging", type=Path, required=True)
    remove.add_argument("--staging-parent", type=Path, required=True)
    remove.add_argument("--project", required=True)
    stale = subparsers.add_parser("remove-stale")
    stale.add_argument("--staging-parent", type=Path, required=True)
    stale.add_argument("--project", required=True)
    return parser


def _die(message: str) -> NoReturn:
    print(f"restore-backup-staging: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "stage":
            staged = stage_backup(arguments.backup, arguments.staging_parent, arguments.project)
            print(staged)
        elif arguments.command == "remove":
            remove_staging(arguments.staging, arguments.staging_parent, arguments.project)
        else:
            remove_stale_staging(arguments.staging_parent, arguments.project)
    except (StagingError, OSError) as error:
        _die(str(error))


if __name__ == "__main__":
    main()
