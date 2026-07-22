#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/backup.sh --output DIRECTORY
       scripts/backup.sh --recover

Creates a consistent portfolio backup directory containing a PostgreSQL custom
dump, final uploaded media, a signed manifest, and SHA-256 checksums. The
independent signing key pair is configured with
PORTFOLIO_BACKUP_PRIVATE_KEY_FILE and PORTFOLIO_BACKUP_PUBLIC_KEY_FILE.
Backend writes are stopped for the duration and the previous backend state is
restored. --recover only converges backend state left by an interrupted backup.
EOF
}

fail() {
    printf 'backup: %s\n' "$*" >&2
    exit 1
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        fail "sha256sum, shasum, or openssl is required"
    fi
}

valid_revision() {
    [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]
}

output_dir=""
recovery_mode=false
while (($#)); do
    case "$1" in
        --output)
            (($# >= 2)) || fail "--output requires a directory"
            output_dir=$2
            shift 2
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
    [[ -z "$output_dir" ]] || fail "--recover cannot be combined with --output"
else
    [[ -n "$output_dir" ]] || fail "--output is required unless --recover is used"
fi
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=maintenance-lock.sh
source "$SCRIPT_DIR/maintenance-lock.sh"
compose_project_name=$(portfolio_compose_project_name)
portfolio_maintenance_lock_acquire "$compose_project_name" backup || exit $?
trap portfolio_maintenance_lock_release EXIT

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

backup_state_directory=${PORTFOLIO_BACKUP_STATE_DIR:-$(portfolio_maintenance_lock_directory)}
[[ "$backup_state_directory" == /* ]] || fail "PORTFOLIO_BACKUP_STATE_DIR must be absolute"
backup_journal_file="$backup_state_directory/$compose_project_name.backup.json"

migration_helper() {
    "${COMPOSE[@]}" run --rm --no-deps -T \
        --volume "$SCRIPT_DIR/backup_migrations.py:/tmp/backup_migrations.py:ro" \
        --entrypoint python backend /tmp/backup_migrations.py \
        --config /app/alembic.ini "$@"
}

backup_journal_helper() {
    python3 "$SCRIPT_DIR/backup_journal.py" \
        --file "$backup_journal_file" \
        --project "$compose_project_name" "$@"
}

validated_backend_snapshot() {
    local container_id=$1
    local snapshot
    local container_state
    local health_state
    local container_project
    local container_service
    local extra

    snapshot=$(
        docker inspect --type container \
            --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
            "$container_id" 2>/dev/null
    ) || {
        printf 'backup: recorded backend container cannot be inspected: %s\n' \
            "$container_id" >&2
        return 1
    }
    [[ -n "$snapshot" && "$snapshot" != *$'\n'* ]] || {
        printf '%s\n' 'backup: backend container inspection returned invalid output' >&2
        return 1
    }
    IFS='|' read -r \
        container_state health_state container_project container_service extra \
        <<< "$snapshot"
    if [[ -n "$extra" || "$container_project" != "$compose_project_name" || \
        "$container_service" != backend ]]; then
        printf '%s\n' \
            'backup: recorded container does not belong to this Compose backend service' >&2
        return 1
    fi
    case "$container_state" in
        created|running|restarting|exited|paused|dead|removing) ;;
        *)
            printf '%s\n' 'backup: backend container has an invalid runtime state' >&2
            return 1
            ;;
    esac
    case "$health_state" in
        healthy|unhealthy|starting|missing) ;;
        *)
            printf '%s\n' 'backup: backend container has an invalid health state' >&2
            return 1
            ;;
    esac
    printf '%s\t%s\n' "$container_state" "$health_state"
}

wait_for_backend_health() {
    local container_id=$1
    local deadline=$((SECONDS + 60))
    local snapshot
    local container_state
    local health_state

    while :; do
        snapshot=$(validated_backend_snapshot "$container_id") || return 1
        IFS=$'\t' read -r container_state health_state <<< "$snapshot"
        case "$container_state" in
            running|restarting) ;;
            *)
                printf 'backup: backend container stopped while waiting for readiness: %s\n' \
                    "$container_id" >&2
                return 1
                ;;
        esac
        case "$health_state" in
            healthy)
                return 0
                ;;
            unhealthy|missing)
                printf 'backup: backend container did not expose a healthy readiness state: %s\n' \
                    "$container_id" >&2
                return 1
                ;;
            starting)
                if ((SECONDS >= deadline)); then
                    printf 'backup: backend readiness timed out after 60 seconds: %s\n' \
                        "$container_id" >&2
                    return 1
                fi
                sleep 1
                ;;
        esac
    done
}

recover_interrupted_backup() {
    local journal_record
    local backend_container_id
    local extra
    local snapshot
    local container_state
    local health_state

    journal_record=$(backup_journal_helper read) || return 1
    IFS=$'\t' read -r backend_container_id _ extra <<< "$journal_record"
    if [[ -n "$extra" || ! "$backend_container_id" =~ ^[0-9a-f]{64}$ ]]; then
        printf '%s\n' 'backup: interrupted backup journal returned invalid state' >&2
        return 1
    fi

    snapshot=$(validated_backend_snapshot "$backend_container_id") || return 1
    IFS=$'\t' read -r container_state health_state <<< "$snapshot"
    case "$container_state" in
        running|restarting)
            ;;
        created|exited)
            backup_journal_helper update --phase backend_starting || return 1
            printf 'Starting original backend container %s...\n' "$backend_container_id"
            if ! docker start "$backend_container_id" >/dev/null; then
                printf 'backup: original backend container could not be started: %s\n' \
                    "$backend_container_id" >&2
                return 1
            fi
            ;;
        *)
            printf 'backup: original backend container is not safely startable from state %s\n' \
                "$container_state" >&2
            return 1
            ;;
    esac

    wait_for_backend_health "$backend_container_id" || return 1
    backup_journal_helper remove || return 1
    printf 'Interrupted backup backend recovery completed for Compose project %s.\n' \
        "$compose_project_name"
}

backup_journal_status=0
if backup_journal_helper exists; then
    :
else
    backup_journal_status=$?
fi
case "$backup_journal_status" in
    0)
        printf 'Recovering backend state left by an interrupted backup...\n'
        recover_interrupted_backup || \
            fail "interrupted backup recovery failed; journal retained"
        ;;
    3)
        if [[ "$recovery_mode" == true ]]; then
            printf 'No interrupted backup exists for Compose project %s.\n' \
                "$compose_project_name"
        fi
        ;;
    *)
        fail "backup journal state is unsafe or unreadable"
        ;;
esac

if [[ "$recovery_mode" == true ]]; then
    portfolio_maintenance_lock_release
    trap - EXIT HUP INT TERM
    exit 0
fi

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

COMPOSE=(docker compose --project-name "$compose_project_name")
COMPOSE+=(--project-directory "$ROOT_DIR" --file "$ROOT_DIR/docker-compose.yml")

backup_private_key=${PORTFOLIO_BACKUP_PRIVATE_KEY_FILE:-}
backup_public_key=${PORTFOLIO_BACKUP_PUBLIC_KEY_FILE:-}
[[ -n "$backup_private_key" ]] || \
    fail "PORTFOLIO_BACKUP_PRIVATE_KEY_FILE is required"
[[ -n "$backup_public_key" ]] || \
    fail "PORTFOLIO_BACKUP_PUBLIC_KEY_FILE is required"

mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)

printf 'Validating independent backup signing configuration...\n'
signature_key_id=$(
    python3 "$SCRIPT_DIR/backup_signature.py" validate-pair \
        --private-key "$backup_private_key" \
        --public-key "$backup_public_key" \
        --forbid-root "$ROOT_DIR" \
        --forbid-root "$output_dir"
) || fail "independent backup signing configuration is invalid"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
final_dir="$output_dir/portfolio-backup-$timestamp"
quarantine_dir="$output_dir/portfolio-backup-$timestamp.quarantine"
[[ ! -e "$final_dir" ]] || fail "backup destination already exists: $final_dir"
[[ ! -e "$quarantine_dir" ]] || fail "backup quarantine destination already exists: $quarantine_dir"

temp_dir=$(mktemp -d "$output_dir/.portfolio-backup-$timestamp.XXXXXX")
backend_was_active=false
backend_container_id=""
journal_active=false
service_recovery_attempted=false
backup_verified=false

recover_backend() {
    service_recovery_attempted=true
    printf 'Restoring previous backend state and waiting for readiness...\n'
    if recover_interrupted_backup; then
        journal_active=false
        return 0
    fi
    if [[ "$backup_verified" == true ]]; then
        printf 'backup: backup data is valid, but backend readiness recovery failed\n' >&2
    else
        printf 'backup: backend readiness recovery failed after an incomplete backup attempt\n' >&2
    fi
    return 1
}

quarantine_verified_backup() {
    [[ -n "${temp_dir:-}" && -d "$temp_dir" ]] || return 0
    if [[ -e "$quarantine_dir" ]]; then
        printf 'backup: verified backup remains at %s because the quarantine destination exists\n' \
            "$temp_dir" >&2
        return 1
    fi
    if ! mv -- "$temp_dir" "$quarantine_dir"; then
        printf 'backup: verified backup could not be moved to quarantine and remains at %s\n' \
            "$temp_dir" >&2
        return 1
    fi
    temp_dir=""
    printf 'backup: verified backup quarantined at %s\n' "$quarantine_dir" >&2
    printf 'backup: verify it with the independently configured public key: %s/verify-backup.sh --backup %q\n' \
        "$SCRIPT_DIR" "$quarantine_dir" >&2
}

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [[ "$journal_active" == true && "$service_recovery_attempted" != true ]]; then
        if ! recover_backend; then
            status=2
        fi
    fi
    if [[ -n "${temp_dir:-}" && -d "$temp_dir" ]]; then
        if [[ "$backup_verified" == true ]]; then
            if ! quarantine_verified_backup; then
                status=2
            fi
        else
            rm -rf -- "$temp_dir"
        fi
    fi
    portfolio_maintenance_lock_release
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

backend_container_ids=()
for backend_state in running restarting; do
    state_backend_ids=$(
        "${COMPOSE[@]}" ps --status "$backend_state" --quiet backend
    ) || fail "backend container state could not be determined"
    while IFS= read -r state_backend_id; do
        [[ -n "$state_backend_id" ]] || continue
        [[ "$state_backend_id" =~ ^[0-9a-f]{64}$ ]] || \
            fail "Compose returned an invalid backend container ID"
        backend_container_ids+=("$state_backend_id")
    done <<< "$state_backend_ids"
done
if ((${#backend_container_ids[@]} > 1)); then
    fail "expected at most one active backend container"
elif ((${#backend_container_ids[@]} == 1)); then
    backend_container_id=${backend_container_ids[0]}
    backend_snapshot=$(validated_backend_snapshot "$backend_container_id") || \
        fail "active backend container identity could not be verified"
    IFS=$'\t' read -r backend_runtime_state _ \
        <<< "$backend_snapshot"
    case "$backend_runtime_state" in
        running|restarting) ;;
        *) fail "Compose active backend container is not running" ;;
    esac
    backend_was_active=true
fi

if [[ "$backend_was_active" == true ]]; then
    backup_journal_helper create \
        --backend-container-id "$backend_container_id" \
        --phase backend_stopping
    journal_active=true
    printf 'Stopping backend writes...\n'
    "${COMPOSE[@]}" stop backend
    backup_journal_helper update --phase backend_stopped
else
    printf 'Backend is not active; preserving its existing stopped state.\n'
fi

printf 'Recording application and database migration compatibility...\n'
application_alembic_head=$(migration_helper application-head)
valid_revision "$application_alembic_head" || \
    fail "application must expose exactly one valid Alembic head"
database_alembic_heads=$(
    "${COMPOSE[@]}" exec -T postgres sh -c \
        'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
            --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"' \
        sh 'SELECT version_num FROM alembic_version ORDER BY version_num'
)
database_head_count=$(printf '%s\n' "$database_alembic_heads" | awk 'NF { count++ } END { print count + 0 }')
[[ "$database_head_count" == "1" ]] || \
    fail "database must expose exactly one Alembic head; found $database_head_count"
database_alembic_head=$database_alembic_heads
valid_revision "$database_alembic_head" || fail "database Alembic head is invalid"
migration_helper validate-metadata \
    --database-head "$database_alembic_head" \
    --backup-application-head "$application_alembic_head" >/dev/null

printf 'Creating PostgreSQL dump...\n'
"${COMPOSE[@]}" exec -T postgres sh -c \
    'exec pg_dump --format=custom --no-owner --no-privileges --no-comments --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    > "$temp_dir/database.dump"
[[ -s "$temp_dir/database.dump" ]] || fail "PostgreSQL dump is empty"

printf 'Archiving uploaded media...\n'
"${COMPOSE[@]}" run --rm --no-deps -T \
    --volume "$SCRIPT_DIR/restore_uploads.py:/tmp/restore_uploads.py:ro" \
    --entrypoint python backend /tmp/restore_uploads.py create \
    > "$temp_dir/uploads.tar"
[[ -s "$temp_dir/uploads.tar" ]] || fail "uploaded media archive is empty"

database_bytes=$(wc -c < "$temp_dir/database.dump" | tr -d '[:space:]')
uploads_bytes=$(wc -c < "$temp_dir/uploads.tar" | tr -d '[:space:]')
cat > "$temp_dir/manifest.txt" <<EOF
format_version=3
created_at_utc=$created_at
application_id=personal-portfolio
application_backup_compatibility=1
application_alembic_head=$application_alembic_head
signature_format_version=1
signature_algorithm=rsa-pss-sha256-mgf1-sha256-saltlen32
signature_key_id=$signature_key_id
database_format=postgresql_custom
database_alembic_head=$database_alembic_head
database_bytes=$database_bytes
uploads_format=tar
uploads_bytes=$uploads_bytes
EOF

for file in database.dump uploads.tar manifest.txt; do
    printf '%s  %s\n' "$(sha256_file "$temp_dir/$file")" "$file"
done > "$temp_dir/SHA256SUMS"

printf 'Signing backup checksums with the independent private key...\n'
python3 "$SCRIPT_DIR/backup_signature.py" sign \
    --checksums "$temp_dir/SHA256SUMS" \
    --private-key "$backup_private_key" \
    --forbid-root "$ROOT_DIR" \
    --forbid-root "$output_dir" \
    > "$temp_dir/SHA256SUMS.sig"
[[ -s "$temp_dir/SHA256SUMS.sig" ]] || fail "backup signature is empty"
chmod 0600 "$temp_dir/SHA256SUMS.sig"

printf 'Verifying completed backup before service recovery...\n'
(
    unset PORTFOLIO_BACKUP_PUBLIC_KEY_FILES
    "$SCRIPT_DIR/verify-backup.sh" \
        --backup "$temp_dir" \
        --public-key "$backup_public_key"
)
backup_verified=true

if [[ "$backend_was_active" == true ]]; then
    if ! recover_backend; then
        exit 2
    fi
fi

mv -- "$temp_dir" "$final_dir"
temp_dir=""
portfolio_maintenance_lock_release
trap - EXIT HUP INT TERM

printf 'Backup created: %s\n' "$final_dir"
printf 'Verify with the independently configured public key: %s/verify-backup.sh --backup %q\n' \
    "$SCRIPT_DIR" "$final_dir"
