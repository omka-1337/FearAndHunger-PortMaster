#!/bin/bash
# Builds the distributable PortMaster archive.
# Ships the engine only, never the game's own files.
#
# The repository is laid out the way a PortMaster submission directory is:
# metadata at the top level, engine in fearandhunger/. A released port's zip puts
# that metadata inside the port folder instead, so this stages the files into
# that shape before zipping.
set -euo pipefail

cd "$(dirname "$(realpath "$0")")"

for f in fearandhunger/www fearandhunger/Game.exe fearandhunger/package.nw; do
  if [ -e "$f" ]; then
    echo "ERROR: $f is present. The release must not contain game files."
    exit 1
  fi
done

if [ ! -x fearandhunger/nwjs/nw ]; then
  echo "ERROR: the NW.js runtime is missing. Run ./fetch-runtime.sh first."
  exit 1
fi

if [ ! -f fearandhunger/libs.aarch64/libnss3.so ]; then
  echo "ERROR: the system libraries are missing. Run ./fetch-libs.sh first."
  exit 1
fi

if [ ! -x fearandhunger/tools/aarch64/oggenc ]; then
  echo "ERROR: the audio tools are missing. Run ./fetch-tools.sh first."
  exit 1
fi

rm -rf dist
mkdir -p dist/stage/fearandhunger

cp "Fear & Hunger.sh" dist/stage/
cp port.json README.md PERFORMANCE.md LICENSE gameinfo.xml screenshot.png dist/stage/fearandhunger/
cp fearandhunger/libs.aarch64-README.txt dist/stage/fearandhunger/libs.aarch64/README.txt 2>/dev/null || true
[ -f cover.png ] && cp cover.png dist/stage/fearandhunger/ || true
cp -r fearandhunger/. dist/stage/fearandhunger/
rm -rf dist/stage/fearandhunger/userdata dist/stage/fearandhunger/www
rm -rf dist/stage/fearandhunger/tools/__pycache__
rm -f dist/stage/fearandhunger/log.txt dist/stage/fearandhunger/log-game.txt

python3 - <<'PY'
import os, stat, zipfile

OUT = "dist/fearandhunger.zip"
entries = []
for root, dirs, files in os.walk("dist/stage"):
    for f in sorted(files):
        entries.append(os.path.join(root, f))

# The launcher, the engine and the tools have to come out of the zip executable.
def executable(arc):
    return (arc.endswith(".sh") or arc.endswith(".py")
            or arc.endswith("/nwjs/nw") or arc.endswith(".so")
            or "/nwjs/lib/" in arc or "/tools/aarch64/ogg" in arc)

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(entries):
        arc = os.path.relpath(p, "dist/stage")
        zi = zipfile.ZipInfo.from_file(p, arc)
        mode = os.stat(p).st_mode
        if executable(arc):
            mode |= stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        zi.external_attr = (mode & 0xFFFF) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(p, "rb") as fh:
            z.writestr(zi, fh.read())

print(f"Built {OUT}  ({os.path.getsize(OUT)/1048576:.1f} MB, {len(entries)} files)")
PY

rm -rf dist/stage
