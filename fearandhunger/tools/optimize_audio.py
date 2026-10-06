#!/usr/bin/env python3
"""Shrink the memory Fear & Hunger needs for music and ambience.

The launcher runs this on the handheld before every start. The first time, it
rewrites the game's music and ambience, which takes a few minutes; after that it
finds every track already done and returns at once. It can still be run on a PC
beforehand, which is faster, and the device then finds nothing left to do.

Why it exists
-------------
RPG Maker MV decodes every track to an uncompressed float32 buffer and keeps the
BGM, the BGS and the ME resident at the same time. The compression of the ogg on
disk is irrelevant to that; what counts is duration x sample rate x channels x 4.
This game's longest ambience track runs 299 seconds in 48 kHz stereo, which is
109 MB of RAM by itself, and the three longest together were measured at 292 MB
of PCM with a peak of 988 MB for the whole process. That does not fit in 1 GB.

Folding the tracks to mono halves it, and halving the sample rate halves it
again - but only together with the AudioContext rate the port's patch.js sets,
because Chromium resamples to the context rate while decoding, so a lower rate
in the file alone buys nothing. With both, the same three tracks measured 67 MB
of PCM and a 444 MB peak.

Loop points come along. LOOPSTART and LOOPLENGTH count samples at the file's
own rate, and MV divides them by the rate it reads from the new file, so they
are rescaled with it - left alone, a loop marked at two seconds into a 48 kHz
track would come back at four and a third. They are also written first: MV
only looks for them in the first 255 bytes of the comment header.

Sound effects are left alone: there are 411 of them, they are short, and they are
not what fills the memory.

Every track is checked before it is touched, and one that is already mono at
the target rate is skipped, so an interrupted run picks up where it stopped. A
track is only replaced once its new version is complete and on the card.

Usage
-----
    python3 optimize_audio.py <www/audio> [--inplace | --out DIR] [--quality N]

Encodes with oggdec and oggenc: the copies in tools/aarch64 on the handheld,
vorbis-tools from PATH on a PC, or ffmpeg when that is all there is.

Progress goes to stdout and only when there is work to do, because the launcher
shows every line of it on screen. Everything else goes to stderr.
"""

import argparse
import concurrent.futures
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

DEFAULT_KEY = 'd41d8cd98f00b204e9800998ecf8427e'
FOLDERS = ('bgm', 'bgs', 'me')
HEADER_LEN = 16
TEMP_PREFIX = '.fnh-'
# Long comments are cover art, which the game never reads, and passing one on a
# command line would run into the kernel's limit on the length of an argument.
MAX_COMMENT = 16384


def note(msg):
    print(msg, file=sys.stderr, flush=True)


def find_key(audio_dir):
    """The encryption key lives in data/System.json, one level up from audio/."""
    system = os.path.join(os.path.dirname(os.path.abspath(audio_dir)), 'data', 'System.json')
    try:
        with open(system, encoding='utf-8') as fh:
            data = json.load(fh)
        key = data.get('encryptionKey')
        if key:
            return key
    except Exception:
        pass
    return DEFAULT_KEY


def xor_head(body, key):
    body = bytearray(body)
    for i in range(min(HEADER_LEN, len(body))):
        body[i] ^= key[i]
    return body


def read_ogg(path, encrypted, key, limit=-1):
    """The plain Ogg bytes of a track, decrypted if it needs it."""
    with open(path, 'rb') as fh:
        raw = fh.read(limit + HEADER_LEN if limit >= 0 and encrypted else limit)
    if not encrypted:
        return raw
    return bytes(xor_head(raw[HEADER_LEN:], key))


def vorbis_headers(data):
    """Channels, sample rate and comments of an Ogg Vorbis stream.

    Returns None for anything that is not Vorbis. The comments are None when
    only the start of the file was read and they did not fit in it.
    """
    packets, cur, pos = [], b'', 0
    try:
        while len(packets) < 2 and data[pos:pos + 4] == b'OggS':
            nseg = data[pos + 26]
            lacing = data[pos + 27:pos + 27 + nseg]
            body = pos + 27 + nseg
            if len(lacing) < nseg or body + sum(lacing) > len(data):
                break  # the page runs past what was read
            for n in lacing:
                cur += data[body:body + n]
                body += n
                if n < 255:
                    packets.append(cur)
                    cur = b''
                    if len(packets) == 2:
                        break
            pos += 27 + nseg + sum(lacing)
        if not packets or packets[0][:7] != b'\x01vorbis':
            return None
        ident = packets[0]
        channels = ident[11]
        rate = struct.unpack_from('<I', ident, 12)[0]
        if len(packets) < 2:
            return channels, rate, None
        com = packets[1]
        if com[:7] != b'\x03vorbis':
            return None
        off = 7
        off += 4 + struct.unpack_from('<I', com, off)[0]
        count = struct.unpack_from('<I', com, off)[0]
        off += 4
        comments = []
        for _ in range(count):
            n = struct.unpack_from('<I', com, off)[0]
            off += 4
            comments.append(com[off:off + n].decode('utf-8', 'replace'))
            off += n
        return channels, rate, comments
    except (IndexError, struct.error):
        return None


