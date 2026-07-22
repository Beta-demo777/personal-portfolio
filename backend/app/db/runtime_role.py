from __future__ import annotations

import os
from pathlib import Path
import sys

import psycopg2
from psycopg2 import sql


BUSINESS_TABLES = ("site_content", "content_revisions")
MIGRATION_TABLE = "alembic_version"
RUNTIME_USER_ENV = "POSTGRES_RUNTIME_USER"
RUNTIME_DB_AUTH_FILE_ENV = "POSTGRES_RUNTIME_PASSWORD_FILE"
MAX_POSTGRES_IDENTIFIER_BYTES = 63


class RuntimeRolePolicyError(RuntimeError):
    pass


def _validate_runtime_role_name(role_name: str) -> str:
    if (
        not role_name
        or role_name != role_name.strip()
        or role_name.lower().startswith("pg_")
        or "\x00" in role_name
        or any(ord(character) < 32 for character in role_name)
        or len(role_name.encode("utf-8")) > MAX_POSTGRES_IDENTIFIER_BYTES
    ):
        raise RuntimeRolePolicyError("runtime database role name is invalid")
    return role_name


def _ensure_runtime_role_owns_nothing(cursor, role_name: str) -> None:
    cursor.execute(
        """
        WITH runtime_role AS (
            SELECT oid FROM pg_roles WHERE rolname = %s
        )
        SELECT object_kind, object_name
        FROM (
            SELECT 'database' AS object_kind, datname AS object_name
            FROM pg_database, runtime_role
            WHERE datdba = runtime_role.oid
            UNION ALL
            SELECT 'schema', nspname
            FROM pg_namespace, runtime_role
            WHERE nspowner = runtime_role.oid
              AND left(nspname, 3) <> 'pg_'
              AND nspname <> 'information_schema'
            UNION ALL
            SELECT 'relation', namespace.nspname || '.' || relation.relname
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            CROSS JOIN runtime_role
            WHERE relation.relowner = runtime_role.oid
              AND left(namespace.nspname, 3) <> 'pg_'
              AND namespace.nspname <> 'information_schema'
            UNION ALL
            SELECT 'function', namespace.nspname || '.' || routine.proname
            FROM pg_proc AS routine
            JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
            CROSS JOIN runtime_role
            WHERE routine.proowner = runtime_role.oid
              AND left(namespace.nspname, 3) <> 'pg_'
              AND namespace.nspname <> 'information_schema'
        ) AS owned_objects
        ORDER BY object_kind, object_name
        LIMIT 1
        """,
        (role_name,),
    )
    if cursor.fetchone() is not None:
        raise RuntimeRolePolicyError(
            "runtime database role owns an object and cannot be made least-privileged"
        )


def _revoke_role_memberships(cursor, role_name: str) -> None:
    cursor.execute(
        """
        SELECT granted_role.rolname
        FROM pg_auth_members AS membership
        JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        JOIN pg_roles AS member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = %s
        ORDER BY granted_role.rolname
        """,
        (role_name,),
    )
    for (granted_role,) in cursor.fetchall():
        cursor.execute(
            sql.SQL("REVOKE {} FROM {}")
            .format(sql.Identifier(granted_role), sql.Identifier(role_name))
        )


def _business_sequences(cursor) -> tuple[str, ...]:
    cursor.execute(
        """
        SELECT DISTINCT sequence.relname
        FROM pg_class AS sequence
        JOIN pg_namespace AS sequence_namespace
          ON sequence_namespace.oid = sequence.relnamespace
        JOIN pg_depend AS dependency
          ON dependency.classid = 'pg_class'::regclass
         AND dependency.objid = sequence.oid
         AND dependency.refclassid = 'pg_class'::regclass
         AND dependency.deptype IN ('a', 'i')
        JOIN pg_class AS business_table
          ON business_table.oid = dependency.refobjid
        JOIN pg_namespace AS table_namespace
          ON table_namespace.oid = business_table.relnamespace
        WHERE sequence.relkind = 'S'
          AND sequence_namespace.nspname = 'public'
          AND table_namespace.nspname = 'public'
          AND business_table.relname = ANY(%s)
        ORDER BY sequence.relname
        """,
        (list(BUSINESS_TABLES),),
    )
    return tuple(row[0] for row in cursor.fetchall())


