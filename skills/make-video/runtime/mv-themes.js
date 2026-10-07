/*!
 * mv-themes.js — the seven make-video style presets as data (MIT).
 *
 * Each theme carries a palette, font stacks (vendored by new_project.py into
 * lib/fonts.css), a background texture spec for mv-draw's themeBackground(),
 * a motion language and a default procedural music bed. The matching style
 * guides live in references/styles/<name>.md.
 *
 *   import { themes, applyTheme } from './lib/mv-themes.js';
 *   const theme = applyTheme('cut-paper', { width: 1920, height: 1080 });
 *   // CSS can now use var(--bg), var(--ink), var(--accent), var(--c1)…,
 *   // var(--font-display), var(--font-body), var(--weight-display), var(--size-title)…
 */

export const themes = {
  'cut-paper': {
    name: 'Cut Paper',
    summary: 'Layered construction-paper shapes with soft shadows, kraft texture and a stop-motion step.',
    palette: {
      bg: '#e9dcc4', ink: '#2d2219', accent: '#d2491f', muted: '#8a7763',
      colors: ['#e4572e', '#f2a541', '#283d63', '#7fb7d4', '#9bbf85', '#f2b5a7', '#fbf4e6'],
    },
    fonts: { display: "'Fraunces', Georgia, serif", body: "'DM Sans', system-ui, sans-serif", hand: "'Caveat', cursive", mono: "'JetBrains Mono', ui-monospace, monospace" },
    weights: { display: 800, body: 500 },
    texture: { kind: 'paper', color: '#e9dcc4', blotch: 0.12, fibers: 0.09, grain: 0.06, vignette: 0.22 },
    motion: { ease: 'outBack', stepFps: 12, wobble: 0.8, transition: 'slide-left:0.6' },
    music: { chords: ['Fmaj7', 'Dm7', 'Bbmaj7', 'C6'], every: 4, bpm: 92, arp: true, drums: false },
  },
  'cross-hatch': {
    name: 'Cross-Hatch',
    summary: 'Ink-on-ivory engraving: hatched shading, boiling hand-drawn lines, serif type, one red accent.',
    palette: {
      bg: '#f3eee0', ink: '#1c1a17', accent: '#b8322a', muted: '#8f8778',
      colors: ['#1c1a17', '#b8322a', '#2f4a6d', '#a39b8b', '#d9cfb8'],
    },
    fonts: { display: "'Instrument Serif', 'EB Garamond', Georgia, serif", body: "'EB Garamond', Georgia, serif", hand: "'Caveat', cursive", mono: "'JetBrains Mono', ui-monospace, monospace" },
    weights: { display: 400, body: 500 },
    texture: { kind: 'paper', color: '#f3eee0', blotch: 0.05, fibers: 0.03, grain: 0.05, vignette: 0.12 },
    motion: { ease: 'inOutSine', boil: 8, transition: 'dip:0.8' },
    music: { chords: ['Am7', 'Fmaj7', 'Cmaj7', 'G6'], every: 5, bpm: 76, arp: true, drums: false },
  },
  risograph: {
    name: 'Risograph',
    summary: 'Two or three fluorescent spot inks overprinted (multiply) with grain and misregistration; zine type.',
    palette: {
      bg: '#f6f0e1', ink: '#3d5588', accent: '#ff48b0', muted: '#9a93a8',
      colors: ['#ff48b0', '#0078bf', '#ffe800', '#00838a', '#ff6c2f', '#3d5588'],
    },
    fonts: { display: "'Archivo', 'Arial Narrow', sans-serif", body: "'Space Mono', ui-monospace, monospace", hand: "'Caveat', cursive", mono: "'Space Mono', ui-monospace, monospace" },
    weights: { display: 900, body: 400 },
    texture: { kind: 'paper', color: '#f6f0e1', blotch: 0.04, fibers: 0.02, grain: 0.06, vignette: 0.05 },
    motion: { ease: 'snappy', registration: 4, registrationFps: 6, transition: { type: 'wipe-right', duration: 0.55, edge: '#ff48b0' } },
    music: { chords: ['Dm9', 'G7', 'Cmaj7', 'Am7'], every: 4, bpm: 88, arp: false, drums: true },
  },
  sketchbook: {
    name: 'Sketchbook',
    summary: 'Ballpoint and marker on graph paper: drawn-on lines, highlighter swipes, handwritten labels.',
    palette: {
      bg: '#fbfaf5', ink: '#25303b', accent: '#ff6b9a', muted: '#8a94a6',
      colors: ['#ffd23f', '#ff6b9a', '#3ccf91', '#4aa3ff', '#25303b'],
    },
    fonts: { display: "'Permanent Marker', 'Caveat', cursive", body: "'Patrick Hand', 'Caveat', cursive", hand: "'Caveat', cursive", mono: "'JetBrains Mono', ui-monospace, monospace" },
    weights: { display: 400, body: 400 },
    texture: { kind: 'grid', color: '#fbfaf5', line: '#dde8f2', major: '#c6d7e8', spacing: 44, majorEvery: 5 },
    motion: { ease: 'outCubic', boil: 6, transition: 'slide-up:0.6' },
    music: { chords: ['C', 'G', 'Am', 'F'], every: 2.4, bpm: 100, arp: true, drums: false },
  },
  isometric: {
    name: 'Isometric',
    summary: 'Clean 30° isometric blocks in soft pastels with three-tone shading, grids and gentle camera moves.',
    palette: {
      bg: '#eef1ff', ink: '#1e2140', accent: '#d9468a', muted: '#7b80a8',
      colors: ['#6c74f0', '#9b7bf2', '#f27fb2', '#4fd1a5', '#f8b84e', '#58b6f2'],
    },
    fonts: { display: "'Space Grotesk', 'Inter', sans-serif", body: "'Inter', system-ui, sans-serif", hand: "'Caveat', cursive", mono: "'JetBrains Mono', ui-monospace, monospace" },
    weights: { display: 700, body: 500 },
    texture: { kind: 'gradient', from: '#f1f3ff', to: '#dce2fb', angle: 100, grain: 0.02 },
    motion: { ease: 'outBack', stagger: 0.06, transition: 'zoom:0.7' },
    music: { chords: ['Ebmaj7', 'Cm7', 'Abmaj7', 'Bb6'], every: 4, bpm: 96, arp: true, drums: false },
  },
  chalkboard: {
    name: 'Chalkboard',
    summary: 'Dark board, chalk-white and pastel strokes, written-on equations and diagrams — the math-explainer look. Set texture to flat for a clean vector variant.',
    palette: {
      bg: '#1d2521', ink: '#eeece3', accent: '#ffd166', muted: '#8d9a92',
      colors: ['#7cc6fe', '#ffd166', '#ff8fa3', '#8fe388', '#ffa45b', '#eeece3'],
    },
    fonts: { display: "'Cabin Sketch', 'Patrick Hand', cursive", body: "'Patrick Hand', 'Caveat', cursive", hand: "'Caveat', cursive", mono: "'JetBrains Mono', ui-monospace, monospace", math: "'EB Garamond', Georgia, serif" },
    weights: { display: 700, body: 400 },
    texture: { kind: 'board', color: '#1d2521', smudge: 0.09, ghosts: 0.05, grain: 0.05, vignette: 0.38 },
    motion: { ease: 'inOutSine', boil: 0, transition: 'fade:0.8' },
    music: { chords: ['Am9', 'Fmaj7', 'Cmaj7', 'Em7'], every: 5, bpm: 72, arp: false, drums: false },
  },
  'kinetic-type': {
    name: 'Kinetic Type',
    summary: 'Huge condensed type cut to the beat: masks, slams, stretches, two-color flips and a single hot accent.',
    palette: {
      bg: '#0b0b0c', ink: '#f2f0ea', accent: '#ff4d1f', muted: '#6d6a64',
      colors: ['#ff4d1f', '#d7ff3b', '#f2f0ea', '#0b0b0c', '#3a3a3d'],
    },
    fonts: { display: "'Anton', 'Archivo', Impact, sans-serif", body: "'Inter', system-ui, sans-serif", hand: "'Permanent Marker', cursive", mono: "'JetBrains Mono', ui-monospace, monospace" },
    weights: { display: 400, body: 600 },
    texture: { kind: 'flat', grain: 0.05 },
    motion: { ease: 'outExpo', bpm: 120, transition: 'cut' },
    music: { chords: ['Am', 'F', 'C', 'G'], every: 2, bpm: 120, arp: true, drums: true },
  },
};

