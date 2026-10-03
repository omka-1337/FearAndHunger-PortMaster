## Notes

Thanks to [Miro Haverinen](https://store.steampowered.com/app/1002300/Fear__Hunger/) for creating Fear & Hunger, which is not interested in whether you are having a good time.

The game is a paid title, so this port ships the engine only. Copy the `www` folder from your own installation into the `fearandhunger` folder, alongside the engine. `Game.exe`, the `.dll` files, `locales/`, `swiftshader/`, `credits.html` and the loose `package.json` are the Windows NW.js runtime and are not needed; this port brings its own.

The engine is NW.js 0.117.0 for aarch64, which is Chromium 154 with Node. Fear & Hunger is RPG Maker MV 1.6.0, and MV games are web pages, so there is no native engine to swap in the way mkxp-z replaces RGSS. Official NW.js aarch64 builds only go back to 0.111.1, so there is no build close to the 0.33 the game shipped with — the game runs on a Chromium a hundred versions newer than the one it was written against, and the port exists to paper over the places where that shows.

Nothing in the port edits the files you copy in. Every fix is injected before the game's own scripts through `inject_js_start` in `package.json`, which is this port's equivalent of a preloaded compatibility script.

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

Run this once, on a PC, before copying `www` across:

```
python3 fearandhunger/tools/optimize_audio.py /path/to/www/audio --inplace
```

RPG Maker MV decodes every track to an uncompressed float32 buffer and keeps the music, the ambience and the event jingle resident at the same time. How well the ogg is compressed does not matter: what costs memory is duration x sample rate x channels x 4 bytes. This game's longest ambience track runs 299 seconds in 48 kHz stereo, which is 109 MB of RAM on its own.

Measured on a desktop, forcing the three longest tracks to decode together — which is a state the game can genuinely reach, since BGM, BGS and ME all play at once:

| | decoded PCM | peak process memory |
|--|--|--|
| As shipped | 292 MB | 988 MB |
| Tracks folded to mono | 146 MB | 526 MB |
| Mono, plus the port's 22 kHz audio context | 67 MB | 444 MB |

The two halves only work together. Chromium resamples while decoding to whatever rate the audio context runs at, so a lower sample rate in the file buys nothing by itself — the port's `patch.js` sets the context to 22050 Hz, and the converter supplies the mono. On disk the tracks go from 181 MB to about 21 MB, but the disk was never the problem.

Sound effects are left alone. There are 411 of them, they are short, and they are not what fills the memory.

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

Face buttons follow the device's own labels, so on a Nintendo style layout Confirm sits on B. Say if yours differs. The game is keyboard only — no gamepad plugin is enabled and `YEP_KeyboardConfig` keeps MV's stock bindings — so everything goes through gptokeyb2 and `fearandhunger.gptk`.

## What the port changes, and why

`patch.js` does four things. Each can be turned off or retuned with an environment variable, which is how to narrow down a problem without editing anything.

**The Steamworks plugin is stubbed.** `js/plugins/Archeia_Steamworks.js` is enabled and requires `js/libs/greenworks` at the top level of the file, but that module only ships `.node` binaries for Windows and macOS. On aarch64 it resolves to nothing and the next line inside it throws, before the title screen, every time. The port intercepts that one require and hands the plugin an inert object, so `initAPI()` is falsy and every Steam call short circuits. The 205 achievement triggers in the game's event data are plugin commands, and MV silently ignores plugin commands it does not know, so nothing else notices. Achievements are the only casualty and there is no Steam client here to receive them.

**The audio context runs at 22050 Hz** (`FNH_AUDIO_HZ=0` to disable), for the reasons above.

**The frame is rendered at the size of the panel.** The game is 816x624 and the screen is smaller, so MV was already shrinking the frame on its way out; rendering straight into a buffer the size of the panel removes that waste — on 640x480 it is 40% fewer pixels for a picture that is, pixel for pixel, the one you were already seeing. The scale is worked out from the screen at startup; `FNH_RENDER_SCALE=1` renders natively, or set it to a number to force one.

**A lost GPU context reloads the game.** PIXI 4.5.4 does not recover from one: the game keeps running and keeps drawing, but what reaches the screen is corrupt, usually a vertically mirrored frame. On a handheld the context is lost when the device sleeps. The port reloads at the title screen instead, with saves intact. `FNH_NO_GL_RELOAD=1` leaves it alone.

`FNH_CACHE_MP` sets the image cache ceiling in megapixels, 8 by default against the game's 10. `FNH_SKIP_VIDEO=1` skips the intro, which is 33 seconds of 816x624 VP9 decoded in software. `FNH_VERBOSE=1` writes frame rate, heap and scene names to `fearandhunger/log-game.txt`.

## Known issues, and what has not been tested

## Performance on a 1 GB device

Measured on an RG40XX V under ROCKNIX (kernel 7.2, Panfrost, Mali-G31, 640x480).

The device has no swap of any kind out of the box, and that single fact dominates
everything else. With nothing to compress into, the kernel's only way to free memory is
to drop clean file-backed pages - which here means the engine's own code, since Chromium
is 283 MB of it - and then fault it back off the SD card at the next instruction. The
dungeons ran at **0.4 fps** that way, with single frames taking nine seconds, and the
game read 1.5 GB off the card in ninety seconds while doing it.

The launcher now sets up 1 GB of zstd zram when it finds no swap, and hands it back on
exit. The same scene then ran at **13-18 fps**, and disk reads fell to 174 MB.

The second limit is fill rate. The game puts a fullscreen additive fog layer over 138 of
its 170 maps, which a Mali-G31 does not enjoy at native size, so the port renders at 60%
of 816x624 by default and lets the panel scale it back up. `FNH_RENDER_SCALE=0` restores
a pixel-exact frame for anyone on stronger hardware.

Two things that look like optimisations and are not. Shrinking the image cache to save
memory costs more than it saves: every eviction becomes a fresh read from a slow card, so
the default here is higher than the game's own, not lower. And decrypting the assets, while
worth doing for the CPU it saves, changed the read volume barely at all - the reads were
the kernel paging the engine, not the game loading art.

### Where a frame goes

`FNH_FRAMEPROF=1` splits each frame into map logic, sprites and drawing, and names what
loaded during any frame over 100 ms. Measured on map 74 (156 events) at native resolution,
with zram up:

| | per frame |
|--|--|
| `Game_Map.updateEvents` | 23.0 ms |
| rendering | 18.6 ms |
| `Spriteset_Map.update` | 15.1 ms |
| `Game_Map.refresh` | 4.6 ms, and it runs 320 times in 10 seconds |
| interpreter | 1.5 ms |

About 63 ms a frame, so 16 fps, split roughly evenly between event logic, drawing and
sprites. There is no single culprit to remove. The dungeons are worse because they carry
330 to 460 events against 7 on the first outdoor map, and MV updates every event on the
map every frame whether or not it is anywhere near the screen - around 80% of them are not.

`Game_Map.refresh` running every frame is worth noting: it re-evaluates the page conditions
of every event on the map, and it is triggered by any switch or variable change. This game
has hunger and sanity ticking constantly.

A warning about measuring this on hardware this slow: an earlier version of the profiler
wrapped `Game_Event.update` and `Sprite_Character.update`, which on a 333 event map is 666
timer calls a frame. It reported 144 ms of map logic and 8 ms of drawing, and both figures
were artefacts - the real split is above, and drawing is a third of the frame rather than
noise. Measure once per frame, not once per object.

Still unexplored: windows and menus stall for seconds, which points at MV's habit of
re-uploading a window's whole contents bitmap to the GPU, made worse by `rpg_core.js`
setting PIXI's texture garbage collector to drop anything unused for a single frame. The
port raises that to 600 frames and ships a profiler (`FNH_PROFILE=1`) that times text
drawing, texture upload and window rebuilds separately. EmulationStation's 109 MB is also
still there during play - on ROCKNIX it is started by `sway.sh`, not by the disabled
`emustation.service`, so stopping it takes more than `systemctl stop`.

**The firmware has to provide DRM/KMS graphics.** The engine is Chromium, and Chromium draws through X11, Wayland or DRM/KMS — never through a bare framebuffer. Some firmware still drives the panel the old way: KNULLI on the Allwinner H700 (RG40XX H and V) runs a 4.9 kernel with Arm's `mali_kbase` blob, which deliberately exposes no DRM API, so the device has `/dev/mali0`, `/dev/disp` and `/dev/fb0` and no `/dev/dri` at all. No compositor can run on that, so neither can this port, and neither can any other Electron or NW.js port. The launcher checks for it and says so plainly instead of letting Chromium abort with a stack trace.

The same hardware under a firmware with a mainline kernel and Panfrost — ROCKNIX, for one — does have `/dev/dri`, and that is where this port belongs.

**The software renderer is not an option.** Running this game on PIXI's canvas renderer core dumps the engine outright, so the port needs working GLES and fails loudly rather than falling back. The software rasteriser is deliberately not shipped. If the screen is black, try `FNH_GL_ARGS=--use-angle=gl` and then `FNH_GL_ARGS=" "` before concluding anything.

**NW.js is Chromium, and it wants a fuller system than most ports do.** On KNULLI (RG40XX-V, gladiator-ii) all sixteen libraries it asks for are absent outright: the X11 set, NSS, ATK, AT-SPI, CUPS, GBM and xkbcommon. The port therefore carries them and their whole dependency closure — 57 stock Debian bookworm arm64 binaries, unmodified, built into `fearandhunger/libs.aarch64/` by `./fetch-libs.sh` and listed with their source packages in that folder's `MANIFEST.txt`. Bookworm's glibc is 2.36 against the device's 2.40, and glibc is backward compatible, which is why it is not a current Debian.

What the firmware still has to provide is `libglib-2.0`, `libgobject-2.0`, `libdbus-1` and `libexpat`. Those are deliberately not overridden, along with cairo, pango, udev and alsa: replacing a system's own glib is how you break it.

The launcher asks the dynamic loader what is missing before it starts anything, so another firmware that is short of something will say so by name rather than showing a black screen. Please send that list if you get one.

**`physical_attack_animation.js` throws a SyntaxError at startup on every platform, Windows included.** It asks `PluginManager` for its parameters under a name it is not registered with, gets an empty object, and evals `"[object Object]"`. The plugin has therefore never worked. It is logged as a known upstream error and ignored.

Everything above was verified on a desktop x86_64 build of the same NW.js version: the game boots, plays through the title, character select, the intro, the dungeon, a battle, a game over and saves, with no crashes and no WebGL errors. **None of it has been run on a handheld yet.** Desktop frame rates say nothing about a Mali-G31, and the 444 MB measured there is not a promise about a device where the GPU draws from the same 1 GB as everything else.

## Building the runtime

The engine is not in this repository — `libnw.so` alone is 283 MB, past what GitHub accepts in a single file. Fetch and trim it with:

```
./fetch-runtime.sh
./fetch-libs.sh
```

The first downloads the official NW.js aarch64 tarball, checks it against a pinned SHA-256, drops 227 of the 228 locale packs, the software rasteriser, the high-dpi asset pack and the crash reporter, and installs the rest into `fearandhunger/nwjs/`. The second pulls 45 pinned Debian packages, flattens them to their SONAMEs in `fearandhunger/libs.aarch64/`, and prints what it still expects the firmware to provide.

Then `./build-release.sh` stages the metadata the way a released port expects and writes `dist/fearandhunger.zip`, refusing to run if either of those is missing or if any game file has found its way into the port folder.
