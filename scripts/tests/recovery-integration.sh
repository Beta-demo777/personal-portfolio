#!/usr/bin/env bash

set -Eeuo pipefail

fail() {
    printf 'recovery-integration: %s\n' "$*" >&2
    exit 1
}

[[ "${PORTFOLIO_RUN_RECOVERY_INTEGRATION:-}" == "true" ]] || fail \
    "refusing to run without PORTFOLIO_RUN_RECOVERY_INTEGRATION=true"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
project_name=${PORTFOLIO_RECOVERY_TEST_PROJECT:-portfolio-recovery-test-$$}
[[ "$project_name" == portfolio-recovery-test-* ]] || fail "test project name must start with portfolio-recovery-test-"

export PORTFOLIO_COMPOSE_PROJECT_NAME=$project_name
export POSTGRES_USER=portfolio_recovery_test
export POSTGRES_APP_USER=portfolio_recovery_app_test
export POSTGRES_DB=portfolio_recovery_test
export AUTH_COOKIE_SECURE=false
export PUBLIC_ORIGIN=http://localhost
export AI_MODEL=test-model

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/portfolio-recovery-integration.XXXXXX")
chmod 0700 "$temporary_directory"
backup_key_directory=$temporary_directory/backup-signing-keys
install -d -m 0700 "$backup_key_directory"
export PORTFOLIO_BACKUP_PRIVATE_KEY_FILE=$backup_key_directory/private.pem
export PORTFOLIO_BACKUP_PUBLIC_KEY_FILE=$backup_key_directory/public.pem
export PORTFOLIO_BACKUP_PUBLIC_KEY_FILES=$PORTFOLIO_BACKUP_PUBLIC_KEY_FILE
openssl genpkey \
    -algorithm RSA \
    -pkeyopt rsa_keygen_bits:3072 \
    -out "$PORTFOLIO_BACKUP_PRIVATE_KEY_FILE" \
    >/dev/null 2>&1
chmod 0600 "$PORTFOLIO_BACKUP_PRIVATE_KEY_FILE"
openssl pkey \
    -in "$PORTFOLIO_BACKUP_PRIVATE_KEY_FILE" \
    -pubout \
    -out "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILE"
chmod 0644 "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILE"
export PORTFOLIO_MAINTENANCE_LOCK_DIR=$temporary_directory/maintenance-state
export PORTFOLIO_RESTORE_STATE_DIR=$temporary_directory/maintenance-state
secret_directory=$temporary_directory/secrets
install -d -m 0700 "$secret_directory"
retired_secret_directory=$temporary_directory/retired-secrets
install -d -m 0700 "$retired_secret_directory"
inspection_secret_directory=$temporary_directory/inspection-secrets
install -d -m 0700 "$inspection_secret_directory"
docker_inspect_directory=$temporary_directory/docker-inspect
install -d -m 0700 "$docker_inspect_directory"
export PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE=$secret_directory/postgres_password
export PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE=$secret_directory/postgres_app_password
export PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE=$secret_directory/blog_admin_password_hash
export PORTFOLIO_APP_SECRET_KEY_SECRET_FILE=$secret_directory/app_secret_key
export PORTFOLIO_AI_API_KEY_SECRET_FILE=$secret_directory/ai_api_key

COMPOSE=(
    docker compose
    --project-name "$project_name"
    --project-directory "$ROOT_DIR"
    --file "$ROOT_DIR/docker-compose.yml"
)

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf -- "$temporary_directory"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

random_secret() {
    python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
}

write_secret_file() {
    local target=$1
    local value=$2
    local temporary=${target}.new

    (umask 077; printf '%s' "$value" > "$temporary")
    chmod 0600 "$temporary"
    mv -f -- "$temporary" "$target"
}

