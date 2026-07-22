from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from scripts import backup_journal


PROJECT = "backup-journal-test"
CONTAINER_ID = "a" * 64


class BackupJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.journal = self.base / "state" / f"{PROJECT}.backup.json"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_create_update_read_and_remove_are_crash_safe(self) -> None:
        backup_journal.create_journal(
            self.journal,
            PROJECT,
            CONTAINER_ID,
            "backend_stopping",
        )

        self.assertEqual(stat.S_IMODE(self.journal.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.journal.stat().st_mode), 0o600)
        self.assertEqual(
            backup_journal.read_journal(self.journal, PROJECT),
            {
                "version": 1,
                "project_name": PROJECT,
                "backend_container_id": CONTAINER_ID,
                "phase": "backend_stopping",
            },
        )

        backup_journal.update_journal(self.journal, PROJECT, "backend_stopped")
        self.assertEqual(
            backup_journal.read_journal(self.journal, PROJECT)["phase"],
            "backend_stopped",
        )
        backup_journal.remove_journal(self.journal, PROJECT)
        self.assertFalse(self.journal.exists())
        self.assertFalse(backup_journal.journal_exists(self.journal))

    def test_project_schema_and_container_identity_are_strict(self) -> None:
        backup_journal.create_journal(
            self.journal,
            PROJECT,
            CONTAINER_ID,
            "backend_stopping",
        )

        with self.assertRaisesRegex(backup_journal.JournalError, "different"):
            backup_journal.read_journal(self.journal, "other-backup-test")

        payload = json.loads(self.journal.read_text(encoding="ascii"))
        for field, value in (
            ("backend_container_id", "short"),
            ("phase", "unknown"),
            ("extra", "unexpected"),
        ):
            with self.subTest(field=field):
                changed = dict(payload)
                changed[field] = value
                with self.assertRaises(backup_journal.JournalError):
                    backup_journal.validate_payload(changed, PROJECT)

    def test_wrong_permissions_symlink_and_hardlink_fail_closed(self) -> None:
        backup_journal.create_journal(
            self.journal,
            PROJECT,
            CONTAINER_ID,
            "backend_stopping",
        )

        self.journal.chmod(0o644)
        with self.assertRaisesRegex(backup_journal.JournalError, "0600"):
            backup_journal.read_journal(self.journal, PROJECT)
        self.journal.chmod(0o600)

        hardlink = self.base / "journal-hardlink"
        os.link(self.journal, hardlink)
        with self.assertRaisesRegex(backup_journal.JournalError, "hard links"):
            backup_journal.read_journal(self.journal, PROJECT)
        hardlink.unlink()

        target = self.base / "journal-target"
        self.journal.replace(target)
        self.journal.symlink_to(target)
        with self.assertRaisesRegex(backup_journal.JournalError, "regular file"):
            backup_journal.read_journal(self.journal, PROJECT)

    def test_unsafe_partial_replacement_is_not_silently_ignored(self) -> None:
        self.journal.parent.mkdir(mode=0o700)
        unsafe_temporary = self.journal.parent / f".{self.journal.name}.unsafe"
        unsafe_temporary.symlink_to(self.base / "missing")

        with self.assertRaisesRegex(backup_journal.JournalError, "temporary file"):
            backup_journal.journal_exists(self.journal)


if __name__ == "__main__":
    unittest.main()
