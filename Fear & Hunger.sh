#!/bin/bash

XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}

if [ -d "/opt/system/Tools/PortMaster/" ]; then
  controlfolder="/opt/system/Tools/PortMaster"
elif [ -d "/opt/tools/PortMaster/" ]; then
  controlfolder="/opt/tools/PortMaster"
elif [ -d "$XDG_DATA_HOME/PortMaster/" ]; then
  controlfolder="$XDG_DATA_HOME/PortMaster"
else
  controlfolder="/roms/ports/PortMaster"
fi

source $controlfolder/control.txt
[ -f "${controlfolder}/mod_${CFW_NAME}.txt" ] && source "${controlfolder}/mod_${CFW_NAME}.txt"
get_controls

GAMEDIR=/$directory/ports/fearandhunger
BINARY="$GAMEDIR/nwjs/nw"

cd $GAMEDIR

> "$GAMEDIR/log.txt" && exec > >(tee "$GAMEDIR/log.txt") 2>&1

# The game is a paid title, so its files are user supplied.
if [ ! -f "$GAMEDIR/www/index.html" ] || [ ! -f "$GAMEDIR/www/js/rpg_core.js" ]; then
  echo "Game files not found. See README.md for how to supply them."
  echo "Expected: $GAMEDIR/www/ (the www folder from your own installation)"
  sleep 5
  exit 1
fi

# NW.js is Chromium, so it wants a good deal more of the system than a normal
# port does. Name what is missing rather than dying with a blank screen. The
# dynamic loader does this for us, no ldd needed.
FIRMWARE_LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="$GAMEDIR/libs.aarch64:$GAMEDIR/nwjs/lib:$LD_LIBRARY_PATH"
# nw carries an RPATH of $ORIGIN/lib, so tracing it covers libnw.so and everything
# below it. libnw.so itself has no interpreter and cannot be traced directly, which
# would make this check quietly pass while the engine is unrunnable.
TRACE=$(LD_TRACE_LOADED_OBJECTS=1 "$BINARY" 2>&1)
if [ -z "$TRACE" ]; then
  echo "Could not inspect the engine. Is $BINARY present and executable?"
  sleep 5
  exit 1
fi
MISSING=$(echo "$TRACE" | grep "not found" | awk '{print $1}' | sort -u)
if [ -n "$MISSING" ]; then
  echo "This device is missing libraries the engine needs:"
  echo "$MISSING" | sed 's/^/  /'
  echo ""
  echo "Drop aarch64 builds of them into $GAMEDIR/libs.aarch64/ and run again."
  echo "Please also report the list, it belongs in the port."
  sleep 10
  exit 1
fi

