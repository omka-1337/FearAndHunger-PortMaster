#!/bin/bash
# Builds fearandhunger/libs.aarch64/ from stock Debian bookworm arm64 packages.
#
# NW.js is Chromium, and Chromium links against a good deal more of a desktop
# system than handheld firmware carries. On KNULLI (RG40XX-V, gladiator-ii) all
# sixteen libraries it asks for are absent outright - X11, NSS, ATK, AT-SPI,
# CUPS, GBM and xkbcommon - so the port brings them, along with everything they
# pull in. Nothing here is patched: these are the distribution's own binaries.
#
# Bookworm carries glibc 2.36 and the device reports 2.40. glibc is backward
# compatible, so binaries built against the older one run against the newer, and
# not the other way round - which is why this does not use a current Debian.
#
# The libraries that the device does have, and that these depend on, are left
# well alone: glib, gobject, gio, cairo, pango, dbus, expat, udev and alsa stay
# the firmware's own, because overriding those is how you break a system.
set -euo pipefail

cd "$(dirname "$(realpath "$0")")"
DEST="fearandhunger/libs.aarch64"

if [ -f "$DEST/libnss3.so" ] && [ "${1:-}" != "--force" ]; then
  echo "Libraries already in $DEST (use --force to rebuild)."
  exit 0
fi

for tool in curl ar tar readelf; do
  command -v "$tool" >/dev/null || { echo "need $tool on PATH"; exit 1; }
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/urls.txt" <<'URLS'
https://deb.debian.org/debian/pool/main/a/at-spi2-core/libatk1.0-0_2.46.0-5_arm64.deb
https://deb.debian.org/debian/pool/main/a/at-spi2-core/libatspi2.0-0_2.46.0-5_arm64.deb
https://deb.debian.org/debian/pool/main/a/avahi/libavahi-client3_0.8-10+deb12u1_arm64.deb
https://deb.debian.org/debian/pool/main/a/avahi/libavahi-common3_0.8-10+deb12u1_arm64.deb
https://deb.debian.org/debian/pool/main/c/cups/libcups2_2.4.2-3+deb12u9_arm64.deb
https://deb.debian.org/debian/pool/main/e/e2fsprogs/libcom-err2_1.47.0-2+b2_arm64.deb
https://deb.debian.org/debian/pool/main/g/gmp/libgmp10_6.2.1+dfsg1-1.1_arm64.deb
https://deb.debian.org/debian/pool/main/g/gnutls28/libgnutls30_3.7.9-2+deb12u7_arm64.deb
https://deb.debian.org/debian/pool/main/k/keyutils/libkeyutils1_1.6.3-2_arm64.deb
https://deb.debian.org/debian/pool/main/k/krb5/libgssapi-krb5-2_1.20.1-2+deb12u5_arm64.deb
https://deb.debian.org/debian/pool/main/k/krb5/libk5crypto3_1.20.1-2+deb12u5_arm64.deb
https://deb.debian.org/debian/pool/main/k/krb5/libkrb5-3_1.20.1-2+deb12u5_arm64.deb
https://deb.debian.org/debian/pool/main/k/krb5/libkrb5support0_1.20.1-2+deb12u5_arm64.deb
https://deb.debian.org/debian/pool/main/libb/libbsd/libbsd0_0.11.7-2_arm64.deb
https://deb.debian.org/debian/pool/main/libd/libdrm/libdrm2_2.4.114-1+b1_arm64.deb
https://deb.debian.org/debian/pool/main/libf/libffi/libffi8_3.4.4-1_arm64.deb
https://deb.debian.org/debian/pool/main/libi/libidn2/libidn2-0_2.3.3-1+b1_arm64.deb
https://deb.debian.org/debian/pool/main/libm/libmd/libmd0_1.0.4-2_arm64.deb
https://deb.debian.org/debian/pool/main/libt/libtasn1-6/libtasn1-6_4.19.0-2+deb12u1_arm64.deb
https://deb.debian.org/debian/pool/main/libu/libunistring/libunistring2_1.0-2_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libx11/libx11-6_1.8.4-2+deb12u2_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxau/libxau6_1.0.9-1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxcb/libxcb1_1.15-1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxcomposite/libxcomposite1_0.4.5-1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxdamage/libxdamage1_1.1.6-1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxdmcp/libxdmcp6_1.1.2-3_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxext/libxext6_1.3.4-1+b1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxfixes/libxfixes3_6.0.0-2_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxi/libxi6_1.8-1+b1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxinerama/libxinerama1_1.1.4-3_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxkbcommon/libxkbcommon0_1.5.0-1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxrandr/libxrandr2_1.5.2-2+b1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxrender/libxrender1_0.9.10-1.1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxshmfence/libxshmfence1_1.3-1_arm64.deb
https://deb.debian.org/debian/pool/main/libx/libxtst/libxtst6_1.2.3-1.1_arm64.deb
https://deb.debian.org/debian/pool/main/m/mesa/libgbm1_22.3.6-1+deb12u2_arm64.deb
https://deb.debian.org/debian/pool/main/n/nettle/libhogweed6_3.8.1-2_arm64.deb
https://deb.debian.org/debian/pool/main/n/nettle/libnettle8_3.8.1-2_arm64.deb
https://deb.debian.org/debian/pool/main/n/nspr/libnspr4_4.35-1_arm64.deb
https://deb.debian.org/debian/pool/main/n/nss/libnss3_3.87.1-1+deb12u2_arm64.deb
https://deb.debian.org/debian/pool/main/o/openssl/libssl3_3.0.20-1~deb12u2_arm64.deb
https://deb.debian.org/debian/pool/main/p/p11-kit/libp11-kit0_0.24.1-2_arm64.deb
https://deb.debian.org/debian/pool/main/s/sqlite3/libsqlite3-0_3.40.1-2+deb12u2_arm64.deb
https://deb.debian.org/debian/pool/main/w/wayland/libwayland-server0_1.21.0-1_arm64.deb
https://deb.debian.org/debian/pool/main/z/zlib/zlib1g_1.2.13.dfsg-1_arm64.deb
URLS

