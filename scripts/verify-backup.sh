#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/verify-backup.sh --backup DIRECTORY [--public-key FILE ...]
       scripts/verify-backup.sh --backup DIRECTORY --allow-unsigned-legacy

Validates an independently signed v3 backup, strict manifest and checksums, the
complete PostgreSQL custom-dump object policy, and every uploads archive member.
Public keys can be repeated or supplied as a colon-separated list in
PORTFOLIO_BACKUP_PUBLIC_KEY_FILES. Unsigned v1/v2 backups are rejected unless
--allow-unsigned-legacy is explicitly supplied.
EOF
}

fail() {
    printf 'verify-backup: %s\n' "$*" >&2
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

manifest_value() {
    local key=$1
    local count
    count=$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$backup_dir/manifest.txt")
    [[ "$count" == "1" ]] || fail "manifest key must appear exactly once: $key"
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print }' "$backup_dir/manifest.txt"
}

validate_manifest_lines() {
    awk '
        !/^[a-z][a-z0-9_]*=[^[:cntrl:]]*$/ { exit 1 }
        {
            key = $0
            sub(/=.*/, "", key)
            if (seen[key]++) { exit 1 }
        }
    ' "$backup_dir/manifest.txt" || \
        fail "manifest contains a malformed line or duplicate key"
}

validate_manifest_keys() {
    local format_version=$1
    local key
    while IFS='=' read -r key _; do
        case "$format_version:$key" in
            1:format_version|1:created_at_utc|1:database_format|1:database_bytes|1:uploads_format|1:uploads_bytes) ;;
            2:format_version|2:created_at_utc|2:application_id|2:application_backup_compatibility|2:application_alembic_head|2:database_format|2:database_alembic_head|2:database_bytes|2:uploads_format|2:uploads_bytes) ;;
            3:format_version|3:created_at_utc|3:application_id|3:application_backup_compatibility|3:application_alembic_head|3:signature_format_version|3:signature_algorithm|3:signature_key_id|3:database_format|3:database_alembic_head|3:database_bytes|3:uploads_format|3:uploads_bytes) ;;
            *) fail "manifest contains an unsupported key for format $format_version: $key" ;;
        esac
    done < "$backup_dir/manifest.txt"
}

valid_revision() {
    [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]
}

