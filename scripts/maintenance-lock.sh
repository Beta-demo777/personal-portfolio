#!/usr/bin/env bash

# Shared host-side lock for maintenance operations that touch one Compose project.

PORTFOLIO_MAINTENANCE_LOCK_MODE=""
PORTFOLIO_MAINTENANCE_LOCK_FILE=""
PORTFOLIO_MAINTENANCE_LOCK_FD=""

portfolio_compose_project_name() {
    printf '%s\n' "${PORTFOLIO_COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-portfolio}}"
}

portfolio_maintenance_lock_usage() {
    cat <<'EOF'
Usage: scripts/maintenance-lock.sh [--project-name NAME] --operation NAME -- COMMAND [ARG ...]

Runs one manual maintenance command while holding the same non-blocking,
host-side project lock used by backup.sh and restore.sh. Use this wrapper for
multi-step secret rotation by launching a dedicated shell as COMMAND.
EOF
}

portfolio_maintenance_lock_directory() {
    if [[ -n "${PORTFOLIO_MAINTENANCE_LOCK_DIR:-}" ]]; then
        [[ "$PORTFOLIO_MAINTENANCE_LOCK_DIR" == /* ]] || {
            printf '%s\n' \
                'maintenance-lock: PORTFOLIO_MAINTENANCE_LOCK_DIR must be absolute' >&2
            return 64
        }
        printf '%s\n' "$PORTFOLIO_MAINTENANCE_LOCK_DIR"
        return 0
    fi

    # /var/tmp survives ordinary host reboots, so interrupted-restore journals
    # stored beside the lock remain available to an explicit --recover.
    printf '/var/tmp/portfolio-maintenance-%s\n' "$(id -u)"
}

portfolio_maintenance_lock_owner() {
    local lock_directory=$1
    local lock_owner

    # GNU and BSD stat use different format flags. Try the GNU spelling first
    # and only accept a single numeric UID; on BSD it fails cleanly and the
    # fallback below selects the native format.
    if lock_owner=$(stat -c '%u' "$lock_directory" 2>/dev/null) && \
        [[ "$lock_owner" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$lock_owner"
        return 0
    fi
    if lock_owner=$(stat -f '%u' "$lock_directory" 2>/dev/null) && \
        [[ "$lock_owner" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$lock_owner"
        return 0
    fi
    return 1
}

portfolio_maintenance_lock_acquire() {
    local project_name=$1
    local operation=$2
    local lock_directory
    local lock_file
    local lock_fd
    local lock_owner
    local current_uid

    if [[ -n "$PORTFOLIO_MAINTENANCE_LOCK_MODE" ]]; then
        printf '%s\n' 'maintenance-lock: this process already holds a maintenance lock' >&2
        return 70
    fi
    if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
        printf 'maintenance-lock: invalid Compose project name: %s\n' "$project_name" >&2
        return 64
    fi
    if [[ ! "$operation" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
        printf 'maintenance-lock: invalid operation name: %s\n' "$operation" >&2
        return 64
    fi

    lock_directory=$(portfolio_maintenance_lock_directory) || return $?
    umask 077
    mkdir -p -- "$lock_directory" || {
        printf 'maintenance-lock: lock directory could not be created: %s\n' \
            "$lock_directory" >&2
        return 73
    }
    if [[ ! -d "$lock_directory" || -L "$lock_directory" ]]; then
        printf 'maintenance-lock: lock directory must be a real directory: %s\n' \
            "$lock_directory" >&2
        return 73
    fi
    current_uid=$(id -u)
    if ! lock_owner=$(portfolio_maintenance_lock_owner "$lock_directory"); then
        printf 'maintenance-lock: lock directory ownership could not be checked: %s\n' \
            "$lock_directory" >&2
        return 73
    fi
    if [[ "$lock_owner" != "$current_uid" ]]; then
        printf 'maintenance-lock: lock directory is not owned by the current user: %s\n' \
            "$lock_directory" >&2
        return 73
    fi
    chmod 0700 "$lock_directory" || {
        printf 'maintenance-lock: lock directory permissions could not be secured: %s\n' \
            "$lock_directory" >&2
        return 73
    }
    lock_file="$lock_directory/$project_name.lock"

    if command -v flock >/dev/null 2>&1; then
        exec {lock_fd}>> "$lock_file"
        if ! flock --nonblock "$lock_fd"; then
            exec {lock_fd}>&-
            printf "maintenance-lock: another maintenance operation is already running for Compose project '%s'; %s did not start\n" \
                "$project_name" "$operation" >&2
            return 75
        fi
        PORTFOLIO_MAINTENANCE_LOCK_MODE=flock
        PORTFOLIO_MAINTENANCE_LOCK_FD=$lock_fd
    elif command -v shlock >/dev/null 2>&1; then
        if ! shlock -f "$lock_file" -p "$$"; then
            printf "maintenance-lock: another maintenance operation is already running for Compose project '%s'; %s did not start\n" \
                "$project_name" "$operation" >&2
            return 75
        fi
        PORTFOLIO_MAINTENANCE_LOCK_MODE=shlock
    else
        printf '%s\n' \
            'maintenance-lock: flock (Linux) or shlock (macOS/BSD) is required' >&2
        return 69
    fi

    PORTFOLIO_MAINTENANCE_LOCK_FILE=$lock_file
}

portfolio_maintenance_lock_release() {
    local recorded_pid

    case "$PORTFOLIO_MAINTENANCE_LOCK_MODE" in
        flock)
            if [[ -n "$PORTFOLIO_MAINTENANCE_LOCK_FD" ]]; then
                flock --unlock "$PORTFOLIO_MAINTENANCE_LOCK_FD" >/dev/null 2>&1 || true
                exec {PORTFOLIO_MAINTENANCE_LOCK_FD}>&-
            fi
            ;;
        shlock)
            if [[ -f "$PORTFOLIO_MAINTENANCE_LOCK_FILE" ]]; then
                recorded_pid=$(< "$PORTFOLIO_MAINTENANCE_LOCK_FILE")
                if [[ "$recorded_pid" == "$$" ]]; then
                    rm -f -- "$PORTFOLIO_MAINTENANCE_LOCK_FILE"
                fi
            fi
            ;;
    esac

    PORTFOLIO_MAINTENANCE_LOCK_MODE=""
    PORTFOLIO_MAINTENANCE_LOCK_FILE=""
    PORTFOLIO_MAINTENANCE_LOCK_FD=""
}

portfolio_maintenance_lock_main() {
    local project_name
    local operation="manual"

    project_name=$(portfolio_compose_project_name)
    while (($#)); do
        case "$1" in
            --project-name)
                (($# >= 2)) || {
                    printf '%s\n' 'maintenance-lock: --project-name requires a value' >&2
                    return 64
                }
                project_name=$2
                shift 2
                ;;
            --operation)
                (($# >= 2)) || {
                    printf '%s\n' 'maintenance-lock: --operation requires a value' >&2
                    return 64
                }
                operation=$2
                shift 2
                ;;
            --)
                shift
                break
                ;;
            -h|--help)
                portfolio_maintenance_lock_usage
                return 0
                ;;
            *)
                printf 'maintenance-lock: unknown argument: %s\n' "$1" >&2
                return 64
                ;;
        esac
    done
    (($# > 0)) || {
        printf '%s\n' 'maintenance-lock: COMMAND is required' >&2
        return 64
    }

    portfolio_maintenance_lock_acquire "$project_name" "$operation" || return $?
    export COMPOSE_PROJECT_NAME=$project_name
    export PORTFOLIO_COMPOSE_PROJECT_NAME=$project_name
    trap portfolio_maintenance_lock_release EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    set -Eeuo pipefail
    portfolio_maintenance_lock_main "$@"
fi
