from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import backup_migrations  # noqa: E402


@dataclass(frozen=True)
class FakeRevision:
    revision: str


class FakeScriptDirectory:
    def __init__(self, parents: dict[str, tuple[str, ...]], heads: tuple[str, ...]):
        self.parents = parents
        self.heads = heads

    def get_heads(self) -> tuple[str, ...]:
        return self.heads

    def get_revision(self, revision: str) -> FakeRevision:
        if revision not in self.parents:
            raise LookupError(revision)
        return FakeRevision(revision)

    def iterate_revisions(
        self, descendant: str, ancestor: str
    ) -> tuple[FakeRevision, ...]:
        pending = [descendant]
        visited: set[str] = set()
        while pending:
            current = pending.pop()
            if current == ancestor:
                return tuple(FakeRevision(value) for value in visited)
            if current in visited:
                continue
            visited.add(current)
            pending.extend(self.parents[current])
        raise ValueError(f"{ancestor} is not an ancestor of {descendant}")


LINEAR_SCRIPT = FakeScriptDirectory(
    {
        "20260716_0001": (),
        "20260717_0002": ("20260716_0001",),
    },
    ("20260717_0002",),
)


class BackupMigrationCompatibilityTests(unittest.TestCase):
    def test_accepts_old_database_and_application_heads_on_current_chain(self) -> None:
        current = backup_migrations.validate_backup_metadata(
            LINEAR_SCRIPT,
            "20260716_0001",
            "20260716_0001",
        )
        self.assertEqual(current, "20260717_0002")

    def test_accepts_old_database_created_by_current_application(self) -> None:
        current = backup_migrations.validate_backup_metadata(
            LINEAR_SCRIPT,
            "20260716_0001",
            "20260717_0002",
        )
        self.assertEqual(current, "20260717_0002")

    def test_legacy_backup_uses_its_single_known_database_head(self) -> None:
        current = backup_migrations.validate_backup_metadata(
            LINEAR_SCRIPT,
            "20260716_0001",
            None,
        )
        self.assertEqual(current, "20260717_0002")

    def test_legacy_backup_rejects_an_unknown_actual_database_head(self) -> None:
        with self.assertRaisesRegex(
            backup_migrations.CompatibilityError, "unknown Alembic revision"
        ):
            backup_migrations.validate_backup_metadata(
                LINEAR_SCRIPT,
                "20990101_9999",
                None,
            )

    def test_rejects_unknown_or_future_database_revision(self) -> None:
        with self.assertRaisesRegex(
            backup_migrations.CompatibilityError, "unknown Alembic revision"
        ):
            backup_migrations.validate_backup_metadata(
                LINEAR_SCRIPT,
                "20990101_9999",
                "20260717_0002",
            )

    def test_rejects_backup_created_by_unknown_or_future_application(self) -> None:
        with self.assertRaisesRegex(
            backup_migrations.CompatibilityError, "unknown Alembic revision"
        ):
            backup_migrations.validate_backup_metadata(
                LINEAR_SCRIPT,
                "20260716_0001",
                "20990101_9999",
            )

    def test_rejects_database_newer_than_recorded_backup_application(self) -> None:
        with self.assertRaisesRegex(
            backup_migrations.CompatibilityError, "not an ancestor"
        ):
            backup_migrations.validate_backup_metadata(
                LINEAR_SCRIPT,
                "20260717_0002",
                "20260716_0001",
            )

    def test_rejects_application_graph_with_multiple_heads(self) -> None:
        branched = FakeScriptDirectory(
            {
                "base": (),
                "head_a": ("base",),
                "head_b": ("base",),
            },
            ("head_a", "head_b"),
        )
        with self.assertRaisesRegex(
            backup_migrations.CompatibilityError, "exactly one head"
        ):
            backup_migrations.validate_backup_metadata(branched, "base", "base")

    def test_rejects_restored_database_with_multiple_heads(self) -> None:
        with patch.object(
            backup_migrations,
            "_database_heads",
            return_value=("head_a", "head_b"),
        ):
            with self.assertRaisesRegex(
                backup_migrations.CompatibilityError, "exactly one Alembic head"
            ):
                backup_migrations._single_database_head()


if __name__ == "__main__":
    unittest.main()
