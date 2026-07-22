from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import backup_signature
from scripts.tests.backup_signature_fixture import generate_rsa_key_pair


class BackupSignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.key_context = tempfile.TemporaryDirectory()
        cls.keys = Path(cls.key_context.name)
        cls.private_key, cls.public_key = generate_rsa_key_pair(cls.keys, "current")
        cls.rotated_private_key, cls.rotated_public_key = generate_rsa_key_pair(
            cls.keys, "rotated"
        )
        cls.weak_private_key, cls.weak_public_key = generate_rsa_key_pair(
            cls.keys, "weak", bits=2048
        )
        cls.ec_private_key = cls.keys / "ec-private.pem"
        cls.ec_public_key = cls.keys / "ec-public.pem"
        subprocess.run(
            (
                "openssl",
                "genpkey",
                "-algorithm",
                "EC",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-out",
                str(cls.ec_private_key),
            ),
            check=True,
            capture_output=True,
        )
        cls.ec_private_key.chmod(0o600)
        subprocess.run(
            (
                "openssl",
                "pkey",
                "-in",
                str(cls.ec_private_key),
                "-pubout",
                "-out",
                str(cls.ec_public_key),
            ),
            check=True,
            capture_output=True,
        )
        cls.ec_public_key.chmod(0o644)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.key_context.cleanup()

    def setUp(self) -> None:
        self.context = tempfile.TemporaryDirectory()
        self.base = Path(self.context.name)
        self.checksums = self.base / "SHA256SUMS"
        self.checksums.write_bytes(
            b"0" * 64 + b"  database.dump\n"
            + b"1" * 64
            + b"  uploads.tar\n"
            + b"2" * 64
            + b"  manifest.txt\n"
        )
        self.signature = self.base / "SHA256SUMS.sig"

    def tearDown(self) -> None:
        self.context.cleanup()

    def _write_signature(self) -> str:
        identifier = backup_signature.validate_key_pair(
            self.private_key, self.public_key
        )
        self.signature.write_bytes(
            backup_signature.sign(self.checksums, self.private_key)
        )
        return identifier

    def test_signs_exact_domain_and_raw_checksum_bytes_with_pss(self) -> None:
        identifier = self._write_signature()
        backup_signature.verify(
            self.checksums,
            self.signature,
            (self.public_key,),
            identifier,
        )

        self.checksums.write_bytes(self.checksums.read_bytes().replace(b"\n", b"\r\n"))
        with self.assertRaises(backup_signature.InvalidSignatureError):
            backup_signature.verify(
                self.checksums,
                self.signature,
                (self.public_key,),
                identifier,
            )

    def test_rotation_selects_only_the_exact_spki_key_id(self) -> None:
        identifier = self._write_signature()
        backup_signature.verify(
            self.checksums,
            self.signature,
            (self.rotated_public_key, self.public_key),
            identifier,
        )
        with self.assertRaises(backup_signature.UntrustedSignatureError):
            backup_signature.verify(
                self.checksums,
                self.signature,
                (self.rotated_public_key,),
                identifier,
            )
        with self.assertRaises(backup_signature.SignatureConfigurationError):
            backup_signature.verify(
                self.checksums,
                self.signature,
                (self.public_key, self.public_key),
                identifier,
            )

    def test_rejects_weak_and_non_rsa_keys(self) -> None:
        for path, private in (
            (self.weak_private_key, True),
            (self.weak_public_key, False),
            (self.ec_private_key, True),
            (self.ec_public_key, False),
        ):
            with self.subTest(path=path.name), self.assertRaises(
                backup_signature.SignatureConfigurationError
            ):
                backup_signature.key_id(path, private=private)

    def test_rejects_unsafe_key_permissions(self) -> None:
        private_copy = self.base / "private.pem"
        private_copy.write_bytes(self.private_key.read_bytes())
        private_copy.chmod(0o644)
        public_copy = self.base / "public.pem"
        public_copy.write_bytes(self.public_key.read_bytes())
        public_copy.chmod(0o664)

        with self.assertRaises(backup_signature.SignatureConfigurationError):
            backup_signature.key_id(private_copy, private=True)
        with self.assertRaises(backup_signature.SignatureConfigurationError):
            backup_signature.key_id(public_copy, private=False)

    def test_rejects_key_not_owned_by_effective_user(self) -> None:
        with mock.patch.object(
            backup_signature.os,
            "geteuid",
            return_value=self.public_key.stat().st_uid + 1,
        ), self.assertRaises(backup_signature.SignatureConfigurationError):
            backup_signature.key_id(self.public_key, private=False)

    def test_rejects_symbolic_and_hard_linked_keys(self) -> None:
        symbolic = self.base / "symbolic.pem"
        symbolic.symlink_to(self.public_key)
        hard_link = self.base / "hard.pem"
        os.link(self.public_key, hard_link)
        try:
            for path in (symbolic, hard_link):
                with self.subTest(path=path.name), self.assertRaises(
                    backup_signature.SignatureConfigurationError
                ):
                    backup_signature.key_id(path, private=False)
        finally:
            hard_link.unlink(missing_ok=True)

    def test_rejects_key_inside_forbidden_backup_root(self) -> None:
        embedded = self.base / "embedded.pem"
        embedded.write_bytes(self.public_key.read_bytes())
        embedded.chmod(0o644)
        with self.assertRaises(
            backup_signature.SignatureConfigurationError, msg="stored outside"
        ):
            backup_signature.key_id(
                embedded, private=False, forbidden_roots=(self.base,)
            )

    def test_rejects_empty_malformed_and_changed_signature_material(self) -> None:
        identifier = self._write_signature()
        self.signature.write_bytes(b"")
        with self.assertRaises(backup_signature.InvalidSignatureError):
            backup_signature.verify(
                self.checksums, self.signature, (self.public_key,), identifier
            )

        self.signature.write_bytes(b"x" * 384)
        with self.assertRaises(backup_signature.InvalidSignatureError):
            backup_signature.verify(
                self.checksums, self.signature, (self.public_key,), identifier
            )

        with self.assertRaises(backup_signature.InvalidSignatureError):
            backup_signature.verify(
                self.checksums,
                self.signature,
                (self.public_key,),
                "spki-sha256:not-a-key-id",
            )


if __name__ == "__main__":
    unittest.main()
