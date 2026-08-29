#!/bin/sh
set -eu

: "${DSH_ORBIT_IMAGE:?set DSH_ORBIT_IMAGE to the Orbit image tag}"
: "${DSH_DATA_DIR:?set DSH_DATA_DIR to the host DSH data directory}"

profile="${DSH_PROFILE:-web}"
uid="${DSH_UID:-10001}"
gid="${DSH_GID:-10001}"

case "$profile" in
  ""|*/*|*\\*)
    echo "invalid DSH_PROFILE: $profile" >&2
    exit 2
    ;;
esac

exec docker run --rm \
  --user "$uid:$gid" \
  --entrypoint /usr/local/bin/dsh-orbit-ensure-node-pty \
  -e DSH_PROFILE_ROOT="/data/dsh-home/profiles/$profile" \
  -v "$DSH_DATA_DIR:/data:rw" \
  "$DSH_ORBIT_IMAGE"
