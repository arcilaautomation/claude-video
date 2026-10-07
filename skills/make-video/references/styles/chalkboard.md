# Style: chalkboard

A dark board where ideas are written and drawn live: chalk-textured strokes, hand-lettered titles, pastel colors that each *mean* something, equations that write themselves and graphs that plot. Set the texture to `flat` (and fonts to EB Garamond + Inter) for the clean "vector on dark" math-explainer variant.

**Signature:** dark board with smudges · strokes that write on · color-coded concepts · equations and graphs as first-class visuals · calm, unhurried pacing.

## Palette (`themes.chalkboard`)

| role | hex | use |
|------|-----|-----|
| bg | `#1d2521` | slate board (texture: `board`) — clean variant: `#14171c`, texture `flat` |
| ink | `#eeece3` | chalk white |
| accent | `#ffd166` | yellow — "the answer" |
| colors | `#7cc6fe #ffd166 #ff8fa3 #8fe388 #ffa45b #eeece3` | blue, yellow, pink, green, orange, white |

Assign each concept a color for the whole video (e.g. input = blue, output = yellow, error = pink) and never reuse it for anything else.

## Type

- Display: **Cabin Sketch** 700 (chalky caps), body: **Patrick Hand**, handwriting: **Caveat**, math: **KaTeX** (scaffold with `--math`) or **EB Garamond** italic.
- Clean variant: titles in **EB Garamond**, labels in **Inter**, equations in KaTeX.

## Drawing

```js
import { chalk, glowStroke, circlePoints, trimPath } from './lib/mv-draw.js';
// A plotted function that draws itself
const pts = Array.from({ length: 200 }, (_, i) => { const x = i / 199; return [x0 + x * gw, y0 - Math.sin(x * TAU * 2) * gh]; });
chalk(ctx, pts, { color: '#7cc6fe', width: 5, progress: s.at(0.5, 2.0), seed: 3 });
// Clean variant: glowing vector stroke
glowStroke(ctx, (c) => { c.beginPath(); trimPath(pts, p).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); }, { color: '#7cc6fe', width: 5 });
```

**Equations** (KaTeX): render in `build()` into a div, then reveal with a left-to-right `clip-path: inset(0 X% 0 0)` driven by `s.at()` — reads as writing. Highlight terms by wrapping them in `\textcolor{#ffd166}{…}` and pulsing scale.

**Graphs**: axes draw first (0.5 s), then the curve (1–2 s), then a moving dot with a value readout (`countUp`) and dashed guide lines.

## Motion

- Write-on for everything (chalk `progress`, KaTeX clip reveal, text fade+blur as in the starter); `ease.inOutSine`.
- Morphs carry meaning: move an equation term to its new place instead of cutting (`mix` positions from `getBoundingClientRect` measured in build).
- Keep old content visible but dimmed (opacity 0.35) as the next step builds — it's a board.
- Transitions: `fade:0.8` (erase-like) or an eraser swipe (`wipe-right` with a chalk-dust smear).

## Sound

Calm and thoughtful: `pad` on `Am9 Fmaj7 Cmaj7 Em7` (every 5 s), gentle `chime` on each reveal, chalk tap = `click` with `tone: 1800`; `riser` into the key result, `success` on the answer.

## Don't

- Bright saturated neons on the textured board (keep pastels), or more than 4 concept colors.
- Walls of equations — one line at a time, the rest dimmed.
- Fast cuts; this style earns trust by taking its time.
