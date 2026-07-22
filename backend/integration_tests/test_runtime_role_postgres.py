from __future__ import annotations

import os
import secrets
import unittest

import psycopg2
from psycopg2 import sql


@unittest.skipUnless(
    os.environ.get("PORTFOLIO_RUN_DB_INTEGRATION") == "true",
    "requires the isolated PostgreSQL integration database",
)
class RuntimeRolePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from app.core.config import settings
        from app.db.runtime_role import provision_runtime_role

        cls.settings = settings
        cls.role_name = f"portfolio_runtime_test_{os.getpid()}_{secrets.token_hex(4)}"
        cls.runtime_auth_value = secrets.token_urlsafe(32)
        cls.owner_connection = cls._connect(
            settings.POSTGRES_USER,
            settings.POSTGRES_PASSWORD,
        )
        provision_runtime_role(
            cls.owner_connection,
            cls.role_name,
            cls.runtime_auth_value,
        )
        cls.owner_connection.commit()
        cls.owner_connection.autocommit = True

    @classmethod
    def tearDownClass(cls) -> None:
        if not hasattr(cls, "owner_connection"):
            return
        try:
            with cls.owner_connection.cursor() as cursor:
                cursor.execute(
                    sql.SQL("DROP OWNED BY {}")
                    .format(sql.Identifier(cls.role_name))
                )
                cursor.execute(
                    sql.SQL("DROP ROLE IF EXISTS {}")
                    .format(sql.Identifier(cls.role_name))
                )
        finally:
            cls.owner_connection.close()
            cls.runtime_auth_value = ""

    @classmethod
    def _connect(cls, user: str, password: str):
        return psycopg2.connect(
            host=cls.settings.POSTGRES_HOST,
            port=cls.settings.POSTGRES_PORT,
            user=user,
            password=password,
            dbname=cls.settings.POSTGRES_DB,
            connect_timeout=cls.settings.DB_CONNECT_TIMEOUT_SECONDS,
        )

    def test_runtime_role_has_only_required_role_and_object_privileges(self) -> None:
        with self.owner_connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit,
                       rolreplication, rolbypassrls, rolcanlogin
                FROM pg_roles
                WHERE rolname = %s
                """,
                (self.role_name,),
            )
            self.assertEqual(
                cursor.fetchone(),
                (False, False, False, False, False, False, True),
            )
            cursor.execute(
                "SELECT count(*) FROM pg_auth_members WHERE member = "
                "(SELECT oid FROM pg_roles WHERE rolname = %s)",
                (self.role_name,),
            )
            self.assertEqual(cursor.fetchone(), (0,))

            for privilege, expected in (
                ("CONNECT", True),
                ("CREATE", False),
                ("TEMPORARY", False),
            ):
                cursor.execute(
                    "SELECT has_database_privilege(%s, current_database(), %s)",
                    (self.role_name, privilege),
                )
                self.assertEqual(cursor.fetchone(), (expected,))

            for privilege, expected in (("USAGE", True), ("CREATE", False)):
                cursor.execute(
                    "SELECT has_schema_privilege(%s, 'public', %s)",
                    (self.role_name, privilege),
                )
                self.assertEqual(cursor.fetchone(), (expected,))

            for table_name in ("site_content", "content_revisions"):
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    cursor.execute(
                        "SELECT has_table_privilege(%s, %s, %s)",
                        (self.role_name, f"public.{table_name}", privilege),
                    )
                    self.assertEqual(cursor.fetchone(), (True,))
                for privilege in ("TRUNCATE", "REFERENCES", "TRIGGER"):
                    cursor.execute(
                        "SELECT has_table_privilege(%s, %s, %s)",
                        (self.role_name, f"public.{table_name}", privilege),
                    )
                    self.assertEqual(cursor.fetchone(), (False,))

            cursor.execute(
                "SELECT has_table_privilege(%s, 'public.alembic_version', 'SELECT'), "
                "has_table_privilege(%s, 'public.alembic_version', 'INSERT')",
                (self.role_name, self.role_name),
            )
            self.assertEqual(cursor.fetchone(), (True, False))
            cursor.execute(
                "SELECT has_sequence_privilege(%s, "
                "'public.content_revisions_id_seq', 'USAGE'), "
                "has_sequence_privilege(%s, "
                "'public.content_revisions_id_seq', 'SELECT'), "
                "has_sequence_privilege(%s, "
                "'public.content_revisions_id_seq', 'UPDATE')",
                (self.role_name, self.role_name, self.role_name),
            )
            self.assertEqual(cursor.fetchone(), (True, True, False))

    def test_runtime_role_can_crud_content_and_use_the_revision_sequence(self) -> None:
        connection = self._connect(self.role_name, self.runtime_auth_value)
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO content_revisions (payload, reason) "
                    "VALUES (%s::json, %s) RETURNING id",
                    ('{"runtimeRoleProbe": true}', "runtime_role_probe"),
                )
                revision_id = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT payload FROM content_revisions WHERE id = %s",
                    (revision_id,),
                )
                self.assertEqual(cursor.fetchone()[0], {"runtimeRoleProbe": True})
                cursor.execute(
                    "UPDATE content_revisions SET reason = %s WHERE id = %s",
                    ("runtime_role_updated", revision_id),
                )
                self.assertEqual(cursor.rowcount, 1)
                cursor.execute(
                    "DELETE FROM content_revisions WHERE id = %s",
                    (revision_id,),
                )
                self.assertEqual(cursor.rowcount, 1)
            connection.rollback()
        finally:
            connection.close()

    def test_runtime_role_cannot_execute_ddl_or_privileged_commands(self) -> None:
        forbidden_statements = (
            "CREATE TABLE runtime_role_forbidden (id integer)",
            "CREATE TEMP TABLE runtime_role_temp_forbidden (id integer)",
            "ALTER TABLE site_content ADD COLUMN runtime_role_forbidden integer",
            "TRUNCATE TABLE content_revisions",
            "CREATE DATABASE runtime_role_database_forbidden",
            "CREATE ROLE runtime_role_login_forbidden",
        )
        for statement in forbidden_statements:
            with self.subTest(statement=statement):
                connection = self._connect(self.role_name, self.runtime_auth_value)
                connection.autocommit = True
                try:
                    with connection.cursor() as cursor:
                        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                            cursor.execute(statement)
                finally:
                    connection.close()


if __name__ == "__main__":
    unittest.main()
