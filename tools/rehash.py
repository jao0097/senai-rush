#!/usr/bin/env python3
"""Give every JS chunk in senai-rush-netlify/assets a fresh hash suffix.

The server (and most CDNs) cache files named like `game-BVaTPfK4.js` as
immutable, so after editing a bundle in place returning players keep the old
copy. Run this after editing any chunk: it renames all `<name>-<8 chars>.js`
chunks to `<name>-<new id>.js` (one id derived from the current contents) and
rewrites every reference in the chunks, index.html and online/online.js.
Renaming all chunks together keeps cross-chunk imports consistent.

Usage: python3 tools/rehash.py
"""
import base64
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "senai-rush-netlify"
ASSETS = SRC / "assets"
CHUNK = re.compile(r"^([a-zA-Z]+)-([A-Za-z0-9_-]{8})\.js$")


def main() -> None:
    chunks = sorted(p for p in ASSETS.glob("*.js") if CHUNK.match(p.name))
    digest = hashlib.sha256()
    for p in chunks:
        digest.update(p.name.encode())
        digest.update(p.read_bytes())
    build = base64.urlsafe_b64encode(digest.digest()).decode()[:8]
    renames = {p.name: f"{CHUNK.match(p.name).group(1)}-{build}.js" for p in chunks}
    renames = {old: new for old, new in renames.items() if old != new}
    if not renames:
        print("already up to date")
        return

    pattern = re.compile("|".join(re.escape(old) for old in renames))
    fix = lambda text: pattern.sub(lambda m: renames[m.group(0)], text)
    for p in chunks:
        p.write_text(fix(p.read_text(encoding="utf-8")), encoding="utf-8")
        if p.name in renames:
            p.rename(p.with_name(renames[p.name]))
    for p in (SRC / "index.html", SRC / "online" / "online.js"):
        p.write_text(fix(p.read_text(encoding="utf-8")), encoding="utf-8")
    for old, new in renames.items():
        print(f"{old} -> {new}")


if __name__ == "__main__":
    main()
