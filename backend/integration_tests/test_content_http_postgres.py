import base64
import copy
import json
import os
import re
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional
from unittest.mock import patch


os.environ["PORTFOLIO_DISABLE_DOTENV"] = "true"

RUN_DB_INTEGRATION = (
    os.environ.get("PORTFOLIO_RUN_DB_INTEGRATION", "").strip().lower() == "true"
)
DATABASE_NAME_PATTERN = re.compile(
    r"(?:^|[_-])(?:ci|test)(?:[_-]|$)",
    re.IGNORECASE,
)
SAME_ORIGIN_HEADERS = {"Origin": "http://localhost"}
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)


def content_payload(version: str) -> dict:
    return {
        "personalInfo": {
            "name": "CI Portfolio",
            "title": "Integration Test",
            "bio": version,
            "location": "",
            "email": "",
            "github": "",
            "twitter": "",
            "experience": [],
        },
        "techStackGroups": [],
        "projects": [],
        "blogPosts": [
            {
                "id": "ci-draft",
                "title": "CI Draft",
                "slug": "ci-draft",
                "excerpt": "Draft must remain private",
                "content": "# Draft",
                "date": "2026-07-17",
                "readTime": "1 min",
                "category": "Testing",
                "tags": ["integration"],
                "views": 0,
                "likes": 0,
                "status": "draft",
            },
            {
                "id": "ci-published",
                "title": "CI Published",
                "slug": "ci-published",
                "excerpt": "Published content",
                "content": "# Published",
                "date": "2026-07-17",
                "readTime": "1 min",
                "category": "Testing",
                "tags": ["integration"],
                "views": 0,
                "likes": 0,
                "status": "published",
            },
        ],
        "siteSettings": {
            "siteTitle": "CI Portfolio",
            "siteDescription": "Integration test content",
            "brandInitials": "CI",
            "navigation": [],
            "footerCopyright": "",
            "footerBadges": [],
            "icpNumber": "",
            "icpUrl": "",
        },
        "homePage": {
            "greetings": [],
            "heroPrefix": "",
            "heroHighlight": "",
            "heroSuffix": "",
            "introduction": "",
            "highlights": [],
            "portfolioButton": "",
            "agentButton": "",
            "blogButton": "",
        },
        "showcasePage": {
            "identityLabel": "",
            "terminalWelcome": "",
            "terminalHint": "",
            "terminalTitle": "",
            "terminalPlaceholder": "",
            "technologyTitle": "",
            "worksEyebrow": "",
            "worksTitle": "",
            "terminalPrompt": "",
            "quickLabel": "",
            "allFilterLabel": "",
            "terminalHelp": [],
            "commandNotFound": "",
            "detailsLabel": "",
            "repositoryLabel": "",
            "livePreviewLabel": "",
            "impactLabel": "",
            "starsLabel": "",
            "forksLabel": "",
        },
        "blogPage": {
            "eyebrow": "",
            "title": "",
            "description": "",
            "searchPlaceholder": "",
            "noResultsText": "",
            "backLabel": "",
            "relatedTitle": "",
            "allCategoryLabel": "",
            "readsLabel": "",
            "likeLabel": "",
            "linkCopiedLabel": "",
        },
        "aboutPage": {
            "eyebrow": "",
            "title": "",
            "description": "",
            "introductionTitle": "",
            "introduction": [],
            "experienceTitle": "",
            "hobbiesTitle": "",
            "hobbies": [],
            "technologyTitle": "",
            "contactEyebrow": "",
            "contactTitle": "",
            "contactDescription": "",
            "contactNamePlaceholder": "",
            "contactMessagePlaceholder": "",
            "contactSendingLabel": "",
            "contactSuccessLabel": "",
            "contactSubmitLabel": "",
        },
        "agentPage": {
            "title": "",
            "description": "",
            "welcomeMessage": "",
            "initialBubble": "",
            "loadingBubble": "",
            "answeredBubble": "",
            "resetBubble": "",
            "inputPlaceholder": "",
            "displayName": "",
            "badgeLabel": "",
            "modelLabel": "",
            "idleStatus": "",
            "loadingStatus": "",
            "interactionHint": "",
            "suggestionsTitle": "",
            "resetLabel": "",
            "samplePrompts": [],
            "funQuotes": [],
        },
        "musicPlayer": {
            "title": "",
            "minimizedLabel": "",
            "standbyLabel": "",
            "playingPrefix": "",
            "tracks": [],
        },
    }


