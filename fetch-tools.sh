#!/bin/bash
# Builds fearandhunger/tools/aarch64/: the Ogg Vorbis decoder and encoder the
# first launch uses to shrink the game's music on the handheld itself.
#
# The game needs its music and ambience folded to mono to fit in 1 GB, and the
# launcher does that before the first start (tools/optimize_audio.py). Firmware
# cannot be counted on for an encoder, so the port carries oggdec and oggenc from
# vorbis-tools and the five libraries they link: libogg, libvorbis, libvorbisenc,
# libvorbisfile and libFLAC. About a megabyte in all, nothing else needed.
#
# They come from Ubuntu 22.04's arm64 archive, unmodified, pinned by SHA-256. The
# binaries ask for nothing newer than glibc 2.34 and the devices report 2.40. They
# sit in their own folder rather than in libs.aarch64/ because only the converter
# needs them: it hands them that folder as LD_LIBRARY_PATH and nothing else ever
# loads them.
set -euo pipefail

cd "$(dirname "$(realpath "$0")")"
DEST="fearandhunger/tools/aarch64"
POOL="https://ports.ubuntu.com/ubuntu-ports/pool"

if [ -x "$DEST/oggdec" ] && [ -x "$DEST/oggenc" ] && [ "${1:-}" != "--force" ]; then
  echo "Audio tools already in $DEST (use --force to rebuild)."
  exit 0
fi

for tool in curl ar tar zstd sha256sum readelf; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH"; exit 1; }
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/pins.txt" <<'PINS'
7443b2da405bf6d6b21c5543cfc5ce9404bdd64f5763d0fa19eb85cf518715aa  universe/v/vorbis-tools/vorbis-tools_1.4.2-1_arm64.deb
6072fff3bdc02037b2cc4dd5ee421bdb5a656eb2f70563e940fb0d967ee70332  main/libo/libogg/libogg0_1.3.5-0ubuntu3_arm64.deb
bf1b1c79b8953e077c19fc1015972b2f8e16521e41d4596e2f7e3d91811ea4d0  main/libv/libvorbis/libvorbis0a_1.3.7-1build2_arm64.deb
b9ce841fed071fadd460971fb835dff9c859b18ad11eff0518b76159bd8193ef  main/libv/libvorbis/libvorbisenc2_1.3.7-1build2_arm64.deb
56cebf5da54aee5e0de0a5b638b9af78bb2bdca97defaff4053bb30326054182  main/libv/libvorbis/libvorbisfile3_1.3.7-1build2_arm64.deb
65e7a3da61f2f868befc17dc983bdfae3139a8bd348e086a0e053bb3d9b2747d  main/f/flac/libflac8_1.3.3-2ubuntu0.2_arm64.deb
PINS

echo "Fetching $(wc -l < "$TMP/pins.txt") packages from Ubuntu..."
mkdir -p "$TMP/debs" "$TMP/extract"
while read -r sum path; do
  deb="$TMP/debs/$(basename "$path")"
  curl -sfL -o "$deb" "$POOL/$path" || { echo "could not fetch $path"; exit 1; }
  echo "$sum  $deb" | sha256sum -c --quiet - || { echo "checksum mismatch: $path"; exit 1; }
  ar p "$deb" data.tar.zst 2>/dev/null | tar --zstd -xf - -C "$TMP/extract" 2>/dev/null ||
  ar p "$deb" data.tar.xz 2>/dev/null | tar -xJ -C "$TMP/extract" 2>/dev/null ||
  { echo "could not unpack $(basename "$deb")"; exit 1; }
done < "$TMP/pins.txt"

rm -rf "$DEST"
mkdir -p "$DEST/copyright"
install -m 755 "$TMP/extract/usr/bin/oggdec" "$TMP/extract/usr/bin/oggenc" "$DEST/"
for lib in libogg.so.0 libvorbis.so.0 libvorbisenc.so.2 libvorbisfile.so.3 libFLAC.so.8; do
  cp -L "$TMP/extract/usr/lib/aarch64-linux-gnu/$lib" "$DEST/"
done
for doc in "$TMP/extract/usr/share/doc"/*/copyright; do
  cp "$doc" "$DEST/copyright/$(basename "$(dirname "$doc")")"
done

# Everything these link against must be in the folder or be glibc itself, or
# the first launch would find out the hard way.
MISSING=$(for f in "$DEST"/oggdec "$DEST"/oggenc "$DEST"/*.so.*; do
            readelf -d -W "$f" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'
          done | sort -u | grep -vxE 'libc\.so\.6|libm\.so\.6|ld-linux-aarch64\.so\.1' |
          while read -r lib; do [ -e "$DEST/$lib" ] || echo "$lib"; done)
if [ -n "$MISSING" ]; then
  echo "Not bundled, and not glibc: $MISSING"
  exit 1
fi

# vorbis-tools is GPL, so where these binaries came from travels with them.
{
  echo "The Ogg Vorbis decoder and encoder the first launch uses to shrink the game's"
  echo "music, and the libraries they link. tools/optimize_audio.py runs them with this"
  echo "folder as LD_LIBRARY_PATH; nothing else loads them."
  echo
  echo "Stock Ubuntu 22.04 arm64 binaries, unmodified. vorbis-tools is GPL-2; libogg,"
  echo "libvorbis and libFLAC are BSD-style. Their copyright files are in copyright/."
  echo
  echo "Rebuild this folder with ./fetch-tools.sh. Source packages, in Ubuntu's pool"
  echo "at $POOL/:"
  echo
  awk '{print "  " $2}' "$TMP/pins.txt" | sort
  echo
  echo "Contents:"
  echo
  for f in $(ls "$DEST" | grep -v -e '\.txt$' -e '^copyright$' | sort); do
    printf '  %-34s %7s KB\n' "$f" "$(( $(stat -c%s "$DEST/$f") / 1024 ))"
  done
} > "$DEST/MANIFEST.txt"

echo "Done: $(du -sh "$DEST" | cut -f1) in $DEST, manifest written"