def carry_comments(comments, ratio):
    """The tags to write on the new file, loop points rescaled and first."""
    loops, rest = [], []
    for c in comments:
        name, sep, value = c.partition('=')
        if not sep:
            continue
        if name.upper() in ('LOOPSTART', 'LOOPLENGTH') and value.strip().isdigit():
            loops.append(f'{name}={round(int(value) * ratio)}')
        elif name.upper() != 'ENCODER' and len(c) <= MAX_COMMENT:
            rest.append(c)
    return loops + rest


class VorbisTools:
    """oggdec into oggenc through a pipe, so no decoded track ever lands on disk."""

    def __init__(self, oggdec, oggenc, env=None, label='vorbis-tools'):
        self.oggdec, self.oggenc, self.env, self.label = oggdec, oggenc, env, label

    def runs(self):
        try:
            for tool in (self.oggdec, self.oggenc):
                r = subprocess.run([tool, '--version'], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if r.returncode != 0:
                    note(f'{tool} will not run here: {r.stderr.decode(errors="replace").strip()}')
                    return False
        except OSError as e:
            note(f'{self.label} will not run here: {e}')
            return False
        return True

    def can_take(self, channels):
        # oggenc only folds stereo. Nothing in this game is wider, but if it were
        # it would be left as it was rather than mangled.
        return channels in (1, 2)

    def encode(self, src, out, channels, rate, rate_out, quality, comments):
        cmd = [self.oggenc, '-Q', '-q', str(quality)]
        if rate_out != rate:
            cmd += ['--resample', str(rate_out)]
        if channels == 2:
            cmd.append('--downmix')
        for c in comments:
            cmd += ['-c', c]
        cmd += ['-o', out, '-']
        dec = subprocess.Popen([self.oggdec, '-Q', '-o', '-', src],
                               stdout=subprocess.PIPE, env=self.env)
        enc = subprocess.Popen(cmd, stdin=dec.stdout, env=self.env)
        dec.stdout.close()  # so oggdec stops if oggenc does
        enc.wait()
        dec.wait()
        if dec.returncode or enc.returncode:
            raise subprocess.CalledProcessError(dec.returncode or enc.returncode, cmd)


class Ffmpeg:
    label = 'ffmpeg'

    def runs(self):
        return True

    def can_take(self, channels):
        return True

    def encode(self, src, out, channels, rate, rate_out, quality, comments):
        cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-map_metadata', '-1',
               '-ar', str(rate_out), '-ac', '1', '-c:a', 'libvorbis', '-q:a', str(quality)]
        for c in comments:
            cmd += ['-metadata', c]
        cmd += ['-f', 'ogg', out]
        subprocess.run(cmd, check=True)


def find_encoder():
    here = os.path.dirname(os.path.abspath(__file__))
    bundled = os.path.join(here, platform.machine())
    if os.path.isfile(os.path.join(bundled, 'oggenc')):
        tools = [os.path.join(bundled, t) for t in ('oggdec', 'oggenc')]
        # A zip can lose the executable bit on the way to the card.
        for t in tools:
            try:
                os.chmod(t, os.stat(t).st_mode | 0o111)
            except OSError:
                pass
        env = dict(os.environ)
        env['LD_LIBRARY_PATH'] = bundled + (':' + env['LD_LIBRARY_PATH']
                                            if env.get('LD_LIBRARY_PATH') else '')
        enc = VorbisTools(*tools, env=env, label='tools/' + platform.machine())
        if enc.runs():
            return enc
    if shutil.which('oggdec') and shutil.which('oggenc'):
        enc = VorbisTools(shutil.which('oggdec'), shutil.which('oggenc'))
        if enc.runs():
            return enc
    if shutil.which('ffmpeg'):
        return Ffmpeg()
    return None


