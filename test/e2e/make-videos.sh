#!/usr/bin/env bash
# Turns the test images into 12-second vertical webm files (VP9, since Playwright's Chromium has no H.264).
set -euo pipefail
cd "$(dirname "$0")/media"
for n in bhangra bollywood cat portrait arab georgian family; do
  [ -s "$n.webm" ] && { echo "skip $n.webm"; continue; }
  [ -s "$n.jpg" ] || { echo "no $n.jpg"; continue; }
  ffmpeg -v error -y -loop 1 -i "$n.jpg" -t 12 -r 15 \
    -vf "scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p" \
    -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 "$n.webm" && echo "made $n.webm"
done

# mixed reel for the real-time check: cat 4 s -> bollywood 6 s -> cat 6 s
if [ ! -s mixed.webm ]; then
  V="scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,fps=15"
  ffmpeg -v error -y -loop 1 -t 4 -i cat.jpg -loop 1 -t 6 -i bollywood.jpg -loop 1 -t 6 -i cat.jpg \
    -filter_complex "[0:v]$V[a];[1:v]$V[b];[2:v]$V[c];[a][b][c]concat=n=3:v=1:a=0[v]" -map "[v]" \
    -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 mixed.webm && echo "made mixed.webm"
fi
