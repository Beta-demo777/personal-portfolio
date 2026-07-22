import unittest
from unittest.mock import Mock, patch

import sqlalchemy as sa

from test_support import configure_test_environment

configure_test_environment()

from app.db import session


EXPECTED_HEAD = "20260717_0002"


def create_schema(
    engine,
    *,
    revision: str = EXPECTED_HEAD,
    include_revisions: bool = True,
    include_updated_at: bool = True,
    payload_type: str = "JSON",
    payload_nullable: bool = False,
    revision_reason_length: int = 32,
    site_primary_key: bool = True,
    site_content_id: int | None = None,
) -> None:
    site_id = "id INTEGER NOT NULL"
    if site_primary_key:
        site_id += " PRIMARY KEY"
    payload_nullability = "" if payload_nullable else " NOT NULL"
    site_columns = f"{site_id}, payload {payload_type}{payload_nullability}"
    if include_updated_at:
        site_columns += ", updated_at DATETIME NOT NULL"

    with engine.begin() as connection:
        connection.execute(sa.text(f"CREATE TABLE site_content ({site_columns})"))
        if include_revisions:
            connection.execute(sa.text(
                "CREATE TABLE content_revisions ("
                "id INTEGER NOT NULL PRIMARY KEY, payload JSON NOT NULL, "
                f"reason VARCHAR({revision_reason_length}) NOT NULL, "
                "created_at DATETIME NOT NULL)"
            ))
        connection.execute(sa.text(
            "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)"
        ))
        connection.execute(
            sa.text("INSERT INTO alembic_version (version_num) VALUES (:revision)"),
            {"revision": revision},
        )
        if site_content_id is not None:
            connection.execute(
                sa.text(
                    "INSERT INTO site_content (id, payload, updated_at) "
                    "VALUES (:identifier, '{}', CURRENT_TIMESTAMP)"
                ),
                {"identifier": site_content_id},
            )


class DatabaseReadinessTests(unittest.TestCase):
    def test_application_engine_uses_bounded_connection_and_pool_waits(self) -> None:
        sentinel = object()
        with patch.object(session, "create_engine", return_value=sentinel) as create_engine:
            created = session._create_database_engine()

        self.assertIs(created, sentinel)
        _, keyword_arguments = create_engine.call_args
        self.assertTrue(keyword_arguments["pool_pre_ping"])
        self.assertTrue(keyword_arguments["hide_parameters"])
        self.assertEqual(
            keyword_arguments["pool_timeout"],
            session.settings.DB_POOL_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            keyword_arguments["connect_args"],
            session.settings.database_connect_args(),
        )

    def test_application_migration_head_is_discoverable(self) -> None:
        session._expected_migration_heads.cache_clear()
        self.assertEqual(
            session._expected_migration_heads(),
            frozenset({EXPECTED_HEAD}),
        )

    def assert_ready(self, engine) -> None:
        with patch.object(session, "engine", engine), patch.object(
            session,
            "_expected_migration_heads",
            return_value=frozenset({EXPECTED_HEAD}),
        ):
            session.check_database_readiness()

    def assert_not_ready(self, engine, message: str) -> None:
        with patch.object(session, "engine", engine), patch.object(
            session,
            "_expected_migration_heads",
            return_value=frozenset({EXPECTED_HEAD}),
        ), self.assertRaisesRegex(session.DatabaseNotReadyError, message):
            session.check_database_readiness()

    def test_accepts_current_database_with_required_schema(self) -> None:
        engine = sa.create_engine("sqlite://")
        create_schema(engine)
        self.assert_ready(engine)
        engine.dispose()

    def test_rejects_database_without_required_table(self) -> None:
        engine = sa.create_engine("sqlite://")
        create_schema(engine, include_revisions=False)
        self.assert_not_ready(engine, "Required CMS tables")
        engine.dispose()

    def test_rejects_database_without_required_column(self) -> None:
        engine = sa.create_engine("sqlite://")
        create_schema(engine, include_updated_at=False)
        self.assert_not_ready(engine, "columns")
        engine.dispose()

    def test_rejects_incompatible_column_type_nullability_and_length(self) -> None:
        wrong_type = sa.create_engine("sqlite://")
        create_schema(wrong_type, payload_type="TEXT")
        self.assert_not_ready(wrong_type, "payload.*type")
        wrong_type.dispose()

        nullable = sa.create_engine("sqlite://")
        create_schema(nullable, payload_nullable=True)
        self.assert_not_ready(nullable, "payload.*nullability")
        nullable.dispose()

        wrong_length = sa.create_engine("sqlite://")
        create_schema(wrong_length, revision_reason_length=64)
        self.assert_not_ready(wrong_length, "reason.*length")
        wrong_length.dispose()

    def test_rejects_incompatible_primary_key(self) -> None:
        engine = sa.create_engine("sqlite://")
        create_schema(engine, site_primary_key=False)
        self.assert_not_ready(engine, "site_content.*primary key")
        engine.dispose()

    def test_rejects_non_singleton_site_content_row(self) -> None:
        engine = sa.create_engine("sqlite://")
        create_schema(engine, site_content_id=2)
        self.assert_not_ready(engine, "singleton invariant")
        engine.dispose()

    def test_postgresql_timestamp_columns_must_include_timezone(self) -> None:
        connection = Mock()
        connection.dialect.name = "postgresql"

        self.assertTrue(
            session._column_type_is_compatible(
                connection,
                sa.DateTime(timezone=True),
                sa.DateTime,
            )
        )
        self.assertFalse(
            session._column_type_is_compatible(
                connection,
                sa.DateTime(timezone=False),
                sa.DateTime,
            )
        )

    def test_rejects_stale_or_missing_migration_revision(self) -> None:
        stale = sa.create_engine("sqlite://")
        create_schema(stale, revision="old_revision")
        self.assert_not_ready(stale, "migration revision")
        stale.dispose()

        missing = sa.create_engine("sqlite://")
        with missing.begin() as connection:
            connection.execute(sa.text(
                "CREATE TABLE site_content ("
                "id INTEGER NOT NULL PRIMARY KEY, payload JSON NOT NULL, "
                "updated_at DATETIME NOT NULL)"
            ))
            connection.execute(sa.text(
                "CREATE TABLE content_revisions ("
                "id INTEGER NOT NULL PRIMARY KEY, payload JSON NOT NULL, "
                "reason VARCHAR(32) NOT NULL, created_at DATETIME NOT NULL)"
            ))
        self.assert_not_ready(missing, "migration revision")
        missing.dispose()


if __name__ == "__main__":
    unittest.main()
