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
VERIFY_SCRIPT = SCRIPTS_DIR / "verify-backup.sh"


class VerifyBackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.key_directory_context = tempfile.TemporaryDirectory()
        cls.key_directory = Path(cls.key_directory_context.name)
        cls.private_key, cls.public_key = generate_rsa_key_pair(
            cls.key_directory, "current"
        )
        cls.rotated_private_key, cls.rotated_public_key = generate_rsa_key_pair(
            cls.key_directory, "rotated"
        )
        cls.key_id = backup_signature.key_id(cls.public_key, private=False)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.key_directory_context.cleanup()

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.backup = self.base / "backup"
        self.backup.mkdir()
        self.fake_bin = self.base / "bin"
        self.fake_bin.mkdir()
        self.pg_restore_toc = self.base / "pg_restore.toc"
        self.pg_restore_toc.write_text(PG18_APPLICATION_TOC, encoding="ascii")
        pg_restore = self.fake_bin / "pg_restore"
        pg_restore.write_text(
            '#!/bin/sh\ncat "$PG_RESTORE_TOC_FILE"\n', encoding="ascii"
        )
        pg_restore.chmod(0o755)

        (self.backup / "database.dump").write_bytes(b"PGDMP-test-custom-dump")
        self._write_valid_uploads_archive()
        self._write_manifest()
        self._write_checksums()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _write_valid_uploads_archive(self) -> None:
        with tarfile.open(self.backup / "uploads.tar", mode="w") as archive:
            payload = b"media"
            member = tarfile.TarInfo("1" * 32 + ".png")
            member.size = len(payload)
            member.mtime = 1_700_000_000
            archive.addfile(member, io.BytesIO(payload))

    def _write_manifest(
        self,
        *,
        database_bytes: int | None = None,
        format_version: int = 3,
        application_id: str = "personal-portfolio",
        extra_line: str | None = None,
    ) -> None:
        database_size = (self.backup / "database.dump").stat().st_size
        uploads_size = (self.backup / "uploads.tar").stat().st_size
        lines = [
            f"format_version={format_version}",
            "created_at_utc=2026-07-17T00:00:00Z",
        ]
        if format_version in (2, 3):
            lines.extend(
                (
                    f"application_id={application_id}",
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
        lines.extend(
            (
                "database_format=postgresql_custom",
                *(
                    ("database_alembic_head=20260716_0001",)
                    if format_version in (2, 3)
                    else ()
                ),
                f"database_bytes={database_size if database_bytes is None else database_bytes}",
                "uploads_format=tar",
                f"uploads_bytes={uploads_size}",
            )
        )
        if extra_line is not None:
            lines.append(extra_line)
        (self.backup / "manifest.txt").write_text(
            "\n".join((*lines, "")),
            encoding="ascii",
        )

    def _write_checksums(self) -> None:
        lines = []
        for filename in ("database.dump", "uploads.tar", "manifest.txt"):
            digest = hashlib.sha256((self.backup / filename).read_bytes()).hexdigest()
            lines.append(f"{digest}  {filename}\n")
        (self.backup / "SHA256SUMS").write_text("".join(lines), encoding="ascii")
        format_line = (self.backup / "manifest.txt").read_text(encoding="ascii").splitlines()[0]
        if format_line == "format_version=3":
            sign_checksums(self.backup, self.private_key)
        else:
            (self.backup / "SHA256SUMS.sig").unlink(missing_ok=True)

    def _verify(
        self,
        *,
        public_keys: tuple[Path, ...] | None = None,
        allow_unsigned_legacy: bool = False,
        environment_overrides: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.pop("PORTFOLIO_BACKUP_PUBLIC_KEY_FILES", None)
        environment["PATH"] = f"{self.fake_bin}{os.pathsep}{environment['PATH']}"
        environment["PG_RESTORE_TOC_FILE"] = str(self.pg_restore_toc)
        environment.update(environment_overrides or {})
        command = [str(VERIFY_SCRIPT), "--backup", str(self.backup)]
        for public_key in public_keys if public_keys is not None else (self.public_key,):
            command.extend(("--public-key", str(public_key)))
        if allow_unsigned_legacy:
            command.append("--allow-unsigned-legacy")
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

    def test_accepts_backup_whose_manifest_and_members_match(self) -> None:
        result = self._verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Backup verified", result.stdout)

    def test_rejects_unsigned_v1_and_v2_without_explicit_legacy_opt_in(self) -> None:
        for format_version in (1, 2):
            with self.subTest(format_version=format_version):
                self._write_manifest(format_version=format_version)
                self._write_checksums()
                rejected = self._verify(public_keys=())
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("unsigned legacy", rejected.stderr)

                allowed = self._verify(
                    public_keys=(), allow_unsigned_legacy=True
                )
                self.assertEqual(allowed.returncode, 0, allowed.stderr)
                self.assertIn(
                    f"allowing unsigned legacy format v{format_version}",
                    allowed.stderr,
                )

    def test_verifies_legacy_v1_with_explicit_compatibility_warning(self) -> None:
        self._write_manifest(format_version=1)
        self._write_checksums()
        result = self._verify(public_keys=(), allow_unsigned_legacy=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("legacy format v1", result.stderr)

    def test_rejects_manifest_for_another_application(self) -> None:
        self._write_manifest(application_id="other-application")
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("different application", result.stderr)

    def test_rejects_unknown_manifest_key(self) -> None:
        self._write_manifest(extra_line="unexpected=value")
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported key", result.stderr)

    def test_rejects_manifest_size_mismatch_even_with_fresh_checksum(self) -> None:
        self._write_manifest(database_bytes=1)
        self._write_checksums()
        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest size mismatch", result.stderr)

    def test_rejects_upload_temporary_member_even_with_fresh_checksum(self) -> None:
        with tarfile.open(self.backup / "uploads.tar", mode="w") as archive:
            payload = b"unfinished"
            member = tarfile.TarInfo(".upload-attacker.tmp")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        self._write_manifest()
        self._write_checksums()

        result = self._verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid or unreadable media entries", result.stderr)

    def test_rejects_non_application_database_object_without_echoing_its_name(self) -> None:
        secret_marker = "private-function-name-must-not-leak"
        self.pg_restore_toc.write_text(
            PG18_APPLICATION_TOC
            + f"9010; 1255 17000 FUNCTION public {secret_marker}() portfolio\n",
            encoding="ascii",
        )

        result = self._verify()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PostgreSQL object policy", result.stderr)
        self.assertNotIn(secret_marker, result.stdout + result.stderr)

    def test_rejects_tampering_even_when_attacker_recomputes_checksums(self) -> None:
        (self.backup / "database.dump").write_bytes(b"PGDMP-attacker-replacement")
        database_size = (self.backup / "database.dump").stat().st_size
        manifest = (self.backup / "manifest.txt").read_text(encoding="ascii")
        manifest = manifest.replace(
            next(
                line
                for line in manifest.splitlines()
                if line.startswith("database_bytes=")
            ),
            f"database_bytes={database_size}",
        )
        (self.backup / "manifest.txt").write_text(manifest, encoding="ascii")
        signature = (self.backup / "SHA256SUMS.sig").read_bytes()
        lines = []
        for filename in ("database.dump", "uploads.tar", "manifest.txt"):
            digest = hashlib.sha256((self.backup / filename).read_bytes()).hexdigest()
            lines.append(f"{digest}  {filename}\n")
        (self.backup / "SHA256SUMS").write_text("".join(lines), encoding="ascii")
        (self.backup / "SHA256SUMS.sig").write_bytes(signature)

        result = self._verify()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature", result.stderr)

    def test_selects_rotated_public_key_only_by_manifest_key_id(self) -> None:
        result = self._verify(
            public_keys=(self.rotated_public_key, self.public_key)
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        untrusted = self._verify(public_keys=(self.rotated_public_key,))
        self.assertNotEqual(untrusted.returncode, 0)
        self.assertIn("no configured backup public key matches", untrusted.stderr)

    def test_v3_signature_failure_never_falls_back_to_legacy(self) -> None:
        (self.backup / "SHA256SUMS.sig").write_bytes(b"invalid")

        result = self._verify(allow_unsigned_legacy=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature", result.stderr)
        self.assertNotIn("allowing unsigned", result.stderr)

    def test_rejects_public_key_stored_inside_backup(self) -> None:
        embedded = self.backup / "embedded-public.pem"
        embedded.write_bytes(self.public_key.read_bytes())
        embedded.chmod(0o644)

        result = self._verify(public_keys=(embedded,))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stored outside", result.stderr)

    def test_accepts_environment_keyring_and_rejects_empty_or_duplicate_entries(self) -> None:
        accepted = self._verify(
            public_keys=(),
            environment_overrides={
                "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES": (
                    f"{self.rotated_public_key}:{self.public_key}"
                )
            },
        )
        self.assertEqual(accepted.returncode, 0, accepted.stderr)

        for configured in (
            f"{self.public_key}:",
            f"{self.public_key}:{self.public_key}",
        ):
            with self.subTest(configured=configured):
                rejected = self._verify(
                    public_keys=(),
                    environment_overrides={
                        "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES": configured
                    },
                )
                self.assertNotEqual(rejected.returncode, 0)


if __name__ == "__main__":
    unittest.main()
