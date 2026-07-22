#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/restore.sh --backup DIRECTORY [--public-key FILE ...] [--yes]
       scripts/restore.sh --backup DIRECTORY --allow-unsigned-legacy [--allow-legacy-v1] [--yes]
       scripts/restore.sh --recover

Restores PostgreSQL and uploaded media from a verified backup. The database is
first restored into an isolated database and media is staged inside the uploads
volume. Signed v3 backups require one or more independent public keys, supplied
with repeated --public-key options or PORTFOLIO_BACKUP_PUBLIC_KEY_FILES.
Unsigned v1/v2 backups require --allow-unsigned-legacy; v1 additionally requires
--allow-legacy-v1 because it lacks application and migration metadata. Without
--yes, confirmation is required. Use --recover after an interrupted restore; it
never starts a new restore.
EOF
}

fail() {
    printf 'restore: %s\n' "$*" >&2
    exit 1
}

backup_dir=""
assume_yes=false
allow_legacy_v1=false
allow_unsigned_legacy=false
public_keys=()
recovery_mode=false
while (($#)); do
    case "$1" in
        --backup)
            (($# >= 2)) || fail "--backup requires a directory"
            backup_dir=$2
            shift 2
            ;;
        --yes)
            assume_yes=true
            shift
            ;;
        --public-key)
            (($# >= 2)) || fail "--public-key requires a file"
            [[ -n "$2" ]] || fail "--public-key must not be empty"
            public_keys+=("$2")
            shift 2
            ;;
        --allow-unsigned-legacy)
            allow_unsigned_legacy=true
            shift
            ;;
        --allow-legacy-v1)
            allow_legacy_v1=true
            shift
            ;;
        --recover)
            recovery_mode=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

if [[ "$recovery_mode" == true ]]; then
    [[ -z "$backup_dir" ]] || fail "--recover cannot be combined with --backup"
    [[ "$assume_yes" == false ]] || fail "--recover does not accept --yes"
    [[ "$allow_legacy_v1" == false ]] || fail "--recover does not accept --allow-legacy-v1"
    [[ "$allow_unsigned_legacy" == false ]] || \
        fail "--recover does not accept --allow-unsigned-legacy"
    ((${#public_keys[@]} == 0)) || fail "--recover does not accept --public-key"
else
    [[ -n "$backup_dir" ]] || fail "--backup is required unless --recover is used"
fi
test_fail_at=${PORTFOLIO_RESTORE_TEST_FAIL_AT:-}
test_kill_at=${PORTFOLIO_RESTORE_TEST_KILL_AT:-}
[[ -z "$test_fail_at" || -z "$test_kill_at" ]] || \
    fail "only one isolated recovery test interruption may be configured"
if [[ -n "$test_fail_at" ]]; then
    [[ "${PORTFOLIO_RESTORE_TESTING:-}" == "true" ]] || \
        fail "PORTFOLIO_RESTORE_TEST_FAIL_AT is reserved for isolated recovery tests"
    case "$test_fail_at" in
        after_media_stage|after_media_activate|after_live_database_rename|after_database_restore|after_backend_validation|after_commit_started) ;;
        *) fail "unsupported recovery test failure point: $test_fail_at" ;;
    esac
fi
if [[ -n "$test_kill_at" ]]; then
    [[ "${PORTFOLIO_RESTORE_TESTING:-}" == "true" ]] || \
        fail "PORTFOLIO_RESTORE_TEST_KILL_AT is reserved for isolated recovery tests"
    case "$test_kill_at" in
        after_media_stage|after_media_activate|after_live_database_rename|after_database_restore|after_backend_validation|after_commit_started) ;;
        *) fail "unsupported recovery test kill point: $test_kill_at" ;;
    esac
fi

inject_test_failure() {
    if [[ "$test_kill_at" == "$1" ]]; then
        printf 'restore: injecting isolated recovery test SIGKILL at %s\n' "$1" >&2
        kill -KILL "$$"
        exit 137
    fi
    if [[ "$test_fail_at" == "$1" ]]; then
        fail "injected isolated recovery test failure at $1"
    fi
}

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=maintenance-lock.sh
source "$SCRIPT_DIR/maintenance-lock.sh"
compose_project_name=$(portfolio_compose_project_name)
maintenance_operation=restore
[[ "$recovery_mode" == true ]] && maintenance_operation=restore-recover
portfolio_maintenance_lock_acquire "$compose_project_name" "$maintenance_operation" || exit $?
trap portfolio_maintenance_lock_release EXIT

