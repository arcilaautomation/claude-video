# Style: cut-paper

Layered construction paper on a kraft desk: flat shapes with slightly ragged scissor-cut edges, soft drop shadows that sell the depth, and a stop-motion step so it feels handmade.

**Signature (all four make it read as cut paper):** jagged-edge flat shapes · real shadows between layers · fibrous paper texture · motion stepped at 12 fps with tiny rotation jitter.

## Palette (`themes['cut-paper']`)

| role | hex | use |
|------|-----|-----|
| bg | `#e9dcc4` | kraft board (texture: `paper`, visible fibers) |
| ink | `#2d2219` | text, small details |
| accent | `#d2491f` | tomato paper — the "look here" color |
| colors | `#e4572e #f2a541 #283d63 #7fb7d4 #9bbf85 #f2b5a7 #fbf4e6` | paper stock: tomato, marigold, navy, sky, sage, blush, cream |

Use 3–4 paper colors per scene. Cream (`#fbf4e6`) cards behind text keep contrast high.

## Type

- Display: **Fraunces** 700–900 (soft, wonky serif). Body: **DM Sans** 500. Handwritten notes: **Caveat**.
- Big headlines can sit on a torn paper strip (`paperShape` with `rectPoints` + `jag: 2.5`).
- Letters can arrive as individual paper cutouts: per-char rotation ±15° settling to ±2° (the starter's `enterChars`).

## Shapes and texture

```js
import { paperShape, blobPoints, rectPoints, circlePoints, starPoints, paper } from './lib/mv-draw.js';
// A sun that bobs on twos:
const ts = stepTime(t, 12);
paperShape(ctx, circlePoints(cx, cy + Math.sin(ts * 2) * 4, 90, 48), { color: '#f2a541', seed: 3 });
// Rolling hill layers back-to-front (darker = farther):
paperShape(ctx, blobPoints(w * 0.2, h * 1.1, 420, { seed: 1, wobble: 0.08 }), { color: '#9bbf85', seed: 1, dy: 10 });
```

- Every shape gets `paperShape` (jagged edge + shadow + fiber overlay). Bigger `dy`/`blur` = higher off the page.
- Build characters/objects from 3–8 simple shapes (circle head, rounded-rect body, triangle ears) — think collage, not illustration.
- Leave kraft visible around shapes; don't fill the frame edge to edge.

## Motion

- `stepTime(t, 12)` for all object motion ("on twos"); keep text entrances smooth or stepped consistently.
- Entrances: slide/drop in with `ease.outBack`, settle with a 1–3° rotation wobble (`hash(i)`-seeded, constant per object).
- Paper never fades — it slides, flips (scaleX through 0) or gets lifted off (scale up + shadow grows + exits).
- Transitions: `slide-left`/`push` like moving the board, or a big paper sheet wiping across (draw a full-frame `paperShape` sliding over).
- Idle: shapes "breathe" by ±1% scale on twos; a mobile-like sway (rotate ±2°) for hanging things.

## Sound

Warm and plucky: `pad` on `Fmaj7 Dm7 Bbmaj7 C6`, `arp` at ~4 notes/s (marimba-like), `pop` for each shape landing, `swish` on slides, `thud` for big pieces. Paper rustle = short `whoosh` with `from: 2000, to: 6000, gain: 0.15`.

## Don't

- Gradients, glows, thin hairlines, photographic images (breaks the material).
- Pure black text on tomato (low contrast) — use cream cards or ink on light paper.
- Perfectly smooth motion on objects — the step is the charm.
