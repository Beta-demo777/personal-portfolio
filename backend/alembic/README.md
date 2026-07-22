# Database migrations

Run Alembic from the repository root so it can find `alembic.ini`:

```bash
alembic upgrade head
```

The connection used here must be the database maintenance owner. Production
Compose runs this command only through the one-shot `database-init` service;
the long-running API role intentionally has no DDL privileges. After every
online upgrade, `database-init` reconciles the explicit business-table and
owned-sequence grants before the API is allowed to start.

For a new, empty database, the initial revision creates `site_content` and
`content_revisions`. The following data migration gives every legacy blog post
an explicit `published` status in both the current payload and retained content
revisions. Runtime public reads remain fail-closed when a status is absent.

Databases created by the application before Alembic was introduced already
contain those tables. Back up the database and run the normal upgrade:

```bash
alembic upgrade head
```

In online mode, the initial revision detects those tables and validates their
column names, types, nullability, lengths, primary keys, write-required timestamp
defaults, and the owned sequence backing `content_revisions.id` before recording
the baseline. It aborts instead of stamping an incompatible or read-only schema.
Missing tables are created normally.

Because the baseline may adopt tables that predate Alembic, it is intentionally
irreversible and will never drop them during `alembic downgrade`. Restore a
verified backup when a full rollback is required.

To inspect SQL without connecting to PostgreSQL:

```bash
alembic upgrade head --sql
```

The database URL comes from `app.core.config.settings.database_url`; it is not
stored in `alembic.ini` or rendered into offline SQL.