command -v docker >/dev/null 2>&1 || fail "docker is required"
compose_version=$(docker compose version --short 2>/dev/null) || \
    fail "the Docker Compose plugin is required"
compose_version=${compose_version#v}
[[ "$compose_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$ ]] || \
    fail "unable to determine the Docker Compose version"
compose_major=$((10#${BASH_REMATCH[1]}))
compose_minor=$((10#${BASH_REMATCH[2]}))
if ((compose_major < 2 || (compose_major == 2 && compose_minor < 30))); then
    fail "Docker Compose 2.30.0 or newer is required; found $compose_version"
fi
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

COMPOSE=(docker compose --project-name "$compose_project_name")
COMPOSE+=(--project-directory "$ROOT_DIR" --file "$ROOT_DIR/docker-compose.yml")
restore_state_directory=${PORTFOLIO_RESTORE_STATE_DIR:-$(portfolio_maintenance_lock_directory)}
[[ "$restore_state_directory" == /* ]] || fail "PORTFOLIO_RESTORE_STATE_DIR must be absolute"
restore_journal_file="$restore_state_directory/$compose_project_name.restore.json"
backup_source_dir=$backup_dir
backup_staging_dir=""
restore_input_dir=""

cleanup_backup_staging() {
    if [[ -n "$backup_staging_dir" ]]; then
        if ! python3 "$SCRIPT_DIR/restore_backup_staging.py" remove \
            --staging "$backup_staging_dir" \
            --staging-parent "$restore_state_directory" \
            --project "$compose_project_name"; then
            return 1
        fi
        backup_staging_dir=""
        restore_input_dir=""
    fi
}

early_finish() {
    local status=$?
    trap - EXIT HUP INT TERM
    if ! cleanup_backup_staging; then
        printf 'restore: private backup staging cleanup failed\n' >&2
        ((status == 0)) && status=1
    fi
    portfolio_maintenance_lock_release
    exit "$status"
}
trap early_finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

journal_helper() {
    python3 "$SCRIPT_DIR/restore_journal.py" \
        --file "$restore_journal_file" \
        --project "$compose_project_name" "$@"
}

if [[ "$recovery_mode" != true && \
    ( -e "$restore_journal_file" || -L "$restore_journal_file" ) ]]; then
    fail "an interrupted restore journal exists; run scripts/restore.sh --recover before starting another restore"
fi

cleanup_stale_backup_staging() {
    python3 "$SCRIPT_DIR/restore_backup_staging.py" remove-stale \
        --staging-parent "$restore_state_directory" \
        --project "$compose_project_name"
}

if [[ "$recovery_mode" != true ]]; then
    # A SIGKILL cannot run the exit trap. With no recovery journal and while
    # holding the project lock, an earlier private input snapshot is stale.
    cleanup_stale_backup_staging
fi

manifest_value() {
    local key=$1
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print }' \
        "$restore_input_dir/manifest.txt"
}

migration_helper() {
    "${COMPOSE[@]}" run --rm --no-deps -T \
        --env PYTHONPATH=/app \
        --volume "$SCRIPT_DIR/backup_migrations.py:/tmp/backup_migrations.py:ro" \
        --entrypoint python backend /tmp/backup_migrations.py \
        --config /app/alembic.ini "$@"
}

if [[ "$recovery_mode" != true ]]; then
    printf 'Copying backup inputs into private restore staging...\n'
    backup_staging_dir=$(python3 "$SCRIPT_DIR/restore_backup_staging.py" stage \
        --backup "$backup_source_dir" \
        --staging-parent "$restore_state_directory" \
        --project "$compose_project_name")
    restore_input_dir=$backup_staging_dir
    backup_source_canonical=$(cd -- "$backup_source_dir" && pwd -P)
    verify_arguments=(
        --backup "$restore_input_dir"
        --forbid-key-root "$backup_source_canonical"
    )
    if ((${#public_keys[@]} > 0)); then
        for public_key in "${public_keys[@]}"; do
            verify_arguments+=(--public-key "$public_key")
        done
    fi
    if [[ "$allow_unsigned_legacy" == true ]]; then
        verify_arguments+=(--allow-unsigned-legacy)
    fi
    "$SCRIPT_DIR/verify-backup.sh" "${verify_arguments[@]}"
    backup_format_version=$(manifest_value format_version)
    manifest_database_bytes=$(manifest_value database_bytes)
    manifest_database_head=""
    manifest_application_head=""
    if [[ "$backup_format_version" == "1" ]]; then
        [[ "$allow_legacy_v1" == true ]] || fail \
            "legacy format v1 cannot be restored by default because it lacks application and Alembic metadata; re-create a signed v3 backup or also pass --allow-legacy-v1 for isolated inspection"
        printf '%s\n' \
            'restore: warning: explicitly allowing legacy v1; the isolated database will be treated as authoritative' >&2
    else
        manifest_database_head=$(manifest_value database_alembic_head)
        manifest_application_head=$(manifest_value application_alembic_head)
        printf 'Checking backup migration lineage against this application...\n'
        migration_helper validate-metadata \
            --database-head "$manifest_database_head" \
            --backup-application-head "$manifest_application_head" >/dev/null
    fi

    cat >&2 <<'EOF'
WARNING: This operation replaces the active PostgreSQL database and every file
in the uploads volume. Old data is retained until the restored database, media,
and backend readiness check have all succeeded.
EOF

    if [[ "$assume_yes" != true ]]; then
        [[ -t 0 ]] || fail "interactive confirmation requires a terminal; use --yes for automation"
        read -r -p "Type RESTORE to continue: " confirmation
        [[ "$confirmation" == "RESTORE" ]] || fail "restore cancelled"
    fi

    restore_token=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
    staged_database="portfolio_restore_${restore_token:0:16}"
    rollback_database="portfolio_rollback_${restore_token:0:16}"
fi

upload_helper() {
    "${COMPOSE[@]}" run --rm --no-deps -T \
        --volume "$SCRIPT_DIR/restore_uploads.py:/tmp/restore_uploads.py:ro" \
        --entrypoint python backend /tmp/restore_uploads.py "$@"
}

check_database_capacity() {
    local uploads_filesystem_device=$1
    local uploads_filesystem_total_bytes=$2
    local uploads_filesystem_free_bytes=$3
    local uploads_filesystem_free_inodes=$4
    local uploads_staging_bytes=$5
    local uploads_staging_inodes=$6
    local database_plain_bytes
    local database_toc_entries
    local filesystem_stats
    local filesystem_total_kib
    local filesystem_free_kib
    local filesystem_free_inodes
    local filesystem_device

    database_plain_bytes=$(
        "${COMPOSE[@]}" exec -T postgres \
            pg_restore --no-owner --no-privileges --file=- \
            < "$restore_input_dir/database.dump" | wc -c | tr -d '[:space:]'
    )
    database_toc_entries=$(
        "${COMPOSE[@]}" exec -T postgres pg_restore --list \
            < "$restore_input_dir/database.dump" | \
            awk '!/^;/ && NF { count++ } END { print count + 0 }'
    )
    filesystem_stats=$("${COMPOSE[@]}" exec -T postgres sh -euc '
        set -- $(df -Pk "$PGDATA" | tail -n 1)
        total_kib=$2
        free_kib=$4
        set -- $(df -P -i "$PGDATA" | tail -n 1)
        free_inodes=$4
        device=$(stat -c %d "$PGDATA")
        printf "%s %s %s %s\n" "$device" "$total_kib" "$free_kib" "$free_inodes"
    ')
    read -r filesystem_device filesystem_total_kib filesystem_free_kib filesystem_free_inodes \
        <<< "$filesystem_stats"

    [[ "$database_plain_bytes" =~ ^[0-9]+$ ]] || \
        fail "could not determine the expanded database restore size"
    [[ "$database_toc_entries" =~ ^[0-9]+$ ]] || \
        fail "could not determine the database restore object count"
    [[ "$filesystem_device" =~ ^[0-9]+$ && \
        "$filesystem_total_kib" =~ ^[0-9]+$ && \
        "$filesystem_free_kib" =~ ^[0-9]+$ && \
        "$filesystem_free_inodes" =~ ^[0-9]+$ ]] || \
        fail "could not determine PostgreSQL volume capacity"

    python3 "$SCRIPT_DIR/restore_capacity.py" \
        --dump-bytes "$manifest_database_bytes" \
        --plain-bytes "$database_plain_bytes" \
        --toc-entries "$database_toc_entries" \
        --filesystem-total-kib "$filesystem_total_kib" \
        --filesystem-free-kib "$filesystem_free_kib" \
        --filesystem-free-inodes "$filesystem_free_inodes" \
        --database-filesystem-device "$filesystem_device" \
        --uploads-filesystem-device "$uploads_filesystem_device" \
        --uploads-filesystem-total-bytes "$uploads_filesystem_total_bytes" \
        --uploads-filesystem-free-bytes "$uploads_filesystem_free_bytes" \
        --uploads-filesystem-free-inodes "$uploads_filesystem_free_inodes" \
        --uploads-staging-bytes "$uploads_staging_bytes" \
        --uploads-staging-inodes "$uploads_staging_inodes"
}

drop_database() {
    local database_name=$1
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec dropdb --if-exists --force --maintenance-db=template1 --username="$POSTGRES_USER" "$1"' \
        sh "$database_name"
}

swap_database() {
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec psql --username="$POSTGRES_USER" --dbname=template1 --set=ON_ERROR_STOP=1 --set=live_db="$POSTGRES_DB" --set=rollback_db="$1"' \
        sh "$rollback_database" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN (:'live_db', :'rollback_db')
  AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I RENAME TO %I', :'live_db', :'rollback_db')
\gexec
SQL
    inject_test_failure after_live_database_rename
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec psql --username="$POSTGRES_USER" --dbname=template1 --set=ON_ERROR_STOP=1 --set=live_db="$POSTGRES_DB" --set=staged_db="$1"' \
        sh "$staged_database" <<'SQL'
SELECT format('ALTER DATABASE %I RENAME TO %I', :'staged_db', :'live_db')
\gexec
SQL
}

rollback_database_swap() {
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec psql --username="$POSTGRES_USER" --dbname=template1 --set=ON_ERROR_STOP=1 --set=live_db="$POSTGRES_DB" --set=staged_db="$1" --set=rollback_db="$2"' \
        sh "$staged_database" "$rollback_database" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN (:'live_db', :'staged_db', :'rollback_db')
  AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I RENAME TO %I', :'live_db', :'staged_db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
\gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', :'rollback_db', :'live_db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
\gexec
SQL
}

recover_database_rollback() {
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec psql --username="$POSTGRES_USER" --dbname=template1 --set=ON_ERROR_STOP=1 --set=live_db="$POSTGRES_DB" --set=staged_db="$1" --set=rollback_db="$2"' \
        restore-database-rollback "$staged_database" "$rollback_database" <<'SQL'
SELECT CASE WHEN
    :'live_db' = :'staged_db'
    OR :'live_db' = :'rollback_db'
    OR :'staged_db' = :'rollback_db'
    OR (
        NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
        AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
    )
    OR (
        EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
        AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'staged_db')
        AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
    )
    THEN 'true' ELSE 'false' END AS invalid
\gset recovery_
\if :recovery_invalid
\echo 'restore: database names are ambiguous; refusing automatic rollback'
\quit 1
\endif

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN (:'live_db', :'staged_db', :'rollback_db')
  AND pid <> pg_backend_pid();

SELECT format('ALTER DATABASE %I RENAME TO %I', :'live_db', :'staged_db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'staged_db')
\gexec

SELECT format('ALTER DATABASE %I RENAME TO %I', :'rollback_db', :'live_db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
\gexec

SELECT format('DROP DATABASE %I WITH (FORCE)', :'staged_db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'staged_db')
\gexec

SELECT CASE WHEN
    NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
    OR EXISTS (SELECT 1 FROM pg_database WHERE datname = :'staged_db')
    OR EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
    THEN 'true' ELSE 'false' END AS invalid
\gset recovery_final_
\if :recovery_final_invalid
\echo 'restore: database rollback did not converge to one live database'
\quit 1
\endif
SQL
}

recover_database_commit() {
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec psql --username="$POSTGRES_USER" --dbname=template1 --set=ON_ERROR_STOP=1 --set=live_db="$POSTGRES_DB" --set=staged_db="$1" --set=rollback_db="$2"' \
        restore-database-commit "$staged_database" "$rollback_database" <<'SQL'
SELECT CASE WHEN
    :'live_db' = :'staged_db'
    OR :'live_db' = :'rollback_db'
    OR :'staged_db' = :'rollback_db'
    OR NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
    OR EXISTS (SELECT 1 FROM pg_database WHERE datname = :'staged_db')
    THEN 'true' ELSE 'false' END AS invalid
\gset recovery_
\if :recovery_invalid
\echo 'restore: committed database names are ambiguous; refusing cleanup'
\quit 1
\endif

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'rollback_db'
  AND pid <> pg_backend_pid();

SELECT format('DROP DATABASE %I WITH (FORCE)', :'rollback_db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
\gexec

SELECT CASE WHEN
    NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'live_db')
    OR EXISTS (SELECT 1 FROM pg_database WHERE datname = :'staged_db')
    OR EXISTS (SELECT 1 FROM pg_database WHERE datname = :'rollback_db')
    THEN 'true' ELSE 'false' END AS invalid
\gset recovery_final_
\if :recovery_final_invalid
\echo 'restore: committed database cleanup did not converge'
\quit 1
\endif
SQL
}

backend_active_state() {
    local backend_state
    local running_services

    for backend_state in running restarting; do
        running_services=$("${COMPOSE[@]}" ps --status "$backend_state" --services) || return $?
        if grep -qx backend <<< "$running_services"; then
            printf '%s\n' true
            return 0
        fi
    done
    printf '%s\n' false
}

recover_interrupted_restore() {
    local journal_record
    local recorded_backend_was_active
    local currently_active
    local restart_backend

    if [[ ! -e "$restore_journal_file" && ! -L "$restore_journal_file" ]]; then
        printf 'No interrupted restore exists for Compose project %s.\n' "$compose_project_name"
        return 0
    fi

    journal_record=$(journal_helper read)
    IFS=$'\t' read -r \
        restore_token \
        staged_database \
        rollback_database \
        restore_phase \
        recorded_backend_was_active \
        <<< "$journal_record"

    currently_active=$(backend_active_state)
    restart_backend=false
    if [[ "$recorded_backend_was_active" == true || "$currently_active" == true ]]; then
        restart_backend=true
    fi

    printf 'Stopping backend before recovering interrupted restore state...\n'
    "${COMPOSE[@]}" stop backend

    if [[ "$restore_phase" == commit_started ]]; then
        printf 'Finishing the previously committed database and media cleanup...\n'
        recover_database_commit
        upload_helper recover-commit --token "$restore_token"
    else
        printf 'Restoring the original database name and uploaded media...\n'
        recover_database_rollback
        upload_helper recover-rollback --token "$restore_token"
    fi

    if [[ "$restart_backend" == true ]]; then
        printf 'Starting backend and validating readiness after recovery...\n'
        "${COMPOSE[@]}" up --detach --wait --wait-timeout 60 backend
    fi

    journal_helper remove
    printf 'Interrupted restore recovery completed for Compose project %s.\n' \
        "$compose_project_name"
}

if [[ "$recovery_mode" == true ]]; then
    recover_interrupted_restore
    cleanup_stale_backup_staging
    exit 0
fi

backend_was_active=false
backend_stop_attempted=false
media_state=none
database_state=none
restore_committed=false
journal_active=false

finish() {
    status=$?
    trap - EXIT HUP INT TERM

    if ((status != 0)) && [[ "$journal_active" == true ]]; then
        durable_journal_record=""
        if durable_journal_record=$(journal_helper read); then
            IFS=$'\t' read -r \
                durable_restore_token \
                durable_staged_database \
                durable_rollback_database \
                durable_restore_phase \
                durable_backend_was_active \
                <<< "$durable_journal_record"
            if [[ "$durable_restore_phase" == commit_started ]]; then
                restore_committed=true
            fi
        else
            # The durable phase is authoritative. If it cannot be read, neither
            # rollback nor cleanup is safe; leave the backend stopped for an
            # explicit recovery after the journal problem is investigated.
            restore_committed=true
            printf 'restore: CRITICAL: recovery journal could not be read; automatic rollback was skipped\n' >&2
        fi
    fi

    if ((status != 0)) && [[ "$restore_committed" != true && "$journal_active" == true ]]; then
        database_rollback_ok=true
        media_rollback_ok=true
        backend_recovery_ok=true
        if [[ "$backend_stop_attempted" == true ]]; then
            "${COMPOSE[@]}" stop backend >/dev/null 2>&1 || true
        fi

        printf 'Restoring the original PostgreSQL database name...\n' >&2
        if recover_database_rollback; then
            database_state=none
        else
            database_rollback_ok=false
            printf 'restore: CRITICAL: database rollback did not complete; recovery journal retained\n' >&2
        fi

        if [[ "$database_rollback_ok" == true ]]; then
            printf 'Rolling back uploaded media...\n' >&2
            if upload_helper recover-rollback --token "$restore_token"; then
                media_state=none
            else
                media_rollback_ok=false
                printf 'restore: CRITICAL: media rollback did not complete; recovery journal retained\n' >&2
            fi
        else
            media_rollback_ok=false
            printf 'restore: keeping media state because database rollback did not complete\n' >&2
        fi

        if [[ "$backend_stop_attempted" == true && "$backend_was_active" == true ]]; then
            if [[ "$database_rollback_ok" == true && "$media_rollback_ok" == true ]]; then
                printf 'Restarting backend with the original data...\n' >&2
                if ! "${COMPOSE[@]}" up --detach --wait --wait-timeout 60 backend; then
                    printf 'restore: original data was restored, but backend restart failed\n' >&2
                    backend_recovery_ok=false
                fi
            else
                printf 'restore: backend remains stopped because rollback did not complete\n' >&2
                backend_recovery_ok=false
            fi
        fi

        if [[ "$database_rollback_ok" == true && \
            "$media_rollback_ok" == true && \
            "$backend_recovery_ok" == true ]]; then
            if journal_helper remove; then
                journal_active=false
            else
                printf 'restore: recovered data, but the recovery journal could not be removed\n' >&2
            fi
        fi
    fi

    if ((status != 0)); then
        if [[ "$journal_active" == true ]]; then
            printf 'restore: restore failed; run scripts/restore.sh --recover before another restore and keep backend stopped if rollback was incomplete\n' >&2
        else
            printf 'restore: restore failed; original data remains active\n' >&2
        fi
    fi
    if ! cleanup_backup_staging; then
        printf 'restore: private backup staging cleanup failed\n' >&2
        ((status == 0)) && status=1
    fi
    portfolio_maintenance_lock_release
    exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Checking uploads and PostgreSQL capacity before staging data...\n'
upload_capacity_stats=$(upload_helper preflight-capacity < "$restore_input_dir/uploads.tar")
read -r \
    uploads_filesystem_device \
    uploads_filesystem_total_bytes \
    uploads_filesystem_free_bytes \
    uploads_filesystem_free_inodes \
    uploads_staging_bytes \
    uploads_staging_inodes \
    <<< "$upload_capacity_stats"
for capacity_value in \
    "$uploads_filesystem_device" \
    "$uploads_filesystem_total_bytes" \
    "$uploads_filesystem_free_bytes" \
    "$uploads_filesystem_free_inodes" \
    "$uploads_staging_bytes" \
    "$uploads_staging_inodes"; do
    [[ "$capacity_value" =~ ^[0-9]+$ ]] || fail "could not determine uploads volume capacity"
done
check_database_capacity \
    "$uploads_filesystem_device" \
    "$uploads_filesystem_total_bytes" \
    "$uploads_filesystem_free_bytes" \
    "$uploads_filesystem_free_inodes" \
    "$uploads_staging_bytes" \
    "$uploads_staging_inodes"

printf 'Restoring backup into isolated PostgreSQL database %s...\n' "$staged_database"
journal_helper create \
    --token "$restore_token" \
    --phase database_creating
journal_active=true
database_state=creating
"${COMPOSE[@]}" exec -T postgres sh -c \
    'exec createdb --template=template0 --owner="$POSTGRES_USER" --username="$POSTGRES_USER" "$1"' \
    sh "$staged_database"
database_state=staged
journal_helper update --phase database_staged
"${COMPOSE[@]}" exec -T postgres sh -c \
    'exec pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --no-comments --username="$POSTGRES_USER" --dbname="$1"' \
    sh "$staged_database" < "$restore_input_dir/database.dump"
printf 'Validating and, when required, migrating the isolated database...\n'
prepare_migration_args=(prepare-restored)
if [[ "$backup_format_version" == "2" || "$backup_format_version" == "3" ]]; then
    prepare_migration_args+=(
        --expected-database-head "$manifest_database_head"
        --backup-application-head "$manifest_application_head"
    )
fi
"${COMPOSE[@]}" run --rm --no-deps -T \
    --env POSTGRES_DB="$staged_database" \
    --env PYTHONPATH=/app \
    --volume "$SCRIPT_DIR/backup_migrations.py:/tmp/backup_migrations.py:ro" \
    --entrypoint python database-init /tmp/backup_migrations.py \
    --config /app/alembic.ini "${prepare_migration_args[@]}"

printf 'Applying least-privilege runtime grants to the isolated database...\n'
"${COMPOSE[@]}" run --rm --no-deps -T \
    --env POSTGRES_DB="$staged_database" \
    --entrypoint python database-init -m app.db.runtime_role

printf 'Checking migrated database head and CMS schema readiness...\n'
"${COMPOSE[@]}" run --rm --no-deps -T \
    --env POSTGRES_DB="$staged_database" \
    --entrypoint python backend -c \
    'from app.db.session import check_database_readiness; check_database_readiness()'

printf 'Staging and validating uploaded media inside the uploads volume...\n'
journal_helper update --phase media_staging
media_state=staged
upload_helper stage --token "$restore_token" < "$restore_input_dir/uploads.tar"
journal_helper update --phase media_staged
inject_test_failure after_media_stage

printf 'Checking staged CMS, revision, and media-reference semantics...\n'
"${COMPOSE[@]}" run --rm --no-deps -T \
    --env POSTGRES_DB="$staged_database" \
    --entrypoint python backend -m app.db.restore_preflight \
    --uploads-root "/app/uploads/.portfolio-restore-${restore_token}.stage"

for backend_state in running restarting; do
    running_services=$("${COMPOSE[@]}" ps --status "$backend_state" --services)
    if grep -qx backend <<< "$running_services"; then
        backend_was_active=true
    fi
done

printf 'Stopping backend writes...\n'
journal_helper update \
    --phase backend_stopping \
    --backend-was-active "$backend_was_active"
backend_stop_attempted=true
"${COMPOSE[@]}" stop backend
journal_helper update --phase backend_stopped

printf 'Activating staged uploaded media with rollback state retained...\n'
journal_helper update --phase media_activating
media_state=activating
upload_helper activate --token "$restore_token"
media_state=active
journal_helper update --phase media_active
inject_test_failure after_media_activate

printf 'Switching to the fully restored PostgreSQL database...\n'
journal_helper update --phase database_swapping
database_state=swapping
swap_database
database_state=swapped
journal_helper update --phase database_swapped
inject_test_failure after_database_restore

if [[ "$backend_was_active" == true ]]; then
    printf 'Starting a read-only backend and validating readiness before committing restore...\n'
    journal_helper update --phase backend_validating
    ADMIN_WRITES_ENABLED=false \
        "${COMPOSE[@]}" up --detach --wait --wait-timeout 60 --force-recreate backend
    "${COMPOSE[@]}" stop backend
    inject_test_failure after_backend_validation
fi

# Only a ready, write-blocked application commits the restored pair. Persist the
# decision before exposing writes so every later recovery keeps accepted writes.
journal_helper update --phase commit_started
restore_committed=true
inject_test_failure after_commit_started
database_state=committed

if [[ "$backend_was_active" == true ]]; then
    printf 'Starting the committed backend with administrator writes enabled...\n'
    ADMIN_WRITES_ENABLED=true \
        "${COMPOSE[@]}" up --detach --wait --wait-timeout 60 --force-recreate backend
fi

# Cleanup only removes retained rollback data. A cleanup failure cannot damage
# the active restored pair and the journal keeps recovery deterministic.
recover_database_commit
upload_helper recover-commit --token "$restore_token"
media_state=finalized
journal_helper remove
journal_active=false

printf 'Restore completed from: %s\n' "$backup_source_dir"
