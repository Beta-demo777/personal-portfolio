from __future__ import annotations

import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
STAGING_SCRIPT = SCRIPTS_DIR / "restore_backup_staging.py"
REQUIRED_FILES = (
    "database.dump",
    "uploads.tar",
    "manifest.txt",
    "SHA256SUMS",
    "SHA256SUMS.sig",
)
PROJECT = "staging-test"


class RestoreBackupStagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.backup = self.base / "backup"
        self.backup.mkdir()
        self.staging_parent = self.base / "private"
        for index, name in enumerate(REQUIRED_FILES):
            (self.backup / name).write_bytes(f"original-{index}".encode("ascii"))

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _stage(self, backup: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "stage",
                "--backup",
                str(backup or self.backup),
                "--staging-parent",
                str(self.staging_parent),
                "--project",
                PROJECT,
            ),
            check=False,
            capture_output=True,
            text=True,
        )

    def _remove(self, staging: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "remove",
                "--staging",
                str(staging),
                "--staging-parent",
                str(self.staging_parent),
                "--project",
                PROJECT,
            ),
            check=False,
            capture_output=True,
            text=True,
        )

    def test_private_snapshot_is_unchanged_after_source_replacement(self) -> None:
        expected = {name: (self.backup / name).read_bytes() for name in REQUIRED_FILES}
        result = self._stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        staging = Path(result.stdout.strip())

        self.assertEqual(stat.S_IMODE(staging.stat().st_mode), 0o700)
        for name, content in expected.items():
            self.assertEqual(stat.S_IMODE((staging / name).stat().st_mode), 0o400)
            self.assertEqual((staging / name).read_bytes(), content)

        replacement = self.base / "replacement"
        replacement.write_bytes(b"attacker replacement")
        os.replace(replacement, self.backup / "database.dump")
        (self.backup / "manifest.txt").write_bytes(b"changed manifest")

        self.assertEqual((staging / "database.dump").read_bytes(), expected["database.dump"])
        self.assertEqual((staging / "manifest.txt").read_bytes(), expected["manifest.txt"])

        removed = self._remove(staging)
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(staging.exists())

    def test_rejects_symbolic_link_input_without_leaving_staging(self) -> None:
        target = self.base / "target"
        target.write_bytes(b"linked")
        (self.backup / "database.dump").unlink()
        (self.backup / "database.dump").symlink_to(target)

        result = self._stage()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular file", result.stderr)
        self.assertEqual(list(self.staging_parent.glob(".portfolio-restore-backup-*")), [])

    def test_rejects_symbolic_link_signature_without_leaving_staging(self) -> None:
        target = self.base / "target-signature"
        target.write_bytes(b"linked")
        (self.backup / "SHA256SUMS.sig").unlink()
        (self.backup / "SHA256SUMS.sig").symlink_to(target)

        result = self._stage()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular file", result.stderr)
        self.assertEqual(list(self.staging_parent.glob(".portfolio-restore-backup-*")), [])

    def test_allows_missing_signature_for_explicit_legacy_verification(self) -> None:
        (self.backup / "SHA256SUMS.sig").unlink()

        result = self._stage()

        self.assertEqual(result.returncode, 0, result.stderr)
        staging = Path(result.stdout.strip())
        self.assertFalse((staging / "SHA256SUMS.sig").exists())
        removed = self._remove(staging)
        self.assertEqual(removed.returncode, 0, removed.stderr)

    def test_rejects_multiply_linked_input_without_leaving_staging(self) -> None:
        extra_link = self.base / "database-hardlink"
        os.link(self.backup / "database.dump", extra_link)

        result = self._stage()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one hard link", result.stderr)
        self.assertEqual(list(self.staging_parent.glob(".portfolio-restore-backup-*")), [])

    def test_rejects_non_regular_input(self) -> None:
        (self.backup / "uploads.tar").unlink()
        (self.backup / "uploads.tar").mkdir()

        result = self._stage()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular file", result.stderr)

    def test_rejects_symbolic_link_backup_directory(self) -> None:
        linked_backup = self.base / "linked-backup"
        linked_backup.symlink_to(self.backup, target_is_directory=True)

        result = self._stage(linked_backup)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a symbolic link", result.stderr)

    def test_accepts_relative_backup_path_without_following_final_symlinks(self) -> None:
        result = subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "stage",
                "--backup",
                self.backup.name,
                "--staging-parent",
                self.staging_parent.name,
                "--project",
                PROJECT,
            ),
            cwd=self.base,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        staging = Path(result.stdout.strip())
        self.assertTrue(staging.is_dir())
        removed = subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "remove",
                "--staging",
                str(staging),
                "--staging-parent",
                str(staging.parent),
                "--project",
                PROJECT,
            ),
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(removed.returncode, 0, removed.stderr)

    def test_stale_cleanup_removes_partial_sigkill_state_for_only_one_project(self) -> None:
        first = self._stage()
        self.assertEqual(first.returncode, 0, first.stderr)
        interrupted = Path(first.stdout.strip())
        (interrupted / "SHA256SUMS").unlink()
        (interrupted / "database.dump").chmod(0o600)

        other = subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "stage",
                "--backup",
                str(self.backup),
                "--staging-parent",
                str(self.staging_parent),
                "--project",
                "staging-test-extra",
            ),
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(other.returncode, 0, other.stderr)
        other_staging = Path(other.stdout.strip())

        cleanup = subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "remove-stale",
                "--staging-parent",
                str(self.staging_parent),
                "--project",
                PROJECT,
            ),
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(cleanup.returncode, 0, cleanup.stderr)
        self.assertFalse(interrupted.exists())
        self.assertTrue(other_staging.is_dir())
        other_cleanup = subprocess.run(
            (
                sys.executable,
                str(STAGING_SCRIPT),
                "remove-stale",
                "--staging-parent",
                str(self.staging_parent),
                "--project",
                "staging-test-extra",
            ),
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(other_cleanup.returncode, 0, other_cleanup.stderr)


if __name__ == "__main__":
    unittest.main()
