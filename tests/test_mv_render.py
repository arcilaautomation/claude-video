"""End-to-end render tests: headless Chromium + ffmpeg (skipped when unavailable)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import MV_DIR, MV_SCRIPTS, renderer_status, synth_audio

RENDER = MV_SCRIPTS / "render.mjs"

pytestmark = pytest.mark.skipif(
    not (shutil.which("node") and shutil.which("ffmpeg") and renderer_status().get("ok")),
    reason="needs node, ffmpeg and a working Chromium (run skills/make-video/scripts/setup.py)",
)


def render(*args: str, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(RENDER), *args], capture_output=True, text=True, timeout=timeout)


def project(tmp_path: Path, body: str, name: str = "proj") -> Path:
    """A minimal composition using the runtime straight from the skill folder."""
    d = tmp_path / name
    (d / "lib").mkdir(parents=True)
    (d / "assets").mkdir()
    for f in (MV_DIR / "runtime").glob("*.js"):
        shutil.copy2(f, d / "lib" / f.name)
    (d / "index.html").write_text(
        f"<!doctype html><html><head><meta charset='utf-8'><title>{name}</title></head><body>"
        f"<script type='module'>{body}</script></body></html>",
        encoding="utf-8",
    )
    return d


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
                         capture_output=True, text=True).stdout
    return json.loads(out)


BASIC = """
import { defineVideo, h, css, ease } from './lib/mv.js';
defineVideo({
  width: 320, height: 180, fps: 12, background: '#203040',
  scenes: [
    { name: 'a', duration: 1.5, build(el) { el.append(h('div', { style: 'position:absolute;left:40px;top:60px;color:#fff;font:24px sans-serif' }, 'Hello')); },
      render(t, s) { css(s.el.firstChild, { x: 60 * s.at(0, 1, ease.outCubic) }); } },
    { name: 'b', duration: 1.5, transition: 'fade:0.5', canvas: true,
      render(t, s) { s.ctx.fillStyle = '#e63946'; s.ctx.fillRect(40 + t * 60, 50, 80, 80); } },
  ],
  audio(a) { a.pad({ chords: ['Am', 'F'], every: 1.25, gain: 0.1 }); a.pop(0.3); a.whoosh(0.9); },
  tracks: [{ src: 'assets/voice.wav', role: 'voice', at: 0.5 }],
});
"""


def test_video_render_end_to_end(tmp_path):
    d = project(tmp_path, BASIC)
    synth_audio(d / "assets" / "voice.wav", [("tone", 1.2)])
    info = json.loads(render("info", str(d)).stdout)
    assert info["duration"] == pytest.approx(2.5)  # 1.5 + 1.5 − 0.5 overlap
    assert info["scenes"][1]["start"] == pytest.approx(1.0)
    proc = render("video", str(d), "--json", "--workers", "2")
    assert proc.returncode == 0, proc.stderr
    summary = json.loads(proc.stdout)
    out = Path(summary["file"])
    assert out.exists() and summary["frames"] == 30
    data = probe(out)
    v = next(s for s in data["streams"] if s["codec_type"] == "video")
    a = next(s for s in data["streams"] if s["codec_type"] == "audio")
    assert (v["width"], v["height"], int(v["nb_read_frames"])) == (320, 180, 30)
    assert v["pix_fmt"] == "yuv420p"
    assert float(a["duration"]) == pytest.approx(2.5, abs=0.06)
    assert Path(summary["sheet"]).exists() and Path(summary["report"]).exists()
    assert summary["qa"] and not summary["qa"].get("error")
    assert "voice" in summary["audio"]


def test_partial_draft_and_stills(tmp_path):
    d = project(tmp_path, BASIC.replace("tracks: [{ src: 'assets/voice.wav', role: 'voice', at: 0.5 }],", ""))
    proc = render("video", str(d), "--draft", "--from", "1", "--to", "2", "--no-audio", "--no-qa", "--json")
    assert proc.returncode == 0, proc.stderr
    summary = json.loads(proc.stdout)
    assert summary["frames"] == 12 and summary["width"] == 160  # half-size draft
    proc = render("stills", str(d), "--at", "0.5,2.2", "--json")
    assert proc.returncode == 0, proc.stderr
    shots = json.loads(proc.stdout)
    assert [s["scene"] for s in shots] == ["a", "b"]
    png = Path(shots[0]["file"]).read_bytes()
    assert png[:4] == b"\x89PNG" and int.from_bytes(png[16:20], "big") == 320


def test_storyboard_sheet(tmp_path):
    d = project(tmp_path, BASIC.replace("tracks: [{ src: 'assets/voice.wav', role: 'voice', at: 0.5 }],", ""))
    proc = render("storyboard", str(d), "--json")
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout)
    assert Path(res["sheet"]).exists() and len(res["beats"]) == 2
    assert (Path(res["dir"]) / "index.html").exists()


def test_audit_flags_clipped_text(tmp_path):
    d = project(tmp_path, """
