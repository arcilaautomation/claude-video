#!/usr/bin/env python3
"""Word-level timings for narration, so visuals can land on the words.

    python3 align.py assets/narration.mp3 --text script.txt
    → assets/narration.words.json
      {"duration": 12.4, "source": "groq", "words": [{"w": "Tides", "s": 0.12, "e": 0.48}, ...]}

In the composition:  const vo = await loadWords('assets/narration.words.json');
                     vo.cue('the moon')  → seconds when "the moon" is spoken

Backends (--backend auto tries them in order):
  faster-whisper  local model (install once: setup.py --with-whisper)
  groq | openai   Whisper API word timestamps (GROQ_API_KEY / OPENAI_API_KEY,
                  read from ~/.config/make-video/.env or /watch's config)
  estimate        no model: spreads the script's words over the detected
                  speech (requires --text; good enough for rough cues)

With --text the recognized words are snapped onto your script, so cues use
your exact wording and spelling. --srt also writes subtitles.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from mv_env import deps_home, get_value  # noqa: E402

API = {
    "groq": (os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1"), "whisper-large-v3", "GROQ_API_KEY"),
    "openai": (os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"), "whisper-1", "OPENAI_API_KEY"),
}


# ───────────────────────────────────────────────────────────── audio ──

def duration_of(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        raise RuntimeError(f"cannot read duration of {path}")


def speech_segments(path: Path, noise_db: float = -35.0, min_silence: float = 0.18) -> list[tuple[float, float]]:
    """Non-silent intervals of the audio (via ffmpeg silencedetect)."""
    total = duration_of(path)
    log = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-vn", "-af",
         f"silencedetect=n={noise_db}dB:d={min_silence}", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    starts = [max(0.0, float(x)) for x in re.findall(r"silence_start:\s*(-?[\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([\d.]+)", log)]
    silences = []
    for i, s in enumerate(starts):
        silences.append((s, ends[i] if i < len(ends) else total))
    segs = []
    cursor = 0.0
    for s, e in silences:
        if s - cursor > 0.02:
            segs.append((cursor, s))
        cursor = max(cursor, e)
    if total - cursor > 0.02:
        segs.append((cursor, total))
    return segs or [(0.0, total)]


# ───────────────────────────────────────────────────────────── words ──

TOKEN_RE = re.compile(r"\S+")


def norm(w: str) -> str:
    w = w.lower().replace("’", "'").replace("‘", "'")
    return re.sub(r"[^\w']+", "", w, flags=re.UNICODE).strip("'")


def script_tokens(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall(text) if norm(t)]


def estimate_words(path: Path, text: str) -> list[dict]:
    """Spread script words over detected speech, weighted by length."""
    tokens = script_tokens(text)
    if not tokens:
        return []
    segs = speech_segments(path)
    speech = sum(e - s for s, e in segs)
    weights = [len(norm(t)) + 2.0 for t in tokens]
    total_w = sum(weights)

    def to_real(x: float) -> float:
        for s, e in segs:
            if x <= e - s:
                return s + x
            x -= e - s
        return segs[-1][1]

    out, acc = [], 0.0
    for tok, wgt in zip(tokens, weights):
        a = acc / total_w * speech
        acc += wgt
        b = acc / total_w * speech
        s, e = to_real(a), to_real(b - 1e-4)
        out.append({"w": tok, "s": round(s, 3), "e": round(max(e, s + 0.04), 3)})
    return out


def snap_to_script(recognized: list[dict], text: str) -> list[dict]:
    """Map recognized word timings onto the script's tokens (exact wording)."""
    tokens = script_tokens(text)
    if not recognized or not tokens:
        return recognized
    a = [norm(w["w"]) for w in recognized]
    b = [norm(t) for t in tokens]
    times: list[tuple[float, float] | None] = [None] * len(tokens)
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(j2 - j1):
                r = recognized[i1 + k]
                times[j1 + k] = (r["s"], r["e"])
        elif op == "replace":
            s, e = recognized[i1]["s"], recognized[i2 - 1]["e"]
            n = j2 - j1
            for k in range(n):
                times[j1 + k] = (s + (e - s) * k / n, s + (e - s) * (k + 1) / n)
    # Fill script words the recognizer missed by interpolating between neighbours.
    i = 0
    while i < len(times):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(times) and times[j] is None:
            j += 1
        left = times[i - 1][1] if i > 0 else (times[j][0] if j < len(times) else 0.0)
        right = times[j][0] if j < len(times) else left + 0.3 * (j - i)
        right = max(right, left + 0.05 * (j - i))
        n = j - i
        for k in range(n):
            times[i + k] = (left + (right - left) * k / n, left + (right - left) * (k + 1) / n)
        i = j
    out, last = [], 0.0
    for tok, (s, e) in zip(tokens, times):
        s = max(s, last)
        e = max(e, s + 0.03)
        out.append({"w": tok, "s": round(s, 3), "e": round(e, 3)})
        last = s
    return out


# ──────────────────────────────────────────────────────────── backends ──

