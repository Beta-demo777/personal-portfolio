from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

from scripts.tests.backup_signature_fixture import (
    generate_rsa_key_pair,
    sign_checksums,
)


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import production_probe  # noqa: E402


NOW = datetime(2026, 7, 17, 0, 0, 0, tzinfo=timezone.utc)


class FakeHeaders:
    def __init__(self, content_type: str):
        self.content_type = content_type

    def get_content_type(self) -> str:
        return self.content_type


class FakeResponse:
    def __init__(
        self,
        status: int,
        *,
        url: str = "https://beta-demo.top/",
        content_type: str = "text/html",
        body: bytes = b"x",
    ):
        self.status = status
        self.url = url
        self.headers = FakeHeaders(content_type)
        self.body = body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def geturl(self) -> str:
        return self.url

    def read(self, size: int) -> bytes:
        return self.body[:size]


class ProductionProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.key_context = tempfile.TemporaryDirectory()
        cls.key_directory = Path(cls.key_context.name)
        cls.private_key, cls.public_key = generate_rsa_key_pair(
            cls.key_directory, "probe"
        )
        cls.other_private_key, cls.other_public_key = generate_rsa_key_pair(
            cls.key_directory, "other"
        )
        cls.key_id = production_probe.backup_signature.key_id(
            cls.public_key, private=False
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.key_context.cleanup()

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.backup_root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _write_backup(
        self,
        created_at: datetime,
        *,
        name: str = "portfolio-backup-20260717T000000Z",
        format_version: int = 3,
    ) -> Path:
        backup = self.backup_root / name
        backup.mkdir()
        (backup / "database.dump").write_bytes(b"database")
        (backup / "uploads.tar").write_bytes(b"uploads")
        lines = [
            f"format_version={format_version}",
            f"created_at_utc={created_at.strftime(production_probe.MANIFEST_TIMESTAMP)}",
            "application_id=personal-portfolio",
        ]
        if format_version == 3:
            lines.extend(
                (
                    "application_backup_compatibility=1",
                    "application_alembic_head=20260717_0002",
                    "signature_format_version=1",
                    "signature_algorithm=rsa-pss-sha256-mgf1-sha256-saltlen32",
                    f"signature_key_id={self.key_id}",
                    "database_format=postgresql_custom",
                    "database_alembic_head=20260717_0002",
                    f"database_bytes={(backup / 'database.dump').stat().st_size}",
                    "uploads_format=tar",
                    f"uploads_bytes={(backup / 'uploads.tar').stat().st_size}",
                )
            )
        (backup / "manifest.txt").write_text(
            "\n".join((*lines, "")),
            encoding="ascii",
        )
        self._write_checksums(backup)
        if format_version == 3:
            sign_checksums(backup, self.private_key)
        return backup

    @staticmethod
    def _write_checksums(backup: Path) -> None:
        lines = []
        for filename in production_probe.CHECKSUM_BACKUP_FILES:
            digest = hashlib.sha256((backup / filename).read_bytes()).hexdigest()
            lines.append(f"{digest}  {filename}\n")
        (backup / "SHA256SUMS").write_text("".join(lines), encoding="ascii")

    def _resign(self, backup: Path) -> None:
        sign_checksums(backup, self.private_key)

    def _check(
        self,
        *,
        public_keys: tuple[Path, ...] | None = None,
        key_configuration_error: bool = False,
    ) -> production_probe.ProbeResult:
        return production_probe.check_backup(
            self.backup_root,
            now=NOW,
            max_age_hours=26,
            public_keys=public_keys if public_keys is not None else (self.public_key,),
            key_configuration_error=key_configuration_error,
        )

    def test_origin_requires_an_exact_https_origin(self) -> None:
        target = production_probe.parse_origin("https://beta-demo.top:8443/")
        self.assertEqual(target.origin, "https://beta-demo.top:8443")
        self.assertEqual(target.port, 8443)

        for invalid in (
            "http://beta-demo.top",
            "https://user@beta-demo.top",
            "https://beta-demo.top/admin",
            "https://beta-demo.top?debug=1",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                production_probe.parse_origin(invalid)

    def test_http_probe_enforces_status_and_latency_without_reading_a_body(self) -> None:
        times = iter((10.0, 10.025, 20.0, 20.200))
        healthy = production_probe.check_http(
            "public_http",
            "https://beta-demo.top/",
            timeout_seconds=1,
            max_latency_ms=100,
            expected_media_type="text/html",
            opener=lambda *_args, **_kwargs: FakeResponse(200),
            monotonic=lambda: next(times),
        )
        slow = production_probe.check_http(
            "public_http",
            "https://beta-demo.top/",
            timeout_seconds=1,
            max_latency_ms=100,
            expected_media_type="text/html",
            opener=lambda *_args, **_kwargs: FakeResponse(200),
            monotonic=lambda: next(times),
        )

        self.assertEqual((healthy.ok, healthy.code, healthy.latency_ms), (True, "OK", 25))
        self.assertEqual((slow.ok, slow.code, slow.latency_ms), (False, "HTTP_LATENCY", 200))

    def test_readiness_probe_rejects_redirected_or_invalid_json_responses(self) -> None:
        def probe(response: FakeResponse) -> production_probe.ProbeResult:
            times = iter((1.0, 1.01))
            return production_probe.check_http(
                "backend_readiness",
                "https://beta-demo.top/backend/health/ready",
                timeout_seconds=1,
                max_latency_ms=100,
                expected_media_type="application/json",
                expected_json_status="ready",
                opener=lambda *_args, **_kwargs: response,
                monotonic=lambda: next(times),
            )

        healthy = probe(FakeResponse(
            200,
            url="https://beta-demo.top/backend/health/ready",
            content_type="application/json",
            body=b'{"status":"ready"}',
        ))
        redirected = probe(FakeResponse(
            200,
            url="https://beta-demo.top/login",
            content_type="application/json",
            body=b'{"status":"ready"}',
        ))
        wrong_payload = probe(FakeResponse(
            200,
            url="https://beta-demo.top/backend/health/ready",
            content_type="application/json",
            body=b'{"status":"ok"}',
        ))

        self.assertTrue(healthy.ok)
        self.assertEqual(redirected.code, "HTTP_CONTRACT")
        self.assertEqual(wrong_payload.code, "HTTP_CONTRACT")

    def test_tls_probe_warns_before_expiry(self) -> None:
        target = production_probe.parse_origin("https://beta-demo.top")
        healthy = production_probe.check_tls(
            target,
            now=NOW,
            timeout_seconds=1,
            warning_days=30,
            expiry_loader=lambda *_args: NOW + timedelta(days=31),
        )
        expiring = production_probe.check_tls(
            target,
            now=NOW,
            timeout_seconds=1,
            warning_days=30,
            expiry_loader=lambda *_args: NOW + timedelta(days=7),
        )

        self.assertTrue(healthy.ok)
        self.assertEqual(expiring.code, "TLS_EXPIRING")

    def test_backup_probe_accepts_only_a_fresh_published_signed_v3_backup(self) -> None:
        self._write_backup(NOW - timedelta(hours=2))
        quarantine = self.backup_root / "portfolio-backup-20260718T000000Z.quarantine"
        quarantine.mkdir()

        result = self._check()

        self.assertEqual((result.ok, result.code, result.age_seconds), (True, "OK", 7200))

    def test_backup_probe_rejects_stale_future_and_invalid_backups(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=27))
        stale = self._check()
        self.assertEqual(stale.code, "BACKUP_STALE")

        manifest = (backup / "manifest.txt").read_text(encoding="ascii").replace(
            "created_at_utc=2026-07-15T21:00:00Z",
            "created_at_utc=2026-07-18T00:00:00Z",
        )
        (backup / "manifest.txt").write_text(manifest, encoding="ascii")
        self._write_checksums(backup)
        self._resign(backup)
        future = self._check()
        self.assertEqual(future.code, "BACKUP_FROM_FUTURE")

        (backup / "manifest.txt").write_text("not-a-manifest\n", encoding="ascii")
        self._write_checksums(backup)
        self._resign(backup)
        invalid = self._check()
        self.assertEqual(invalid.code, "BACKUP_INVALID")

    def test_backup_probe_hashes_every_checksum_member(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        originals = {
            filename: (backup / filename).read_bytes()
            for filename in production_probe.CHECKSUM_BACKUP_FILES
        }

        for filename, contents in originals.items():
            with self.subTest(filename=filename):
                (backup / filename).write_bytes(contents + b"x")
                result = self._check()
                self.assertEqual((result.ok, result.code), (False, "BACKUP_INVALID"))
                (backup / filename).write_bytes(contents)

    def test_backup_probe_rejects_forged_duplicate_extra_and_malformed_checksums(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        valid_lines = (backup / "SHA256SUMS").read_text(encoding="ascii").splitlines(
            keepends=True
        )
        forged = f"{'0' * 64}  database.dump\n"
        duplicate = "".join((valid_lines[0], valid_lines[0], valid_lines[2]))
        extra = "".join((*valid_lines, f"{'0' * 64}  extra.txt\n"))
        missing = "".join(valid_lines[:2])
        malformed = valid_lines[0].replace("  ", " ", 1) + "".join(valid_lines[1:])
        uppercase = valid_lines[0][:64].upper() + valid_lines[0][64:] + "".join(valid_lines[1:])
        crlf = "".join(valid_lines).replace("\n", "\r\n")

        for label, contents in (
            ("forged", forged + "".join(valid_lines[1:])),
            ("duplicate", duplicate),
            ("extra", extra),
            ("missing", missing),
            ("malformed", malformed),
            ("uppercase", uppercase),
            ("crlf", crlf),
        ):
            with self.subTest(label=label):
                (backup / "SHA256SUMS").write_text(contents, encoding="ascii")
                self._resign(backup)
                result = self._check()
                self.assertEqual((result.ok, result.code), (False, "BACKUP_INVALID"))

    def test_backup_probe_rejects_symbolic_link_members(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        checksum = backup / "SHA256SUMS"
        target = self.backup_root / "external-checksums"
        target.write_bytes(checksum.read_bytes())
        checksum.unlink()
        checksum.symlink_to(target)

        result = self._check()

        self.assertEqual(
            (result.ok, result.code), (False, "BACKUP_SIGNATURE_INVALID")
        )

    def test_backup_probe_rejects_hard_link_members(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        os.link(backup / "database.dump", self.backup_root / "linked-database.dump")

        result = self._check()

        self.assertEqual((result.ok, result.code), (False, "BACKUP_INVALID"))

    def test_backup_probe_treats_a_missing_published_member_as_invalid(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        (backup / "uploads.tar").unlink()

        result = self._check()

        self.assertEqual((result.ok, result.code), (False, "BACKUP_INVALID"))

    def test_backup_probe_reports_missing_without_accepting_quarantine(self) -> None:
        (self.backup_root / "portfolio-backup-20260717T000000Z.quarantine").mkdir()
        result = self._check()
        self.assertEqual((result.ok, result.code), (False, "BACKUP_MISSING"))

    def test_backup_probe_distinguishes_signature_failure_classes(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))

        missing_configuration = self._check(public_keys=())
        self.assertEqual(missing_configuration.code, "BACKUP_SIGNATURE_CONFIG")

        untrusted = self._check(public_keys=(self.other_public_key,))
        self.assertEqual(untrusted.code, "BACKUP_UNTRUSTED")

        (backup / "SHA256SUMS.sig").write_bytes(b"invalid")
        invalid = self._check()
        self.assertEqual(invalid.code, "BACKUP_SIGNATURE_INVALID")

    def test_probe_environment_keyring_rejects_empty_entries(self) -> None:
        keys, invalid = production_probe._configured_public_keys(
            [self.other_public_key],
            {
                "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES": str(self.public_key)
            },
        )
        self.assertFalse(invalid)
        self.assertEqual(keys[0], self.other_public_key)
        self.assertIn(self.public_key, keys)

        for configured in ("", f"{self.public_key}:", f":{self.public_key}"):
            with self.subTest(configured=configured):
                keys, invalid = production_probe._configured_public_keys(
                    [], {"PORTFOLIO_BACKUP_PUBLIC_KEY_FILES": configured}
                )
                self.assertEqual(keys, ())
                self.assertTrue(invalid)

    def test_backup_probe_rejects_unsigned_legacy_without_a_bypass(self) -> None:
        self._write_backup(
            NOW - timedelta(hours=2),
            format_version=2,
        )

        result = self._check()

        self.assertEqual((result.ok, result.code), (False, "BACKUP_UNSIGNED"))

    def test_backup_probe_rejects_embedded_or_unsafe_public_key_configuration(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        embedded = backup / "public.pem"
        embedded.write_bytes(self.public_key.read_bytes())
        embedded.chmod(0o644)
        embedded_result = self._check(public_keys=(embedded,))
        self.assertEqual(embedded_result.code, "BACKUP_SIGNATURE_CONFIG")

        unsafe = self.backup_root.parent / "unsafe-public.pem"
        unsafe.write_bytes(self.public_key.read_bytes())
        unsafe.chmod(0o666)
        try:
            unsafe_result = self._check(public_keys=(unsafe,))
            self.assertEqual(unsafe_result.code, "BACKUP_SIGNATURE_CONFIG")
        finally:
            unsafe.unlink(missing_ok=True)

    def test_backup_probe_rejects_signed_but_unrestorable_manifest_contracts(self) -> None:
        backup = self._write_backup(NOW - timedelta(hours=2))
        original = (backup / "manifest.txt").read_text(encoding="ascii")
        malformed_manifests = (
            original + "unexpected=value\n",
            original.replace(
                f"database_bytes={(backup / 'database.dump').stat().st_size}",
                "database_bytes=1",
            ),
            original.replace(
                "application_alembic_head=20260717_0002",
                "application_alembic_head=invalid revision",
            ),
        )

        for manifest in malformed_manifests:
            with self.subTest(manifest=manifest.splitlines()[-1]):
                (backup / "manifest.txt").write_text(manifest, encoding="ascii")
                self._write_checksums(backup)
                self._resign(backup)
                result = self._check()
                self.assertEqual((result.ok, result.code), (False, "BACKUP_INVALID"))


if __name__ == "__main__":
    unittest.main()
