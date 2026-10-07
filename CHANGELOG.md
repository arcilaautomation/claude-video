# Changelog

All notable changes to `/watch` and `/make-video` are documented here.

## [0.3.0] — Unreleased

### Added
- **`/make-video` skill** — Claude makes videos with code. A guided workflow (intake → story → storyboard → build → render/review loop → deliver) where every frame is a JavaScript function of time, rendered in headless Chromium and encoded with ffmpeg.
  - **Runtime** (`runtime/mv.js`): scenes and layers with transitions (fade, dip, push, cover, wipe with edge, iris, zoom, blur), easing library (Penner, cubic-bezier, springs), keyframes, OKLab color mixing, seeded rng/Perlin noise, split-text/fit-text/type-on/count-up/SVG draw-on helpers, narration cue helpers and word-level captions, seekable WebM video layers, a live preview player with scrubber, and an in-page layout audit.
  - **Renderer** (`scripts/render.mjs`): parallel browser workers each piping frames into an ffmpeg segment encoder, concatenated losslessly; draft/partial/scaled renders; MP4, GIF, and ProRes 4444 MOV with alpha; storyboard sheets, timeline sheets and labeled contact sheets; layout + determinism audit; procedural audio stems mixed with voice/music/fx tracks, music ducked under voice, two-pass loudness normalization to −14 LUFS; live preview server.
  - **Seven styles** (`mv-themes.js`, `mv-draw.js`, `references/styles/`): cut paper, cross-hatch, risograph, sketchbook, isometric, chalkboard, kinetic type — palettes, vendored OFL fonts, textures (paper, slate, graph paper, grain), hand-drawn lines, hatching, cut-paper shapes, riso overprint/halftone, isometric projection, chalk strokes, and an original mascot rig.
  - **Procedural sound** (`mv-audio.js`): pads, arpeggios, bass and drums from chord names; whoosh, pop, click, chime, riser, impact, typing and sparkle effects.
  - **Narration** (`tts.py`, `align.py`): ElevenLabs (with native timings), OpenAI TTS, macOS `say`, Piper or espeak-ng; word timings via faster-whisper, the Whisper API or a speech-detection estimate, snapped onto the script; SRT captions.
  - **Tooling**: `setup.py` (runtime installer and preflight), `new_project.py` (self-contained projects with vendored runtime, fonts and KaTeX), `qa.py` (black/frozen/flash/loudness checks and contact sheets for any video), `media.py` (footage → seekable WebM), `palette.py` (reference image → theme palette).
  - **Templates**: `starter`, `explainer`, `style-reel`.
- `dist/make-video.skill` bundle and release-workflow support.
- Tests for the make-video runtime, narration, tooling and end-to-end rendering.

## [0.2.0] — 2026-06-29

### Added
- **`--detail` dial** with four modes — `transcript` (captions only, no frames), `efficient` (fast keyframe pass, cap 50), `balanced` (scene-aware, cap 100, default), and `token-burner` (scene-aware, uncapped). Set the default with `WATCH_DETAIL` in `~/.config/watch/.env`.
- **Frame deduplication** (default on; `--no-dedup` to disable). Before the budget cap, a pass downscales each frame to a 16×16 grayscale thumbnail and drops frames whose mean per-pixel difference from the last *kept* frame is within threshold — so the budget goes to distinct content instead of held slides and static recordings. The **Frames** report line shows how many near-duplicates were dropped.
- **Whisper auto-chunking.** Audio over the 25 MB upload cap is split into evenly sized chunks, transcribed per chunk, with segment timestamps shifted back into source time. Partial failures are tolerated — transcription only fails if *every* chunk fails, so length alone no longer breaks it.
- **`--timestamps T1,T2,…`** — grab a frame at each absolute timestamp; reserved against the cap, and the only frames produced under `--detail transcript`.
- **`--no-whisper`** — disable transcription entirely (frames only).
- pytest suite covering config, dedup, download, fixtures, frames, setup, timestamps, watch, and whisper (no network; ffmpeg-synthesized clips).

### Changed
- **Restructured into a self-contained `skills/watch/` package** so `SKILL.md` and its `scripts/` runtime are siblings in one folder. This fixes installs on Codex, Cursor, Copilot, and other Agent Skills hosts: `npx skills add` now copies the skill as a working unit instead of grabbing the root `SKILL.md` without its scripts.
- **Harness-agnostic path resolution** — `SKILL.md` resolves `$SKILL_DIR` from where it was Read instead of the Claude-Code-only `${CLAUDE_SKILL_DIR}`, so script calls work on every host.
- `/watch` is now derived from `SKILL.md` frontmatter; the separate `commands/watch.md` wrapper was dropped to avoid a duplicate slash command.
- `balanced` now full-decodes to detect every scene cut across the whole video. The previous early-exit was faster but kept only the first cuts and dropped the tail of long videos.
- `token-burner` is exempt from the long-video "sparse scan" warning, since it keeps every scene-change frame.
- `--max-frames` is now an override on top of each mode's default cap, rather than a fixed default of 80.

### Fixed
- Non-Claude installs (`npx skills add`) were dead on arrival — the installer copied `SKILL.md` without the `scripts/` it shells out to. The self-contained package layout resolves this.

### Removed
- `V2_PLAN.md` and `V2_CONCERNS.md` planning docs.

## [0.1.3] — 2026-05-09

### Fixed
- Windows: `video.info.json` is read as UTF-8 (#4). Previously `Path.read_text()` defaulted to cp1252 on Windows and crashed on yt-dlp's UTF-8 output, silently dropping Title/Uploader from the report. Same fix applied to `.env` reads/writes in `whisper.py` and `setup.py`.
- `download.py` now logs info.json parse failures to stderr instead of swallowing them.

### Security
- Hardened subprocess argv against option injection (#2): inserted `--` before the URL in the yt-dlp argv, and tightened `is_url` to reject `-`-prefixed sources and require a non-empty netloc. Resolved video/audio paths to absolute via `Path.resolve()` before passing to `ffmpeg`/`ffprobe`, so a relative path starting with `-` can't be misinterpreted as a flag.

## [0.1.2] — 2026-04-24

### Fixed
- Windows console crash: removed the emoji from the long-video warning in `watch.py`; cp1252 consoles couldn't encode it.
- `setup.py` now prints `winget` / `pip` install commands on Windows instead of "unsupported platform" — matches what the README already promised.

### Changed
- `SKILL.md` notes that on Windows the scripts must be invoked with `python`, not `python3` (the latter is the Microsoft Store stub on Windows).

## [0.1.1] — 2026-04-24

### Fixed
- Added `commands/watch.md` shim so `/watch` is callable when installed as a Claude Code plugin. Without it, the plugin loaded but the skill wasn't exposed as a slash command.
- `scripts/build-skill.sh` now strips `commands/` from the claude.ai `.skill` bundle alongside `hooks/` and `.claude-plugin/`.

## [0.1.0] — 2026-04-24

Initial marketplace release.

### Added
- `/watch <url-or-path> [question]` slash command.
- yt-dlp download with native caption extraction (manual + auto-subs).
- ffmpeg frame extraction with auto-scaled fps (≤2 fps, ≤100 frames, duration-aware budget).
- `--start` / `--end` focused mode with denser frame budget and transcript range filtering.
- Whisper fallback (Groq preferred, OpenAI secondary) for videos without captions.
- `setup.py` preflight: silent `--check`, structured `--json`, and installer that auto-runs `brew install` on macOS.
- Session-start hook that prints a one-line status on first run / partial config.
- `.skill` bundle packaging for claude.ai upload via `scripts/build-skill.sh`.
