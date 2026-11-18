#!/usr/bin/env bash
# Angolo caffetteria con i pasticcini: patch di sorgente e prep.blend, bake dei soli gruppi toccati
# (caffe' + pareti/panca per le ombre di contatto), post, export e compressione del GLB. Circa 1 ora su CPU.
set -e
cd "$(dirname "$0")/.."
B="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.0/blender.exe}"
SRC="${SRC:-../BDA_Galleria_Demo/blender/BDA_Galleria.blend}"
GROUPS="${GROUPS:-cafe_matte,cafe_gloss,walls}"
F='STEP|CAM|BUILT|REMOVED|CONVERTED|CULLC|UV |PATCHED|BAKED|POST|GROUP|EXPORTED|ALL DONE|Error|rror:|Traceback|line [0-9]'
step() { echo "STEP $1 $(date +%H:%M:%S)"; }
step patch_src;  "$B" -b "$SRC" --python tools/patch_cafe.py -- --save 2>&1 | grep -E "$F" || true
step patch_prep; "$B" -b tools/out/prep.blend --python tools/patch_cafe.py -- --save 2>&1 | grep -E "$F" || true
step bake;       "$B" -b tools/out/prep.blend --python tools/bake_web.py -- bake --groups "$GROUPS" 2>&1 | grep -E "$F" || true
step post;       "$B" -b --factory-startup --python tools/post_web.py -- --groups "$GROUPS" 2>&1 | grep -E "$F" || true
step export;     "$B" -b tools/out/prep.blend --python tools/export_web.py 2>&1 | grep -E "$F" || true
step glb;        npx gltf-transform meshopt tools/out/galleria_raw.glb public/scene/galleria.glb --level high 2>&1 | tail -2
step done
