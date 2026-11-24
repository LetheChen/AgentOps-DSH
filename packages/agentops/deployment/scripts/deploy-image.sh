#!/usr/bin/env bash
set -euo pipefail
umask 027

BASE_DIR="/opt/app"
ENV_FILE=""
IMAGE_FILE=""
COMPOSE_FILE=""
CONTAINER="app"
SERVICE="app"
IMAGE_NAME="app:latest"
BACKUP_PREFIX="app:backup"
BACKUP_DIR=""
LOCK_FILE="/var/lock/deploy-image/release.lock"
HEALTH_URL="http://127.0.0.1:8000/health/ready"
MYSQL_CONTAINER=""
DB_NAME=""
RELEASE_ID=""
ROLLBACK="false"
SKIP_MIGRATE="false"

log() { printf '[deploy-image] %s\n' "$*"; }
die() { printf '[deploy-image] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage:
  deploy-image.sh --image FILE --release-id ID [options]
  deploy-image.sh --rollback --release-id ID [options]

Options:
  --base-dir DIR             Installed application directory. Default: /opt/app
  --env-file FILE            Production environment file. Default: <base-dir>/.env
  --compose-file FILE        Compose file. Default: <base-dir>/docker-compose.yml
  --container NAME           Application container. Default: app
  --service NAME             Compose service. Default: app
  --image-name NAME          Runtime image tag. Default: app:latest
  --backup-tag-prefix NAME   Backup tag prefix. Default: app:backup
  --backup-dir DIR           MySQL backup directory. Default: <base-dir>/backups/mysql
  --lock-file FILE           Remote release lock. Default: /var/lock/deploy-image/release.lock
  --health-url URL           Health check URL. Default: http://127.0.0.1:8000/health/ready
  --mysql-container NAME     MySQL container. Default: <container>-mysql
  --db-name NAME             MySQL database. Default: AGENTOPS_DEPLOY_DB_NAME or app
  --release-id ID            Release identifier used for rollback metadata.
  --skip-migrate             Do not run Alembic migration or create a MySQL backup.
  --rollback                 Roll back to the image recorded for --release-id.
USAGE
}

require_value() {
  [[ $# -ge 2 && -n "$2" ]] || die "missing value for $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-dir) require_value "$@"; BASE_DIR="$2"; shift 2 ;;
    --env-file) require_value "$@"; ENV_FILE="$2"; shift 2 ;;
    --image) require_value "$@"; IMAGE_FILE="$2"; shift 2 ;;
    --compose-file) require_value "$@"; COMPOSE_FILE="$2"; shift 2 ;;
    --container) require_value "$@"; CONTAINER="$2"; shift 2 ;;
    --service) require_value "$@"; SERVICE="$2"; shift 2 ;;
    --image-name) require_value "$@"; IMAGE_NAME="$2"; shift 2 ;;
    --backup-tag-prefix) require_value "$@"; BACKUP_PREFIX="$2"; shift 2 ;;
    --backup-dir) require_value "$@"; BACKUP_DIR="$2"; shift 2 ;;
    --lock-file) require_value "$@"; LOCK_FILE="$2"; shift 2 ;;
    --health-url) require_value "$@"; HEALTH_URL="$2"; shift 2 ;;
    --mysql-container) require_value "$@"; MYSQL_CONTAINER="$2"; shift 2 ;;
    --db-name) require_value "$@"; DB_NAME="$2"; shift 2 ;;
    --release-id) require_value "$@"; RELEASE_ID="$2"; shift 2 ;;
    --skip-migrate) SKIP_MIGRATE="true"; shift ;;
    --rollback) ROLLBACK="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run this script as root"
