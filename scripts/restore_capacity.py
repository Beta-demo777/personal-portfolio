"""Conservative capacity planning for an isolated PostgreSQL restore."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import sys
from typing import NoReturn, Sequence


DATABASE_EXPANSION_AND_WAL_FACTOR = 4
MIN_DATABASE_RESERVE_BYTES = 512 * 1024 * 1024
MIN_DATABASE_RESERVE_INODES = 4_096
INODES_PER_TOC_ENTRY = 8
RELATION_SEGMENT_BYTES = 1024 * 1024 * 1024
INODES_PER_ESTIMATED_SEGMENT = 32
FILESYSTEM_FREE_COMPARISON_TOLERANCE_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class DatabaseCapacityRequirement:
    required_bytes: int
    required_inodes: int


def database_capacity_requirement(
    *,
    dump_bytes: int,
    plain_bytes: int,
    toc_entries: int,
    filesystem_total_bytes: int,
) -> DatabaseCapacityRequirement:
    for label, value in (
        ("dump bytes", dump_bytes),
        ("plain restore bytes", plain_bytes),
        ("TOC entries", toc_entries),
        ("filesystem total bytes", filesystem_total_bytes),
    ):
        if value < 0:
            raise ValueError(f"{label} must not be negative")
    if filesystem_total_bytes == 0:
        raise ValueError("filesystem total bytes must be positive")

    restored_bytes = max(dump_bytes, plain_bytes)
    proportional_reserve = (filesystem_total_bytes + 19) // 20  # Keep at least 5% free.
    reserve_bytes = max(MIN_DATABASE_RESERVE_BYTES, proportional_reserve)
    required_bytes = restored_bytes * DATABASE_EXPANSION_AND_WAL_FACTOR + reserve_bytes

    estimated_segments = (restored_bytes + RELATION_SEGMENT_BYTES - 1) // RELATION_SEGMENT_BYTES
    required_inodes = max(
        MIN_DATABASE_RESERVE_INODES,
        toc_entries * INODES_PER_TOC_ENTRY
        + estimated_segments * INODES_PER_ESTIMATED_SEGMENT,
    )
    return DatabaseCapacityRequirement(
        required_bytes=required_bytes,
        required_inodes=required_inodes,
    )


def ensure_database_capacity(
    requirement: DatabaseCapacityRequirement,
    *,
    available_bytes: int,
    available_inodes: int,
) -> None:
    if available_bytes < requirement.required_bytes:
        raise RuntimeError(
            "PostgreSQL volume has insufficient free space for the staged database, "
            "indexes, WAL, and safety reserve"
        )
    if available_inodes < requirement.required_inodes:
        raise RuntimeError(
            "PostgreSQL volume has insufficient free inodes for the staged database and WAL"
        )


def filesystems_share_capacity(
    *,
    database_device: int,
    database_total_bytes: int,
    database_available_bytes: int,
    uploads_device: int,
    uploads_total_bytes: int,
    uploads_available_bytes: int,
) -> bool:
    if database_device == uploads_device:
        return True
    return (
        database_total_bytes == uploads_total_bytes
        and abs(database_available_bytes - uploads_available_bytes)
        <= FILESYSTEM_FREE_COMPARISON_TOLERANCE_BYTES
    )


def ensure_shared_restore_capacity(
    database_requirement: DatabaseCapacityRequirement,
    *,
    uploads_staging_bytes: int,
    uploads_staging_inodes: int,
    available_bytes: int,
    available_inodes: int,
) -> None:
    combined_bytes = database_requirement.required_bytes + uploads_staging_bytes
    combined_inodes = database_requirement.required_inodes + uploads_staging_inodes
    if available_bytes < combined_bytes:
        raise RuntimeError(
            "shared data volume has insufficient free space for the staged database, "
            "indexes, WAL, new media, and safety reserve"
        )
    if available_inodes < combined_inodes:
        raise RuntimeError(
            "shared data volume has insufficient free inodes for the staged database, "
            "WAL, new media, and rollback state"
        )


def _non_negative_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must not be negative")
    return parsed


def _positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _die(message: str) -> NoReturn:
    print(f"restore-capacity: {message}", file=sys.stderr)
    raise SystemExit(1)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump-bytes", type=_non_negative_integer, required=True)
    parser.add_argument("--plain-bytes", type=_non_negative_integer, required=True)
    parser.add_argument("--toc-entries", type=_non_negative_integer, required=True)
    parser.add_argument("--filesystem-total-kib", type=_positive_integer, required=True)
    parser.add_argument("--filesystem-free-kib", type=_non_negative_integer, required=True)
    parser.add_argument("--filesystem-free-inodes", type=_non_negative_integer, required=True)
    parser.add_argument("--database-filesystem-device", type=_non_negative_integer, required=True)
    parser.add_argument("--uploads-filesystem-device", type=_non_negative_integer, required=True)
    parser.add_argument("--uploads-filesystem-total-bytes", type=_positive_integer, required=True)
    parser.add_argument("--uploads-filesystem-free-bytes", type=_non_negative_integer, required=True)
    parser.add_argument("--uploads-filesystem-free-inodes", type=_non_negative_integer, required=True)
    parser.add_argument("--uploads-staging-bytes", type=_non_negative_integer, required=True)
    parser.add_argument("--uploads-staging-inodes", type=_non_negative_integer, required=True)
    arguments = parser.parse_args(argv)

    try:
        requirement = database_capacity_requirement(
            dump_bytes=arguments.dump_bytes,
            plain_bytes=arguments.plain_bytes,
            toc_entries=arguments.toc_entries,
            filesystem_total_bytes=arguments.filesystem_total_kib * 1024,
        )
        ensure_database_capacity(
            requirement,
            available_bytes=arguments.filesystem_free_kib * 1024,
            available_inodes=arguments.filesystem_free_inodes,
        )
        database_total_bytes = arguments.filesystem_total_kib * 1024
        database_available_bytes = arguments.filesystem_free_kib * 1024
        if filesystems_share_capacity(
            database_device=arguments.database_filesystem_device,
            database_total_bytes=database_total_bytes,
            database_available_bytes=database_available_bytes,
            uploads_device=arguments.uploads_filesystem_device,
            uploads_total_bytes=arguments.uploads_filesystem_total_bytes,
            uploads_available_bytes=arguments.uploads_filesystem_free_bytes,
        ):
            ensure_shared_restore_capacity(
                requirement,
                uploads_staging_bytes=arguments.uploads_staging_bytes,
                uploads_staging_inodes=arguments.uploads_staging_inodes,
                available_bytes=min(
                    database_available_bytes,
                    arguments.uploads_filesystem_free_bytes,
                ),
                available_inodes=min(
                    arguments.filesystem_free_inodes,
                    arguments.uploads_filesystem_free_inodes,
                ),
            )
    except (RuntimeError, ValueError) as error:
        _die(str(error))

    print(
        "database_required_bytes="
        f"{requirement.required_bytes} database_required_inodes={requirement.required_inodes}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
