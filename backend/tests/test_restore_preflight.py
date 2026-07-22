import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

from test_support import configure_test_environment

configure_test_environment()

from app.core.content_payload import referenced_managed_uploads
from app.db import restore_preflight
from test_content_schema import valid_content


class StaticRows:
    def __init__(self, rows) -> None:
        self.rows = list(rows)
        self.closed = False

    def all(self):
        return list(self.rows)

    def one(self):
        if len(self.rows) != 1:
            raise AssertionError("expected exactly one metadata row")
        return self.rows[0]

    def close(self) -> None:
        self.closed = True


class StreamingRows:
    def __init__(self, rows) -> None:
        self.rows = list(rows)
        self.closed = False

    def __iter__(self):
        return iter(self.rows)

    def all(self):
        raise AssertionError("payload rows must not be loaded with all()")

    def one(self):
        raise AssertionError("payload rows must be streamed")

    def close(self) -> None:
        self.closed = True


def image_bytes(
    image_format: str,
    *,
    size: tuple[int, int] = (1, 1),
    frames: int = 1,
) -> bytes:
    output = io.BytesIO()
    images = [Image.new("RGB", size, (index * 40, 0, 0)) for index in range(frames)]
    images[0].save(
        output,
        format=image_format,
        save_all=frames > 1,
        append_images=images[1:],
        duration=10,
        loop=0,
    )
    return output.getvalue()


