"""Narration helpers: text chunking, alignment, captions, and TTS backends (mocked)."""
from __future__ import annotations

import base64
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import load_mv, synth_audio

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is required")

SCRIPT = "Tides rise twice a day. The moon pulls the ocean, and the earth spins underneath."


# ───────────────────────────────────────────────────────────── align ──

def test_snap_to_script_keeps_script_wording(mv_isolated):
    align = load_mv("align")
    recognized = [
        {"w": "tides", "s": 0.0, "e": 0.3}, {"w": "rise", "s": 0.3, "e": 0.6},
        {"w": "twice", "s": 0.6, "e": 0.9}, {"w": "a", "s": 0.9, "e": 1.0}, {"w": "day", "s": 1.0, "e": 1.3},
        {"w": "the", "s": 1.6, "e": 1.7}, {"w": "mood", "s": 1.7, "e": 2.0},  # misheard
        {"w": "pulls", "s": 2.0, "e": 2.3}, {"w": "ocean", "s": 2.5, "e": 2.9},  # "the" dropped
    ]
    words = align.snap_to_script(recognized, "Tides rise twice a day. The moon pulls the ocean.")
    assert [w["w"] for w in words] == ["Tides", "rise", "twice", "a", "day.", "The", "moon", "pulls", "the", "ocean."]
    assert words[6]["s"] == pytest.approx(1.7)  # "moon" takes "mood"'s timing
    starts = [w["s"] for w in words]
    assert starts == sorted(starts)
    assert all(w["e"] > w["s"] for w in words)
    assert 2.3 <= words[8]["s"] <= 2.5  # the missing "the" is interpolated into the gap


def test_estimate_follows_detected_speech(mv_isolated, tmp_path):
    align = load_mv("align")
    audio = synth_audio(tmp_path / "speech.wav", [("gap", 0.5), ("tone", 1.5), ("gap", 1.0), ("tone", 1.5), ("gap", 0.5)])
    segs = align.speech_segments(audio)
    assert len(segs) == 2
    assert segs[0][0] == pytest.approx(0.5, abs=0.1) and segs[1][0] == pytest.approx(3.0, abs=0.1)
    words = align.estimate_words(audio, "one two three. four five six.")
    assert len(words) == 6
    assert words[0]["s"] == pytest.approx(0.5, abs=0.1)
    assert all(not (2.05 < w["s"] < 2.95) for w in words), "no word should start inside the silence"
    assert words[-1]["e"] <= 4.6


def test_align_auto_falls_back_to_estimate(mv_isolated, tmp_path):
    align = load_mv("align")
    audio = synth_audio(tmp_path / "v.wav", [("tone", 2.0)])
    assert align.available_backends()[-1] == "estimate"
    res = align.align(audio, "hello there world", backend="estimate")
    assert res["source"] == "estimate" and len(res["words"]) == 3
    with pytest.raises(RuntimeError, match="needs --text"):
        align.align(audio, None, backend="estimate")


def test_caption_chunks_and_srt(mv_isolated):
    align = load_mv("align")
    words = [{"w": w, "s": i * 0.3, "e": i * 0.3 + 0.25} for i, w in enumerate("one two three four five six seven eight nine ten.".split())]
    chunks = align.caption_chunks(words, max_words=8)
    assert [len(c["text"].split()) for c in chunks] == [5, 5]  # balanced, not 8 + 2
    srt = align.to_srt(words)
    assert srt.startswith("1\n00:00:00,000 --> ")
    assert "one two three four five" in srt and "\n2\n" in srt


# ─────────────────────────────────────────────────────────────── tts ──

def test_chunk_text_respects_limits_and_paragraphs(mv_isolated):
    tts = load_mv("tts")
    text = "First paragraph here.\n\nSecond one is longer. It has two sentences."
    assert tts.chunk_text(text, 1000) == ["First paragraph here.\n\nSecond one is longer. It has two sentences."]
    chunks = tts.chunk_text(text, 30)
    assert all(len(c) <= 30 for c in chunks)
    assert " ".join(c.replace("\n\n", " ") for c in chunks).split() == text.split()
    long_word_run = "word " * 40
    assert all(len(c) <= 50 for c in tts.chunk_text(long_word_run, 50))