assert_log_file_contains_no_secrets() {
    local log_file=$1
    local source
    local source_directory
    for source_directory in \
        "$secret_directory" \
        "$retired_secret_directory" \
        "$inspection_secret_directory" \
        "$backup_key_directory"; do
        for source in "$source_directory"/*; do
            if [[ -s "$source" ]] && grep -Fq -f "$source" "$log_file"; then
                fail "container log exposed active or retired test secret content"
            fi
        done
    done
}

assert_service_secret_isolation() {
    local service=$1
    local container_id
    local image_id
    local container_inspect=$docker_inspect_directory/$service-container.json
    local image_inspect=$docker_inspect_directory/$service-image.json

    if [[ "$service" == database-init ]]; then
        container_id=$("${COMPOSE[@]}" ps --all --quiet "$service")
    else
        container_id=$("${COMPOSE[@]}" ps --status running --quiet "$service")
    fi
    [[ -n "$container_id" && "$container_id" != *$'\n'* ]] || \
        fail "$service does not have exactly one running container"
    image_id=$(docker inspect --type container --format '{{.Image}}' "$container_id")
    [[ -n "$image_id" && "$image_id" != *$'\n'* ]] || \
        fail "$service container does not identify exactly one image"

    (umask 077; docker inspect --type container "$container_id" > "$container_inspect")
    (umask 077; docker image inspect "$image_id" > "$image_inspect")
    python3 "$SCRIPT_DIR/assert_no_secret_exposure.py" \
        --service "$service" \
        --container-inspect "$container_inspect" \
        --image-inspect "$image_inspect" \
        --secret-directory "$secret_directory" \
        --secret-directory "$retired_secret_directory" \
        --secret-directory "$inspection_secret_directory"
    rm -f -- "$container_inspect" "$image_inspect"
}

assert_long_running_services_keep_secrets_out_of_metadata() {
    local service
    for service in postgres database-init backend frontend; do
        assert_service_secret_isolation "$service"
    done
}

generate_admin_hash() {
    local password=$1
    local generated
    generated=$(printf '%s' "$password" | \
        "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint python backend -c \
        'from argon2 import PasswordHasher; from argon2.low_level import Type; import sys; print(PasswordHasher(type=Type.ID).hash(sys.stdin.read()))')
    [[ "$generated" == '$argon2id$v=19$'* && "$generated" != *$'\n'* ]] || \
        fail "backend did not generate one Argon2id hash"
    printf '%s' "$generated"
}

assert_admin_password_status() {
    local password=$1
    local expected_status=$2
    printf '%s' "$password" | "${COMPOSE[@]}" exec -T backend python -c '
import json
import sys
import urllib.error
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:8000/api/v1/admin/login",
    data=json.dumps({"password": sys.stdin.read()}).encode(),
    headers={"Content-Type": "application/json", "Origin": "http://localhost"},
    method="POST",
)
try:
    response = urllib.request.urlopen(request, timeout=10)
except urllib.error.HTTPError as error:
    response = error
with response:
    response.read()
    if response.status != int(sys.argv[1]):
        sys.exit(1)
' "$expected_status"
}

assert_session_status() {
    local session_token=$1
    local expected_status=$2
    printf '%s' "$session_token" | "${COMPOSE[@]}" exec -T backend python -c '
import sys
import urllib.error
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:8000/api/v1/admin/status",
    headers={"Cookie": f"portfolio_admin_session={sys.stdin.read()}"},
)
try:
    response = urllib.request.urlopen(request, timeout=10)
except urllib.error.HTTPError as error:
    response = error
with response:
    response.read()
    if response.status != int(sys.argv[1]):
        sys.exit(1)
' "$expected_status"
}

assert_database_password_rejected() {
    local database_user=$1
    local retired_password=$2
    printf '%s' "$retired_password" | \
        "${COMPOSE[@]}" run --rm --no-deps -T \
        --env POSTGRES_USER="$database_user" --entrypoint python backend -c '
import os
import sys

import psycopg2

try:
    connection = psycopg2.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ["POSTGRES_PORT"]),
        user=os.environ["POSTGRES_USER"],
        password=sys.stdin.read(),
        dbname=os.environ["POSTGRES_DB"],
        connect_timeout=3,
    )
except psycopg2.OperationalError:
    sys.exit(0)
connection.close()
sys.exit(1)
'
}

assert_secret_projection() {
    "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint /bin/sh secret-init -euc '
        test -z "${POSTGRES_PASSWORD+x}"
        test -z "${POSTGRES_APP_PASSWORD+x}"
        test -z "${BLOG_ADMIN_PASSWORD_HASH+x}"
        test -z "${APP_SECRET_KEY+x}"
        test -z "${AI_API_KEY+x}"
        test -z "${PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE+x}"
        test -z "${PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE+x}"
        test -z "${PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE+x}"
        test -z "${PORTFOLIO_APP_SECRET_KEY_SECRET_FILE+x}"
        test -z "${PORTFOLIO_AI_API_KEY_SECRET_FILE+x}"
        if touch /rootfs-write-probe 2>/dev/null; then
            exit 1
        fi
        for source in /run/secrets/*; do
            if { printf x >> "$source"; } 2>/dev/null; then
                exit 1
            fi
        done
        cmp -s /run/secrets/postgres_password /runtime/postgres/postgres_password
        cmp -s /run/secrets/postgres_password /runtime/database-init/postgres_password
        cmp -s /run/secrets/postgres_app_password /runtime/database-init/postgres_app_password
        cmp -s /run/secrets/postgres_app_password /runtime/backend/postgres_app_password
        cmp -s /run/secrets/blog_admin_password_hash /runtime/backend/blog_admin_password_hash
        cmp -s /run/secrets/app_secret_key /runtime/backend/app_secret_key
        cmp -s /run/secrets/ai_api_key /runtime/frontend/ai_api_key
        for target in \
            /runtime/postgres/postgres_password \
            /runtime/database-init/postgres_password \
            /runtime/database-init/postgres_app_password \
            /runtime/backend/postgres_app_password \
            /runtime/backend/blog_admin_password_hash \
            /runtime/backend/app_secret_key \
            /runtime/frontend/ai_api_key; do
            test "$(stat -c %a "$target")" = 444
            test ! -e "${target}.tmp"
        done
        test ! -e /runtime/backend/blog_admin_password
        test ! -e /runtime/backend/blog_admin_password.tmp
        test ! -e /runtime/backend/postgres_password
        test ! -e /runtime/backend/postgres_password.tmp
    '
}

assert_backend_uses_secret_files() {
    "${COMPOSE[@]}" exec -T backend /bin/sh -euc '
        test -z "${POSTGRES_PASSWORD+x}"
        test -z "${BLOG_ADMIN_PASSWORD+x}"
        test -z "${BLOG_ADMIN_PASSWORD_FILE+x}"
        test -z "${BLOG_ADMIN_PASSWORD_HASH+x}"
        test -z "${ADMIN_ALLOW_LEGACY_PASSWORD+x}"
        test -z "${APP_SECRET_KEY+x}"
        test -z "${PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE+x}"
        test -z "${PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE+x}"
        test -z "${PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE+x}"
        test -z "${PORTFOLIO_APP_SECRET_KEY_SECRET_FILE+x}"
        test -z "${PORTFOLIO_AI_API_KEY_SECRET_FILE+x}"
        test "$POSTGRES_PASSWORD_FILE" = /run/secrets/postgres_app_password
        test "$BLOG_ADMIN_PASSWORD_HASH_FILE" = /run/secrets/blog_admin_password_hash
        test "$APP_SECRET_KEY_FILE" = /run/secrets/app_secret_key
        test ! -e /run/secrets/blog_admin_password
        test ! -e /run/secrets/postgres_password
    '
}

assert_database_init_uses_secret_files() {
    "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint /bin/sh database-init -euc '
        test -z "${POSTGRES_PASSWORD+x}"
        test -z "${POSTGRES_RUNTIME_PASSWORD+x}"
        test "$POSTGRES_PASSWORD_FILE" = /run/secrets/postgres_password
        test "$POSTGRES_RUNTIME_PASSWORD_FILE" = /run/secrets/postgres_app_password
        test -r /run/secrets/postgres_password
        test -r /run/secrets/postgres_app_password
        test ! -e /run/secrets/blog_admin_password_hash
        test ! -e /run/secrets/app_secret_key
    '
}

assert_runtime_database_role() {
    "${COMPOSE[@]}" run --rm --no-deps -T \
        --env PYTHONPATH=/app \
        --volume "$SCRIPT_DIR/assert_runtime_role.py:/tmp/assert_runtime_role.py:ro" \
        --entrypoint python backend /tmp/assert_runtime_role.py
}

assert_incomplete_database_returns_503() {
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
        --command 'ALTER TABLE site_content RENAME TO site_content_readiness_probe' \
        >/dev/null

    readiness_rejected=true
    if ! "${COMPOSE[@]}" exec -T backend python -c '
import json
import sys
import urllib.error
import urllib.request

try:
    response = urllib.request.urlopen("http://127.0.0.1:8000/health/ready", timeout=5)
except urllib.error.HTTPError as error:
    response = error

with response:
    body = json.loads(response.read())
    if (
        response.status != 503
        or response.headers.get("Cache-Control") != "no-store"
        or body.get("detail") != "Database is not ready"
    ):
        sys.exit(1)
'; then
        readiness_rejected=false
    fi

    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
        --command 'ALTER TABLE site_content_readiness_probe RENAME TO site_content' \
        >/dev/null
    [[ "$readiness_rejected" == true ]] || \
        fail "real PostgreSQL incomplete schema did not return readiness 503"
    "${COMPOSE[@]}" up --detach --wait --wait-timeout 60 backend >/dev/null
}

create_stale_secret_files() {
    "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint /bin/sh secret-init -euc '
        for target in \
            /runtime/postgres/postgres_password \
            /runtime/database-init/postgres_password \
            /runtime/database-init/postgres_app_password \
            /runtime/backend/postgres_app_password \
            /runtime/backend/blog_admin_password_hash \
            /runtime/backend/app_secret_key \
            /runtime/frontend/ai_api_key; do
            printf stale > "${target}.tmp"
        done
        printf legacy-plaintext-test-value > /runtime/backend/blog_admin_password
    '
}

rotate_database_password() {
    local next_password=$1
    printf '%s\n%s\n' "$next_password" "$next_password" | \
        "${COMPOSE[@]}" exec -T postgres psql \
            --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
            --command "\\password $POSTGRES_USER" >/dev/null
}

database_value() {
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
        --command \
        "SELECT payload::jsonb #>> '{personalInfo,bio}'
         FROM content_revisions
         WHERE reason = 'recovery-test'
         ORDER BY id DESC
         LIMIT 1"
}

database_head() {
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
        --command 'SELECT version_num FROM alembic_version ORDER BY version_num'
}

restore_scratch_database_count() {
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname=template1 --tuples-only --no-align \
        --command "SELECT count(*) FROM pg_database
                   WHERE datname LIKE 'portfolio_restore_%'
                      OR datname LIKE 'portfolio_rollback_%'"
}

site_content_identity() {
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
        --command "SELECT COALESCE(payload::jsonb #>> '{personalInfo,bio}', '')
                   FROM site_content WHERE id = 1"
}

write_site_content_fixture() {
    local variant=$1
    local payload
    payload=$(fixture content "$variant")
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
        --set content_payload="$payload" >/dev/null <<'SQL'
INSERT INTO site_content (id, payload, updated_at)
VALUES (1, :'content_payload'::json, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;
SQL
    unset payload
}

prepare_legacy_0001_content() {
    local payload
    payload=$(fixture content legacy)
    "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
        --set content_payload="$payload" <<'SQL'
INSERT INTO site_content (id, payload, updated_at)
VALUES (1, :'content_payload'::json, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;

INSERT INTO content_revisions (payload, reason, created_at)
VALUES (:'content_payload'::json, 'legacy-backup-test', CURRENT_TIMESTAMP);

UPDATE alembic_version SET version_num = '20260716_0001';
SQL
    unset payload
}

assert_legacy_content_was_migrated() {
    local site_status
    local revision_status
    site_status=$(
        "${COMPOSE[@]}" exec -T postgres psql \
            --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
            --command \
            "SELECT post ->> 'status'
             FROM site_content,
                  jsonb_array_elements(payload::jsonb -> 'blogPosts') AS post
             WHERE post ->> 'id' = 'legacy-post'"
    )
    revision_status=$(
        "${COMPOSE[@]}" exec -T postgres psql \
            --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
            --command \
            "SELECT post ->> 'status'
             FROM content_revisions,
                  jsonb_array_elements(payload::jsonb -> 'blogPosts') AS post
             WHERE post ->> 'id' = 'legacy-post'
             ORDER BY id DESC
             LIMIT 1"
    )
    [[ "$site_status" == "published" ]] || fail "legacy site content was not backfilled"
    [[ "$revision_status" == "published" ]] || fail "legacy revision was not backfilled"
}

write_database_value() {
    local value=$1
    local probe_value_base64

    probe_value_base64=$(printf '%s' "$value" | \
        python3 -c 'import base64, sys; sys.stdout.write(base64.b64encode(sys.stdin.buffer.read()).decode("ascii"))')
    {
        printf '%s\n' \
            'BEGIN;' \
            'CREATE TEMP TABLE recovery_probe_input (value_base64 text NOT NULL) ON COMMIT DROP;' \
            'COPY recovery_probe_input (value_base64) FROM STDIN;'
        printf '%s\n' "$probe_value_base64"
        printf '%s\n' \
            '\.' \
            'INSERT INTO content_revisions (payload, reason, created_at)' \
            "SELECT jsonb_set(site_content.payload::jsonb, '{personalInfo,bio}'," \
            "           to_jsonb(convert_from(decode(recovery_probe_input.value_base64, 'base64'), 'UTF8')))," \
            "       'recovery-test', CURRENT_TIMESTAMP" \
            'FROM recovery_probe_input CROSS JOIN site_content' \
            'WHERE site_content.id = 1;' \
            'COMMIT;'
    } | "${COMPOSE[@]}" exec -T postgres psql \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
        >/dev/null
}

fixture() {
    "${COMPOSE[@]}" run --rm --no-deps -T \
        --volume "$SCRIPT_DIR/recovery_fixture.py:/tmp/recovery_fixture.py:ro" \
        --entrypoint python backend /tmp/recovery_fixture.py "$@"
}

inject_partial_committed_media_cleanup() {
    local restore_token=$1

    "${COMPOSE[@]}" run --rm --no-deps -T \
        --entrypoint python backend -c '
import os
from pathlib import Path
import shutil
import stat
import sys

root = Path("/app/uploads")
base = root / f".portfolio-restore-{sys.argv[1]}"
stage = Path(f"{base}.stage")
rollback = Path(f"{base}.rollback")
cleanup = Path(f"{base}.cleanup-commit")

for path in (root, stage, rollback):
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise RuntimeError(f"expected a real restore directory: {path.name}")
if cleanup.exists() or cleanup.is_symlink():
    raise RuntimeError("commit cleanup tombstone already exists")

stage.rmdir()
os.replace(rollback, cleanup)
descriptor = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)

# Model SIGKILL after recursive cleanup has already removed its authority files.
(cleanup / "state.json").unlink()
shutil.rmtree(cleanup / "old")
' "$restore_token"
}

# A syntactically valid bootstrap value lets Compose build the image before the
# containerized Argon2 implementation generates the randomized test hash.
bootstrap_admin_hash='$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA' # secret-scan: allow-test-fixture
initial_database_password=$(random_secret)
initial_app_database_password=$(random_secret)
initial_admin_password=$(random_secret)
initial_app_secret=$(random_secret)
initial_ai_key=$(random_secret)
write_secret_file "$inspection_secret_directory/initial_admin_password" "$initial_admin_password"
write_secret_file "$PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE" "$initial_database_password"
write_secret_file "$PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE" "$initial_app_database_password"
write_secret_file "$PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE" "$bootstrap_admin_hash"
write_secret_file "$PORTFOLIO_APP_SECRET_KEY_SECRET_FILE" "$initial_app_secret"
write_secret_file "$PORTFOLIO_AI_API_KEY_SECRET_FILE" "$initial_ai_key"
unset bootstrap_admin_hash

printf 'Building the isolated application images...\n'
"${COMPOSE[@]}" build backend database-init frontend
admin_password_hash=$(generate_admin_hash "$initial_admin_password")
write_secret_file "$PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE" "$admin_password_hash"
unset admin_password_hash

printf 'Starting isolated PostgreSQL, backend, and frontend services...\n'
"${COMPOSE[@]}" up --detach --wait postgres backend frontend
assert_secret_projection
assert_backend_uses_secret_files
assert_database_init_uses_secret_files
assert_runtime_database_role
assert_incomplete_database_returns_503
assert_admin_password_status "$initial_admin_password" 200
old_session_token=$("${COMPOSE[@]}" exec -T backend python -c \
    'from app.core.auth import create_session_token; print(create_session_token())')
write_secret_file "$inspection_secret_directory/initial_session_token" "$old_session_token"
assert_session_status "$old_session_token" 200
assert_long_running_services_keep_secrets_out_of_metadata
deployment_log=$temporary_directory/deployment.log
"${COMPOSE[@]}" logs --no-color > "$deployment_log" 2>&1
assert_log_file_contains_no_secrets "$deployment_log"
rm -f -- "$deployment_log"

current_app_secret=$(< "$PORTFOLIO_APP_SECRET_KEY_SECRET_FILE")
write_secret_file "$PORTFOLIO_APP_SECRET_KEY_SECRET_FILE" ""
failed_init_log=$temporary_directory/failed-secret-init.log
if "${COMPOSE[@]}" run --rm --no-deps -T secret-init > "$failed_init_log" 2>&1; then
    fail "secret-init accepted an empty required secret"
fi
write_secret_file "$PORTFOLIO_APP_SECRET_KEY_SECRET_FILE" "$current_app_secret"
unset current_app_secret
assert_log_file_contains_no_secrets "$failed_init_log"
rm -f -- "$failed_init_log"
assert_secret_projection

printf 'Rotating isolated runtime secrets...\n'
create_stale_secret_files
cp "$PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE" "$retired_secret_directory/postgres_password"
cp "$PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE" "$retired_secret_directory/postgres_app_password"
cp "$PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE" "$retired_secret_directory/blog_admin_password_hash"
cp "$PORTFOLIO_APP_SECRET_KEY_SECRET_FILE" "$retired_secret_directory/app_secret_key"
cp "$PORTFOLIO_AI_API_KEY_SECRET_FILE" "$retired_secret_directory/ai_api_key"
chmod 0600 "$retired_secret_directory"/*
"${COMPOSE[@]}" stop backend >/dev/null
next_database_password=$(random_secret)
rotate_database_password "$next_database_password"
write_secret_file "$PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE" "$next_database_password"
unset next_database_password
next_app_database_password=$(random_secret)
write_secret_file "$PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE" "$next_app_database_password"
unset next_app_database_password
next_admin_password=$(random_secret)
write_secret_file "$inspection_secret_directory/next_admin_password" "$next_admin_password"
admin_password_hash=$(generate_admin_hash "$next_admin_password")
write_secret_file "$PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE" "$admin_password_hash"
unset admin_password_hash
write_secret_file "$PORTFOLIO_APP_SECRET_KEY_SECRET_FILE" "$(random_secret)"
write_secret_file "$PORTFOLIO_AI_API_KEY_SECRET_FILE" "$(random_secret)"
"${COMPOSE[@]}" run --rm --no-deps -T secret-init
assert_secret_projection
"${COMPOSE[@]}" run --rm --no-deps -T database-init
"${COMPOSE[@]}" up --detach --wait --force-recreate postgres backend frontend
assert_secret_projection
assert_backend_uses_secret_files
assert_database_init_uses_secret_files
assert_runtime_database_role
assert_database_password_rejected "$POSTGRES_USER" "$initial_database_password"
assert_database_password_rejected "$POSTGRES_APP_USER" "$initial_app_database_password"
assert_admin_password_status "$next_admin_password" 200
assert_admin_password_status "$initial_admin_password" 401
assert_session_status "$old_session_token" 401
assert_long_running_services_keep_secrets_out_of_metadata
rotation_log=$temporary_directory/rotation.log
"${COMPOSE[@]}" logs --no-color > "$rotation_log" 2>&1
assert_log_file_contains_no_secrets "$rotation_log"
rm -f -- "$rotation_log"
unset initial_database_password initial_app_database_password initial_admin_password initial_app_secret initial_ai_key
unset next_admin_password old_session_token

write_site_content_fixture current
parameter_binding_probe=$'quote \' backslash \\ ; DROP TABLE recovery_probe; --\nsecond line'
write_database_value "$parameter_binding_probe"
[[ "$(database_value)" == "$parameter_binding_probe" ]] || \
    fail "database probe value was not safely parameterized"
unset parameter_binding_probe
write_database_value backup-value
fixture write large-backup
expected_large_snapshot=$(fixture snapshot)

mkdir -p "$temporary_directory/backups"
"$ROOT_DIR/scripts/backup.sh" --output "$temporary_directory/backups"
backup_dir=$(find "$temporary_directory/backups" -mindepth 1 -maxdepth 1 -type d -name 'portfolio-backup-*' -print -quit)
[[ -n "$backup_dir" ]] || fail "backup directory was not created"
grep -qx 'format_version=3' "$backup_dir/manifest.txt" || fail "backup did not use signed manifest v3"
grep -qx 'signature_format_version=1' "$backup_dir/manifest.txt" || \
    fail "backup did not record the signature format"
grep -qx 'signature_algorithm=rsa-pss-sha256-mgf1-sha256-saltlen32' \
    "$backup_dir/manifest.txt" || fail "backup did not record the signature algorithm"
[[ -s "$backup_dir/SHA256SUMS.sig" ]] || fail "backup signature is missing"
grep -qx 'application_id=personal-portfolio' "$backup_dir/manifest.txt" || \
    fail "backup did not record the application identity"
grep -qx 'application_alembic_head=20260717_0002' "$backup_dir/manifest.txt" || \
    fail "backup did not record the application Alembic head"
grep -qx 'database_alembic_head=20260717_0002' "$backup_dir/manifest.txt" || \
    fail "backup did not record the database Alembic head"
uploads_bytes=$(awk -F= '$1 == "uploads_bytes" { print $2 }' "$backup_dir/manifest.txt")
((uploads_bytes > 70 * 1024 * 1024)) || fail "integration backup is not larger than 70 MiB"
grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
    fail "backup did not restore the running backend state"

write_database_value mutated-value
fixture write mutated
"$ROOT_DIR/scripts/restore.sh" --backup "$backup_dir" --yes
[[ "$(database_value)" == "backup-value" ]] || fail "database did not round-trip"
[[ "$(fixture snapshot)" == "$expected_large_snapshot" ]] || fail "large media set did not round-trip"

printf 'Creating and restoring a real revision 0001 backup through revision 0002...\n'
write_database_value legacy-backup-value
fixture write mutated
"${COMPOSE[@]}" stop backend >/dev/null
prepare_legacy_0001_content
[[ "$(database_head)" == "20260716_0001" ]] || fail "legacy fixture did not reach revision 0001"
mkdir -p "$temporary_directory/legacy-backups"
"$ROOT_DIR/scripts/backup.sh" --output "$temporary_directory/legacy-backups"
legacy_backup_dir=$(
    find "$temporary_directory/legacy-backups" -mindepth 1 -maxdepth 1 \
        -type d -name 'portfolio-backup-*' -print -quit
)
[[ -n "$legacy_backup_dir" ]] || fail "legacy backup directory was not created"
grep -qx 'application_alembic_head=20260717_0002' "$legacy_backup_dir/manifest.txt" || \
    fail "legacy backup did not record the current application head"
grep -qx 'database_alembic_head=20260716_0001' "$legacy_backup_dir/manifest.txt" || \
    fail "legacy backup did not record revision 0001"

# A backup preserves a stopped backend and never runs deployment migrations.
# Return the independent live test database to the current head explicitly.
[[ -z "$("${COMPOSE[@]}" ps --status running --quiet backend)" ]] || \
    fail "legacy backup did not preserve the stopped backend state"
"${COMPOSE[@]}" run --rm --no-deps -T database-init
"${COMPOSE[@]}" up --detach --no-deps --wait backend
[[ "$(database_head)" == "20260717_0002" ]] || fail "live database did not return to current head"
write_database_value live-before-legacy-restore
"$ROOT_DIR/scripts/restore.sh" --backup "$legacy_backup_dir" --yes
[[ "$(database_value)" == "legacy-backup-value" ]] || \
    fail "cross-version database contents did not round-trip"
[[ "$(database_head)" == "20260717_0002" ]] || \
    fail "restored revision 0001 database was not upgraded to revision 0002"
assert_legacy_content_was_migrated

printf 'Rejecting malformed staged CMS content before activation...\n'
write_database_value malformed-backup-value
write_site_content_fixture malformed
fixture write mutated
mkdir -p "$temporary_directory/malformed-backups"
"$ROOT_DIR/scripts/backup.sh" --output "$temporary_directory/malformed-backups"
malformed_backup_dir=$(
    find "$temporary_directory/malformed-backups" -mindepth 1 -maxdepth 1 \
        -type d -name 'portfolio-backup-*' -print -quit
)
[[ -n "$malformed_backup_dir" ]] || fail "malformed backup directory was not created"

write_site_content_fixture current
write_database_value semantic-current-must-survive
fixture write failure-current
semantic_failure_snapshot=$(fixture snapshot)
[[ "$(database_value)" == "semantic-current-must-survive" ]] || \
    fail "semantic rejection active database fixture was not initialized"
semantic_restore_log=$temporary_directory/semantic-restore.log
if "$ROOT_DIR/scripts/restore.sh" --backup "$malformed_backup_dir" --yes \
    > "$semantic_restore_log" 2>&1; then
    fail "restore accepted malformed staged CMS content"
fi
grep -q 'site content does not match the current application contract' \
    "$semantic_restore_log" || fail "semantic restore rejection was not reported"
if grep -q 'semantic-private-content-must-not-leak' "$semantic_restore_log"; then
    fail "semantic restore rejection leaked staged CMS content"
fi
assert_log_file_contains_no_secrets "$semantic_restore_log"
if grep -Eq 'Stopping backend writes|Activating staged uploaded media|Switching to' \
    "$semantic_restore_log"; then
    fail "semantic restore rejection reached activation work"
fi
[[ "$(database_value)" == "semantic-current-must-survive" ]] || \
    fail "semantic restore rejection changed the active database"
[[ "$(site_content_identity)" == "recovery-current" ]] || \
    fail "semantic restore rejection changed active site content"
[[ "$(fixture snapshot)" == "$semantic_failure_snapshot" ]] || \
    fail "semantic restore rejection changed active media"
grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
    fail "semantic restore rejection stopped the active backend"
rm -f -- "$semantic_restore_log"

printf 'Rejecting forged staged media before stopping backend writes...\n'
invalid_media_backup_dir=$temporary_directory/invalid-media-backup
cp -R "$backup_dir" "$invalid_media_backup_dir"
python3 "$SCRIPT_DIR/recovery_fixture.py" \
    corrupt-backup-media "$invalid_media_backup_dir" \
    --private-key "$PORTFOLIO_BACKUP_PRIVATE_KEY_FILE"
write_database_value invalid-media-current-must-survive
write_site_content_fixture current
fixture write failure-current
invalid_media_snapshot=$(fixture snapshot)
invalid_media_restore_log=$temporary_directory/invalid-media-restore.log
if "$ROOT_DIR/scripts/restore.sh" --backup "$invalid_media_backup_dir" --yes \
    > "$invalid_media_restore_log" 2>&1; then
    fail "restore accepted forged staged media"
fi
grep -q 'staged uploaded media set is invalid' "$invalid_media_restore_log" || \
    fail "forged staged media rejection was not reported"
assert_log_file_contains_no_secrets "$invalid_media_restore_log"
if grep -Eq 'Stopping backend writes|Activating staged uploaded media|Switching to' \
    "$invalid_media_restore_log"; then
    fail "forged staged media rejection reached activation work"
fi
[[ "$(database_value)" == "invalid-media-current-must-survive" ]] || \
    fail "forged staged media rejection changed the active database"
[[ "$(site_content_identity)" == "recovery-current" ]] || \
    fail "forged staged media rejection changed active site content"
[[ "$(fixture snapshot)" == "$invalid_media_snapshot" ]] || \
    fail "forged staged media rejection changed active media"
[[ "$(restore_scratch_database_count)" == 0 ]] || \
    fail "forged staged media rejection left a scratch database"
grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
    fail "forged staged media rejection stopped the active backend"
rm -f -- "$invalid_media_restore_log"

for failure_point in \
    after_media_stage \
    after_media_activate \
    after_live_database_rename \
    after_database_restore \
    after_backend_validation; do
    printf 'Injecting isolated restore failure at %s...\n' "$failure_point"
    "${COMPOSE[@]}" up --detach --wait backend
    write_database_value "must-survive-$failure_point"
    write_site_content_fixture "$failure_point"
    fixture write failure-current
    failure_snapshot=$(fixture snapshot)
    failure_restore_log=$temporary_directory/restore-$failure_point.log

    if PORTFOLIO_RESTORE_TESTING=true \
        PORTFOLIO_RESTORE_TEST_FAIL_AT="$failure_point" \
        "$ROOT_DIR/scripts/restore.sh" --backup "$backup_dir" --yes \
        > "$failure_restore_log" 2>&1; then
        fail "injected restore failure unexpectedly succeeded at $failure_point"
    fi
    grep -q "injected isolated recovery test failure at $failure_point" \
        "$failure_restore_log" || fail "injected failure was not observed at $failure_point"
    assert_log_file_contains_no_secrets "$failure_restore_log"
    [[ "$(database_value)" == "must-survive-$failure_point" ]] || \
        fail "database rollback did not preserve data at $failure_point"
    [[ "$(site_content_identity)" == "recovery-$failure_point" ]] || \
        fail "site content rollback did not preserve data at $failure_point"
    [[ "$(fixture snapshot)" == "$failure_snapshot" ]] || \
        fail "media rollback did not preserve data at $failure_point"
    [[ "$(restore_scratch_database_count)" == 0 ]] || \
        fail "restore left a scratch database at $failure_point"

    grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
        fail "backend did not return to service after rollback at $failure_point"
    rm -f -- "$failure_restore_log"
done

printf 'Recovering an ordinary failure after the durable commit decision...\n'
"${COMPOSE[@]}" up --detach --wait backend
write_database_value must-be-replaced-after-ordinary-commit
fixture write failure-current
commit_failure_log=$temporary_directory/restore-failure-after-commit.log
if PORTFOLIO_RESTORE_TESTING=true \
    PORTFOLIO_RESTORE_TEST_FAIL_AT=after_commit_started \
    "$ROOT_DIR/scripts/restore.sh" --backup "$backup_dir" --yes \
    > "$commit_failure_log" 2>&1; then
    fail "restore unexpectedly survived ordinary failure after commit started"
fi
[[ -f "$PORTFOLIO_RESTORE_STATE_DIR/$project_name.restore.json" ]] || \
    fail "ordinary committed failure did not retain a recovery journal"
"$ROOT_DIR/scripts/restore.sh" --recover >> "$commit_failure_log" 2>&1
assert_log_file_contains_no_secrets "$commit_failure_log"
[[ "$(database_value)" == "backup-value" ]] || \
    fail "ordinary committed failure recovery did not retain restored database"
[[ "$(fixture snapshot)" == "$expected_large_snapshot" ]] || \
    fail "ordinary committed failure recovery did not retain restored media"
grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
    fail "backend did not return after ordinary committed failure recovery"
rm -f -- "$commit_failure_log"

for kill_point in \
    after_media_activate \
    after_live_database_rename \
    after_database_restore \
    after_backend_validation; do
    printf 'Recovering an isolated SIGKILL at %s...\n' "$kill_point"
    "${COMPOSE[@]}" up --detach --wait backend
    write_database_value "must-survive-kill-$kill_point"
    write_site_content_fixture "$kill_point"
    fixture write failure-current
    kill_snapshot=$(fixture snapshot)
    kill_restore_log=$temporary_directory/restore-kill-$kill_point.log

    if PORTFOLIO_RESTORE_TESTING=true \
        PORTFOLIO_RESTORE_TEST_KILL_AT="$kill_point" \
        "$ROOT_DIR/scripts/restore.sh" --backup "$backup_dir" --yes \
        > "$kill_restore_log" 2>&1; then
        fail "SIGKILL restore unexpectedly succeeded at $kill_point"
    fi
    grep -q "injecting isolated recovery test SIGKILL at $kill_point" \
        "$kill_restore_log" || fail "SIGKILL was not observed at $kill_point"
    [[ -f "$PORTFOLIO_RESTORE_STATE_DIR/$project_name.restore.json" ]] || \
        fail "SIGKILL did not retain a recovery journal at $kill_point"

    "$ROOT_DIR/scripts/restore.sh" --recover >> "$kill_restore_log" 2>&1
    "$ROOT_DIR/scripts/restore.sh" --recover >> "$kill_restore_log" 2>&1
    assert_log_file_contains_no_secrets "$kill_restore_log"
    [[ "$(database_value)" == "must-survive-kill-$kill_point" ]] || \
        fail "SIGKILL recovery did not preserve the database at $kill_point"
    [[ "$(site_content_identity)" == "recovery-$kill_point" ]] || \
        fail "SIGKILL recovery did not preserve site content at $kill_point"
    [[ "$(fixture snapshot)" == "$kill_snapshot" ]] || \
        fail "SIGKILL recovery did not preserve media at $kill_point"
    [[ "$(restore_scratch_database_count)" == 0 ]] || \
        fail "SIGKILL recovery left a scratch database at $kill_point"
    [[ ! -e "$PORTFOLIO_RESTORE_STATE_DIR/$project_name.restore.json" ]] || \
        fail "SIGKILL recovery left its journal at $kill_point"
    grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
        fail "backend did not return after SIGKILL recovery at $kill_point"
    rm -f -- "$kill_restore_log"
done

printf 'Finishing an already committed restore after SIGKILL...\n'
"${COMPOSE[@]}" up --detach --wait backend
write_database_value must-be-replaced-after-commit
fixture write failure-current
commit_kill_log=$temporary_directory/restore-kill-after-commit.log
if PORTFOLIO_RESTORE_TESTING=true \
    PORTFOLIO_RESTORE_TEST_KILL_AT=after_commit_started \
    "$ROOT_DIR/scripts/restore.sh" --backup "$backup_dir" --yes \
    > "$commit_kill_log" 2>&1; then
    fail "restore unexpectedly survived SIGKILL after commit started"
fi
[[ -f "$PORTFOLIO_RESTORE_STATE_DIR/$project_name.restore.json" ]] || \
    fail "committed SIGKILL did not retain a recovery journal"
commit_journal_record=$(python3 "$ROOT_DIR/scripts/restore_journal.py" \
    --file "$PORTFOLIO_RESTORE_STATE_DIR/$project_name.restore.json" \
    --project "$project_name" read)
IFS=$'\t' read -r \
    commit_restore_token \
    _ \
    _ \
    commit_restore_phase \
    _ \
    <<< "$commit_journal_record"
[[ "$commit_restore_phase" == commit_started ]] || \
    fail "committed SIGKILL journal did not retain the commit decision"
printf 'Injecting a partial committed-media cleanup after tombstone publication...\n'
inject_partial_committed_media_cleanup "$commit_restore_token"
unset \
    commit_journal_record \
    commit_restore_token \
    commit_restore_phase
"$ROOT_DIR/scripts/restore.sh" --recover >> "$commit_kill_log" 2>&1
"$ROOT_DIR/scripts/restore.sh" --recover >> "$commit_kill_log" 2>&1
assert_log_file_contains_no_secrets "$commit_kill_log"
[[ "$(database_value)" == "backup-value" ]] || \
    fail "committed SIGKILL recovery did not retain the restored database"
[[ "$(fixture snapshot)" == "$expected_large_snapshot" ]] || \
    fail "committed SIGKILL recovery did not retain the restored media"
[[ "$(restore_scratch_database_count)" == 0 ]] || \
    fail "committed SIGKILL recovery left a scratch database"
[[ ! -e "$PORTFOLIO_RESTORE_STATE_DIR/$project_name.restore.json" ]] || \
    fail "committed SIGKILL recovery left its journal"
grep -qx backend <<< "$("${COMPOSE[@]}" ps --status running --services)" || \
    fail "backend did not return after committed SIGKILL recovery"
rm -f -- "$commit_kill_log"

printf 'Recovery integration test passed for project %s\n' "$project_name"
