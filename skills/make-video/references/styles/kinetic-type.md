# Style: kinetic-type

Words as the visuals: huge condensed type that slams, slides, stretches and masks on the beat, with hard cuts, a near-black/bone-white flip and one hot accent. Built for hooks, launches, quotes and promos.

**Signature:** type filling 70–90% of the frame width · masked reveals (letters rise from behind a baseline) · cuts on the beat · two-tone with one accent · constant momentum.

## Palette (`themes['kinetic-type']`)

| role | hex | use |
|------|-----|-----|
| bg | `#0b0b0c` | near-black (flip to `#f2f0ea` bone white for contrast beats) |
| ink | `#f2f0ea` | type |
| accent | `#ff4d1f` | signal orange — one word per scene at most |
| colors | `#ff4d1f #d7ff3b #f2f0ea #0b0b0c #3a3a3d` | orange, acid lime (rarely), bone, black, graphite |

## Type

- Display: **Anton** (400 only) uppercase, line-height 0.9–0.95; alt: **Archivo** with `font-stretch` animation (62% → 125%) for stretch effects. Body: **Inter** 600.
- One idea per screen, 1–4 words. Size each word to the frame with `fitText(el, { width: W * 0.9 })`.
- Masks: `.mv-word { overflow: hidden }` and translate chars from `y: 105%` → 0 (`ease.outExpo`), the starter's kinetic branch.

## Techniques

```js
// Beat grid from the theme tempo
const spb = 60 / theme.music.bpm;                  // seconds per beat
const beat = Math.floor(t / spb), phase = (t % spb) / spb;
// Slam: overshoot scale on the beat
css(word, { scale: 1 + 0.25 * (1 - ease.outExpo(Math.min(1, phase * 3))) });
// Stretch (Archivo): font-stretch from 62% to 125%
css(el, { fontStretch: `${62 + 63 * ease.inOutCubic(p)}%` });
// Flip: swap bg/ink every 2 beats for contrast beats (set both every frame)
```

- Layout variety per beat: centered single word → stacked three lines left-aligned → giant word cropped by the frame edge (intentional bleed) → word in a solid accent box.
- Marquees (repeating text strips sliding) and counters (`countUp`) fill transitional beats.
- Thin rules, grid lines and small mono labels (`01 / 04`) add designed structure.

## Motion

- `ease.outExpo` in, `ease.inExpo` out, durations 0.2–0.45 s; nothing sits still for more than one beat.
- Cut on the beat (`transition: 'cut'`), and set scene durations to multiples of a beat (`spb * 4`).
- Stagger letters 0.02–0.03 s; words 0.08 s.

## Sound

Driving: `drums` at 120 bpm with four-on-the-floor kick, `bass`, `arp` on `Am F C G` every 2 s; `impact` on the title slam, `swish` on slides, `riser` into the payoff word.

## Don't

- Body-sized text, paragraphs, or more than one accent color per frame.
- Flashing bg/ink faster than ~2 flips per second (QA flags > 3 flashes/s — a photosensitivity risk).
- Empty frames between cuts — the next word must already be arriving.
