#!/usr/bin/env python3
"""Regenerate icons/icon{16,32,48,128}.png (and their -gray variants) from
assets/source/icon.png.

Run after editing the source icon:

    python3 make_icons.py

Requires Pillow (`pip install Pillow`).
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is not installed. Run: pip install Pillow")

ROOT = Path(__file__).parent
# Must stay in step with the "icons" / "action.default_icon" keys in manifest.json.
SIZES = (16, 32, 48, 128)


def grayscale(img: Image.Image) -> Image.Image:
    # ImageOps.grayscale drops alpha, so desaturate the RGB channels and splice
    # the original alpha back in — keeps the cutout transparent instead of
    # matting it to a solid box.
    alpha = img.getchannel("A")
    gray = ImageOps.grayscale(img).convert("RGBA")
    gray.putalpha(alpha)
    return gray


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--source", type=Path, default=ROOT / "assets" / "source" / "icon.png",
        help="source image (default: assets/source/icon.png)",
    )
    ap.add_argument("--out", type=Path, default=ROOT / "icons", help="output directory (default: icons/)")
    args = ap.parse_args()

    if not args.source.exists():
        sys.exit(f"No source image at {args.source}")

    # RGBA keeps the transparent background transparent instead of matting it to black.
    img = Image.open(args.source).convert("RGBA")

    if img.width != img.height:
        print(f"warning: {args.source.name} is {img.width}x{img.height}, not square — output will be squashed")
    if min(img.size) < max(SIZES):
        print(f"warning: source is smaller than {max(SIZES)}px, large icons will be upscaled and soft")

    gray_img = grayscale(img)

    args.out.mkdir(exist_ok=True)
    written = 0
    for size in SIZES:
        for variant, source_img in (("", img), ("-gray", gray_img)):
            dest = args.out / f"icon{size}{variant}.png"
            source_img.resize((size, size), Image.LANCZOS).save(dest, "PNG", optimize=True)
            print(f"{dest.relative_to(ROOT)}  ({dest.stat().st_size:,} bytes)")
            written += 1

    print(f"\nWrote {written} icons from {args.source.relative_to(ROOT)}. Reload the extension at chrome://extensions to see them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
