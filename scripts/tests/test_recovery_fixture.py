from __future__ import annotations

import hashlib
from pathlib import Path
import tarfile
import tempfile
import unittest

from scripts import backup_signature
from scripts.tests import recovery_fixture
from scripts.tests.backup_signature_fixture import (
    generate_rsa_key_pair,
    sign_checksums,
)


class RecoveryFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.key_context = tempfile.TemporaryDirectory()
        cls.key_directory = Path(cls.key_context.name)
        cls.private_key, cls.public_key = generate_rsa_key_pair(
            cls.key_directory, "fixture"
        )
        cls.key_id = backup_signature.key_id(cls.public_key, private=False)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.key_context.cleanup()

    def setUp(self) -> None:
        self.context = tempfile.TemporaryDirectory()
        self.backup = Path(self.context.name) / "backup"
        self.backup.mkdir()
        (self.backup / "database.dump").write_bytes(b"PGDMP-fixture")
        with tarfile.open(self.backup / "uploads.tar", mode="w"):
            pass
        self._write_manifest_and_checksums()

    def tearDown(self) -> None:
        self.context.cleanup()

    def _write_manifest_and_checksums(self) -> None:
        (self.backup / "manifest.txt").write_text(
            "\n".join(
                (
                    "format_version=3",
                    "created_at_utc=2026-07-17T00:00:00Z",
                    "application_id=personal-portfolio",
                    "application_backup_compatibility=1",
                    "application_alembic_head=20260717_0002",
                    "signature_format_version=1",
                    "signature_algorithm=rsa-pss-sha256-mgf1-sha256-saltlen32",
                    f"signature_key_id={self.key_id}",
                    "database_format=postgresql_custom",
                    "database_alembic_head=20260717_0002",
                    f"database_bytes={(self.backup / 'database.dump').stat().st_size}",
                    "uploads_format=tar",
                    f"uploads_bytes={(self.backup / 'uploads.tar').stat().st_size}",
                    "",
                )
            ),
            encoding="ascii",
        )
        checksums = []
        for filename in ("database.dump", "uploads.tar", "manifest.txt"):
            digest = hashlib.sha256((self.backup / filename).read_bytes()).hexdigest()
            checksums.append(f"{digest}  {filename}\n")
        (self.backup / "SHA256SUMS").write_text(
            "".join(checksums), encoding="ascii"
        )
        sign_checksums(self.backup, self.private_key)

    def test_semantic_media_corruption_is_resigned_with_the_ci_private_key(self) -> None:
        original_signature = (self.backup / "SHA256SUMS.sig").read_bytes()

        recovery_fixture.corrupt_backup_media(self.backup, self.private_key)

        replacement_signature = (self.backup / "SHA256SUMS.sig").read_bytes()
        self.assertNotEqual(replacement_signature, original_signature)
        backup_signature.verify(
            self.backup / "SHA256SUMS",
            self.backup / "SHA256SUMS.sig",
            (self.public_key,),
            self.key_id,
        )
        manifest = (self.backup / "manifest.txt").read_text(encoding="ascii")
        self.assertIn(
            f"uploads_bytes={(self.backup / 'uploads.tar').stat().st_size}",
            manifest,
        )


if __name__ == "__main__":
    unittest.main()
