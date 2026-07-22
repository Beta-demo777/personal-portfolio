"""Backfill explicit publication status for legacy blog posts.

Revision ID: 20260717_0002
Revises: 20260716_0001
Create Date: 2026-07-17
"""

from collections.abc import Sequence
from typing import Optional, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260717_0002"
down_revision: Optional[str] = "20260716_0001"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


CONTENT_TABLES = ("site_content", "content_revisions")


def _backfill_statement(table_name: str) -> sa.TextClause:
    if table_name not in CONTENT_TABLES:
        raise ValueError(f"Unsupported content table: {table_name}")
    return sa.text(
        f"""
        UPDATE {table_name} AS target
        SET payload = jsonb_set(
            target.payload::jsonb,
            '{{blogPosts}}',
            (
                SELECT jsonb_agg(
                    CASE
                        WHEN jsonb_typeof(item.post) = 'object'
                            AND NOT (item.post ? 'status')
                        THEN item.post || '{{"status":"published"}}'::jsonb
                        ELSE item.post
                    END
                    ORDER BY item.ordinality
                )
                FROM jsonb_array_elements(
                    target.payload::jsonb -> 'blogPosts'
                ) WITH ORDINALITY AS item(post, ordinality)
            ),
            false
        )::json
        WHERE jsonb_typeof(target.payload::jsonb -> 'blogPosts') = 'array'
            AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                    target.payload::jsonb -> 'blogPosts'
                ) AS candidate(post)
                WHERE jsonb_typeof(candidate.post) = 'object'
                    AND NOT (candidate.post ? 'status')
            )
        """
    )


def upgrade() -> None:
    for table_name in CONTENT_TABLES:
        op.execute(_backfill_statement(table_name))


def downgrade() -> None:
    raise RuntimeError(
        "The blog post status backfill is intentionally irreversible because "
        "backfilled and originally explicit published states are indistinguishable; "
        "restore a verified backup to roll back"
    )
