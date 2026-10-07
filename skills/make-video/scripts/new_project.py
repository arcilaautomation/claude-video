#!/usr/bin/env python3
"""Scaffold a make-video project.

    python3 new_project.py my-video --style cut-paper --aspect 16:9 --fps 30 --title "How tides work"

Creates a self-contained folder:

    my-video/
      index.html        the composition (edit this) — from templates/<template>/
      brief.md          intake answers, story, script, storyboard notes
      lib/              runtime (mv.js, mv-draw.js, mv-audio.js, mv-themes.js)
      lib/fonts.css     open-source fonts vendored from the setup cache
      lib/katex/        (with --math) KaTeX for typeset equations
      assets/           images, audio, narration timing JSON
      out/              renders (git-ignored)

Projects carry their own copy of the runtime, so they keep rendering the same
way after the skill updates, and can be zipped and rendered anywhere.
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
from mv_env import deps_home  # noqa: E402

STYLES = ["cut-paper", "cross-hatch", "risograph", "sketchbook", "isometric", "chalkboard", "kinetic-type"]
TEMPLATES = ["starter", "explainer", "style-reel"]
ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "21:9": (2520, 1080)}
RUNTIME_FILES = ["mv.js", "mv-draw.js", "mv-audio.js", "mv-themes.js"]

# family → (npm package, css files to read)
FONTS = [
    ("Inter", "@fontsource-variable/inter", ["wght.css", "wght-italic.css"]),
    ("DM Sans", "@fontsource-variable/dm-sans", ["wght.css", "wght-italic.css"]),
    ("Space Grotesk", "@fontsource-variable/space-grotesk", ["wght.css"]),
    ("Fraunces", "@fontsource-variable/fraunces", ["full.css", "full-italic.css"]),
    ("EB Garamond", "@fontsource-variable/eb-garamond", ["wght.css", "wght-italic.css"]),
    ("JetBrains Mono", "@fontsource-variable/jetbrains-mono", ["wght.css"]),
    ("Caveat", "@fontsource-variable/caveat", ["wght.css"]),
    ("Archivo", "@fontsource-variable/archivo", ["wdth.css"]),
    ("Instrument Serif", "@fontsource/instrument-serif", ["400.css", "400-italic.css"]),
    ("Permanent Marker", "@fontsource/permanent-marker", ["400.css"]),
    ("Patrick Hand", "@fontsource/patrick-hand", ["400.css"]),
    ("Cabin Sketch", "@fontsource/cabin-sketch", ["400.css", "700.css"]),
    ("Space Mono", "@fontsource/space-mono", ["400.css", "700.css"]),
    ("Anton", "@fontsource/anton", ["400.css"]),
]

FACE_RE = re.compile(r"/\*\s*([^*]+?)\s*\*/\s*(@font-face\s*\{[^}]*\})", re.S)

BRIEF = """# {title} — brief

## Intake
- **Subject / goal:**
- **Audience:**
- **Format:** {width}×{height} ({aspect}), {fps} fps — target length:
- **Style:** {style} (references/styles/{style}.md)
- **Audio:** narration? (voice / backend) · music bed? · sound effects?
- **Hero character:**
- **Captions:**
- **References:** (images / videos and what to take from each)
- **Must include / avoid:**

## Story
One sentence:

Beats — what the viewer understands at each step:
1. Hook —
2.
3.
4. Payoff / call to action —

## Script
(narration, ~2.5 words per second; leave blank for music-only videos)

## Storyboard
| # | time | scene | on screen | narration / sound |
|---|------|-------|-----------|-------------------|
| 1 | | | | |

