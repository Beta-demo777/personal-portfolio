from functools import lru_cache

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from sqlalchemy import DateTime, Integer, JSON, String, create_engine, inspect, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import PROJECT_ROOT, settings


def _create_database_engine():
    return create_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_timeout=settings.DB_POOL_TIMEOUT_SECONDS,
        hide_parameters=True,
        connect_args=settings.database_connect_args(),
    )


engine = _create_database_engine()
REQUIRED_CMS_SCHEMA = {
    "site_content": {
        "id": (Integer, False, None, None),
        "payload": (JSON, False, None, None),
        "updated_at": (DateTime, False, None, "current_timestamp"),
    },
    "content_revisions": {
        "id": (Integer, False, None, "owned_sequence"),
        "payload": (JSON, False, None, None),
        "reason": (String, False, 32, None),
        "created_at": (DateTime, False, None, "current_timestamp"),
    },
}


class DatabaseNotReadyError(SQLAlchemyError):
    pass


def _normalized_server_default(value: object) -> str:
    return "".join(str(value or "").lower().split())


def _column_type_is_compatible(
    connection: Connection,
    column_type: object,
    expected_type: type,
) -> bool:
    if not isinstance(column_type, expected_type):
        return False
    if (
        expected_type is DateTime
        and connection.dialect.name == "postgresql"
        and getattr(column_type, "timezone", False) is not True
    ):
        return False
    return True


def _has_owned_sequence_default(
    connection: Connection,
    table_name: str,
    column_name: str,
) -> bool:
    return bool(
        connection.scalar(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_class AS table_relation
                    JOIN pg_namespace AS table_namespace
                        ON table_namespace.oid = table_relation.relnamespace
                    JOIN pg_attribute AS column_attribute
                        ON column_attribute.attrelid = table_relation.oid
                    JOIN pg_attrdef AS column_default
                        ON column_default.adrelid = table_relation.oid
                        AND column_default.adnum = column_attribute.attnum
                    JOIN pg_depend AS default_dependency
                        ON default_dependency.classid = 'pg_attrdef'::regclass
                        AND default_dependency.objid = column_default.oid
                        AND default_dependency.refclassid = 'pg_class'::regclass
                    JOIN pg_class AS sequence_relation
                        ON sequence_relation.oid = default_dependency.refobjid
                        AND sequence_relation.relkind = 'S'
                    JOIN pg_depend AS ownership_dependency
                        ON ownership_dependency.classid = 'pg_class'::regclass
                        AND ownership_dependency.objid = sequence_relation.oid
                        AND ownership_dependency.refclassid = 'pg_class'::regclass
                        AND ownership_dependency.refobjid = table_relation.oid
                        AND ownership_dependency.refobjsubid = column_attribute.attnum
                        AND ownership_dependency.deptype IN ('a', 'i')
                    WHERE table_namespace.nspname = current_schema()
                        AND table_relation.relname = :table_name
                        AND table_relation.relkind IN ('r', 'p')
                        AND column_attribute.attname = :column_name
                        AND column_attribute.attnum > 0
                        AND NOT column_attribute.attisdropped
                )
                """
            ),
            {"table_name": table_name, "column_name": column_name},
        )
    )


def _validate_postgresql_write_defaults(
    connection: Connection,
    table_name: str,
    available_columns: dict[str, dict],
    expected_columns: dict,
) -> None:
    if connection.dialect.name != "postgresql":
        return

    for column_name, (_, _, _, default_kind) in expected_columns.items():
        if default_kind == "current_timestamp":
            default = _normalized_server_default(
                available_columns[column_name].get("default")
            )
            if default not in {"now()", "current_timestamp"}:
                raise DatabaseNotReadyError(
                    f"{table_name}.{column_name} has an incompatible server default"
                )
        elif default_kind == "owned_sequence" and not _has_owned_sequence_default(
            connection,
            table_name,
            column_name,
        ):
            raise DatabaseNotReadyError(
                f"{table_name}.{column_name} does not have its required owned sequence default"
            )


class Base(DeclarativeBase):
    pass


SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@lru_cache(maxsize=1)
def _expected_migration_heads() -> frozenset[str]:
    try:
        alembic_config = Config(str(PROJECT_ROOT / "alembic.ini"))
        heads = frozenset(ScriptDirectory.from_config(alembic_config).get_heads())
    except (CommandError, KeyError, OSError) as error:
        raise DatabaseNotReadyError("Alembic migration metadata is unavailable") from error
    if not heads:
        raise DatabaseNotReadyError("Alembic migration metadata does not define a head")
    return heads


def check_database_readiness() -> None:
    expected_heads = _expected_migration_heads()
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))

        current_heads = frozenset(MigrationContext.configure(connection).get_current_heads())
        if current_heads != expected_heads:
            raise DatabaseNotReadyError(
                "Database migration revision does not match the application head"
            )

        inspector = inspect(connection)
        missing_tables = [
            table_name
            for table_name in REQUIRED_CMS_SCHEMA
            if not inspector.has_table(table_name)
        ]
        if missing_tables:
            raise DatabaseNotReadyError(
                f"Required CMS tables are missing: {', '.join(missing_tables)}"
            )

        for table_name, expected_columns in REQUIRED_CMS_SCHEMA.items():
            available_columns = {
                column["name"]: column for column in inspector.get_columns(table_name)
            }
            if set(available_columns) != set(expected_columns):
                raise DatabaseNotReadyError(
                    f"{table_name} columns do not match the application schema"
                )

            for column_name, (type_class, nullable, length, _) in expected_columns.items():
                column = available_columns[column_name]
                column_type = column["type"]
                if not _column_type_is_compatible(
                    connection,
                    column_type,
                    type_class,
                ):
                    raise DatabaseNotReadyError(
                        f"{table_name}.{column_name} has an incompatible type"
                    )
                if bool(column["nullable"]) != nullable:
                    raise DatabaseNotReadyError(
                        f"{table_name}.{column_name} has incompatible nullability"
                    )
                if length is not None and getattr(column_type, "length", None) != length:
                    raise DatabaseNotReadyError(
                        f"{table_name}.{column_name} has an incompatible length"
                    )

            primary_key = (
                inspector.get_pk_constraint(table_name).get("constrained_columns") or []
            )
            if set(primary_key) != {"id"}:
                raise DatabaseNotReadyError(
                    f"{table_name} has an incompatible primary key"
                )

            _validate_postgresql_write_defaults(
                connection,
                table_name,
                available_columns,
                expected_columns,
            )

        site_content_ids = list(
            connection.scalars(
                text("SELECT id FROM site_content ORDER BY id LIMIT 2")
            )
        )
        if site_content_ids not in ([], [1]):
            raise DatabaseNotReadyError("site_content singleton invariant failed")

        connection.execute(text("SELECT id, payload, updated_at FROM site_content LIMIT 0"))
        connection.execute(
            text("SELECT id, payload, reason, created_at FROM content_revisions LIMIT 0")
        )
