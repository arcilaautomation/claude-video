# Style: sketchbook

A notebook page drawing itself: ballpoint lines on graph paper, chunky marker headlines, highlighter swipes, arrows and doodles that draw on as the explanation unfolds — a smart friend explaining with a pen.

**Signature:** graph/dot-grid paper · lines that draw on · gentle line boil · marker headline + handwritten labels · highlighter behind key words.

## Palette (`themes.sketchbook`)

| role | hex | use |
|------|-----|-----|
| bg | `#fbfaf5` | paper (texture: `grid`, 44 px squares) |
| ink | `#25303b` | ballpoint blue-black |
| accent | `#ff6b9a` | pink marker |
| colors | `#ffd23f #ff6b9a #3ccf91 #4aa3ff #25303b` | yellow / pink / mint / blue highlighters, ink |
| muted | `#8a94a6` | pencil |

## Type

- Display: **Permanent Marker** (weight 400 only — never bold). Body: **Patrick Hand**. Scribbles: **Caveat**.
- Highlighter behind words: an absolutely-positioned rounded rect in `colors[0]` at 55% alpha with `mix-blend-mode: multiply`, scaling X from 0 → 1 (origin left) after the word appears.
- Underlines and circles around words are `sketch*` strokes, drawn on.

## Drawing

```js
import { sketch, sketchRect, sketchCircle, sketchArrow, starPoints, boil, trimPath } from './lib/mv-draw.js';
const sd = boil(t, 6);
sketchRect(ctx, x, y, w, h, { color: ink, width: 3, seed: sd, progress: s.at(0.2, 0.9) });
sketchArrow(ctx, ax, ay, bx, by, { color: '#ff6b9a', width: 4, curve: 0.2, seed: sd, progress: s.at(0.8, 1.4) });
sketchCircle(ctx, cx, cy, 60, { color: ink, width: 3, seed: sd, progress: q });   // circles overshoot like real pen strokes
```

- Diagrams = boxes, arrows, stick figures, simple icons (lightbulb, gear, phone) built from sketch strokes.
- Use the grid: snap boxes to 44 px multiples so drawings feel planned.
- Sticky notes: rotated (±3°) yellow/pink squares with a soft shadow, handwritten text.

## Motion

- Everything draws on (`progress` 0→1, `ease.outCubic`, 0.4–1.0 s per stroke), in the order a person would draw it.
- Boil at 6 fps on all strokes; text doesn't boil.
- A pen-position "cursor" (small dot at the end of the active stroke) sells the drawing — `trimPath(pts, p)` gives the tip.
- Transitions: `slide-up` like turning to the next page, or erase (draw the same strokes with `progress` running back to 0).

## Sound

Light and curious: `arp` on `C G Am F` (every 2.4 s), soft `pad`; `typing` at `rate: 16, gain: 0.08` while strokes draw (pen scratch), `pop` on sticky notes, `chime` on the "aha".

## Don't

- Fill large areas with solid color; heavy shadows; geometric perfection.
- Faux-bold marker type (it's single-weight).
- Doodles behind body text — keep the text column clear.
