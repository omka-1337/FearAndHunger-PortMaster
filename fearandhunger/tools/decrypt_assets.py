#!/usr/bin/env python3
"""Remove RPG Maker MV's asset encryption, so the engine can load files normally.

Run this once, on a PC, over the www folder you are copying to the handheld.

Why it exists
-------------
MV does not hand an encrypted image to the browser. For every single load it
fires an XMLHttpRequest, pulls the whole file into an ArrayBuffer, decrypts the
first sixteen bytes in JavaScript, wraps the result in a blob and points an
<img> at that. Requests to file:// are not cached by Chromium, so this happens
again in full every time the image cache evicts something - and on a handheld
the image cache is small while the SD card is slow.

Measured on an RG40XX V: the game read 926 MB off the card in 100 seconds, far
more than the whole game weighs, and spent the time waiting rather than drawing.

Decrypted files load through Image.src and the audio element instead, which
Chromium decodes natively and the kernel's page cache can actually hold on to.
The encryption was never protecting anything here anyway: the key is the md5 of
the empty string, which is what RPG Maker writes when encryption is left on with
no password set.

Usage
-----
    python3 decrypt_assets.py <www> [--dry-run]

Renames img/**.rpgmvp to .png and audio/**.rpgmvo to .ogg, strips the headers,
and clears hasEncryptedImages and hasEncryptedAudio in data/System.json. The
game then looks for exactly those names. Keep a copy of your own installation if
you want to go back - this edits in place.
"""

import argparse
import json
import os
import sys

HEADER_LEN = 16
EXT = {'.rpgmvp': '.png', '.rpgmvo': '.ogg', '.rpgmvm': '.m4a',
       '.png_': '.png', '.ogg_': '.ogg'}


def decrypt_file(path, out, key):
    with open(path, 'rb') as fh:
        data = fh.read()
    if data[:5] != b'RPGMV':
        return False
    body = bytearray(data[HEADER_LEN:])
    for i in range(min(HEADER_LEN, len(body))):
        body[i] ^= key[i]
    with open(out, 'wb') as fh:
        fh.write(body)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('www', help='the game\'s www folder')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    system_path = os.path.join(args.www, 'data', 'System.json')
    if not os.path.isfile(system_path):
        sys.exit(f'No data/System.json under {args.www}')

    with open(system_path, encoding='utf-8') as fh:
        system = json.load(fh)

    key_hex = system.get('encryptionKey') or ''
    if not key_hex:
        sys.exit('System.json carries no encryptionKey; nothing to do.')
    key = bytes.fromhex(key_hex)

    done = skipped = 0
    total_bytes = 0
    for root, _, files in os.walk(args.www):
        for name in files:
            stem, ext = os.path.splitext(name)
            if ext not in EXT:
                continue
            src = os.path.join(root, name)
            dst = os.path.join(root, stem + EXT[ext])
            total_bytes += os.path.getsize(src)
            if args.dry_run:
                done += 1
                continue
            if decrypt_file(src, dst, key):
                os.remove(src)
                done += 1
            else:
                skipped += 1

    if args.dry_run:
        print(f'Would decrypt {done} files ({total_bytes / 1e6:.0f} MB).')
        return

    system['hasEncryptedImages'] = False
    system['hasEncryptedAudio'] = False
    with open(system_path, 'w', encoding='utf-8') as fh:
        json.dump(system, fh, ensure_ascii=False, separators=(',', ':'))

    print(f'Decrypted {done} files ({total_bytes / 1e6:.0f} MB).'
          + (f' {skipped} were not encrypted and were left alone.' if skipped else ''))
    print('System.json updated: the game will now load them directly.')


if __name__ == '__main__':
    main()
