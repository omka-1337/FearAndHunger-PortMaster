# Why this game is slow on a handheld, and what was done about it

Everything here was measured on an RG40XX V under ROCKNIX: a 1 GB Allwinner H700, a
Mali-G31, a 640x480 panel. The numbers are kept because three days of this were spent
chasing the wrong things, and the record of which guesses were wrong is worth as much as
the fixes.

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

The second limit is fill rate. Counted from the map data: 46 of the 169 maps carry fog, and
each of those 46 carries **three** fullscreen layers of it at blend 1, which is additive.
138 was an earlier count of `<fog effect>` tags rather than of maps. The heaviest maps are
among the 46 (Map110 with 572 events, Map080 with 535, Map160 with 506), so the worst places
in this game pay for the events and for the fill rate at once. The port renders natively. Scaling down was
worth a great deal while the game's fullscreen shader filters were still running; once those
are off it buys nothing on this hardware - a 328 event dungeon measures 17-24 fps either way -
so the sharper frame wins.

Two things that look like optimisations and are not. Shrinking the image cache to save
memory costs more than it saves: every eviction becomes a fresh read from a slow card, so
the default here is higher than the game's own, not lower. And decrypting the assets, while
worth doing for the CPU it saves, changed the read volume barely at all - the reads were
the kernel paging the engine, not the game loading art.

### Measured on hardware after the timestep cap

Walking a dungeon on an RG40XX V (map 6, 271 events), render scale 0.6, zram up, with the
off-screen culling and the refresh throttle on and the fixed timestep capped at two steps:

| | |
|--|--|
| frame rate | 10-26 fps, 1.8-2.0 logic steps per frame |
| `Game_Map.update` | 9-19 ms |
| `Spriteset_Map.update` | 6-10 ms |
| rendering | 5-11 ms |
| culled | 50-78% of events and their sprites |
| refreshes skipped | 250-750 per 10 s |

Against 63 ms a frame before any of it, the CPU side is roughly four times cheaper. Capping
at one step is smoother still but runs the game at a third of its proper speed, which is
worse to play than a lower frame rate; two steps keeps the logic at 20-50 Hz.

What is left is not CPU. Measured work adds up to 25-36 ms while frames take 40-100 ms, and
sitting in a menu with no logic running at all still reports 20.7 fps - which is exactly 60/3,
a frame missing its vblank and landing on every third one. The next thing worth trying is
hiding the culled sprites rather than only skipping their updates: PIXI still walks and
submits all 333 of them every frame.

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

### The cliff, which is in the game rather than in the engine

The game ships `TDDP_FluidTimestep.js`, enabled, and it replaces
`SceneManager.updateMain` with a fixed timestep: a 1/60 accumulator drained in a
`while` loop, clamped at 0.25 s. While a frame fits in 16.6 ms the loop runs one logic
step and nothing is odd. The moment a frame costs more than that, the loop runs the map
logic twice in one rendered frame, which makes the frame longer, which asks for a third
step. It is a cliff with positive feedback, not a slope, and it explains two things that
did not add up before:

- why 0.77 of native ran the dungeons at 13 to 18 fps while 0.55 held 60. One side of
  the cliff, then the other.
- why windows and menus stall for seconds. A window rebuild costing hundreds of ms
  clamps `frameTime` to 0.25, which is fifteen logic steps back to back, which is
  another long frame.

It also means the 63 ms breakdown above is per rendered frame and therefore includes
however many logic steps ran in it, so a single step costs rather less than those
figures suggest.

`FNH_MAX_STEPS` caps the catch up and defaults to 1: under load the game runs slower
instead of freezing, which on this hardware is the better of the two. `FNH_MAX_STEPS=0`
hands the loop back to the plugin, and either way the profiler reports `steps=` per
frame so the two can be compared on the same scene.

### Spending the frame on what is visible

MV updates every event on the map every frame. The dungeons here carry 572 events where
102 is the most that fit on screen at once, and the second game reaches 922.
`FNH_CULL=2`, the default, skips the update of an event that is outside the view, and
`FNH_CULL=1` skips only its sprite, which cannot affect logic at all.

