#!/usr/bin/env bash
# Builds the extension zip for the Chrome Web Store (or for loading unpacked).
#   scripts/pack.sh            -> dist/aindus-<version>.zip
#   scripts/pack.sh --no-models -> without the Sketchfab 3D models (mannequins dance; the dances stay)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
python3 "$(dirname "$0")/make-credits.py"     # credits are built from what actually goes into the archive
VER=$(python3 -c "import json;print(json.load(open('$EXT/manifest.json'))['version'])")
mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/aindus-$VER.zip"
rm -f "$OUT"
EXCLUDE=(-x "*.DS_Store" -x "*/.git*")
if [ "${1:-}" = "--no-models" ]; then EXCLUDE+=(-x "assets/models/*"); fi
for need in vendor/transformers/transformers.min.js vendor/three/three.module.min.js assets/model/head.json assets/model/prompts.json assets/songs/songs.json; do
  [ -s "$EXT/$need" ] || { echo "нет $need — сначала ./scripts/fetch-assets.sh"; exit 1; }
done
PEOPLE=$(ls "$EXT/assets/models/people"/*.glb 2>/dev/null | wc -l | tr -d " ")
if [ "$PEOPLE" != "0" ]; then echo "⚠️  в сборке $PEOPLE моделей со Sketchfab (в т.ч. Моди и Человек-паук) — это чужая интеллектуальная собственность, публиковать нельзя"; fi
PRIV=$(python3 -c "import json;print(sum(1 for s in json.load(open('$EXT/assets/songs/songs.json')) if s.get('private')))")
if [ "$PRIV" != "0" ]; then echo "⚠️  в плейлисте $PRIV своих треков (private) — публиковать такое расширение нельзя, убери их: scripts/add-music.py --remove <имя>"; fi
(cd "$EXT" && zip -qr "$OUT" . "${EXCLUDE[@]}")
echo "$OUT  ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
