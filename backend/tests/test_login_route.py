import os
import secrets
import unittest
from typing import Optional
from unittest.mock import patch


from test_support import configure_test_environment

# Creating the SQLAlchemy engine does not connect to PostgreSQL. Fixed test
# values keep route imports self-contained and independent of the project dotenv.
configure_test_environment()

from fastapi import HTTPException, Request, Response

# Route registration checks multipart support because this module also owns the
# unrelated upload endpoint. The production dependency is pinned in requirements;
# bypassing that check keeps this focused test runnable in a minimal local venv.
with patch("fastapi.dependencies.utils.ensure_multipart_is_installed"):
    from app.api import content
from app.core.login_limiter import LoginAttemptLimiter


class AdminLoginRouteTests(unittest.TestCase):
    client_ip = "198.51.100.20"

    def setUp(self) -> None:
        self.original_limiter = content.LOGIN_ATTEMPTS
        content.LOGIN_ATTEMPTS = LoginAttemptLimiter(
            max_failures=2,
            window_seconds=60,
            lockout_seconds=30,
            max_clients=100,
        )
        self.addCleanup(setattr, content, "LOGIN_ATTEMPTS", self.original_limiter)

        self.password_patch = patch.object(
            content,
            "verify_password",
            side_effect=lambda supplied: secrets.compare_digest(
                supplied,
                "correct-password",
            ),
        )
        self.token_patch = patch.object(
            content,
            "create_session_token",
            return_value="test-session-token",
        )
        self.password_patch.start()
        self.token_patch.start()
        self.addCleanup(self.password_patch.stop)
        self.addCleanup(self.token_patch.stop)

    def request(self) -> Request:
        return Request(
            {
                "type": "http",
                "headers": [],
                "client": (self.client_ip, 54321),
            }
        )

    def login(self, password: str, response: Optional[Response] = None):
        return content.admin_login(
            content.LoginRequest(password=password),
            self.request(),
            response if response is not None else Response(),
        )

    def test_threshold_failure_returns_retry_after_without_log_flood(self) -> None:
        with patch.object(content.logger, "info") as info_log, patch.object(
            content.logger,
            "warning",
        ) as warning_log:
            with self.assertRaises(HTTPException) as first_error:
                self.login("wrong-password")
            with self.assertRaises(HTTPException) as threshold_error:
                self.login("wrong-password")
            with self.assertRaises(HTTPException) as locked_error:
                self.login("wrong-password")

        self.assertEqual(first_error.exception.status_code, 401)
        self.assertEqual(threshold_error.exception.status_code, 429)
        self.assertEqual(threshold_error.exception.headers, {"Retry-After": "30"})
        self.assertEqual(locked_error.exception.status_code, 429)
        info_log.assert_called_once_with(
            "admin_login_failed client_ip=%s",
            self.client_ip,
        )
        warning_log.assert_called_once_with(
            "admin_login_lockout client_ip=%s",
            self.client_ip,
        )
        self.assertNotIn("wrong-password", str(info_log.call_args_list))
        self.assertNotIn("wrong-password", str(warning_log.call_args_list))

    def test_success_clears_previous_failures(self) -> None:
        with self.assertRaises(HTTPException) as first_error:
            self.login("wrong-password")
        self.assertEqual(first_error.exception.status_code, 401)

        response = Response()
        with patch.object(content.settings, "AUTH_COOKIE_SECURE", True):
            self.assertEqual(
                self.login("correct-password", response),
                {"authenticated": True},
            )
        self.assertIn(
            "portfolio_admin_session=test-session-token",
            response.headers["set-cookie"],
        )
        self.assertIn("Path=/backend/api/v1/admin", response.headers["set-cookie"])
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("Secure", response.headers["set-cookie"])
        self.assertIn("SameSite=strict", response.headers["set-cookie"])

        with self.assertRaises(HTTPException) as next_error:
            self.login("wrong-password")
        self.assertEqual(next_error.exception.status_code, 401)

    def test_logout_deletes_the_cookie_at_the_same_scoped_path(self) -> None:
        response = Response()
        self.assertEqual(content.admin_logout(response), {"authenticated": False})
        set_cookie = response.headers["set-cookie"]
        self.assertIn("portfolio_admin_session=", set_cookie)
        self.assertIn("Path=/backend/api/v1/admin", set_cookie)
        self.assertIn("Max-Age=0", set_cookie)


if __name__ == "__main__":
    unittest.main()
