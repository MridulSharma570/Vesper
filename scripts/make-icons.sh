#!/usr/bin/env bash
# Renders the Vesper mark at any size using ImageMagick draw primitives.
#
# Why not just rasterise the SVG: ImageMagick's built-in MSVG renderer ignores
# <defs> gradients referenced by fill, which produced a black tile. Drawing the
# mark directly gives identical output here and on a CI machine with no SVG
# delegate, and the store icons must be pixel-exact.
#
# Usage: make-icons.sh <size> <out.png> [maskable]
#   maskable  = full-bleed background (no rounded-corner alpha) for Android
#               adaptive / PWA maskable icons, per W3C appmanifest icon purpose.
set -euo pipefail

SIZE="${1:-512}"
OUT="${2:-icon-${SIZE}.png}"
MASKABLE="${3:-}"
S="$SIZE"

# Rotating a square 45deg shrinks its inscribed square to 0.707*S, so cropping
# SxS from a rotated SxS gradient leaves transparent corners (a diamond).
# Render the gradient at 2*S first, then rotate and centre-crop SxS: full bleed.
T=$((S * 2))

# Proportions are fractions of the canvas so every size is the same drawing.
cx=$((S/2)); cy=$((S/2))
dot=$((S*34/512))
r1=$((S*86/512));  r2=$((S*140/512))
w=$((S*23/512))    # stroke width

box1="$((cx-r1)),$((cy-r1)) $((cx+r1)),$((cy+r1))"
box2="$((cx-r2)),$((cy-r2)) $((cx+r2)),$((cy+r2))"

# 1. Diagonal gradient, masked to a rounded square (unless maskable).
# NB: +repage right after -rotate is load-bearing: rotation leaves a negative
# page offset (e.g. 546x546-81-81) which would skew the gravity-centred crop
# into the white background corners.
magick -size "${T}x${T}" gradient:'#8b93ff-#3f3dbb' -rotate 45 +repage \
       -gravity center -crop "${S}x${S}+0+0" +repage grad.png
if [ -n "$MASKABLE" ]; then
  cp grad.png base.png
else
  magick -size "${S}x${S}" xc:none -fill white \
    -draw "roundrectangle 0,0 $((S-1)),$((S-1)) $((S*80/512)),$((S*80/512))" mask.png
  magick grad.png mask.png -alpha off -compose CopyOpacity -composite base.png
fi

# 2. The mark: centre dot plus two concentric parenthesis pairs.
magick base.png \
  -stroke white -strokewidth "$w" -fill none \
  -draw "stroke-linecap round arc ${box1} -42,42"  -draw "stroke-linecap round arc ${box1} 138,222" \
  -strokewidth "$((w*80/100))" \
  -draw "stroke-linecap round arc ${box2} -46,46" -draw "stroke-linecap round arc ${box2} 134,226" \
  -stroke none -fill white \
  -draw "circle ${cx},${cy} $((cx+dot)),${cy}" \
  "$OUT"

rm -f grad.png mask.png base.png
