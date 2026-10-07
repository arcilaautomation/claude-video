#!/usr/bin/env python3
"""Setup / preflight for /make-video.

Modes:
  setup.py --check         Silent preflight. Exit 0 if ready; 2 = system tools
                           missing (node/npm/ffmpeg); 5 = runtime not installed.
  setup.py --json          Machine-readable status for the agent to branch on.
  setup.py                 Installer: npm runtime deps (playwright-core, fonts,
                           KaTeX) into the cache dir → headless Chromium →
                           verify a real launch → scaffold ~/.config/make-video/.env.
  setup.py --with-whisper  Also create a private venv with faster-whisper for
                           local word timings of narration you record yourself.

Design (mirrors /watch): silent on success, idempotent, never sudo, macOS
auto-installs node/ffmpeg via Homebrew and other platforms get exact
commands. API keys are optional and never written automatically.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from mv_env import CONFIG_FILE, deps_home, get_value, read_env_file  # noqa: E402

SKILL_VERSION = "0.3.0"
PLAYWRIGHT_VERSION = "1.56.1"
FONT_PACKAGES = {
    "@fontsource-variable/inter": "^5.2.0",
    "@fontsource-variable/dm-sans": "^5.2.0",
    "@fontsource-variable/space-grotesk": "^5.2.0",
    "@fontsource-variable/fraunces": "^5.2.0",
    "@fontsource-variable/eb-garamond": "^5.2.0",
    "@fontsource-variable/jetbrains-mono": "^5.2.0",
    "@fontsource-variable/caveat": "^5.2.0",
    "@fontsource-variable/archivo": "^5.2.0",
    "@fontsource/instrument-serif": "^5.2.0",
    "@fontsource/permanent-marker": "^5.2.0",
    "@fontsource/patrick-hand": "^5.2.0",
    "@fontsource/cabin-sketch": "^5.2.0",
    "@fontsource/space-mono": "^5.2.0",
    "@fontsource/anton": "^5.2.0",
}
DEPENDENCIES = {"playwright-core": PLAYWRIGHT_VERSION, "katex": "^0.16.22", **FONT_PACKAGES}
REQUIRED_BINARIES = ["node", "npm", "ffmpeg", "ffprobe"]
MARKER = ".ready.json"

ENV_TEMPLATE = """# /make-video configuration — every key here is optional.
#
# Narration (text-to-speech). The first available backend wins:
#   ElevenLabs — best voices, returns word timings: https://elevenlabs.io/app/settings/api-keys
#   OpenAI TTS (gpt-4o-mini-tts):                   https://platform.openai.com/api-keys
#   Local fallback: macOS `say`, `espeak-ng`, or Piper (set PIPER_MODEL=/path/to/voice.onnx)
ELEVENLABS_API_KEY=
OPENAI_API_KEY=

# Default voice: an ElevenLabs voice ID or name, or an OpenAI voice (alloy, coral, onyx, nova, ...)
# MAKE_VIDEO_VOICE=
# Force a TTS backend: elevenlabs | openai | say | espeak | piper
# MAKE_VIDEO_TTS=

