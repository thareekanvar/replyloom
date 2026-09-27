#!/usr/bin/env bash
# Checks that Baileys patches still apply cleanly.
# Run as part of CI or before deploy to catch upstream updates that make
# the patches redundant (or break them).
#
# Uses patch-package itself (the same tool the worker's postinstall runs)
# rather than shelling out to `patch` directly: patch-package knows how to
# reverse-then-reapply idempotently, so the check works whether the patch
# is currently applied (normal, postinstall already ran) or not, and it
# fails with exit 1 exactly when a patch no longer matches the installed
# package. `--error-on-fail` is required locally — it's only on by default
# when CI=true.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKER_DIR="apps/worker"
PATCH_DIR="$WORKER_DIR/patches"

echo "==> Checking Baileys patch applicability..."

if [ ! -d "$PATCH_DIR" ]; then
  echo "    No patches directory found — skipping."
  exit 0
fi

PATCH_COUNT=$(find "$PATCH_DIR" -name '*.patch' 2>/dev/null | wc -l | tr -d ' ')
if [ "$PATCH_COUNT" -eq 0 ]; then
  echo "    No patch files found — skipping."
  exit 0
fi

echo "    Found $PATCH_COUNT patch file(s) in $PATCH_DIR"

cd "$WORKER_DIR"
if pnpm exec patch-package --error-on-fail; then
  echo "    All patches apply cleanly."
else
  echo "" >&2
  echo "  Some patches may be stale. Review before deploying." >&2
  echo "  If Baileys was updated and the fixes are now in upstream," >&2
  echo "  remove the corresponding .patch files from $PATCH_DIR." >&2
  exit 1
fi
