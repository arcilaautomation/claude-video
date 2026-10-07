# Audio: narration, music, sound effects

Three sources, mixed by the renderer into one normalized stereo track:

| source | how | role |
|--------|-----|------|
| procedural | `audio(a)` in the composition (Web Audio, rendered offline) | `music` + `fx` stems |
| files | `tracks: [{ src, … }]` | `voice`, `music` or `fx` |
| narration | `scripts/tts.py` (or a recording) → `assets/narration.mp3` + `.words.json` | a `voice` track |

Mix rules (automatic): music is side-chain **ducked** under any `voice` track; the master is normalized to **−14 LUFS** (pass `--lufs -16` for voice-heavy pieces) with a limiter at about −1.5 dBTP. The QA report states the final loudness and true peak.

## Narration

```bash
python3 "$SKILL_DIR/scripts/tts.py" --text-file "<dir>/script.txt" --out "<dir>/assets/narration.mp3" [--voice NAME] [--speed 1.05] [--srt "<dir>/out/captions.srt"]
python3 "$SKILL_DIR/scripts/tts.py" --list-voices
```

Backend order (override with `--backend` or `MAKE_VIDEO_TTS=` in `~/.config/make-video/.env`):

1. **ElevenLabs** (`ELEVENLABS_API_KEY`) — most natural; word timings come back with the audio. `--voice` takes a library voice name or ID (default: a warm narrator voice); `ELEVENLABS_MODEL` overrides the model. Long scripts are chunked with `previous_text`/`next_text` so the delivery stays continuous.
2. **OpenAI** (`OPENAI_API_KEY`) — `gpt-4o-mini-tts`; steer the read with `--instructions "warm, curious, unhurried; slight smile"`. Voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse.
3. **macOS `say`**, **Piper** (`piper` + `PIPER_MODEL=/path/voice.onnx`), **espeak-ng** — free/offline; espeak sounds robotic (fine for drafts and timing tests).

If the harness exposes an **ElevenLabs connector/MCP**, you can generate the voice with it instead: save the audio into `assets/narration.mp3`, then run `align.py` to get timings.

Backends without native timings are aligned automatically. For narration the user records:

```bash
python3 "$SKILL_DIR/scripts/align.py" "<dir>/assets/voice.wav" --text "<dir>/script.txt" [--srt captions.srt]
```

Alignment backends: **faster-whisper** locally (`setup.py --with-whisper`), the **Whisper API** with word timestamps via `GROQ_API_KEY` or `OPENAI_API_KEY` (also read from `/watch`'s config), or an **estimate** that spreads the script over the detected speech (no model; ±0.3 s — fine for scene changes, not for word-perfect highlights). With `--text`, recognized words are snapped onto your script so cues use your wording.

**Writing for the voice**: short sentences; spell numbers how they should be said ("twenty twenty-six"); avoid symbols ("%", "→"); add paragraph breaks where a pause should go; read it aloud at ~2.5 words/s to check the length.

## Syncing visuals to the voice

```js
const vo = await loadWords('assets/narration.words.json');   // inside an async defineVideo(() => …) or setup()
vo.cue('the moon')        // start time of the phrase
vo.cueEnd('high tide')    // end time of the phrase
vo.captionAt(t)           // caption chunk + per-word state
```

- Start scenes slightly **before** their first word (`vo.cue(...) - 0.3`) so the picture leads the voice.
- Land emphasis animations **on** the stressed word.
- Leave ~0.5 s of picture after the last word, and 1–1.5 s of hold at the very end.
- Put the voice in `tracks` with `at: 0` if the scene timings came from the same file; shifting `at` shifts all cues (`narration(json, { offset })`).

## Procedural music (free, code)

```js
audio(a) {
  a.pad({ chords: ['Fmaj7', 'Am7', 'Dm7', 'C'], every: 4, gain: 0.13 });     // warm bed
  a.arp({ chords: ['Fmaj7', 'Am7', 'Dm7', 'C'], every: 4, rate: 4, gain: 0.05 });
  a.drums({ bpm: 96, kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.', gain: 0.2 });
}
```

- Match chord changes (`every`) to scene lengths or a bar of the tempo (4 beats at 96 bpm = 2.5 s) so the music breathes with the cuts.
- Mood: major-seventh / add9 chords = warm and curious; minor nine = reflective; plain triads with drums at 110–125 bpm = energetic.
- Each theme carries a default in `theme.music` — use it as a starting point.
- For a real track: `tracks: [{ src: 'assets/music.mp3', role: 'music', gain: 0.6, fadeIn: 0.5, fadeOut: 2, loop: true }]`. Only use music the user owns or that is licensed for their use.

## Sound effects on the picture

| event | effect |
|-------|--------|
| scene transition | `whoosh` (0.1 s before the cut), `swish` for small moves |
| element lands / bullet appears | `pop` (vary `pitch` per item), `click`, `blip` |
| text typing | `typing` |
| build-up into a reveal | `riser` ending on the reveal |
| big reveal / payoff | `impact`, `success`, `sparkle` |
| counters / ticks | `tick` per step |

Keep effects 6–12 dB under the voice (gains 0.2–0.4); vary pitch and pan on repeats so they don't sound copy-pasted.

## Checking the mix

`node render.mjs audio <dir>` renders just the soundtrack to `out/audio.wav`. After a video render the QA line reports loudness, true peak and long silences. The `watch` skill's transcript of the final MP4 is a quick check that the narration is intact and in sync.