[[ -n "$BASE_DIR" && "$BASE_DIR" = /* ]] || die "--base-dir must be an absolute path"
ENV_FILE="${ENV_FILE:-$BASE_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$BASE_DIR/docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:-$BASE_DIR/backups/mysql}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-${CONTAINER}-mysql}"
[[ -n "$RELEASE_ID" && "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "--release-id is required and must be path-safe"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
command -v docker >/dev/null || die "docker is not installed"
command -v flock >/dev/null || die "flock is not installed"
command -v curl >/dev/null || die "curl is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is not installed"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
DB_NAME="${DB_NAME:-${AGENTOPS_DEPLOY_DB_NAME:-app}}"

install -d -m 0750 "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another release is already running"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

wait_for_health() {
  local attempt status
  for attempt in $(seq 1 90); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]] && curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "health check passed"
      return 0
    fi
    if [[ "$status" == "running" ]] && curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "container is running and health URL responds"
      return 0
    fi
    sleep 2
  done
  log "health check failed; container status: ${status:-unknown}"
  docker logs --tail 150 "$CONTAINER" 2>&1 || true
  return 1
}

RELEASES_DIR="$BASE_DIR/releases"
install -d -m 0700 "$RELEASES_DIR"
RELEASE_FILE="$RELEASES_DIR/$RELEASE_ID.env"

if [[ "$ROLLBACK" == "true" ]]; then
  [[ -f "$RELEASE_FILE" ]] || die "rollback metadata not found for release: $RELEASE_ID"
  # The metadata is root-owned and generated by this script.
  # shellcheck disable=SC1090
  . "$RELEASE_FILE"
  [[ -n "${BACKUP_IMAGE_ID:-}" ]] || die "release has no recorded backup image id"
  log "rolling back $CONTAINER to image $BACKUP_IMAGE_ID"
  docker tag "$BACKUP_IMAGE_ID" "$IMAGE_NAME"
  compose up -d --no-deps --force-recreate "$SERVICE"
  wait_for_health
  log "rollback complete: release_id=$RELEASE_ID image_id=$BACKUP_IMAGE_ID"
  exit 0
fi

[[ -n "$IMAGE_FILE" && "$IMAGE_FILE" = /* ]] || die "--image must be an absolute path"
[[ -f "$IMAGE_FILE" ]] || die "image file not found: $IMAGE_FILE"

CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
BACKUP_TAG=""
STAMP="$(date +%Y%m%d-%H%M%S)"
if [[ -n "$CURRENT_IMAGE_ID" ]]; then
  SHORT_ID="${CURRENT_IMAGE_ID#sha256:}"
  SHORT_ID="${SHORT_ID:0:8}"
  BACKUP_TAG="${BACKUP_PREFIX}-${STAMP}-${SHORT_ID}"
  log "backing up current image $CURRENT_IMAGE_ID as $BACKUP_TAG"
  docker tag "$CURRENT_IMAGE_ID" "$BACKUP_TAG"
else
  log "no current application container image to back up"
fi

MYSQL_BACKUP=""
if [[ "$SKIP_MIGRATE" != "true" ]]; then
  if docker inspect "$MYSQL_CONTAINER" >/dev/null 2>&1; then
    install -d -m 0700 "$BACKUP_DIR"
    MYSQL_BACKUP="$BACKUP_DIR/app-${STAMP}.sql.gz"
    log "creating MySQL backup: $MYSQL_BACKUP"
    MYSQL_PWD="$MYSQL_ROOT_PASSWORD" docker exec -e MYSQL_PWD "$MYSQL_CONTAINER" \
      mysqldump -uroot --single-transaction --routines --events --triggers "$DB_NAME" | gzip > "$MYSQL_BACKUP"
    [[ -s "$MYSQL_BACKUP" ]] || die "MySQL backup is empty"
    gzip -t "$MYSQL_BACKUP"
    find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz' -mtime +7 -delete
  else
    log "MySQL container $MYSQL_CONTAINER is not running; backup skipped"
  fi
fi

log "loading image $IMAGE_FILE"
docker load -i "$IMAGE_FILE"
docker image inspect "$IMAGE_NAME" >/dev/null
NEW_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_NAME")"

if [[ "$SKIP_MIGRATE" != "true" ]]; then
  log "running Alembic migration"
  compose run --rm --no-deps "$SERVICE" python -m alembic upgrade head
fi

log "recreating application service ${SERVICE}; MySQL and Redis stay untouched"
compose up -d --no-deps --force-recreate "$SERVICE"
wait_for_health

FINAL_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
cat > "$RELEASE_FILE" <<EOF
BACKUP_TAG='$BACKUP_TAG'
BACKUP_IMAGE_ID='$CURRENT_IMAGE_ID'
IMAGE_ID='$FINAL_IMAGE_ID'
RELEASED_AT='$(date -u +%Y-%m-%dT%H:%M:%SZ)'
MYSQL_BACKUP='$MYSQL_BACKUP'
EOF
chmod 0600 "$RELEASE_FILE"

log "release complete: release_id=$RELEASE_ID image_id=$FINAL_IMAGE_ID backup_tag=${BACKUP_TAG:-none}"
