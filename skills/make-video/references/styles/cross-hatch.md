# Style: cross-hatch

Pen-and-ink engraving on ivory paper: everything is line — tone comes from hatching density, outlines boil slightly as if redrawn each frame, type is a refined italic serif, and a single red ink carries emphasis.

**Signature:** hatched (not filled) shading · boiling hand-inked outlines · ivory paper · serif italics · one red accent.

## Palette (`themes['cross-hatch']`)

| role | hex | use |
|------|-----|-----|
| bg | `#f3eee0` | ivory paper |
| ink | `#1c1a17` | all line work and text |
| accent | `#b8322a` | red ink: arrows, underlines, the one thing that matters |
| colors | `#1c1a17 #b8322a #2f4a6d #a39b8b #d9cfb8` | ink, red, blue-black ink, graphite wash, sepia wash |

Washes (`#d9cfb8`, `#a39b8b` at 30–60% alpha) may sit under hatching for depth; never use saturated fills.

## Type

- Display: **Instrument Serif** italic (weight 400 — it has no bold). Body: **EB Garamond** 500. Annotations: **Caveat** in red.
- Classic layouts: centered title with small-caps kicker and a ruled line; captions like engraving plates ("Fig. 2 — The tidal bulge").

## Drawing

```js
import { hatch, sketch, sketchCircle, sketchLine, sketchArrow, circlePoints, boil } from './lib/mv-draw.js';
const sd = boil(t, 8);                                   // redraw jitter 8×/s
hatch(ctx, circlePoints(cx, cy, r), { gap: 7, angle: -35, cross: true, color: ink, seed: sd, progress: p });
sketchCircle(ctx, cx, cy, r, { color: ink, width: 2.4, seed: sd });
sketchArrow(ctx, x1, y1, x2, y2, { color: '#b8322a', width: 3, seed: sd, progress: q });
```

- Tone scale: light = `gap 12`, mid = `gap 8`, dark = `gap 6 + cross`, black = `gap 4 + cross`. Shade the side away from an imagined top-left light.
- Outline with `sketch*` (2 passes, `rough 0.7–1`), hatch inside with 1 pass.
- Draw-on everything: outline first (`progress` 0→1 over 0.6–1 s), then hatching fills in (`progress` on `hatch`).

## Motion

- Slow and deliberate: `ease.inOutSine`, 0.8–1.5 s moves. Ink appears by drawing, not fading (text may fade + slight blur, as in the starter).
- Boil at 6–8 fps (`boil(t, 8)` as the seed) on all line work — even static frames live.
- Camera: slow push-ins and pans across a large engraved "plate" (`.world` wrapper with `css(world, { scale, x })`).
- Transitions: `dip:0.8` through the paper, or ink spreading: an `iris` from a dot.

## Sound

Sparse and acoustic: `pad` on `Am7 Fmaj7 Cmaj7 G6` with a low cutoff (1100), occasional `chime` (bell-like), soft `click` for pen ticks, `typing` sounds for quick scribbles (`rate: 18, gain: 0.08`).

## Don't

- Solid color fills or gradients (hatch instead).
- Many colors; red is the only hue besides ink and washes.
- Perfect straight vector lines — always `sketch*`.
