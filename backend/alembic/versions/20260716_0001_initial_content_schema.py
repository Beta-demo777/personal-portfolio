"""Create the initial portfolio content schema.

Revision ID: 20260716_0001
Revises:
Create Date: 2026-07-16
"""

from collections.abc import Sequence
from typing import Optional, Union

from alembic import context, op
import sqlalchemy as sa


revision: str = "20260716_0001"
down_revision: Optional[str] = None
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


EXPECTED_TABLES = {
    "site_content": {
        "id": (sa.Integer, False, None, None),
        "payload": (sa.JSON, False, None, None),
        "updated_at": (sa.DateTime, False, None, "current_timestamp"),
    },
    "content_revisions": {
        "id": (sa.Integer, False, None, "owned_sequence"),
        "payload": (sa.JSON, False, None, None),
        "reason": (sa.String, False, 32, None),
        "created_at": (sa.DateTime, False, None, "current_timestamp"),
    },
}


def _normalized_server_default(value: object) -> str:
    return "".join(str(value or "").lower().split())


def _column_type_is_compatible(
    bind: sa.engine.Connection,
    column_type: object,
    expected_type: type,
) -> bool:
    if not isinstance(column_type, expected_type):
        return False
    if (
        expected_type is sa.DateTime
        and bind.dialect.name == "postgresql"
        and getattr(column_type, "timezone", False) is not True
    ):
        return False
    return True


def _has_owned_sequence_default(
    bind: sa.engine.Connection,
    table_name: str,
    column_name: str,
) -> bool:
    return bool(
        bind.scalar(
            sa.text(
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
    table_name: str,
    columns: dict[str, dict],
) -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for column_name, (_, _, _, default_kind) in EXPECTED_TABLES[table_name].items():
        if default_kind == "current_timestamp":
            default = _normalized_server_default(columns[column_name].get("default"))
            if default not in {"now()", "current_timestamp"}:
                raise RuntimeError(
                    f"Existing {table_name}.{column_name} has an incompatible "
                    "server default; expected the current timestamp"
                )
        elif default_kind == "owned_sequence" and not _has_owned_sequence_default(
            bind,
            table_name,
            column_name,
        ):
            raise RuntimeError(
                f"Existing {table_name}.{column_name} must have a sequence-backed "
                "server default owned by the same column"
            )


def _existing_table_is_compatible(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(table_name):
        return False

    expected = EXPECTED_TABLES[table_name]
    columns = {column["name"]: column for column in inspector.get_columns(table_name)}
    if set(columns) != set(expected):
        raise RuntimeError(
            f"Existing {table_name} columns are incompatible with the migration; "
            f"expected {sorted(expected)}, found {sorted(columns)}"
        )

    for column_name, (type_class, nullable, length, _) in expected.items():
        column = columns[column_name]
        column_type = column["type"]
        if not _column_type_is_compatible(bind, column_type, type_class):
            raise RuntimeError(
                f"Existing {table_name}.{column_name} has incompatible type "
                f"{column_type}; expected {type_class.__name__}"
            )
        if bool(column["nullable"]) != nullable:
            raise RuntimeError(
                f"Existing {table_name}.{column_name} has incompatible nullability"
            )
        if length is not None and getattr(column_type, "length", None) != length:
            raise RuntimeError(
                f"Existing {table_name}.{column_name} has incompatible length"
            )

    primary_key = inspector.get_pk_constraint(table_name).get("constrained_columns") or []
    if set(primary_key) != {"id"}:
        raise RuntimeError(f"Existing {table_name} has an incompatible primary key")
    _validate_postgresql_write_defaults(table_name, columns)
    return True


def _should_create_table(table_name: str) -> bool:
    # Offline mode cannot inspect a database and must render the complete DDL.
    return context.is_offline_mode() or not _existing_table_is_compatible(table_name)


def upgrade() -> None:
    if _should_create_table("site_content"):
        op.create_table(
            "site_content",
            sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    if _should_create_table("content_revisions"):
        op.create_table(
            "content_revisions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("reason", sa.String(length=32), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )


def downgrade() -> None:
    raise RuntimeError(
        "The baseline migration is intentionally irreversible because it may "
        "have adopted pre-existing CMS tables; restore a verified backup to roll back"
    )
