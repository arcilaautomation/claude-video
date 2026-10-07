# Style: risograph

A riso-printed zine come alive: two or three fluorescent spot inks, overprinted so they multiply into new colors, speckled grain, layers a few pixels out of register, halftone gradients and loud condensed type.

**Signature:** limited spot inks · `multiply` overprints making a third color · grain speckle in solid areas · misregistration that jitters · halftone dots instead of gradients.

## Palette (`themes.risograph`, inks in `RISO`)

| role | hex | use |
|------|-----|-----|
| bg | `#f6f0e1` | uncoated paper |
| ink | `#3d5588` | federal blue — text |
| accent | `#ff48b0` | fluorescent pink |
| colors | `#ff48b0 #0078bf #ffe800 #00838a #ff6c2f #3d5588` | pink, blue, yellow, teal, orange, federal blue |

Pick **two inks per video** (pink + blue is the classic; yellow + teal, orange + blue also sing). Pink × blue multiply → purple; yellow × blue → green. That's the palette.

## Type

- Display: **Archivo** at `font-stretch: 62–75%`, weight 900, uppercase, tight leading (0.9). Body/mono: **Space Mono**.
- Fake overprint on DOM text: `text-shadow: .045em .03em 0 rgba(255,72,176,.75)` (second ink offset), or render headline words twice in two inks with `mix-blend-mode: multiply` and a 2–4 px offset that jitters.

## Printing layers

```js
import { risoLayer, halftone, RISO, grain } from './lib/mv-draw.js';
const k = boil(t, 6);                                      // registration jitter 6×/s
const off = (i) => [(hash(k, i) - 0.5) * 6, (hash(k, i, 1) - 0.5) * 6];
risoLayer(ctx, RISO.blue, (lc) => { lc.fillRect(100, 300, 600, 400); }, { offset: off(0), key: 0, seed: 2 });
risoLayer(ctx, RISO.pink, (lc) => { lc.beginPath(); lc.arc(700, 400, 220, 0, TAU); lc.fill(); }, { offset: off(1), key: 1, seed: 5 });
halftone(ctx, 0, 800, 1920, 280, { value: (u) => u, cell: 14, color: RISO.pink });   // gradient as dots
grain(ctx, W, H, t, { amount: 0.025, rate: 4, blend: 'multiply' });
```

- One `risoLayer` call per ink per frame (each needs its own `key`); draw the lightest ink first.
- Shapes are bold and geometric: big circles, stripes, arrows, blocky icons, cut-out photo silhouettes (posterized).
- Keep grain static (`rate: 0`, the default) — animated grain balloons file size.

## Motion

- Snappy: `ease.snappy`/`outExpo` for entrances, hard cuts, `steps(4)` for poster-like jumps.
- Registration jitter at 6 fps on everything; slide layers *separately* (ink layers arriving with a 2–3 frame offset look great).
- Transitions: `wipe-right` like a new pass through the printer; pink/blue panels sweeping across.

## Sound

Lo-fi beat: `drums` at 88 bpm (`hat '..x...x...x...x.'`), `bass`, sparse `pad` on `Dm9 G7 Cmaj7 Am7`. `click`/`blip` on pops; `swish` on wipes.

## Don't

- More than three inks, smooth gradients, drop shadows, thin type.
- Pure black (use federal blue or a dark overprint).
- Grain so heavy that text breaks up — keep text on light paper or solid ink.
