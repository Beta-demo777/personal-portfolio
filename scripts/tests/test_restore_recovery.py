from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
RESTORE_SCRIPT = SCRIPTS_DIR / "restore.sh"
JOURNAL_SCRIPT = SCRIPTS_DIR / "restore_journal.py"
PROJECT = "restore-recovery-test"
TOKEN = "0123456789abcdef0123456789abcdef"
ROLLBACK_PHASES = (
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
)


class RestoreRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.lock_directory = self.base / "state"
        self.docker_log = self.base / "docker.log"
        docker = self.fake_bin / "docker"
        docker.write_text(
            """#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [ "$*" = "compose version --short" ]; then
    printf '%s\n' "${FAKE_COMPOSE_VERSION:-2.30.0}"
    exit 0
fi
case "$*" in
    *'ps --status running --services'*)
        [ "${FAKE_BACKEND_ACTIVE:-false}" = true ] && printf '%s\n' backend
        exit 0
        ;;
    *'ps --status restarting --services'*) exit 0 ;;
    *'restore-database-rollback'*) exit "${FAKE_DATABASE_RECOVERY_STATUS:-0}" ;;
    *'restore-database-commit'*) exit "${FAKE_DATABASE_RECOVERY_STATUS:-0}" ;;
    *'restore_uploads.py recover-rollback'*) exit "${FAKE_MEDIA_RECOVERY_STATUS:-0}" ;;
    *'restore_uploads.py recover-commit'*) exit "${FAKE_MEDIA_RECOVERY_STATUS:-0}" ;;
    *'stop backend'*) exit 0 ;;
    *'up --detach --wait --wait-timeout 60 backend'*) exit "${FAKE_BACKEND_START_STATUS:-0}" ;;
esac
exit 99
""",
            encoding="ascii",
        )
        docker.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    @property
    def journal(self) -> Path:
        return self.lock_directory / f"{PROJECT}.restore.json"

    def _environment(self, **overrides: str) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.fake_bin}{os.pathsep}{environment['PATH']}",
                "DOCKER_LOG": str(self.docker_log),
                "PORTFOLIO_COMPOSE_PROJECT_NAME": PROJECT,
                "PORTFOLIO_MAINTENANCE_LOCK_DIR": str(self.lock_directory),
                "PORTFOLIO_RESTORE_STATE_DIR": str(self.lock_directory),
            }
        )
        environment.update(overrides)
        return environment

    def _create_journal(self, phase: str, *, backend_was_active: bool = False) -> None:
        created = subprocess.run(
            (
                sys.executable,
                str(JOURNAL_SCRIPT),
                "--file",
                str(self.journal),
                "--project",
                PROJECT,
                "create",
                "--token",
                TOKEN,
                "--phase",
                "database_creating",
            ),
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(created.returncode, 0, created.stderr)
        if phase != "database_creating" or backend_was_active:
            arguments = [
                sys.executable,
                str(JOURNAL_SCRIPT),
                "--file",
                str(self.journal),
                "--project",
                PROJECT,
                "update",
                "--phase",
                phase,
            ]
            if backend_was_active:
                arguments.extend(("--backend-was-active", "true"))
            updated = subprocess.run(
                arguments,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(updated.returncode, 0, updated.stderr)

    def _recover(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (str(RESTORE_SCRIPT), "--recover"),
            env=self._environment(**overrides),
            check=False,
            capture_output=True,
            text=True,
        )

    def _docker_operations(self) -> str:
        return self.docker_log.read_text(encoding="utf-8") if self.docker_log.exists() else ""

    def test_every_precommit_phase_selects_rollback_and_removes_journal(self) -> None:
        for phase in ROLLBACK_PHASES:
            with self.subTest(phase=phase):
                self.docker_log.unlink(missing_ok=True)
                self._create_journal(phase)
                recovered = self._recover()
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                operations = self._docker_operations()
                self.assertIn("restore-database-rollback", operations)
                self.assertIn("restore_uploads.py recover-rollback", operations)
                self.assertNotIn("restore-database-commit", operations)
                self.assertFalse(self.journal.exists())

    def test_commit_phase_finishes_cleanup_and_repeat_is_a_noop(self) -> None:
        self._create_journal("commit_started")
        first = self._recover()
        self.assertEqual(first.returncode, 0, first.stderr)
        operations = self._docker_operations()
        self.assertIn("restore-database-commit", operations)
        self.assertIn("restore_uploads.py recover-commit", operations)
        self.assertFalse(self.journal.exists())

        self.docker_log.unlink()
        repeated = self._recover()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertIn("No interrupted restore", repeated.stdout)
        self.assertNotIn("stop backend", self._docker_operations())

    def test_recovery_removes_partial_private_input_staging_left_by_sigkill(self) -> None:
        self._create_journal("media_staged")
        staging = self.lock_directory / (
            f".portfolio-restore-backup-{len(PROJECT)}-{PROJECT}-" + "a" * 32
        )
        staging.mkdir(mode=0o700)
        partial_dump = staging / "database.dump"
        partial_dump.write_bytes(b"partial")
        partial_dump.chmod(0o600)

        recovered = self._recover()

        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertFalse(staging.exists())
        self.assertFalse(self.journal.exists())

    def test_recovery_restarts_backend_when_recorded_or_currently_active(self) -> None:
        self._create_journal("backend_stopped", backend_was_active=True)
        recorded = self._recover()
        self.assertEqual(recorded.returncode, 0, recorded.stderr)
        self.assertIn("up --detach --wait --wait-timeout 60 backend", self._docker_operations())

        self.docker_log.unlink()
        self._create_journal("media_staged")
        current = self._recover(FAKE_BACKEND_ACTIVE="true")
        self.assertEqual(current.returncode, 0, current.stderr)
        self.assertIn("up --detach --wait --wait-timeout 60 backend", self._docker_operations())

    def test_failed_recovery_keeps_journal_and_blocks_a_new_restore(self) -> None:
        self._create_journal("database_swapping")
        failed = self._recover(FAKE_DATABASE_RECOVERY_STATUS="42")
        self.assertEqual(failed.returncode, 42, failed.stderr)
        self.assertTrue(self.journal.is_file())

        self.docker_log.unlink()
        new_restore = subprocess.run(
            (str(RESTORE_SCRIPT), "--backup", str(self.base / "missing"), "--yes"),
            env=self._environment(),
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(new_restore.returncode, 0)
        self.assertIn("interrupted restore journal exists", new_restore.stderr)
        operations = self._docker_operations()
        self.assertNotIn("stop backend", operations)
        self.assertNotIn("restore-database", operations)

    def test_corrupt_journal_fails_closed_before_data_operations(self) -> None:
        self.lock_directory.mkdir(mode=0o700)
        self.journal.write_text('{"version":1', encoding="ascii")
        self.journal.chmod(0o600)
        original = self.journal.read_bytes()

        recovered = self._recover()

        self.assertNotEqual(recovered.returncode, 0)
        self.assertIn("corrupt", recovered.stderr)
        self.assertEqual(self.journal.read_bytes(), original)
        operations = self._docker_operations()
        self.assertNotIn("stop backend", operations)
        self.assertNotIn("restore-database", operations)
        self.assertNotIn("restore_uploads.py recover", operations)


if __name__ == "__main__":
    unittest.main()
