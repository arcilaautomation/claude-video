"""Shared pytest fixtures: ffmpeg-synthesized clips and scripts/ on sys.path."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

# Make the bundled scripts importable (mirrors watch.py's sys.path insert).
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "skills" / "watch" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

# 14 visually distinct fills → 14 abrupt cuts → x264 emits a keyframe per cut.
COLORS = [
    "red", "green", "blue", "white", "black", "yellow", "cyan",
    "magenta", "gray", "orange", "purple", "brown", "navy", "olive",
]


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(cmd)}\n{result.stderr}")


def build_cut_clip(
    path: Path,
    n: int = 14,
    seg: float = 0.4,
    size: str = "320x240",
    fps: int = 10,
) -> None:
    """Concatenate ``n`` solid-color segments into one clip with ``n`` cuts.

    Each color change is a hard scene cut, so the scene selector finds ~n-1
    changes. x264's own scenecut detection is unreliable on flat fills, so we
    force a keyframe at every ``seg`` boundary — giving ~n real keyframes for
    the keyframe engine to find.
    """
    inputs: list[str] = []
    for i in range(n):
        color = COLORS[i % len(COLORS)]
        inputs += ["-f", "lavfi", "-t", str(seg), "-i", f"color=c={color}:s={size}:r={fps}"]
    streams = "".join(f"[{i}:v]" for i in range(n))
    filt = f"{streams}concat=n={n}:v=1:a=0[out]"
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        *inputs,
        "-filter_complex", filt, "-map", "[out]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
        str(path),
    ])


def build_static_clip(
    path: Path,
    duration: float = 3.0,
    size: str = "320x240",
    fps: int = 10,
) -> None:
    """One solid color: 1 keyframe, no scene changes → triggers both fallbacks."""
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-t", str(duration), "-i", f"color=c=blue:s={size}:r={fps}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "600",
        str(path),
    ])


@pytest.fixture(scope="session")
def cut_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("clips") / "cuts.mp4"
    build_cut_clip(path)
    return path


@pytest.fixture(scope="session")
def static_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("clips") / "static.mp4"
    build_static_clip(path)
    return path


# ───────────────────────────── make-video ─────────────────────────────

import importlib.util  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402

MV_DIR = Path(__file__).resolve().parent.parent / "skills" / "make-video"
MV_SCRIPTS = MV_DIR / "scripts"


def load_mv(name: str, alias: str | None = None):
    """Import a make-video script by file path under a unique module name."""
    if str(MV_SCRIPTS) not in sys.path:
        sys.path.append(str(MV_SCRIPTS))
    spec = importlib.util.spec_from_file_location(alias or f"mv_{name}", MV_SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def mv_isolated(tmp_path, monkeypatch):
    """Fresh HOME / MAKE_VIDEO_HOME and no API keys or proxies for local mock servers."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("MAKE_VIDEO_HOME", str(tmp_path / "mvhome"))
    for key in ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "MAKE_VIDEO_TTS", "MAKE_VIDEO_VOICE", "PIPER_MODEL"]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    env_mod = load_mv("mv_env", alias="mv_env")
    monkeypatch.setattr(env_mod, "CONFIG_FILE", home / ".config" / "make-video" / ".env")
    monkeypatch.setattr(env_mod, "WATCH_CONFIG_FILE", home / ".config" / "watch" / ".env")
    sys.modules["mv_env"] = env_mod
    return home


def synth_audio(path: Path, pattern: list[tuple[str, float]], rate: int = 44100) -> Path:
    """Concatenate tone ('tone') and silence ('gap') segments into a WAV file."""
    inputs, labels = [], []
    for i, (kind, dur) in enumerate(pattern):
        src = f"sine=frequency=330:sample_rate={rate}:duration={dur}" if kind == "tone" else f"anullsrc=r={rate}:cl=mono:d={dur}"
        inputs += ["-f", "lavfi", "-i", src]
        labels.append(f"[{i}:a]")
    filt = "".join(labels) + f"concat=n={len(pattern)}:v=0:a=1[out]"
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", filt, "-map", "[out]", "-ac", "1", str(path)])
    return path


def renderer_status() -> dict:
    """{'ok': bool, ...} from `render.mjs doctor`, cached for the session."""
    if not hasattr(renderer_status, "cache"):
        node = shutil.which("node")
        if not node:
            renderer_status.cache = {"ok": False, "why": "node not installed"}
        else:
            proc = subprocess.run([node, str(MV_SCRIPTS / "render.mjs"), "doctor", "--json"], capture_output=True, text=True, timeout=180)
            try:
                renderer_status.cache = json.loads(proc.stdout)
            except ValueError:
                renderer_status.cache = {"ok": False, "why": proc.stderr[-300:]}
    return renderer_status.cache


requires_renderer = pytest.mark.skipif(
    not (shutil.which("node") and shutil.which("ffmpeg")), reason="node and ffmpeg are required for render tests"
)
