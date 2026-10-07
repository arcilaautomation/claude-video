# Style: isometric

A tidy miniature world at 30°: pastel blocks with three-tone shading, floor grids, little servers, buildings and devices assembling themselves — perfect for systems, data flows and "how it works" for software.

**Signature:** true isometric projection (no perspective) · three tones per object (lit top, mid left, dark right) · pastel palette on a soft gradient · things rise, slide along grid axes and connect.

## Palette (`themes.isometric`)

| role | hex | use |
|------|-----|-----|
| bg | `#eef1ff` → `#dce2fb` | soft periwinkle gradient |
| ink | `#1e2140` | text, outlines (optional) |
| accent | `#d9468a` | highlights, data packets |
| colors | `#6c74f0 #9b7bf2 #f27fb2 #4fd1a5 #f8b84e #58b6f2` | indigo, violet, pink, mint, amber, sky |

`I.box` derives top/right tones automatically (`shade(color, ±)`), or pass `top/left/right`.

## Type

- Display: **Space Grotesk** 700. Body: **Inter** 500. Labels on objects: **JetBrains Mono** small caps in pill tags.
- Text lives on the flat 2D layer above the world (don't skew text isometrically unless it's a sign on a block).

## The world

```js
import { iso } from './lib/mv-draw.js';
const I = iso(W * 0.62, H * 0.62, 56);          // origin, unit size in px
I.grid(ctx, 10, 10, { x0: -5, y0: -5 });
const items = [[0, 0, 2, '#6c74f0'], [2, 0, 1, '#4fd1a5'], [0, 2, 1.4, '#f8b84e']];
items.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));    // back to front
for (const [x, y, hgt, c] of items) {
  const rise = s.at(0.2 + (x + y) * 0.08, 0.8 + (x + y) * 0.08, ease.outBack);
  I.shadow(ctx, x, y, 1, 1);
  I.box(ctx, x, y, 0, 1, 1, hgt * rise, { color: c });
}
const [px, py] = I.p(1.5, 0.5, 2.2);             // screen point above a block — anchor a DOM label there
```

- Sort by `x + y` (then `z`) every frame; draw shadows before boxes.
- Compose clusters (a "city", a "server rack", a "pipeline") rather than scattering blocks; keep one side of the frame for text.
- Connections: dashed lines along grid axes (`I.p` endpoints) with a dot (data packet) travelling along them (`lerp` between grid points).

## Motion

- Blocks rise from the floor (`h * ease.outBack(p)`) with diagonal stagger (`(x + y) * 0.06–0.1 s`).
- Camera: slow drift of the origin (`ox + 20 * ease.inOutSine(s.p)`) or a scale push; transitions `zoom` into a block.
- Packets move linearly along paths and pulse on arrival (`scale 1 → 1.3 → 1`).

## Sound

Airy tech: `pad` on `Ebmaj7 Cm7 Abmaj7 Bb6`, light `arp`; `blip` per block landing (pitch up the scale), `click` for connections, `success` when the system completes.

## Don't

- Perspective (vanishing points) or rotating the projection mid-scene.
- More than ~12 visible blocks at once; random scattering.
- Text overlapping the world — anchor labels in clear space with leader lines.
