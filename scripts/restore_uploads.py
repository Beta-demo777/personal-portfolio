"""Create, validate, and transactionally replace the uploads archive.

Staging and rollback data live below the uploads mount so archives larger than
the container's /tmp tmpfs never pass through /tmp.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import errno
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
from typing import BinaryIO, Callable, NoReturn


UPLOAD_ROOT = Path("/app/uploads")
UPLOAD_FILENAME = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp|gif)$")
UPLOAD_TEMP_FILENAME = re.compile(r"^\.upload-[A-Za-z0-9_-]+\.tmp$")
TOKEN_PATTERN = re.compile(r"^[0-9a-f]{32}$")
TRANSACTION_PREFIX = ".portfolio-restore-"
MAX_ARCHIVE_ENTRIES = 10_001  # One optional root plus up to 10,000 images.
MAX_MEDIA_FILES = 10_000
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_MTIME = 4_102_444_800  # 2100-01-01T00:00:00Z
COPY_CHUNK_BYTES = 1024 * 1024
MIN_FREE_BYTES_AFTER_STAGE = 256 * 1024 * 1024
MIN_FREE_INODES_AFTER_STAGE = 128
DIRECTORY_FSYNC_UNSUPPORTED_ERRNOS = frozenset(
    {
        errno.EINVAL,
        getattr(errno, "ENOTSUP", errno.EINVAL),
        getattr(errno, "EOPNOTSUPP", errno.EINVAL),
    }
)


@dataclass(frozen=True)
class ArchiveSummary:
    files: int
    total_bytes: int


@dataclass(frozen=True)
class TransactionPaths:
    stage: Path
    rollback: Path
    commit_cleanup: Path
    rollback_cleanup: Path
    old: Path
    state: Path
    state_temporary: Path


@dataclass(frozen=True)
class FilesystemCapacity:
    device_id: int
    total_bytes: int
    available_bytes: int
    available_inodes: int


FailureHook = Callable[[str], None]


def _is_regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def transaction_paths(root: Path, token: str) -> TransactionPaths:
    if not TOKEN_PATTERN.fullmatch(token):
        raise ValueError("restore token must contain exactly 32 lowercase hex characters")
    base = f"{TRANSACTION_PREFIX}{token}"
    rollback = root / f"{base}.rollback"
    return TransactionPaths(
        stage=root / f"{base}.stage",
        rollback=rollback,
        commit_cleanup=root / f"{base}.cleanup-commit",
        rollback_cleanup=root / f"{base}.cleanup-rollback",
        old=rollback / "old",
        state=rollback / "state.json",
        state_temporary=rollback / "state.json.tmp",
    )


def validated_filename(member: tarfile.TarInfo) -> str | None:
    path = PurePosixPath(member.name)
    if member.name in (".", "./"):
        if not member.isdir():
            raise ValueError("archive root entry must be a directory")
        return None
    if path.is_absolute() or len(path.parts) != 1 or ".." in path.parts:
        raise ValueError(f"unsafe archive path: {member.name!r}")
    filename = path.parts[0]
    if not member.isfile() or not UPLOAD_FILENAME.fullmatch(filename):
        raise ValueError(f"unsupported archive entry: {member.name!r}")
    if member.size < 0:
        raise ValueError(f"archive entry has a negative size: {filename!r}")
    if not 0 <= int(member.mtime) <= MAX_MTIME:
        raise ValueError(f"archive entry has an unsupported mtime: {filename!r}")
    return filename


def _copy_member(source: BinaryIO, output: BinaryIO | None, expected: int) -> None:
    copied = 0
    while copied < expected:
        chunk = source.read(min(COPY_CHUNK_BYTES, expected - copied))
        if not chunk:
            break
        copied += len(chunk)
        if output is not None:
            output.write(chunk)
    if copied != expected:
        raise ValueError(f"archive entry is truncated: expected {expected} bytes, read {copied}")


def read_archive(archive_file: BinaryIO, destination: Path | None = None) -> ArchiveSummary:
    """Validate every member and optionally extract it into an empty directory."""

    entries = 0
    total_bytes = 0
    filenames: set[str] = set()
    root_seen = False

    with tarfile.open(fileobj=archive_file, mode="r|*") as archive:
        for member in archive:
            entries += 1
            if entries > MAX_ARCHIVE_ENTRIES:
                raise ValueError("uploads archive contains too many entries")
            filename = validated_filename(member)
            if filename is None:
                if root_seen:
                    raise ValueError("uploads archive contains duplicate root entries")
                root_seen = True
                continue
            if filename in filenames:
                raise ValueError(f"duplicate archive entry: {filename!r}")
            filenames.add(filename)
            if len(filenames) > MAX_MEDIA_FILES:
                raise ValueError("uploads archive contains too many media files")
            total_bytes += member.size
            if total_bytes > MAX_TOTAL_BYTES:
                raise ValueError("uploads archive declares too much data")

            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"cannot read archive entry: {filename!r}")
            with source:
                if destination is None:
                    _copy_member(source, None, member.size)
                    continue
                target = destination / filename
                with target.open("xb") as output:
                    _copy_member(source, output, member.size)
                    output.flush()
                    os.fsync(output.fileno())
                target.chmod(0o644)
                os.utime(target, (int(member.mtime), int(member.mtime)))

    return ArchiveSummary(files=len(filenames), total_bytes=total_bytes)


def filesystem_capacity(path: Path) -> FilesystemCapacity:
    statistics = os.statvfs(path)
    fragment_size = statistics.f_frsize or statistics.f_bsize
    return FilesystemCapacity(
        device_id=path.stat().st_dev,
        total_bytes=statistics.f_blocks * fragment_size,
        available_bytes=statistics.f_bavail * fragment_size,
        available_inodes=statistics.f_favail,
    )


def ensure_archive_capacity(
    root: Path,
    summary: ArchiveSummary,
    *,
    capacity: FilesystemCapacity | None = None,
) -> FilesystemCapacity:
    """Require room for staged media while the existing live set remains present."""

    current = capacity or filesystem_capacity(root)
    proportional_reserve = (current.total_bytes + 19) // 20  # Keep at least 5% free.
    reserve_bytes = max(MIN_FREE_BYTES_AFTER_STAGE, proportional_reserve)
    required_bytes = summary.total_bytes + reserve_bytes
    required_inodes = summary.files + MIN_FREE_INODES_AFTER_STAGE

    if current.available_bytes < required_bytes:
        raise RuntimeError(
            "uploads volume has insufficient free space for staged media and safety reserve"
        )
    if current.available_inodes < required_inodes:
        raise RuntimeError(
            "uploads volume has insufficient free inodes for staged media and rollback state"
        )
    return current


def preflight_archive_capacity(
    root: Path,
    archive_file: BinaryIO,
    *,
    capacity: FilesystemCapacity | None = None,
) -> tuple[ArchiveSummary, FilesystemCapacity]:
    """Validate an archive and its capacity requirements without writing to the volume."""

    summary = read_archive(archive_file)
    current = ensure_archive_capacity(root, summary, capacity=capacity)
    return summary, current


def _archive_entry(archive: tarfile.TarFile, path: Path) -> int:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"upload is not a regular file: {path.name!r}")
        member = tarfile.TarInfo(path.name)
        member.size = before.st_size
        member.mtime = int(before.st_mtime)
        member.mode = 0o644
        member.uid = 0
        member.gid = 0
        member.uname = ""
        member.gname = ""
        with os.fdopen(os.dup(descriptor), "rb") as source:
            archive.addfile(member, source)
        after = os.fstat(descriptor)
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError(f"upload changed while it was being archived: {path.name!r}")
        return before.st_size
    finally:
        os.close(descriptor)


def create_archive(root: Path, output: BinaryIO) -> ArchiveSummary:
    """Archive final media only; known upload temp files are intentionally omitted."""

    root.mkdir(parents=True, exist_ok=True)
    media: list[Path] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        if UPLOAD_TEMP_FILENAME.fullmatch(entry.name) and _is_regular_file(entry):
            continue
        if entry.name.startswith(TRANSACTION_PREFIX):
            raise RuntimeError(
                f"unfinished uploads restore transaction found: {entry.name!r}; "
                "finish or roll it back before taking a backup"
            )
        if not UPLOAD_FILENAME.fullmatch(entry.name):
            raise ValueError(f"unsupported entry in uploads directory: {entry.name!r}")
        if not _is_regular_file(entry):
            raise ValueError(f"upload is not a regular file: {entry.name!r}")
        media.append(entry)

    if len(media) > MAX_MEDIA_FILES:
        raise ValueError("uploads directory contains too many media files")

    total_bytes = 0
    with tarfile.open(fileobj=output, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
        for path in media:
            total_bytes += path.lstat().st_size
            if total_bytes > MAX_TOTAL_BYTES:
                raise ValueError("uploads directory contains too much data")
            archived_bytes = _archive_entry(archive, path)
            if archived_bytes != path.lstat().st_size:
                raise RuntimeError(f"upload size changed while archiving: {path.name!r}")

    return ArchiveSummary(files=len(media), total_bytes=total_bytes)


def stage_archive(root: Path, token: str, archive_file: BinaryIO) -> ArchiveSummary:
    root.mkdir(parents=True, exist_ok=True)
    paths = transaction_paths(root, token)
    for entry in root.iterdir():
        if entry.name.startswith(TRANSACTION_PREFIX):
            raise RuntimeError(f"another uploads restore transaction exists: {entry.name!r}")
    if paths.stage.exists() or paths.rollback.exists():
        raise FileExistsError(f"restore transaction already exists for token {token}")
    stage_created = False
    try:
        stage_created = _mkdir_durable(paths.stage, mode=0o700)
        summary = read_archive(archive_file, paths.stage)
        _fsync_directory(paths.stage)
        return summary
    except BaseException:
        if stage_created:
            _cleanup_tree_after_error(paths.stage)
        raise


def _write_state(paths: TransactionPaths, old_names: list[str], new_names: list[str]) -> None:
    payload = {"version": 1, "old_names": old_names, "new_names": new_names}
    with paths.state_temporary.open("x", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=True, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    _replace_durable(paths.state_temporary, paths.state)


def _fsync_directory(directory: Path) -> None:
    # Windows does not expose a portable way to open and fsync a directory.
    if os.name == "nt":  # pragma: no cover - production restore runs on Linux.
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(directory, flags)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in DIRECTORY_FSYNC_UNSUPPORTED_ERRNOS:
                raise
    finally:
        os.close(descriptor)


def _fsync_directories(*directories: Path) -> None:
    first_error: OSError | None = None
    seen: set[Path] = set()
    for directory in directories:
        if directory in seen:
            continue
        seen.add(directory)
        try:
            _fsync_directory(directory)
        except OSError as error:
            # A cross-directory rename changes both namespaces. Try to persist
            # both sides even when syncing the first directory fails.
            if first_error is None:
                first_error = error
    if first_error is not None:
        raise first_error


def _mkdir_durable(directory: Path, *, mode: int, exist_ok: bool = False) -> bool:
    try:
        directory.mkdir(mode=mode)
    except FileExistsError:
        if not exist_ok or not directory.is_dir() or directory.is_symlink():
            raise
        return False
    try:
        _fsync_directory(directory.parent)
    except OSError:
        # Do not leave a newly created but unconfirmed namespace entry behind.
        try:
            directory.rmdir()
            _fsync_directory(directory.parent)
        except OSError:
            pass
        raise
    return True


def _replace_durable(source: Path, destination: Path) -> None:
    os.replace(source, destination)
    _fsync_directories(source.parent, destination.parent)


def _remove_tree_durable(directory: Path) -> None:
    parent = directory.parent
    shutil.rmtree(directory)
    _fsync_directory(parent)


def _remove_real_tree_durable(directory: Path, description: str) -> None:
    if not directory.exists() and not directory.is_symlink():
        return
    if not directory.is_dir() or directory.is_symlink():
        raise RuntimeError(f"{description} is not a real directory")
    _remove_tree_durable(directory)


def _publish_cleanup_tombstone(source: Path, tombstone: Path, description: str) -> None:
    """Publish a completed outcome before recursively removing its authority data."""

    if not source.is_dir() or source.is_symlink():
        raise RuntimeError(f"{description} source is not a real directory")
    if tombstone.exists() or tombstone.is_symlink():
        raise RuntimeError(f"{description} already exists")
    _replace_durable(source, tombstone)


def _cleanup_tree_after_error(directory: Path) -> None:
    """Best-effort cleanup without replacing the operation's original error."""

    shutil.rmtree(directory, ignore_errors=True)
    try:
        _fsync_directory(directory.parent)
    except OSError:
        pass