class BackendPrefixProxy:
    """Model Nginx's /backend prefix removal while retaining the browser URL."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        prefix = "/backend"
        path = scope.get("path", "")
        if path != prefix and not path.startswith(f"{prefix}/"):
            await self._not_found(scope, send)
            return

        proxied_scope = dict(scope)
        proxied_scope["path"] = path[len(prefix):] or "/"
        raw_path = scope.get("raw_path")
        if isinstance(raw_path, bytes) and raw_path.startswith(prefix.encode("ascii")):
            proxied_scope["raw_path"] = raw_path[len(prefix):] or b"/"
        await self.app(proxied_scope, receive, send)

    @staticmethod
    async def _not_found(scope, send):
        await send(
            {
                "type": "http.response.start",
                "status": 404,
                "headers": [(b"content-type", b"text/plain")],
            }
        )
        if scope["type"] == "http":
            await send({"type": "http.response.body", "body": b"Not Found"})


@unittest.skipUnless(
    RUN_DB_INTEGRATION,
    "set PORTFOLIO_RUN_DB_INTEGRATION=true to run PostgreSQL integration tests",
)
class ContentHttpPostgresIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database_name = os.environ.get("POSTGRES_DB", "")
        if not DATABASE_NAME_PATTERN.search(database_name):
            raise RuntimeError(
                "Database integration tests require a dedicated database name "
                "containing a standalone 'ci' or 'test' segment"
            )

        admin_password = os.environ.get("PORTFOLIO_TEST_ADMIN_PASSWORD")
        if not admin_password:
            raise RuntimeError(
                "Database integration tests require PORTFOLIO_TEST_ADMIN_PASSWORD "
                "in the process environment"
            )
        cls.admin_password = admin_password

        cls.upload_directory = tempfile.TemporaryDirectory(
            prefix="portfolio-db-integration-uploads-"
        )
        cls.addClassCleanup(cls.upload_directory.cleanup)
        previous_upload_dir = os.environ.get("UPLOAD_DIR")
        os.environ["UPLOAD_DIR"] = cls.upload_directory.name
        cls.addClassCleanup(
            cls._restore_environment,
            "UPLOAD_DIR",
            previous_upload_dir,
        )

        previous_cookie_secure = os.environ.get("AUTH_COOKIE_SECURE")
        os.environ["AUTH_COOKIE_SECURE"] = "false"
        cls.addClassCleanup(
            cls._restore_environment,
            "AUTH_COOKIE_SECURE",
            previous_cookie_secure,
        )

        from fastapi.testclient import TestClient
        from sqlalchemy import text

        from app.core.config import settings

        previous_configured_upload_dir = settings.UPLOAD_DIR
        previous_configured_cookie_secure = settings.AUTH_COOKIE_SECURE
        settings.UPLOAD_DIR = cls.upload_directory.name
        settings.AUTH_COOKIE_SECURE = False
        cls.addClassCleanup(
            setattr,
            settings,
            "UPLOAD_DIR",
            previous_configured_upload_dir,
        )
        cls.addClassCleanup(
            setattr,
            settings,
            "AUTH_COOKIE_SECURE",
            previous_configured_cookie_secure,
        )

        from app.db.session import engine
        from app.main import app

        cls.engine = engine
        cls.sql_text = text
        cls._clear_content_tables()
        cls.addClassCleanup(cls.engine.dispose)
        cls.addClassCleanup(cls._clear_content_tables)

        proxy = BackendPrefixProxy(app)
        cls.client_a = TestClient(proxy, base_url="http://localhost")
        cls.client_b = TestClient(proxy, base_url="http://localhost")
        cls.client_a.__enter__()
        cls.addClassCleanup(cls.client_a.__exit__, None, None, None)
        cls.client_b.__enter__()
        cls.addClassCleanup(cls.client_b.__exit__, None, None, None)

    @staticmethod
    def _restore_environment(name: str, previous_value: Optional[str]) -> None:
        if previous_value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous_value

    @classmethod
    def _clear_content_tables(cls) -> None:
        expected_name = os.environ["POSTGRES_DB"]
        with cls.engine.begin() as connection:
            actual_name = connection.scalar(cls.sql_text("SELECT current_database()"))
            if actual_name != expected_name:
                raise RuntimeError("Connected database does not match POSTGRES_DB")
            connection.execute(
                cls.sql_text(
                    "TRUNCATE TABLE content_revisions, site_content RESTART IDENTITY"
                )
            )

    def assert_status(self, response, expected: int) -> None:
        self.assertEqual(response.status_code, expected, response.text)

    def setUp(self) -> None:
        self._clear_content_tables()

    def login(self, client):
        response = client.post(
            "/backend/api/v1/admin/login",
            json={"password": self.admin_password},
            headers=SAME_ORIGIN_HEADERS,
        )
        self.assert_status(response, 200)
        return response

    def test_admin_content_lifecycle_over_http_and_postgresql(self) -> None:
        ready = self.client_a.get("/backend/health/ready")
        self.assert_status(ready, 200)
        self.assertEqual(ready.json(), {"status": "ready"})

        malformed = self.client_a.get(
            "/backend/api/v1/admin/status",
            headers={"Cookie": "portfolio_admin_session=not-base64.not-a-signature"},
        )
        self.assert_status(malformed, 401)
        self.assertEqual(malformed.headers["cache-control"], "private, no-store")

        login_a = self.login(self.client_a)
        set_cookie = login_a.headers["set-cookie"].lower()
        self.assertIn("path=/backend/api/v1/admin", set_cookie)
        self.assertIn("httponly", set_cookie)
        self.assertIn("samesite=strict", set_cookie)
        self.login(self.client_b)

        status_response = self.client_a.get("/backend/api/v1/admin/status")
        self.assert_status(status_response, 200)
        self.assertIn("portfolio_admin_session=", status_response.request.headers["cookie"])

        initial_read = self.client_a.get("/backend/api/v1/admin/content")
        self.assert_status(initial_read, 200)
        self.assertEqual(
            initial_read.json(),
            {"initialized": False, "content": None},
        )
        self.assertEqual(initial_read.headers["etag"], '"0"')

        baseline = content_payload("baseline")
        initial_write = self.client_a.put(
            "/backend/api/v1/admin/content",
            json=baseline,
            headers={**SAME_ORIGIN_HEADERS, "If-Match": '"0"'},
        )
        self.assert_status(initial_write, 200)
        baseline_etag = initial_write.headers["etag"]
        self.assertTrue(baseline_etag.startswith('"sha256-'))

        read_a = self.client_a.get("/backend/api/v1/admin/content")
        read_b = self.client_b.get("/backend/api/v1/admin/content")
        self.assert_status(read_a, 200)
        self.assert_status(read_b, 200)
        self.assertEqual(read_a.headers["etag"], baseline_etag)
        self.assertEqual(read_b.headers["etag"], baseline_etag)

        candidates = [copy.deepcopy(baseline), copy.deepcopy(baseline)]
        candidates[0]["personalInfo"]["bio"] = "concurrent-a"
        candidates[1]["personalInfo"]["bio"] = "concurrent-b"
        barrier = threading.Barrier(2)

        def concurrent_write(client, payload):
            barrier.wait(timeout=10)
            return client.put(
                "/backend/api/v1/admin/content",
                json=payload,
                headers={**SAME_ORIGIN_HEADERS, "If-Match": baseline_etag},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(concurrent_write, self.client_a, candidates[0]),
                executor.submit(concurrent_write, self.client_b, candidates[1]),
            ]
            concurrent_responses = [future.result(timeout=20) for future in futures]

        status_codes = sorted(response.status_code for response in concurrent_responses)
        self.assertEqual(status_codes, [200, 409])
        rejected = next(
            response for response in concurrent_responses if response.status_code == 409
        )
        self.assertEqual(
            rejected.json()["detail"],
            {
                "code": "CONTENT_VERSION_CONFLICT",
                "message": "Content changed in another session. Reload before publishing.",
            },
        )
        winner_index = next(
            index
            for index, response in enumerate(concurrent_responses)
            if response.status_code == 200
        )

        current_read = self.client_a.get("/backend/api/v1/admin/content")
        self.assert_status(current_read, 200)
        self.assertEqual(
            current_read.json(),
            {"initialized": True, "content": candidates[winner_index]},
        )
        current_etag = current_read.headers["etag"]
        self.assertNotEqual(current_etag, baseline_etag)

        stale_write = self.client_b.put(
            "/backend/api/v1/admin/content",
            json=baseline,
            headers={**SAME_ORIGIN_HEADERS, "If-Match": baseline_etag},
        )
        self.assert_status(stale_write, 409)
        self.assertEqual(
            stale_write.json()["detail"]["code"],
            "CONTENT_VERSION_CONFLICT",
        )

        public_read = self.client_a.get("/backend/api/v1/content")
        self.assert_status(public_read, 200)
        self.assertNotIn("cookie", public_read.request.headers)
        self.assertEqual(
            [post["id"] for post in public_read.json()["blogPosts"]],
            ["ci-published"],
        )
        public_etag = public_read.headers["etag"]
        self.assertTrue(public_etag.startswith('"sha256-'))
        self.assertEqual(
            public_read.headers["cache-control"],
            "public, max-age=0, must-revalidate",
        )
        public_not_modified = self.client_b.get(
            "/backend/api/v1/content",
            headers={"If-None-Match": public_etag},
        )
        self.assert_status(public_not_modified, 304)
        self.assertEqual(public_not_modified.content, b"")
        self.assertEqual(public_not_modified.headers["etag"], public_etag)

        revisions = self.client_a.get("/backend/api/v1/admin/revisions")
        self.assert_status(revisions, 200)
        revision_items = revisions.json()["items"]
        self.assertEqual(len(revision_items), 1)
        self.assertEqual(revision_items[0]["reason"], "content_update")
        revision_id = revision_items[0]["id"]

        revision = self.client_a.get(
            f"/backend/api/v1/admin/revisions/{revision_id}"
        )
        self.assert_status(revision, 200)
        self.assertEqual(revision.json()["payload"], baseline)

        restored = self.client_a.post(
            f"/backend/api/v1/admin/revisions/{revision_id}/restore",
            headers={**SAME_ORIGIN_HEADERS, "If-Match": current_etag},
        )
        self.assert_status(restored, 200)
        self.assertEqual(restored.json()["restoredRevisionId"], revision_id)
        self.assertEqual(restored.json()["content"], baseline)
        restored_etag = restored.headers["etag"]

        restored_read = self.client_a.get("/backend/api/v1/admin/content")
        self.assert_status(restored_read, 200)
        self.assertEqual(
            restored_read.json(),
            {"initialized": True, "content": baseline},
        )
        self.assertEqual(restored_read.headers["etag"], restored_etag)

        uploaded = self.client_a.post(
            "/backend/api/v1/admin/uploads",
            headers=SAME_ORIGIN_HEADERS,
            files={"image": ("pixel.png", PNG_1X1, "image/png")},
        )
        self.assert_status(uploaded, 200)
        upload_metadata = uploaded.json()
        filename = upload_metadata["filename"]
        self.assertRegex(filename, r"^[0-9a-f]{32}\.png$")
        self.assertEqual(upload_metadata["contentType"], "image/png")

        downloaded = self.client_a.get(upload_metadata["url"])
        self.assert_status(downloaded, 200)
        self.assertEqual(downloaded.content, PNG_1X1)

        media = self.client_a.get("/backend/api/v1/admin/media")
        self.assert_status(media, 200)
        uploaded_item = next(
            item for item in media.json()["items"] if item["filename"] == filename
        )
        self.assertFalse(uploaded_item["referenced"])

        referenced_payload = copy.deepcopy(baseline)
        referenced_payload["blogPosts"][1]["coverImage"] = upload_metadata["url"]
        referenced_write = self.client_a.put(
            "/backend/api/v1/admin/content",
            json=referenced_payload,
            headers={**SAME_ORIGIN_HEADERS, "If-Match": restored_etag},
        )
        self.assert_status(referenced_write, 200)

        delete_after_save = self.client_a.delete(
            f"/backend/api/v1/admin/media/{filename}",
            headers=SAME_ORIGIN_HEADERS,
        )
        self.assert_status(delete_after_save, 409)
        self.assertEqual(
            delete_after_save.json()["detail"],
            {
                "code": "MEDIA_STILL_REFERENCED",
                "message": "Media file is still referenced by site content",
                "details": {
                    "references": ["$.blogPosts[1].coverImage"],
                },
            },
        )
        self.assert_status(self.client_a.get(upload_metadata["url"]), 200)

        second_upload = self.client_a.post(
            "/backend/api/v1/admin/uploads",
            headers=SAME_ORIGIN_HEADERS,
            files={"image": ("second.png", PNG_1X1, "image/png")},
        )
        self.assert_status(second_upload, 200)
        second_metadata = second_upload.json()

        delete_before_save = self.client_a.delete(
            f"/backend/api/v1/admin/media/{second_metadata['filename']}",
            headers=SAME_ORIGIN_HEADERS,
        )
        self.assert_status(delete_before_save, 200)
        self.assert_status(self.client_a.get(second_metadata["url"]), 404)

        missing_media_payload = copy.deepcopy(referenced_payload)
        missing_media_payload["blogPosts"][1]["coverImage"] = second_metadata["url"]
        save_after_delete = self.client_a.put(
            "/backend/api/v1/admin/content",
            json=missing_media_payload,
            headers={
                **SAME_ORIGIN_HEADERS,
                "If-Match": referenced_write.headers["etag"],
            },
        )
        self.assert_status(save_after_delete, 409)
        self.assertEqual(
            save_after_delete.json()["detail"],
            {
                "code": "MEDIA_REFERENCE_MISSING",
                "message": "Content references unavailable managed media",
                "details": {"filenames": [second_metadata["filename"]]},
            },
        )

        final_read = self.client_a.get("/backend/api/v1/admin/content")
        self.assert_status(final_read, 200)
        self.assertEqual(final_read.json()["content"], referenced_payload)

    def test_restore_preflight_rejects_oversized_json_before_python_decode(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.core.config import settings
        from app.db import restore_preflight

        private_marker = "private-oversized-restore-value"
        stored_payload = json.dumps({"marker": private_marker * 20})
        with self.engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO site_content (id, payload)
                    VALUES (1, CAST(:payload AS JSON))
                    """
                ),
                {"payload": stored_payload},
            )

        with tempfile.TemporaryDirectory() as uploads_directory, patch.object(
            settings,
            "MAX_CONTENT_BYTES",
            64,
        ), patch.object(
            restore_preflight.json,
            "loads",
            side_effect=AssertionError("oversized JSON reached Python decoding"),
        ), Session(self.engine) as database, self.assertRaisesRegex(
            restore_preflight.RestoredContentInvalidError,
            "restore storage size limit",
        ) as rejected:
            restore_preflight.validate_restored_content(
                database,
                Path(uploads_directory),
            )

        self.assertNotIn(private_marker, str(rejected.exception))

    def test_restore_preflight_streams_valid_postgresql_json(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.db import restore_preflight

        payload = json.dumps(content_payload("valid restore stream"))
        with self.engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO site_content (id, payload)
                    VALUES (1, CAST(:payload AS JSON))
                    """
                ),
                {"payload": payload},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO content_revisions (payload, reason)
                    VALUES (CAST(:payload AS JSON), 'integration_restore')
                    """
                ),
                {"payload": payload},
            )

        with tempfile.TemporaryDirectory() as uploads_directory, Session(
            self.engine
        ) as database:
            restore_preflight.validate_restored_content(
                database,
                Path(uploads_directory),
            )


if __name__ == "__main__":
    unittest.main()
