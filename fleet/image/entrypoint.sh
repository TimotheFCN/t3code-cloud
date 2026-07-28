#!/usr/bin/env bash
# t3env entrypoint — deliberately minimal in fleet phase 2:
#
#   1. start the inner Docker daemon (data root on the environment volume,
#      see /etc/docker/daemon.json)
#   2. start `t3 serve`, configured entirely through T3CODE_* env vars
#
# Later phases extend the bootstrap (tailscaled + tailnet join, credential
# materialization, workspace clone, setup hook, `t3 project add`).
#
# The inner daemon needs the sysbox runtime on the node. Without it (e.g.
# plain runc during development) dockerd fails to start; that is degraded but
# deliberate — the T3 server still runs, and the warning below says why.
set -uo pipefail

log() { echo "[t3env] $*" >&2; }

DOCKERD_PID=""
if [ "${T3ENV_SKIP_DOCKERD:-0}" != "1" ]; then
  log "starting inner dockerd"
  dockerd >>/var/log/dockerd.log 2>&1 &
  DOCKERD_PID=$!
  dockerd_ready=0
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      dockerd_ready=1
      break
    fi
    if ! kill -0 "${DOCKERD_PID}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [ "${dockerd_ready}" = "1" ]; then
    log "inner dockerd is ready"
  else
    log "WARNING: inner dockerd did not come up — 'docker' will not work in this environment."
    log "WARNING: is the container running under the sysbox runtime? See /var/log/dockerd.log"
  fi
fi

log "starting t3 serve (host=${T3CODE_HOST:-} port=${T3CODE_PORT:-} home=${T3CODE_HOME:-})"
t3 serve &
T3_PID=$!

shutdown() {
  log "shutting down"
  kill -TERM "${T3_PID}" 2>/dev/null || true
  if [ -n "${DOCKERD_PID}" ]; then
    kill -TERM "${DOCKERD_PID}" 2>/dev/null || true
  fi
}
trap shutdown TERM INT

wait "${T3_PID}"
exit_code=$?
if [ -n "${DOCKERD_PID}" ]; then
  kill -TERM "${DOCKERD_PID}" 2>/dev/null || true
fi
# Reap whatever is left before giving up PID 1.
wait 2>/dev/null || true
exit "${exit_code}"
