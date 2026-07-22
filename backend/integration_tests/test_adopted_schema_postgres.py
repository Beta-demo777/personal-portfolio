import json
import os
import re
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool


os.environ["PORTFOLIO_DISABLE_DOTENV"] = "true"

RUN_DB_INTEGRATION = (
    os.environ.get("PORTFOLIO_RUN_DB_INTEGRATION", "").strip().lower() == "true"
)
DATABASE_NAME_PATTERN = re.compile(
    r"(?:^|[_-])(?:ci|test)(?:[_-]|$)",
    re.IGNORECASE,
)


@unittest.skipUnless(
    RUN_DB_INTEGRATION,
    "set PORTFOLIO_RUN_DB_INTEGRATION=true to run PostgreSQL integration tests",
)
class AdoptedSchemaPostgresIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database_name = os.environ.get("POSTGRES_DB", "")
        if not DATABASE_NAME_PATTERN.search(database_name):
            raise RuntimeError(
                "Adopted-schema tests require a dedicated database name containing "
                "a standalone 'ci' or 'test' segment"
            )

        from app.core.config import PROJECT_ROOT, settings

        cls.project_root = PROJECT_ROOT
        cls.settings = settings
        cls.admin_engine = sa.create_engine(
            settings.database_url,
            isolation_level="AUTOCOMMIT",
            poolclass=NullPool,
            connect_args=settings.database_connect_args(migration=True),
        )
        cls.addClassCleanup(cls.admin_engine.dispose)

        with cls.admin_engine.connect() as connection:
            actual_name = connection.scalar(sa.text("SELECT current_database()"))
            if actual_name != database_name:
                raise RuntimeError("Connected database does not match POSTGRES_DB")

    def setUp(self) -> None:
        self.database_name = f"portfolio_test_adoption_{uuid.uuid4().hex[:12]}"
        self._create_database()
        self.addCleanup(self._drop_database)

        self.database_engine = sa.create_engine(
            self.settings.database_url.set(database=self.database_name),
            poolclass=NullPool,
            connect_args=self.settings.database_connect_args(migration=True),
        )
        self.addCleanup(self.database_engine.dispose)

    def _quoted_database_name(self, connection) -> str:
        return connection.dialect.identifier_preparer.quote(self.database_name)

    def _create_database(self) -> None:
        with self.admin_engine.connect() as connection:
            quoted_name = self._quoted_database_name(connection)
            connection.exec_driver_sql(f"CREATE DATABASE {quoted_name}")

    def _drop_database(self) -> None:
        with self.admin_engine.connect() as connection:
            connection.execute(
                sa.text(
                    """
                    SELECT pg_terminate_backend(pid)
                    FROM pg_stat_activity
                    WHERE datname = :database_name
                        AND pid <> pg_backend_pid()
                    """
                ),
                {"database_name": self.database_name},
            )
            quoted_name = self._quoted_database_name(connection)
            connection.exec_driver_sql(f"DROP DATABASE IF EXISTS {quoted_name}")

    def _create_legacy_schema(self, revision_id_mode: str) -> None:
        if revision_id_mode not in {"serial", "missing_default", "wrong_sequence"}:
            raise ValueError(f"Unsupported revision ID mode: {revision_id_mode}")

        revision_id_type = "SERIAL" if revision_id_mode != "missing_default" else "INTEGER"
        with self.database_engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TABLE site_content (
                    id INTEGER NOT NULL,
                    payload JSON NOT NULL,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
                    PRIMARY KEY (id)
                )
                """
            )
            connection.exec_driver_sql(
                f"""
                CREATE TABLE content_revisions (
                    id {revision_id_type} NOT NULL,
                    payload JSON NOT NULL,
                    reason VARCHAR(32) NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
                    PRIMARY KEY (id)
                )
                """
            )

            if revision_id_mode == "wrong_sequence":
                connection.exec_driver_sql("CREATE SEQUENCE wrong_content_revision_id_seq")
                connection.exec_driver_sql(
                    """
                    ALTER TABLE content_revisions
                    ALTER COLUMN id SET DEFAULT
                        nextval('wrong_content_revision_id_seq'::regclass)
                    """
                )

            if revision_id_mode == "serial":
                legacy_payload = json.dumps(
                    {
                        "version": "legacy",
                        "blogPosts": [{"id": "legacy-post"}],
                    },
                    separators=(",", ":"),
                )
                connection.execute(
                    sa.text(
                        """
                        INSERT INTO site_content (id, payload)
                        VALUES (1, CAST(:payload AS JSON))
                        """
                    ),
                    {"payload": legacy_payload},
                )
                connection.execute(
                    sa.text(
                        """
                        INSERT INTO content_revisions (payload, reason)
                        VALUES (CAST(:payload AS JSON), 'legacy_seed')
                        """
                    ),
                    {"payload": legacy_payload},
                )

    def _run_upgrade(self) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PORTFOLIO_DISABLE_DOTENV": "true",
                "POSTGRES_DB": self.database_name,
                "PYTHONPATH": str(self.project_root / "backend"),
            }
        )
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "alembic",
                "-c",
                str(self.project_root / "alembic.ini"),
                "upgrade",
                "head",
            ],
            cwd=self.project_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def _assert_migration_rejected_without_stamp(self) -> None:
        inspector = sa.inspect(self.database_engine)
        if not inspector.has_table("alembic_version"):
            return
        with self.database_engine.connect() as connection:
            stamped_revisions = connection.scalar(
                sa.text("SELECT count(*) FROM alembic_version")
            )
        self.assertEqual(stamped_revisions, 0)

    def test_fresh_schema_does_not_create_a_site_content_sequence(self) -> None:
        migration = self._run_upgrade()
        self.assertEqual(migration.returncode, 0, migration.stderr)

        with self.database_engine.connect() as connection:
            site_sequence = connection.scalar(
                sa.text("SELECT pg_get_serial_sequence('site_content', 'id')")
            )
            site_id_default = connection.scalar(
                sa.text(
                    """
                    SELECT column_default
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                        AND table_name = 'site_content'
                        AND column_name = 'id'
                    """
                )
            )
            revision_sequence = connection.scalar(
                sa.text(
                    "SELECT pg_get_serial_sequence('content_revisions', 'id')"
                )
            )

        self.assertIsNone(site_sequence)
        self.assertIsNone(site_id_default)
        self.assertIsNotNone(revision_sequence)

    def test_adopts_write_compatible_schema_and_preserves_application_writes(self) -> None:
        self._create_legacy_schema("serial")

        migration = self._run_upgrade()
        self.assertEqual(migration.returncode, 0, migration.stderr)

        expected_heads = tuple(
            ScriptDirectory.from_config(
                Config(str(self.project_root / "alembic.ini"))
            ).get_heads()
        )
        with self.database_engine.connect() as connection:
            database_heads = tuple(
                MigrationContext.configure(connection).get_current_heads()
            )
            sequence_name = connection.scalar(
                sa.text(
                    "SELECT pg_get_serial_sequence('content_revisions', 'id')"
                )
            )

        self.assertEqual(database_heads, expected_heads)
        self.assertIsNotNone(sequence_name)

        inspector = sa.inspect(self.database_engine)
        site_columns = {
            column["name"]: column for column in inspector.get_columns("site_content")
        }
        revision_columns = {
            column["name"]: column
            for column in inspector.get_columns("content_revisions")
        }
        self.assertEqual(
            "".join(str(site_columns["updated_at"]["default"]).lower().split()),
            "now()",
        )
        self.assertEqual(
            "".join(str(revision_columns["created_at"]["default"]).lower().split()),
            "now()",
        )
        self.assertIn("nextval(", str(revision_columns["id"]["default"]).lower())

        from app.api.content import _create_revision, _locked_site_content
        from app.db import session as database_session

        with patch.object(database_session, "engine", self.database_engine):
            database_session.check_database_readiness()

        with Session(self.database_engine, expire_on_commit=False) as database:
            content = _locked_site_content(database)
            self.assertIsNotNone(content)
            assert content is not None
            revision = _create_revision(
                database,
                content.payload,
                reason="content_update",
            )
            content.payload = {"version": "application-write", "blogPosts": []}
            database.commit()
            database.refresh(content)
            database.refresh(revision)

            self.assertEqual(revision.id, 2)
            self.assertIsNotNone(revision.created_at)
            self.assertIsNotNone(content.updated_at)
            self.assertEqual(content.payload["version"], "application-write")

        with self.database_engine.connect() as connection:
            revision_ids = list(
                connection.scalars(
                    sa.text("SELECT id FROM content_revisions ORDER BY id")
                )
            )
        self.assertEqual(revision_ids, [1, 2])

    def test_rejects_revision_id_without_server_default_or_sequence(self) -> None:
        self._create_legacy_schema("missing_default")

        migration = self._run_upgrade()

        self.assertNotEqual(migration.returncode, 0)
        self.assertIn("sequence-backed server default", migration.stderr)
        self._assert_migration_rejected_without_stamp()

    def test_rejects_revision_id_default_using_the_wrong_sequence(self) -> None:
        self._create_legacy_schema("wrong_sequence")

        migration = self._run_upgrade()

        self.assertNotEqual(migration.returncode, 0)
        self.assertIn("sequence-backed server default", migration.stderr)
        self._assert_migration_rejected_without_stamp()

    def test_readiness_rejects_timestamp_without_timezone(self) -> None:
        migration = self._run_upgrade()
        self.assertEqual(migration.returncode, 0, migration.stderr)
        with self.database_engine.begin() as connection:
            connection.exec_driver_sql(
                "ALTER TABLE site_content ALTER COLUMN updated_at "
                "TYPE TIMESTAMP WITHOUT TIME ZONE"
            )

        from app.db import session as database_session

        with patch.object(
            database_session,
            "engine",
            self.database_engine,
        ), self.assertRaisesRegex(
            database_session.DatabaseNotReadyError,
            "updated_at.*type",
        ):
            database_session.check_database_readiness()


if __name__ == "__main__":
    unittest.main()
