#!/usr/bin/env python3
"""Turn a photo into a racer face texture (512x660 WebP, soft oval cut-out).

Usage: python3 tools/make-face.py <photo> <character-id> [--box x0,y0,x1,y1] [--smooth]
Example: python3 tools/make-face.py ~/isaac.jpg isaac --box 125,100,315,360

--box is the head (hair to chin) in photo pixels; without it a centred box in
the upper half of the photo is used. Output: senai-rush-netlify/assets/<id>-face.webp
(the kart model loads tavares/isaac/... faces from there). Requires Pillow.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
W, H = 512, 660


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("photo")
    ap.add_argument("id")
    ap.add_argument("--box", help="x0,y0,x1,y1 of the head in the photo")
    ap.add_argument("--smooth", action="store_true", help="denoise grainy phone photos")
    args = ap.parse_args()

    img = ImageOps.exif_transpose(Image.open(args.photo)).convert("RGB")
    if args.box:
        x0, y0, x1, y1 = (int(v) for v in args.box.split(","))
    else:
        w, h = img.size
        bw = w * 0.45
        x0, x1 = (w - bw) / 2, (w + bw) / 2
        y0, y1 = h * 0.15, h * 0.15 + bw * H / W
    # grow the box to the texture's aspect ratio around its centre
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = x1 - x0, y1 - y0
    if bw / bh < W / H:
        bw = bh * W / H
    else:
        bh = bw * H / W
    face = img.crop((round(cx - bw / 2), round(cy - bh / 2), round(cx + bw / 2), round(cy + bh / 2)))
    face = face.resize((W, H), Image.LANCZOS)
    if args.smooth:
        face = face.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.SMOOTH_MORE)
    face = ImageOps.autocontrast(face, cutoff=1)

    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).ellipse((14, 10, W - 14, H - 10), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(8))
    face.putalpha(mask)

    out = ROOT / "senai-rush-netlify" / "assets" / f"{args.id}-face.webp"
    face.save(out, "WEBP", quality=88, method=6)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
