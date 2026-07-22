#!/usr/bin/env python3

from __future__ import annotations

import psycopg2

from app.core.config import settings


def connect():
    return psycopg2.connect(
        host=settings.POSTGRES_HOST,
        port=settings.POSTGRES_PORT,
        user=settings.POSTGRES_USER,
        password=settings.POSTGRES_PASSWORD,
        dbname=settings.POSTGRES_DB,
        connect_timeout=settings.DB_CONNECT_TIMEOUT_SECONDS,
    )


def require(value: bool, message: str) -> None:
    if not value:
        raise RuntimeError(message)


def verify_catalog_policy() -> None:
    connection = connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_user, current_database()")
            require(
                cursor.fetchone() == (settings.POSTGRES_USER, settings.POSTGRES_DB),
                "backend is not connected as the configured runtime role",
            )
            cursor.execute(
                """
                SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit,
                       rolreplication, rolbypassrls, rolcanlogin
                FROM pg_roles
                WHERE rolname = current_user
                """
            )
            require(
                cursor.fetchone()
                == (False, False, False, False, False, False, True),
                "runtime role attributes are unsafe",
            )
            cursor.execute(
                """
                SELECT count(*)
                FROM pg_auth_members
                WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                """
            )
            require(cursor.fetchone() == (0,), "runtime role inherits another role")
            cursor.execute(
                """
                SELECT has_database_privilege(current_user, current_database(), 'CONNECT'),
                       has_database_privilege(current_user, current_database(), 'CREATE'),
                       has_database_privilege(current_user, current_database(), 'TEMPORARY'),
                       has_schema_privilege(current_user, 'public', 'USAGE'),
                       has_schema_privilege(current_user, 'public', 'CREATE')
                """
            )
            require(
                cursor.fetchone() == (True, False, False, True, False),
                "runtime database or schema privileges are unsafe",
            )

            for table_name in ("site_content", "content_revisions"):
                cursor.execute(
                    """
                    SELECT has_table_privilege(current_user, %s, 'SELECT'),
                           has_table_privilege(current_user, %s, 'INSERT'),
                           has_table_privilege(current_user, %s, 'UPDATE'),
                           has_table_privilege(current_user, %s, 'DELETE'),
                           has_table_privilege(current_user, %s, 'TRUNCATE'),
                           has_table_privilege(current_user, %s, 'REFERENCES'),
                           has_table_privilege(current_user, %s, 'TRIGGER')
                    """,
                    (f"public.{table_name}",) * 7,
                )
                require(
                    cursor.fetchone()
                    == (True, True, True, True, False, False, False),
                    f"runtime privileges for {table_name} are unsafe",
                )

            cursor.execute(
                """
                SELECT has_table_privilege(
                           current_user, 'public.alembic_version', 'SELECT'
                       ),
                       has_table_privilege(
                           current_user, 'public.alembic_version', 'INSERT'
                       ),
                       has_sequence_privilege(
                           current_user, 'public.content_revisions_id_seq', 'USAGE'
                       ),
                       has_sequence_privilege(
                           current_user, 'public.content_revisions_id_seq', 'SELECT'
                       ),
                       has_sequence_privilege(
                           current_user, 'public.content_revisions_id_seq', 'UPDATE'
                       )
                """
            )
            require(
                cursor.fetchone() == (True, False, True, True, False),
                "runtime migration or sequence privileges are unsafe",
            )
    finally:
        connection.close()


def verify_content_crud() -> None:
    connection = connect()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO content_revisions (payload, reason) "
                "VALUES (%s::json, %s) RETURNING id",
                ('{"composeRuntimeRoleProbe": true}', "runtime_role_probe"),
            )
            revision_id = cursor.fetchone()[0]
            cursor.execute(
                "SELECT payload FROM content_revisions WHERE id = %s",
                (revision_id,),
            )
            require(
                cursor.fetchone() == ({"composeRuntimeRoleProbe": True},),
                "runtime role could not read inserted content",
            )
            cursor.execute(
                "UPDATE content_revisions SET reason = %s WHERE id = %s",
                ("runtime_role_updated", revision_id),
            )
            require(cursor.rowcount == 1, "runtime role could not update content")
            cursor.execute(
                "DELETE FROM content_revisions WHERE id = %s",
                (revision_id,),
            )
            require(cursor.rowcount == 1, "runtime role could not delete content")
        connection.rollback()
    finally:
        connection.close()


def verify_privileged_operations_are_denied() -> None:
    forbidden_statements = (
        "CREATE TABLE runtime_role_forbidden (id integer)",
        "CREATE TEMP TABLE runtime_role_temp_forbidden (id integer)",
        "ALTER TABLE site_content ADD COLUMN runtime_role_forbidden integer",
        "TRUNCATE TABLE content_revisions",
        "CREATE DATABASE runtime_role_database_forbidden",
        "CREATE ROLE runtime_role_login_forbidden",
    )
    for statement in forbidden_statements:
        connection = connect()
        connection.autocommit = True
        try:
            with connection.cursor() as cursor:
                try:
                    cursor.execute(statement)
                except psycopg2.errors.InsufficientPrivilege:
                    continue
                raise RuntimeError("runtime role unexpectedly executed a privileged statement")
        finally:
            connection.close()


def main() -> None:
    verify_catalog_policy()
    verify_content_crud()
    verify_privileged_operations_are_denied()


if __name__ == "__main__":
    main()
