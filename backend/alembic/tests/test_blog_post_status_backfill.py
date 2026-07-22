import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

from sqlalchemy.dialects import postgresql

from test_support import configure_test_environment

configure_test_environment()


REVISION_PATH = (
    Path(__file__).resolve().parents[1]
    / "versions"
    / "20260717_0002_backfill_blog_post_status.py"
)
SPEC = importlib.util.spec_from_file_location("blog_post_status_backfill", REVISION_PATH)
assert SPEC is not None and SPEC.loader is not None
revision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(revision)


class BlogPostStatusBackfillTests(unittest.TestCase):
    def test_revision_extends_the_initial_schema_head(self) -> None:
        self.assertEqual(revision.revision, "20260717_0002")
        self.assertEqual(revision.down_revision, "20260716_0001")

    def test_upgrade_backfills_both_current_content_and_revisions(self) -> None:
        with patch.object(revision.op, "execute") as execute:
            revision.upgrade()

        self.assertEqual(execute.call_count, 2)
        statements = [
            str(call.args[0].compile(dialect=postgresql.dialect()))
            for call in execute.call_args_list
        ]
        for table_name, statement in zip(revision.CONTENT_TABLES, statements):
            self.assertIn(f"UPDATE {table_name} AS target", statement)
            self.assertIn("jsonb_array_elements", statement)
            self.assertIn("WITH ORDINALITY", statement)
            self.assertIn("ORDER BY item.ordinality", statement)
            self.assertIn("NOT (item.post ? 'status')", statement)
            self.assertIn('"status":"published"', statement)
            self.assertIn("AND EXISTS", statement)

    def test_statement_builder_rejects_unexpected_table_names(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported content table"):
            revision._backfill_statement("site_content; DROP TABLE site_content")

    def test_downgrade_is_explicitly_irreversible(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "intentionally irreversible"):
            revision.downgrade()


if __name__ == "__main__":
    unittest.main()
