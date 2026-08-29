#!/bin/sh
# Reference downstream snapshot hook for the DSH Orbit snapshot contract.
#
# The contract is storage-agnostic: production sites replace this script with
# ZFS, Btrfs, NAS, or VM snapshot logic. This reference implementation is
# portable: it archives DSH_DATA_ROOT with tar into DSH_SNAPSHOT_ARCHIVE_DIR
# and writes the required manifest to DSH_SNAPSHOT_MANIFEST.
#
# Required environment (provided by the DSH Orbit upgrade runner):
#   DSH_SNAPSHOT_ID           requested snapshot identifier
#   DSH_DATA_ROOT             persistent data root directory
#   DSH_ORBIT_REVISION        exact DSH Orbit revision to record
#   DSH_VERSION               DSH version that produced the data (pre-upgrade)
#   DSH_SNAPSHOT_MANIFEST     manifest output path (JSON)
#   DSH_SNAPSHOT_ARCHIVE_DIR  optional archive directory (default: next to the manifest)
#
# Optional environment:
#   DSH_CANDIDATE_DSH_VERSION candidate DSH version the upgrade moves to
#
# Exit behavior: 0 and a completed manifest on success, non-zero on failure.
# The manifest must never contain storage credentials.
set -eu

: "${DSH_SNAPSHOT_ID:?DSH_SNAPSHOT_ID is required}"
: "${DSH_DATA_ROOT:?DSH_DATA_ROOT is required}"
: "${DSH_ORBIT_REVISION:?DSH_ORBIT_REVISION is required}"
: "${DSH_VERSION:?DSH_VERSION is required}"
: "${DSH_SNAPSHOT_MANIFEST:?DSH_SNAPSHOT_MANIFEST is required}"

if [ ! -d "$DSH_DATA_ROOT" ]; then
  echo "snapshot data root is not a directory: $DSH_DATA_ROOT" >&2
  exit 3
fi

archive_dir="${DSH_SNAPSHOT_ARCHIVE_DIR:-$(dirname "$DSH_SNAPSHOT_MANIFEST")}"
mkdir -p "$archive_dir"
archive="$archive_dir/$DSH_SNAPSHOT_ID.tar.gz"

data_parent="$(dirname "$DSH_DATA_ROOT")"
data_name="$(basename "$DSH_DATA_ROOT")"
tar -czf "$archive" -C "$data_parent" "$data_name"

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
candidate_json=""
if [ -n "${DSH_CANDIDATE_DSH_VERSION:-}" ]; then
  candidate_json=",
  \"candidateDshVersion\": \"$DSH_CANDIDATE_DSH_VERSION\""
fi

cat > "$DSH_SNAPSHOT_MANIFEST" <<EOF
{
  "snapshotId": "$DSH_SNAPSHOT_ID",
  "createdAt": "$created_at",
  "orbitRevision": "$DSH_ORBIT_REVISION",
  "dshVersion": "$DSH_VERSION",
  "dataRoot": "$DSH_DATA_ROOT",
  "method": "tar-gz-reference",
  "restoreReference": "$archive",
  "status": "complete"$candidate_json
}
EOF

echo "snapshot archive: $archive"