Nothing observable is skipped, and the reason is in `rpg_objects.js`: `Game_Event`'s own
`updateSelfMovement` is already gated on `isNearTheScreen`, so random, approach and
custom route events do not walk off screen in the original game either. What does
outlive the view is a forced move route (this game issues 16042 of them at other
events), a running interpreter, an autorun or parallel page, a step already in progress
and a requested animation or balloon. Each of those keeps its event updating, and
`_stopCount` is credited by hand so an event returning to view is as ready to move as it
would have been. The profiler prints which reason kept each event, so a whitelist that
has stopped doing its job says so.

`FNH_REFRESH_MS` is the third knob, 50 ms by default. `Game_Map.refresh` re-evaluates
the page conditions of every event on the map and any switch or variable change asks for
one, which with hunger and sanity ticking meant 320 refreshes in ten seconds. The work
is deferred rather than dropped: `_needsRefresh` stays set and the next frame asks again.
A map that has just loaded always refreshes at once.

Windows and menus re-uploading their whole contents bitmap to the GPU is still real and
still separate from the cliff, made worse by `rpg_core.js` setting PIXI's texture garbage
collector to drop anything unused for a single frame. The port raises that to 600 frames
and ships a profiler (`FNH_PROFILE=1`) that times text drawing, texture upload and window
rebuilds separately. EmulationStation's 109 MB is also
still there during play - on ROCKNIX it is started by `sway.sh`, not by the disabled
`emustation.service`, so stopping it takes more than `systemctl stop`.

**The firmware has to provide DRM/KMS graphics.** The engine is Chromium, and Chromium draws through X11, Wayland or DRM/KMS, never through a bare framebuffer. Some firmware still drives the panel the old way: KNULLI on the Allwinner H700 (RG40XX H and V) runs a 4.9 kernel with Arm's `mali_kbase` blob, which deliberately exposes no DRM API, so the device has `/dev/mali0`, `/dev/disp` and `/dev/fb0` and no `/dev/dri` at all. No compositor can run on that, so neither can this port, and neither can any other Electron or NW.js port. The launcher checks for it and says so plainly instead of letting Chromium abort with a stack trace.

The same hardware under a firmware with a mainline kernel and Panfrost, ROCKNIX for one, does have `/dev/dri`, and that is where this port belongs.

**The software renderer is not an option.** Running this game on PIXI's canvas renderer core dumps the engine outright, so the port needs working GLES and fails loudly rather than falling back. The software rasteriser is deliberately not shipped. If the screen is black, try `FNH_GL_ARGS=--use-angle=gl` and then `FNH_GL_ARGS=" "` before concluding anything.

**NW.js is Chromium, and it wants a fuller system than most ports do.** On KNULLI (RG40XX-V, gladiator-ii) all sixteen libraries it asks for are absent outright: the X11 set, NSS, ATK, AT-SPI, CUPS, GBM and xkbcommon. The port therefore carries them and their whole dependency closure: 57 stock Debian bookworm arm64 binaries, unmodified, built into `fearandhunger/libs.aarch64/` by `./fetch-libs.sh` and listed with their source packages in that folder's `MANIFEST.txt`. Bookworm's glibc is 2.36 against the device's 2.40, and glibc is backward compatible, which is why it is not a current Debian.

What the firmware still has to provide is `libglib-2.0`, `libgobject-2.0`, `libdbus-1` and `libexpat`. Those are deliberately not overridden, along with cairo, pango, udev and alsa: replacing a system's own glib is how you break it.

The launcher asks the dynamic loader what is missing before it starts anything, so another firmware that is short of something will say so by name rather than showing a black screen. Please send that list if you get one.

**`physical_attack_animation.js` throws a SyntaxError at startup on every platform, Windows included.** It asks `PluginManager` for its parameters under a name it is not registered with, gets an empty object, and evals `"[object Object]"`. The plugin has therefore never worked. It is logged as a known upstream error and ignored.

Everything above was verified on a desktop x86_64 build of the same NW.js version: the game boots, plays through the title, character select, the intro, the dungeon, a battle, a game over and saves, with no crashes and no WebGL errors. **None of it has been run on a handheld yet.** Desktop frame rates say nothing about a Mali-G31, and the 444 MB measured there is not a promise about a device where the GPU draws from the same 1 GB as everything else.
