#!/usr/bin/env python3
"""Automated QA for a rendered video (any MP4/MOV/WebM).

    python3 qa.py out/video.mp4            # human-readable summary
    python3 qa.py out/video.mp4 --json     # machine-readable (render.mjs uses this)
    python3 qa.py any.mp4 --sheet sheet.jpg [--count 20]   # labeled contact sheet

Checks (pure stdlib + ffmpeg/ffprobe):
- stream facts: resolution, fps, frame count, duration, codecs, A/V length match
- black segments (blackdetect) and long frozen stretches (freezedetect)
- photosensitivity: more than 3 large luminance flashes within one second in
  any screen quadrant (a coarse proxy for the WCAG 2.3.1 general flash rule)
- audio: integrated loudness and true peak (EBU R128), long silences

These complement — not replace — looking at the frames: they catch the
mechanical failures (a blank scene, a stuck animation, clipping audio)
cheaply on every render.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def _run(cmd: list[str], *, binary: bool = False, timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=not binary, timeout=timeout)


def probe(path: Path) -> dict:
    proc = _run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    out: dict = {"duration": float(data.get("format", {}).get("duration") or 0.0)}
    if video:
        num, _, den = (video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1").partition("/")
        fps = float(num) / float(den or 1) if float(den or 1) else 0.0
        out["video"] = {
            "codec": video.get("codec_name"),
            "width": video.get("width"),
            "height": video.get("height"),
            "fps": round(fps, 3),
            "pix_fmt": video.get("pix_fmt"),
            "frames": int(video["nb_frames"]) if str(video.get("nb_frames", "")).isdigit() else None,
            "duration": float(video.get("duration") or out["duration"]),
        }
    if audio:
        out["audio"] = {
            "codec": audio.get("codec_name"),
            "channels": audio.get("channels"),
            "sample_rate": int(audio.get("sample_rate") or 0),
            "duration": float(audio.get("duration") or out["duration"]),
        }
    return out


def detect_black_freeze(path: Path) -> tuple[list[dict], list[dict]]:
    proc = _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-an",
        "-vf", "scale=320:-2,blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-55dB:d=1.0",
        "-f", "null", "-",
    ])
    log = proc.stderr
    black = [
        {"start": float(a), "end": float(b), "duration": float(c)}
        for a, b, c in re.findall(r"black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)", log)
    ]
    starts = [float(x) for x in re.findall(r"freeze_start:\s*([\d.]+)", log)]
    durs = [float(x) for x in re.findall(r"freeze_duration:\s*([\d.]+)", log)]
    frozen = [{"start": s, "duration": d, "end": s + d} for s, d in zip(starts, durs)]
    # A freeze still running at EOF has a start but no duration line.
    if len(starts) > len(durs):
        frozen.append({"start": starts[-1], "duration": None, "end": None})
    return black, frozen


def _quadrant_luma(path: Path, fps: float) -> list[list[float]]:
    """Mean relative luminance per frame for each of 4 screen quadrants."""
    w, h = 64, 36
    proc = _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), "-an",
        "-vf", f"scale={w}:{h}:flags=area,format=gray", "-f", "rawvideo", "-",
    ], binary=True)
    data = proc.stdout or b""
    size = w * h
    lin = [((v / 255.0) / 12.92) if v / 255.0 <= 0.04045 else (((v / 255.0) + 0.055) / 1.055) ** 2.4 for v in range(256)]
    frames: list[list[float]] = []
    for off in range(0, len(data) - size + 1, size):
        px = data[off: off + size]
        q = [0.0, 0.0, 0.0, 0.0]
        for y in range(h):
            row = px[y * w: (y + 1) * w]
            top = 0 if y < h // 2 else 2
            left = sum(lin[v] for v in row[: w // 2])
            right = sum(lin[v] for v in row[w // 2:])
            q[top] += left
            q[top + 1] += right
        n = (w // 2) * (h // 2)
        frames.append([v / n for v in q])
    return frames


def luminance_transitions(series: list[float]) -> list[int]:
    """Frame indices where relative luminance reverses by ≥ 10% (darker side < 0.8)."""
    events: list[int] = []
    if not series:
        return events
    anchor = series[0]
    direction = 0
    for i in range(1, len(series)):
        v = series[i]
        delta = v - anchor
        if abs(delta) >= 0.10 and min(v, anchor) < 0.80:
            d = 1 if delta > 0 else -1
            if d != direction:
                events.append(i)
                direction = d
            anchor = v
        elif (direction >= 0 and v > anchor) or (direction <= 0 and v < anchor):
            anchor = v  # keep tracking the extreme of the current swing
    return events


def detect_flashes(path: Path, fps: float) -> list[dict]:
    """1-second windows with more than 3 flashes (> 6 opposing luminance transitions)."""
    if fps <= 0:
        return []
    lum = _quadrant_luma(path, fps)
    win = max(1, int(round(fps)))
    hits: list[dict] = []
    for qi in range(4):
        events = luminance_transitions([f[qi] for f in lum])
        j = 0
        for i, f in enumerate(events):
            while events[j] <= f - win:
                j += 1
            transitions = i - j + 1
            if transitions > 6:
                t = events[j] / fps
                if not any(abs(h["time"] - t) < 1.0 for h in hits):
                    hits.append({"time": round(t, 2), "quadrant": qi, "flashes_per_second": (transitions + 1) // 2})
    hits.sort(key=lambda x: x["time"])
    return hits


def audio_metrics(path: Path) -> dict:
    proc = _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-vn",
        "-af", "ebur128=peak=true:framelog=quiet,silencedetect=n=-50dB:d=1.5", "-f", "null", "-",
    ])
    log = proc.stderr
    out: dict = {}
    summary = log[log.rfind("Summary:"):] if "Summary:" in log else ""
    m = re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)
    if m:
        out["lufs"] = None if m.group(1) == "-inf" else float(m.group(1))
    m = re.search(r"Peak:\s*(-?[\d.]+|-inf)\s*dBFS", summary)
    if m:
        out["true_peak_db"] = None if m.group(1) == "-inf" else float(m.group(1))
    starts = [float(x) for x in re.findall(r"silence_start:\s*(-?[\d.]+)", log)]
    ends = re.findall(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", log)
    silences = []
    for i, s in enumerate(starts):
        if i < len(ends):
            silences.append({"start": max(0.0, s), "end": float(ends[i][0]), "duration": float(ends[i][1])})
        else:
            silences.append({"start": max(0.0, s), "end": None, "duration": None})
    out["silences"] = silences
    return out


def fmt(t: float | None) -> str:
    if t is None:
        return "end"
    m = int(t // 60)
    return f"{m:02d}:{t - m * 60:05.2f}"


def analyze(path: Path) -> dict:
    info = probe(path)
    report: dict = {"file": str(path), **info, "warnings": []}
    warn = report["warnings"].append
    video = info.get("video")
    duration = info.get("duration") or 0.0
    if not video:
        warn("no video stream")
        report["summary"] = "no video stream"
        return report
    if video["width"] % 2 or video["height"] % 2:
        warn(f"odd dimensions {video['width']}x{video['height']} — many players need even sizes")
    black, frozen = detect_black_freeze(path)
    report["black"] = black
    report["frozen"] = frozen
    for b in black:
        at_edge = b["start"] < 0.05 or (duration and b["end"] > duration - 0.05)
        if b["duration"] >= (1.0 if at_edge else 0.4):
            warn(f"black frames {fmt(b['start'])}–{fmt(b['end'])} ({b['duration']:.1f}s)")
    for f in frozen:
        d = f["duration"] if f["duration"] is not None else duration - f["start"]
        if d >= 4.0:
            warn(f"nothing moves {fmt(f['start'])}–{fmt(f['end'])} ({d:.1f}s) — intended hold? add subtle motion")
    flashes = detect_flashes(path, video["fps"])
    report["flashes"] = flashes
    for fl in flashes[:5]:
        warn(f"possible photosensitivity risk at {fmt(fl['time'])}: {fl['flashes_per_second']} large flashes within 1s — keep ≤ 3/s")
    audio = info.get("audio")
    if audio:
        am = audio_metrics(path)
        report["audio"].update(am)
        lufs = am.get("lufs")
        tp = am.get("true_peak_db")
        if lufs is not None and not (-18.5 <= lufs <= -9.5):
            warn(f"loudness {lufs:.1f} LUFS (aim for about -14)")
        if tp is not None and tp > -0.3:
            warn(f"true peak {tp:.1f} dBFS — risk of clipping (keep below -1)")
        for s in am["silences"]:
            d = s["duration"] if s["duration"] is not None else duration - s["start"]
            if d >= 2.5 and s["start"] > 0.5:
                warn(f"silence {fmt(s['start'])}–{fmt(s['end'])} ({d:.1f}s)")
        if abs(audio["duration"] - video["duration"]) > 0.1:
            warn(f"audio is {audio['duration']:.2f}s but video is {video['duration']:.2f}s")
    parts = [f"{video['width']}x{video['height']} {video['fps']:g}fps {duration:.2f}s"]
    if audio:
        lufs = report["audio"].get("lufs")
        parts.append(f"audio {lufs:.1f} LUFS" if lufs is not None else "audio (silent)")
    else:
        parts.append("no audio")
    parts.append("no black/frozen/flash issues" if not report["warnings"] else f"{len(report['warnings'])} warning(s)")
    report["summary"] = " · ".join(parts)
    return report


def contact_sheet(path: Path, out: Path, count: int = 20) -> Path:
    """Labeled grid of `count` evenly spaced frames (ffmpeg tile + drawtext when available)."""
    info = probe(path)
    video = info.get("video") or {}
    duration = info.get("duration") or video.get("duration") or 0.0
    if not duration:
        raise RuntimeError("cannot read duration")
    w, h = video.get("width") or 16, video.get("height") or 9
    ar = w / h
    cols = 4 if ar >= 1.5 else 5 if ar > 0.8 else 6
    rows = math.ceil(count / cols)
    thumb_w = 480 if ar >= 1.5 else 384 if ar > 0.8 else 320
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mv-sheet-") as tmp:
        frames = []
        for i in range(count):
            t = duration * (i + 0.5) / count
            f = Path(tmp) / f"f{i:03d}.png"
            base = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1"]
            label = fmt(t).replace(":", r"\:")
            draw = (f",drawbox=x=0:y=ih-34:w=iw:h=34:color=black@0.6:t=fill,"
                    f"drawtext=text='{label}':x=10:y=h-27:fontsize=20:fontcolor=white")
            res = _run(base + ["-vf", f"scale={thumb_w}:-2{draw}", str(f)])
            if res.returncode != 0:
                res = _run(base + ["-vf", f"scale={thumb_w}:-2", str(f)])
            if res.returncode == 0 and f.exists():
                frames.append(f)
        if not frames:
            raise RuntimeError("could not extract frames")
        while len(frames) < cols * rows:
            frames.append(frames[-1])
        res = _run([
            "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-framerate", "1", "-i", str(Path(tmp) / "f%03d.png"),
            "-vf", f"tile={cols}x{rows}:padding=6:margin=6:color=0x141416", "-frames:v", "1", "-q:v", "3", str(out),
        ])
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip())
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--json", action="store_true", help="print the full report as JSON")
    ap.add_argument("--sheet", type=Path, help="also write a labeled contact sheet here")
    ap.add_argument("--count", type=int, default=20, help="frames in the contact sheet (default 20)")
    args = ap.parse_args(argv)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("qa.py needs ffmpeg and ffprobe on PATH", file=sys.stderr)
        return 2
    if not args.video.exists():
        print(f"no such file: {args.video}", file=sys.stderr)
        return 2
    report = analyze(args.video.resolve())
    if args.sheet:
        report["sheet"] = str(contact_sheet(args.video.resolve(), args.sheet.resolve(), args.count))
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"qa: {report['summary']}")
        for w in report["warnings"]:
            print(f"  - {w}")
        if report.get("sheet"):
            print(f"  contact sheet: {report['sheet']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
