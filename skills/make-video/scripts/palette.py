#!/usr/bin/env python3
"""Extract a palette from a reference image (or a video frame) for a custom style.

    python3 palette.py reference.png            # swatches with roles
    python3 palette.py reference.png --json     # machine-readable
    python3 palette.py clip.mp4 --at 3.5        # sample a video frame

Downscales with ffmpeg, runs a small deterministic k-means in pure Python and
assigns roles: bg (largest area), ink (highest contrast against bg), accent
(most saturated remaining), then the rest as extra colors. Prints a palette
object you can paste over a theme in index.html:

    const theme = applyTheme({ ...themes['cut-paper'], palette: { bg, ink, accent, muted, colors } }, { width: W, height: H });
"""
from __future__ import annotations

import argparse
import colorsys
import json
import subprocess
import sys
from pathlib import Path

SIZE = 72


def load_pixels(path: Path, at: float | None) -> list[tuple[int, int, int]]:
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error"]
    if at is not None:
        cmd += ["-ss", f"{at:.3f}"]
    cmd += ["-i", str(path), "-frames:v", "1", "-vf", f"scale={SIZE}:{SIZE}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    data = subprocess.run(cmd, capture_output=True).stdout
    if len(data) < 3:
        raise SystemExit(f"could not decode {path}")
    return [(data[i], data[i + 1], data[i + 2]) for i in range(0, len(data) - 2, 3)]


def _lin(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb) -> float:
    return 0.2126 * _lin(rgb[0]) + 0.7152 * _lin(rgb[1]) + 0.0722 * _lin(rgb[2])


def contrast(a, b) -> float:
    la, lb = sorted([luminance(a), luminance(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def kmeans(px: list[tuple[int, int, int]], k: int, iters: int = 14) -> list[tuple[tuple[int, int, int], int]]:
    # Deterministic farthest-point init.
    centers = [max(px, key=lambda p: sum(p))]
    while len(centers) < k:
        centers.append(max(px, key=lambda p: min(sum((p[i] - c[i]) ** 2 for i in range(3)) for c in centers)))
    centers = [tuple(float(v) for v in c) for c in centers]
    assign = [0] * len(px)
    for _ in range(iters):
        for j, p in enumerate(px):
            assign[j] = min(range(len(centers)), key=lambda c: sum((p[i] - centers[c][i]) ** 2 for i in range(3)))
        sums = [[0.0, 0.0, 0.0, 0] for _ in centers]
        for p, a in zip(px, assign):
            s = sums[a]
            s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3] += 1
        centers = [(s[0] / s[3], s[1] / s[3], s[2] / s[3]) if s[3] else centers[i] for i, s in enumerate(sums)]
    counts = [0] * len(centers)
    for a in assign:
        counts[a] += 1
    out = [(tuple(int(round(v)) for v in c), n) for c, n in zip(centers, counts) if n]
    return sorted(out, key=lambda x: -x[1])


def hexc(rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def saturation(rgb) -> float:
    return colorsys.rgb_to_hls(*(v / 255 for v in rgb))[2]


def build_palette(clusters) -> dict:
    total = sum(n for _, n in clusters)
    bg = clusters[0][0]
    rest = [c for c, _ in clusters[1:]]
    ink = max(rest, key=lambda c: contrast(c, bg)) if rest else ((20, 20, 20) if luminance(bg) > 0.4 else (240, 240, 240))
    if contrast(ink, bg) < 4.5:
        ink = (20, 20, 20) if luminance(bg) > 0.4 else (242, 240, 234)
    others = [c for c in rest if c != ink]
    accent = max(others, key=saturation) if others else ink
    muted = min(others, key=saturation) if len(others) > 1 else ink
    colors = sorted(others, key=lambda c: -saturation(c)) or [accent]
    return {
        "bg": hexc(bg), "ink": hexc(ink), "accent": hexc(accent), "muted": hexc(muted),
        "colors": [hexc(c) for c in colors],
        "coverage": {hexc(c): round(n / total, 3) for c, n in clusters},
        "ink_contrast": round(contrast(ink, bg), 2),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", type=Path)
    ap.add_argument("--colors", type=int, default=6)
    ap.add_argument("--at", type=float, help="timestamp when the input is a video")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if not a.image.exists():
        print(f"no such file: {a.image}", file=sys.stderr)
        return 2
    pal = build_palette(kmeans(load_pixels(a.image.resolve(), a.at), max(2, a.colors)))
    if a.json:
        print(json.dumps(pal, indent=2))
        return 0
    print(f"bg      {pal['bg']}   ({pal['coverage'][pal['bg']] * 100:.0f}% of the image)")
    print(f"ink     {pal['ink']}   (contrast {pal['ink_contrast']}:1 on bg)")
    print(f"accent  {pal['accent']}")
    print(f"muted   {pal['muted']}")
    print("colors  " + " ".join(pal["colors"]))
    js = {k: pal[k] for k in ("bg", "ink", "accent", "muted", "colors")}
    print("\npalette: " + json.dumps(js))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
