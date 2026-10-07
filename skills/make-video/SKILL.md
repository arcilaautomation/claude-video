---
name: make-video
version: "0.3.0"
description: Create videos with code — animated explainers, motion graphics, product demos, kinetic typography and social shorts. Scripts and storyboards the video with the user, writes every frame as a JavaScript function of time, renders it in headless Chromium (Playwright) and stitches it with ffmpeg into an MP4 with narration, music and sound effects, then reviews its own frames before delivering. Seven built-in styles (cut paper, cross-hatch, risograph, sketchbook, isometric, chalkboard, kinetic type) or a custom look from reference images or videos. No AI video generator needed.
argument-hint: "<what the video is about> [style] [length] [aspect ratio]"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
homepage: https://github.com/bradautomates/claude-video
repository: https://github.com/bradautomates/claude-video
author: bradautomates
license: MIT
user-invocable: true
---

# /make-video

You can't film anything, but you can write code — and a video is just a function of time. Give a function a time `t` and it returns one picture; ask for 30 pictures per second and play them in order, and that's a video. This skill turns that idea into a production pipeline:

- **Composition** — an HTML page (DOM, SVG, canvas) whose `render(t)` draws the frame for any time `t`, built on the bundled runtime (`lib/mv.js`: scenes, transitions, easing, seeded noise, text and drawing helpers).
- **Renderer** — `scripts/render.mjs` seeks headless Chromium to every frame, screenshots it, and pipes the frames into ffmpeg, in parallel workers. Sound is code too (`audio(a)`), mixed with narration/music files, ducked and loudness-normalized.
- **Eyes** — you can't watch the result, but you can look at it: every render produces a labeled **contact sheet** plus an automated QA report, and `storyboard` / `stills` render any moment as an image you `Read`.

Same `t`, same picture — so any frame can be redrawn or checked on its own, and you iterate on stills (cheap) before rendering video (expensive).

## Resolve `SKILL_DIR` (do this before any command)

Set `SKILL_DIR` to the **absolute path of the directory containing this SKILL.md** (your harness showed it when you Read this file). The scripts are always siblings: `SKILL_DIR/scripts/…`. Do not use harness-specific variables.

```bash
SKILL_DIR="<absolute path of the directory containing this SKILL.md>"
test -f "$SKILL_DIR/scripts/render.mjs" || { echo "render.mjs not found under $SKILL_DIR" >&2; exit 1; }
```

On **Windows** use `python` instead of `python3`.

## Step 0 — Preflight (every invocation; silent on success)

```bash
python3 "$SKILL_DIR/scripts/setup.py" --check
```

| Exit | Meaning | Action |
|------|---------|--------|
| `0` | Ready | Continue without comment. |
| `2` | `node` (18+), `npm` or `ffmpeg` missing | Run the installer — it uses Homebrew on macOS and prints the exact commands elsewhere. |
| `5` | Runtime not installed yet | Tell the user it will download ~100 MB once (Chromium + fonts), then run the installer. |

```bash
python3 "$SKILL_DIR/scripts/setup.py"                 # idempotent
python3 "$SKILL_DIR/scripts/setup.py" --json          # status: tts backends, alignment, runtime
```

The installer puts `playwright-core`, 14 open-source fonts and KaTeX into `~/.cache/make-video` (override with `MAKE_VIDEO_HOME`), downloads headless Chromium, verifies a real launch, and scaffolds `~/.config/make-video/.env` for optional narration keys. Keys are optional: videos with music and sound effects need none.

## The workflow

Tell the user the plan in one line — **intake → story → storyboard → build → review loop → deliver** — then run it. The two approval points (story, storyboard) are what keep you out of hour-long render/redo loops: changes are cheap on paper and stills, expensive on finished video.

### 1. Intake

Collect only what the request doesn't already say. Use `AskUserQuestion` when available (max 4 questions per call, 2–4 options each; users can always pick "Other"), otherwise ask in chat. One round, two at most.

- **Format** — `16:9` landscape (YouTube, slides) · `9:16` vertical (Shorts/Reels/TikTok) · `1:1` square (feeds) · `4:5`.
- **Length** — ~15 s · ~30 s · ~60 s · 90 s+. Longer means more scenes, not slower ones.
- **Style** — offer the three presets that best fit the subject (best first, marked recommended) plus **Custom from a reference**; say the others exist (see Styles below).
- **Audio** — narration + music (best for explainers) · music + sound effects only · silent · "I'll provide audio".

Second round only if relevant: voice backend (see `setup.py --json` → `tts`), burned-in captions (default yes for 9:16), a recurring hero character, reference images/videos, must-include facts, logo or call to action.

### 2. Story and script

Scaffold the project and write the plan into its `brief.md`:

```bash
python3 "$SKILL_DIR/scripts/new_project.py" "<dir>" --style <style> --aspect 16:9 --fps 30 --title "<title>"
#   --template explainer   narrated multi-scene explainer to adapt (vendors KaTeX)
#   --template style-reel  one vignette per style — technique reference
#   --math                 vendor KaTeX for typeset equations
```

