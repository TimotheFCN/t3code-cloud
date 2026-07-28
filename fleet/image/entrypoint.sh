#!/usr/bin/env bash
# t3env entrypoint — the bootstrap sequence:
#
#   1. start tailscaled (state on the environment volume — stable device
#      identity) and join the tailnet as $T3ENV_TS_HOSTNAME; first boot uses
#      the controller-minted $TS_AUTHKEY, every later boot reuses the
#      persisted identity and never needs a key again
#   2. start the inner Docker daemon (data root on the environment volume,
#      see /etc/docker/daemon.json)
#   3. clone the project into /root/workspace (skipped when the volume
#      already has it — recreates keep the workspace)
#   4. run the project's setup hook (.t3env/setup.sh) when present
#   5. register the workspace with `t3 project add` (idempotent)
#   6. start `t3 serve`, configured entirely through T3CODE_* env vars
#      (with T3CODE_TAILSCALE_SERVE=1 it publishes itself over HTTPS via
#      Tailscale Serve)
#
# Phase 5 adds credential materialization before the clone.
#
# The inner daemon needs the sysbox runtime on the node. Without it (e.g.
# plain runc during development) dockerd fails to start; that is degraded but
# deliberate — the T3 server still runs, and the warning below says why. A
# failed tailnet join, by contrast, aborts loudly: without its tailnet
# endpoint the environment is unreachable by design (no ports are published).
set -uo pipefail

log() { echo "[t3env] $*" >&2; }

WORKSPACE_DIR="/root/workspace"
SETUP_HOOK=".t3env/setup.sh"
TS_STATE_DIR="${T3ENV_TS_STATE_DIR:-/root/.tailscale}"
# The socket must stay at the default in production — `t3 serve
# --tailscale-serve` runs the `tailscale` CLI without a --socket flag. The
# overrides exist so entrypoint tests can run unprivileged outside a
# container.
TS_SOCKET="${T3ENV_TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"
TUN_DEVICE="${T3ENV_TUN_DEVICE:-/dev/net/tun}"
LOG_DIR="${T3ENV_LOG_DIR:-/var/log}"

ts_cli() { tailscale "--socket=${TS_SOCKET}" "$@"; }

ts_backend_state() {
  # Extracts BackendState from `tailscale status --json` without a jq
  # dependency (NeedsLogin / Running / Stopped / ...).
  ts_cli status --json 2>/dev/null |
    sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

TAILSCALED_PID=""
if [ -n "${T3ENV_TS_HOSTNAME:-}" ] && [ "${T3ENV_SKIP_TAILSCALE:-0}" != "1" ]; then
  tailscaled_args=("--statedir=${TS_STATE_DIR}" "--socket=${TS_SOCKET}")
  # sysbox exposes /dev/net/tun, so production environments run tailscaled in
  # kernel mode; without a TUN device (plain runc in development) userspace
  # networking serves inbound traffic just the same.
  if [ ! -e "${TUN_DEVICE}" ]; then
    log "no ${TUN_DEVICE} — starting tailscaled in userspace-networking mode"
    tailscaled_args+=("--tun=userspace-networking")
  fi
  mkdir -p "${TS_STATE_DIR}"
  log "starting tailscaled (state in ${TS_STATE_DIR})"
  tailscaled "${tailscaled_args[@]}" >>"${LOG_DIR}/tailscaled.log" 2>&1 &
  TAILSCALED_PID=$!
  tailscaled_ready=0
  for _ in $(seq 1 30); do
    if [ -S "${TS_SOCKET}" ]; then
      tailscaled_ready=1
      break
    fi
    if ! kill -0 "${TAILSCALED_PID}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [ "${tailscaled_ready}" != "1" ]; then
    log "ERROR: tailscaled did not come up — see /var/log/tailscaled.log"
    exit 1
  fi

  # The same non-default flags are passed on every boot (`tailscale up`
  # requires that); only the first join carries the single-use auth key.
  # --accept-dns=false keeps the container's normal DNS resolution — the
  # environment only serves inbound, it never needs to resolve tailnet peers.
  up_args=("--hostname=${T3ENV_TS_HOSTNAME}" "--accept-dns=false" "--timeout=120s")
  if [ "$(ts_backend_state)" = "NeedsLogin" ]; then
    # First join. Never reached again once the volume has a logged-in
    # identity — rejoins must reuse it (the device's URL is its identity).
    if [ -z "${TS_AUTHKEY:-}" ]; then
      log "ERROR: first tailnet join requires TS_AUTHKEY"
      exit 1
    fi
    log "joining tailnet as ${T3ENV_TS_HOSTNAME}"
    if ! ts_cli up "--authkey=${TS_AUTHKEY}" "${up_args[@]}"; then
      log "ERROR: tailnet join failed — check the auth key and tailnet ACLs"
      exit 1
    fi
  else
    log "existing tailscale identity found — rejoining as ${T3ENV_TS_HOSTNAME}"
    if ! ts_cli up "${up_args[@]}"; then
      log "ERROR: tailnet rejoin failed — see ${LOG_DIR}/tailscaled.log"
      exit 1
    fi
  fi
  log "tailnet is up"
fi
# The single-use key must not leak into the server or provider CLIs.
unset TS_AUTHKEY

DOCKERD_PID=""
if [ "${T3ENV_SKIP_DOCKERD:-0}" != "1" ]; then
  log "starting inner dockerd"
  dockerd >>"${LOG_DIR}/dockerd.log" 2>&1 &
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
  if [ -n "${TAILSCALED_PID}" ]; then
    kill -TERM "${TAILSCALED_PID}" 2>/dev/null || true
  fi
}
trap shutdown TERM INT

wait "${T3_PID}"
exit_code=$?
if [ -n "${DOCKERD_PID}" ]; then
  kill -TERM "${DOCKERD_PID}" 2>/dev/null || true
fi
if [ -n "${TAILSCALED_PID}" ]; then
  kill -TERM "${TAILSCALED_PID}" 2>/dev/null || true
fi
# Reap whatever is left before giving up PID 1.
wait 2>/dev/null || true
exit "${exit_code}"
