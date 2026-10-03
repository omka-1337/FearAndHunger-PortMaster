## Notes

Thanks to [Miro Haverinen](https://store.steampowered.com/app/1002300/Fear__Hunger/) for creating Fear & Hunger, which is not interested in whether you are having a good time.

**Playable.** Boots, plays, fights, saves and loads on an RG40XX V at roughly 17-24 fps in a
dungeon. Not smooth, but a game you can sit down with.

**Needs firmware with DRM/KMS graphics - ROCKNIX, not KNULLI.** The engine is Chromium, which
draws through X11, Wayland or DRM/KMS and nothing else, and KNULLI on this hardware has none
of the three. The launcher checks before it starts and says so by name.

The game is paid, so only the engine ships here: NW.js 0.117 for aarch64, which is Chromium
with Node, because RPG Maker MV games are web pages and there is no native engine to swap in
the way mkxp-z replaces RGSS. Nothing in the port edits the files you copy in - every fix is
injected ahead of the game's own scripts through `inject_js_start`.

## Supplying the game files

```
fearandhunger/
├── www/              <- from your installation
│   ├── audio/
│   ├── data/
│   ├── fonts/
│   ├── img/
│   ├── js/
│   ├── movies/
│   └── index.html
├── nwjs/             <- the engine, from ./fetch-runtime.sh
├── package.json
├── patch.js
└── tools/
```

Saves are written to `www/save`, next to the game's own files, exactly as on the desktop. A save made on a PC will load here and the other way round.

## The audio step, which is not optional

Run this once on a PC, before copying `www` across. It needs `python3` and `ffmpeg`.

```
python3 fearandhunger/tools/optimize_audio.py /path/to/www/audio --inplace
```

MV keeps whole tracks in memory as uncompressed float32 and holds the music, the ambience and
the event jingle at once; this game's longest ambience is 109 MB of RAM by itself. Folding the
tracks to mono, together with the 22 kHz audio context the port sets, takes the worst case
from 292 MB of PCM to 67 MB. Skip this and the game still runs, but it has far less room to
run in. Sound effects are left alone - 411 short files are not what fills the memory.

## Controls

| Button | Action |
|--|--|
| D-Pad | Move, menu navigation |
| B | Confirm, talk, interact |
| A | Cancel, open the menu |
| Y | Dash |
| X | Backspace, for the name entry screen |
| L1 / R1 | Page up and down in long lists |
| Start | Menu |
| Start + Select | Quit |

Face buttons follow the device's own labels, so on a Nintendo style layout Confirm sits on B. Say if yours differs. The game is keyboard only, no gamepad plugin is enabled and `YEP_KeyboardConfig` keeps MV's stock bindings, so everything goes through gptokeyb2 and `fearandhunger.gptk`.

## What the port changes, and why

Everything below can be turned off or retuned with an environment variable, which is how to narrow down a problem without editing a file.

**The Steamworks plugin is stubbed.** `js/plugins/Archeia_Steamworks.js` is enabled and requires `js/libs/greenworks` at the top level of the file, but that module only ships `.node` binaries for Windows and macOS. On aarch64 it resolves to nothing and the next line inside it throws, before the title screen, every time. The port intercepts that one require and hands the plugin an inert object, so `initAPI()` is falsy and every Steam call short circuits. The 205 achievement triggers in the game's event data are plugin commands, and MV silently ignores plugin commands it does not know, so nothing else notices. Achievements are the only casualty and there is no Steam client here to receive them.

**The audio context runs at 22050 Hz** (`FNH_AUDIO_HZ=0` to disable), for the reasons above.

**Fullscreen shader filters are off, the frame rate knobs are on.** See Settings; the reasoning is in [PERFORMANCE.md](PERFORMANCE.md).

**A lost GPU context reloads the game.** PIXI 4.5.4 does not recover from one: the game keeps running and keeps drawing, but what reaches the screen is corrupt, usually a vertically mirrored frame. On a handheld the context is lost when the device sleeps. The port reloads at the title screen instead, with saves intact. `FNH_NO_GL_RELOAD=1` leaves it alone.

## Settings

Everything is an environment variable, so a tester can change one thing without editing a
file: `FNH_FILTERS=99 ./"Fear & Hunger.sh"`.

| Variable | Default | What it does |
|--|--|--|
| `FNH_FILTERS` | `0` | Fullscreen shader passes. The game asks FilterController for zoomblur, rgbsplit, godray and adjustment on about a third of its maps; one map stacks two zoomblurs and an rgbsplit, which cost 14 fps against 21 without them. `99` restores the game's own look. |
| `FNH_FOG` | `99` | How many of a map's fog layers to draw. 46 maps carry three fullscreen additive layers each. Untested as a frame rate knob - it was not the cause of the slow map that filters turned out to be. |
| `FNH_MAX_STEPS` | `2` | Logic steps the fixed timestep may run per rendered frame. `1` is smoother and runs the game at a third speed; `0` restores the plugin's own uncapped loop. |
| `FNH_CULL` | `1` | `1` skips the logic of off-screen events, which nothing can see. `2` also skips their sprites, which is faster and makes a character you walk towards appear late and at arm's length. `0` updates everything. |
| `FNH_REFRESH_MS` | `50` | Minimum gap between page condition refreshes. |
| `FNH_RENDER_SCALE` | `1` | Fraction of 816x624 to render into. `0` matches the panel. Below 1 clips part of the name entry window, and with the filters off it buys nothing measurable. |
| `FNH_CACHE_MP` | `12` | Image cache ceiling in megapixels, against the game's own 10. |
| `FNH_AUDIO_HZ` | `22050` | Audio context rate. `0` leaves it at the device default. |
| `FNH_TEXTURE_GC` | `600` | Frames PIXI keeps an unused texture. `rpg_core.js` sets 1. |
| `FNH_SKIP_VIDEO` | off | Skips the intro: 33 seconds of 816x624 VP9 decoded in software. |
| `FNH_VERBOSE` | off | Frame rate, heap and scene names into `fearandhunger/log-game.txt`. |
| `FNH_FRAMEPROF` | off | Splits each frame into map logic, sprites and drawing, and names what loaded during any frame over 100 ms. |

## Known issues

**The render scale clips window contents, cause unknown.** At anything below 1 the name
entry window loses about a quarter of its canvas, the avatar with it. Three explanations were
tested on hardware and all three were wrong: it is not `WindowLayer`'s scissor (a window full
of coloured edge stripes renders perfectly through the window layer at 0.6), it is not
`DK_Name_Input` (which does not touch that scene), and rebuilding `Bitmap.snap` at the
renderer's resolution throws `RangeError: offset is out of bounds` out of PIXI's extract,
which cannot read a render texture whose resolution is not 1. The default is now 1, which
sidesteps it entirely and, with the fullscreen filters off, costs nothing measurable.

