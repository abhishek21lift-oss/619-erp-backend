#!/usr/bin/env bash
# Enable rungs 4-5 of the Command Center recovery ladder on the VPS.
#
#   cc-recovery.sh inspect   read-only: what is running, what would change
#   cc-recovery.sh apply     back up, write the override, start the proxy,
#                            recreate ONLY the API container
#   cc-recovery.sh verify    prove the proxy refuses everything but the two
#                            restarts, and that nothing is exposed
#
# ── Why an override file ────────────────────────────────────────────────────
#
# The compose file that runs production lives at /opt/myptstudio, outside the
# repository, and was written by hand. Editing it with a script would mean
# parsing YAML nobody has reviewed. `docker compose` merges a
# docker-compose.override.yml beside it automatically — including on every
# deploy — so this script writes ONLY that file and never touches the original.
# Removing the file and re-running `docker compose up -d <api>` undoes it.
#
# ── What it will not do ─────────────────────────────────────────────────────
#
#   * mount /var/run/docker.sock anywhere but the proxy
#   * publish a port (the proxy is `expose`d on the compose network only)
#   * recreate Redis, the worker, or anything with a volume
#   * guess: a missing worker, an existing override file, an ambiguous API
#     container or a container name the proxy regex cannot carry safely all
#     stop the script with the reason.
set -euo pipefail

DIR="${CC_COMPOSE_DIR:-/opt/myptstudio}"
PROXY_IMAGE='wollomatic/socket-proxy:1.13.1@sha256:3935b709275e4ec35d6ed5a5c4a1f0d01ed31eec5e7234efc3357ecd47689002'
PROXY_SERVICE='docker-socket-proxy'
NAME_RE='^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'
MODE="${1:-inspect}"

die() { echo "cc-recovery: STOP — $*" >&2; exit 1; }
say() { echo "cc-recovery: $*"; }

cd "$DIR" || die "no compose directory at $DIR"

MAIN=''
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  [ -f "$f" ] && { MAIN="$f"; break; }
done
[ -n "$MAIN" ] || die "no compose file in $DIR"
case "$MAIN" in
  compose.*) OVERRIDE="compose.override.${MAIN##*.}" ;;
  *)         OVERRIDE="docker-compose.override.${MAIN##*.}" ;;
esac

PROJECT="$(docker compose config --format json 2>/dev/null | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$PROJECT" ] || PROJECT="$(basename "$DIR")"

# ── Discover the real containers, not the names in any template ────────────
# The API is the container serving :5000 in this project; the worker is the
# one running src/workers/index.js. Both found from Docker itself.
api_rows="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter publish=5000 \
  --format '{{.Label "com.docker.compose.service"}} {{.Names}}')"
worker_rows="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --no-trunc \
  --format '{{.Label "com.docker.compose.service"}} {{.Names}} {{.Command}}' | grep 'src/workers/index.js' || true)"

[ "$(printf '%s\n' "$api_rows" | grep -c . || true)" = 1 ] \
  || die "expected exactly one API container publishing :5000 in project '$PROJECT', found: ${api_rows:-none}"
API_SERVICE="${api_rows%% *}";  API_CONTAINER="${api_rows##* }"
[ "$(printf '%s\n' "$worker_rows" | grep -c . || true)" = 1 ] \
  || die "expected exactly one worker container (src/workers/index.js) in project '$PROJECT', found: ${worker_rows:-none}. Without a separate worker there is nothing for rung 4 to restart."
WORKER_SERVICE="$(echo "$worker_rows" | awk '{print $1}')"; WORKER_CONTAINER="$(echo "$worker_rows" | awk '{print $2}')"

for n in "$API_CONTAINER" "$WORKER_CONTAINER" "$API_SERVICE"; do
  [[ "$n" =~ $NAME_RE ]] || die "'$n' contains characters the proxy allow-list regex cannot carry safely (only letters, digits, _ and -)"
done
[ "$API_CONTAINER" != "$WORKER_CONTAINER" ] || die "API and worker are the same container"

SOCK_GID="$(stat -c %g /var/run/docker.sock)"
api_networks="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$API_CONTAINER")"

inspect() {
  say "compose dir:       $DIR"
  say "compose file:      $MAIN  (override: $OVERRIDE $( [ -f "$OVERRIDE" ] && echo EXISTS || echo absent))"
  say "project:           $PROJECT"
  say "API:               service=$API_SERVICE container=$API_CONTAINER"
  say "worker:            service=$WORKER_SERVICE container=$WORKER_CONTAINER"
  say "API networks:      $api_networks"
  say "docker.sock gid:   $SOCK_GID"
  say "running:"; docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '  {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}'
  say "socket mounted in API? $(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$API_CONTAINER" | grep -c docker.sock || true)"
  say "anything bound to :2375 on the host? $(ss -ltn 2>/dev/null | grep -c ':2375 ' || true)"
  say "API env DOCKER_PROXY_URL: $(docker exec "$API_CONTAINER" printenv DOCKER_PROXY_URL 2>/dev/null || echo '(unset)')"
}

network_yaml() {
  # Attach the proxy to exactly the compose networks the API is on, by their
  # compose key (the label), so service-name DNS works between them.
  local keys=""
  for net in $api_networks; do
    k="$(docker network inspect -f '{{index .Labels "com.docker.compose.network"}}' "$net" 2>/dev/null || true)"
    [ -n "$k" ] || die "the API is on network '$net', which this compose project does not define"
    keys="$keys $k"
  done
  echo "    networks:"
  for k in $keys; do echo "      - $k"; done
}