def _read_state(paths: TransactionPaths) -> tuple[list[str], list[str]]:
    with paths.state.open(encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("version") != 1:
        raise ValueError("unsupported uploads restore transaction state")
    old_names = payload.get("old_names")
    new_names = payload.get("new_names")
    if not isinstance(old_names, list) or not isinstance(new_names, list):
        raise ValueError("invalid uploads restore transaction state")
    for name in [*old_names, *new_names]:
        if not isinstance(name, str) or name in ("", ".", "..") or "/" in name or "\0" in name:
            raise ValueError("unsafe name in uploads restore transaction state")
    return old_names, new_names


def _checkpoint(hook: FailureHook | None, name: str) -> None:
    if hook is not None:
        hook(name)


def activate_staged_archive(
    root: Path,
    token: str,
    *,
    failure_hook: FailureHook | None = None,
) -> None:
    """Activate staged files while retaining enough state for rollback."""

    paths = transaction_paths(root, token)
    if (
        not paths.stage.is_dir()
        or paths.stage.is_symlink()
        or paths.rollback.exists()
        or paths.rollback.is_symlink()
        or paths.commit_cleanup.exists()
        or paths.commit_cleanup.is_symlink()
        or paths.rollback_cleanup.exists()
        or paths.rollback_cleanup.is_symlink()
    ):
        raise RuntimeError("uploads restore transaction is not in the staged state")

    new_names = sorted(entry.name for entry in paths.stage.iterdir())
    for name in new_names:
        entry = paths.stage / name
        if not UPLOAD_FILENAME.fullmatch(name) or not _is_regular_file(entry):
            raise ValueError(f"invalid staged upload: {name!r}")

    old_names: list[str] = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        if entry == paths.stage:
            continue
        if entry.name.startswith(TRANSACTION_PREFIX):
            raise RuntimeError(f"another uploads restore transaction exists: {entry.name!r}")
        old_names.append(entry.name)

    rollback_created = False
    try:
        rollback_created = _mkdir_durable(paths.rollback, mode=0o700)
        _mkdir_durable(paths.old, mode=0o700)
        _write_state(paths, old_names, new_names)
    except BaseException:
        if rollback_created:
            _cleanup_tree_after_error(paths.rollback)
        raise

    try:
        for name in old_names:
            _replace_durable(root / name, paths.old / name)
        _checkpoint(failure_hook, "after_old_media_moved")
        for name in new_names:
            _replace_durable(paths.stage / name, root / name)
        _checkpoint(failure_hook, "after_new_media_moved")
    except BaseException:
        rollback_active_archive(root, token)
        raise


def rollback_active_archive(root: Path, token: str) -> None:
    paths = transaction_paths(root, token)
    if not paths.rollback.is_dir() or not paths.state.is_file() or not paths.old.is_dir():
        raise RuntimeError("uploads restore transaction has no rollback state")
    if (
        paths.rollback.is_symlink()
        or paths.state.is_symlink()
        or paths.old.is_symlink()
        or paths.commit_cleanup.exists()
        or paths.commit_cleanup.is_symlink()
        or paths.rollback_cleanup.exists()
        or paths.rollback_cleanup.is_symlink()
    ):
        raise RuntimeError("uploads restore transaction has invalid rollback state")
    old_names, new_names = _read_state(paths)

    _mkdir_durable(paths.stage, mode=0o700, exist_ok=True)
    old_name_set = set(old_names)
    for name in new_names:
        active = root / name
        staged = paths.stage / name
        saved_old = paths.old / name
        active_exists = active.exists() or active.is_symlink()
        staged_exists = staged.exists() or staged.is_symlink()
        old_was_moved = saved_old.exists() or saved_old.is_symlink()
        if active_exists and name in old_name_set and not old_was_moved:
            # Activation failed before this original entry was moved.
            continue
        if active_exists:
            if staged_exists:
                raise RuntimeError(f"cannot roll back upload because staging target exists: {name!r}")
            _replace_durable(active, staged)
    for name in old_names:
        saved = paths.old / name
        target = root / name
        saved_exists = saved.exists() or saved.is_symlink()
        target_exists = target.exists() or target.is_symlink()
        if saved_exists:
            if target_exists:
                raise RuntimeError(f"cannot overwrite entry while rolling back uploads: {name!r}")
            _replace_durable(saved, target)
        elif not target_exists:
            raise RuntimeError(f"cannot roll back missing original upload entry: {name!r}")

    # From this rename onward the outcome marker, not state.json/old, is the
    # durable authority. Recursive cleanup can therefore resume from any point.
    _publish_cleanup_tombstone(
        paths.rollback,
        paths.rollback_cleanup,
        "uploads restore rollback cleanup tombstone",
    )
    _remove_real_tree_durable(paths.stage, "uploads restore staging path")
    _remove_real_tree_durable(
        paths.rollback_cleanup,
        "uploads restore rollback cleanup tombstone",
    )


def finalize_active_archive(root: Path, token: str) -> None:
    paths = transaction_paths(root, token)
    if (
        not paths.rollback.is_dir()
        or not paths.state.is_file()
        or not paths.old.is_dir()
    ):
        raise RuntimeError("uploads restore transaction is not active")
    if (
        paths.rollback.is_symlink()
        or paths.state.is_symlink()
        or paths.old.is_symlink()
        or paths.commit_cleanup.exists()
        or paths.commit_cleanup.is_symlink()
        or paths.rollback_cleanup.exists()
        or paths.rollback_cleanup.is_symlink()
    ):
        raise RuntimeError("uploads restore transaction has invalid active state")
    _read_state(paths)
    # Keep rollback authoritative until staging cleanup has durably completed.
    _remove_real_tree_durable(paths.stage, "uploads restore staging path")
    _publish_cleanup_tombstone(
        paths.rollback,
        paths.commit_cleanup,
        "uploads restore commit cleanup tombstone",
    )
    _remove_real_tree_durable(
        paths.commit_cleanup,
        "uploads restore commit cleanup tombstone",
    )


def discard_staged_archive(root: Path, token: str) -> None:
    paths = transaction_paths(root, token)
    if (
        paths.rollback.exists()
        or paths.rollback.is_symlink()
        or paths.commit_cleanup.exists()
        or paths.commit_cleanup.is_symlink()
        or paths.rollback_cleanup.exists()
        or paths.rollback_cleanup.is_symlink()
    ):
        raise RuntimeError("cannot discard an active uploads restore transaction; roll it back")
    _remove_real_tree_durable(paths.stage, "uploads restore staging path")


def _validate_transaction_entries(root: Path, paths: TransactionPaths) -> None:
    expected = {
        paths.stage.name,
        paths.rollback.name,
        paths.commit_cleanup.name,
        paths.rollback_cleanup.name,
    }
    for entry in root.iterdir():
        if entry.name.startswith(TRANSACTION_PREFIX) and entry.name not in expected:
            raise RuntimeError(f"another uploads restore transaction exists: {entry.name!r}")


def _cleanup_tombstone_exists(tombstone: Path, description: str) -> bool:
    if not tombstone.exists() and not tombstone.is_symlink():
        return False
    if not tombstone.is_dir() or tombstone.is_symlink():
        raise RuntimeError(f"{description} is not a real directory")
    return True


def _validate_single_cleanup_outcome(
    paths: TransactionPaths,
    *,
    expected: Path,
    unexpected: Path,
    outcome: str,
) -> bool:
    expected_exists = _cleanup_tombstone_exists(
        expected,
        f"uploads restore {outcome} cleanup tombstone",
    )
    unexpected_exists = _cleanup_tombstone_exists(
        unexpected,
        "uploads restore cleanup tombstone for the opposite outcome",
    )
    if unexpected_exists:
        raise RuntimeError(f"uploads restore cleanup outcome does not match {outcome}")
    if expected_exists and (paths.rollback.exists() or paths.rollback.is_symlink()):
        raise RuntimeError("uploads restore transaction has ambiguous cleanup state")
    return expected_exists


def _finish_rollback_cleanup(paths: TransactionPaths) -> None:
    _remove_real_tree_durable(paths.stage, "uploads restore staging path")
    _remove_real_tree_durable(
        paths.rollback_cleanup,
        "uploads restore rollback cleanup tombstone",
    )


def _finish_commit_cleanup(paths: TransactionPaths) -> None:
    if paths.stage.exists() or paths.stage.is_symlink():
        raise RuntimeError("committed uploads restore has staging data during cleanup")
    _remove_real_tree_durable(
        paths.commit_cleanup,
        "uploads restore commit cleanup tombstone",
    )


def _discard_unstarted_activation(paths: TransactionPaths) -> None:
    if (
        not paths.stage.is_dir()
        or paths.stage.is_symlink()
        or not paths.rollback.is_dir()
        or paths.rollback.is_symlink()
        or not paths.old.is_dir()
        or paths.old.is_symlink()
    ):
        raise RuntimeError("uploads restore transaction has incomplete rollback state")
    if paths.state.exists() or paths.state.is_symlink():
        raise RuntimeError("uploads restore transaction state is ambiguous")
    rollback_entries = {entry.name for entry in paths.rollback.iterdir()}
    if not rollback_entries.issubset({paths.old.name, paths.state_temporary.name}):
        raise RuntimeError("uploads restore transaction has unexpected rollback entries")
    if any(paths.old.iterdir()):
        raise RuntimeError("uploads restore transaction is missing state after media moved")
    if (
        paths.state_temporary.exists()
        or paths.state_temporary.is_symlink()
    ) and not _is_regular_file(paths.state_temporary):
        raise RuntimeError("uploads restore temporary state is not a regular file")
    _publish_cleanup_tombstone(
        paths.rollback,
        paths.rollback_cleanup,
        "uploads restore rollback cleanup tombstone",
    )
    _finish_rollback_cleanup(paths)


def recover_rollback_archive(root: Path, token: str) -> None:
    """Idempotently converge an interrupted transaction back to the old media."""

    root.mkdir(parents=True, exist_ok=True)
    paths = transaction_paths(root, token)
    _validate_transaction_entries(root, paths)
    if _validate_single_cleanup_outcome(
        paths,
        expected=paths.rollback_cleanup,
        unexpected=paths.commit_cleanup,
        outcome="rollback",
    ):
        _finish_rollback_cleanup(paths)
        return
    if paths.rollback.exists() or paths.rollback.is_symlink():
        if not paths.rollback.is_dir() or paths.rollback.is_symlink():
            raise RuntimeError("uploads restore rollback path is not a real directory")
        if (
            paths.state.is_file()
            and not paths.state.is_symlink()
            and paths.old.is_dir()
            and not paths.old.is_symlink()
        ):
            rollback_active_archive(root, token)
        elif not paths.state.exists() and not paths.state.is_symlink():
            _discard_unstarted_activation(paths)
        else:
            raise RuntimeError("uploads restore transaction has invalid rollback state")
    elif paths.stage.exists() or paths.stage.is_symlink():
        if not paths.stage.is_dir() or paths.stage.is_symlink():
            raise RuntimeError("uploads restore staging path is not a real directory")
        discard_staged_archive(root, token)


def recover_commit_archive(root: Path, token: str) -> None:
    """Idempotently finish media cleanup after a restore has committed."""

    root.mkdir(parents=True, exist_ok=True)
    paths = transaction_paths(root, token)
    _validate_transaction_entries(root, paths)
    if _validate_single_cleanup_outcome(
        paths,
        expected=paths.commit_cleanup,
        unexpected=paths.rollback_cleanup,
        outcome="commit",
    ):
        _finish_commit_cleanup(paths)
        return
    if paths.rollback.exists() or paths.rollback.is_symlink():
        if (
            not paths.rollback.is_dir()
            or paths.rollback.is_symlink()
            or not paths.state.is_file()
            or paths.state.is_symlink()
            or not paths.old.is_dir()
            or paths.old.is_symlink()
        ):
            raise RuntimeError("committed uploads restore has invalid rollback state")
        finalize_active_archive(root, token)
    elif paths.stage.exists() or paths.stage.is_symlink():
        raise RuntimeError("committed uploads restore has staging data without rollback state")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=UPLOAD_ROOT)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("create", help="write an uploads tar archive to stdout")
    validate = subparsers.add_parser("validate", help="validate an uploads tar archive")
    validate.add_argument("--archive", type=Path, help="archive path; defaults to stdin")
    subparsers.add_parser(
        "preflight-capacity",
        help="validate an uploads archive and check volume capacity without writing",
    )
    for command in (
        "stage",
        "activate",
        "rollback",
        "finalize",
        "discard",
        "recover-rollback",
        "recover-commit",
    ):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("--token", required=True)
    return parser


