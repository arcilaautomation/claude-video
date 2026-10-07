#!/usr/bin/env python3
"""Prepare footage and grab frames for compositions.

    python3 media.py clip  in.mp4 assets/demo.webm [--start 3 --end 12] [--width 1920] [--fps 30]
        → assets/demo.webm (VP9, seek-friendly, muted) + assets/demo.audio.wav (if the clip has sound)
          Use with videoClip('assets/demo.webm') and add the wav as a track.
    python3 media.py still in.mp4 4.5 assets/frame.png     one frame at t=4.5s
    python3 media.py frames in.mp4 assets/seq --fps 10     image sequence (frame_0001.jpg …)
    python3 media.py probe in.mp4                          duration / size / fps / audio as JSON

Why: headless Chromium (Playwright's build) cannot decode H.264/AAC, so MP4
screen recordings must become WebM, with short GOPs so the renderer can seek
to any frame quickly and exactly.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg failed: {proc.stderr.strip()[-600:]}")


def probe(path: Path) -> dict:
    proc = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffprobe failed: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    v = next((s for s in data["streams"] if s.get("codec_type") == "video"), {})
    a = next((s for s in data["streams"] if s.get("codec_type") == "audio"), None)
    num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
    return {
        "duration": float(data["format"].get("duration") or 0),
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": round(float(num) / float(den or 1), 3) if float(den or 1) else None,
        "video_codec": v.get("codec_name"),
        "audio": bool(a),
    }


def trim_args(start: float | None, end: float | None) -> list[str]:
    out = []
    if start:
        out += ["-ss", f"{start:.3f}"]
    if end:
        out += ["-to", f"{end:.3f}"]
    return out


def cmd_clip(a) -> int:
    src, dst = a.input.resolve(), a.output.resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    info = probe(src)
    vf = [f"fps={a.fps}"]
    if a.width:
        vf.append(f"scale={a.width}:-2:flags=lanczos")
    gop = max(1, int(a.fps // 2))
    run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *trim_args(a.start, a.end), "-i", str(src), "-an",
         "-vf", ",".join(vf), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(a.crf), "-row-mt", "1",
         "-deadline", "good", "-cpu-used", "4", "-g", str(gop), "-keyint_min", str(gop), "-pix_fmt", "yuv420p", str(dst)])
    print(f"wrote {dst} ({probe(dst)['duration']:.2f}s, keyframe every {gop} frames)")
    if info["audio"] and not a.no_audio:
        wav = dst.with_name(dst.stem + ".audio.wav")
        run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *trim_args(a.start, a.end), "-i", str(src), "-vn", "-ac", "2", "-ar", "48000", str(wav)])
        rel = f"{dst.parent.name}/{wav.name}" if dst.parent.name == "assets" else str(wav)
        print(f"wrote {wav}")
        print(f"  the <video> layer is muted — add its sound as a track: {{ src: '{rel}', role: 'fx', at: <scene start + trim> }}")
    return 0


def cmd_still(a) -> int:
    dst = a.output.resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-ss", f"{a.time:.3f}", "-i", str(a.input.resolve()), "-frames:v", "1", str(dst)])
    print(f"wrote {dst}")
    return 0


def cmd_frames(a) -> int:
    out = a.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    vf = f"fps={a.fps}" + (f",scale={a.width}:-2" if a.width else "")
    run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *trim_args(a.start, a.end), "-i", str(a.input.resolve()), "-vf", vf, "-q:v", "2", str(out / "frame_%04d.jpg")])
    print(f"wrote {len(list(out.glob('frame_*.jpg')))} frames to {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("clip", help="convert footage to seekable WebM (+ audio wav)")
    c.add_argument("input", type=Path)
    c.add_argument("output", type=Path)
    c.add_argument("--start", type=float)
    c.add_argument("--end", type=float)
    c.add_argument("--fps", type=float, default=30)
    c.add_argument("--width", type=int)
    c.add_argument("--crf", type=int, default=32)
    c.add_argument("--no-audio", action="store_true")
    s = sub.add_parser("still", help="grab one frame")
    s.add_argument("input", type=Path)
    s.add_argument("time", type=float)
    s.add_argument("output", type=Path)
    f = sub.add_parser("frames", help="export an image sequence")
    f.add_argument("input", type=Path)
    f.add_argument("output", type=Path)
    f.add_argument("--fps", type=float, default=10)
    f.add_argument("--width", type=int)
    f.add_argument("--start", type=float)
    f.add_argument("--end", type=float)
    p = sub.add_parser("probe", help="print media facts as JSON")
    p.add_argument("input", type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "probe":
        print(json.dumps(probe(a.input.resolve()), indent=2))
        return 0
    return {"clip": cmd_clip, "still": cmd_still, "frames": cmd_frames}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