# Word timings for narration you record yourself come from faster-whisper
# (setup.py --with-whisper) or the Whisper API via GROQ_API_KEY / OPENAI_API_KEY
# (also read from /watch's ~/.config/watch/.env).
# GROQ_API_KEY=
"""


def _which(name: str) -> str | None:
    return shutil.which(name)


def _missing_binaries() -> list[str]:
    return [b for b in REQUIRED_BINARIES if not _which(b)]


def _node_version() -> str | None:
    node = _which("node")
    if not node:
        return None
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        return out or None
    except (OSError, subprocess.SubprocessError):
        return None


def _node_ok(version: str | None) -> bool:
    try:
        return bool(version) and int(version.lstrip("v").split(".")[0]) >= 18
    except ValueError:
        return False


def _marker() -> dict | None:
    p = deps_home() / MARKER
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not (deps_home() / "node_modules" / "playwright-core" / "package.json").exists() and not data.get("global_playwright"):
        return None
    return data


def _setup_complete() -> bool:
    return read_env_file(CONFIG_FILE).get("SETUP_COMPLETE") == "true"


def _tts_status() -> dict:
    return {
        "elevenlabs": bool(get_value("ELEVENLABS_API_KEY")),
        "openai": bool(get_value("OPENAI_API_KEY")),
        "say": bool(_which("say")),
        "espeak": bool(_which("espeak-ng") or _which("espeak")),
        "piper": bool(_which("piper") and get_value("PIPER_MODEL")),
    }


def _faster_whisper_python() -> str | None:
    venv = deps_home() / "venv"
    py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if py.exists():
        return str(py)
    try:
        import faster_whisper  # noqa: F401
        return sys.executable
    except ImportError:
        return None


def _status() -> dict:
    missing = _missing_binaries()
    node_v = _node_version()
    if node_v and not _node_ok(node_v):
        missing.append("node>=18")
    marker = _marker()
    whisper_api = "groq" if get_value("GROQ_API_KEY") else "openai" if get_value("OPENAI_API_KEY") else None
    if missing:
        status = "needs_system_tools"
    elif not marker:
        status = "needs_install"
    else:
        status = "ready"
    return {
        "status": status,
        "can_proceed": status == "ready",
        "first_run": not _setup_complete(),
        "missing_binaries": missing,
        "node": node_v,
        "deps_home": str(deps_home()),
        "runtime": marker,
        "fonts": (deps_home() / "node_modules" / "@fontsource-variable" / "inter").exists(),
        "tts": _tts_status(),
        "alignment": {"faster_whisper": bool(_faster_whisper_python()), "whisper_api": whisper_api},
        "config_file": str(CONFIG_FILE),
        "platform": platform.system(),
        "skill_version": SKILL_VERSION,
    }


def cmd_check() -> int:
    s = _status()
    if s["can_proceed"]:
        return 0
    installer = Path(__file__).resolve()
    if s["missing_binaries"]:
        sys.stderr.write(f"[make-video] missing: {', '.join(s['missing_binaries'])}. Run: python3 {installer}\n")
        return 2
    sys.stderr.write(f"[make-video] runtime not installed (playwright-core, fonts, Chromium). Run: python3 {installer}\n")
    return 5


def cmd_json() -> int:
    json.dump(_status(), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _install_system_tools(missing: list[str]) -> bool:
    system = platform.system()
    pkgs = sorted({"node" if b in ("node", "npm", "node>=18") else "ffmpeg" for b in missing})
    if system == "Darwin" and _which("brew"):
        cmd = ["brew", "install", *pkgs]
        print(f"[setup] running: {' '.join(cmd)}", file=sys.stderr)
        if subprocess.run(cmd).returncode != 0:
            print("[setup] brew install failed", file=sys.stderr)
            return False
        return not _missing_binaries()
    print("[setup] please install these first, then re-run setup:", file=sys.stderr)
    if "node" in pkgs:
        print({
            "Darwin": "  node 18+:  brew install node   (or https://nodejs.org)",
            "Windows": "  node 18+:  winget install OpenJS.NodeJS.LTS",
        }.get(system, "  node 18+:  https://nodejs.org/en/download  (or your package manager / nvm)"), file=sys.stderr)
    if "ffmpeg" in pkgs:
        print({
            "Darwin": "  ffmpeg:    brew install ffmpeg",
            "Windows": "  ffmpeg:    winget install Gyan.FFmpeg",
        }.get(system, "  ffmpeg:    sudo apt install ffmpeg   (or: sudo dnf install ffmpeg)"), file=sys.stderr)
    return False


def _npm_install(home: Path) -> bool:
    home.mkdir(parents=True, exist_ok=True)
    pkg = {
        "name": "make-video-runtime",
        "private": True,
        "description": "Runtime dependencies for the make-video agent skill (managed by setup.py; safe to delete).",
        "dependencies": DEPENDENCIES,
    }
    (home / "package.json").write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")
    npm = _which("npm")
    cmd = [npm, "install", "--no-audit", "--no-fund", "--loglevel=error", "--omit=dev"]
    print(f"[setup] installing playwright-core {PLAYWRIGHT_VERSION}, KaTeX and {len(FONT_PACKAGES)} open-source fonts into {home}", file=sys.stderr)
    proc = subprocess.run(cmd, cwd=str(home), shell=(os.name == "nt"))
    if proc.returncode != 0:
        print(f"[setup] npm install failed (exit {proc.returncode}). Check your network/npm registry and re-run.", file=sys.stderr)
        return False
    return True


def _doctor() -> dict:
    node = _which("node")
    proc = subprocess.run([node, str(SCRIPT_DIR / "render.mjs"), "doctor", "--json"], capture_output=True, text=True, timeout=180)
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return {"ok": False, "chromiumError": (proc.stderr or proc.stdout).strip()[-800:]}


def _install_chromium(home: Path) -> bool:
    cli = home / "node_modules" / "playwright-core" / "cli.js"
    if not cli.exists():
        return False
    print("[setup] downloading headless Chromium (~100 MB, one time)", file=sys.stderr)
    proc = subprocess.run([_which("node"), str(cli), "install", "chromium-headless-shell"])
    return proc.returncode == 0


def _scaffold_env() -> bool:
    if CONFIG_FILE.exists():
        return False
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(ENV_TEMPLATE, encoding="utf-8")
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass
    return True


def _mark_setup_complete() -> None:
    text = CONFIG_FILE.read_text(encoding="utf-8") if CONFIG_FILE.exists() else ENV_TEMPLATE
    if any(line.strip() == "SETUP_COMPLETE=true" for line in text.splitlines()):
        return
    if not text.endswith("\n"):
        text += "\n"
    CONFIG_FILE.write_text(text + "SETUP_COMPLETE=true\n", encoding="utf-8")
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass


def _install_whisper(home: Path) -> bool:
    venv = home / "venv"
    py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not py.exists():
        print(f"[setup] creating venv {venv}", file=sys.stderr)
        if subprocess.run([sys.executable, "-m", "venv", str(venv)]).returncode != 0:
            print("[setup] could not create a venv (on Debian/Ubuntu: sudo apt install python3-venv)", file=sys.stderr)
            return False
    print("[setup] installing faster-whisper into the venv (the model downloads on first use)", file=sys.stderr)
    return subprocess.run([str(py), "-m", "pip", "install", "--quiet", "--upgrade", "faster-whisper"]).returncode == 0


def cmd_install(with_whisper: bool = False) -> int:
    missing = _missing_binaries()
    node_v = _node_version()
    if node_v and not _node_ok(node_v):
        missing.append("node>=18")
    if missing and not _install_system_tools(missing):
        return 2
    home = deps_home()
    if not _npm_install(home):
        return 5
    report = _doctor()
    if not report.get("chromium"):
        if _install_chromium(home):
            report = _doctor()
    if not report.get("ok"):
        err = report.get("chromiumError") or report.get("playwrightError") or "unknown error"
        print(f"[setup] Chromium could not start:\n{err}", file=sys.stderr)
        if platform.system() == "Linux" and "shared lib" in err:
            print(f"[setup] missing system libraries — run: sudo node {home / 'node_modules/playwright-core/cli.js'} install-deps chromium", file=sys.stderr)
        return 5
    marker = {
        "skill_version": SKILL_VERSION,
        "playwright": report.get("playwright"),
        "chromium": report.get("chromium"),
        "ffmpeg": report.get("ffmpeg"),
        "checked": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (home / MARKER).write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    created = _scaffold_env()
    print(f"[setup] {'created' if created else 'config exists:'} {CONFIG_FILE}")
    if with_whisper and not _install_whisper(home):
        print("[setup] faster-whisper install failed — narration timing will use the Whisper API or estimates", file=sys.stderr)
    _mark_setup_complete()
    tts = _tts_status()
    print(f"[setup] ready: {report.get('chromium')} · {report.get('ffmpeg')}")
    voices = [k for k, v in tts.items() if v]
    print(f"[setup] narration backends: {', '.join(voices) if voices else 'none (videos can still use music + sound effects; add ELEVENLABS_API_KEY or OPENAI_API_KEY for a voice)'}")
    return 0


def main() -> int:
    args = sys.argv[1:]
    if "--check" in args:
        return cmd_check()
    if "--json" in args:
        return cmd_json()
    return cmd_install(with_whisper="--with-whisper" in args)


if __name__ == "__main__":
    raise SystemExit(main())
