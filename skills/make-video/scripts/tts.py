#!/usr/bin/env python3
"""Narration (text-to-speech) with word timings.

    python3 tts.py --text-file script.txt --out assets/narration.mp3
    → assets/narration.mp3 + assets/narration.words.json

Backends (--backend auto picks the first available):
  elevenlabs  ELEVENLABS_API_KEY — best voices; timings come back with the audio
  openai      OPENAI_API_KEY — gpt-4o-mini-tts (steer delivery with --instructions)
  say         macOS built-in voices
  piper       local neural TTS (`piper` on PATH + PIPER_MODEL=/path/voice.onnx)
  espeak      espeak-ng (robotic; last resort)

Backends without native timings are aligned afterwards with align.py
(faster-whisper, the Whisper API, or an estimate from detected speech).

Voices: --voice takes an ElevenLabs voice name or ID, an OpenAI voice
(alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse),
or a `say -v` / espeak voice. --list-voices shows what's available.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from mv_env import get_value  # noqa: E402
import align as aligner  # noqa: E402

ELEVEN_BASE = os.environ.get("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io")
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
ELEVEN_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"  # "George" — a warm narrator from the default voice library
ELEVEN_DEFAULT_MODEL = "eleven_multilingual_v2"
OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]
CHUNK_CHARS = {"elevenlabs": 2400, "openai": 3500, "say": 20000, "espeak": 20000, "piper": 20000}


# ───────────────────────────────────────────────────────────── text ──

def chunk_text(text: str, limit: int) -> list[str]:
    """Split on paragraphs, then sentences, keeping each chunk under `limit` chars."""
    text = re.sub(r"[ \t]+", " ", text.strip())
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    cur = ""
    for para in paragraphs:
        para = " ".join(para.split())
        pieces = [para] if len(para) <= limit else re.split(r"(?<=[.!?;:])\s+", para)
        for piece in pieces:
            while len(piece) > limit:  # pathological sentence: hard-split on a space
                cut = piece.rfind(" ", 0, limit)
                cut = cut if cut > 0 else limit
                if cur:
                    chunks.append(cur)
                    cur = ""
                chunks.append(piece[:cut].strip())
                piece = piece[cut:].strip()
            sep = "\n\n" if cur and piece is pieces[0] else " "
            if cur and len(cur) + len(sep) + len(piece) > limit:
                chunks.append(cur)
                cur = piece
            else:
                cur = f"{cur}{sep}{piece}" if cur else piece
    if cur:
        chunks.append(cur)
    return chunks


def chars_to_words(alignment: dict, offset: float = 0.0) -> list[dict]:
    """ElevenLabs character alignment → word timings."""
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    words: list[dict] = []
    cur, s, e = "", None, None
    for ch, a, b in zip(chars, starts, ends):
        if ch.isspace():
            if cur:
                words.append({"w": cur, "s": round(s + offset, 3), "e": round(e + offset, 3)})
            cur, s, e = "", None, None
            continue
        if not cur:
            s = a
        cur += ch
        e = b
    if cur:
        words.append({"w": cur, "s": round(s + offset, 3), "e": round(e + offset, 3)})
    return [w for w in words if aligner.norm(w["w"])]


# ───────────────────────────────────────────────────────────── http ──

def _request(url: str, *, data: bytes | None = None, headers: dict, method: str = "POST", timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code} from {url.split('?')[0]}: {detail}")
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"cannot reach {url.split('?')[0]}: {e.reason}")
    raise RuntimeError("unreachable")


def to_wav(src: Path, dst: Path, rate: int = 44100) -> Path:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )
    return dst


# ──────────────────────────────────────────────────────────── voices ──

def eleven_voices(key: str) -> list[dict]:
    raw = _request(f"{ELEVEN_BASE}/v1/voices", headers={"xi-api-key": key}, method="GET", timeout=60)
    return json.loads(raw).get("voices", [])


def resolve_eleven_voice(key: str, voice: str | None) -> str:
    if not voice:
        return ELEVEN_DEFAULT_VOICE
    if re.fullmatch(r"[A-Za-z0-9]{20}", voice):
        return voice
    voices = eleven_voices(key)
    want = voice.lower()
    for v in voices:
        if v.get("name", "").lower() == want:
            return v["voice_id"]
    for v in voices:
        if v.get("name", "").lower().startswith(want):
            return v["voice_id"]
    names = ", ".join(sorted(v.get("name", "?") for v in voices)[:30])
    raise RuntimeError(f"no ElevenLabs voice named {voice!r}. Available: {names}")


# ─────────────────────────────────────────────────────────── backends ──

def synth_elevenlabs(chunks: list[str], tmp: Path, voice: str | None, speed: float, model: str | None) -> tuple[list[Path], list[list[dict]] | None]:
    key = get_value("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    voice_id = resolve_eleven_voice(key, voice)
    model = model or get_value("ELEVENLABS_MODEL") or ELEVEN_DEFAULT_MODEL
    files, timings = [], []
    for i, chunk in enumerate(chunks):
        body: dict = {
            "text": chunk,
            "model_id": model,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True, "speed": speed},
        }
        if i > 0:
            body["previous_text"] = chunks[i - 1][-600:]
        if i + 1 < len(chunks):
            body["next_text"] = chunks[i + 1][:600]
        raw = _request(
            f"{ELEVEN_BASE}/v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128",
            data=json.dumps(body).encode("utf-8"),
            headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "application/json"},
        )
        data = json.loads(raw)
        audio = tmp / f"chunk{i:03d}.mp3"
        audio.write_bytes(base64.b64decode(data["audio_base64"]))
        files.append(audio)
        timings.append(chars_to_words(data.get("alignment") or data.get("normalized_alignment") or {}))
    return files, timings


def synth_openai(chunks: list[str], tmp: Path, voice: str | None, speed: float, model: str | None, instructions: str | None) -> tuple[list[Path], None]:
    key = get_value("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    voice = voice or "coral"
    if voice not in OPENAI_VOICES:
        raise RuntimeError(f"OpenAI voice must be one of {', '.join(OPENAI_VOICES)}")
    files = []
    for i, chunk in enumerate(chunks):
        body = {"model": model or "gpt-4o-mini-tts", "voice": voice, "input": chunk, "response_format": "wav", "speed": speed}
        if instructions:
            body["instructions"] = instructions
        raw = _request(
            f"{OPENAI_BASE}/audio/speech",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        f = tmp / f"chunk{i:03d}.wav"
        f.write_bytes(raw)
        files.append(f)
    return files, None


def synth_local(backend: str, chunks: list[str], tmp: Path, voice: str | None, speed: float) -> tuple[list[Path], None]:
    files = []
    for i, chunk in enumerate(chunks):
        txt = tmp / f"chunk{i:03d}.txt"
        txt.write_text(chunk, encoding="utf-8")
        if backend == "say":
            out = tmp / f"chunk{i:03d}.aiff"
            cmd = ["say", "-o", str(out), "-f", str(txt), "-r", str(int(185 * speed))]
            if voice:
                cmd[1:1] = ["-v", voice]
        elif backend == "espeak":
            out = tmp / f"chunk{i:03d}.wav"
            exe = shutil.which("espeak-ng") or shutil.which("espeak")
            cmd = [exe, "-w", str(out), "-s", str(int(160 * speed)), "-f", str(txt)]
            if voice:
                cmd[1:1] = ["-v", voice]
        elif backend == "piper":
            model = get_value("PIPER_MODEL")
            if not model:
                raise RuntimeError("set PIPER_MODEL=/path/to/voice.onnx to use piper")
            out = tmp / f"chunk{i:03d}.wav"
            cmd = [shutil.which("piper"), "--model", model, "--output_file", str(out), "--length_scale", f"{1 / speed:.3f}"]
            with txt.open("rb") as fh:
                proc = subprocess.run(cmd, stdin=fh, capture_output=True)
            if proc.returncode != 0:
                raise RuntimeError(f"piper failed: {proc.stderr.decode(errors='replace')[-300:]}")
            files.append(out)
            continue
        else:
            raise RuntimeError(f"unknown backend {backend}")
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"{backend} failed: {proc.stderr.decode(errors='replace')[-300:]}")
        files.append(out)
    return files, None


def available_backends() -> list[str]:
    out = []
    if get_value("ELEVENLABS_API_KEY"):
        out.append("elevenlabs")
    if get_value("OPENAI_API_KEY"):
        out.append("openai")
    if shutil.which("say"):
        out.append("say")
    if shutil.which("piper") and get_value("PIPER_MODEL"):
        out.append("piper")
    if shutil.which("espeak-ng") or shutil.which("espeak"):
        out.append("espeak")
    return out


def pick_backend(requested: str) -> str:
    if requested != "auto":
        return requested
    forced = get_value("MAKE_VIDEO_TTS")
    if forced:
        return forced
    avail = available_backends()
    if not avail:
        raise RuntimeError(
            "no text-to-speech backend available. Add ELEVENLABS_API_KEY or OPENAI_API_KEY to "
            "~/.config/make-video/.env, or install espeak-ng / Piper (macOS has `say`). "
            "You can also record narration yourself and run align.py on it."
        )
    return avail[0]


# ───────────────────────────────────────────────────────────── main ──

def synthesize(text: str, out: Path, *, backend: str = "auto", voice: str | None = None, speed: float = 1.0,
               model: str | None = None, instructions: str | None = None, align_backend: str = "auto") -> dict:
    backend = pick_backend(backend)
    voice = voice or get_value("MAKE_VIDEO_VOICE")
    chunks = chunk_text(text, CHUNK_CHARS.get(backend, 3000))
    if not chunks:
        raise RuntimeError("the script is empty")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mv-tts-") as tmpdir:
        tmp = Path(tmpdir)
        if backend == "elevenlabs":
            files, timings = synth_elevenlabs(chunks, tmp, voice, speed, model)
        elif backend == "openai":
            files, timings = synth_openai(chunks, tmp, voice, speed, model, instructions)
        else:
            files, timings = synth_local(backend, chunks, tmp, voice, speed)
        wavs = [to_wav(f, tmp / f"norm{i:03d}.wav") for i, f in enumerate(files)]
        offsets, acc = [], 0.0
        for w in wavs:
            offsets.append(acc)
            acc += aligner.duration_of(w)
        joined = tmp / "joined.wav"
        listing = tmp / "list.txt"
        listing.write_text("".join(f"file '{w.as_posix()}'\n" for w in wavs), encoding="utf-8")
        subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)], check=True)
        if out.suffix.lower() == ".wav":
            shutil.copy2(joined, out)
        else:
            subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(joined), "-c:a", "libmp3lame", "-b:a", "192k", str(out)], check=True)
        if timings is not None:
            words = []
            for off, ws in zip(offsets, timings):
                words += [{"w": w["w"], "s": round(w["s"] + off, 3), "e": round(w["e"] + off, 3)} for w in ws]
            source = backend
        else:
            res = aligner.align(out, text, align_backend)
            words, source = res["words"], f"{backend}+{res['source']}"
    result = {"duration": round(aligner.duration_of(out), 3), "source": source, "voice": voice or "", "text": text.strip(), "words": words}
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--text", help="narration text")
    src.add_argument("--text-file", type=Path, help="file with the narration script")
    ap.add_argument("--out", type=Path, default=Path("assets/narration.mp3"))
    ap.add_argument("--words-out", type=Path, help="default: <out>.words.json")
    ap.add_argument("--backend", default="auto", choices=["auto", "elevenlabs", "openai", "say", "piper", "espeak"])
    ap.add_argument("--voice")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--model", help="ElevenLabs model_id or OpenAI TTS model")
    ap.add_argument("--instructions", help="OpenAI gpt-4o-mini-tts delivery notes, e.g. 'warm, curious, unhurried'")
    ap.add_argument("--align", default="auto", dest="align_backend", help="alignment backend when TTS has no timings")
    ap.add_argument("--srt", type=Path, help="also write SRT captions")
    ap.add_argument("--list-voices", action="store_true")
    args = ap.parse_args(argv)

    if args.list_voices:
        print("available backends:", ", ".join(available_backends()) or "none")
        key = get_value("ELEVENLABS_API_KEY")
        if key:
            try:
                for v in eleven_voices(key):
                    labels = ", ".join(f"{k}={val}" for k, val in (v.get("labels") or {}).items())
                    print(f"  elevenlabs  {v.get('name', '?'):<22} {v.get('voice_id')}  {labels}")
            except RuntimeError as e:
                print(f"  elevenlabs: {e}")
        if get_value("OPENAI_API_KEY"):
            print("  openai      " + ", ".join(OPENAI_VOICES))
        if shutil.which("say"):
            print("  say         run `say -v '?'` for the list")
        return 0
    text = args.text if args.text is not None else (args.text_file.read_text(encoding="utf-8") if args.text_file else None)
    if not text or not text.strip():
        print("give the narration with --text or --text-file", file=sys.stderr)
        return 2
    try:
        result = synthesize(text, args.out, backend=args.backend, voice=args.voice, speed=args.speed, model=args.model,
                            instructions=args.instructions, align_backend=args.align_backend)
    except (RuntimeError, subprocess.CalledProcessError) as e:
        print(f"[tts] {e}", file=sys.stderr)
        return 1
    words_out = args.words_out or args.out.with_name(args.out.stem + ".words.json")
    words_out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"[tts] {args.out} ({result['duration']:.2f}s, {len(result['words'])} words, timings via {result['source']})")
    print(f"      timings: {words_out}")
    print(f"      in index.html: const vo = await loadWords('{words_out.as_posix()}'); tracks: [{{ src: '{args.out.as_posix()}', role: 'voice' }}]")
    if args.srt:
        args.srt.write_text(aligner.to_srt(result["words"]), encoding="utf-8")
        print(f"      captions: {args.srt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
