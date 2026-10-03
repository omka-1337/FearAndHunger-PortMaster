What is in a release of this port, and under what terms.

The port's own files - the launcher, patch.js, the gptk mapping and tools/ - are
MIT, see LICENSE at the top of the repository.

The engine is NW.js: Chromium and Node.js. It is shipped unmodified, minus the
locale packs, the software rasteriser and the crash reporter, which are deleted
rather than changed. Its licence and those of everything it bundles ship with it
at nwjs/credits.html.

libs.aarch64/ holds the libraries Chromium needs and handheld firmware does not
have. They are the stock Debian bookworm arm64 binaries, unmodified, each a
separate shared object that can be replaced by dropping another file over it.
Several are LGPL (gnutls, atk, at-spi, idn2, unistring, gmp) and one is MPL
(nss); MANIFEST.txt in that folder names the exact Debian source package and
version every one of them came from, which is where their sources live.

Nothing of Fear & Hunger is distributed here. The game is a paid title and its
files come from the player's own copy.
