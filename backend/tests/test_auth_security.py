import unittest
from unittest.mock import patch

from test_support import configure_test_environment

configure_test_environment()

from fastapi import HTTPException

from app.core import auth

try:
    import argon2  # noqa: F401

    ARGON2_AVAILABLE = True
except ImportError:
    ARGON2_AVAILABLE = False


class AdminAuthenticationSecurityTests(unittest.TestCase):
    def test_valid_session_round_trip(self) -> None:
        with patch.multiple(
            auth.settings,
            ADMIN_ENABLED=True,
            APP_SECRET_KEY="s" * 32,
            AUTH_SESSION_HOURS=12,
        ), patch.object(auth.time, "time", return_value=1_000):
            token = auth.create_session_token()
            payload = auth.require_admin(token)

        self.assertEqual(payload, {"role": "admin", "exp": 44_200})

    def test_malformed_and_oversized_sessions_always_return_401(self) -> None:
        malformed_tokens = (
            "a.a",
            f"payload.{'a' * 43}",
            f"p\u00e4yload.{'a' * 43}",
            f"payload.{'!' * 43}",
            "x" * (auth.MAX_SESSION_TOKEN_CHARS + 1),
        )
        with patch.multiple(
            auth.settings,
            ADMIN_ENABLED=True,
            APP_SECRET_KEY="s" * 32,
        ):
            for token in malformed_tokens:
                with self.subTest(token=token[:20]), self.assertRaises(HTTPException) as rejected:
                    auth.require_admin(token)
                self.assertEqual(rejected.exception.status_code, 401)

    def test_expired_session_is_rejected_at_exact_expiry(self) -> None:
        with patch.multiple(
            auth.settings,
            ADMIN_ENABLED=True,
            APP_SECRET_KEY="s" * 32,
            AUTH_SESSION_HOURS=1,
        ), patch.object(auth.time, "time", return_value=10):
            token = auth.create_session_token()
        with patch.multiple(
            auth.settings,
            ADMIN_ENABLED=True,
            APP_SECRET_KEY="s" * 32,
        ), patch.object(auth.time, "time", return_value=3_610), self.assertRaises(
            HTTPException
        ) as rejected:
            auth.require_admin(token)
        self.assertEqual(rejected.exception.status_code, 401)

    def test_password_verification_always_uses_argon2id(self) -> None:
        with patch.multiple(
            auth.settings,
            ADMIN_ENABLED=True,
            BLOG_ADMIN_PASSWORD_HASH="encoded-argon2id-hash",  # secret-scan: allow-test-fixture
        ), patch.object(auth, "_verify_argon2id", return_value=True) as verify_argon2id:
            self.assertTrue(auth.verify_password("supplied-password"))
        verify_argon2id.assert_called_once_with(
            "encoded-argon2id-hash",
            "supplied-password",
        )

    @unittest.skipUnless(ARGON2_AVAILABLE, "argon2-cffi is not installed in the local venv")
    def test_argon2id_hash_generation_and_verification_round_trip(self) -> None:
        password = "strong-admin-password"
        encoded_hash = auth.hash_admin_password(password)
        self.assertTrue(encoded_hash.startswith("$argon2id$v=19$"))
        self.assertTrue(auth._verify_argon2id(encoded_hash, password))
        self.assertFalse(auth._verify_argon2id(encoded_hash, "wrong-password"))

    def test_hash_generation_rejects_weak_password_before_loading_argon2(self) -> None:
        with self.assertRaisesRegex(ValueError, "between 12 and 256"):
            auth.hash_admin_password("short")

    def test_missing_password_hash_returns_503_instead_of_falling_back(self) -> None:
        with patch.multiple(
            auth.settings,
            ADMIN_ENABLED=True,
            BLOG_ADMIN_PASSWORD_HASH=None,
        ), self.assertRaises(HTTPException) as rejected:
            auth.verify_password("strong-admin-password")
        self.assertEqual(rejected.exception.status_code, 503)

    def test_disabled_admin_returns_503_before_session_or_password_processing(self) -> None:
        with patch.object(auth.settings, "ADMIN_ENABLED", False):
            for action in (
                lambda: auth.verify_password("password"),
                lambda: auth.require_admin("a.a"),
                auth.create_session_token,
            ):
                with self.subTest(action=action), self.assertRaises(HTTPException) as rejected:
                    action()
                self.assertEqual(rejected.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