def _require_schema_objects(cursor) -> tuple[str, ...]:
    required_relations = (*BUSINESS_TABLES, MIGRATION_TABLE)
    cursor.execute(
        """
        SELECT relation.relname
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY(%s)
          AND relation.relkind IN ('r', 'p')
        ORDER BY relation.relname
        """,
        (list(required_relations),),
    )
    available = {row[0] for row in cursor.fetchall()}
    missing = set(required_relations) - available
    if missing:
        raise RuntimeRolePolicyError(
            "required database schema is unavailable during runtime role provisioning"
        )
    sequences = _business_sequences(cursor)
    if not sequences:
        raise RuntimeRolePolicyError(
            "business database schema has no owned sequence for runtime inserts"
        )
    return sequences


def _assert_policy(cursor, role_name: str, sequences: tuple[str, ...]) -> None:
    cursor.execute(
        """
        SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit,
               rolreplication, rolbypassrls, rolcanlogin
        FROM pg_roles
        WHERE rolname = %s
        """,
        (role_name,),
    )
    if cursor.fetchone() != (False, False, False, False, False, False, True):
        raise RuntimeRolePolicyError("runtime database role attributes are unsafe")

    cursor.execute(
        """
        SELECT has_database_privilege(%s, current_database(), 'CONNECT'),
               has_database_privilege(%s, current_database(), 'CREATE'),
               has_database_privilege(%s, current_database(), 'TEMPORARY'),
               has_schema_privilege(%s, 'public', 'USAGE'),
               has_schema_privilege(%s, 'public', 'CREATE')
        """,
        (role_name, role_name, role_name, role_name, role_name),
    )
    if cursor.fetchone() != (True, False, False, True, False):
        raise RuntimeRolePolicyError("runtime database or schema privileges are unsafe")

    for table_name in BUSINESS_TABLES:
        cursor.execute(
            """
            SELECT has_table_privilege(%s, %s, 'SELECT'),
                   has_table_privilege(%s, %s, 'INSERT'),
                   has_table_privilege(%s, %s, 'UPDATE'),
                   has_table_privilege(%s, %s, 'DELETE'),
                   has_table_privilege(%s, %s, 'TRUNCATE'),
                   has_table_privilege(%s, %s, 'REFERENCES'),
                   has_table_privilege(%s, %s, 'TRIGGER')
            """,
            tuple(
                value
                for privilege in range(7)
                for value in (role_name, f"public.{table_name}")
            ),
        )
        if cursor.fetchone() != (True, True, True, True, False, False, False):
            raise RuntimeRolePolicyError("runtime business table privileges are unsafe")

    cursor.execute(
        """
        SELECT has_table_privilege(%s, 'public.alembic_version', 'SELECT'),
               has_table_privilege(%s, 'public.alembic_version', 'INSERT'),
               has_table_privilege(%s, 'public.alembic_version', 'UPDATE'),
               has_table_privilege(%s, 'public.alembic_version', 'DELETE')
        """,
        (role_name, role_name, role_name, role_name),
    )
    if cursor.fetchone() != (True, False, False, False):
        raise RuntimeRolePolicyError("runtime migration table privileges are unsafe")

    for sequence_name in sequences:
        cursor.execute(
            """
            SELECT has_sequence_privilege(%s, %s, 'USAGE'),
                   has_sequence_privilege(%s, %s, 'SELECT'),
                   has_sequence_privilege(%s, %s, 'UPDATE')
            """,
            (
                role_name,
                f"public.{sequence_name}",
                role_name,
                f"public.{sequence_name}",
                role_name,
                f"public.{sequence_name}",
            ),
        )
        if cursor.fetchone() != (True, True, False):
            raise RuntimeRolePolicyError("runtime sequence privileges are unsafe")


