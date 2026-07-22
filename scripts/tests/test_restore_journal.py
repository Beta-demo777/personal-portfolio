from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
JOURNAL_SCRIPT = SCRIPTS_DIR / "restore_journal.py"
PROJECT = "journal-test"
TOKEN = "0123456789abcdef0123456789abcdef"


class RestoreJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.state_directory = self.base / "state"
        self.journal = self.state_directory / "journal-test.restore.json"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _run(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(JOURNAL_SCRIPT),
                "--file",
                str(self.journal),
                "--project",
                PROJECT,
                *arguments,
            ),
            check=False,
            capture_output=True,
            text=True,
        )

    def _create(self) -> subprocess.CompletedProcess[str]:
        return self._run(
            "create",
            "--token",
            TOKEN,
            "--phase",
            "database_creating",
        )

    def test_create_update_read_and_remove_use_strict_permissions(self) -> None:
        created = self._create()
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertEqual(stat.S_IMODE(self.state_directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.journal.stat().st_mode), 0o600)

        updated = self._run(
            "update",
            "--phase",
            "backend_stopping",
            "--backend-was-active",
            "true",
        )
        self.assertEqual(updated.returncode, 0, updated.stderr)

        stale_temporary = self.state_directory / f".{self.journal.name}.interrupted"
        stale_temporary.write_text("old atomic write", encoding="ascii")
        stale_temporary.chmod(0o600)

        read = self._run("read")
        self.assertEqual(read.returncode, 0, read.stderr)
        self.assertFalse(stale_temporary.exists())
        self.assertEqual(
            read.stdout.strip().split("\t"),
            [
                TOKEN,
                "portfolio_restore_0123456789abcdef",
                "portfolio_rollback_0123456789abcdef",
                "backend_stopping",
                "true",
            ],
        )

        removed = self._run("remove")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(self.journal.exists())
        self.assertEqual(self._run("exists").returncode, 1)

    def test_create_never_overwrites_an_existing_journal(self) -> None:
        self.assertEqual(self._create().returncode, 0)
        original = self.journal.read_bytes()

        repeated = self._create()

        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("run --recover", repeated.stderr)
        self.assertEqual(self.journal.read_bytes(), original)

    def test_corrupt_journal_fails_closed_and_is_not_removed(self) -> None:
        self.state_directory.mkdir(mode=0o700)
        self.journal.write_text('{"version":1,"token":', encoding="ascii")
        self.journal.chmod(0o600)
        original = self.journal.read_bytes()

        for command in (("read",), ("remove",), ("update", "--phase", "media_staged")):
            result = self._run(*command)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("corrupt", result.stderr)
            self.assertEqual(self.journal.read_bytes(), original)

    def test_schema_rejects_unexpected_content_and_database_names(self) -> None:
        self.assertEqual(self._create().returncode, 0)
        payload = json.loads(self.journal.read_text(encoding="ascii"))
        payload["content"] = "must-not-be-recorded"
        self.journal.write_text(json.dumps(payload), encoding="ascii")
        self.journal.chmod(0o600)
        extra_field = self._run("read")
        self.assertNotEqual(extra_field.returncode, 0)
        self.assertIn("invalid schema", extra_field.stderr)

        del payload["content"]
        payload["staged_database"] = "portfolio"
        self.journal.write_text(json.dumps(payload), encoding="ascii")
        self.journal.chmod(0o600)
        unsafe_database = self._run("read")
        self.assertNotEqual(unsafe_database.returncode, 0)
        self.assertIn("invalid staged database name", unsafe_database.stderr)

    def test_wrong_permissions_symlink_and_hardlink_fail_closed(self) -> None:
        self.assertEqual(self._create().returncode, 0)
        self.journal.chmod(0o644)
        insecure = self._run("read")
        self.assertNotEqual(insecure.returncode, 0)
        self.assertIn("0600", insecure.stderr)

        self.journal.chmod(0o600)
        hardlink = self.base / "journal-link"
        os.link(self.journal, hardlink)
        linked = self._run("read")
        self.assertNotEqual(linked.returncode, 0)
        self.assertIn("hard links", linked.stderr)
        hardlink.unlink()

        target = self.base / "target"
        self.journal.replace(target)
        self.journal.symlink_to(target)
        symbolic = self._run("read")
        self.assertNotEqual(symbolic.returncode, 0)
        self.assertIn("regular file", symbolic.stderr)

    def test_update_rejects_project_mismatch_without_rewriting(self) -> None:
        self.assertEqual(self._create().returncode, 0)
        original = self.journal.read_bytes()
        mismatch = subprocess.run(
            (
                sys.executable,
                str(JOURNAL_SCRIPT),
                "--file",
                str(self.journal),
                "--project",
                "another-project",
                "update",
                "--phase",
                "media_active",
            ),
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("different Compose project", mismatch.stderr)
        self.assertEqual(self.journal.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