for (const [key, t] of Object.entries(themes)) t.key = key;

export const themeNames = Object.keys(themes);

/** Look up a theme by name (throws with the list of valid names). */
export function getTheme(name) {
  const t = themes[name];
  if (!t) throw new Error(`unknown theme "${name}" — choose one of: ${themeNames.join(', ')}`);
  return t;
}

/**
 * Apply a theme's palette, fonts and a type scale as CSS variables on :root.
 * Returns the theme. Type sizes scale with the shorter side of the frame.
 */
export function applyTheme(nameOrTheme, { width = 1920, height = 1080, root = document.documentElement } = {}) {
  const theme = typeof nameOrTheme === 'string' ? getTheme(nameOrTheme) : nameOrTheme;
  const p = theme.palette;
  const s = root.style;
  s.setProperty('--bg', p.bg);
  s.setProperty('--ink', p.ink);
  s.setProperty('--accent', p.accent);
  s.setProperty('--muted', p.muted);
  p.colors.forEach((c, i) => s.setProperty(`--c${i + 1}`, c));
  for (const [k, v] of Object.entries(theme.fonts)) s.setProperty(`--font-${k}`, v);
  const w = theme.weights || { display: 800, body: 500 };
  s.setProperty('--weight-display', String(w.display));
  s.setProperty('--weight-body', String(w.body));
  const u = Math.min(width, height);
  const scale = { hero: 0.15, title: 0.09, subtitle: 0.06, body: 0.045, label: 0.036, small: 0.028 };
  for (const [k, v] of Object.entries(scale)) s.setProperty(`--size-${k}`, `${Math.round(u * v)}px`);
  s.setProperty('--pad', `${Math.round(u * 0.08)}px`);
  s.setProperty('--pad-x', `${Math.round(Math.max(width * 0.075, u * 0.08))}px`);
  s.setProperty('--pad-y', `${Math.round(Math.max(height * 0.08, u * 0.06))}px`);
  return theme;
}
