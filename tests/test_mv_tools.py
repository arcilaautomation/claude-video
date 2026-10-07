"""make-video tooling: QA checks, scaffolding, setup preflight, palette and media helpers."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import MV_SCRIPTS, _run, load_mv

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is required")


def run_script(name: str, *args: str, env: dict | None = None):
    return subprocess.run([sys.executable, str(MV_SCRIPTS / name), *args], capture_output=True, text=True, env=env, timeout=300)


# ──────────────────────────────────────────────────────────────── qa ──

def _clip(path: Path, vf_input: str, seconds: float, audio: bool = False, vf: str | None = None) -> Path:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", vf_input]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}"]
    if vf:
        cmd += ["-vf", vf]
    cmd += ["-t", str(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if audio:
        cmd += ["-c:a", "aac", "-shortest"]
    _run(cmd + [str(path)])
    return path


def test_qa_clean_clip(tmp_path):
    qa = load_mv("qa")
    clip = _clip(tmp_path / "ok.mp4", "testsrc2=size=320x180:rate=30", 3, audio=True)
    rep = qa.analyze(clip)
    assert rep["video"]["width"] == 320 and rep["video"]["fps"] == 30
    assert rep["black"] == [] and rep["flashes"] == []
    assert rep["audio"]["lufs"] is not None
    assert not [w for w in rep["warnings"] if "black" in w or "flash" in w]


def test_qa_flags_black_and_frozen(tmp_path):
    qa = load_mv("qa")
    rep = qa.analyze(_clip(tmp_path / "black.mp4", "color=c=black:s=320x180:r=30", 6))
    assert any("black frames" in w for w in rep["warnings"])
    assert any("nothing moves" in w for w in rep["warnings"])


def test_qa_flags_flashing(tmp_path):
    qa = load_mv("qa")
    clip = _clip(tmp_path / "flash.mp4", "color=c=white:s=320x180:r=30", 3, vf="geq=lum='if(lt(mod(N,6),3),235,16)':cb=128:cr=128")
    rep = qa.analyze(clip)
    assert rep["flashes"], "a 5 Hz full-frame strobe must be flagged"
    assert any("photosensitivity" in w for w in rep["warnings"])


def test_luminance_transitions():
    qa = load_mv("qa")
    steady = [0.5 + 0.01 * (i % 2) for i in range(60)]
    assert qa.luminance_transitions(steady) == []
    strobe = [0.05 if (i // 3) % 2 else 0.9 for i in range(30)]
    assert len(qa.luminance_transitions(strobe)) >= 8


def test_qa_cli_sheet(tmp_path):
    clip = _clip(tmp_path / "c.mp4", "testsrc2=size=320x180:rate=30", 2)
    proc = run_script("qa.py", str(clip), "--json", "--sheet", str(tmp_path / "sheet.jpg"), "--count", "8")
    assert proc.returncode == 0, proc.stderr
    rep = json.loads(proc.stdout)
    assert Path(rep["sheet"]).exists()


# ─────────────────────────────────────────────────────── new_project ──

def _env(tmp_path: Path, mvhome: Path | None = None) -> dict:
    env = dict(os.environ)
    env["HOME"] = str(tmp_path / "home")
    env["MAKE_VIDEO_HOME"] = str(mvhome or tmp_path / "empty-cache")
    return env


def test_scaffold_without_fonts(tmp_path):
    proj = tmp_path / "tides"
    proc = run_script("new_project.py", str(proj), "--style", "risograph", "--aspect", "9:16", "--fps", "24", "--title", "Tides 101", env=_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert "missing" in proc.stdout  # fonts not installed → told to run setup
    html = (proj / "index.html").read_text()
    assert "{{" not in html
    assert "const W = 1080, H = 1920, FPS = 24;" in html
    assert "applyTheme('risograph'" in html and "Tides 101" in html
    for f in ["mv.js", "mv-draw.js", "mv-audio.js", "mv-themes.js", "fonts.css"]:
        assert (proj / "lib" / f).exists()
    assert (proj / "brief.md").read_text().startswith("# Tides 101")
    assert (proj / ".gitignore").read_text().strip() == "out/"
    # existing, non-empty folder is refused without --force
    again = run_script("new_project.py", str(proj), env=_env(tmp_path))
    assert again.returncode != 0 and "already exists" in again.stderr


@pytest.mark.parametrize("args", [["--style", "watercolor"], ["--size", "1281x720"], ["--aspect", "3:2"]])
def test_scaffold_rejects_bad_input(tmp_path, args):
    proc = run_script("new_project.py", str(tmp_path / "p"), *args, env=_env(tmp_path))
    assert proc.returncode != 0


def test_scaffold_vendors_fonts_and_katex(tmp_path):
    cache = Path(os.environ.get("MAKE_VIDEO_HOME", Path.home() / ".cache" / "make-video"))
    if not (cache / "node_modules" / "@fontsource-variable" / "inter").exists():
        pytest.skip("run skills/make-video/scripts/setup.py first (fonts not installed)")
    proj = tmp_path / "explainer"
    proc = run_script("new_project.py", str(proj), "--template", "explainer", env=_env(tmp_path, cache))
    assert proc.returncode == 0, proc.stderr
    css = (proj / "lib" / "fonts.css").read_text()
    for family in ["Inter", "Fraunces", "Anton", "Cabin Sketch", "Archivo"]:
        assert f"font-family: '{family}'" in css
    assert "cyrillic" not in css and ".woff)" not in css
    woff2 = list((proj / "lib" / "fonts").glob("*.woff2"))
    assert len(woff2) >= 20 and all(f"fonts/{p.name}" in css for p in woff2)
    assert (proj / "lib" / "katex" / "katex.mjs").exists()
    assert (proj / "script.txt").exists()


# ──────────────────────────────────────────────────────────── setup ──

def test_setup_reports_missing_runtime(tmp_path):
    env = _env(tmp_path)
    js = run_script("setup.py", "--json", env=env)
    data = json.loads(js.stdout)
    assert data["status"] in {"needs_install", "needs_system_tools"}
    assert data["can_proceed"] is False and data["first_run"] is True
    chk = run_script("setup.py", "--check", env=env)
    assert chk.returncode == (2 if data["missing_binaries"] else 5)
    assert "setup.py" in chk.stderr


def test_setup_ready_with_marker(tmp_path):
    if not (shutil.which("node") and shutil.which("npm") and shutil.which("ffprobe")):
        pytest.skip("node/npm/ffprobe not installed")
    cache = tmp_path / "cache"
    (cache / "node_modules" / "playwright-core").mkdir(parents=True)
    (cache / "node_modules" / "playwright-core" / "package.json").write_text("{}")
    (cache / ".ready.json").write_text(json.dumps({"chromium": "x"}))
    env = _env(tmp_path, cache)
    chk = run_script("setup.py", "--check", env=env)
    assert chk.returncode == 0 and chk.stdout == "" and chk.stderr == ""
    data = json.loads(run_script("setup.py", "--json", env=env).stdout)
    assert data["status"] == "ready" and data["tts"]["elevenlabs"] is False


def test_env_reads_shared_watch_keys(mv_isolated):
    env_mod = sys.modules["mv_env"]
    watch_cfg = mv_isolated / ".config" / "watch" / ".env"
    watch_cfg.parent.mkdir(parents=True)
    watch_cfg.write_text("GROQ_API_KEY=gsk-123  # comment\nELEVENLABS_API_KEY=not-shared\n")
    assert env_mod.get_value("GROQ_API_KEY") == "gsk-123"
    assert env_mod.get_value("ELEVENLABS_API_KEY") is None  # only Whisper keys are shared
    env_mod.set_value("MAKE_VIDEO_VOICE", "Narrator")
    env_mod.set_value("MAKE_VIDEO_VOICE", "Other")
    text = env_mod.CONFIG_FILE.read_text()
    assert text.count("MAKE_VIDEO_VOICE=") == 1 and env_mod.get_value("MAKE_VIDEO_VOICE") == "Other"
    if os.name != "nt":
        assert (env_mod.CONFIG_FILE.stat().st_mode & 0o777) == 0o600


# ───────────────────────────────────────────────── palette & media ──

def test_palette_roles(tmp_path):
    img = tmp_path / "ref.png"
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", "color=c=0xf4ecd8:s=200x100", "-f", "lavfi", "-i", "color=c=0x1d3557:s=60x100",
          "-f", "lavfi", "-i", "color=c=0xe63946:s=40x100",
          "-filter_complex", "[0][1]overlay=0:0[a];[a][2]overlay=160:0", "-frames:v", "1", str(img)])
    proc = run_script("palette.py", str(img), "--json", "--colors", "3")
    assert proc.returncode == 0, proc.stderr
    pal = json.loads(proc.stdout)
    assert pal["bg"].lower().startswith("#f")  # the cream area dominates
    assert pal["ink_contrast"] >= 4.5
    assert len(pal["colors"]) >= 1


def test_media_clip_makes_seekable_webm(tmp_path):
    src = tmp_path / "src.mp4"
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
          "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)])
    out = tmp_path / "assets" / "clip.webm"
    proc = run_script("media.py", "clip", str(src), str(out), "--fps", "30")
    assert proc.returncode == 0, proc.stderr
    info = json.loads(run_script("media.py", "probe", str(out)).stdout)
    assert info["video_codec"] == "vp9" and info["duration"] == pytest.approx(2.0, abs=0.1)
    assert (tmp_path / "assets" / "clip.audio.wav").exists()
    assert "assets/clip.audio.wav" in proc.stdout
