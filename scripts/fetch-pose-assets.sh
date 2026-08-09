#!/usr/bin/env bash
# Fetch the MediaPipe runtime and pose model into pose/vendor/.
#
# Run this once, before opening posecheck.html or building the app.
#
# These files are fetched at BUILD time and served from your own origin at run time. The app
# must never pull the model or the WASM from a CDN while running: that makes it broken offline
# and network-dependent in store review. They are not committed to the repo because they are
# ~18MB of binary that npm and Google host perfectly well.
set -euo pipefail
cd "$(dirname "$0")/.."
V="pose/vendor"
MP_VERSION="${MP_VERSION:-1.0.1}"
MODEL="${MODEL:-lite}"          # lite | full  — lite is the default at runtime too
# SHIP=1 trims what a shipped app does not need: sourcemaps, and the no-SIMD WASM fallback.
# That fallback is 11MB and only matters on devices without WASM SIMD, which is roughly
# pre-iOS-16.4 and pre-Chrome-91. Dev builds keep both, so a console stays useful and an
# older device still runs.
SHIP="${SHIP:-0}"

mkdir -p "$V"
echo "→ @mediapipe/tasks-vision@$MP_VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm init -y >/dev/null 2>&1 && npm i --silent "@mediapipe/tasks-vision@$MP_VERSION" )
SRC="$TMP/node_modules/@mediapipe/tasks-vision"

# Both builds: the worker loads the CommonJS one through importScripts (a module worker cannot),
# the main-thread fallback imports the ES module.
#
# The CJS build is deliberately renamed to end in .js. `importScripts` requires a JavaScript
# MIME type, and most static servers — including `python3 -m http.server` — do not know the .cjs
# extension and serve it as application/octet-stream, which the browser refuses. Renaming means
# the worker path works on any server with no configuration.
cp "$SRC/vision_bundle.mjs" "$V/"
cp "$SRC/vision_bundle.cjs" "$V/vision_bundle_worker.js"
mkdir -p "$V/wasm"
cp "$SRC/wasm/vision_wasm_internal.js"   "$V/wasm/"
cp "$SRC/wasm/vision_wasm_internal.wasm" "$V/wasm/"
if [ "$SHIP" = "1" ]; then
  echo "  ship build: skipping sourcemaps and the 11MB no-SIMD fallback"
else
  # sourcemaps under the names the bundles reference, so a dev console stays clean
  cp "$SRC/vision_bundle.mjs.map" "$V/vision_bundle_mjs.js.map" 2>/dev/null || true
  cp "$SRC/vision_bundle.cjs.map" "$V/vision_bundle_cjs.js.map" 2>/dev/null || true
  cp "$SRC/wasm/vision_wasm_nosimd_internal.js"   "$V/wasm/"
  cp "$SRC/wasm/vision_wasm_nosimd_internal.wasm" "$V/wasm/"
fi

echo "→ pose_landmarker_$MODEL (float16)"
curl -sSLf -o "$V/pose_landmarker_$MODEL.task" \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_$MODEL/float16/1/pose_landmarker_$MODEL.task"

echo
echo "done: $(du -sh "$V" | cut -f1) in $V"
[ "$SHIP" = "1" ] || echo "  SHIP=1 ./scripts/fetch-pose-assets.sh trims this for an app bundle"
