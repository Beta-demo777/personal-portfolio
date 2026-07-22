from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from test_support import configure_test_environment

configure_test_environment()

from app import main


class ApplicationLifecycleTests(unittest.TestCase):
    def test_upload_directory_is_created_at_startup_and_served(self) -> None:
        with tempfile.TemporaryDirectory(prefix="portfolio-app-lifecycle-") as parent:
            upload_directory = Path(parent) / "uploads"
            with patch.object(
                main.settings,
                "UPLOAD_DIR",
                str(upload_directory),
            ), patch.object(main, "StaticFiles", wraps=main.StaticFiles) as static_files:
                application = main.create_app()
                self.assertFalse(upload_directory.exists())
                static_files.assert_not_called()

                with TestClient(application, base_url="http://localhost") as client:
                    self.assertTrue(upload_directory.is_dir())
                    static_files.assert_called_once_with(directory=upload_directory)
                    uploaded_file = upload_directory / "example.txt"
                    uploaded_file.write_text("runtime upload", encoding="utf-8")

                    response = client.get("/uploads/example.txt")

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, "runtime upload")


class HealthRouteTests(unittest.TestCase):
    def test_request_id_is_preserved_or_safely_replaced_and_logged(self) -> None:
        with tempfile.TemporaryDirectory(prefix="portfolio-request-context-") as directory:
            with patch.object(main.settings, "UPLOAD_DIR", directory):
                application = main.create_app()
            with patch.object(main.request_logger, "info") as info_log, TestClient(
                application,
                base_url="http://localhost",
            ) as client:
                supplied = "edge-request-12345678"
                accepted = client.get(
                    "/health/live", headers={"X-Request-ID": supplied}
                )
                replaced = client.get(
                    "/health/live", headers={"X-Request-ID": "bad value"}
                )

        self.assertEqual(accepted.headers["X-Request-ID"], supplied)
        replacement = replaced.headers["X-Request-ID"]
        self.assertRegex(replacement, r"^[0-9a-f]{32}$")
        events = [json.loads(call.args[1]) for call in info_log.call_args_list]
        self.assertEqual([event["request_id"] for event in events], [supplied, replacement])
        self.assertTrue(all(event["event"] == "http_request" for event in events))
        self.assertTrue(all(event["route"] == "/health/live" for event in events))
        self.assertTrue(all(event["status"] == 200 for event in events))

    def test_unhandled_response_and_log_share_the_edge_request_id(self) -> None:
        marker = "private-error-message-must-not-be-logged"

        def fail() -> None:
            raise RuntimeError(marker)

        with tempfile.TemporaryDirectory(prefix="portfolio-request-error-") as directory:
            with patch.object(main.settings, "UPLOAD_DIR", directory):
                application = main.create_app()
            application.add_api_route("/test/unhandled", fail, methods=["GET"])
            with patch.object(main.request_logger, "info") as info_log, TestClient(
                application,
                base_url="http://localhost",
                raise_server_exceptions=False,
            ) as client:
                request_id = "edge-error-12345678"
                response = client.get(
                    "/test/unhandled", headers={"X-Request-ID": request_id}
                )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers["X-Request-ID"], request_id)
        self.assertEqual(response.json(), {"detail": "Internal server error"})
        events = [json.loads(call.args[1]) for call in info_log.call_args_list]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "unhandled_exception")
        self.assertEqual(events[0]["request_id"], request_id)
        self.assertEqual(events[0]["error_type"], "RuntimeError")
        self.assertNotIn(marker, info_log.call_args.args[1])

    def test_readiness_failure_is_503_and_never_cacheable(self) -> None:
        response = Response()
        with patch.object(
            main,
            "check_database_readiness",
            side_effect=SQLAlchemyError("private database detail"),
        ), self.assertRaises(HTTPException) as rejected:
            main.health_ready(response)

        self.assertEqual(rejected.exception.status_code, 503)
        self.assertEqual(rejected.exception.detail, "Database is not ready")
        self.assertEqual(rejected.exception.headers, {"Cache-Control": "no-store"})
        self.assertNotIn("private database detail", str(rejected.exception))


if __name__ == "__main__":
    unittest.main()
