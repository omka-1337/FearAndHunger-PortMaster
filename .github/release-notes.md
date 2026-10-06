Fear & Hunger on a handheld, through PortMaster.

**Requires firmware with DRM/KMS graphics — ROCKNIX, not KNULLI.** The engine is Chromium,
which draws through X11, Wayland or DRM/KMS and nothing else; KNULLI on Allwinner hardware
has none of the three. The launcher checks before starting and says so by name.

**The game is not included.** This is the engine only — NW.js 0.117 for aarch64 — plus the
compatibility layer. You supply your own `www` folder from Steam and copy it in; nothing has to
be run on a PC. The first launch spends a few minutes re-encoding the game's music to mono,
which it needs to fit in 1 GB of RAM. See the README for the walkthrough.

### State

Playable. Boots, plays, fights, saves and loads, at roughly 17–24 fps walking a dungeon on an
RG40XX V. Not smooth, but a game you can sit down with.

### What is in here

- NW.js 0.117 (Chromium 154 + Node) for aarch64, trimmed of what this hardware cannot use
- 57 system libraries Chromium needs and handheld firmware does not ship, stock Debian
  bookworm binaries with their source packages named in `libs.aarch64/MANIFEST.txt`
- `patch.js`, which stubs the Steamworks plugin the game cannot load, caps the game's own
  fixed-timestep loop, skips the logic of off-screen events, turns off the fullscreen shader
  filters and keeps decoded audio small enough to fit
- A launcher that sets up compressed swap, finds the compositor, checks for missing libraries
  and reports what is wrong in plain words
- The audio converter the first launch runs, with the oggdec and oggenc it needs for
  aarch64 (stock Ubuntu binaries, named in `tools/aarch64/MANIFEST.txt`), and a tool for
  decrypting assets

### Known issues

- Fullscreen shader filters are off by default, which changes how some scenes look.
  `FNH_FILTERS=99` puts them back.
- `text_knight` never loads — the game ships it as a `.psd`, so the knight's description is
  missing on Windows too.

`PERFORMANCE.md` has the measurements behind every one of those choices, including the
several that turned out to be wrong.