- **One sentence** the viewer should walk away with, then **beats**: hook in the first 1–2 s, one idea per scene, a payoff or call to action at the end.
- **Narration** at ~2.5 words/second (30 s ≈ 70 words); on-screen text short (≤ 7 words per line, ≥ 1.5 s on screen per line).
- Show the user the beats and script (compact, in chat) and get a yes or edits before building anything visual.

Read `references/craft.md` once per session for pacing, hierarchy and motion principles.

### 3. Storyboard (approve the look on stills)

1. **Narrated?** Make the voice first so the visuals can follow it:
   ```bash
   python3 "$SKILL_DIR/scripts/tts.py" --text-file "<dir>/script.txt" --out "<dir>/assets/narration.mp3"
   ```
   It writes `narration.words.json` (word timings). User-supplied recording → `align.py <audio> --text script.txt`. Details: `references/audio.md`.
2. **Read** `references/composition-api.md` and `references/styles/<style>.md` before writing code.
3. Build every scene in its **settled state** first — layout, type, palette, key visuals — with a `label` and `note` per scene. Motion comes after approval.
4. Render and look:
   ```bash
   node "$SKILL_DIR/scripts/render.mjs" storyboard "<dir>"
   ```
   `Read` `out/storyboard/storyboard.png`, fix what's wrong, then give the user the path (macOS: `open "<dir>/out/storyboard/index.html"`) and ask for approval or changes. Iterate here.

### 4. Build the motion

Add entrances, exits, transitions, secondary motion and sound on the hits. Sync to narration with `vo.cue('phrase')`. The contract that makes rendering work:

- `render(t)` must depend only on `t`: **set every animated property on every frame** (no `if (t > 2) el.style…` without an else), no `Math.random()`/`Date` — use `rng(seed)`, `noise()`, `hash()`.
- Create elements once in `build()`; precompute heavy things there (paths, layouts, simulations sampled per frame).
- Async work in `render` (video seeks) must be returned/awaited.

Quick looks while building: `render.mjs sheet "<dir>"` (timeline sheet, seconds) and `render.mjs stills "<dir>" --at 2.4,7` (full-res frames). Live preview for the user (local only): `render.mjs serve "<dir>"`.

### 5. Render and review — never skip

```bash
node "$SKILL_DIR/scripts/render.mjs" audit "<dir>"            # clipped/overlapping/tiny text, missing fonts/images, determinism
node "$SKILL_DIR/scripts/render.mjs" video "<dir>" --draft    # half-res, fast
```

`Read` the contact sheet the render prints (`out/<name>.draft.sheet.jpg`) and walk `references/review-checklist.md`. For anything suspicious, render that moment at full size (`stills --at …`) and `Read` it. Fix, re-render, repeat — usually 2–4 loops. Fix every audit **ERROR** and every QA warning you can't justify. Then the final:

```bash
node "$SKILL_DIR/scripts/render.mjs" video "<dir>"            # full quality + sheet + QA report
```

If the sibling `watch` skill is installed, `python3 "$SKILL_DIR/../watch/scripts/watch.py" "<dir>/out/<name>.mp4"` is a good last look: it samples frames by scene change and transcribes the narration as a viewer would hear it.

### 6. Deliver

Give the path, duration, resolution, file size and a two-line summary of what's in it. Offer the cheap variants: another aspect ratio, a GIF preview (`--format gif`), a transparent overlay (`--alpha` → ProRes 4444 MOV), SRT captions (`tts.py … --srt` / `align.py … --srt`). Keep the project folder — edits are a re-render away.

## Styles

| Style | Look | Good for |
|-------|------|----------|
| `cut-paper` | layered construction paper, soft shadows, kraft texture, stop-motion step | friendly explainers, kids/education, stories |
| `cross-hatch` | ink engraving on ivory, hatched shading, boiling lines, serif type | history, science, editorial, "old book" tone |
| `risograph` | fluorescent spot inks overprinted, grain, misregistration, zine type | culture, music, design, punchy social |
| `sketchbook` | ballpoint + marker on graph paper, drawn-on doodles, handwriting | tutorials, brainstorms, product ideas |
| `isometric` | pastel 30° blocks, clean shading, grids | systems, architecture, SaaS, data flows |
| `chalkboard` | dark board, chalk strokes, written equations (or clean vector on dark) | math, physics, teaching, technical concepts |
| `kinetic-type` | huge condensed type cut to the beat, one hot accent | promos, launches, quotes, hooks |

Each has a guide in `references/styles/<name>.md` (palette, fonts, textures, motion language, recipes). **Custom styles** start from the closest preset:

