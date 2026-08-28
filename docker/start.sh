#!/bin/sh
set -eu
umask 027

READY_FILE="/tmp/dsh-orbit-ready"
PROFILE_ROOT="${DSH_PROFILE_ROOT:-/data/dsh-home/profiles/web}"
PROFILE_CONNECTION_ROOT="${DSH_PROFILE_CONNECTION_ROOT:-${PROFILE_ROOT}/node_modules/@deepseek-ai/dsh-client-connection/lib}"
RESTART_REQUEST="${DSH_HOME:-/data/dsh-home}/.dsh-web-restart.request"
DSH_BIN="/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
PATCHER="/usr/local/lib/dsh-orbit/bin/dsh-orbit-patch.mjs"
HOOK_RUNNER="/usr/local/lib/dsh-orbit/bin/dsh-orbit-run-hooks.mjs"
dsh_pid=""

rm -f "$READY_FILE"

start_dsh() {
  node --expose-internals "$DSH_BIN" web --no-open --trusted-host "$DSH_PUBLIC_HOST" &
  dsh_pid=$!
}

stop_dsh() {
  if [ -n "$dsh_pid" ] && kill -0 "$dsh_pid" 2>/dev/null; then
    kill -TERM "$dsh_pid" 2>/dev/null || true
    wait "$dsh_pid" 2>/dev/null || true
  fi
  dsh_pid=""
}

cleanup() {
  rm -f "$READY_FILE"
  stop_dsh
}
trap cleanup TERM INT EXIT

wait_for_profile() {
  i=0
  while [ "$i" -lt 120 ]; do
    if [ -f "$PROFILE_CONNECTION_ROOT/index.js" ] && [ -f "$PROFILE_CONNECTION_ROOT/client.js" ]; then
      return 0
    fi
    if ! kill -0 "$dsh_pid" 2>/dev/null; then
      wait "$dsh_pid" || true
      echo "DSH exited before the profile client-connection package became available" >&2
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "Timed out waiting for profile client-connection at $PROFILE_CONNECTION_ROOT" >&2
  return 1
}

wait_for_web() {
  i=0
  while [ "$i" -lt 60 ]; do
    if wget -q -O /dev/null http://127.0.0.1:3080 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$dsh_pid" 2>/dev/null; then
      wait "$dsh_pid" || true
      echo "DSH exited before the web service became ready" >&2
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "Timed out waiting for DSH on 127.0.0.1:3080" >&2
  return 1
}

prepare_runtime() {
  node "$PATCHER" --runtime
  node "$HOOK_RUNNER"
}

# A fresh profile may install its own client-connection package on first boot.
# Bootstrap DSH while the gateway is still held unhealthy, then patch and restart.
if [ ! -f "$PROFILE_CONNECTION_ROOT/index.js" ] || [ ! -f "$PROFILE_CONNECTION_ROOT/client.js" ]; then
  start_dsh
  wait_for_profile
  stop_dsh
fi

while :; do
  rm -f "$READY_FILE"
  prepare_runtime
  start_dsh
  wait_for_web
  node "$PATCHER" --check
  touch "$READY_FILE"

  restart_requested=false
  while kill -0 "$dsh_pid" 2>/dev/null; do
    if [ -f "$RESTART_REQUEST" ]; then
      rm -f "$RESTART_REQUEST"
      rm -f "$READY_FILE"
      restart_requested=true
      echo "DSH web restart requested"
      kill -TERM "$dsh_pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done

  if wait "$dsh_pid"; then
    exit_code=0
  else
    exit_code=$?
  fi
  dsh_pid=""

  if [ "$restart_requested" = true ]; then
    echo "Restarting DSH web"
    continue
  fi

  exit "$exit_code"
done
