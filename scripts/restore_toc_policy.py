#!/usr/bin/env python3
"""Validate the complete pg_restore TOC against the portfolio database shape."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import re
import sys
from typing import BinaryIO, NoReturn


MAX_TOC_BYTES = 64 * 1024
MAX_TOC_LINES = 256
MAX_TOC_ENTRIES = 32
SUPPORTED_BACKUP_FORMATS = frozenset((1, 2, 3))

POLICY_ERROR = "database dump TOC violates the application object policy"
ENTRY_PREFIX = re.compile(
    r"(?P<dump_id>[1-9][0-9]{0,9}); "
    r"(?P<catalog_oid>[0-9]{1,10}) "
    r"(?P<object_oid>[0-9]{1,10}) "
    r"(?P<body>[\x20-\x7e]+)"
)
SAFE_TOKEN = re.compile(r"[!-~]{1,255}")

META_KEYS = frozenset(
    {
        ("ENCODING", "-", "ENCODING"),
        ("STDSTRINGS", "-", "STDSTRINGS"),
        ("SEARCHPATH", "-", "SEARCHPATH"),
    }
)
REQUIRED_APPLICATION_KEYS = frozenset(
    {
        ("TABLE", "public", "alembic_version"),
        ("TABLE", "public", "site_content"),
        ("TABLE", "public", "content_revisions"),
        ("SEQUENCE", "public", "content_revisions_id_seq"),
        ("SEQUENCE OWNED BY", "public", "content_revisions_id_seq"),
        ("DEFAULT", "public", "content_revisions", "id"),
        ("TABLE DATA", "public", "alembic_version"),
        ("TABLE DATA", "public", "site_content"),
        ("TABLE DATA", "public", "content_revisions"),
        ("SEQUENCE SET", "public", "content_revisions_id_seq"),
        ("CONSTRAINT", "public", "alembic_version", "alembic_version_pkc"),
        ("CONSTRAINT", "public", "site_content", "site_content_pkey"),
        (
            "CONSTRAINT",
            "public",
            "content_revisions",
            "content_revisions_pkey",
        ),
    }
)

# Format v1 lacked manifest identity and migration metadata, but it was introduced
# after these three tables and Alembic's version table became the database contract.
# Its staged restore still derives and validates one actual Alembic head.
APPLICATION_KEYS_BY_FORMAT = {
    1: REQUIRED_APPLICATION_KEYS,
    2: REQUIRED_APPLICATION_KEYS,
    3: REQUIRED_APPLICATION_KEYS,
}

DESCRIPTOR_FIELD_COUNTS = (
    ("SEQUENCE OWNED BY", 2),
    ("TABLE DATA", 2),
    ("SEQUENCE SET", 2),
    ("CONSTRAINT", 3),
    ("DEFAULT", 3),
    ("SEQUENCE", 2),
    ("TABLE", 2),
)


class TocPolicyError(RuntimeError):
    """The archive object graph is outside the closed application policy."""

    def __init__(self) -> None:
        super().__init__(POLICY_ERROR)


def _reject() -> NoReturn:
    raise TocPolicyError()


@dataclass(frozen=True)
class TocEntry:
    dump_id: int
    catalog_oid: int
    object_oid: int
    key: tuple[str, ...]


def _parse_entry(line: str) -> TocEntry:
    matched = ENTRY_PREFIX.fullmatch(line.rstrip(" "))
    if matched is None:
        _reject()

    dump_id = int(matched.group("dump_id"))
    catalog_oid = int(matched.group("catalog_oid"))
    object_oid = int(matched.group("object_oid"))
    if catalog_oid > 4_294_967_295 or object_oid > 4_294_967_295:
        _reject()
    body = matched.group("body").rstrip(" ")

    for meta_key in META_KEYS:
        if body == " ".join(meta_key):
            return TocEntry(dump_id, catalog_oid, object_oid, meta_key)

    for descriptor, field_count in DESCRIPTOR_FIELD_COUNTS:
        prefix = f"{descriptor} "
        if not body.startswith(prefix):
            continue
        parts = body[len(prefix) :].split()
        if (
            len(parts) != field_count + 1
            or SAFE_TOKEN.fullmatch(parts[-1]) is None
        ):
            _reject()
        return TocEntry(
            dump_id,
            catalog_oid,
            object_oid,
            (descriptor, *parts[:-1]),
        )

    _reject()


def _validate_oid_shape(entry: TocEntry) -> None:
    descriptor = entry.key[0]
    if entry.key in META_KEYS:
        valid = entry.catalog_oid == 0 and entry.object_oid == 0
    elif descriptor in {"TABLE", "SEQUENCE"}:
        valid = entry.catalog_oid == 1259 and entry.object_oid > 0
    elif descriptor == "TABLE DATA":
        valid = entry.catalog_oid == 0 and entry.object_oid > 0
    elif descriptor in {"SEQUENCE OWNED BY", "SEQUENCE SET"}:
        valid = entry.catalog_oid == 0 and entry.object_oid == 0
    elif descriptor == "DEFAULT":
        valid = entry.catalog_oid == 2604 and entry.object_oid > 0
    elif descriptor == "CONSTRAINT":
        valid = entry.catalog_oid == 2606 and entry.object_oid > 0
    else:
        valid = False
    if not valid:
        _reject()


def _before(indexes: dict[tuple[str, ...], int], first: tuple[str, ...], second: tuple[str, ...]) -> None:
    if indexes[first] >= indexes[second]:
        _reject()


def _validate_structure(entries: list[TocEntry], format_version: int) -> None:
    if format_version not in SUPPORTED_BACKUP_FORMATS:
        _reject()
    if not entries or len(entries) > MAX_TOC_ENTRIES:
        _reject()

    dump_ids: set[int] = set()
    semantic_keys: set[tuple[str, ...]] = set()
    catalog_objects: set[tuple[int, int]] = set()
    indexes: dict[tuple[str, ...], int] = {}
    for index, entry in enumerate(entries):
        if entry.dump_id in dump_ids or entry.key in semantic_keys:
            _reject()
        dump_ids.add(entry.dump_id)
        semantic_keys.add(entry.key)
        indexes[entry.key] = index
        _validate_oid_shape(entry)
        if entry.catalog_oid:
            identity = (entry.catalog_oid, entry.object_oid)
            if identity in catalog_objects:
                _reject()
            catalog_objects.add(identity)

    application_keys = APPLICATION_KEYS_BY_FORMAT[format_version]
    # The normal pg_restore list is the set that the restore command will apply.
    # Archive header counts may include hidden metadata, but no visible object
    # beyond this exact application set is accepted.
    if semantic_keys != application_keys:
        _reject()

    entries_by_key = {entry.key: entry for entry in entries}
    relation_oids = {
        key[2]: entry.object_oid
        for key, entry in entries_by_key.items()
        if key[0] in {"TABLE", "SEQUENCE"}
    }
    for table_name in ("alembic_version", "site_content", "content_revisions"):
        data_entry = entries_by_key[("TABLE DATA", "public", table_name)]
        if data_entry.object_oid != relation_oids[table_name]:
            _reject()

    for table_name, constraint_name in (
        ("alembic_version", "alembic_version_pkc"),
        ("site_content", "site_content_pkey"),
        ("content_revisions", "content_revisions_pkey"),
    ):
        table = ("TABLE", "public", table_name)
        data = ("TABLE DATA", "public", table_name)
        constraint = ("CONSTRAINT", "public", table_name, constraint_name)
        _before(indexes, table, data)
        _before(indexes, data, constraint)

    revision_table = ("TABLE", "public", "content_revisions")
    revision_data = ("TABLE DATA", "public", "content_revisions")
    sequence = ("SEQUENCE", "public", "content_revisions_id_seq")
    sequence_owned = ("SEQUENCE OWNED BY", "public", "content_revisions_id_seq")
    default = ("DEFAULT", "public", "content_revisions", "id")
    sequence_set = ("SEQUENCE SET", "public", "content_revisions_id_seq")
    _before(indexes, revision_table, sequence)
    _before(indexes, sequence, sequence_owned)
    _before(indexes, sequence_owned, default)
    _before(indexes, revision_table, default)
    _before(indexes, sequence, default)
    _before(indexes, default, revision_data)
    _before(indexes, sequence, sequence_set)


def validate_toc_bytes(payload: bytes, format_version: int) -> None:
    if len(payload) > MAX_TOC_BYTES or b"\x00" in payload:
        _reject()
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _reject()
    lines = text.splitlines()
    if len(lines) > MAX_TOC_LINES:
        _reject()

    entries: list[TocEntry] = []
    for line in lines:
        if not line or line.startswith(";"):
            continue
        entries.append(_parse_entry(line))
        if len(entries) > MAX_TOC_ENTRIES:
            _reject()
    _validate_structure(entries, format_version)


def _read_bounded(source: BinaryIO) -> bytes:
    payload = source.read(MAX_TOC_BYTES + 1)
    if len(payload) <= MAX_TOC_BYTES:
        return payload
    # Drain the pipe so pg_restore exits normally and the caller receives one
    # deterministic policy error instead of an upstream SIGPIPE diagnostic.
    while source.read(64 * 1024):
        pass
    _reject()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a pg_restore TOC against the portfolio schema."
    )
    parser.add_argument(
        "--format-version",
        type=int,
        choices=sorted(SUPPORTED_BACKUP_FORMATS),
        required=True,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        validate_toc_bytes(_read_bounded(sys.stdin.buffer), arguments.format_version)
    except TocPolicyError:
        print(f"restore-toc-policy: {POLICY_ERROR}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
