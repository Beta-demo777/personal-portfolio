from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from scripts.tests.toc_fixtures import PG18_APPLICATION_TOC
from scripts.tests.backup_signature_fixture import generate_rsa_key_pair


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
BACKUP_SCRIPT = SCRIPTS_DIR / "backup.sh"
VERIFY_SCRIPT = SCRIPTS_DIR / "verify-backup.sh"


class BackupLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.key_context = tempfile.TemporaryDirectory()
        cls.key_directory = Path(cls.key_context.name)
        cls.private_key, cls.public_key = generate_rsa_key_pair(
            cls.key_directory, "backup"
        )
        cls.other_private_key, cls.other_public_key = generate_rsa_key_pair(
            cls.key_directory, "other"
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.key_context.cleanup()

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.output_directory = self.base / "backups"
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.docker_log = self.base / "docker.log"
        self.backend_state_file = self.base / "backend.state"
        self.backend_state_file.write_text("running\n", encoding="ascii")
        self.backend_container_id = "b" * 64
        self.pg_restore_toc = self.base / "pg_restore.toc"
        self.pg_restore_toc.write_text(PG18_APPLICATION_TOC, encoding="ascii")

        pg_restore = self.fake_bin / "pg_restore"
        pg_restore.write_text(
            '#!/bin/sh\ncat "$PG_RESTORE_TOC_FILE"\n', encoding="ascii"
        )
        pg_restore.chmod(0o755)

        docker = self.fake_bin / "docker"
        docker.write_text(
            """#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
    "compose version --short")
        printf '%s\n' "${FAKE_COMPOSE_VERSION:-2.30.0}"
        ;;
    *" ps --status running --quiet backend")
        if [ "$(cat "$FAKE_BACKEND_STATE_FILE")" = running ]; then
            printf '%s\n' "$FAKE_BACKEND_CONTAINER_ID"
        fi
        ;;
    *" ps --status restarting --quiet backend")
        if [ "$(cat "$FAKE_BACKEND_STATE_FILE")" = restarting ]; then
            printf '%s\n' "$FAKE_BACKEND_CONTAINER_ID"
        fi
        ;;
    *" stop backend")
        printf '%s\n' exited > "$FAKE_BACKEND_STATE_FILE"
        if [ "${FAKE_KILL_AFTER_STOP:-false}" = true ]; then
            kill -KILL "$PPID"
        fi
        ;;
    "inspect --type container --format "*" $FAKE_BACKEND_CONTAINER_ID")
        state=$(cat "$FAKE_BACKEND_STATE_FILE")
        health=healthy
        if [ "${FAKE_BACKEND_RECOVERY_FAIL:-false}" = true ]; then
            health=unhealthy
        fi
        printf '%s|%s|%s|backend\n' \
            "$state" "$health" \
            "${FAKE_CONTAINER_PROJECT:-$PORTFOLIO_COMPOSE_PROJECT_NAME}"
        ;;
    "start $FAKE_BACKEND_CONTAINER_ID")
        if [ "${FAKE_BACKEND_START_FAIL:-false}" = true ]; then
            exit 42
        fi
        printf '%s\n' running > "$FAKE_BACKEND_STATE_FILE"
        printf '%s\n' "$FAKE_BACKEND_CONTAINER_ID"
        ;;
    *"backup_migrations.py"*" application-head")
        printf '%s\n' 20260717_0002
        ;;
    *"backup_migrations.py"*" validate-metadata"*)
        ;;
    *"SELECT version_num FROM alembic_version"*)
        printf '%s\n' 20260717_0002
        ;;
    *"pg_dump --format=custom"*)
        printf 'PGDMP-fake-custom-dump'
        ;;
    *"restore_uploads.py create"*)
        tar -cf - -T /dev/null
        ;;
    *)
        printf 'unexpected fake docker invocation: %s\n' "$*" >&2
        exit 98
        ;;
esac
""",
            encoding="ascii",
        )
        docker.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _environment(self, *, recovery_fails: bool = False) -> dict[str, str]:
        environment = os.environ.copy()
        environment.pop("POSTGRES_DB", None)
        environment.pop("POSTGRES_USER", None)
        environment.pop("PORTFOLIO_BACKUP_PUBLIC_KEY_FILES", None)
        environment.update(
            {
                "DOCKER_LOG": str(self.docker_log),
                "FAKE_BACKEND_CONTAINER_ID": self.backend_container_id,
                "FAKE_BACKEND_STATE_FILE": str(self.backend_state_file),
                "FAKE_BACKEND_RECOVERY_FAIL": "true" if recovery_fails else "false",
                "FAKE_COMPOSE_VERSION": "2.30.0",
                "FAKE_KILL_AFTER_STOP": "false",
                "PATH": f"{self.fake_bin}{os.pathsep}{environment['PATH']}",
                "PG_RESTORE_TOC_FILE": str(self.pg_restore_toc),
                "PORTFOLIO_COMPOSE_PROJECT_NAME": "backup-lifecycle-test",
                "PORTFOLIO_MAINTENANCE_LOCK_DIR": str(self.base / "locks"),
                "PORTFOLIO_BACKUP_STATE_DIR": str(self.base / "locks"),
                "PORTFOLIO_BACKUP_PRIVATE_KEY_FILE": str(self.private_key),
                "PORTFOLIO_BACKUP_PUBLIC_KEY_FILE": str(self.public_key),
            }
        )
        return environment

    def _run_backup(
        self,
        *,
        recovery_fails: bool = False,
        environment_overrides: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = self._environment(recovery_fails=recovery_fails)
        environment.update(environment_overrides or {})
        return subprocess.run(
            (str(BACKUP_SCRIPT), "--output", str(self.output_directory)),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def _recover_backup(
        self,
        *,
        environment_overrides: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = self._environment()
        environment.update(environment_overrides or {})
        return subprocess.run(
            (str(BACKUP_SCRIPT), "--recover"),
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def _retry_while_interrupted_process_holds_lock(
        self,
        operation,
    ) -> subprocess.CompletedProcess[str]:
        deadline = time.monotonic() + 5
        while True:
            result = operation()
            if result.returncode != 75 or time.monotonic() >= deadline:
                return result
            time.sleep(0.02)

    def _verify(self, backup_directory: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                str(VERIFY_SCRIPT),
                "--backup",
                str(backup_directory),
                "--public-key",
                str(self.public_key),
            ),
            env=self._environment(),
            capture_output=True,
            text=True,
            check=False,
        )

    def test_success_waits_for_backend_readiness_before_publishing(self) -> None:
        result = self._run_backup()
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")

        published = list(self.output_directory.glob("portfolio-backup-*"))
        self.assertEqual(len(published), 1)
        self.assertFalse(published[0].name.endswith(".quarantine"))
        self.assertEqual(self._verify(published[0]).returncode, 0)
        self.assertIn(
            "format_version=3",
            (published[0] / "manifest.txt").read_text(encoding="ascii"),
        )
        self.assertEqual((published[0] / "SHA256SUMS.sig").stat().st_size, 384)

        docker_log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn(f"start {self.backend_container_id}", docker_log)
        self.assertNotIn(" up ", docker_log)
        self.assertIn("Backup created", result.stdout)

    def test_database_identity_is_resolved_inside_the_postgres_container(self) -> None:
        result = self._run_backup()
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")

        docker_log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn('psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"', docker_log)

    def test_self_verification_uses_only_the_preflighted_pair_public_key(self) -> None:
        result = self._run_backup(
            environment_overrides={
                "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES": str(self.public_key)
            }
        )

        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")

    def test_dump_disables_comments_before_structural_verification(self) -> None:
        result = self._run_backup()
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")

        docker_log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn(
            "pg_dump --format=custom --no-owner --no-privileges --no-comments",
            docker_log,
        )

    def test_object_policy_failure_recovers_backend_without_publishing_backup(self) -> None:
        self.pg_restore_toc.write_text(
            PG18_APPLICATION_TOC
            + "9010; 3079 17000 EXTENSION - untrusted portfolio\n",
            encoding="ascii",
        )

        result = self._run_backup()

        self.assertNotEqual(result.returncode, 0)
        published = list(self.output_directory.glob("portfolio-backup-*"))
        self.assertEqual(published, [])
        docker_log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn(f"start {self.backend_container_id}", docker_log)
        self.assertIn("PostgreSQL object policy", result.stderr)

    def test_readiness_failure_keeps_verified_backup_in_quarantine(self) -> None:
        result = self._run_backup(recovery_fails=True)
        self.assertEqual(result.returncode, 2, f"{result.stdout}\n{result.stderr}")

        quarantined = list(self.output_directory.glob("portfolio-backup-*.quarantine"))
        self.assertEqual(len(quarantined), 1)
        verification = self._verify(quarantined[0])
        self.assertEqual(verification.returncode, 0, verification.stderr)
        self.assertIn("backup data is valid, but backend readiness recovery failed", result.stderr)
        self.assertIn("verified backup quarantined", result.stderr)
        self.assertNotIn("Backup created", result.stdout)

        docker_log = self.docker_log.read_text(encoding="utf-8")
        self.assertEqual(docker_log.count(f"start {self.backend_container_id}"), 1)
        journal = self.base / "locks" / "backup-lifecycle-test.backup.json"
        self.assertTrue(journal.is_file())

    def test_unsupported_compose_version_fails_before_backend_or_backup_operations(
        self,
    ) -> None:
        result = self._run_backup(
            environment_overrides={"FAKE_COMPOSE_VERSION": "2.29.9"}
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.docker_log.read_text(encoding="utf-8").splitlines(),
            ["compose version --short"],
        )
        self.assertIn("Docker Compose 2.30.0 or newer is required", result.stderr)
        self.assertFalse(self.output_directory.exists())

    def test_stopped_backend_remains_stopped(self) -> None:
        self.backend_state_file.write_text("exited\n", encoding="ascii")

        result = self._run_backup()

        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
        docker_log = self.docker_log.read_text(encoding="utf-8")
        self.assertNotIn("stop backend", docker_log)
        self.assertNotIn(f"start {self.backend_container_id}", docker_log)
        self.assertEqual(
            self.backend_state_file.read_text(encoding="ascii").strip(),
            "exited",
        )

    def test_sigkill_after_stop_is_explicitly_recoverable_and_repeat_is_a_noop(
        self,
    ) -> None:
        interrupted = self._run_backup(
            environment_overrides={"FAKE_KILL_AFTER_STOP": "true"}
        )
        journal = self.base / "locks" / "backup-lifecycle-test.backup.json"

        self.assertEqual(interrupted.returncode, -9)
        self.assertTrue(journal.is_file())
        self.assertEqual(
            self.backend_state_file.read_text(encoding="ascii").strip(),
            "exited",
        )

        self.docker_log.unlink()
        recovered = self._retry_while_interrupted_process_holds_lock(
            lambda: self._recover_backup(
                environment_overrides={"FAKE_COMPOSE_VERSION": "2.1.0"}
            )
        )
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertFalse(journal.exists())
        self.assertIn(
            f"start {self.backend_container_id}",
            self.docker_log.read_text(encoding="utf-8"),
        )
        self.assertEqual(
            self.backend_state_file.read_text(encoding="ascii").strip(),
            "running",
        )

        self.docker_log.unlink()
        repeated = self._recover_backup()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertIn("No interrupted backup exists", repeated.stdout)
        self.assertFalse(self.docker_log.exists())

    def test_next_backup_recovers_sigkill_journal_before_new_stop(self) -> None:
        interrupted = self._run_backup(
            environment_overrides={"FAKE_KILL_AFTER_STOP": "true"}
        )
        self.assertEqual(interrupted.returncode, -9)

        self.docker_log.unlink()
        resumed = self._retry_while_interrupted_process_holds_lock(self._run_backup)

        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        operations = self.docker_log.read_text(encoding="utf-8").splitlines()
        first_start = operations.index(f"start {self.backend_container_id}")
        next_stop = next(
            index
            for index, operation in enumerate(operations)
            if " stop backend" in operation
        )
        self.assertLess(first_start, next_stop)
        self.assertFalse(
            (self.base / "locks" / "backup-lifecycle-test.backup.json").exists()
        )

    def test_next_backup_recovers_before_rejecting_old_compose(self) -> None:
        interrupted = self._run_backup(
            environment_overrides={"FAKE_KILL_AFTER_STOP": "true"}
        )
        self.assertEqual(interrupted.returncode, -9)
        journal = self.base / "locks" / "backup-lifecycle-test.backup.json"

        self.docker_log.unlink()
        rejected = self._retry_while_interrupted_process_holds_lock(
            lambda: self._run_backup(
                environment_overrides={"FAKE_COMPOSE_VERSION": "2.29.9"}
            )
        )

        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("Docker Compose 2.30.0 or newer is required", rejected.stderr)
        self.assertFalse(journal.exists())
        self.assertEqual(
            self.backend_state_file.read_text(encoding="ascii").strip(),
            "running",
        )
        operations = self.docker_log.read_text(encoding="utf-8").splitlines()
        self.assertLess(
            operations.index(f"start {self.backend_container_id}"),
            operations.index("compose version --short"),
        )
        self.assertFalse(any(" stop backend" in operation for operation in operations))

    def test_recovery_rejects_corrupt_journal_without_touching_backend(self) -> None:
        journal = self.base / "locks" / "backup-lifecycle-test.backup.json"
        journal.parent.mkdir(mode=0o700)
        journal.write_text('{"version":1', encoding="ascii")
        journal.chmod(0o600)

        recovered = self._recover_backup()

        self.assertNotEqual(recovered.returncode, 0)
        self.assertTrue(journal.is_file())
        operations = (
            self.docker_log.read_text(encoding="utf-8")
            if self.docker_log.exists()
            else ""
        )
        self.assertNotIn("inspect --type container", operations)
        self.assertNotIn(f"start {self.backend_container_id}", operations)

    def test_recovery_rejects_container_from_another_compose_project(self) -> None:
        interrupted = self._run_backup(
            environment_overrides={"FAKE_KILL_AFTER_STOP": "true"}
        )
        self.assertEqual(interrupted.returncode, -9)
        journal = self.base / "locks" / "backup-lifecycle-test.backup.json"

        self.docker_log.unlink()
        recovered = self._retry_while_interrupted_process_holds_lock(
            lambda: self._recover_backup(
                environment_overrides={"FAKE_CONTAINER_PROJECT": "other-project"}
            )
        )

        self.assertNotEqual(recovered.returncode, 0)
        self.assertTrue(journal.is_file())
        operations = self.docker_log.read_text(encoding="utf-8")
        self.assertIn("does not belong", recovered.stderr)
        self.assertNotIn(f"start {self.backend_container_id}", operations)

    def test_signing_configuration_fails_before_backend_is_stopped(self) -> None:
        bad_private = self.base / "bad-private.pem"
        bad_private.write_bytes(self.private_key.read_bytes())
        bad_private.chmod(0o644)
        self.output_directory.mkdir()
        embedded_private = self.output_directory / "private.pem"
        embedded_public = self.output_directory / "public.pem"
        embedded_private.write_bytes(self.private_key.read_bytes())
        embedded_private.chmod(0o600)
        embedded_public.write_bytes(self.public_key.read_bytes())
        embedded_public.chmod(0o644)

        for label, overrides in (
            (
                "missing-private",
                {"PORTFOLIO_BACKUP_PRIVATE_KEY_FILE": ""},
            ),
            (
                "permissions",
                {"PORTFOLIO_BACKUP_PRIVATE_KEY_FILE": str(bad_private)},
            ),
            (
                "mismatched-pair",
                {"PORTFOLIO_BACKUP_PUBLIC_KEY_FILE": str(self.other_public_key)},
            ),
            (
                "inside-backup-root",
                {
                    "PORTFOLIO_BACKUP_PRIVATE_KEY_FILE": str(embedded_private),
                    "PORTFOLIO_BACKUP_PUBLIC_KEY_FILE": str(embedded_public),
                },
            ),
        ):
            with self.subTest(label=label):
                self.docker_log.unlink(missing_ok=True)
                result = self._run_backup(environment_overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                operations = (
                    self.docker_log.read_text(encoding="utf-8")
                    if self.docker_log.exists()
                    else ""
                )
                self.assertNotIn("stop backend", operations)
                self.assertNotIn("pg_dump", operations)
                self.assertEqual(
                    list(self.output_directory.glob("portfolio-backup-*")), []
                )


if __name__ == "__main__":
    unittest.main()