def fsync(path):
    fd = os.open(path, os.O_RDWR)  # Windows will not flush a read-only handle
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def convert(track, enc, key, rate_limit, quality):
    """Rewrite one track. Returns the size of the result."""
    data = read_ogg(track['src'], track['encrypted'], key)
    info = vorbis_headers(data)
    if info is None:
        raise ValueError('not an Ogg Vorbis stream')
    channels, rate, comments = info
    rate_out = min(rate, rate_limit)
    comments = carry_comments(comments or [], rate_out / rate)
    work = tempfile.mkdtemp(prefix=TEMP_PREFIX, dir=os.path.dirname(track['dst']))
    try:
        out = os.path.join(work, 'out.ogg')
        if track['encrypted']:
            src = os.path.join(work, 'in.ogg')
            with open(src, 'wb') as fh:
                fh.write(data)
        else:
            src = track['src']
        del data
        enc.encode(src, out, channels, rate, rate_out, quality, comments)
        if track['encrypted']:
            with open(track['src'], 'rb') as fh:
                header = fh.read(HEADER_LEN)
            with open(out, 'rb') as fh:
                body = xor_head(fh.read(), key)
            staged = os.path.join(work, 'out.rpgmvo')
            with open(staged, 'wb') as fh:
                fh.write(header + bytes(body))
        else:
            staged = out
        fsync(staged)
        os.replace(staged, track['dst'])
        return os.path.getsize(track['dst'])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def clean_leftovers(folder):
    """Remove what an interrupted run left behind. The originals are untouched."""
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if name.startswith(TEMP_PREFIX) and os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif name.endswith(('.ogg.new', '.rpgmvo.new')):  # the old script's staging
            os.remove(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('audio_dir', help='the www/audio folder')
    ap.add_argument('--out', help='write to this folder instead of converting in place')
    ap.add_argument('--inplace', action='store_true', help='overwrite the files given')
    ap.add_argument('--rate', type=int, default=22050, help='sample rate (default 22050)')
    ap.add_argument('--quality', type=int, default=5,
                    help='vorbis quality 0-10 (default 5; this changes file size, not RAM)')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 1,
                    help='tracks to encode at once (default: one per core)')
    args = ap.parse_args()

    if not args.inplace and not args.out:
        ap.error('pick one of --inplace or --out DIR')

    key = bytes.fromhex(find_key(args.audio_dir))
    tracks, found, foreign = [], 0, 0

    for folder in FOLDERS:
        src_dir = os.path.join(args.audio_dir, folder)
        if not os.path.isdir(src_dir):
            continue
        dst_dir = src_dir if args.inplace else os.path.join(args.out, folder)
        os.makedirs(dst_dir, exist_ok=True)
        clean_leftovers(dst_dir)

        for name in sorted(os.listdir(src_dir)):
            encrypted = name.endswith('.rpgmvo')
            if not encrypted and not name.endswith('.ogg'):
                continue
            found += 1
            track = {'src': os.path.join(src_dir, name), 'dst': os.path.join(dst_dir, name),
                     'name': f'{folder}/{name}', 'encrypted': encrypted}
            info = vorbis_headers(read_ogg(track['src'], encrypted, key, 4096))
            if info is None:
                foreign += 1
                note(f'  {track["name"]}: not Ogg Vorbis, left as it was')
            elif info[0] == 1 and info[1] <= args.rate:
                if not args.inplace:
                    shutil.copyfile(track['src'], track['dst'])
            else:
                track['channels'] = info[0]
                tracks.append(track)

    if not found:
        sys.exit('No bgm/bgs/me tracks found. Point this at www/audio.')
    if not tracks:
        note(f'All {found - foreign} tracks are already mono at {args.rate} Hz or below. '
             'Nothing to do.')
        return

    enc = find_encoder()
    if enc is None:
        print('Cannot shrink the music: no Ogg Vorbis encoder. The port\'s own in '
              'tools/aarch64 is missing or will not run here, and neither vorbis-tools nor '
              'ffmpeg is installed. The game will run, with far less memory to spare.',
              flush=True)
        sys.exit(1)
    note(f'Encoding with {enc.label}, {args.jobs} at a time')

    skipped = [t for t in tracks if not enc.can_take(t['channels'])]
    for t in skipped:
        print(f'  !! {t["name"]}: {t["channels"]} channels, left as it was', flush=True)
    tracks = [t for t in tracks if enc.can_take(t['channels'])]

    print(f'Shrinking {len(tracks)} music and ambience tracks to fit in 1 GB of RAM.', flush=True)
    print('This happens once and takes a few minutes.', flush=True)

    lock = threading.Lock()
    done = failed = before = after = 0
    start = time.monotonic()

    def run(track):
        nonlocal done, failed, before, after
        size_in = os.path.getsize(track['src'])
        try:
            size_out = convert(track, enc, key, args.rate, args.quality)
        except Exception as e:  # one bad track must not stop the others
            size_out, err = None, e
        with lock:
            done += 1
            if size_out is None:
                failed += 1
                print(f'[{done}/{len(tracks)}] !! {track["name"]}: could not convert, '
                      'left as it was', flush=True)
                note(f'    {err}')
            else:
                before += size_in
                after += size_out
                print(f'[{done}/{len(tracks)}] {track["name"]}: '
                      f'{size_in / 1e6:.1f} -> {size_out / 1e6:.1f} MB', flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        list(pool.map(run, tracks))

    took = time.monotonic() - start
    print(f'Done in {int(took // 60)}m {int(took % 60):02d}s: {done - failed} tracks, '
          f'{before / 1e6:.0f} MB -> {after / 1e6:.0f} MB on disk.'
          + (f' {failed} could not be converted and play as they were.' if failed else ''),
          flush=True)
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
