#!/usr/bin/env bash
# Prints the CHANGELOG.md section for a version, without its heading. The release workflow publishes it as the notes.
# Usage: scripts/release-notes.sh <version>   (fails if CHANGELOG.md has no non-empty section for it)
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:?usage: scripts/release-notes.sh <version>}"
notes="$(awk -v heading="## [$version]" '
  index($0, "## ") == 1 { if (found) exit; found = index($0, heading) == 1; next }
  found
' CHANGELOG.md)"
if [[ -z "${notes//[[:space:]]/}" ]]; then
  echo "error: CHANGELOG.md has no notes for $version. Add a '## [$version] - <date>' section before tagging." >&2
  exit 1
fi
printf '%s\n' "$notes"
