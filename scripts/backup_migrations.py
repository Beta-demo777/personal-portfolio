#!/usr/bin/env python3

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
from typing import Any


REVISION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class CompatibilityError(RuntimeError):
    pass


def _validated_revision(value: str, label: str) -> str:
    if not REVISION_PATTERN.fullmatch(value):
        raise CompatibilityError(f"{label} is not a valid Alembic revision identifier")
    return value


def _single_application_head(script: Any) -> str:
    heads = tuple(script.get_heads())
    if len(heads) != 1:
        rendered = ", ".join(sorted(heads)) if heads else "none"
        raise CompatibilityError(
            f"application migration graph must have exactly one head; found: {rendered}"
        )
    return _validated_revision(heads[0], "application migration head")


def _require_known_ancestor(
    script: Any,
    ancestor: str,
    descendant: str,
    relationship: str,
) -> None:
    for revision in (ancestor, descendant):
        try:
            resolved = script.get_revision(revision)
        except Exception as error:
            raise CompatibilityError(
                f"{relationship}: unknown Alembic revision {revision}"
            ) from error
        if resolved is None or resolved.revision != revision:
            raise CompatibilityError(
                f"{relationship}: unknown or abbreviated Alembic revision {revision}"
            )

    try:
        tuple(script.iterate_revisions(descendant, ancestor))
    except Exception as error:
        raise CompatibilityError(
            f"{relationship}: revision {ancestor} is not an ancestor of {descendant}"
        ) from error


def validate_backup_metadata(
    script: Any,
    database_head: str,
    backup_application_head: str | None,
) -> str:
    database_head = _validated_revision(database_head, "database migration head")
    current_application_head = _single_application_head(script)
    _require_known_ancestor(
        script,
        database_head,
        current_application_head,
        "database compatibility check",
    )

    if backup_application_head is not None:
        backup_application_head = _validated_revision(
            backup_application_head, "backup application migration head"
        )
        _require_known_ancestor(
            script,
            backup_application_head,
            current_application_head,
            "application compatibility check",
        )
        _require_known_ancestor(
            script,
            database_head,
            backup_application_head,
            "backup metadata consistency check",
        )

    return current_application_head


def _load_script(config_path: Path):
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    if not config_path.is_file():
        raise CompatibilityError(f"Alembic configuration not found: {config_path}")
    return ScriptDirectory.from_config(Config(str(config_path)))


def _database_heads() -> tuple[str, ...]:
    from alembic.migration import MigrationContext
    from app.db.session import engine

    with engine.connect() as connection:
        return tuple(MigrationContext.configure(connection).get_current_heads())


def _single_database_head() -> str:
    heads = _database_heads()
    if len(heads) != 1:
        rendered = ", ".join(sorted(heads)) if heads else "none"
        raise CompatibilityError(
            f"restored database must have exactly one Alembic head; found: {rendered}"
        )
    return _validated_revision(heads[0], "restored database migration head")


def prepare_restored_database(
    config_path: Path,
    expected_database_head: str | None,
    backup_application_head: str | None,
) -> tuple[str, str, bool]:
    from alembic import command
    from alembic.config import Config
    from app.db.session import engine

    script = _load_script(config_path)
    database_head = _single_database_head()
    if expected_database_head is not None:
        expected_database_head = _validated_revision(
            expected_database_head, "manifest database migration head"
        )
        if database_head != expected_database_head:
            raise CompatibilityError(
                "restored database migration head does not match the manifest: "
                f"expected {expected_database_head}, found {database_head}"
            )

    application_head = validate_backup_metadata(
        script, database_head, backup_application_head
    )
    migration_applied = database_head != application_head
    if migration_applied:
        engine.dispose()
        command.upgrade(Config(str(config_path)), application_head)
        engine.dispose()

    final_heads = _database_heads()
    if final_heads != (application_head,):
        rendered = ", ".join(sorted(final_heads)) if final_heads else "none"
        raise CompatibilityError(
            "isolated database did not reach the application migration head; "
            f"expected {application_head}, found: {rendered}"
        )
    return database_head, application_head, migration_applied


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate backup Alembic compatibility and migrate staged databases."
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("/app/alembic.ini"),
        help="Alembic configuration path (default: /app/alembic.ini)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("application-head")

    validate = subparsers.add_parser("validate-metadata")
    validate.add_argument("--database-head", required=True)
    validate.add_argument("--backup-application-head")

    prepare = subparsers.add_parser("prepare-restored")
    prepare.add_argument("--expected-database-head")
    prepare.add_argument("--backup-application-head")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        script = _load_script(args.config)
        if args.command == "application-head":
            print(_single_application_head(script))
            return 0
        if args.command == "validate-metadata":
            print(
                validate_backup_metadata(
                    script,
                    args.database_head,
                    args.backup_application_head,
                )
            )
            return 0

        database_head, application_head, migration_applied = (
            prepare_restored_database(
                args.config,
                args.expected_database_head,
                args.backup_application_head,
            )
        )
        print(f"restored_database_head_before={database_head}")
        print(f"application_alembic_head={application_head}")
        print(f"migration_applied={'true' if migration_applied else 'false'}")
        return 0
    except CompatibilityError as error:
        print(f"backup-migrations: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