def _multipart(fields: dict[str, str | list[str]], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----mv{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for k, v in fields.items():
        for item in v if isinstance(v, list) else [v]:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{item}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode()
    )
    parts.append(file_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def api_words(path: Path, backend: str, language: str | None = None) -> list[dict]:
    base, model, key_name = API[backend]
    key = get_value(key_name)
    if not key:
        raise RuntimeError(f"{key_name} is not set")
    with tempfile.TemporaryDirectory(prefix="mv-align-") as tmp:
        small = Path(tmp) / "speech.mp3"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", str(small)],
            check=True,
        )
        fields: dict[str, str | list[str]] = {
            "model": model,
            "response_format": "verbose_json",
            "timestamp_granularities[]": ["word", "segment"],
        }
        if language:
            fields["language"] = language
        body, boundary = _multipart(fields, "file", small)
        req = urllib.request.Request(
            f"{base}/audio/transcriptions", data=body, method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        data = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:300]
                if e.code in (429, 500, 502, 503) and attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise RuntimeError(f"{backend} transcription failed: HTTP {e.code} {detail}")
    words = data.get("words") or [w for s in data.get("segments", []) for w in s.get("words", [])]
    if not words:
        raise RuntimeError(f"{backend} returned no word timestamps")
    return [{"w": str(w.get("word", "")).strip(), "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)} for w in words if str(w.get("word", "")).strip()]


FW_SCRIPT = r"""
import json, sys
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[2], device="auto", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], word_timestamps=True, language=(sys.argv[3] or None))
words = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)} for s in segments for w in (s.words or []) if w.word.strip()]
print(json.dumps({"words": words, "language": info.language}))
"""


def faster_whisper_python() -> str | None:
    venv = deps_home() / "venv"
    py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if py.exists():
        return str(py)
    try:
        import faster_whisper  # noqa: F401
        return sys.executable
    except ImportError:
        return None


def local_words(path: Path, model: str = "small", language: str | None = None) -> list[dict]:
    py = faster_whisper_python()
    if not py:
        raise RuntimeError("faster-whisper is not installed (run setup.py --with-whisper)")
    proc = subprocess.run([py, "-c", FW_SCRIPT, str(path), model, language or ""], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"faster-whisper failed: {proc.stderr.strip()[-400:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])["words"]


def available_backends() -> list[str]:
    out = []
    if faster_whisper_python():
        out.append("faster-whisper")
    if get_value("GROQ_API_KEY"):
        out.append("groq")
    if get_value("OPENAI_API_KEY"):
        out.append("openai")
    out.append("estimate")
    return out


def align(path: Path, text: str | None = None, backend: str = "auto", model: str = "small", language: str | None = None) -> dict:
    order = available_backends() if backend == "auto" else [backend]
    errors = []
    for b in order:
        try:
            if b == "estimate":
                if not text:
                    raise RuntimeError("the estimate backend needs --text (the script)")
                words = estimate_words(path, text)
            elif b == "faster-whisper":
                words = local_words(path, model, language)
            else:
                words = api_words(path, b, language)
            if text and b != "estimate":
                words = snap_to_script(words, text)
            return {"duration": round(duration_of(path), 3), "source": b, "words": words}
        except Exception as e:  # noqa: BLE001 — fall through to the next backend
            errors.append(f"{b}: {e}")
            if backend != "auto":
                break
    raise RuntimeError("no alignment backend worked:\n  " + "\n  ".join(errors))


# ─────────────────────────────────────────────────────────── captions ──

def caption_chunks(words: list[dict], max_chars: int = 42, max_words: int = 8, pause: float = 0.5) -> list[dict]:
    """Group words into caption lines: break at sentence ends and pauses, then
    split long phrases into evenly sized pieces (5+5, not 8+2)."""
    phrases, cur = [], []
    for w in words:
        if cur and w["s"] - cur[-1]["e"] > pause:
            phrases.append(cur)
            cur = []
        cur.append(w)
        if re.search(r"[.!?;:]$", w["w"]) or (w["w"].endswith(",") and len(cur) >= max(3, max_words // 2)):
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    chunks = []
    for ph in phrases:
        chars = sum(len(x["w"]) + 1 for x in ph) - 1
        n = max(1, -(-len(ph) // max_words), -(-chars // max_chars))
        size = -(-len(ph) // n)
        chunks += [ph[i:i + size] for i in range(0, len(ph), size)]
    return [{"start": c[0]["s"], "end": c[-1]["e"], "text": " ".join(x["w"] for x in c)} for c in chunks]


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(words: list[dict], offset: float = 0.0) -> str:
    out = []
    chunks = caption_chunks(words)
    for i, c in enumerate(chunks, 1):
        end = c["end"] + 0.25
        if i < len(chunks):
            end = min(end, chunks[i]["start"])
        out.append(f"{i}\n{srt_time(c['start'] + offset)} --> {srt_time(end + offset)}\n{c['text']}\n")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", type=Path)
    ap.add_argument("--text", type=Path, help="script file — snaps timings onto your exact words")
    ap.add_argument("--out", type=Path, help="default: <audio>.words.json next to the audio")
    ap.add_argument("--backend", default="auto", choices=["auto", "faster-whisper", "groq", "openai", "estimate"])
    ap.add_argument("--model", default="small", help="faster-whisper model size (tiny/base/small/medium)")
    ap.add_argument("--language", help="ISO code, e.g. en")
    ap.add_argument("--srt", type=Path, help="also write SRT captions here")
    args = ap.parse_args(argv)
    if not args.audio.exists():
        print(f"no such file: {args.audio}", file=sys.stderr)
        return 2
    text = args.text.read_text(encoding="utf-8") if args.text else None
    try:
        result = align(args.audio.resolve(), text, args.backend, args.model, args.language)
    except RuntimeError as e:
        print(f"[align] {e}", file=sys.stderr)
        return 1
    out = args.out or args.audio.with_name(args.audio.stem + ".words.json")
    if text:
        result["text"] = text.strip()
    out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    words = result["words"]
    print(f"[align] {len(words)} words over {result['duration']:.2f}s via {result['source']} → {out}")
    if words:
        print("  first cues: " + ", ".join(f"{w['w']}@{w['s']:.2f}" for w in words[:6]))
    if args.srt:
        args.srt.write_text(to_srt(words), encoding="utf-8")
        print(f"  captions: {args.srt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
