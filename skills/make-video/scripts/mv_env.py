#!/usr/bin/env python3
"""Shared configuration helpers for the make-video scripts.

- Keys and preferences live in ~/.config/make-video/.env (mode 0600).
- OPENAI_API_KEY / GROQ_API_KEY are also read from /watch's
  ~/.config/watch/.env so users configure Whisper once for both skills.
- Runtime npm dependencies (playwright-core, fonts, KaTeX) live in a cache
  directory outside the skill folder (MAKE_VIDEO_HOME, default
  ~/.cache/make-video), so read-only plugin installs keep working.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "make-video"
CONFIG_FILE = CONFIG_DIR / ".env"
WATCH_CONFIG_FILE = Path.home() / ".config" / "watch" / ".env"
SHARED_WITH_WATCH = {"OPENAI_API_KEY", "GROQ_API_KEY"}


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, _, value = raw.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] in ('"', "'") and value[-1] == value[0]:
            value = value[1:-1]
        else:
            for i, ch in enumerate(value):
                if ch == "#" and i > 0 and value[i - 1] in " \t":
                    value = value[:i].rstrip()
                    break
        values[key.strip()] = value
    return values


def _warn_permissions(path: Path) -> None:
    try:
        if os.name != "nt" and path.stat().st_mode & 0o044:
            sys.stderr.write(f"[make-video] WARNING: {path} is readable by other users. Run: chmod 600 {path}\n")
    except OSError:
        pass


def get_value(name: str, default: str | None = None) -> str | None:
    """Environment first, then ~/.config/make-video/.env, then (for shared keys) /watch's file."""
    env = os.environ.get(name)
    if env and env.strip():
        return env.strip()
    if CONFIG_FILE.exists():
        _warn_permissions(CONFIG_FILE)
        v = read_env_file(CONFIG_FILE).get(name)
        if v:
            return v
    if name in SHARED_WITH_WATCH and WATCH_CONFIG_FILE.exists():
        v = read_env_file(WATCH_CONFIG_FILE).get(name)
        if v:
            return v
    return default


def deps_home() -> Path:
    if os.environ.get("MAKE_VIDEO_HOME"):
        return Path(os.environ["MAKE_VIDEO_HOME"]).expanduser()
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "make-video"
    return Path.home() / ".cache" / "make-video"


def set_value(name: str, value: str, path: Path = CONFIG_FILE) -> None:
    """Idempotently set NAME=value in the config file (creates it 0600)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    out, done = [], False
    for line in lines:
        if line.strip().startswith(f"{name}=") and not done:
            out.append(f"{name}={value}")
            done = True
        else:
            out.append(line)
    if not done:
        out.append(f"{name}={value}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
