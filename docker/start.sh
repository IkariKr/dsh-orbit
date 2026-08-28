#!/bin/sh
set -eu

READY_FILE="/tmp/dsh-orbit-ready"
PROFILE_ROOT="${DSH_PROFILE_ROOT:-/data/dsh-home/profiles/web}"
PROFILE_CONNECTION_ROOT="${DSH_PROFILE_CONNECTION_ROOT:-${PROFILE_ROOT}/node_modules/@deepseek-ai/dsh-client-connection/lib}"
DSH_BIN="/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
PATCHER="/usr/local/lib/dsh-orbit/bin/dsh-orbit-patch.mjs"
dsh_pid=""

rm -f "$READY_FILE"

start_dsh() {
  node --expose-internals "$DSH_BIN" web --no-open &
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

# A fresh profile may install its own client-connection package on first boot.
# Bootstrap DSH while the gateway is still held unhealthy, then patch and restart.
if [ ! -f "$PROFILE_CONNECTION_ROOT/index.js" ] || [ ! -f "$PROFILE_CONNECTION_ROOT/client.js" ]; then
  start_dsh
  wait_for_profile
  stop_dsh
fi

node "$PATCHER" --runtime
start_dsh
wait_for_web
node "$PATCHER" --check

touch "$READY_FILE"
trap cleanup TERM INT EXIT
wait "$dsh_pid"
