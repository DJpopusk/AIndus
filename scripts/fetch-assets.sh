#!/usr/bin/env bash
# Downloads all third-party assets:
#   - transformers.js + ONNX Runtime (the model is CLIP)
#   - three.js + GLTFLoader (dancing 3D models)
#   (dances are already in the repository: extension/assets/dances/dances.glb from AIST++, 100STYLE and CMU;
#   rebuild with scripts/make-dances.py)
#   - music: public domain (PD-India) old Bollywood and CC BY tracks from Wikimedia Commons
# Needs curl, ffmpeg, cwebp (brew install webp) and node (npx @gltf-transform/cli).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
UA="aindu-fetch/0.1"
dl() { # dl URL DEST
  mkdir -p "$(dirname "$2")"
  if [ -s "$2" ]; then echo "  skip $(basename "$2")"; return; fi
  echo "  get  $(basename "$2")"; curl -fsSL --retry 5 --retry-delay 8 --retry-all-errors -A "$UA" -o "$2" "$1"; sleep 2
}

echo "== transformers.js 3.8.1 (версия зафиксирована: ревью AMO сверяет библиотеки с официальным релизом)"
TF="https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist"
for f in transformers.min.js ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm; do
  dl "$TF/$f" "$EXT/vendor/transformers/$f"
done

echo "== three.js"
TV="https://cdn.jsdelivr.net/npm/three@0.170.0"
dl "$TV/build/three.module.min.js" "$EXT/vendor/three/three.module.min.js"
dl "$TV/examples/jsm/loaders/GLTFLoader.js" "$EXT/vendor/three/GLTFLoader.js"
dl "$TV/examples/jsm/utils/BufferGeometryUtils.js" "$EXT/vendor/three/BufferGeometryUtils.js"
dl "$TV/examples/jsm/utils/SkeletonUtils.js" "$EXT/vendor/three/SkeletonUtils.js"
dl "$TV/examples/jsm/libs/meshopt_decoder.module.js" "$EXT/vendor/three/meshopt_decoder.module.js"   # models are meshopt-compressed
# extension pages have no import map, so the bare 'three' import is rewritten to the local file
sed -i '' -e "s#from 'three'#from './three.module.min.js'#" -e "s#from '../utils/BufferGeometryUtils.js'#from './BufferGeometryUtils.js'#" \
  "$EXT/vendor/three/GLTFLoader.js" "$EXT/vendor/three/BufferGeometryUtils.js" "$EXT/vendor/three/SkeletonUtils.js"

echo "== music (Wikimedia Commons)"
RAW="$ROOT/.cache/songs"; mkdir -p "$RAW"
WC="https://upload.wikimedia.org/wikipedia/commons"
dl "$WC/1/18/Babul_%281950%29%2C_sound_track.opus"          "$RAW/babul1950.opus"
dl "$WC/8/85/Bandhan%2C_1940%2C_film_sound_track.ogg"         "$RAW/bandhan1940.ogg"
dl "$WC/9/93/Zindagi_KoSanwarna_HogaIndia.ogg"               "$RAW/alamara1931.ogg"
dl "$WC/f/f5/Naraina_%28ISRC_USUAN1400053%29.mp3"            "$RAW/naraina.mp3"
dl "$WC/6/6d/Tablas_and_Sitars_%28Antti_Luode%29.mp3"        "$RAW/tablas_sitars.mp3"
dl "$WC/f/f2/Lame_Drivers_-_03_-_Bhangra_outro.ogg"          "$RAW/bhangra_outro.ogg"
dl "$WC/6/66/Dhol_Thap_Punjab_Folk.ogg"                      "$RAW/dhol_thap.ogg"
dl "$WC/5/50/Maharashtrian_Dhol_Perform_02.ogg"              "$RAW/dhol_maha.ogg"

SONGS="$EXT/assets/songs"; mkdir -p "$SONGS"
cut() { # cut SRC START DUR DEST: cuts a fragment with fades and encodes it to ogg
  if [ -s "$SONGS/$4" ]; then echo "  skip $4"; return; fi
  echo "  cut  $4"
  ffmpeg -v error -y -ss "$2" -t "$3" -i "$1" -af "afade=t=in:d=1,afade=t=out:st=$(( $3 - 3 )):d=3,loudnorm=I=-16" \
    -ac 2 -ar 44100 -c:a libvorbis -q:a 4 "$SONGS/$4"
}
# Babul (1950): 12 songs by Naushad; windows picked by the musical density of the signal
cut "$RAW/babul1950.opus"   400 120 babul_a.ogg
cut "$RAW/babul1950.opus"  1640 120 babul_b.ogg
cut "$RAW/babul1950.opus"  2330 110 babul_c.ogg
cut "$RAW/bandhan1940.ogg"  280  90 bandhan_a.ogg
cut "$RAW/bandhan1940.ogg"  605  90 bandhan_b.ogg
cut "$RAW/bandhan1940.ogg"  770  90 bandhan_c.ogg
cut "$RAW/alamara1931.ogg"    0 120 alamara.ogg
cut "$RAW/naraina.mp3"        0 210 naraina.ogg
cut "$RAW/tablas_sitars.mp3"  0 180 tablas_sitars.ogg
cut "$RAW/bhangra_outro.ogg"  0 100 bhangra_outro.ogg
cut "$RAW/dhol_thap.ogg"      0  21 dhol_thap.ogg
cut "$RAW/dhol_maha.ogg"      0  60 dhol_maha.ogg