class RestoreContentPreflightTests(unittest.TestCase):
    def test_empty_site_content_is_valid(self) -> None:
        restore_preflight.validate_site_content_rows([])

    def test_current_content_and_public_filter_are_validated(self) -> None:
        payload = valid_content()
        restore_preflight.validate_site_content_rows([(1, payload)])

    def test_legacy_status_migration_is_allowed_without_mutating_backup_row(self) -> None:
        payload = valid_content()
        del payload["blogPosts"][0]["status"]
        original = copy.deepcopy(payload)

        restore_preflight.validate_site_content_rows([(1, payload)])

        self.assertEqual(payload, original)
        self.assertNotIn("status", payload["blogPosts"][0])

    def test_multiple_rows_are_rejected_without_exposing_payloads(self) -> None:
        marker = "private-content-must-not-leak"
        with self.assertRaises(restore_preflight.RestoredContentInvalidError) as rejected:
            restore_preflight.validate_site_content_rows(
                [(1, {"marker": marker}), (2, {"marker": marker})]
            )

        self.assertEqual(
            str(rejected.exception),
            "site content singleton invariant failed",
        )
        self.assertNotIn(marker, str(rejected.exception))

    def test_non_singleton_id_is_rejected(self) -> None:
        with self.assertRaises(restore_preflight.RestoredContentInvalidError):
            restore_preflight.validate_site_content_rows([(2, valid_content())])

    def test_malformed_payload_is_rejected_without_pydantic_input_details(self) -> None:
        marker = "private-content-must-not-leak"
        malformed = valid_content()
        malformed["privateField"] = marker

        with self.assertRaises(restore_preflight.RestoredContentInvalidError) as rejected:
            restore_preflight.validate_site_content_rows([(1, malformed)])

        self.assertEqual(
            str(rejected.exception),
            "site content does not match the current application contract",
        )
        self.assertNotIn(marker, str(rejected.exception))

    def test_content_size_limit_matches_the_online_write_boundary(self) -> None:
        marker = "private-oversized-content-must-not-leak"
        oversized = valid_content()
        oversized["personalInfo"]["bio"] = marker * 20

        with patch.object(
            restore_preflight.settings,
            "MAX_CONTENT_BYTES",
            100,
        ), patch.object(
            restore_preflight,
            "migrate_legacy_content_payload",
        ) as migrate_payload, self.assertRaises(
            restore_preflight.RestoredContentInvalidError
        ) as rejected:
            restore_preflight.validate_site_content_rows([(1, oversized)])

        migrate_payload.assert_not_called()
        self.assertEqual(
            str(rejected.exception),
            "site content exceeds the configured content size limit",
        )
        self.assertNotIn(marker, str(rejected.exception))

    def test_public_filter_failure_is_sanitized_and_fails_closed(self) -> None:
        with patch.object(
            restore_preflight,
            "public_content_payload",
            side_effect=RuntimeError("private-filter-detail"),
        ), self.assertRaises(restore_preflight.RestoredContentInvalidError) as rejected:
            restore_preflight.validate_site_content_rows([(1, valid_content())])

        self.assertNotIn("private-filter-detail", str(rejected.exception))

    def test_revisions_are_bounded_and_each_payload_is_validated(self) -> None:
        payload = valid_content()
        restore_preflight.validate_revision_rows(
            [(1, payload), (2, payload)],
            max_revisions=2,
        )

        malformed = copy.deepcopy(payload)
        malformed["privateField"] = "revision-private-content"
        with self.assertRaises(restore_preflight.RestoredContentInvalidError) as rejected:
            restore_preflight.validate_revision_rows([(1, malformed)], max_revisions=2)
        self.assertNotIn("revision-private-content", str(rejected.exception))

        with self.assertRaisesRegex(
            restore_preflight.RestoredContentInvalidError,
            "revision count",
        ):
            restore_preflight.validate_revision_rows(
                [(1, payload), (2, payload), (3, payload)],
                max_revisions=2,
            )

    def test_staged_media_must_contain_every_content_reference(self) -> None:
        filename = f"{'a' * 32}.png"
        payload = valid_content()
        payload["blogPosts"][0]["content"] = f"![cover](/backend/uploads/{filename})"

        with tempfile.TemporaryDirectory() as temporary_directory:
            uploads_root = Path(temporary_directory)
            with self.assertRaisesRegex(
                restore_preflight.RestoredContentInvalidError,
                "missing a referenced",
            ):
                restore_preflight.validate_staged_uploads(uploads_root, [payload])

            for referenced_filename in referenced_managed_uploads(payload):
                (uploads_root / referenced_filename).write_bytes(image_bytes("PNG"))
            restore_preflight.validate_staged_uploads(uploads_root, [payload])

    def test_external_media_url_does_not_require_a_staged_local_file(self) -> None:
        filename = f"{'a' * 32}.png"
        payload = valid_content()
        payload["blogPosts"][0]["coverImage"] = (
            f"https://cdn.example.com/uploads/{filename}"
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            restore_preflight.validate_staged_uploads(
                Path(temporary_directory),
                [payload],
            )

    def test_staged_media_rejects_forged_corrupt_and_mismatched_images(self) -> None:
        invalid_media = (
            ("a" * 32 + ".png", b"not-an-image"),
            ("b" * 32 + ".png", image_bytes("PNG")[:-8]),
            ("c" * 32 + ".jpg", image_bytes("PNG")),
        )

        for filename, content in invalid_media:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as directory:
                (Path(directory) / filename).write_bytes(content)
                with self.assertRaisesRegex(
                    restore_preflight.RestoredContentInvalidError,
                    "staged uploaded media set is invalid",
                ):
                    restore_preflight.validate_staged_uploads(Path(directory), [])

    def test_staged_media_enforces_size_dimension_frame_and_decode_pixel_limits(self) -> None:
        cases = (
            (
                "size",
                "d" * 32 + ".png",
                image_bytes("PNG") + b"x" * (1024 * 1024),
                {"MAX_UPLOAD_MB": 1},
            ),
            (
                "dimensions",
                "e" * 32 + ".png",
                image_bytes("PNG", size=(2, 2)),
                {"MAX_IMAGE_PIXELS": 3},
            ),
            (
                "frames",
                "f" * 32 + ".gif",
                image_bytes("GIF", frames=3),
                {"MAX_IMAGE_FRAMES": 2},
            ),
            (
                "total-pixels",
                "1" * 32 + ".gif",
                image_bytes("GIF", frames=3),
                {"MAX_IMAGE_TOTAL_PIXELS": 2},
            ),
        )

        for label, filename, content, setting_overrides in cases:
            with self.subTest(limit=label), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / filename
                path.write_bytes(content)
                patches = [
                    patch.object(restore_preflight.settings, name, value)
                    for name, value in setting_overrides.items()
                ]
                for setting_patch in patches:
                    setting_patch.start()
                try:
                    with self.assertRaisesRegex(
                        restore_preflight.RestoredContentInvalidError,
                        "staged uploaded media set is invalid",
                    ):
                        restore_preflight.validate_staged_uploads(Path(directory), [])
                finally:
                    for setting_patch in reversed(patches):
                        setting_patch.stop()

    def test_database_queries_are_bounded(self) -> None:
        database = Mock()
        payload = valid_content()
        serialized_payload = json.dumps(payload)
        site_metadata = StaticRows([(1, len(serialized_payload.encode("utf-8")))])
        revision_metadata = StaticRows([(0, None)])
        site_payloads = StreamingRows([(1, serialized_payload)])
        revision_payloads = StreamingRows([])
        database.execute.side_effect = [
            site_metadata,
            revision_metadata,
            site_payloads,
            revision_payloads,
        ]

        with tempfile.TemporaryDirectory() as temporary_directory:
            uploads_root = Path(temporary_directory)
            for filename in referenced_managed_uploads(payload):
                (uploads_root / filename).write_bytes(image_bytes("PNG"))
            restore_preflight.validate_restored_content(
                database,
                uploads_root,
            )

        statements = [call.args[0] for call in database.execute.call_args_list]
        self.assertEqual(statements[0]._limit_clause.value, 2)
        self.assertIsNone(statements[1]._limit_clause)
        self.assertEqual(statements[2]._limit_clause.value, 2)
        self.assertEqual(
            statements[3]._limit_clause.value,
            restore_preflight.settings.MAX_CONTENT_REVISIONS + 1,
        )
        self.assertEqual(
            statements[2].get_execution_options()["yield_per"],
            restore_preflight.RESTORE_STREAM_BATCH_SIZE,
        )
        self.assertEqual(
            statements[3].get_execution_options()["yield_per"],
            restore_preflight.RESTORE_STREAM_BATCH_SIZE,
        )
        self.assertTrue(
            all(
                result.closed
                for result in (
                    site_metadata,
                    revision_metadata,
                    site_payloads,
                    revision_payloads,
                )
            )
        )

    def test_database_storage_limit_rejects_before_loading_payload_text(self) -> None:
        database = Mock()
        site_metadata = StaticRows(
            [(1, restore_preflight._stored_json_size_limit() + 1)]
        )
        database.execute.return_value = site_metadata

        with tempfile.TemporaryDirectory() as temporary_directory, patch.object(
            restore_preflight.json,
            "loads",
            side_effect=AssertionError("oversized JSON must not be decoded"),
        ), self.assertRaisesRegex(
            restore_preflight.RestoredContentInvalidError,
            "restore storage size limit",
        ):
            restore_preflight.validate_restored_content(
                database,
                Path(temporary_directory),
            )

        database.execute.assert_called_once()
        self.assertTrue(site_metadata.closed)

    def test_revision_count_limit_rejects_before_loading_payload_text(self) -> None:
        database = Mock()
        site_metadata = StaticRows([])
        revision_metadata = StaticRows(
            [(restore_preflight.settings.MAX_CONTENT_REVISIONS + 1, 1)]
        )
        database.execute.side_effect = [site_metadata, revision_metadata]

        with tempfile.TemporaryDirectory() as temporary_directory, patch.object(
            restore_preflight.json,
            "loads",
            side_effect=AssertionError("overflow revisions must not be decoded"),
        ), self.assertRaisesRegex(
            restore_preflight.RestoredContentInvalidError,
            "revision count",
        ):
            restore_preflight.validate_restored_content(
                database,
                Path(temporary_directory),
            )

        self.assertEqual(database.execute.call_count, 2)
        self.assertTrue(site_metadata.closed)
        self.assertTrue(revision_metadata.closed)

    def test_cli_hides_unexpected_database_error_details(self) -> None:
        marker = "private-driver-detail"
        session_context = Mock()
        session_context.__enter__ = Mock(return_value=Mock())
        session_context.__exit__ = Mock(return_value=False)
        stderr = io.StringIO()
        stdout = io.StringIO()

        with patch.object(restore_preflight, "SessionLocal", return_value=session_context), patch.object(
            restore_preflight,
            "validate_restored_content",
            side_effect=RuntimeError(marker),
        ), redirect_stderr(stderr), redirect_stdout(stdout):
            result = restore_preflight.main(["--uploads-root", "/not-inspected-by-mock"])

        self.assertEqual(result, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("staged content validation could not complete", stderr.getvalue())
        self.assertNotIn(marker, stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