backup_dir=""
allow_unsigned_legacy=false
public_keys=()
key_forbidden_roots=()
while (($#)); do
    case "$1" in
        --backup)
            (($# >= 2)) || fail "--backup requires a directory"
            backup_dir=$2
            shift 2
            ;;
        --public-key)
            (($# >= 2)) || fail "--public-key requires a file"
            [[ -n "$2" ]] || fail "--public-key must not be empty"
            public_keys+=("$2")
            shift 2
            ;;
        --forbid-key-root)
            (($# >= 2)) || fail "--forbid-key-root requires a directory"
            [[ -n "$2" ]] || fail "--forbid-key-root must not be empty"
            key_forbidden_roots+=("$2")
            shift 2
            ;;
        --allow-unsigned-legacy)
            allow_unsigned_legacy=true
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

[[ -n "$backup_dir" ]] || fail "--backup is required"
[[ -d "$backup_dir" ]] || fail "backup directory not found: $backup_dir"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
backup_dir=$(cd -- "$backup_dir" && pwd)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

if [[ -n "${PORTFOLIO_BACKUP_PUBLIC_KEY_FILES+x}" ]]; then
    [[ -n "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILES" ]] || \
        fail "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES must not be empty"
    [[ "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILES" != :* && \
        "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILES" != *: && \
        "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILES" != *::* ]] || \
        fail "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES contains an empty path"
    IFS=':' read -r -a configured_public_keys <<< "$PORTFOLIO_BACKUP_PUBLIC_KEY_FILES"
    for public_key in "${configured_public_keys[@]}"; do
        [[ -n "$public_key" ]] || \
            fail "PORTFOLIO_BACKUP_PUBLIC_KEY_FILES contains an empty path"
        public_keys+=("$public_key")
    done
fi

for file in database.dump uploads.tar manifest.txt SHA256SUMS; do
    [[ -f "$backup_dir/$file" ]] || fail "required file is missing: $file"
done

validate_manifest_lines
format_version=$(manifest_value format_version)
[[ "$format_version" == "1" || "$format_version" == "2" || "$format_version" == "3" ]] || \
    fail "unsupported or missing backup format version"
validate_manifest_keys "$format_version"
created_at=$(manifest_value created_at_utc)
[[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || \
    fail "manifest has an invalid created_at_utc value"

if [[ "$format_version" == "2" || "$format_version" == "3" ]]; then
    [[ "$(manifest_value application_id)" == "personal-portfolio" ]] || \
        fail "manifest belongs to a different application"
    [[ "$(manifest_value application_backup_compatibility)" == "1" ]] || \
        fail "manifest has an unsupported application backup compatibility version"
    application_alembic_head=$(manifest_value application_alembic_head)
    database_alembic_head=$(manifest_value database_alembic_head)
    valid_revision "$application_alembic_head" || \
        fail "manifest application_alembic_head is invalid"
    valid_revision "$database_alembic_head" || \
        fail "manifest database_alembic_head is invalid"
fi

if [[ "$format_version" == "3" ]]; then
    [[ "$(manifest_value signature_format_version)" == "1" ]] || \
        fail "manifest has an unsupported signature format version"
    [[ "$(manifest_value signature_algorithm)" == \
        "rsa-pss-sha256-mgf1-sha256-saltlen32" ]] || \
        fail "manifest has an unsupported signature algorithm"
    signature_key_id=$(manifest_value signature_key_id)
    [[ -f "$backup_dir/SHA256SUMS.sig" ]] || \
        fail "required v3 signature is missing: SHA256SUMS.sig"
    signature_arguments=()
    ((${#public_keys[@]} > 0)) || \
        fail "v3 backup verification requires an independent public key"
    for public_key in "${public_keys[@]}"; do
        signature_arguments+=(--public-key "$public_key")
    done
    if ((${#key_forbidden_roots[@]} > 0)); then
        for forbidden_root in "${key_forbidden_roots[@]}"; do
            signature_arguments+=(--forbid-root "$forbidden_root")
        done
    fi
    python3 "$SCRIPT_DIR/backup_signature.py" verify \
        --checksums "$backup_dir/SHA256SUMS" \
        --signature "$backup_dir/SHA256SUMS.sig" \
        --expected-key-id "$signature_key_id" \
        --forbid-root "$ROOT_DIR" \
        --forbid-root "$backup_dir" \
        "${signature_arguments[@]}" || \
        fail "v3 backup signature is invalid or untrusted"
else
    [[ "$allow_unsigned_legacy" == true ]] || \
        fail "unsigned legacy format v$format_version is rejected by default; pass --allow-unsigned-legacy only for isolated legacy inspection"
    [[ ! -e "$backup_dir/SHA256SUMS.sig" && ! -L "$backup_dir/SHA256SUMS.sig" ]] || \
        fail "unsigned legacy backups must not contain a v3 signature sidecar"
    printf 'verify-backup: warning: explicitly allowing unsigned legacy format v%s\n' \
        "$format_version" >&2
fi

[[ "$(manifest_value database_format)" == "postgresql_custom" ]] || \
    fail "manifest has an unsupported database format"
[[ "$(manifest_value uploads_format)" == "tar" ]] || \
    fail "manifest has an unsupported uploads format"

database_bytes=$(manifest_value database_bytes)
uploads_bytes=$(manifest_value uploads_bytes)
[[ "$database_bytes" =~ ^[0-9]+$ ]] || fail "manifest database_bytes is invalid"
[[ "$uploads_bytes" =~ ^[0-9]+$ ]] || fail "manifest uploads_bytes is invalid"
actual_database_bytes=$(wc -c < "$backup_dir/database.dump" | tr -d '[:space:]')
actual_uploads_bytes=$(wc -c < "$backup_dir/uploads.tar" | tr -d '[:space:]')
[[ "$actual_database_bytes" == "$database_bytes" ]] || fail "manifest size mismatch for database.dump"
[[ "$actual_uploads_bytes" == "$uploads_bytes" ]] || fail "manifest size mismatch for uploads.tar"

checksum_line_count=0
expected_files=(database.dump uploads.tar manifest.txt)
while IFS= read -r checksum_line; do
    ((checksum_line_count += 1))
    ((checksum_line_count <= ${#expected_files[@]})) || \
        fail "SHA256SUMS must contain exactly three canonical entries"
    file=${expected_files[$((checksum_line_count - 1))]}
    [[ "$checksum_line" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9._-]+)$ ]] || \
        fail "SHA256SUMS contains a non-canonical entry for $file"
    [[ "${BASH_REMATCH[2]}" == "$file" ]] || \
        fail "SHA256SUMS entries are missing, reordered, or unexpected"
    expected=${BASH_REMATCH[1]}
    actual=$(sha256_file "$backup_dir/$file")
    [[ "$actual" == "$expected" ]] || fail "checksum mismatch for $file"
done < "$backup_dir/SHA256SUMS"

[[ "$checksum_line_count" == "3" ]] || \
    fail "SHA256SUMS must contain exactly three canonical entries"
checksum_final_newline_count=$(tail -c 1 "$backup_dir/SHA256SUMS" | wc -l | tr -d '[:space:]')
[[ "$checksum_final_newline_count" == "1" ]] || \
    fail "SHA256SUMS must end with exactly one LF-delimited entry"

magic=$(LC_ALL=C dd if="$backup_dir/database.dump" bs=5 count=1 2>/dev/null)
[[ "$magic" == "PGDMP" ]] || fail "database.dump is not a PostgreSQL custom-format dump"

if command -v pg_restore >/dev/null 2>&1; then
    if ! pg_restore --list "$backup_dir/database.dump" | \
        python3 "$SCRIPT_DIR/restore_toc_policy.py" \
            --format-version "$format_version"; then
        fail "database.dump failed PostgreSQL object policy validation"
    fi
else
    command -v docker >/dev/null 2>&1 || fail "pg_restore or docker is required"
    docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required"
    COMPOSE=(docker compose)
    if [[ -n "${PORTFOLIO_COMPOSE_PROJECT_NAME:-}" ]]; then
        COMPOSE+=(--project-name "$PORTFOLIO_COMPOSE_PROJECT_NAME")
    fi
    COMPOSE+=(--project-directory "$ROOT_DIR" --file "$ROOT_DIR/docker-compose.yml")
    if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list \
        < "$backup_dir/database.dump" | \
        python3 "$SCRIPT_DIR/restore_toc_policy.py" \
            --format-version "$format_version"; then
        fail "database.dump failed PostgreSQL object policy validation"
    fi
fi

python3 "$SCRIPT_DIR/restore_uploads.py" validate --archive "$backup_dir/uploads.tar" || \
    fail "uploads.tar contains invalid or unreadable media entries"

if [[ "$format_version" == "1" ]]; then
    printf '%s\n' \
        'verify-backup: warning: legacy format v1 has no application or Alembic compatibility metadata' >&2
fi

printf 'Backup verified: %s\n' "$backup_dir"
