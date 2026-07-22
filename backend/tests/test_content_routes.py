import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_support import configure_test_environment

configure_test_environment()

from fastapi import HTTPException, Response
from pydantic import ValidationError

with patch("fastapi.dependencies.utils.ensure_multipart_is_installed"):
    from app.api import content
from app.core.api_errors import (
    MEDIA_REFERENCE_MISSING,
    MEDIA_STILL_REFERENCED,
    REVISION_INCOMPATIBLE,
)
from app.core.origin import require_same_origin
from test_content_schema import valid_content


class EmptyContentDatabase:
    def get(self, model, identifier):
        return None


def valid_write_content() -> dict:
    payload = valid_content()
    payload["blogPosts"][0]["coverImage"] = None
    return payload


class ContentRouteConcurrencyTests(unittest.TestCase):
    def test_all_unsafe_admin_routes_have_origin_protection(self) -> None:
        protected_paths = set()
        for route in content.router.routes:
            methods = getattr(route, "methods", set())
            if not (methods & {"POST", "PUT", "PATCH", "DELETE"}):
                continue
            dependencies = {
                dependency.call for dependency in route.dependant.dependencies
            }
            self.assertIn(require_same_origin, dependencies, route.path)
            protected_paths.add(route.path)
        self.assertEqual(len(protected_paths), 6)

    def test_all_persistent_admin_write_routes_support_the_restore_write_gate(self) -> None:
        gated_paths = set()
        for route in content.router.routes:
            dependencies = {
                dependency.call for dependency in route.dependant.dependencies
            }
            if content.require_admin_writes_enabled in dependencies:
                gated_paths.add(route.path)

        self.assertEqual(
            gated_paths,
            {
                "/api/v1/admin/content",
                "/api/v1/admin/revisions/{revision_id}/restore",
                "/api/v1/admin/media/{filename}",
                "/api/v1/admin/uploads",
            },
        )

    def test_restore_write_gate_returns_retryable_503(self) -> None:
        with patch.object(content.settings, "ADMIN_WRITES_ENABLED", False), self.assertRaises(
            HTTPException
        ) as rejected:
            content.require_admin_writes_enabled()

        self.assertEqual(rejected.exception.status_code, 503)
        self.assertEqual(rejected.exception.headers, {"Retry-After": "5"})

    def test_empty_admin_content_has_stable_initial_etag(self) -> None:
        response = Response()
        result = content.read_admin_content(response, {}, EmptyContentDatabase())
        self.assertEqual(
            result.model_dump(),
            {"initialized": False, "content": None},
        )
        self.assertEqual(response.headers["etag"], '"0"')

    def test_admin_content_route_declares_explicit_response_model(self) -> None:
        route = next(
            route
            for route in content.router.routes
            if route.path == "/api/v1/admin/content" and route.methods == {"GET"}
        )
        self.assertEqual(route.response_model, content.AdminContentResponse)

    def test_initialized_admin_response_requires_a_complete_payload(self) -> None:
        with self.assertRaises(ValidationError):
            content.InitializedAdminContentResponse(
                initialized=True,
                content={"personalInfo": valid_content()["personalInfo"]},
            )

    def test_initialized_admin_read_rejects_a_partial_stored_payload(self) -> None:
        database = Mock()
        database.get.return_value = SimpleNamespace(
            payload={"personalInfo": valid_content()["personalInfo"]}
        )

        with self.assertRaises(ValidationError):
            content.read_admin_content(Response(), {}, database)

    def test_put_rejects_missing_if_match_before_writing(self) -> None:
        payload = content.ContentPayload.model_validate(valid_write_content())
        database = Mock()
        with patch.object(content, "_locked_site_content", return_value=None), self.assertRaises(
            HTTPException
        ) as rejected:
            content.update_admin_content(payload, Response(), None, {}, database)
        self.assertEqual(rejected.exception.status_code, 428)
        database.add.assert_not_called()
        database.commit.assert_not_called()

    def test_initial_put_accepts_etag_zero_and_returns_new_etag(self) -> None:
        payload = content.ContentPayload.model_validate(valid_write_content())
        response = Response()
        database = Mock()
        with patch.object(content, "_locked_site_content", return_value=None):
            result = content.update_admin_content(payload, response, '"0"', {}, database)
        self.assertEqual(result, {"saved": True})
        self.assertTrue(response.headers["etag"].startswith('"sha256-'))
        database.add.assert_called_once()
        database.commit.assert_called_once()

    def test_restore_also_requires_current_etag(self) -> None:
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=valid_content())
        current = SimpleNamespace(payload=valid_content())
        with patch.object(content, "_locked_site_content", return_value=current), self.assertRaises(
            HTTPException
        ) as rejected:
            content.restore_content_revision(1, Response(), None, {}, database)
        self.assertEqual(rejected.exception.status_code, 428)
        database.commit.assert_not_called()

    def test_serialized_content_size_limit_returns_413(self) -> None:
        payload = content.ContentPayload.model_validate(valid_write_content())
        with patch.object(content.settings, "MAX_CONTENT_BYTES", 100), self.assertRaises(
            HTTPException
        ) as rejected:
            content._serialize_content_payload(payload)
        self.assertEqual(rejected.exception.status_code, 413)

    def test_put_rejects_a_missing_managed_media_reference_before_writing(self) -> None:
        filename = "a" * 32 + ".png"
        raw_payload = valid_write_content()
        raw_payload["blogPosts"][0]["coverImage"] = f"/backend/uploads/{filename}"
        payload = content.ContentPayload.model_validate(raw_payload)
        database = Mock()

        with tempfile.TemporaryDirectory() as upload_directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            upload_directory,
        ), patch.object(
            content,
            "_locked_site_content",
            return_value=None,
        ), self.assertRaises(HTTPException) as rejected:
            content.update_admin_content(payload, Response(), '"0"', {}, database)

        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            {
                "code": MEDIA_REFERENCE_MISSING,
                "message": "Content references unavailable managed media",
                "details": {"filenames": [filename]},
            },
        )
        database.add.assert_not_called()
        database.commit.assert_not_called()

    def test_put_accepts_an_existing_regular_managed_media_file(self) -> None:
        filename = "b" * 32 + ".png"
        raw_payload = valid_write_content()
        raw_payload["blogPosts"][0]["coverImage"] = f"/backend/uploads/{filename}"
        payload = content.ContentPayload.model_validate(raw_payload)
        response = Response()
        database = Mock()

        with tempfile.TemporaryDirectory() as upload_directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            upload_directory,
        ), patch.object(
            content,
            "_locked_site_content",
            return_value=None,
        ):
            Path(upload_directory, filename).write_bytes(b"managed image")
            result = content.update_admin_content(
                payload,
                response,
                '"0"',
                {},
                database,
            )

        self.assertEqual(result, {"saved": True})
        database.add.assert_called_once()
        database.commit.assert_called_once()

    def test_put_accepts_an_external_url_with_a_managed_looking_path(self) -> None:
        filename = "b" * 32 + ".png"
        raw_payload = valid_write_content()
        raw_payload["blogPosts"][0]["coverImage"] = (
            f"https://cdn.example.com/uploads/{filename}"
        )
        payload = content.ContentPayload.model_validate(raw_payload)
        response = Response()
        database = Mock()

        with tempfile.TemporaryDirectory() as upload_directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            upload_directory,
        ), patch.object(
            content,
            "_locked_site_content",
            return_value=None,
        ):
            result = content.update_admin_content(
                payload,
                response,
                '"0"',
                {},
                database,
            )

        self.assertEqual(result, {"saved": True})
        database.add.assert_called_once()
        database.commit.assert_called_once()

    def test_restore_rejects_a_revision_with_a_missing_managed_media_reference(self) -> None:
        filename = "c" * 32 + ".webp"
        revision_payload = valid_write_content()
        revision_payload["blogPosts"][0]["coverImage"] = (
            f"/backend/uploads/{filename}"
        )
        current = SimpleNamespace(payload=valid_write_content())
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=revision_payload)

        with tempfile.TemporaryDirectory() as upload_directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            upload_directory,
        ), patch.object(
            content,
            "_locked_site_content",
            return_value=current,
        ), self.assertRaises(HTTPException) as rejected:
            content.restore_content_revision(
                1,
                Response(),
                content._content_etag(current),
                {},
                database,
            )

        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            {
                "code": MEDIA_REFERENCE_MISSING,
                "message": "Content references unavailable managed media",
                "details": {"filenames": [filename]},
            },
        )
        database.commit.assert_not_called()

    def test_restore_rejects_an_incompatible_revision_without_leaking_validation(self) -> None:
        incompatible_payload = valid_write_content()
        private_marker = "private-invalid-revision-value"
        incompatible_payload["personalInfo"]["name"] = [private_marker]
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=incompatible_payload)

        with self.assertRaises(HTTPException) as rejected:
            content.restore_content_revision(1, Response(), '"current"', {}, database)

        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            {
                "code": REVISION_INCOMPATIBLE,
                "message": "This revision does not match the current content schema",
            },
        )
        self.assertNotIn(private_marker, str(rejected.exception.detail))
        database.commit.assert_not_called()

    def test_revision_read_migrates_and_serializes_without_mutating_snapshot(self) -> None:
        legacy_payload = valid_write_content()
        del legacy_payload["blogPosts"][0]["status"]
        original = copy.deepcopy(legacy_payload)
        database = Mock()
        database.get.return_value = SimpleNamespace(
            id=1,
            reason="content_update",
            created_at="2026-07-17T00:00:00Z",
            payload=legacy_payload,
        )

        result = content.read_content_revision(1, {}, database)

        self.assertEqual(result["payload"]["blogPosts"][0]["status"], "published")
        self.assertNotIn("coverImage", result["payload"]["blogPosts"][0])
        self.assertEqual(legacy_payload, original)

    def test_revision_read_rejects_incompatible_payload_without_leaking_validation(self) -> None:
        private_marker = "private-invalid-revision-read-value"
        incompatible_payload = [private_marker]
        database = Mock()
        database.get.return_value = SimpleNamespace(
            id=1,
            reason="content_update",
            created_at="2026-07-17T00:00:00Z",
            payload=incompatible_payload,
        )

        with self.assertRaises(HTTPException) as rejected:
            content.read_content_revision(1, {}, database)

        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            {
                "code": REVISION_INCOMPATIBLE,
                "message": "This revision does not match the current content schema",
            },
        )
        self.assertNotIn(private_marker, str(rejected.exception.detail))

    def test_delete_rejects_referenced_media_with_a_stable_error_code(self) -> None:
        filename = "d" * 32 + ".png"
        payload = valid_write_content()
        payload["blogPosts"][0]["coverImage"] = f"/backend/uploads/{filename}"
        current = SimpleNamespace(payload=payload)
        database = Mock()
        database.execute.return_value.scalars.return_value.all.return_value = []

        with tempfile.TemporaryDirectory() as upload_directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            upload_directory,
        ), patch.object(
            content,
            "_locked_site_content",
            return_value=current,
        ), patch.object(
            content,
            "_iter_bounded_revision_payloads",
            return_value=(item for item in ()),
        ), self.assertRaises(HTTPException) as rejected:
            Path(upload_directory, filename).write_bytes(b"managed image")
            content.delete_uploaded_media(filename, {}, database)

        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            {
                "code": MEDIA_STILL_REFERENCED,
                "message": "Media file is still referenced by site content",
                "details": {"references": ["$.blogPosts[0].coverImage"]},
            },
        )

    def test_legacy_post_status_is_migrated_without_mutating_stored_payload(self) -> None:
        legacy_payload = valid_content()
        del legacy_payload["blogPosts"][0]["status"]
        original = copy.deepcopy(legacy_payload)

        migrated = content._migrate_legacy_content_payload(legacy_payload)

        self.assertEqual(migrated["blogPosts"][0]["status"], "published")
        self.assertEqual(legacy_payload, original)
        self.assertNotIn("status", legacy_payload["blogPosts"][0])

    def test_public_filter_requires_explicit_published_status(self) -> None:
        now = content.datetime.now(content.timezone.utc)
        self.assertFalse(content._is_public_post({"id": "legacy"}, now))
        self.assertTrue(
            content._is_public_post({"id": "published", "status": "published"}, now)
        )

    def test_admin_read_explicitly_migrates_legacy_status(self) -> None:
        legacy_payload = valid_content()
        del legacy_payload["blogPosts"][0]["status"]
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=legacy_payload)

        result = content.read_admin_content(Response(), {}, database)

        self.assertTrue(result.initialized)
        self.assertIsNotNone(result.content)
        self.assertEqual(result.content.blogPosts[0].status, "published")
        self.assertNotIn("status", legacy_payload["blogPosts"][0])

    def test_public_read_filters_missing_status_even_for_legacy_shaped_rows(self) -> None:
        legacy_payload = valid_content()
        del legacy_payload["blogPosts"][0]["status"]
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=legacy_payload)

        response = Response()
        result = content.read_public_content(response, None, database)

        self.assertEqual(result["blogPosts"], [])
        self.assertTrue(response.headers["etag"].startswith('"sha256-'))
        self.assertEqual(
            response.headers["cache-control"],
            "public, max-age=0, must-revalidate",
        )
        self.assertNotIn("status", legacy_payload["blogPosts"][0])

    def test_public_read_supports_weak_and_strong_conditional_etags(self) -> None:
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=valid_content())
        response = Response()

        result = content.read_public_content(response, None, database)
        etag = response.headers["etag"]

        self.assertIsInstance(result, dict)
        self.assertTrue(etag.startswith('"sha256-'))
        for condition in (etag, f"W/{etag}", f'"unrelated", {etag}', "*"):
            not_modified = content.read_public_content(Response(), condition, database)
            self.assertIsInstance(not_modified, Response)
            self.assertEqual(not_modified.status_code, 304)
            self.assertEqual(not_modified.headers["etag"], etag)
            self.assertEqual(
                not_modified.headers["cache-control"],
                "public, max-age=0, must-revalidate",
            )

    def test_public_etag_hashes_filtered_visibility_not_the_admin_document(self) -> None:
        payload = valid_content()
        payload["blogPosts"][0]["status"] = "published"
        payload["blogPosts"][0]["scheduledAt"] = "2000-01-01T00:00:00Z"
        payload["blogPosts"].append(
            {
                **copy.deepcopy(payload["blogPosts"][0]),
                "id": "scheduled-later",
                "slug": "scheduled-later",
                "scheduledAt": "2999-01-01T00:00:00Z",
            }
        )
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=payload)
        hidden_response = Response()

        hidden_payload = content.read_public_content(hidden_response, None, database)
        self.assertEqual(len(hidden_payload["blogPosts"]), 1)

        payload["blogPosts"][1]["scheduledAt"] = "2000-01-01T00:00:00Z"
        visible_response = Response()
        visible_payload = content.read_public_content(visible_response, None, database)

        self.assertEqual(len(visible_payload["blogPosts"]), 2)
        self.assertNotEqual(hidden_response.headers["etag"], visible_response.headers["etag"])


if __name__ == "__main__":
    unittest.main()