# Jamendo (CC BY / CC BY-SA), found through Openverse; cut to 120 s with fades
JAM="https://prod-1.storage.jamendo.com/?format=mp32&trackid="
dl "$JAM1469399" "$RAW/reggaeton_bhangra.mp3"; cut "$RAW/reggaeton_bhangra.mp3" 0 120 reggaeton_bhangra.ogg
dl "$JAM730383" "$RAW/bollywood_snuff.mp3"; cut "$RAW/bollywood_snuff.mp3" 0 120 bollywood_snuff.ogg
dl "$JAM1030598" "$RAW/bollywood_hasenchat.mp3"; cut "$RAW/bollywood_hasenchat.mp3" 0 120 bollywood_hasenchat.ogg
dl "$JAM530764" "$RAW/bollywood_onac.mp3"; cut "$RAW/bollywood_onac.mp3" 0 120 bollywood_onac.ogg
dl "$JAM178481" "$RAW/india_funk.mp3"; cut "$RAW/india_funk.mp3" 0 120 india_funk.ogg
dl "$JAM543780" "$RAW/india_club_mix.mp3"; cut "$RAW/india_club_mix.mp3" 0 120 india_club_mix.ogg
dl "$JAM956165" "$RAW/tabla_beatz.mp3"; cut "$RAW/tabla_beatz.mp3" 0 120 tabla_beatz.ogg
dl "$JAM1241685" "$RAW/mumbai_fusion.mp3"; cut "$RAW/mumbai_fusion.mp3" 0 120 mumbai_fusion.ogg
dl "$JAM1469394" "$RAW/drunk_desi_dub.mp3"; cut "$RAW/drunk_desi_dub.mp3" 0 120 drunk_desi_dub.ogg
dl "$JAM676057" "$RAW/sitar_wars.mp3"; cut "$RAW/sitar_wars.mp3" 0 120 sitar_wars.ogg


# Freesound (CC BY / CC0), found through Openverse
dl "https://cdn.freesound.org/previews/182/182540_1859932-hq.mp3" "$RAW/fs_bhangra1.mp3"; cut "$RAW/fs_bhangra1.mp3" 0 23 fs_bhangra1.ogg
dl "https://cdn.freesound.org/previews/182/182537_1859932-hq.mp3" "$RAW/fs_bhangra4.mp3"; cut "$RAW/fs_bhangra4.mp3" 0 33 fs_bhangra4.ogg
dl "https://cdn.freesound.org/previews/182/182538_1859932-hq.mp3" "$RAW/fs_bhangra3.mp3"; cut "$RAW/fs_bhangra3.mp3" 0 120 fs_bhangra3.ogg
dl "https://cdn.freesound.org/previews/169/169109_2681262-hq.mp3" "$RAW/fs_dhol_bounce.mp3"; cut "$RAW/fs_dhol_bounce.mp3" 0 120 fs_dhol_bounce.ogg
dl "https://cdn.freesound.org/previews/94/94001_43-hq.mp3" "$RAW/fs_udaipur1.mp3"; cut "$RAW/fs_udaipur1.mp3" 0 81 fs_udaipur1.ogg
dl "https://cdn.freesound.org/previews/94/94004_43-hq.mp3" "$RAW/fs_udaipur4.mp3"; cut "$RAW/fs_udaipur4.mp3" 0 79 fs_udaipur4.ogg
dl "https://cdn.freesound.org/previews/94/94003_43-hq.mp3" "$RAW/fs_udaipur3.mp3"; cut "$RAW/fs_udaipur3.mp3" 0 120 fs_udaipur3.ogg
dl "https://cdn.freesound.org/previews/257/257759_2474372-hq.mp3" "$RAW/fs_procession.mp3"; cut "$RAW/fs_procession.mp3" 0 97 fs_procession.ogg
dl "https://cdn.freesound.org/previews/272/272178_2881353-hq.mp3" "$RAW/fs_holi_goa.mp3"; cut "$RAW/fs_holi_goa.mp3" 0 82 fs_holi_goa.ogg

echo "== сжатие моделей, если они есть (meshopt + WebP; оригиналы — в assets-src/, нужен cwebp: brew install webp)"
[ -d "$EXT/assets/models/people" ] && python3 "$ROOT/scripts/compress-models.py" || echo "  моделей со Sketchfab нет — танцуют манекены"

echo "== done"; du -sh "$EXT/vendor" "$EXT/assets"