def provision_runtime_role(connection, role_name: str, password: str) -> None:
    role_name = _validate_runtime_role_name(role_name)
    if not password or "\x00" in password or "\n" in password or "\r" in password:
        raise RuntimeRolePolicyError("runtime database password is invalid")

    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user, current_database()")
        owner_name, database_name = cursor.fetchone()
        if role_name == owner_name:
            raise RuntimeRolePolicyError(
                "runtime database role must differ from the maintenance owner"
            )

        cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role_name,))
        role_exists = cursor.fetchone() is not None
        role_statement = "ALTER ROLE" if role_exists else "CREATE ROLE"
        cursor.execute(
            sql.SQL(
                f"{role_statement} {{}} WITH LOGIN NOSUPERUSER NOCREATEDB "
                "NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD {}"
            ).format(sql.Identifier(role_name), sql.Literal(password))
        )

        _ensure_runtime_role_owns_nothing(cursor, role_name)
        _revoke_role_memberships(cursor, role_name)
        sequences = _require_schema_objects(cursor)

        cursor.execute(
            sql.SQL("REVOKE CONNECT, TEMPORARY ON DATABASE {} FROM PUBLIC")
            .format(sql.Identifier(database_name))
        )
        cursor.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON DATABASE {} FROM {}")
            .format(sql.Identifier(database_name), sql.Identifier(role_name))
        )
        cursor.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}")
            .format(sql.Identifier(database_name), sql.Identifier(role_name))
        )
        cursor.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        cursor.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON SCHEMA public FROM {}")
            .format(sql.Identifier(role_name))
        )
        cursor.execute(
            sql.SQL("GRANT USAGE ON SCHEMA public TO {}")
            .format(sql.Identifier(role_name))
        )
        cursor.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {}")
            .format(sql.Identifier(role_name))
        )
        cursor.execute(
            sql.SQL("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {}")
            .format(sql.Identifier(role_name))
        )

        for table_name in BUSINESS_TABLES:
            cursor.execute(
                sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {}.{} TO {}")
                .format(
                    sql.Identifier("public"),
                    sql.Identifier(table_name),
                    sql.Identifier(role_name),
                )
            )
        cursor.execute(
            sql.SQL("GRANT SELECT ON TABLE {}.{} TO {}")
            .format(
                sql.Identifier("public"),
                sql.Identifier(MIGRATION_TABLE),
                sql.Identifier(role_name),
            )
        )
        for sequence_name in sequences:
            cursor.execute(
                sql.SQL("GRANT USAGE, SELECT ON SEQUENCE {}.{} TO {}")
                .format(
                    sql.Identifier("public"),
                    sql.Identifier(sequence_name),
                    sql.Identifier(role_name),
                )
            )

        _assert_policy(cursor, role_name, sequences)


def main() -> int:
    try:
        from app.core.config import _read_secret_file, settings

        role_name = os.environ.get(RUNTIME_USER_ENV, "")
        password_path = os.environ.get(RUNTIME_DB_AUTH_FILE_ENV, "")
        if not password_path:
            raise RuntimeRolePolicyError(
                "runtime database password file is not configured"
            )
        password = _read_secret_file(
            Path(password_path),
            RUNTIME_DB_AUTH_FILE_ENV,
        )
        connection = psycopg2.connect(
            host=settings.POSTGRES_HOST,
            port=settings.POSTGRES_PORT,
            user=settings.POSTGRES_USER,
            password=settings.POSTGRES_PASSWORD,
            dbname=settings.POSTGRES_DB,
            connect_timeout=settings.DB_CONNECT_TIMEOUT_SECONDS,
            options=(
                f"-c statement_timeout={settings.DB_MIGRATION_STATEMENT_TIMEOUT_MS}"
            ),
            application_name="portfolio-database-init",
        )
        try:
            with connection:
                provision_runtime_role(connection, role_name, password)
        finally:
            connection.close()
            password = ""
        return 0
    except Exception:
        print(
            "database-init: runtime database role provisioning failed",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
