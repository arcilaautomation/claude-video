# Composition API

A project is a folder with `index.html` that imports the runtime from `./lib/` and calls `defineVideo()` once. The renderer serves the folder on localhost, seeks the page to `t = frame / fps` for every frame and screenshots it.

```html
<link rel="stylesheet" href="lib/fonts.css">
<script type="module">
import { defineVideo, ease, css, h, splitText } from './lib/mv.js';
import { applyTheme } from './lib/mv-themes.js';
import { backdrop } from './lib/mv-draw.js';

const W = 1920, H = 1080;
const theme = applyTheme('chalkboard', { width: W, height: H });   // CSS vars + type scale

defineVideo({
  title: 'Why the sky is blue', width: W, height: H, fps: 30,
  background: theme.palette.bg,
  transition: 'fade:0.6',                       // default scene transition
  layers: [{ name: 'bg', under: true, canvas: true, render: (t, s) => backdrop(s.ctx, theme, t, W, H) }],
  scenes: [
    { name: 'hook', duration: 3, label: 'Hook', note: 'Question on screen',
      build(el) { el.append(h('h1', { class: 'title' }, 'Why is the sky blue?')); },
      render(t, s) { css(s.$('.title'), { opacity: s.at(0.2, 0.8), y: (1 - s.at(0.2, 1, ease.outBack)) * 40 }); } },
    // …
  ],
  audio(a) { a.pad({ chords: ['Am9', 'Fmaj7'], gain: 0.12 }); a.whoosh(a.scene('…').start - 0.1); },
  tracks: [{ src: 'assets/narration.mp3', role: 'voice', at: 0.3 }],
});
</script>
```

## The contract

