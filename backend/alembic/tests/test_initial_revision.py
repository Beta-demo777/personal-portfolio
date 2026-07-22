import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import sqlalchemy as sa

from test_support import configure_test_environment

configure_test_environment()

from app.db.session import Base, REQUIRED_CMS_SCHEMA
from app.models import content  # noqa: F401 - registers tables with metadata


REVISION_PATH = (
    Path(__file__).resolve().parents[1]
    / "versions"
    / "20260716_0001_initial_content_schema.py"
)
SPEC = importlib.util.spec_from_file_location("initial_content_schema", REVISION_PATH)
assert SPEC is not None and SPEC.loader is not None
revision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(revision)


class InitialRevisionTests(unittest.TestCase):
    def test_readiness_contract_tracks_the_migration_schema(self) -> None:
        self.assertEqual(revision.EXPECTED_TABLES, REQUIRED_CMS_SCHEMA)

    def test_offline_mode_renders_both_create_statements(self) -> None:
        with patch.object(revision.context, "is_offline_mode", return_value=True), patch.object(
            revision.op,
            "create_table",
        ) as create_table:
            revision.upgrade()

        self.assertEqual(
            [call.args[0] for call in create_table.call_args_list],
            ["site_content", "content_revisions"],
        )

    def test_site_content_singleton_id_does_not_create_a_sequence(self) -> None:
        with patch.object(revision.context, "is_offline_mode", return_value=True), patch.object(
            revision.op,
            "create_table",
        ) as create_table:
            revision.upgrade()

        site_content_id = create_table.call_args_list[0].args[1]
        self.assertIs(site_content_id.autoincrement, False)
        self.assertIs(Base.metadata.tables["site_content"].c.id.autoincrement, False)

    def test_online_mode_adopts_compatible_existing_tables(self) -> None:
        engine = sa.create_engine("sqlite://")
        Base.metadata.create_all(engine)

        with engine.connect() as connection, patch.object(
            revision.context,
            "is_offline_mode",
            return_value=False,
        ), patch.object(revision.op, "get_bind", return_value=connection), patch.object(
            revision.op,
            "create_table",
        ) as create_table:
            revision.upgrade()

        create_table.assert_not_called()

    def test_online_mode_rejects_incompatible_existing_table(self) -> None:
        engine = sa.create_engine("sqlite://")
        with engine.begin() as connection:
            connection.execute(sa.text("CREATE TABLE site_content (id INTEGER PRIMARY KEY)"))

        with engine.connect() as connection, patch.object(
            revision.context,
            "is_offline_mode",
            return_value=False,
        ), patch.object(revision.op, "get_bind", return_value=connection):
            with self.assertRaisesRegex(RuntimeError, "columns are incompatible"):
                revision.upgrade()

    def test_downgrade_refuses_to_drop_adopted_tables(self) -> None:
        with patch.object(revision.op, "drop_table") as drop_table:
            with self.assertRaisesRegex(RuntimeError, "intentionally irreversible"):
                revision.downgrade()

        drop_table.assert_not_called()


if __name__ == "__main__":
    unittest.main()