apply() {
  [ -f "$OVERRIDE" ] && die "$OVERRIDE already exists; merge by hand rather than overwrite it"
  local stamp backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$DIR/.cc-recovery-backup-$stamp"
  mkdir -p "$backup"
  cp -a "$MAIN" "$backup/"
  [ -f .env ] && cp -a .env "$backup/"
  docker compose config > "$backup/effective-config.before.yml"
  docker inspect "$API_CONTAINER" > "$backup/api-container.before.json"
  say "backup: $backup"

  cat > "$OVERRIDE" <<YAML
# Written by 619-erp-backend/scripts/deploy/cc-recovery.sh on $stamp.
# Enables Command Center recovery rungs 4-5 (restart worker / restart API).
# Undo: delete this file, then: docker compose up -d --no-deps $API_SERVICE && docker compose rm -sf $PROXY_SERVICE
services:
  $API_SERVICE:
    environment:
      DOCKER_PROXY_URL: http://$PROXY_SERVICE:2375
      CC_API_CONTAINER: $API_CONTAINER
      CC_WORKER_CONTAINER: $WORKER_CONTAINER

  $PROXY_SERVICE:
    image: $PROXY_IMAGE
    restart: unless-stopped
    command:
      - '-loglevel=INFO'
      - '-listenip=0.0.0.0'
      - '-allowfrom=$API_SERVICE'
      - '-allowPOST=(/v[0-9.]+)?/containers/($API_CONTAINER|$WORKER_CONTAINER)/restart'
      - '-allowhealthcheck'
      - '-watchdoginterval=3600'
      - '-stoponwatchdog'
      - '-shutdowngracetime=5'
    healthcheck:
      test: ['CMD', './healthcheck']
      interval: 30s
      timeout: 5s
      retries: 3
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    group_add:
      - '$SOCK_GID'
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    expose:
      - '2375'
$(network_yaml)
YAML

  # The merged result must be valid and must not have grown a published port
  # or a second socket mount before anything is started.
  docker compose config > "$backup/effective-config.after.yml" || { rm -f "$OVERRIDE"; die "compose rejected the override; removed it"; }
  if docker compose config --format json | grep -q '"published": *"2375"'; then
    rm -f "$OVERRIDE"; die "port 2375 would be published; removed the override"
  fi

  say "pulling $PROXY_IMAGE"
  docker compose pull "$PROXY_SERVICE"
  say "starting $PROXY_SERVICE"
  docker compose up -d --no-deps "$PROXY_SERVICE"
  say "recreating $API_SERVICE only (redis and $WORKER_SERVICE untouched)"
  docker compose up -d --no-deps "$API_SERVICE"
  say "done. Now run: $0 verify"
}

verify() {
  local fail=0 code
  probe() { # method path -> status, from inside the API container
    docker exec "$API_CONTAINER" node -e "
      fetch('http://$PROXY_SERVICE:2375'+process.argv[2],{method:process.argv[1],headers:{'content-type':'application/json'},
        body:process.argv[1]==='POST'?'{\"Image\":\"alpine\",\"HostConfig\":{\"Binds\":[\"/:/host\"]}}':undefined,
        signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(e=>console.log('ERR'))" "$1" "$2"
  }
  expect_refused() {
    code="$(probe "$1" "$2")"
    if [ "$code" = 403 ] || [ "$code" = 405 ]; then say "refused  $code  $1 $2"
    else say "ALLOWED! $code  $1 $2"; fail=1; fi
  }
  say "proxy health: $(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$PROXY_SERVICE")")"
  expect_refused POST /containers/create
  expect_refused POST "/containers/$WORKER_CONTAINER/exec"
  expect_refused POST "/containers/$WORKER_CONTAINER/stop"
  expect_refused POST "/containers/$WORKER_CONTAINER/start"
  expect_refused POST "/containers/$WORKER_CONTAINER/kill"
  for other in $(docker ps --format '{{.Names}}' | grep -vx -e "$API_CONTAINER" -e "$WORKER_CONTAINER"); do
    expect_refused POST "/containers/$other/restart"
  done
  expect_refused POST /images/create
  expect_refused POST /volumes/create
  expect_refused POST /networks/create
  expect_refused POST /build
  expect_refused POST /containers/prune
  expect_refused DELETE "/containers/$WORKER_CONTAINER"
  expect_refused GET /containers/json
  expect_refused GET "/containers/$WORKER_CONTAINER/json"
  expect_refused GET /info
  expect_refused GET /version
  if docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$API_CONTAINER" | grep -q docker.sock; then
    say "FAIL: docker.sock is mounted into the API"; fail=1
  else say "ok: docker.sock is not mounted into the API"; fi
  if docker port "$(docker compose ps -q "$PROXY_SERVICE")" | grep -q .; then
    say "FAIL: the proxy publishes a port"; fail=1
  else say "ok: the proxy publishes no port"; fi
  if ss -ltn 2>/dev/null | grep -q ':2375 '; then say "FAIL: something listens on :2375 on the host"; fail=1
  else say "ok: nothing listens on :2375 on the host"; fi
  if [ "$(docker exec "$API_CONTAINER" printenv DOCKER_PROXY_URL 2>/dev/null)" = "http://$PROXY_SERVICE:2375" ]; then
    say "ok: the API has DOCKER_PROXY_URL"; else say "FAIL: the API does not have DOCKER_PROXY_URL"; fail=1; fi
  [ "$fail" = 0 ] && say "VERIFIED: only POST /containers/($API_CONTAINER|$WORKER_CONTAINER)/restart is allowed" \
    || die "verification failed — see above"
}

case "$MODE" in
  inspect) inspect ;;
  apply)   inspect; apply ;;
  verify)  verify ;;
  *) die "usage: $0 inspect|apply|verify" ;;
esac