- **Reference image** — `Read` it, then `python3 "$SKILL_DIR/scripts/palette.py" <image>` for exact colors; restyle the theme (`applyTheme({...themes['x'], palette})`) and match its shapes, line quality and type.
- **Reference video** — analyze it with the sibling watch skill (`watch.py <url-or-path> --detail balanced`): note the shot structure, pacing (cuts per second), typography, transitions and color, then recreate that structure with the user's content.
- **Originality** — recreate a reference's *feel* (composition, rhythm, palette, technique), never its assets: no copyrighted characters, logos, footage or artwork unless the user owns them and supplies them. Need a mascot? Design an original one (`buddy()` in mv-draw.js is a starting rig).

## Audio in one paragraph

`audio(a)` schedules procedural sound at absolute times — a music bed (`a.pad`, `a.arp`, `a.bass`, `a.drums`) and effects (`a.whoosh`, `a.swish`, `a.pop`, `a.click`, `a.chime`, `a.riser`, `a.impact`, `a.typing`, `a.sparkle`) — synced with `a.scene('name').start` or narration cues. Files go in `tracks: [{ src, at, gain, role: 'voice'|'music'|'fx', fadeIn, fadeOut, loop }]`; the renderer ducks music under voice and normalizes to −14 LUFS. If the harness has an ElevenLabs connector/MCP, you may use it to make the voice — save the file into `assets/` and run `align.py` on it. See `references/audio.md`.

## Command reference

```bash
R="$SKILL_DIR/scripts/render.mjs"
node "$R" storyboard <dir>                 # beats → numbered storyboard sheet + index.html
node "$R" sheet <dir> [--count 24]         # quick timeline contact sheet (no encode)
node "$R" stills <dir> --at 1.5,4 [--debug] # full-res PNGs (debug = safe-area guides + timecode)
node "$R" audit <dir> [--every 0.25]       # layout + determinism audit → out/audit.json
node "$R" video <dir> [--draft] [--from 10 --to 18] [--scale 2] [--fps 60] [--format gif|mov] [--alpha] [--frames png]
node "$R" audio <dir>                      # just the mixed soundtrack (WAV)
node "$R" info <dir>                       # timeline JSON (scenes, beats, tracks)
node "$R" serve <dir> [--open]             # live preview with scrubber (local browser)
python3 "$SKILL_DIR/scripts/qa.py" <video> [--sheet out.jpg]   # QA any video file
python3 "$SKILL_DIR/scripts/media.py" clip in.mp4 assets/clip.webm   # footage → seekable WebM (+ .audio.wav)
```

## Failure modes

- **`page never called defineVideo()`** — a JavaScript error stopped the module; the error text is printed. Fix and re-run.
- **`render(t=…) failed` / timeout** — the composition threw at that time, or an async `render` never resolved (often a video seek). The message names the time.
- **Determinism FAILED** (audit) — a frame depends on what was rendered before it: a property set only in some frames, cached state, `Math.random()`. Parallel workers will show this as flicker at segment boundaries; fix before the final render.
- **Fonts look wrong / audit `font` warning** — the family isn't vendored; use one listed in `composition-api.md` or re-scaffold after `setup.py`.
- **MP4 footage is black** — headless Chromium can't decode H.264; convert with `media.py clip`.
- **Chromium won't launch on Linux** — missing system libraries; the installer prints the `install-deps` command (needs sudo — ask the user).
- **No TTS backend** — make a music-and-effects video, ask for an ElevenLabs/OpenAI key, or have the user record narration and run `align.py`.

## Token efficiency

One contact sheet (~20 frames) costs about as much as one large image — review the sheet, then pull full-res stills only where something looks off. Use `--draft` while iterating and render full quality once. Don't `Read` individual frames in bulk.

## Security & Permissions

**What this skill does:**
- Runs Node.js, headless Chromium and ffmpeg locally. During a render it serves the project folder on `127.0.0.1` (random port) to the local browser only.
- Installs npm packages (`playwright-core`, Fontsource fonts, KaTeX) into `~/.cache/make-video` and Chromium into Playwright's browser cache, via `setup.py`.
- Sends narration **text** to ElevenLabs or OpenAI only when you use those TTS backends; sends narration **audio** to Groq/OpenAI Whisper only for word alignment when no local model is available.
- Reads `~/.config/make-video/.env` (mode `0600`) and, for shared Whisper keys, `~/.config/watch/.env`.
- Writes only inside the project folder, the cache directory above and its own config file.

**What this skill does NOT do:**
- Does not upload your video anywhere, post to any platform, or use any account.
- Does not send API keys anywhere except the provider they belong to; never prints or logs them.
- Does not run `sudo`; on Linux it prints the command if Chromium needs system libraries.

**Bundled code:** `runtime/` (browser runtime copied into each project), `templates/` (starter projects), `scripts/render.mjs` (renderer), `scripts/setup.py`, `new_project.py`, `tts.py`, `align.py`, `qa.py`, `media.py`, `palette.py`, `mv_env.py`. Review before first use.
