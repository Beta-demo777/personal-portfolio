#!/bin/sh

set -eu

if [ "${1:-}" = "database-init" ]; then
    [ "$#" -eq 1 ] || {
        printf '%s\n' 'portfolio-entrypoint: database-init does not accept arguments' >&2
        exit 64
    }
    python -m alembic -c /app/alembic.ini upgrade head
    exec python -m app.db.runtime_role
fi

if [ "${RUN_DB_MIGRATIONS:-false}" != "false" ]; then
    printf '%s\n' \
        'portfolio-entrypoint: RUN_DB_MIGRATIONS is no longer supported; run the database-init service' \
        >&2
    exit 64
fi

exec "$@"
