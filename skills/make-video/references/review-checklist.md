# Review checklist (every render)

You can't watch the video, so you review its frames. After each render:

1. Read the **QA lines** the renderer prints (black/frozen segments, flashes, loudness) and `render.mjs audit` output.
2. `Read` the **contact sheet** (`out/<name>[.draft].sheet.jpg`) — ~20 frames labeled with timecode and scene.
3. For anything you can't judge at thumbnail size, render full-res stills at those times: `render.mjs stills <dir> --at 3.2,7.9 [--debug]` and `Read` them.
4. Fix, re-render (draft), repeat. Final full-quality render only when a draft passes.

## Hard failures (always fix)

- [ ] Any audit **ERROR**: text clipped by the frame or by an `overflow: hidden` box; missing images.
- [ ] Determinism mismatch in the audit.
- [ ] Blank, black or obviously broken frames; elements in default/unstyled positions (a `build` without `render` updates).
- [ ] Fallback fonts (audit `font` warning) — the look depends on the vendored fonts.
- [ ] Text overlapping other text or a busy motif so it can't be read.
- [ ] Placeholder copy left in ("Three rules", "Lorem", template titles) or factual errors in on-screen text.
- [ ] Audio: missing narration, music louder than the voice, clipping, loudness far from −14 LUFS, A/V length mismatch.
- [ ] Photosensitivity warning (more than 3 flashes per second) — slow the flashes or lower their contrast.

## Quality pass (fix what you find)

- [ ] **Hook**: does the first sheet frame already show something interesting (not an empty background)?
- [ ] **One focal point** per frame; the eye knows where to look.
- [ ] **Hierarchy**: headline clearly bigger than body; labels never tiny (audit `tiny` warnings).
- [ ] **Safe areas**: nothing important in the outer 5% (16:9) or under the 9:16 UI zones (`stills --debug`).
- [ ] **Reading time**: every text line stays up ≥ 1.5 s; no text appears and vanishes within one sheet interval.
- [ ] **Something changes every ~2 s**; QA "nothing moves" holds over 4 s are deliberate.
- [ ] **Motion quality**: entrances ease out, exits ease in, staggered groups, no simultaneous everything.
- [ ] **Continuity**: consistent palette and type across scenes; one transition language.
- [ ] **Sync**: visual changes land on their narration cues (compare sheet timecodes to `narration.words.json`).
- [ ] **Ending**: a clear final frame held ~1.5 s; nothing mid-animation at the last frame.
- [ ] **Style fidelity**: does it read as the chosen style at a glance? (see `styles/<name>.md` "signature" list)

## Common fixes

| symptom | fix |
|---------|-----|
| text runs off the frame | `fitText()` in `build`, shorter copy, or a smaller `--size-*` |
| text overlaps the backdrop motif | `backdrop(..., { intensity: 0.5 })` or `{ motif: false }`, or put text on a solid card |
| frame looks empty after a cut | start the first element at `s.at(0, 0.35)`; avoid hard cuts to empty scenes |
| everything moves at once | stagger by 0.08–0.15 s; overlap only ~30% |
| motion feels robotic | replace `linear` with `outCubic` / `inOutCubic`; add overshoot to the hero element |
| scene feels static | slow push-in on a wrapper (`scale 1 → 1.04`), boil lines, drifting particles |
| flicker between parallel chunks | determinism bug — an unconditional property set or a seeded rng fixes it |
| colors look muddy in the MP4 | avoid large full-frame noise; lower grain `amount` (also shrinks the file) |
| narration and visuals drift | build scene starts from `vo.cue(...)`, not hand-typed seconds |
