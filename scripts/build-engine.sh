#!/usr/bin/env bash
# Fetch the pinned dTax tax engine, prove it is unmodified, and build it with
# the engine's own declared tooling (pnpm version from its package.json, its
# own frozen lockfile). Nothing in the engine source is changed.
#
#   scripts/build-engine.sh [OUT_DIR]      default: build/engine
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HERE/build/engine}"
PRISTINE="$(mktemp -d)/engine"
trap 'rm -rf "$(dirname "$PRISTINE")"' EXIT

# 1. Exact pinned commit, every file checked against engine/engine.lock.json.
python3 "$HERE/engine/verify_engine.py" fetch "$PRISTINE"

# 2. Build in a copy, so the verified tree is never touched.
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -R "$PRISTINE" "$OUT"
rm -rf "$OUT/.git"

cd "$OUT"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# --ignore-scripts: no dependency install hooks run during the build.
corepack pnpm install --frozen-lockfile --ignore-scripts --filter "@dtax/tax-engine..."
corepack pnpm --filter @dtax/shared-types build
corepack pnpm --filter @dtax/tax-engine build

# 3. The built source still matches the pin (build output and node_modules
#    are outside the pinned files, so they are compared against a copy of the
#    pinned paths with those removed).
CHECK="$(dirname "$PRISTINE")/check"
mkdir -p "$CHECK"
(cd "$OUT" && tar --exclude=node_modules --exclude=dist -cf - \
    $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["paths"]))' "$HERE/engine/engine.lock.json")) \
  | (cd "$CHECK" && tar -xf -)
python3 "$HERE/engine/verify_engine.py" verify "$CHECK"

test -f "$OUT/packages/tax-engine/dist/index.js"

# 4. Build record, served at GET /source: ties the running service to this build.
python3 - "$HERE/engine/engine.lock.json" "$OUT/packages/tax-engine/dist/index.js" "$OUT/../engine-build.json" \
  "$(node --version)" "$(corepack pnpm --version)" <<'PY'
import hashlib, json, sys
lock, dist, out, node, pnpm = sys.argv[1:]
lock = json.load(open(lock))
json.dump({"commit": lock["commit"], "manifestSha256": lock["manifest_sha256"],
           "distIndexSha256": hashlib.sha256(open(dist, "rb").read()).hexdigest(),
           "node": node, "pnpm": pnpm}, open(out, "w"), indent=2)
PY
echo "Built engine: $OUT/packages/tax-engine/dist/index.js"
