from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from scripts.tests.toc_fixtures import PG18_APPLICATION_TOC
from scripts.tests.backup_signature_fixture import (
    generate_rsa_key_pair,
    sign_checksums,
)
from scripts import backup_signature


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
RESTORE_SCRIPT = SCRIPTS_DIR / "restore.sh"


class RestoreManifestPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.key_context = tempfile.TemporaryDirectory()
        cls.key_directory = Path(cls.key_context.name)
        cls.private_key, cls.public_key = generate_rsa_key_pair(
            cls.key_directory, "restore"
        )
        cls.other_private_key, cls.other_public_key = generate_rsa_key_pair(
            cls.key_directory, "other"
        )
        cls.key_id = backup_signature.key_id(cls.public_key, private=False)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.key_context.cleanup()

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.backup = self.base / "backup"
        self.backup.mkdir()
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.docker_log = self.base / "docker.log"
        self.pg_restore_toc = self.base / "pg_restore.toc"
        self.pg_restore_toc.write_text(PG18_APPLICATION_TOC, encoding="ascii")

        (self.fake_bin / "pg_restore").write_text(
            '#!/bin/sh\ncat "$PG_RESTORE_TOC_FILE"\n', encoding="ascii"
        )
        (self.fake_bin / "pg_restore").chmod(0o755)
        (self.fake_bin / "docker").write_text(
            """#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$*" = "compose version --short" ]; then
    printf '%s\\n' "${FAKE_COMPOSE_VERSION:-2.30.0}"
    exit 0
fi
case "$*" in
    *validate-metadata*) exit "${VALIDATE_METADATA_STATUS:-41}" ;;
    *'/tmp/restore_uploads.py preflight-capacity'*)
        status=${UPLOAD_PREFLIGHT_STATUS:-99}
        if [ "$status" -ne 0 ]; then
            exit "$status"
        fi
        printf '%s\\n' "${UPLOAD_CAPACITY_STATS:-1 1073741824 1073741824 1048576 1024 1}"
        exit 0
        ;;
    *'pg_restore --no-owner --no-privileges --file=-'*)
        printf 'plain restore stream'
        exit 0
        ;;
    *'pg_restore --list'*)
        printf '1; 0 0 TABLE public fixture owner\\n'
        exit 0
        ;;
    *'df -Pk'*)
        printf '%s\\n' "${DATABASE_FILESYSTEM_STATS:-1 1048576 1 1048576}"
        exit 0
        ;;
esac
exit 99
""",
            encoding="ascii",
        )
        (self.fake_bin / "docker").chmod(0o755)

        (self.backup / "database.dump").write_bytes(b"PGDMP-test-custom-dump")
        with tarfile.open(self.backup / "uploads.tar", mode="w") as archive:
            payload = b"media"
            member = tarfile.TarInfo("1" * 32 + ".png")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _write_manifest(self, format_version: int, database_head: str = "") -> None:
        lines = [
            f"format_version={format_version}",
            "created_at_utc=2026-07-17T00:00:00Z",
        ]
        if format_version in (2, 3):
            lines.extend(
                (
                    "application_id=personal-portfolio",
                    "application_backup_compatibility=1",
                    "application_alembic_head=20260717_0002",
                )
            )
        if format_version == 3:
            lines.extend(
                (
                    "signature_format_version=1",
                    "signature_algorithm=rsa-pss-sha256-mgf1-sha256-saltlen32",
                    f"signature_key_id={self.key_id}",
                )
            )
        lines.append("database_format=postgresql_custom")
        if format_version in (2, 3):
            lines.append(f"database_alembic_head={database_head}")
        lines.extend(
            (
                f"database_bytes={(self.backup / 'database.dump').stat().st_size}",
                "uploads_format=tar",
                f"uploads_bytes={(self.backup / 'uploads.tar').stat().st_size}",
            )
        )
        (self.backup / "manifest.txt").write_text(
            "\n".join((*lines, "")), encoding="ascii"
        )
        checksums = []
        for filename in ("database.dump", "uploads.tar", "manifest.txt"):
            digest = hashlib.sha256((self.backup / filename).read_bytes()).hexdigest()
            checksums.append(f"{digest}  {filename}\n")
        (self.backup / "SHA256SUMS").write_text("".join(checksums), encoding="ascii")
        if format_version == 3:
            sign_checksums(self.backup, self.private_key)
        else:
            (self.backup / "SHA256SUMS.sig").unlink(missing_ok=True)

    def _restore(
        self,
        environment_overrides: dict[str, str] | None = None,
        *,
        allow_legacy_v1: bool = False,
        allow_unsigned_legacy: bool = False,
        public_keys: tuple[Path, ...] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.pop("PORTFOLIO_BACKUP_PUBLIC_KEY_FILES", None)
        environment["PATH"] = f"{self.fake_bin}{os.pathsep}{environment['PATH']}"
        environment["DOCKER_LOG"] = str(self.docker_log)
        environment["PORTFOLIO_MAINTENANCE_LOCK_DIR"] = str(self.base / "locks")
        environment["PG_RESTORE_TOC_FILE"] = str(self.pg_restore_toc)
        environment.update(environment_overrides or {})
        command = [str(RESTORE_SCRIPT), "--backup", str(self.backup), "--yes"]
        if allow_legacy_v1:
            command.append("--allow-legacy-v1")
        if allow_unsigned_legacy:
            command.append("--allow-unsigned-legacy")
        for public_key in public_keys if public_keys is not None else (self.public_key,):
            command.extend(("--public-key", str(public_key)))
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_unsupported_compose_version_fails_before_every_restore_operation(
        self,
    ) -> None:
        result = self._restore({"FAKE_COMPOSE_VERSION": "2.29.9"})

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.docker_log.read_text(encoding="utf-8").splitlines(),
            ["compose version --short"],
        )
        self.assertIn("Docker Compose 2.30.0 or newer is required", result.stderr)

    def _assert_no_current_data_operation(self) -> None:
        log = self.docker_log.read_text(encoding="utf-8")
        for operation in ("createdb", "pg_restore", "stop backend", "activate"):
            self.assertNotIn(operation, log)

    def test_legacy_v1_requires_explicit_opt_in_before_any_data_operation(self) -> None:
        self._write_manifest(1)
        result = self._restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsigned legacy", result.stderr)
        self._assert_no_current_data_operation()

        unsigned_only = self._restore(
            allow_unsigned_legacy=True,
            public_keys=(),
        )
        self.assertNotEqual(unsigned_only.returncode, 0)
        self.assertIn("legacy format v1 cannot be restored by default", unsigned_only.stderr)
        self._assert_no_current_data_operation()

    def test_unsigned_v2_requires_explicit_opt_in(self) -> None:
        self._write_manifest(2, "20260717_0002")
        rejected = self._restore(public_keys=())
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("unsigned legacy", rejected.stderr)
        self._assert_no_current_data_operation()

        allowed = self._restore(
            {"VALIDATE_METADATA_STATUS": "41"},
            allow_unsigned_legacy=True,
            public_keys=(),
        )
        self.assertEqual(allowed.returncode, 41)
        self.assertIn("allowing unsigned legacy format v2", allowed.stderr)
        self._assert_no_current_data_operation()

    def test_future_manifest_is_rejected_before_any_data_operation(self) -> None:
        self._write_manifest(3, "20990101_9999")
        result = self._restore()
        self.assertEqual(result.returncode, 41)
        self._assert_no_current_data_operation()

    def test_valid_legacy_v1_toc_reaches_read_only_preflight_after_opt_in(self) -> None:
        self._write_manifest(1)
        result = self._restore(
            {"UPLOAD_PREFLIGHT_STATUS": "77"},
            allow_legacy_v1=True,
            allow_unsigned_legacy=True,
            public_keys=(),
        )

        self.assertEqual(result.returncode, 77, result.stderr)
        self.assertIn("explicitly allowing legacy v1", result.stderr)
        log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn("preflight-capacity", log)
        for operation in ("createdb", "stop backend", "activate --token"):
            self.assertNotIn(operation, log)

    def test_toc_policy_failure_precedes_migration_and_every_data_operation(self) -> None:
        self._write_manifest(3, "20260717_0002")
        secret_marker = "private-trigger-name-must-not-leak"
        self.pg_restore_toc.write_text(
            PG18_APPLICATION_TOC
            + f"9010; 3466 17000 EVENT TRIGGER - {secret_marker} portfolio\n",
            encoding="ascii",
        )

        result = self._restore({"VALIDATE_METADATA_STATUS": "0"})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PostgreSQL object policy", result.stderr)
        self.assertNotIn(secret_marker, result.stdout + result.stderr)
        log = self.docker_log.read_text(encoding="utf-8")
        self.assertNotIn("validate-metadata", log)
        for operation in ("preflight-capacity", "createdb", "stop backend", "activate"):
            self.assertNotIn(operation, log)

    def test_upload_capacity_failure_precedes_every_data_write(self) -> None:
        self._write_manifest(3, "20260717_0002")
        result = self._restore(
            {
                "VALIDATE_METADATA_STATUS": "0",
                "UPLOAD_PREFLIGHT_STATUS": "77",
            }
        )

        self.assertEqual(result.returncode, 77, result.stderr)
        log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn("preflight-capacity", log)
        for operation in ("createdb", "stop backend", "activate --token"):
            self.assertNotIn(operation, log)

    def test_database_capacity_failure_precedes_every_data_write(self) -> None:
        self._write_manifest(3, "20260717_0002")
        result = self._restore(
            {
                "VALIDATE_METADATA_STATUS": "0",
                "UPLOAD_PREFLIGHT_STATUS": "0",
                "DATABASE_FILESYSTEM_STATS": "1 1048576 1 1048576",
            }
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("insufficient free space", result.stderr)
        log = self.docker_log.read_text(encoding="utf-8")
        self.assertIn("pg_restore --no-owner --no-privileges --file=-", log)
        for operation in ("createdb", "stop backend", "activate --token"):
            self.assertNotIn(operation, log)

    def test_invalid_or_untrusted_v3_signature_fails_before_data_operations(self) -> None:
        self._write_manifest(3, "20260717_0002")
        invalid_signature = (self.backup / "SHA256SUMS.sig").read_bytes()
        (self.backup / "SHA256SUMS.sig").write_bytes(invalid_signature[:-1] + b"x")

        invalid = self._restore(allow_unsigned_legacy=True)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("signature", invalid.stderr)
        self.assertNotIn("allowing unsigned", invalid.stderr)
        self._assert_no_current_data_operation()

        self._write_manifest(3, "20260717_0002")
        untrusted = self._restore(public_keys=(self.other_public_key,))
        self.assertNotEqual(untrusted.returncode, 0)
        self.assertIn("no configured backup public key matches", untrusted.stderr)
        self._assert_no_current_data_operation()

    def test_rejects_public_key_from_original_backup_before_data_operations(self) -> None:
        self._write_manifest(3, "20260717_0002")
        embedded = self.backup / "embedded-public.pem"
        embedded.write_bytes(self.public_key.read_bytes())
        embedded.chmod(0o644)

        result = self._restore(public_keys=(embedded,))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stored outside", result.stderr)
        self._assert_no_current_data_operation()


if __name__ == "__main__":
    unittest.main()
