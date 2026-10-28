#!/usr/bin/env bash
# Optional: verify and record a G1 baseline for invariant.
#
# This script never creates a GitHub token. Set INVARIANT_DOCTOR_TOKEN to a
# short-lived GitHub App installation token (or another token) with
# Administration: read and Metadata: read. It verifies the observation and only
# writes the baseline after the class is G1. The CI token is minted by the
# workflow from INVARIANT_APP_ID and INVARIANT_APP_PRIVATE_KEY; this script does
# not store any secret.
#
# Usage:
#   GITHUB_REPOSITORY=owner/repo \
#   INVARIANT_DOCTOR_TOKEN=... \
#     scripts/enable-g1.sh [--check]
#
#   --check       verify G1 but do not write .invariant/protection-baseline.json
#
# A baseline written by this script still has to go through a pull request:
# `.invariant/` is a protected path.

set -euo pipefail

mode="record"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --check) mode="check" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "enable-g1: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

repo="${GITHUB_REPOSITORY:-}"
token="${INVARIANT_DOCTOR_TOKEN:-}"

if [ -z "$repo" ]; then
  echo "enable-g1: set GITHUB_REPOSITORY=owner/repo" >&2
  exit 2
fi
if [ -z "$token" ]; then
  echo "enable-g1: set INVARIANT_DOCTOR_TOKEN to a short-lived App installation token with Administration: read + Metadata: read" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "enable-g1: node >= 20 is required" >&2
  exit 2
fi

if [ -f packages/cli/dist/cli.js ]; then
  npm run build >/dev/null
  cli=(node packages/cli/dist/cli.js)
else
  cli=(npx --no-install invariant)
fi

out="$(mktemp "${TMPDIR:-/tmp}/invariant-doctor.XXXXXX")"
trap 'rm -f "$out"' EXIT

INVARIANT_DOCTOR_TOKEN="$token" GITHUB_REPOSITORY="$repo" \
  "${cli[@]}" doctor --json --repo "$repo" --run-id "${GITHUB_RUN_ID:-local}" --out "$out"

class="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).class)' "$out")"
if [ "$class" != "G1" ]; then
  echo "enable-g1: doctor reported $class, not G1." >&2
  node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const f of d.findings || []) console.error(`- ${f.severity} ${f.code}: ${f.message}`);
  ' "$out" || cat "$out" >&2
  exit 1
fi

echo "enable-g1: G1 observed."

if [ "$mode" = "check" ]; then
  echo "enable-g1: check-only; baseline not changed."
  exit 0
fi

INVARIANT_DOCTOR_TOKEN="$token" GITHUB_REPOSITORY="$repo" \
  "${cli[@]}" doctor --record --repo "$repo" --run-id "${GITHUB_RUN_ID:-local}"

echo "enable-g1: baseline recorded."
echo "enable-g1: commit .invariant/protection-baseline.json through a PR; the ruleset requires review."
echo "enable-g1: confirm with GITHUB_REPOSITORY=$repo INVARIANT_DOCTOR_TOKEN=... ${cli[*]} doctor --strict --repo $repo --run-id local"
