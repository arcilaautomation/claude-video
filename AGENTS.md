# claude-video / watch + make-video skills

Agent Skills package that gives an agent video input (`/watch`) and video output (`/make-video`). Installable across Claude Code (most common host), Codex, Cursor, GitHub Copilot, and 50+ other [Agent Skills](https://agentskills.io) hosts. `/watch` is pure-stdlib Python that orchestrates `yt-dlp` + `ffmpeg` and an optional Whisper API. `/make-video` is a browser runtime (ES modules, no build step) + a Node renderer (`playwright-core` + headless Chromium + `ffmpeg`) + stdlib Python helpers.

## Structure

- `skills/watch/SKILL.md` — canonical skill contract the model reads when `/watch` fires. Source of truth for behavior across every host.
- `skills/watch/scripts/watch.py` — entry point; orchestrates download → frames → transcript.
- `skills/watch/scripts/{download,frames,transcribe,whisper,setup,config}.py` — yt-dlp wrapper, ffmpeg frame extraction + auto-fps, caption/Whisper transcription, preflight/installer, shared config.
- `skills/watch/scripts/build-skill.sh` — builds `dist/watch.skill` for claude.ai upload (dev-only).
- `skills/make-video/SKILL.md` — the video-making workflow contract (intake → story → storyboard → build → render/review loop → deliver).
- `skills/make-video/runtime/` — browser runtime copied into every project: `mv.js` (timeline, scenes/transitions, easing, noise, text helpers, preview player, layout audit, `window.__MV__` renderer protocol), `mv-draw.js` (canvas style helpers), `mv-audio.js` (procedural sound), `mv-themes.js` (the 7 style presets).
- `skills/make-video/scripts/render.mjs` — renderer CLI (video / storyboard / stills / sheet / audit / audio / info / serve / doctor).
- `skills/make-video/scripts/{setup,new_project,tts,align,qa,media,palette,mv_env}.py` — runtime installer, project scaffolder, narration + word timing, video QA, footage prep, palette extraction, shared config.
- `skills/make-video/templates/` — `starter` (any style), `explainer` (narration-timed chalkboard explainer), `style-reel`.
- `skills/make-video/references/` — composition API, craft, audio, review checklist, `styles/<name>.md`.
- `hooks/` — Claude Code SessionStart setup-status hook (Claude Code only).
- `.claude-plugin/` — `plugin.json` + `marketplace.json` (Claude Code plugin + local marketplace).
- `.codex-plugin/plugin.json` — Codex/agents manifest; `"skills": "./skills/"` points the Agent Skills CLI at the self-contained skill folder.
- `.agents/plugins/marketplace.json` — agents marketplace listing pointing at the repo-root plugin.
- `CLAUDE.md` → `@AGENTS.md` — generic-agent entry point.
- `tests/` — pytest suite (ffmpeg-synthesized clips; no network). `test_mv_*` cover make-video; the render tests auto-skip without node + a launchable Chromium.

## Orientation

- The product is the slash-command-invoked skill (`/watch <url-or-path> [question]`), not a CLI. `scripts/watch.py` is implementation. Features must work across every harness the skill installs into, not just Claude Code.
- **The skill is one self-contained folder: `skills/watch/`.** SKILL.md and `scripts/` are siblings inside it. This is what lets `npx skills add` copy a working skill as a unit — do NOT move SKILL.md or `scripts/` back to the repo root, or non-Claude installers will copy SKILL.md without the scripts.
- **Path resolution is harness-agnostic.** SKILL.md resolves `SKILL_DIR` as the directory of the SKILL.md the model just Read, then runs `${SKILL_DIR}/scripts/...`. Do NOT reintroduce `${CLAUDE_SKILL_DIR}` (Claude-Code-only) — it is unset on Codex/Cursor/agents and breaks every script call there.
- **No `commands/` wrapper.** `/watch` and `/make-video` are derived from SKILL.md frontmatter (`name` + `user-invocable: true`). A separate command file creates a duplicate slash command.
- **make-video's core contract: a frame is a pure function of `t`.** The renderer draws frames out of order across parallel workers. Runtime changes must keep `seek(t)` deterministic; `render.mjs audit` checks it and `tests/test_mv_render.py` asserts the check works.
- **No `node_modules` in the skill folder.** Runtime npm deps live in `MAKE_VIDEO_HOME` (default `~/.cache/make-video`), installed by `setup.py`, because plugin installs can be read-only. `render.mjs` resolves `playwright-core` from there (then the project, then the global npm root).
- **Projects carry their own runtime copy** (`new_project.py` copies `runtime/*.js` into `<project>/lib/`), so old projects keep rendering identically. Templates must import from `./lib/`, never from `/__mv/`.
- **Don't name directories `assets/`, `examples/`, `docs/`, `fixtures/` or `tests/` inside a skill** — `.gitattributes` export-ignores them, which would drop them from plugin installs and `.skill` bundles. Project `assets/` folders are created at scaffold time.
- **Originality:** templates and style recipes draw only original shapes/characters; docs tell the agent to recreate a reference's feel, never copy copyrighted characters, logos or footage.

## Install surfaces

| Surface | Install |
|---------|---------|
| Claude Code | `/plugin marketplace add bradautomates/claude-video` then `/plugin install watch@claude-video` |
| Codex / Cursor / Copilot / +50 | `npx skills add bradautomates/claude-video -g` |
| claude.ai (web) | upload `dist/watch.skill` / `dist/make-video.skill` (built by `skills/<name>/scripts/build-skill.sh`) |

## Commands

```bash
# Tests (stdlib + pytest; ffmpeg required for frame tests)
.venv/bin/pytest -q                # or: python3 -m pytest -q

# Build the claude.ai upload bundles (each archives skills/<name>/ as the bundle root)
bash skills/watch/scripts/build-skill.sh        # → dist/watch.skill
bash skills/make-video/scripts/build-skill.sh   # → dist/make-video.skill

# make-video: install the runtime once, then render a template end to end
python3 skills/make-video/scripts/setup.py
python3 skills/make-video/scripts/new_project.py /tmp/demo --template explainer --style chalkboard
node skills/make-video/scripts/render.mjs audit /tmp/demo && node skills/make-video/scripts/render.mjs video /tmp/demo --draft

# Dev: mirror the working tree into the installed Claude Code plugin cache
./dev-sync.sh                       # --dry-run to preview
```

## Rules

- Keep the version in sync across `skills/watch/SKILL.md` and `skills/make-video/SKILL.md` (frontmatter), `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `SKILL_VERSION` in `skills/make-video/scripts/setup.py` when cutting a release.
- When you change a make-video template or runtime visual, render it (`audit` + `video --draft`) and look at the contact sheet before committing.
- Releasing: tag `vX.Y.Z` and push the tag; `.github/workflows/release.yml` builds both `.skill` bundles and attaches them to the GitHub release.
- Never commit real API keys or `.env` contents; keys live in `~/.config/watch/.env` and `~/.config/make-video/.env` (mode `0600`) at runtime.
