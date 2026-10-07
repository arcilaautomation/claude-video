# Craft: making it look and feel professional

Most weak code-made videos fail on fundamentals, not effort: too much text, everything moving at once, linear timing, nothing anchoring the eye. These rules fix 90% of it.

## Story

- **One sentence.** Write the single thing the viewer should remember before anything else. Every scene must serve it.
- **Hook in 1–2 seconds.** Open on the most surprising image or question, not a logo or a title card. ("Why does the Moon pull the ocean but not your coffee?")
- **One idea per scene.** If a scene needs two sentences of on-screen text, it is two scenes.
- **Show, then label.** Lead with the visual (the diagram moving, the number climbing), then the word for it.
- **Payoff.** End on the answer, a transformation, or a clear call to action — and hold the last frame ~1.5 s.

## Script and timing

- Narration runs ~2.5 words/second: 15 s ≈ 35 words, 30 s ≈ 70, 60 s ≈ 150. Write for the ear: short sentences, concrete nouns, no parentheses.
- On-screen text ≤ 7 words per line, ≤ 2 lines at a time; keep each line up ≥ 1.5 s plus ~0.3 s per word.
- Scene length: 2–5 s for social pacing, 4–8 s for explainers. Change *something* at least every ~2 s (a new element, a camera push, a highlight) — QA flags 4 s with nothing moving.
- With narration, the voice is the clock: land each visual change on its word (`vo.cue`) or ~0.15 s before it.

## Layout and hierarchy

- **One focal point per frame.** Biggest, brightest, highest-contrast thing = what matters now. Dim or shrink the rest.
- **Type scale:** use the theme sizes (`--size-hero/title/body/label`). Never below `--size-small` — phones.
- **Safe areas:** keep text inside 5% margins (16:9). For 9:16, keep key text out of the top ~11%, bottom ~20% and right ~13% (platform UI). `render.mjs stills --debug` draws the guides.
- **Grid:** align to a few consistent edges; generous negative space reads as confidence.
- **Contrast:** text ≥ 4.5:1 against what's behind it (`contrast(a, b)` in mv.js). Over busy textures, put text on a solid shape.

## Motion

- **Ease everything.** Linear motion looks mechanical. Entrances: `outCubic`/`outQuart`/`outBack` (decelerate into place). Exits: `inCubic` (accelerate away). Moves between two positions: `inOutCubic`/`inOutSine`.
- **Durations:** small UI moves 0.25–0.4 s; elements entering 0.4–0.7 s; big scene moves 0.8–1.2 s; transitions 0.4–0.8 s.
- **Stagger** related items by 0.05–0.15 s — the eye reads the order.
- **Overlap actions:** start the next element before the previous one fully stops (~30% overlap). Sequential-and-stopped feels like a slideshow.
- **Anticipation & overshoot** (`ease.anticipate`, `ease.outBack`, `ease.spring`) give weight; use them on hero elements, not on everything.
- **Secondary motion keeps holds alive:** a slow 3–6% push-in, gentle `wiggle`, boiling lines, drifting particles — subtle, under 2% of the frame per second.
- **Exits matter:** clear elements before the cut (`s.at(-0.5, -0.1)`) or hand them off with a transition; don't let a scene end mid-entrance.
- **Match cuts** (an element morphs or carries across scenes) beat generic transitions; use the style's default transition otherwise, not a different one per scene.

## Color

- Stick to the theme palette: 1 background, 1 ink, 1 accent for "look here", 2–3 supporting colors. One accent per frame.
- Use color to encode meaning consistently (e.g. the Moon is always blue, the force always gold).

## Sound

- Music bed under everything (quiet: the voice must win — the renderer ducks it automatically).
- An effect on every important visual event: whoosh on transitions, pop/click on elements landing, riser into a reveal, impact on the payoff. Silence is also a tool — drop the bed for one beat before the payoff.

## The storyboard

Seven-ish beats for 30 s. Each panel is the scene's settled frame with a label ("2 · The Moon pulls") and a note ("bulge forms on the near side, arrow draws in"). The user should be able to approve the video from the storyboard alone — if a panel needs explaining, redesign it.

## Prompting yourself (what a good brief contains)

Length and type ("a 30-second animated explainer about…"), aspect ratio, style, soundtrack (procedural / voice file / music file), "render to MP4 with Playwright and ffmpeg", "time the visuals to the narration", and "before calling it done, pull a contact sheet, find what's wrong, re-render, repeat." This skill does all of these; when a user's request is vague, these are the gaps to fill at intake.