**Fullscreen filters are off by default.** That is a visible change: the game uses zoomblur
for its dizzy, dragged-under moments and the port drops it. `FNH_FILTERS=99` puts it back.

**`text_knight` never loads, on any platform.** The game ships it as `text_knight.psd`
rather than a PNG, so the knight's description is missing on Windows too. Nothing to fix here.

**`physical_attack_animation.js` throws a SyntaxError at startup, on any platform.** It asks
`PluginManager` for its parameters under a name it is not registered with, gets an empty
object, and evals `"[object Object]"`. The plugin has therefore never worked.

## Performance

Short version: it runs at roughly 17-24 fps walking a dungeon, with the game's logic at full
speed, and the frame rate is even rather than spiky. Getting there needed four things, and
the launcher and `patch.js` do all of them for you: a gigabyte of zram, because the device
ships with no swap and otherwise pages the engine's own code off the SD card; a cap on the
fixed timestep, because the game's own `TDDP_FluidTimestep` runs the map logic twice for
every frame that misses 16.6 ms and then asks for a third; skipping the logic of events that
are off screen, of which a dungeon has three hundred; and turning off the fullscreen shader
filters, which cost more than everything else put together.

[PERFORMANCE.md](PERFORMANCE.md) has the measurements, including the ones that disproved the
things I was sure of.

## Building the runtime

The engine is not in this repository: `libnw.so` alone is 283 MB, past what GitHub accepts in a single file. Fetch and trim it with:

```
./fetch-runtime.sh
./fetch-libs.sh
```

The first downloads the official NW.js aarch64 tarball, checks it against a pinned SHA-256, drops 227 of the 228 locale packs, the software rasteriser, the high-dpi asset pack and the crash reporter, and installs the rest into `fearandhunger/nwjs/`. The second pulls 45 pinned Debian packages, flattens them to their SONAMEs in `fearandhunger/libs.aarch64/`, and prints what it still expects the firmware to provide.

Then `./build-release.sh` stages the metadata the way a released port expects and writes `dist/fearandhunger.zip`, refusing to run if either of those is missing or if any game file has found its way into the port folder.

## Licence

The port's own files are MIT, see [LICENSE](LICENSE). The engine and the system libraries it
brings carry their own terms, set out in `fearandhunger/licenses/README.txt`; the libraries
are stock Debian binaries, unmodified, with their source packages named in
`fearandhunger/libs.aarch64/MANIFEST.txt`. The game itself is never redistributed.
