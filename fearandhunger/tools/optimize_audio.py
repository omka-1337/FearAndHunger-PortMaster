#!/usr/bin/env python3
"""Shrink the memory Fear & Hunger needs for music and ambience.

Run this once, on a PC, against the www/audio folder you are about to copy to
the handheld. It is not needed on the device and takes minutes there instead of
seconds.

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

Sound effects are left alone: there are 411 of them, they are short, and they are
not what fills the memory.

Usage
-----
    python3 optimize_audio.py <www/audio> [--inplace | --out DIR] [--quality N]

Needs ffmpeg on PATH.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HEADER = b'RPGMV\x00\x00\x00\x00\x03\x01\x00\x00\x00\x00\x00'
DEFAULT_KEY = 'd41d8cd98f00b204e9800998ecf8427e'
FOLDERS = ('bgm', 'bgs', 'me')


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


def decrypt(src, dst, key):
    raw = open(src, 'rb').read()
    body = bytearray(raw[16:])
    for i in range(min(16, len(body))):
        body[i] ^= key[i]
    open(dst, 'wb').write(body)


def encrypt(src, dst, key):
    body = bytearray(open(src, 'rb').read())
    for i in range(min(16, len(body))):
        body[i] ^= key[i]
    open(dst, 'wb').write(HEADER + bytes(body))


def convert(src, dst, key, rate, quality, encrypted):
    tmp = tempfile.mkdtemp(prefix='fnh-audio-')
    try:
        raw = os.path.join(tmp, 'in.ogg')
        out = os.path.join(tmp, 'out.ogg')
        if encrypted:
            decrypt(src, raw, key)
        else:
            shutil.copyfile(src, raw)
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-i', raw,
             '-ar', str(rate), '-ac', '1', '-c:a', 'libvorbis', '-q:a', str(quality), out],
            check=True)
        if encrypted:
            encrypt(out, dst, key)
        else:
            shutil.copyfile(out, dst)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('audio_dir', help='the www/audio folder')
    ap.add_argument('--out', help='write to this folder instead of converting in place')
    ap.add_argument('--inplace', action='store_true', help='overwrite the files given')
    ap.add_argument('--rate', type=int, default=22050, help='sample rate (default 22050)')
    ap.add_argument('--quality', type=int, default=5,
                    help='vorbis quality 0-10 (default 5; this changes file size, not RAM)')
    args = ap.parse_args()

    if not args.inplace and not args.out:
        ap.error('pick one of --inplace or --out DIR')
    if shutil.which('ffmpeg') is None:
        sys.exit('ffmpeg is not on PATH')

    key = bytes.fromhex(find_key(args.audio_dir))
    before = after = 0
    count = 0

    for folder in FOLDERS:
        src_dir = os.path.join(args.audio_dir, folder)
        if not os.path.isdir(src_dir):
            continue
        dst_dir = src_dir if args.inplace else os.path.join(args.out, folder)
        os.makedirs(dst_dir, exist_ok=True)

        for name in sorted(os.listdir(src_dir)):
            encrypted = name.endswith('.rpgmvo')
            if not encrypted and not name.endswith('.ogg'):
                continue
            src = os.path.join(src_dir, name)
            dst = os.path.join(dst_dir, name)
            size_in = os.path.getsize(src)
            try:
                if args.inplace:
                    staged = dst + '.new'
                    convert(src, staged, key, args.rate, args.quality, encrypted)
                    os.replace(staged, dst)
                else:
                    convert(src, dst, key, args.rate, args.quality, encrypted)
            except subprocess.CalledProcessError:
                print(f'  !! {folder}/{name}: ffmpeg failed, left as it was')
                continue
            size_out = os.path.getsize(dst)
            before += size_in
            after += size_out
            count += 1
            print(f'  {folder}/{name}: {size_in / 1e6:.1f} -> {size_out / 1e6:.1f} MB')

    if not count:
        sys.exit('No bgm/bgs/me tracks found. Point this at www/audio.')
    print(f'\n{count} tracks, {before / 1e6:.0f} MB -> {after / 1e6:.0f} MB on disk.')
    print('The saving that matters is in RAM, and it is larger than this.')


if __name__ == '__main__':
    main()
