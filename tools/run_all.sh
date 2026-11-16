#!/usr/bin/env bash
# Pipeline completa: prep -> export GLB -> sonda HDR -> bake -> denoise/WebP -> compressione GLB
set -e
cd "$(dirname "$0")/.."
B="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.0/blender.exe}"
SRC="${SRC:-../BDA_Galleria_Demo/blender/BDA_Galleria.blend}"
F='STEP|CULL|UV |MONO|PREP|GROUP|EXPORTED|PROBE|BAKED|POST|ALL DONE|Error|rror:|Traceback'
step() { echo "STEP $1 $(date +%H:%M:%S)"; }
if [ "$1" != "--skip-prep" ]; then
  step prep;   "$B" -b "$SRC" --python tools/bake_web.py -- prep 2>&1 | grep -E "$F" || true
fi
step export; "$B" -b tools/out/prep.blend --python tools/export_web.py 2>&1 | grep -E "$F" || true
step glb;    npx gltf-transform meshopt tools/out/galleria_raw.glb public/scene/galleria.glb --level high 2>&1 | tail -2
step probe;  "$B" -b "$SRC" --python tools/probe_web.py -- --samples 256 --w 1024 2>&1 | grep -E "$F" || true
step bake;   "$B" -b tools/out/prep.blend --python tools/bake_web.py -- bake --groups all 2>&1 | grep -E "$F" || true
step post;   "$B" -b --factory-startup --python tools/post_web.py 2>&1 | grep -E "$F" || true
step done