## Review log
- render 1:
"""

GITIGNORE = "out/\n"


def vendor_fonts(lib: Path) -> tuple[int, list[str]]:
    """Copy latin + latin-ext woff2 subsets and write lib/fonts.css. Returns (files, missing families)."""
    modules = deps_home() / "node_modules"
    fonts_dir = lib / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    css_out = ["/* Open-source fonts (SIL OFL) vendored from Fontsource by new_project.py. */"]
    copied = 0
    missing: list[str] = []
    for family, pkg, css_files in FONTS:
        pkg_dir = modules / pkg
        if not pkg_dir.exists():
            missing.append(family)
            continue
        for css_name in css_files:
            css_path = pkg_dir / css_name
            if not css_path.exists():
                continue
            for comment, block in FACE_RE.findall(css_path.read_text(encoding="utf-8")):
                if "-latin-" not in comment:
                    continue
                files = re.findall(r"url\(\./files/([^)]+\.woff2)\)", block)
                if not files:
                    continue
                block = re.sub(r"font-family:\s*'[^']*'", f"font-family: '{family}'", block)
                block = re.sub(r",\s*url\(\./files/[^)]+\.woff\)\s*format\('woff'\)", "", block)
                block = block.replace("url(./files/", "url(fonts/").replace("font-display: swap", "font-display: block")
                for f in files:
                    src = pkg_dir / "files" / f
                    if src.exists():
                        shutil.copy2(src, fonts_dir / f)
                        copied += 1
                css_out.append(block)
    (lib / "fonts.css").write_text("\n".join(css_out) + "\n", encoding="utf-8")
    return copied, missing


def vendor_katex(lib: Path) -> bool:
    dist = deps_home() / "node_modules" / "katex" / "dist"
    if not dist.exists():
        return False
    kdir = lib / "katex"
    (kdir / "fonts").mkdir(parents=True, exist_ok=True)
    for name in ["katex.min.css", "katex.mjs"]:
        shutil.copy2(dist / name, kdir / name)
    for f in (dist / "fonts").glob("*.woff2"):
        shutil.copy2(f, kdir / "fonts" / f.name)
    return True


def parse_size(args) -> tuple[int, int, str]:
    if args.size:
        m = re.fullmatch(r"(\d+)\s*[x×]\s*(\d+)", args.size)
        if not m:
            raise SystemExit("--size must look like 1920x1080")
        w, h = int(m.group(1)), int(m.group(2))
        aspect = next((k for k, v in ASPECTS.items() if v[0] * h == v[1] * w), f"{w}:{h}")
        return w, h, aspect
    if args.aspect not in ASPECTS:
        raise SystemExit(f"--aspect must be one of {', '.join(ASPECTS)}")
    w, h = ASPECTS[args.aspect]
    return w, h, args.aspect


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", type=Path, help="project folder to create")
    ap.add_argument("--style", default="chalkboard", help=f"one of: {', '.join(STYLES)} (default chalkboard)")
    ap.add_argument("--template", default="starter", choices=TEMPLATES)
    ap.add_argument("--aspect", default="16:9", help="16:9 | 9:16 | 1:1 | 4:5 | 21:9")
    ap.add_argument("--size", help="explicit WxH, e.g. 1280x720 (overrides --aspect)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--title", default=None)
    ap.add_argument("--math", action="store_true", help="vendor KaTeX for typeset equations")
    ap.add_argument("--force", action="store_true", help="overwrite template files in an existing folder")
    args = ap.parse_args(argv)

    if args.style not in STYLES:
        raise SystemExit(f"unknown style {args.style!r} — choose one of: {', '.join(STYLES)} (custom looks start from the closest one)")
    width, height, aspect = parse_size(args)
    if width % 2 or height % 2:
        raise SystemExit("width and height must be even (H.264 needs even dimensions)")
    target = args.dir.resolve()
    if target.exists() and any(target.iterdir()) and not args.force:
        raise SystemExit(f"{target} already exists and is not empty (use --force to overwrite its template files)")
    title = args.title or target.name.replace("-", " ").replace("_", " ").strip().title()

    lib = target / "lib"
    lib.mkdir(parents=True, exist_ok=True)
    (target / "assets").mkdir(exist_ok=True)
    (target / "out").mkdir(exist_ok=True)
    for name in RUNTIME_FILES:
        shutil.copy2(SKILL_DIR / "runtime" / name, lib / name)
    copied, missing = vendor_fonts(lib)
    math = args.math or args.template == "explainer"
    katex = vendor_katex(lib) if math else False

    tdir = SKILL_DIR / "templates" / args.template
    subs = {
        "{{TITLE}}": title.replace("\\", "\\\\").replace("'", "\\'").replace("<", "&lt;"),
        "{{STYLE}}": args.style,
        "{{WIDTH}}": str(width),
        "{{HEIGHT}}": str(height),
        "{{FPS}}": str(args.fps),
    }
    for src in tdir.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(tdir)
        dst = target / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in {".html", ".js", ".css", ".md", ".json"}:
            text = src.read_text(encoding="utf-8")
            for k, v in subs.items():
                text = text.replace(k, v)
            dst.write_text(text, encoding="utf-8")
        else:
            shutil.copy2(src, dst)
    brief = target / "brief.md"
    if not brief.exists():
        brief.write_text(BRIEF.format(title=title, width=width, height=height, aspect=aspect, fps=args.fps, style=args.style), encoding="utf-8")
    gi = target / ".gitignore"
    if not gi.exists():
        gi.write_text(GITIGNORE, encoding="utf-8")

    print(f"created {target}")
    print(f"  {width}x{height} ({aspect}) · {args.fps} fps · style {args.style} · template {args.template}")
    if missing:
        print(f"  fonts: {copied} files vendored; missing {', '.join(missing)} — run setup.py so styles get their real fonts (falls back to system fonts meanwhile)")
    else:
        print(f"  fonts: {copied} font files vendored into lib/fonts/")
    if math:
        print("  math: KaTeX vendored into lib/katex/" if katex else "  math: KaTeX not found in the setup cache — run setup.py, then re-scaffold with --math")
    render = SCRIPT_DIR / "render.mjs"
    print("next:")
    print(f"  edit      {target / 'index.html'}  (and fill in {brief.name})")
    print(f"  storyboard  node \"{render}\" storyboard \"{target}\"")
    print(f"  preview     node \"{render}\" serve \"{target}\"")
    print(f"  render      node \"{render}\" video \"{target}\" [--draft]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
