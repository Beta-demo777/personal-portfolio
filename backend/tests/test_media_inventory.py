import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_support import configure_test_environment

configure_test_environment()

from fastapi import HTTPException

with patch("fastapi.dependencies.utils.ensure_multipart_is_installed"):
    from app.api import content


def managed_filename(character: str, extension: str = ".png") -> str:
    return character * 32 + extension


class TrackingScandir:
    def __init__(self) -> None:
        self.consumed = 0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        self.closed = True

    def __iter__(self):
        return self

    def __next__(self):
        self.consumed += 1
        return SimpleNamespace(name=f"unexpected-{self.consumed}")


class StreamingRows:
    def __init__(self, rows) -> None:
        self.rows = list(rows)
        self.closed = False

    def __iter__(self):
        return iter(self.rows)

    def all(self):
        raise AssertionError("payload rows must not be loaded with all()")

    def scalars(self):
        raise AssertionError("payload rows must be selected as columns")

    def close(self) -> None:
        self.closed = True


class MediaInventoryTests(unittest.TestCase):
    def test_revision_retention_reads_one_cutoff_and_bulk_deletes_stale_rows(
        self,
    ) -> None:
        database = Mock()
        database.scalar.return_value = 41

        with patch.object(content.settings, "MAX_CONTENT_REVISIONS", 3):
            revision = content._create_revision(database, {"version": 1}, "test")

        cutoff_query = database.scalar.call_args.args[0]
        delete_statement = database.execute.call_args.args[0]
        self.assertEqual(cutoff_query._offset_clause.value, 3)
        self.assertEqual(cutoff_query._limit_clause.value, 1)
        self.assertEqual(
            delete_statement.compile().params,
            {"id_1": 41},
        )
        self.assertEqual(
            delete_statement.get_execution_options()["synchronize_session"],
            False,
        )
        database.add.assert_called_once_with(revision)
        database.flush.assert_called_once_with()
        database.execute.assert_called_once()
        database.delete.assert_not_called()

    def test_revision_retention_does_not_delete_at_the_exact_limit(self) -> None:
        database = Mock()
        database.scalar.return_value = None

        with patch.object(content.settings, "MAX_CONTENT_REVISIONS", 3):
            content._create_revision(database, {"version": 1}, "test")

        cutoff_query = database.scalar.call_args.args[0]
        self.assertEqual(cutoff_query._offset_clause.value, 3)
        self.assertEqual(cutoff_query._limit_clause.value, 1)
        database.execute.assert_not_called()
        database.delete.assert_not_called()

    def test_directory_scan_stops_at_max_plus_one_and_fails_closed(self) -> None:
        entries = TrackingScandir()

        with patch.object(content.os, "scandir", return_value=entries), self.assertRaises(
            HTTPException
        ) as rejected:
            content._scan_upload_directory(Path("/unused"), max_files=2)

        self.assertEqual(entries.consumed, 3)
        self.assertTrue(entries.closed)
        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            content.MEDIA_INVENTORY_LIMIT_DETAIL,
        )

    def test_media_list_keeps_response_shape_and_reference_paths(self) -> None:
        current_filename = managed_filename("a")
        revision_filename = managed_filename("b", ".webp")
        current_payload = {
            "hero": f"/backend/uploads/{current_filename}",
            "body": (
                f"/uploads/{current_filename}?size=large "
                f"/uploads/{current_filename}#duplicate"
            ),
        }
        revisions = [
            (
                7,
                {
                    "cover": f"/uploads/{revision_filename}",
                    "previousHero": f"/backend/uploads/{current_filename}",
                },
            )
        ]
        database = Mock()
        database.get.return_value = SimpleNamespace(payload=current_payload)
        revision_result = StreamingRows(revisions)
        database.execute.return_value = revision_result

        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ), patch.object(
            content.settings,
            "MAX_MEDIA_FILES",
            2,
        ):
            Path(directory, current_filename).write_bytes(b"current")
            Path(directory, revision_filename).write_bytes(b"revision")
            result = content.list_uploaded_media({}, database)

        by_filename = {item["filename"]: item for item in result["items"]}
        self.assertEqual(result["total"], 2)
        self.assertEqual(
            set(result),
            {"items", "total"},
        )
        self.assertEqual(
            by_filename[current_filename]["references"],
            ["$.hero", "$.body", "revision[7].previousHero"],
        )
        self.assertEqual(
            by_filename[revision_filename]["references"],
            ["revision[7].cover"],
        )
        self.assertTrue(by_filename[current_filename]["referenced"])
        self.assertEqual(
            by_filename[current_filename]["url"],
            f"/backend/uploads/{current_filename}",
        )
        self.assertTrue(revision_result.closed)

    def test_external_url_does_not_reference_a_local_media_file(self) -> None:
        filename = managed_filename("a")
        database = Mock()
        database.get.return_value = SimpleNamespace(
            payload={"hero": f"https://cdn.example.com/uploads/{filename}"}
        )
        revision_result = StreamingRows([])
        database.execute.return_value = revision_result

        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ):
            Path(directory, filename).write_bytes(b"local media")
            result = content.list_uploaded_media({}, database)

        self.assertEqual(result["items"][0]["filename"], filename)
        self.assertFalse(result["items"][0]["referenced"])
        self.assertEqual(result["items"][0]["references"], [])
        self.assertTrue(revision_result.closed)

    def test_revision_loading_is_bounded_and_overflow_fails_closed(self) -> None:
        database = Mock()
        revision_result = StreamingRows([(3, {}), (2, {}), (1, {})])
        database.execute.return_value = revision_result

        with patch.object(content.settings, "MAX_CONTENT_REVISIONS", 2), self.assertRaises(
            HTTPException
        ) as rejected:
            list(content._iter_bounded_revision_payloads(database))

        statement = database.execute.call_args.args[0]
        self.assertEqual(statement._limit_clause.value, 3)
        self.assertEqual(
            statement.get_execution_options()["yield_per"],
            content.REVISION_STREAM_BATCH_SIZE,
        )
        self.assertTrue(revision_result.closed)
        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(
            rejected.exception.detail,
            content.REVISION_INVENTORY_LIMIT_DETAIL,
        )

    def test_list_and_delete_use_the_bounded_revision_loader(self) -> None:
        filename = managed_filename("c")
        database = Mock()
        database.get.return_value = None
        results = [StreamingRows([]), StreamingRows([])]
        database.execute.side_effect = results

        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ), patch.object(
            content.settings,
            "MAX_CONTENT_REVISIONS",
            4,
        ):
            Path(directory, filename).write_bytes(b"media")
            content.list_uploaded_media({}, database)
            with patch.object(content, "_locked_site_content", return_value=None):
                result = content.delete_uploaded_media(filename, {}, database)

        self.assertEqual(result, {"deleted": True, "filename": filename})
        self.assertEqual(database.execute.call_count, 2)
        for call in database.execute.call_args_list:
            self.assertEqual(call.args[0]._limit_clause.value, 5)
            self.assertEqual(
                call.args[0].get_execution_options()["yield_per"],
                content.REVISION_STREAM_BATCH_SIZE,
            )
        self.assertTrue(all(result.closed for result in results))

    def test_delete_keeps_file_when_revision_inventory_is_over_limit(self) -> None:
        filename = managed_filename("d")
        database = Mock()
        revision_result = StreamingRows([(2, {}), (1, {})])
        database.execute.return_value = revision_result

        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ), patch.object(
            content.settings,
            "MAX_CONTENT_REVISIONS",
            1,
        ), patch.object(
            content,
            "_locked_site_content",
            return_value=None,
        ):
            target = Path(directory, filename)
            target.write_bytes(b"media")
            with self.assertRaises(HTTPException) as rejected:
                content.delete_uploaded_media(filename, {}, database)
            self.assertTrue(target.exists())

        self.assertEqual(rejected.exception.status_code, 409)
        self.assertTrue(revision_result.closed)

    def test_revision_list_streams_payloads_and_preserves_summary_contract(self) -> None:
        payload = {
            "blogPosts": [{"status": "draft"}, {"status": "published"}],
            "projects": [{}, {}],
            "techStackGroups": [{}],
        }
        created_at = datetime(2026, 7, 17, tzinfo=timezone.utc)
        revision_result = StreamingRows(
            [(9, "content_update", created_at, payload)]
        )
        database = Mock()
        database.execute.return_value = revision_result
        database.scalar.return_value = 1

        result = content.list_content_revisions(30, 0, {}, database)

        self.assertEqual(
            result,
            {
                "items": [
                    {
                        "id": 9,
                        "reason": "content_update",
                        "createdAt": created_at,
                        "summary": {
                            "posts": 2,
                            "drafts": 1,
                            "projects": 2,
                            "skillGroups": 1,
                            "sizeBytes": len(
                                content.json.dumps(
                                    payload,
                                    ensure_ascii=False,
                                ).encode("utf-8")
                            ),
                        },
                    }
                ],
                "total": 1,
                "limit": 30,
                "offset": 0,
            },
        )
        statement = database.execute.call_args.args[0]
        self.assertEqual(statement._limit_clause.value, 30)
        self.assertEqual(
            statement.get_execution_options()["yield_per"],
            content.REVISION_STREAM_BATCH_SIZE,
        )
        self.assertTrue(revision_result.closed)


if __name__ == "__main__":
    unittest.main()