echo "Fetching $(wc -l < "$TMP/urls.txt") packages from Debian..."
mkdir -p "$TMP/debs" "$TMP/extract"
(cd "$TMP/debs" && xargs -n1 -P8 curl -sfLO < "$TMP/urls.txt")

for deb in "$TMP/debs"/*.deb; do
  ar p "$deb" data.tar.xz 2>/dev/null | tar -xJ -C "$TMP/extract" 2>/dev/null ||
  ar p "$deb" data.tar.zst 2>/dev/null | tar --zstd -xf - -C "$TMP/extract" 2>/dev/null ||
  { echo "could not unpack $(basename "$deb")"; exit 1; }
done

# Debian ships each library under its versioned name with a chain of symlinks.
# The loader looks it up by SONAME, so flatten to that and drop the links.
rm -rf "$DEST"
mkdir -p "$DEST"
python3 - "$TMP/extract" "$DEST" <<'PY'
import os, re, shutil, subprocess, sys

src, dst = sys.argv[1], sys.argv[2]

def soname(path):
    out = subprocess.run(['readelf', '-d', '-W', path], capture_output=True, text=True).stdout
    m = re.search(r'SONAME\).*\[(.+?)\]', out)
    return m.group(1) if m else None

copied = 0
for root, _, files in os.walk(src):
    for name in files:
        path = os.path.join(root, name)
        if os.path.islink(path) or '.so' not in name:
            continue
        sn = soname(path)
        if not sn or os.path.exists(os.path.join(dst, sn)):
            continue
        shutil.copy2(path, os.path.join(dst, sn))
        copied += 1
print(f'{copied} libraries')
PY

# Anything the bundle still needs had better be on the device already. Say what
# those are, so a firmware without them is a diagnosis rather than a mystery.
python3 - "$DEST" <<'PY'
import os, re, subprocess, sys
dst = sys.argv[1]
have = set(os.listdir(dst))
base = {'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1',
        'libgcc_s.so.1', 'libresolv.so.2', 'ld-linux-aarch64.so.1'}
need = set()
for lib in have:
    out = subprocess.run(['readelf', '-d', '-W', os.path.join(dst, lib)],
                         capture_output=True, text=True).stdout
    need |= set(re.findall(r'NEEDED\).*\[(.+?)\]', out))
outside = sorted(need - have - base)
print('Expected from the firmware: ' + ', '.join(outside))
PY

cp fearandhunger/libs.aarch64-README.txt "$DEST/README.txt" 2>/dev/null || true

# Several of these are LGPL and one is MPL, so where each binary came from has to
# travel with it. The urls list is the authoritative answer: it names the Debian
# source package and version of every file in the folder.
{
  echo "Libraries NW.js needs that handheld firmware does not ship."
  echo
  echo "Stock Debian bookworm arm64 binaries, unmodified. Bookworm carries glibc 2.36"
  echo "and these devices report 2.40; glibc is backward compatible, so binaries built"
  echo "against the older one run against the newer and not the other way round."
  echo
  echo "Rebuild this folder with ./fetch-libs.sh. Source packages, in Debian's pool:"
  echo
  sed 's|^https://deb.debian.org/debian/|  |' "$TMP/urls.txt" | sort
  echo
  echo "Contents:"
  echo
  for f in $(ls "$DEST" | grep -v '\.txt$' | sort); do
    printf '  %-34s %7s KB\n' "$f" "$(( $(stat -c%s "$DEST/$f") / 1024 ))"
  done
} > "$DEST/MANIFEST.txt"

echo "Done: $(du -sh "$DEST" | cut -f1) in $DEST, manifest written"
