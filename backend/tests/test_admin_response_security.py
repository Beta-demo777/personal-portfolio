import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from starlette.responses import Response

from test_support import configure_test_environment

configure_test_environment()

from app.core.response_security import apply_admin_response_headers, is_admin_api_path
from app import main
from app.main import sanitized_internal_server_error, sanitized_request_validation_error


class AdminResponseSecurityTests(unittest.TestCase):
    def test_only_admin_api_paths_are_selected(self) -> None:
        self.assertTrue(is_admin_api_path("/api/v1/admin"))
        self.assertTrue(is_admin_api_path("/api/v1/admin/content"))
        self.assertFalse(is_admin_api_path("/api/v1/content"))
        self.assertFalse(is_admin_api_path("/api/v1/administrator"))

    def test_sensitive_responses_are_private_and_never_cached(self) -> None:
        response = Response(headers={"Vary": "Accept-Encoding"})
        apply_admin_response_headers(response)

        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertEqual(response.headers["Vary"], "Accept-Encoding, Cookie")

    def test_cookie_is_not_duplicated_in_vary(self) -> None:
        response = Response(headers={"Vary": "cookie, Accept-Encoding"})
        apply_admin_response_headers(response)

        self.assertEqual(response.headers["Vary"], "cookie, Accept-Encoding")

    def test_validation_response_does_not_echo_sensitive_input(self) -> None:
        marker = "private-invalid-admin-input-must-not-leak"
        request = Request(
            {
                "type": "http",
                "method": "POST",
                "scheme": "https",
                "path": "/api/v1/admin/login",
                "raw_path": b"/api/v1/admin/login",
                "query_string": b"",
                "headers": [],
                "client": ("127.0.0.1", 1234),
                "server": ("localhost", 443),
            }
        )
        error = RequestValidationError(
            [
                {
                    "type": "string_too_long",
                    "loc": ("body", "password"),
                    "msg": "String should have at most 256 characters",
                    "input": marker,
                    "ctx": {"max_length": 256, "private": marker},
                }
            ]
        )

        response = asyncio.run(sanitized_request_validation_error(request, error))
        body = json.loads(response.body)

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertEqual(body["detail"][0]["loc"], ["body", "password"])
        self.assertNotIn("input", body["detail"][0])
        self.assertNotIn("ctx", body["detail"][0])
        self.assertNotIn(marker, response.body.decode("utf-8"))

    def test_validation_response_does_not_echo_an_unexpected_field_name(self) -> None:
        marker = "private-attacker-controlled-field-name" * 100
        request = Request(
            {
                "type": "http",
                "method": "POST",
                "scheme": "https",
                "path": "/api/v1/admin/login",
                "raw_path": b"/api/v1/admin/login",
                "query_string": b"",
                "headers": [],
                "client": ("127.0.0.1", 1234),
                "server": ("localhost", 443),
            }
        )
        error = RequestValidationError(
            [
                {
                    "type": "extra_forbidden",
                    "loc": ("body", marker),
                    "msg": "Extra inputs are not permitted",
                    "input": "private-value",
                }
            ]
        )

        response = asyncio.run(sanitized_request_validation_error(request, error))
        body = json.loads(response.body)

        self.assertEqual(
            body["detail"][0]["loc"],
            ["body", "<unexpected-field>"],
        )
        self.assertNotIn(marker, response.body.decode("utf-8"))

    def test_unhandled_admin_error_is_private_and_sanitized(self) -> None:
        marker = "private-exception-detail-must-not-leak"
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "scheme": "https",
                "path": "/api/v1/admin/probe",
                "raw_path": b"/api/v1/admin/probe",
                "query_string": b"",
                "headers": [],
                "client": ("127.0.0.1", 1234),
                "server": ("localhost", 443),
            }
        )

        with patch.object(main.request_logger, "info") as info_log:
            response = asyncio.run(
                sanitized_internal_server_error(request, RuntimeError(marker))
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertEqual(response.headers["Vary"], "Cookie")
        self.assertEqual(json.loads(response.body), {"detail": "Internal server error"})
        self.assertNotIn(marker, response.body.decode("utf-8"))
        logged = info_log.call_args.args[1]
        event = json.loads(logged)
        self.assertEqual(event["event"], "unhandled_exception")
        self.assertEqual(event["error_type"], "RuntimeError")
        self.assertEqual(response.headers["X-Request-ID"], event["request_id"])
        self.assertNotIn(marker, logged)


if __name__ == "__main__":
    unittest.main()
