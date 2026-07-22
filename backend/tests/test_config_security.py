import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_support import configure_test_environment

configure_test_environment()

import os

from pydantic import ValidationError

from app.core.config import Settings


VALID_ARGON2ID_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$"
    "c2FsdHNhbHRzYWx0c2FsdA$"
    "aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA"
)


class SettingsSecretTests(unittest.TestCase):
    def settings(self, **overrides) -> Settings:
        values = {
            "POSTGRES_USER": "test",
            "POSTGRES_PASSWORD": "database-password",
            "POSTGRES_DB": "portfolio",
            "ADMIN_ENABLED": False,
        }
        values.update(overrides)
        with patch.dict(os.environ, {}, clear=True):
            return Settings(_env_file=None, **values)

    @staticmethod
    def secret_file(directory: str, name: str, value: str, mode: int = 0o600) -> Path:
        path = Path(directory) / name
        path.write_text(value, encoding="utf-8")
        path.chmod(mode)
        return path

    def test_secret_files_resolve_and_strip_only_trailing_newlines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_file = self.secret_file(directory, "database", "database-from-file\n")
            password_file = self.secret_file(
                directory,
                "admin-hash",
                f"{VALID_ARGON2ID_HASH}\n",
            )
            secret_file = self.secret_file(directory, "session", f"{'s' * 32}\n")

            configured = self.settings(
                POSTGRES_PASSWORD=None,
                POSTGRES_PASSWORD_FILE=database_file,
                ADMIN_ENABLED=True,
                BLOG_ADMIN_PASSWORD_HASH_FILE=password_file,
                APP_SECRET_KEY_FILE=secret_file,
            )

        self.assertEqual(configured.POSTGRES_PASSWORD, "database-from-file")
        self.assertEqual(configured.BLOG_ADMIN_PASSWORD_HASH, VALID_ARGON2ID_HASH)
        self.assertEqual(configured.APP_SECRET_KEY, "s" * 32)

    def test_direct_value_and_file_conflict_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_file = self.secret_file(directory, "database", "from-file")
            with self.assertRaisesRegex(ValidationError, "cannot both be configured"):
                self.settings(POSTGRES_PASSWORD_FILE=database_file)

    def test_empty_insecure_and_symlink_secret_files_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            empty = self.secret_file(directory, "empty", "\n")
            read_only = self.secret_file(directory, "read-only", "read-only-secret", mode=0o444)
            insecure = self.secret_file(directory, "insecure", "secret", mode=0o666)
            target = self.secret_file(directory, "target", "secret")
            symlink = Path(directory) / "link"
            symlink.symlink_to(target)

            for path, expected_message in (
                (empty, "must not be empty"),
                (insecure, "writable by group or other users"),
                (symlink, "symbolic link"),
            ):
                with self.subTest(path=path.name), self.assertRaisesRegex(
                    ValidationError,
                    expected_message,
                ):
                    self.settings(POSTGRES_PASSWORD=None, POSTGRES_PASSWORD_FILE=path)

            configured = self.settings(
                POSTGRES_PASSWORD=None,
                POSTGRES_PASSWORD_FILE=read_only,
            )
            self.assertEqual(configured.POSTGRES_PASSWORD, "read-only-secret")

    def test_admin_enabled_requires_strong_credentials_and_session_secret(self) -> None:
        with self.assertRaisesRegex(ValidationError, "BLOG_ADMIN_PASSWORD_HASH"):
            self.settings(ADMIN_ENABLED=True, APP_SECRET_KEY="s" * 32)
        with self.assertRaisesRegex(ValidationError, "at least 32 bytes"):
            self.settings(
                ADMIN_ENABLED=True,
                BLOG_ADMIN_PASSWORD_HASH=VALID_ARGON2ID_HASH,
                APP_SECRET_KEY="too-short",
            )

    def test_validation_errors_do_not_echo_secret_inputs(self) -> None:
        database_secret = "database-value-that-must-stay-private"
        admin_secret = "invalid-admin-hash-that-must-stay-private"
        session_secret = "session-value-that-must-stay-private"
        with self.assertRaises(ValidationError) as rejected:
            self.settings(
                POSTGRES_PASSWORD=database_secret,
                ADMIN_ENABLED=True,
                BLOG_ADMIN_PASSWORD_HASH=admin_secret,
                APP_SECRET_KEY=session_secret,
            )
        rendered_error = str(rejected.exception)
        self.assertNotIn(database_secret, rendered_error)
        self.assertNotIn(admin_secret, rendered_error)
        self.assertNotIn(session_secret, rendered_error)

    def test_argon2id_hash_is_the_only_administrator_credential_field(self) -> None:
        configured = self.settings(
            ADMIN_ENABLED=True,
            BLOG_ADMIN_PASSWORD_HASH=VALID_ARGON2ID_HASH,
            APP_SECRET_KEY="s" * 32,
        )
        self.assertEqual(configured.BLOG_ADMIN_PASSWORD_HASH, VALID_ARGON2ID_HASH)
        self.assertNotIn("BLOG_ADMIN_PASSWORD", Settings.model_fields)
        self.assertNotIn("BLOG_ADMIN_PASSWORD_FILE", Settings.model_fields)
        self.assertNotIn("ADMIN_ALLOW_LEGACY_PASSWORD", Settings.model_fields)

    def test_argon2id_hash_can_be_loaded_from_a_read_only_secret_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hash_file = self.secret_file(
                directory,
                "admin-hash",
                f"{VALID_ARGON2ID_HASH}\n",
                mode=0o444,
            )
            configured = self.settings(
                ADMIN_ENABLED=True,
                BLOG_ADMIN_PASSWORD_HASH_FILE=hash_file,
                APP_SECRET_KEY="s" * 32,
            )

        self.assertEqual(configured.BLOG_ADMIN_PASSWORD_HASH, VALID_ARGON2ID_HASH)

    def test_legacy_password_input_cannot_enable_administrator_authentication(self) -> None:
        with self.assertRaisesRegex(ValidationError, "BLOG_ADMIN_PASSWORD_HASH"):
            self.settings(
                ADMIN_ENABLED=True,
                BLOG_ADMIN_PASSWORD="strong-admin-password",  # secret-scan: allow-test-fixture
                APP_SECRET_KEY="s" * 32,
            )

    def test_weak_or_malformed_argon2id_parameters_are_rejected(self) -> None:
        for encoded_hash in (
            "$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
            "$argon2id$v=19$m=1024,t=1,p=1$c2FsdA$aGFzaA",
        ):
            with self.subTest(encoded_hash=encoded_hash), self.assertRaisesRegex(
                ValidationError,
                "Argon2id|memory cost",
            ):
                self.settings(
                    ADMIN_ENABLED=True,
                    BLOG_ADMIN_PASSWORD_HASH=encoded_hash,
                    APP_SECRET_KEY="s" * 32,
                )

    def test_database_timeouts_are_bounded_and_render_connection_options(self) -> None:
        configured = self.settings(
            DB_CONNECT_TIMEOUT_SECONDS=5,
            DB_POOL_TIMEOUT_SECONDS=7,
            DB_STATEMENT_TIMEOUT_MS=11_000,
            DB_MIGRATION_STATEMENT_TIMEOUT_MS=90_000,
        )

        self.assertEqual(
            configured.database_connect_args(),
            {"connect_timeout": 5, "options": "-c statement_timeout=11000"},
        )
        self.assertEqual(
            configured.database_connect_args(migration=True),
            {"connect_timeout": 5, "options": "-c statement_timeout=90000"},
        )

        for field_name, invalid_value in (
            ("DB_CONNECT_TIMEOUT_SECONDS", 0),
            ("DB_CONNECT_TIMEOUT_SECONDS", 21),
            ("DB_POOL_TIMEOUT_SECONDS", 0),
            ("DB_POOL_TIMEOUT_SECONDS", 21),
            ("DB_STATEMENT_TIMEOUT_MS", 99),
            ("DB_STATEMENT_TIMEOUT_MS", 20_001),
            ("DB_MIGRATION_STATEMENT_TIMEOUT_MS", 999),
        ):
            with self.subTest(field_name=field_name), self.assertRaises(ValidationError):
                self.settings(**{field_name: invalid_value})

        with self.assertRaisesRegex(ValidationError, "must total at most 25000 ms"):
            self.settings(
                DB_CONNECT_TIMEOUT_SECONDS=5,
                DB_POOL_TIMEOUT_SECONDS=5,
                DB_STATEMENT_TIMEOUT_MS=15_001,
            )

    def test_upload_processing_concurrency_is_bounded(self) -> None:
        for concurrency in (1, 16):
            with self.subTest(concurrency=concurrency):
                configured = self.settings(MAX_CONCURRENT_UPLOADS=concurrency)
                self.assertEqual(configured.MAX_CONCURRENT_UPLOADS, concurrency)

        for invalid_concurrency in (0, 17):
            with self.subTest(invalid_concurrency=invalid_concurrency), self.assertRaises(
                ValidationError
            ):
                self.settings(MAX_CONCURRENT_UPLOADS=invalid_concurrency)

    def test_request_body_limits_cannot_exceed_the_edge_contract(self) -> None:
        for upload_limit, content_limit in (
            (1, 65_536),
            (8, 2_097_152),
        ):
            with self.subTest(
                upload_limit=upload_limit,
                content_limit=content_limit,
            ):
                configured = self.settings(
                    MAX_UPLOAD_MB=upload_limit,
                    MAX_CONTENT_BYTES=content_limit,
                )
                self.assertEqual(configured.MAX_UPLOAD_MB, upload_limit)
                self.assertEqual(configured.MAX_CONTENT_BYTES, content_limit)

        for field_name, invalid_value in (
            ("MAX_UPLOAD_MB", 0),
            ("MAX_UPLOAD_MB", 9),
            ("MAX_CONTENT_BYTES", 65_535),
            ("MAX_CONTENT_BYTES", 2_097_153),
        ):
            with self.subTest(field_name=field_name), self.assertRaises(ValidationError):
                self.settings(**{field_name: invalid_value})

    def test_media_inventory_limit_has_a_bounded_default_and_range(self) -> None:
        self.assertEqual(self.settings().MAX_MEDIA_FILES, 1_000)

        for media_limit in (1, 10_000):
            with self.subTest(media_limit=media_limit):
                configured = self.settings(MAX_MEDIA_FILES=media_limit)
                self.assertEqual(configured.MAX_MEDIA_FILES, media_limit)

        for invalid_media_limit in (0, 10_001):
            with self.subTest(
                invalid_media_limit=invalid_media_limit
            ), self.assertRaises(ValidationError):
                self.settings(MAX_MEDIA_FILES=invalid_media_limit)

    def test_content_revision_limit_can_only_be_reduced_from_the_storage_budget(self) -> None:
        self.assertEqual(self.settings().MAX_CONTENT_REVISIONS, 100)

        for revision_limit in (1, 100):
            with self.subTest(revision_limit=revision_limit):
                configured = self.settings(MAX_CONTENT_REVISIONS=revision_limit)
                self.assertEqual(configured.MAX_CONTENT_REVISIONS, revision_limit)

        for invalid_revision_limit in (0, 101):
            with self.subTest(
                invalid_revision_limit=invalid_revision_limit
            ), self.assertRaises(ValidationError):
                self.settings(MAX_CONTENT_REVISIONS=invalid_revision_limit)

    def test_administrator_write_gate_is_strictly_boolean(self) -> None:
        self.assertTrue(self.settings().ADMIN_WRITES_ENABLED)
        self.assertFalse(self.settings(ADMIN_WRITES_ENABLED="false").ADMIN_WRITES_ENABLED)
        with self.assertRaises(ValidationError):
            self.settings(ADMIN_WRITES_ENABLED="sometimes")

    def test_invalid_admin_request_boundary_configuration_fails_at_startup(self) -> None:
        admin_configuration = {
            "ADMIN_ENABLED": True,
            "BLOG_ADMIN_PASSWORD_HASH": VALID_ARGON2ID_HASH,
            "APP_SECRET_KEY": "s" * 32,
        }
        for field_name, invalid_value in (
            ("PUBLIC_ORIGIN", "https://beta-demo.top/admin"),
            ("CSRF_TRUSTED_ORIGINS", "https://trusted.example/path"),
            ("AUTH_TRUSTED_PROXY_CIDRS", "not-a-network"),
        ):
            with self.subTest(field_name=field_name), self.assertRaisesRegex(
                ValidationError,
                "request-boundary configuration",
            ):
                self.settings(**admin_configuration, **{field_name: invalid_value})


if __name__ == "__main__":
    unittest.main()
