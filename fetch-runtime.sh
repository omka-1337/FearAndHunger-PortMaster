#!/bin/bash
# Fetches the NW.js aarch64 runtime into fearandhunger/nwjs/ and strips what this
# port cannot use. The runtime is not in git: libnw.so alone is 283 MB, well past
# what GitHub accepts in a file, so it is fetched at build time instead.
set -euo pipefail

VERSION="v0.117.0"
SHA256="7d8cc1891ada76aa1d0e121e237ad7627182fd6fd5ae92ac2e2bafb708962f9c"
URL="https://dl.nwjs.io/${VERSION}/nwjs-${VERSION}-linux-arm64.tar.gz"

cd "$(dirname "$(realpath "$0")")"
DEST="fearandhunger/nwjs"

if [ -x "$DEST/nw" ] && [ "${1:-}" != "--force" ]; then
  echo "Runtime already in $DEST (use --force to refetch)."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Fetching NW.js ${VERSION} for aarch64..."
curl -fL --progress-bar -o "$TMP/nwjs.tar.gz" "$URL"

echo "$SHA256  $TMP/nwjs.tar.gz" | sha256sum -c - || {
  echo "Checksum mismatch. Refusing to ship an unverified runtime."
  exit 1
}

tar xzf "$TMP/nwjs.tar.gz" -C "$TMP"
SRC="$TMP/nwjs-${VERSION}-linux-arm64"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/

# 228 locale packs for a game that only speaks English.
find "$DEST/locales" -type f ! -name 'en-US.pak*' -delete

# The software rasteriser is 18 MB of code that could never run this game at a
# playable rate, and the port deliberately fails loudly instead of falling back
# to it. The high-dpi asset pack and the crash reporter go too.
rm -f "$DEST/lib/libvk_swiftshader.so" "$DEST/lib/libvulkan.so.1" \
      "$DEST/lib/vk_swiftshader_icd.json" "$DEST/nw_200_percent.pak"
rm -rf "$DEST/swiftshader"

# chrome_crashpad_handler stays. Chromium 154 spawns it during startup whatever
# --disable-crash-reporter says, and dies with a FATAL if it is not there.
chmod +x "$DEST/nw" "$DEST/chrome_crashpad_handler"

echo "Runtime ready: $(du -sh "$DEST" | cut -f1)"
