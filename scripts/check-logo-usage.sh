#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
if grep -RInE '<div class="(mark|logoMark)">A</div>|placeholder logo|generic logo' "$ROOT/public" 2>/dev/null; then
  echo "Logo check failed: placeholder A/generic logo found." >&2
  exit 1
fi
[[ -s "$ROOT/public/aas-icon-dark.svg" ]] || { echo "Logo check failed: missing public/aas-icon-dark.svg" >&2; exit 1; }
[[ -s "$ROOT/public/aas-logo-glow.svg" ]] || { echo "Logo check failed: missing public/aas-logo-glow.svg" >&2; exit 1; }
echo "Logo usage check passed."