1. **Pure function of time.** What's on screen at `t` must not depend on which frames were drawn before. Frames render out of order across parallel workers. `render.mjs audit` checks this ("determinism").
2. **Set every animated property on every frame.** Write `css(el, { opacity: p })` unconditionally — never `if (t > 2) el.style.opacity = 1` without the else.
3. **No `Math.random()` or `Date` for visuals.** Use `rng(seed)`, `hash(i, j)`, `noise(x, y, z)`. (The renderer also seeds `Math.random`, but per-page call order still differs between workers.)
4. **Build once, render often.** Create DOM, measure, precompute paths/layouts in `build()`; `render()` only updates.
5. **Async is allowed** but must settle: `render` may return a promise (e.g. `clip.seek(t)`); the frame waits for it.
6. **CSS transitions are disabled; CSS animations are scrubbed** — `@keyframes` animations are paused and seeked to the clip's local time, so they work (relative to the scene start), but prefer `render(t)` for anything important.
7. **Avoid forcing GPU layers**: `will-change`, `translate3d`/`translateZ`, `rotateX/Y` and `perspective` promote elements to compositor layers whose raster scale Chrome reuses between frames, so pixels can depend on render history (the audit's determinism check catches it). `css()` emits 2D transforms unless you pass `z`/`rotateX`/`rotateY`.

## `defineVideo(config | () => config | async () => config)`

| key | meaning |
|-----|---------|
| `width`, `height`, `fps` | frame size (even numbers) and rate. 30 fps is the default; 60 for very fast motion; 24 for film feel. |
| `background` | stage color (`'transparent'` for alpha renders). |
| `title` | used in reports and sheets. |
| `scenes` | sequential clips (below). Duration of the video = end of the last scene unless `duration` is set. |
| `layers` | clips with explicit timing (`start`, `end`, default whole video). `under: true` → behind scenes (backgrounds), otherwise on top (captions, logos, progress bars). |
| `transition` | default transition for every scene after the first. |
| `setup(stage)` | async hook after all `build()`s (load JSON, images, words). |
| `render(t, info)` | optional global per-frame hook after the clips. |
| `beats` | `[{ t, label, note }]` storyboard frames. Default: one per scene at `scene.beat` (local seconds) or 65% through it. |
| `audio(a)` | procedural sound (see "Audio"). |
| `tracks` | audio files: `{ src, at = 0, gain = 1, role = 'music'|'voice'|'fx', trim, duration, fadeIn, fadeOut, loop }`. |

An async config function lets timing come from data:

```js
defineVideo(async () => {
  const vo = await loadWords('assets/narration.words.json');
  return { …, scenes: [
    { name: 'intro', start: 0, … },
    { name: 'moon', start: vo.cue('the moon') - 0.3, … },   // scene begins just before the words
    { name: 'outro', start: vo.cue('so next time'), duration: vo.duration - vo.cue('so next time') + 1.5, … },
  ] };
});
```

### Scenes and layers (clips)

```js
{ name, duration | start,          // a scene without duration ends where the next scene's start says
  transition: 'fade:0.6',          // how THIS scene enters (and the previous one leaves)
  canvas: true | { clear: false, dpr },   // adds a full-frame canvas → s.ctx
  build(el, s) {},                  // once; el is this clip's <section> (or an existing [data-scene="name"])
  render(t, s) {},                  // every frame while active; t = local seconds
  label, note, beat }               // storyboard metadata
```

Transitions: `cut`, `fade` (old out, then new in — no text-on-text), `crossfade` (both at once), `fade-over` (new over an opaque old scene), `dip` (through the background), `slide-left|right|up|down` (push), `cover-left|…` (slides over), `wipe-left|right|up|down` (clips both scenes; add `edge: '#ff4d1f', edgeWidth` for a colored bar on the wipe front), `iris` (`{ type: 'iris', x, y }`), `zoom`, `blur`. Write `'type:seconds'` or `{ type, duration, ease, … }`. The runtime animates the clip container — animate children, not the container. A scene's first ~45% of a `fade` is invisible, so start its entrances after that.

The clip info object `s` (second argument to `render`, also passed to `build`):

| | |
|-|-|
| `s.t`, `s.d`, `s.p` | local time, duration, progress 0–1 |
| `s.T`, `s.frame`, `s.fps` | global time, frame index, fps |
| `s.at(a, b, easing = ease.inOutCubic)` | eased 0→1 between local times `a` and `b`; negative values count from the end (`s.at(-0.6, -0.1)` = exit) |
| `s.in`, `s.out` | enter / exit transition progress (0–1) |
| `s.el`, `s.$(sel)`, `s.$$(sel)` | the clip's element and queries inside it |
| `s.ctx`, `s.canvas` | 2D context / canvas when `canvas` is set (pre-cleared every frame) |
| `s.width`, `s.height` | frame size |
| `s.total`, `s.frames` | the whole video's duration and frame count |

## Motion helpers (`mv.js`)

- **Math**: `clamp(x, lo=0, hi=1)`, `lerp(a, b, p)`, `invLerp`, `remap(x, a, b, c, d, easing?)`, `progress(t, start, end, easing?)`, `smoothstep`, `fract`, `mod`, `pingpong`, `rad`, `deg`, `dist`, `stepTime(t, 12)` (stop-motion), `stagger(i, each, start)`.
- **Easing** `ease.*`: `linear`, `in/out/inOut` × `Sine Quad Cubic Quart Quint Expo Circ Back Elastic Bounce`; curated `smooth`, `snappy`, `standard`, `anticipate`; factories `bezier(x1,y1,x2,y2)`, `spring({ bounce })`, `back(overshoot)`, `steps(n)`, `reverse(fn)`, `inOut(fn)`. Physical `spring(seconds, { stiffness, damping, mass })`.
- **Interpolation**: `mix(a, b, p)` (numbers, CSS colors via OKLab, arrays, flat objects), `tween(t, t0, t1, from, to, easing)`, `keys(t, [[0, 0], [1, 100, ease.outBack], [2.5, 40]])` (each key's easing shapes the segment that leaves it).
- **Color**: `mixColor(a, b, p)`, `alpha(c, a)`, `shade(c, ±amount)`, `contrast(a, b)` (WCAG ratio), `readable(fg, bg, min = 4.5)` (same hue, lightness nudged until it passes), `parseColor`.
- **Randomness**: `rng(seed)` → `.next() .range(a,b) .int(a,b) .pick(arr) .chance(p) .gauss() .shuffle(arr)`; `hash(...numbers)` → [0,1); `noise(x, y, z)` Perlin; `fbm(x, y, z, octaves)`; `wiggle(t, freq, amp, seed)` (AE-style wiggle); `noiseSeed(n)`.
- **DOM**: `h(tag, attrs, ...kids)`, `svg(tag, attrs, ...kids)`, `$`, `$$`, `css(el, { x, y, z, scale, scaleX, scaleY, rotate, rotateX, rotateY, skewX, skewY, opacity, blur, origin, …any CSS or --var })` — transform keys rebuild the whole transform, so pass them together.
- **Text**: `splitText(el)` → `{ words, chars }` inline-block spans (call in `build`, call again in `render` to get the cached spans); `fitText(el, { max, min, width, height })` shrink-to-fit (in `build`, after fonts load); `textLines(el)` → line boxes `[{ x, y, w, h }]` in frame pixels (size an underline to the last line, place highlights); `typeOn(el, text, p, { caret: '|', t })`; `countUp(p, from, to, { decimals, prefix, suffix })`. Faux bold/italic is disabled (`font-synthesis: none`): use weights the font has — `--weight-display`/`--weight-body` from the theme. Characters a font lacks fall back to another font; the audit reports them as `glyph` warnings (e.g. arrows and check marks in handwriting fonts).
- **SVG**: `drawOn(pathEl, p)` stroke draw-on; `pointAt(pathEl, p)` → `{ x, y, angle }` for motion along a path.
- **Media**: `loadImage(src)`, `loadJSON(src, { optional })`, `videoClip('assets/x.webm', { loop, rate })` → `<video>` with `await clip.seek(t)` (WebM/VP9 only — convert with `media.py clip`).
- **Narration**: `loadWords(src, { optional: true })` (→ `null` when the file doesn't exist yet) / `narration(json)` → `vo.cue(phrase, n=1)`, `vo.cueEnd(phrase)`, `vo.has(phrase)`, `vo.wordAt(t)`, `vo.chunks({ maxWords, maxChars, pause })`, `vo.captionAt(t)` → `{ text, words: [{ w, s, e, active, spoken }], start, end }`. Phrase matching ignores case and punctuation; a missing cue throws with suggestions.
- **Misc**: `isRender` (true inside the renderer), `fmtTime(t)`.

## Drawing helpers (`mv-draw.js`) — canvas, all deterministic

- **Backgrounds**: `backdrop(ctx, theme, t, w, h, { intensity, motif })` (texture + on-style corner motif), `themeBackground(theme, w, h)`, `paper(w, h, opts)`, `board(w, h, opts)`, `gridPaper(w, h, { dots, spacing })`, `gradient(w, h, { from, to, angle })` — all cached canvases; `grain(ctx, w, h, t, { amount, rate, blend })` animated film grain.
- **Shapes**: `roundRect`, `polyPath`, `smoothPath(ctx, pts, { closed })`, `rectPoints`, `circlePoints(cx, cy, r, n, ry)`, `blobPoints(cx, cy, r, { seed, wobble, t })`, `starPoints`, `resample`, `trimPath(pts, p)`, `makeCanvas(w, h)`.
- **Hand-drawn**: `sketch(ctx, pts, { color, width, seed, rough, passes, progress, closed, taper })`, `sketchLine`, `sketchRect`, `sketchCircle`, `sketchArrow(ctx, x1, y1, x2, y2, { curve, head, progress })`, `boil(t, rate)` → seed that changes `rate` times/second (line boil).
- **Hatching**: `hatch(ctx, polygonOrPathFn, { angle, gap, width, color, cross, progress, seed })`.
- **Cut paper**: `paperShape(ctx, pts, { color, seed, jag, shadow, blur, dx, dy, texture })`, `cutEdge(pts)`.
- **Risograph**: `RISO` inks, `risoLayer(ctx, ink, drawFn, { offset: [dx, dy], grain, seed, t, key })` (multiply + misregistration; one call per ink, `key` unique per layer), `halftone(ctx, x, y, w, h, { value: (u, v) => 0..1, cell, angle, color })`.
- **Isometric**: `const I = iso(originX, originY, unit)` → `I.p(x, y, z)`, `I.box(ctx, x, y, z, w, d, h, { color | top/left/right, stroke })`, `I.tile`, `I.grid`, `I.shadow`. Draw back-to-front (sort by `x + y`, then `z`).
- **Chalk / glow**: `chalk(ctx, pts, { color, width, progress, seed, density })`, `glowStroke(ctx, pathFn, { color, width, glow })`, `chalkMask()` → a CSS mask URL that gives DOM text/shapes a dusty chalk texture (`css(el, { maskImage: m, webkitMaskImage: m, maskSize: '192px' })`).
- **Mascot**: `buddy(ctx, x, y, size, { t, color, look: [x, y], talk: 0–1, mood, squash, wave })` — an original blob character rig; `talkAmount(vo, t)` drives its mouth from narration.
- **Text**: `wrapLines(ctx, text, maxWidth)`.

## Themes (`mv-themes.js`)

`themes[name]` → `{ name, key, summary, palette: { bg, ink, accent, muted, colors[] }, fonts: { display, body, hand, mono, math? }, texture, motion: { ease, stepFps?, boil?, transition, … }, music: { chords, every, bpm, arp, drums } }`. `applyTheme(nameOrTheme, { width, height })` sets CSS variables `--bg --ink --accent --muted --c1…--cN --font-display --font-body --font-hand --font-mono --size-hero --size-title --size-subtitle --size-body --size-label --size-small --pad` and returns the theme. Custom look: `applyTheme({ ...themes['cut-paper'], palette: { … } }, { width: W, height: H })`.

**Vendored fonts** (in `lib/fonts.css`): Inter, DM Sans, Space Grotesk, Fraunces, EB Garamond, JetBrains Mono, Caveat, Archivo (variable width: `font-stretch: 62%–125%`), Instrument Serif, Permanent Marker, Patrick Hand, Cabin Sketch, Space Mono, Anton. Anything else falls back to system fonts — the audit warns.

**Math**: scaffold with `--math`, then `import katex from './lib/katex/katex.mjs'`, add `<link rel="stylesheet" href="lib/katex/katex.min.css">`, and `katex.render(String.raw`E = mc^2`, el, { displayMode: true })` in `build()`.

## Audio (`audio(a)`)

Times are absolute seconds. Everything renders offline and deterministically into two stems (music, fx).

- **Effects**: `a.whoosh(t, { dur, gain, from, to, pan })`, `a.swish`, `a.pop(t, { pitch })`, `a.click`, `a.tick`, `a.blip(t, { note })`, `a.chime(t, { note, decay })`, `a.success(t)`, `a.riser(t, { dur })` (peaks at `t + dur`), `a.impact(t)`, `a.thud`, `a.typing(t, { dur, rate })`, `a.sparkle(t, { dur })`.
- **Music**: `a.pad({ chords, every, gain, cutoff, start, end })`, `a.arp({ chords, every, rate, pattern })`, `a.bass({ chords, every, bpm })`, `a.drums({ bpm, kick: 'x...x...', snare, hat, swing })`. Chords: `C`, `Am7`, `Fmaj7`, `G6`, `Dm9`, `Csus2`, `E7`, `Bb/D`, …
- **Files**: `await a.sample('assets/ding.wav', t, { gain, rate, bus })`; long files (voice, music beds) belong in `tracks` so they're ducked and normalized.
- **Sync**: `a.scenes`, `a.scene('name').start`, `a.beats`; pass narration cues via closure (`const vo = …` above `defineVideo`).

## Patterns

**Staggered entrance** (list, letters, bars):
```js
render(t, s) {
  s.$$('.item').forEach((el, i) => {
    const p = s.at(0.4 + i * 0.12, 0.9 + i * 0.12, ease.outBack);
    css(el, { opacity: Math.min(1, p * 2), y: (1 - p) * 40, scale: 0.9 + 0.1 * p });
  });
}
```

**Exit before the cut**: `const out = s.at(-0.5, -0.1, ease.inCubic); css(el, { opacity: 1 - out, y: -20 * out });`

**Draw a chart**: build bars/paths in `build()` from data; animate heights with `keys()`; label values with `countUp()`.

**Camera move**: wrap scene content in a `.world` div and animate `css(world, { scale, x, y })` with a slow `ease.inOutSine` — a 3–6% push-in keeps static scenes alive.

**Captions** (vertical social):
```js
{ name: 'captions', render(t, s) {
    const c = vo.captionAt(t);
    s.el.replaceChildren(...(c ? c.words.flatMap((w, i) => [i ? ' ' : '', h('span', { class: w.active ? 'on' : w.spoken ? 'said' : '' }, w.w)]) : []));
} }
```
(Rebuilding a few spans each frame is fine — it is still a pure function of `t`.)

**Narration-driven reveals**: `const p = progress(T, vo.cue('three'), vo.cue('three') + 0.4, ease.outBack)` using the global time `s.T`.

**Footage**: `media.py clip demo.mp4 assets/demo.webm`, then `const clip = videoClip('assets/demo.webm')` → append in `build`, `return clip.seek(t)` in `render`, add `assets/demo.audio.wav` as a track.

**Simulations** (particles that depend on history): precompute every frame's state in `build()` with a seeded rng, then index by `Math.round(t * fps)`.
