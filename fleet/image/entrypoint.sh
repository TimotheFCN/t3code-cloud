#!/usr/bin/env bash
# t3env entrypoint — the phase-3 bootstrap sequence:
#
#   1. start the inner Docker daemon (data root on the environment volume,
#      see /etc/docker/daemon.json)
#   2. clone the project into /root/workspace (skipped when the volume
#      already has it — recreates keep the workspace)
#   3. run the project's setup hook (.t3env/setup.sh) when present
#   4. register the workspace with `t3 project add` (idempotent)
#   5. start `t3 serve`, configured entirely through T3CODE_* env vars
#
# Phase 4 prepends tailscaled + tailnet join; phase 5 adds credential
# materialization before the clone.
#
# The inner daemon needs the sysbox runtime on the node. Without it (e.g.
# plain runc during development) dockerd fails to start; that is degraded but
# deliberate — the T3 server still runs, and the warning below says why.
set -uo pipefail

log() { echo "[t3env] $*" >&2; }

WORKSPACE_DIR="/root/workspace"
SETUP_HOOK=".t3env/setup.sh"

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

if [ -n "${T3ENV_GIT_URL:-}" ]; then
  # Clone once per volume: the workspace survives container recreates, and a
  # re-run (crash-safe create retries, image updates) must never clobber it.
  if [ ! -d "${WORKSPACE_DIR}/.git" ]; then
    log "cloning ${T3ENV_GIT_URL} into ${WORKSPACE_DIR}"
    clone_args=()
    if [ -n "${T3ENV_GIT_BRANCH:-}" ]; then
      clone_args+=(--branch "${T3ENV_GIT_BRANCH}")
    fi
    if ! git clone "${clone_args[@]}" -- "${T3ENV_GIT_URL}" "${WORKSPACE_DIR}"; then
      log "ERROR: git clone failed"
      exit 1
    fi
  else
    log "workspace already present at ${WORKSPACE_DIR}, skipping clone"
  fi

  # Setup hook convention: an executable `.t3env/setup.sh` at the repo root,
  # run from the workspace on every container boot. It must be idempotent —
  # this is where projects reinstall apt packages and other root-filesystem
  # state that recreates legitimately lose. A failing hook aborts the boot
  # loudly rather than serving a half-prepared environment.
  if [ -x "${WORKSPACE_DIR}/${SETUP_HOOK}" ]; then
    log "running setup hook ${SETUP_HOOK}"
    if ! (cd "${WORKSPACE_DIR}" && "./${SETUP_HOOK}"); then
      log "ERROR: setup hook ${SETUP_HOOK} failed"
      exit 1
    fi
  elif [ -e "${WORKSPACE_DIR}/${SETUP_HOOK}" ]; then
    log "WARNING: ${SETUP_HOOK} exists but is not executable — skipping (chmod +x it)"
  fi

  # Register the workspace as a T3 project. Re-runs hit the already-exists
  # guard, which is success for our purposes (recreates keep T3CODE_HOME).
  log "registering ${WORKSPACE_DIR} as a T3 project"
  add_output="$(t3 project add "${WORKSPACE_DIR}" 2>&1)"
  add_status=$?
  if [ "${add_status}" -ne 0 ]; then
    if echo "${add_output}" | grep -qi "already exists"; then
      log "project already registered"
    else
      log "ERROR: t3 project add failed (exit ${add_status}):"
      echo "${add_output}" >&2
      exit 1
    fi
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
