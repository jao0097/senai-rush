#!/usr/bin/env python3
"""Build a single self-contained index.html that runs from file:// (double-click).

Browsers block ES modules, fonts, CSS and texture images loaded from file://,
so this bundles every JS chunk into one classic <script> with esbuild and
inlines CSS, fonts and images as data URIs.

Usage: python3 tools/build-offline.py
Output: senai-rush-offline/index.html
Requires: node/npx (esbuild is fetched via npx on first run).
"""
import base64
import mimetypes
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "senai-rush-netlify"
OUT = ROOT / "senai-rush-offline"
ESBUILD = ["npx", "-y", "esbuild@0.25"]

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")


def data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def main() -> None:
    html = (SRC / "index.html").read_text()
    entry = re.search(r'<script type="module"[^>]*src="\./assets/([^"]+)"', html).group(1)
    css_name = re.search(r'<link rel="stylesheet"[^>]*href="\./assets/([^"]+)"', html).group(1)
    favicon = re.search(r'rel="icon"[^>]*href="\./([^"]+)"', html).group(1)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for js in (SRC / "assets").glob("*.js"):
            text = js.read_text()
            # Face textures are loaded by THREE.TextureLoader; file:// images taint WebGL.
            text = re.sub(
                r"([`\"'])\./(assets/[^`\"']+\.(?:png|webp))\1",
                # optional faces (e.g. isaac) may not exist yet: leave the path, the loader falls back
                lambda m: m.group(1) + data_uri(SRC / m.group(2)) + m.group(1)
                if (SRC / m.group(2)).exists() else m.group(0),
                text,
            )
            # Everything ends up in one bundle, so Vite's dep preloading (which
            # resolves paths against import.meta.url) has nothing to fetch.
            # Re-minified chunks rename __vite__mapDeps, so match the call shape.
            text = re.sub(r"__vite__mapDeps\(\[[\d,]*\]\)", "[]", text)
            text = re.sub(r'(\(\)=>import\("[^"]+"\)),[\w$]+\(\[[\d,]*\]\)', r"\1,[]", text)
            (work / js.name).write_text(text)

        bundle = work / "bundle.js"
        subprocess.run(
            ESBUILD + [str(work / entry), "--bundle", "--format=iife", "--minify",
                       "--log-level=error", f"--outfile={bundle}"],
            check=True,
        )
        js = bundle.read_text()

    css = (SRC / "assets" / css_name).read_text()
    css = re.sub(
        r"url\(\.\./(fonts/[^)]+)\)",
        lambda m: f"url({data_uri(SRC / m.group(1))})",
        css,
    )

    html = re.sub(r'\s*<link rel="preload"[^>]*>', "", html)
    html = re.sub(r'\s*<script type="module"[^>]*></script>', "", html)
    html = re.sub(r'\s*<link rel="stylesheet"[^>]*>', "", html)
    html = html.replace(f'href="./{favicon}"', f'href="{data_uri(SRC / favicon)}"')
    html = html.replace("</head>", f"    <style>{css}</style>\n  </head>")
    js = js.replace("</script", "<\\/script")
    html = html.replace("</body>", f"    <script>{js}</script>\n  </body>")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    (OUT / "index.html").write_text(html)
    print(f"wrote {OUT / 'index.html'} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