def _die(message: str) -> NoReturn:
    print(f"restore_uploads: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    arguments = _parser().parse_args()
    root = arguments.root.resolve()
    try:
        if arguments.command == "create":
            summary = create_archive(root, sys.stdout.buffer)
        elif arguments.command == "validate":
            if arguments.archive is None:
                summary = read_archive(sys.stdin.buffer)
            else:
                with arguments.archive.open("rb") as source:
                    summary = read_archive(source)
        elif arguments.command == "preflight-capacity":
            summary, capacity = preflight_archive_capacity(root, sys.stdin.buffer)
        elif arguments.command == "stage":
            summary = stage_archive(root, arguments.token, sys.stdin.buffer)
        elif arguments.command == "activate":
            activate_staged_archive(root, arguments.token)
            return
        elif arguments.command == "rollback":
            rollback_active_archive(root, arguments.token)
            return
        elif arguments.command == "finalize":
            finalize_active_archive(root, arguments.token)
            return
        elif arguments.command == "discard":
            discard_staged_archive(root, arguments.token)
            return
        elif arguments.command == "recover-rollback":
            recover_rollback_archive(root, arguments.token)
            return
        elif arguments.command == "recover-commit":
            recover_commit_archive(root, arguments.token)
            return
        else:  # pragma: no cover - argparse rejects this path.
            raise AssertionError(f"unsupported command: {arguments.command}")
    except (OSError, tarfile.TarError, ValueError, RuntimeError) as error:
        _die(str(error))
    if arguments.command == "preflight-capacity":
        # Machine-readable output consumed by restore.sh for shared-volume planning.
        print(
            capacity.device_id,
            capacity.total_bytes,
            capacity.available_bytes,
            capacity.available_inodes,
            summary.total_bytes,
            summary.files,
        )
    print(f"files={summary.files} bytes={summary.total_bytes}", file=sys.stderr)


if __name__ == "__main__":
    main()