def test_chars_to_words():
    tts = load_mv("tts")
    text = "Hi there."
    alignment = {
        "characters": list(text),
        "character_start_times_seconds": [i * 0.1 for i in range(len(text))],
        "character_end_times_seconds": [i * 0.1 + 0.1 for i in range(len(text))],
    }
    words = tts.chars_to_words(alignment, offset=2.0)
    assert words == [{"w": "Hi", "s": 2.0, "e": 2.2}, {"w": "there.", "s": 2.3, "e": 2.9}]


def test_no_backend_is_a_clear_error(mv_isolated, monkeypatch):
    tts = load_mv("tts")
    monkeypatch.setattr(tts.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="no text-to-speech backend"):
        tts.pick_backend("auto")
    monkeypatch.setenv("MAKE_VIDEO_TTS", "espeak")
    assert tts.pick_backend("auto") == "espeak"


class _Mock(BaseHTTPRequestHandler):
    wav: bytes = b""
    calls: list = []

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        body = json.dumps({"voices": [{"name": "Narrator", "voice_id": "A" * 20, "labels": {}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        type(self).calls.append((self.path, data, {k.lower(): v for k, v in self.headers.items()}))
        if "/text-to-speech/" in self.path:
            text = data["text"]
            n = len(text)
            body = json.dumps({
                "audio_base64": base64.b64encode(self.wav).decode(),
                "alignment": {
                    "characters": list(text),
                    "character_start_times_seconds": [i / n for i in range(n)],
                    "character_end_times_seconds": [(i + 1) / n for i in range(n)],
                },
            }).encode()
            ctype = "application/json"
        else:  # OpenAI /audio/speech returns raw audio
            body, ctype = self.wav, "audio/wav"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def mock_api(tmp_path, monkeypatch):
    wav = synth_audio(tmp_path / "chunk.wav", [("tone", 1.0)])
    _Mock.wav = wav.read_bytes()
    _Mock.calls = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv("ELEVENLABS_BASE_URL", base)
    monkeypatch.setenv("OPENAI_BASE_URL", base)
    yield _Mock
    server.shutdown()


def test_elevenlabs_chunks_concatenate_with_offsets(mv_isolated, mock_api, tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    tts = load_mv("tts")  # reads the base URL at import
    monkeypatch.setitem(tts.CHUNK_CHARS, "elevenlabs", 30)
    out = tmp_path / "assets" / "narration.mp3"
    res = tts.synthesize(SCRIPT, out, backend="elevenlabs", voice="Narrator")
    assert out.exists() and res["source"] == "elevenlabs"
    assert res["duration"] == pytest.approx(len(mock_api.calls), abs=0.15)  # 1 s of audio per chunk
    assert len(mock_api.calls) >= 3
    first_path, first_body, headers = mock_api.calls[0]
    assert first_path.startswith(f"/v1/text-to-speech/{'A' * 20}/with-timestamps")
    assert headers.get("xi-api-key") == "test-key"
    assert "next_text" in first_body and "previous_text" in mock_api.calls[1][1]
    assert [w["w"] for w in res["words"]] == SCRIPT.split()
    starts = [w["s"] for w in res["words"]]
    assert starts == sorted(starts) and starts[-1] > 2.0


def test_openai_without_timings_is_aligned(mv_isolated, mock_api, tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    tts = load_mv("tts")
    out = tmp_path / "narration.wav"
    res = tts.synthesize("Hello there, world.", out, backend="openai", voice="coral", align_backend="estimate")
    assert out.exists() and res["source"] == "openai+estimate"
    assert [w["w"] for w in res["words"]] == ["Hello", "there,", "world."]
    path, body, headers = mock_api.calls[0]
    assert path == "/audio/speech" and body["voice"] == "coral" and headers["authorization"] == "Bearer sk-test"


def test_tts_cli_writes_words_json(mv_isolated, mock_api, tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    tts = load_mv("tts")
    script = tmp_path / "script.txt"
    script.write_text("Short line here.", encoding="utf-8")
    out = tmp_path / "assets" / "voice.mp3"
    rc = tts.main(["--text-file", str(script), "--out", str(out), "--backend", "elevenlabs", "--srt", str(tmp_path / "c.srt")])
    assert rc == 0
    data = json.loads((tmp_path / "assets" / "voice.words.json").read_text())
    assert data["text"] == "Short line here." and len(data["words"]) == 3
    assert (tmp_path / "c.srt").read_text().startswith("1\n")
