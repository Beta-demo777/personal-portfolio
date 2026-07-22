#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/deploy.sh

Builds and deploys the portfolio Compose application while holding the shared
project maintenance lock. The backend remains stopped if secret initialization,
PostgreSQL readiness, or the database migration fails.
EOF
}

fail() {
    printf 'deploy: %s\n' "$*" >&2
    exit 1
}

while (($#)); do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=maintenance-lock.sh
source "$SCRIPT_DIR/maintenance-lock.sh"
compose_project_name=$(portfolio_compose_project_name)
portfolio_maintenance_lock_acquire "$compose_project_name" deploy || exit $?

backend_stopped=false
application_start_attempted=false
application_ready=false

finish() {
    local status=$?

    trap - EXIT HUP INT TERM
    if ((status != 0)) && \
        [[ "$backend_stopped" == true && "$application_start_attempted" != true ]]; then
        printf '%s\n' \
            'deploy: deployment failed after backend shutdown; backend remains stopped' >&2
    elif ((status != 0)) && \
        [[ "$application_start_attempted" == true && "$application_ready" != true ]]; then
        if "${COMPOSE[@]}" stop nginx backend frontend; then
            printf '%s\n' \
                'deploy: application services did not all reach readiness; edge and application services were stopped to avoid a partial deployment' >&2
        else
            printf '%s\n' \
                'deploy: application services did not all reach readiness and could not be stopped cleanly; inspect Compose service state immediately' >&2
        fi
    elif ((status != 0)) && \
        [[ "$application_start_attempted" == true && "$application_ready" == true ]]; then
        printf '%s\n' \
            'deploy: service readiness succeeded but public-site acceptance failed; application services remain running for initialization or diagnosis' >&2
    fi
    portfolio_maintenance_lock_release
    exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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

COMPOSE=(docker compose --project-name "$compose_project_name")
COMPOSE+=(--project-directory "$ROOT_DIR" --file "$ROOT_DIR/docker-compose.yml")

printf '%s\n' 'Validating deployment prerequisites...'
python3 "$SCRIPT_DIR/deployment_preflight.py" --repository "$ROOT_DIR"
"${COMPOSE[@]}" config --quiet

printf '%s\n' 'Building application images before backend downtime...'
"${COMPOSE[@]}" build backend database-init frontend

printf '%s\n' 'Stopping backend writes before deployment state changes...'
"${COMPOSE[@]}" stop backend
backend_stopped=true

printf '%s\n' 'Refreshing service-isolated runtime secrets...'
"${COMPOSE[@]}" run --rm --no-deps -T secret-init

printf '%s\n' 'Starting PostgreSQL and waiting for readiness...'
"${COMPOSE[@]}" up --detach --wait --wait-timeout 60 --no-deps postgres

printf '%s\n' 'Applying database migrations and runtime-role grants...'
"${COMPOSE[@]}" run --rm --no-deps -T database-init

printf '%s\n' 'Starting backend and waiting for readiness...'
application_start_attempted=true
"${COMPOSE[@]}" up --detach --wait --wait-timeout 60 --no-deps --force-recreate \
    backend
backend_stopped=false

printf '%s\n' 'Starting frontend and waiting for readiness...'
"${COMPOSE[@]}" up --detach --wait --wait-timeout 60 --no-deps --force-recreate \
    frontend

printf '%s\n' 'Refreshing Nginx configuration and waiting for readiness...'
"${COMPOSE[@]}" up --detach --wait --wait-timeout 60 --no-deps --force-recreate \
    nginx
application_ready=true

printf '%s\n' 'Checking public site acceptance through the TLS edge...'
public_http_status=""
if ! public_http_status=$("${COMPOSE[@]}" exec -T nginx sh -euc \
    ': portfolio-public-site-acceptance; if [ -n "${NGINX_HEALTH_CA_FILE:-}" ]; then test -r "$NGINX_HEALTH_CA_FILE"; set -- --cacert "$NGINX_HEALTH_CA_FILE"; else set --; fi; exec curl --silent --show-error --connect-timeout 1 --max-time 30 --noproxy "*" --resolve beta-demo.top:443:127.0.0.1 "$@" --header "Accept: text/html" --output /dev/null --write-out "%{http_code}" https://beta-demo.top/'); then
    fail 'public site acceptance request failed after service readiness; application services remain running for initialization or diagnosis'
fi
if [[ "$public_http_status" != 200 ]]; then
    fail 'application services are healthy but the public site did not return HTTP 200; for a fresh database, initialize content through https://beta-demo.top/admin, then retry the public-site check'
fi

printf 'Deployment completed for Compose project %s.\n' "$compose_project_name"