# Chromium can only draw through X11, Wayland or DRM/KMS. Some firmware drives
# the panel through the framebuffer with Arm's mali_kbase blob instead, which
# deliberately exposes no DRM API - KNULLI on the Allwinner H700 is one, kernel
# 4.9 with /dev/mali0 and /dev/fb0 and no /dev/dri at all. No compositor can run
# there, so neither can this engine. Say so in a sentence rather than letting
# Chromium abort with a stack trace.
if [ ! -d /dev/dri ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
  echo "This firmware has no DRM/KMS graphics (/dev/dri is missing) and no display"
  echo "server. The engine is Chromium, which cannot draw to a bare framebuffer."
  echo ""
  echo "This is the device's graphics stack, not the port: on the same hardware a"
  echo "firmware with a mainline kernel and Panfrost (ROCKNIX, for instance) does"
  echo "provide /dev/dri, and the port works there."
  sleep 10
  exit 1
fi

# The game holds every track it plays fully decoded in memory, and its longest
# ambience is 109 MB of that by itself. patch.js decodes at 22050 Hz, which
# halves it; tools/optimize_audio.py re-encodes the music and ambience to mono
# with the oggdec and oggenc in tools/aarch64, which halves it again. The first
# launch does the work, a few minutes of it, and rewrites those tracks in www/
# for good; every launch after that finds each one already done and is back in
# a moment. The script prints only when there is work to show, so PortMaster's
# message window opens on that first launch and stays shut on the rest.
# python3 is the firmware's own - PortMaster runs on it - and gets the
# firmware's libraries: libs.aarch64 carries a zlib, libffi and openssl older
# than the ones it may have been built against.
if command -v python3 >/dev/null 2>&1; then
  while IFS= read -r line; do
    if type pm_message >/dev/null 2>&1; then
      pm_message "$line"
    else
      echo "$line"
    fi
  done < <(LD_LIBRARY_PATH="$FIRMWARE_LD_LIBRARY_PATH" \
             python3 -u "$GAMEDIR/tools/optimize_audio.py" "$GAMEDIR/www/audio" --inplace)
else
  echo "No python3 on this device, so the music stays stereo and takes twice the"
  echo "memory it needs. The game will run, with far less room to run in."
fi

# Give the kernel somewhere to put compressed memory. Without swap its only way
# to free a page is to drop a clean file-backed one - which here means the engine's
# own code - and then read it back off the SD card at the next instruction. On an
# RG40XX V that cost 1.5 GB of reads in ninety seconds and took the dungeons down
# to half a frame per second. With 1 GB of zstd zram the same scene ran at 13-18.
# The zram module is not loaded on a fresh boot, and without it
# /sys/class/zram-control does not exist and the block below is skipped in
# silence - which is how a device ends up back at half a frame per second with
# nobody noticing it had ever been faster.
if [ "$(awk 'NR>1 {found=1} END {print found+0}' /proc/swaps)" = "0" ] && [ ! -e /sys/class/zram-control/hot_add ]; then
  modprobe zram 2>/dev/null
fi

if [ "$(awk 'NR>1 {found=1} END {print found+0}' /proc/swaps)" = "0" ] && [ -e /sys/class/zram-control/hot_add ]; then
  ZRAM_ID=$(cat /sys/class/zram-control/hot_add 2>/dev/null)
  if [ -n "$ZRAM_ID" ] && [ -b "/dev/zram${ZRAM_ID}" ]; then
    echo zstd > "/sys/block/zram${ZRAM_ID}/comp_algorithm" 2>/dev/null
    if echo 1024M > "/sys/block/zram${ZRAM_ID}/disksize" 2>/dev/null &&
       mkswap "/dev/zram${ZRAM_ID}" >/dev/null 2>&1 &&
       swapon -p 100 "/dev/zram${ZRAM_ID}" 2>/dev/null; then
      echo "zram swap enabled on /dev/zram${ZRAM_ID} (1 GB, zstd)"
      FNH_ZRAM="$ZRAM_ID"
    fi
  fi
fi

if [ "$(awk 'NR>1 {found=1} END {print found+0}' /proc/swaps)" = "0" ]; then
  echo "WARNING: no swap could be set up. Expect the dungeons to crawl: with"
  echo "nowhere to compress memory this device pages the engine's own code off"
  echo "the SD card while you play."
fi

# What the firmware is clocking this at. Read only, and in the log rather than in
# a decision: a port that sets governors behind the firmware's back is a port that
# gets asked why. If these say powersave while the frame rate is poor, that is
# worth knowing before anything else is blamed.
for POL in /sys/devices/system/cpu/cpufreq/policy*; do
  [ -d "$POL" ] || continue
  echo "cpu $(basename "$POL"): governor=$(cat "$POL/scaling_governor" 2>/dev/null) cur=$(cat "$POL/scaling_cur_freq" 2>/dev/null) max=$(cat "$POL/cpuinfo_max_freq" 2>/dev/null)"
done
for DEV in /sys/class/devfreq/*; do
  [ -d "$DEV" ] || continue
  echo "gpu $(basename "$DEV"): governor=$(cat "$DEV/governor" 2>/dev/null) cur=$(cat "$DEV/cur_freq" 2>/dev/null) max=$(cat "$DEV/max_freq" 2>/dev/null)"
done

# Chromium's profile cannot live on the SD card. It takes a process-wide lock by
# creating SingletonLock as a symlink, and exFAT has no symlinks, so the attempt
# fails with ENOSYS and Chromium aborts rather than risk a corrupt profile. None
# of it is worth keeping between runs - saves go to www/save - so put it on tmpfs
# and cap the caches, because that tmpfs is this device's one gigabyte of RAM.
# FNH_PROFILE is patch.js's own profiler switch, so this one is spelled out in
# full: setting FNH_PROFILE=1 to turn the profiler on used to make Chromium put
# its profile in a directory called "1".
PROFILE="${FNH_PROFILE_DIR:-/tmp/fearandhunger-profile}"
rm -rf "$PROFILE"
mkdir -p "$PROFILE" "$GAMEDIR/www/save"

# Which display stack to drive. Weston on KNULLI and sway on ROCKNIX are both
# wayland; X11 devices fall through to the second branch.
# Find the compositor. Launched from the frontend these are inherited, but over
# ssh they are not, and ROCKNIX puts its socket somewhere of its own
# (/run/0-runtime-dir/wayland-1) rather than the usual /run/user/<uid>.
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  for dir in "${XDG_RUNTIME_DIR:-}" "/run/user/$(id -u)" /run/0-runtime-dir /var/run /run /tmp; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    for sock in "$dir"/wayland-*; do
      case "$sock" in *.lock) continue ;; esac
      [ -S "$sock" ] || continue
      export XDG_RUNTIME_DIR="$dir"
      export WAYLAND_DISPLAY="$(basename "$sock")"
      break 2
    done
  done
fi

if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  OZONE="--ozone-platform=wayland"
elif [ -n "${DISPLAY:-}" ]; then
  OZONE="--ozone-platform=x11"
else
  # Not drm: that ozone backend is a ChromeOS build option and is not compiled
  # into the public NW.js binaries, so asking for it is a FATAL, not a fallback.
  echo "No display server found: no wayland socket and no X11 DISPLAY."
  echo "The engine is Chromium and needs one of the two to put a window on."
  sleep 10
  exit 1
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"

# ANGLE on top of native GLES is the right path for Mali. If the screen stays
# black, try --use-angle=gl, and if that fails too, drop the flag entirely.
# The software rasteriser is deliberately not shipped: this game core dumps on
# the canvas renderer, so a device without working GLES cannot run it anyway.
GL_ARGS="${FNH_GL_ARGS:---use-angle=gles}"

# The graphics stack is the firmware's own, and these three have to be as well.
# libgbm loads the firmware's Mesa driver, and the two only work as a pair from
# one Mesa build; libdrm and libwayland-server sit underneath it. libs.aarch64
# carries Debian's copies, from Mesa 22.3, for firmware that has none - KNULLI,
# where Chromium cannot draw anyway - but LD_LIBRARY_PATH puts them in front of
# the firmware's on every device. On ROCKNIX that libgbm met a current Mesa and
# dereferenced a null pointer inside gbm_create_device, which took Chromium down
# before a window ever opened. Preloading the firmware's copies by path beats
# LD_LIBRARY_PATH: the loader matches libraries by SONAME, finds these already
# loaded and never goes looking in libs.aarch64. FNH_FIRMWARE_GPU=0 goes back to
# the bundled ones.
GPU_PRELOAD=""
if [ "${FNH_FIRMWARE_GPU:-1}" != "0" ]; then
  for lib in libgbm.so.1 libdrm.so.2 libwayland-server.so.0; do
    for dir in /usr/lib/aarch64-linux-gnu /usr/lib64 /usr/lib /lib/aarch64-linux-gnu /lib64 /lib; do
      if [ -e "$dir/$lib" ]; then
        GPU_PRELOAD="${GPU_PRELOAD:+$GPU_PRELOAD:}$dir/$lib"
        break
      fi
    done
  done
fi
echo "GPU libraries from the firmware: ${GPU_PRELOAD:-none, using the bundled ones}"
PRELOAD="$GPU_PRELOAD"
if [ -n "${LD_PRELOAD:-}" ]; then
  PRELOAD="${PRELOAD:+$PRELOAD:}$LD_PRELOAD"
fi

# Hand SDL the controller database by file, not by value. ROCKNIX's copy of
# $sdl_controllerconfig is the whole 476 KB database, and Linux caps a single
# environment string at 128 KB, so exporting it makes every later exec fail with
# E2BIG - the engine, grep, pkill, all of it. Firmware that sets
# SDL_GAMECONTROLLERCONFIG_FILE has already done this properly; older firmware
# hands over just this device's mapping, which is small and still worth passing.
if [ -z "${SDL_GAMECONTROLLERCONFIG_FILE:-}" ] && [ "${#sdl_controllerconfig}" -lt 100000 ]; then
  export SDL_GAMECONTROLLERCONFIG="$sdl_controllerconfig"
fi

$GPTOKEYB2 "nw" -c "$GAMEDIR/fearandhunger.gptk" &

pm_platform_helper "$BINARY"

LD_PRELOAD="$PRELOAD" "$BINARY" $OZONE $GL_ARGS \
    --user-data-dir="$PROFILE" \
    --disk-cache-dir="$PROFILE/cache" \
    --disk-cache-size=8388608 \
    --media-cache-size=1048576 \
    "$GAMEDIR"

rm -rf "$PROFILE"

# Hand the zram back if this run is the one that set it up.
if [ -n "${FNH_ZRAM:-}" ]; then
  swapoff "/dev/zram${FNH_ZRAM}" 2>/dev/null
  echo "${FNH_ZRAM}" > /sys/class/zram-control/hot_remove 2>/dev/null
fi

pm_finish