import { defineVideo, h } from './lib/mv.js';
defineVideo({ width: 320, height: 180, fps: 10, background: '#000',
  scenes: [{ name: 'cut', duration: 1, build(el) {
    el.append(h('div', { style: 'position:absolute;left:200px;top:70px;color:#fff;font:32px sans-serif;white-space:nowrap' }, 'Runs off the edge'));
  } }] });
""")
    proc = render("audit", str(d), "--json")
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout)
    clipped = [i for i in res["issues"] if i["type"] == "clipped"]
    assert clipped and clipped[0]["severity"] == "error" and "Runs off" in clipped[0]["text"]
    assert res["determinism"]["mismatches"] == []


def test_audit_catches_state_leaking_between_frames(tmp_path):
    d = project(tmp_path, """
import { defineVideo } from './lib/mv.js';
let calls = 0;  // state that survives between frames: forbidden
defineVideo({ width: 160, height: 90, fps: 10, background: '#000',
  scenes: [{ name: 'leak', duration: 3, canvas: true,
    render(t, s) { calls++; s.ctx.fillStyle = `hsl(${(calls * 47) % 360} 80% 50%)`; s.ctx.fillRect(0, 0, 160, 90); } }] });
""")
    res = json.loads(render("audit", str(d), "--json").stdout)
    assert res["determinism"]["mismatches"], "a frame that depends on render order must be caught"


def test_composition_error_is_reported(tmp_path):
    d = project(tmp_path, "import { defineVideo } from './lib/mv.js'; defineVideo({ width: 0, height: 10, scenes: [] });")
    proc = render("info", str(d))
    assert proc.returncode == 3
    assert "config.width must be a positive number" in proc.stderr


def test_tall_composition_is_not_clipped(tmp_path):
    """Pages open before their size is known; the viewport must grow to fit (9:16, 4K, 21:9)."""
    d = project(tmp_path, """
import { defineVideo } from './lib/mv.js';
defineVideo({ width: 200, height: 1200, fps: 10, background: '#000',
  scenes: [{ name: 'tall', duration: 0.3, canvas: true, render(t, s) { s.ctx.fillStyle = '#ff0000'; s.ctx.fillRect(0, 0, 200, 1200); } }] });
""")
    proc = render("video", str(d), "--workers", "1", "--no-audio", "--no-qa", "--no-sheet", "--json")
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)["file"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", out, "-frames:v", "1", "-vf", "crop=200:40:0:1150", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True).stdout
    reds = raw[0::3]
    assert sum(reds) / len(reds) > 200, "bottom of a tall frame came out dark — viewport clipped the capture"


def test_mix_keeps_full_length_when_voice_ends_early(tmp_path):
    """Ducking used to stop the music when the (shorter) voice track ended."""
    d = project(tmp_path, """
import { defineVideo } from './lib/mv.js';
defineVideo({ width: 160, height: 90, fps: 10, background: '#222', scenes: [{ name: 's', duration: 6 }],
  tracks: [
    { src: 'assets/music.wav', role: 'music', loop: true, gain: 0.8, fadeIn: 0.5 },
    { src: 'assets/voice.wav', role: 'voice', at: 1, trim: 0.5, duration: 2.0 },
  ] });
""")
    synth_audio(d / "assets" / "music.wav", [("tone", 1.5)])
    synth_audio(d / "assets" / "voice.wav", [("tone", 2.0), ("gap", 1.0)])
    proc = render("audio", str(d))
    assert proc.returncode == 0, proc.stderr
    wav = d / "out" / "audio.wav"
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(wav), "-ac", "1", "-ar", "1000", "-f", "s16le", "-"], capture_output=True).stdout
    samples = [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw) - 1, 2)]
    assert len(samples) / 1000 == pytest.approx(6.0, abs=0.05)
    tail = samples[4000:5900]  # well after the voice ended at 3 s
    rms = (sum(v * v for v in tail) / len(tail)) ** 0.5 / 32768
    assert rms > 0.01, "music must keep playing after the voice ends"
