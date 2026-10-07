/*!
 * mv.js — the make-video motion runtime (MIT).
 *
 * A video is a pure function of time: render(t) → one picture. This module
 * gives compositions a timeline (scenes, layers, transitions), deterministic
 * motion helpers (easing, interpolation, seeded noise), text helpers, a live
 * preview player, and the window.__MV__ protocol the headless renderer drives.
 *
 * The one rule: every frame must be computable from `t` alone. Set every
 * animated property on every frame, never depend on the previous frame, and
 * use the seeded rng()/noise() helpers instead of Math.random(). The renderer
 * draws frames out of order across parallel workers, and its determinism
 * check will flag frames that leak state.
 */

export const VERSION = '1.0.0';

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
/** True when the headless renderer is driving the page (no preview UI). */
export const isRender = params.has('render') || (typeof window !== 'undefined' && !!window.__MV_RENDER__);
const debugParam = params.has('debug');

// ─────────────────────────────────────────────────────────────── math ──

export const TAU = Math.PI * 2;
export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, p) => a + (b - a) * p;
export const invLerp = (a, b, x) => (a === b ? (x >= b ? 1 : 0) : (x - a) / (b - a));
export const fract = (x) => x - Math.floor(x);
export const mod = (a, n) => ((a % n) + n) % n;
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
/** Bounce a value back and forth over [0, len]. */
export const pingpong = (x, len = 1) => {
  const m = mod(x, 2 * len);
  return m > len ? 2 * len - m : m;
};
/** Map x from [a,b] to [c,d], clamped, with optional easing. */
export function remap(x, a, b, c, d, easing) {
  const p = clamp(invLerp(a, b, x));
  return lerp(c, d, easing ? easing(p) : p);
}
/** 0→1 progress of t through [start, end], clamped, optionally eased. */
export function progress(t, start, end, easing) {
  const p = clamp(invLerp(start, end, t));
  return easing ? easing(p) : p;
}
export function smoothstep(a, b, x) {
  const p = clamp(invLerp(a, b, x));
  return p * p * (3 - 2 * p);
}
/** Quantize time to a lower frame rate — `stepTime(t, 12)` gives a stop-motion "on twos" feel. */
export const stepTime = (t, fps) => Math.floor(t * fps + 1e-6) / fps;
/** Start time of item i in a stagger: start + i * each. */
export const stagger = (i, each, start = 0) => start + i * each;
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

// ───────────────────────────────────────────────────────────── easing ──

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = TAU / 3;
const c5 = TAU / 4.5;

function outBounce(x) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

/** CSS-style cubic-bezier easing: bezier(0.2, 0, 0, 1). */
export function bezier(x1, y1, x2, y2) {
  const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  const dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(u) - x;
      if (Math.abs(err) < 1e-6) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0, hi = 1;
    u = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/**
 * Damped spring as an easing over normalized time (settles by p = 1).
 * bounce 0 = critically damped (no overshoot), 0.5 = lively, 0.8 = wobbly.
 */
export function springEase({ bounce = 0.3 } = {}) {
  const zeta = clamp(1 - bounce, 0.05, 1);
  const w = 6.9 / zeta;
  const wd = w * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    if (zeta >= 0.999) return 1 - (1 + w * p) * Math.exp(-w * p);
    return 1 - Math.exp(-zeta * w * p) * (Math.cos(wd * p) + ((zeta * w) / wd) * Math.sin(wd * p));
  };
}

/**
 * Physical spring in real seconds (no fixed end): value 0 → 1 with overshoot.
 * spring(t - start, { stiffness: 170, damping: 14 })
 */
export function spring(t, { stiffness = 170, damping = 18, mass = 1, velocity = 0 } = {}) {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const v0 = -velocity;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * w0 * t);
    return 1 - e * (Math.cos(wd * t) + ((zeta * w0 - v0) / wd) * Math.sin(wd * t));
  }
  const e = Math.exp(-w0 * t);
  return 1 - e * (1 + (w0 - v0) * t);
}

export const ease = {
  linear: (x) => x,
  inSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
  outSine: (x) => Math.sin((x * Math.PI) / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inQuart: (x) => x * x * x * x,
  outQuart: (x) => 1 - Math.pow(1 - x, 4),
  inOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  inQuint: (x) => x * x * x * x * x,
  outQuint: (x) => 1 - Math.pow(1 - x, 5),
  inOutQuint: (x) => (x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2),
  inExpo: (x) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
  outExpo: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inOutExpo: (x) =>
    x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2,
  inCirc: (x) => 1 - Math.sqrt(1 - x * x),
  outCirc: (x) => Math.sqrt(1 - Math.pow(x - 1, 2)),
  inOutCirc: (x) =>
    x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2,
  inBack: (x) => c3 * x * x * x - c1 * x * x,
  outBack: (x) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2),
  inOutBack: (x) =>
    x < 0.5
      ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
      : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
  inElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4)),
  outElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
  inOutElastic: (x) =>
    x === 0
      ? 0
      : x === 1
        ? 1
        : x < 0.5
          ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
          : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
  inBounce: (x) => 1 - outBounce(1 - x),
  outBounce,
  inOutBounce: (x) => (x < 0.5 ? (1 - outBounce(1 - 2 * x)) / 2 : (1 + outBounce(2 * x - 1)) / 2),
  // Curated motion-design curves.
  smooth: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  snappy: bezier(0.16, 1, 0.3, 1),
  standard: bezier(0.2, 0, 0, 1),
  anticipate: bezier(0.68, -0.4, 0.27, 1.4),
  // Factories.
  bezier,
  spring: springEase,
  /** outBack with a custom overshoot amount (default 1.70158). */
  back: (s = c1) => (x) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
  /** Stepped easing: steps(4) → 0, .25, .5, .75, 1. */
  steps: (n) => (x) => (x >= 1 ? 1 : Math.floor(x * n) / n),
  /** Run an easing backwards in time: reverse(ease.outCubic)(p). */
  reverse: (fn) => (x) => 1 - fn(1 - x),
  /** Mirror an in-easing into an in-out: inOut(ease.inExpo). */
  inOut: (fn) => (x) => (x < 0.5 ? fn(2 * x) / 2 : 1 - fn(2 - 2 * x) / 2),
};

// ────────────────────────────────────────────────────────────── color ──

let colorCtx = null;
const colorCache = new Map();

/** Parse any CSS color into [r, g, b, a] (0-255, alpha 0-1). */
export function parseColor(c) {
  if (Array.isArray(c)) return [c[0], c[1], c[2], c[3] ?? 1];
  if (colorCache.has(c)) return colorCache.get(c);
  let out = null;
  const m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (m) {
    let hex = m[1];
    if (hex.length <= 4) hex = [...hex].map((ch) => ch + ch).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    out = [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  } else {
    colorCtx ||= document.createElement('canvas').getContext('2d');
    colorCtx.fillStyle = '#000';
    colorCtx.fillStyle = c;
    const v = colorCtx.fillStyle;
    if (v[0] === '#') {
      const n = parseInt(v.slice(1), 16);
      out = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    } else {
      const p = v.match(/[\d.]+/g).map(Number);
      out = [p[0], p[1], p[2], p[3] ?? 1];
    }
  }
  colorCache.set(c, out);
  return out;
}

const toLin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (c) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255), 0, 255);
};
function rgbToOklab([r, g, b]) {
  const lr = toLin(r), lg = toLin(g), lb = toLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToRgb([L, A, B]) {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
const rgba = (r, g, b, a = 1) =>
  a >= 1 ? `rgb(${r | 0}, ${g | 0}, ${b | 0})` : `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${+a.toFixed(4)})`;

/** Blend two CSS colors in OKLab (perceptually even). Returns an rgb()/rgba() string. */
export function mixColor(a, b, p) {
  const ca = parseColor(a), cb = parseColor(b);
  const la = rgbToOklab(ca), lb = rgbToOklab(cb);
  const [r, g, bl] = oklabToRgb([lerp(la[0], lb[0], p), lerp(la[1], lb[1], p), lerp(la[2], lb[2], p)]);
  return rgba(r, g, bl, lerp(ca[3], cb[3], p));
}
/** Same color with a new alpha. */
export function alpha(c, a) {
  const [r, g, b] = parseColor(c);
  return rgba(r, g, b, a);
}
/** Lighten (+) or darken (−) in OKLab lightness; amount ≈ −1…1. */
export function shade(c, amount) {
  const col = parseColor(c);
  const [L, A, B] = rgbToOklab(col);
  const [r, g, b] = oklabToRgb([clamp(L + amount * 0.5, 0, 1), A, B]);
  return rgba(r, g, b, col[3]);
}
/**
 * A version of `fg` that reads on `bg`: keeps the hue, shifts lightness until
 * the WCAG contrast is at least `min` (4.5 body text, 3 for very large type).
 */
export function readable(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg;
  const lb = rgbToOklab(parseColor(bg))[0];
  const dir = lb > 0.6 ? -1 : 1;
  let c = fg;
  for (let i = 1; i <= 20 && contrast(c, bg) < min; i++) c = shade(fg, dir * i * 0.08);
  return contrast(c, bg) >= min ? c : lb > 0.6 ? '#111111' : '#f5f5f5';
}
/** WCAG contrast ratio between two opaque colors. */
export function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = parseColor(c);
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// ────────────────────────────────────────────────────── interpolation ──

const COLOR_RE = /^(#|rgb|hsl|oklab|oklch|lab|lch|color\()/i;

/** Interpolate numbers, colors, arrays or flat objects. */
export function mix(a, b, p) {
  if (typeof a === 'number') return a + (b - a) * p;
  if (typeof a === 'string' && COLOR_RE.test(a.trim())) return mixColor(a, b, p);
  if (Array.isArray(a)) return a.map((v, i) => mix(v, b[i], p));
  if (a && typeof a === 'object') {
    const o = {};
    for (const k in a) o[k] = k in b ? mix(a[k], b[k], p) : a[k];
    return o;
  }
  return p < 1 ? a : b;
}

/** Value at time t of a tween from→to over [t0, t1]. */
export function tween(t, t0, t1, from, to, easing = ease.inOutCubic) {
  return mix(from, to, easing(clamp(invLerp(t0, t1, t))));
}

/**
 * Keyframes: keys(t, [[0, 0], [1, 100, ease.outBack], [2.5, 40]]).
 * Each key is [time, value, easing?]; a key's easing shapes the segment that
 * leaves it (CSS semantics). Values can be numbers, colors, arrays or objects.
 */
export function keys(t, frames, defaultEase = ease.inOutCubic) {
  if (!frames.length) return undefined;
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 0; i < frames.length - 1; i++) {
    const [ta, va, ea] = frames[i];
    const [tb, vb] = frames[i + 1];
    if (t < tb) return mix(va, vb, (ea || defaultEase)(clamp(invLerp(ta, tb, t))));
  }
  return frames[frames.length - 1][1];
}

// ─────────────────────────────────────────────────── random & noise ──

/** 32-bit FNV-1a hash of a string. */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic float in [0, 1) from any numbers: hash(i, frame, 7). */
export function hash(...ns) {
  let h = 0x9e3779b9;
  for (const n of ns) {
    h ^= Math.imul((n * 1000003) | 0, 0x85ebca6b) ^ ((n * 1e6) | 0);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

/** Seeded PRNG (mulberry32). rng('scene-1').range(-10, 10) */
export function rng(seed = 1) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    float: next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p = 0.5) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    gauss: (mean = 0, sd = 1) => mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(TAU * next()),
    shuffle: (arr) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return r;
}

const PERM = new Uint8Array(512);
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
/** Reseed the global noise() field. */
export function noiseSeed(seed = 1) {
  const r = rng(seed);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
noiseSeed(1);

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** 3D gradient (Perlin) noise in roughly [-1, 1]. */
export function noise(x, y = 0, z = 0) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const g = (h, dx, dy, dz) => {
    const gr = GRAD3[h % 12];
    return gr[0] * dx + gr[1] * dy + gr[2] * dz;
  };
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  return lerp(
    lerp(
      lerp(g(PERM[AA], x, y, z), g(PERM[BA], x - 1, y, z), u),
      lerp(g(PERM[AB], x, y - 1, z), g(PERM[BB], x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(g(PERM[AA + 1], x, y, z - 1), g(PERM[BA + 1], x - 1, y, z - 1), u),
      lerp(g(PERM[AB + 1], x, y - 1, z - 1), g(PERM[BB + 1], x - 1, y - 1, z - 1), u),
      v,
    ),
    w,
  );
}
/** Fractal noise: several octaves of noise() summed. */
export function fbm(x, y = 0, z = 0, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * f, y * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
/** Organic wiggle like After Effects' wiggle(): smooth noise of t in [-amp, amp]. */
export function wiggle(t, freq = 1, amp = 1, seed = 0) {
  return noise(t * freq, seed * 17.13 + 0.5, seed * 3.7) * amp * 1.4;
}

// ──────────────────────────────────────────────────────────────── DOM ──

export const $ = (sel, root = document) => (typeof sel === 'string' ? root.querySelector(sel) : sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function applyAttrs(el, attrs, isSvg) {
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'style') {
      if (typeof v === 'string') el.style.cssText = v;
      else css(el, v);
    } else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class' || k === 'className') el.setAttribute('class', v);
    else el.setAttribute(isSvg ? k : k, v === true ? '' : v);
  }
}
function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
/** Create an HTML element: h('div', { class: 'card', style: { x: 20 } }, 'Hello'). */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs, false);
  appendKids(el, kids);
  return el;
}
/** Create an SVG element: svg('path', { d: 'M0 0 L10 10', stroke: '#000' }). */
export function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyAttrs(el, attrs, true);
  appendKids(el, kids);
  return el;
}

const TRANSFORM_KEYS = new Set(['x', 'y', 'z', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY', 'skewX', 'skewY']);
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom', 'scale']);
const px = (v) => (typeof v === 'number' ? `${v}px` : v);

/**
 * Set styles in one call. Transform shorthands: x, y, z (px or string),
 * scale, scaleX, scaleY, rotate/rotateX/rotateY/skewX/skewY (degrees),
 * plus `blur` (px), `origin` (transform-origin) and any CSS property or --var.
 * Transform keys rebuild the whole transform, so pass them together.
 */
export function css(el, props) {
  el = $(el);
  if (!el) return el;
  const s = el.style;
  let tf = null;
  for (const k in props) {
    const v = props[k];
    if (TRANSFORM_KEYS.has(k)) (tf ||= {})[k] = v;
    else if (k === 'blur') s.filter = v ? `blur(${v}px)` : 'none';
    else if (k === 'origin') s.transformOrigin = v;
    else if (k.startsWith('--')) s.setProperty(k, String(v));
    else s[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v;
  }
  if (tf) {
    let out = '';
    // 2D unless z is used: 3D transforms promote the element to a compositor layer whose
    // raster scale Chrome reuses between frames, which makes pixels depend on render history.
    if (tf.z != null) out += `translate3d(${px(tf.x ?? 0)}, ${px(tf.y ?? 0)}, ${px(tf.z)}) `;
    else if (tf.x != null || tf.y != null) out += `translate(${px(tf.x ?? 0)}, ${px(tf.y ?? 0)}) `;
    if (tf.rotate != null) out += `rotate(${tf.rotate}deg) `;
    if (tf.rotateX != null) out += `rotateX(${tf.rotateX}deg) `;
    if (tf.rotateY != null) out += `rotateY(${tf.rotateY}deg) `;
    if (tf.skewX != null) out += `skewX(${tf.skewX}deg) `;
    if (tf.skewY != null) out += `skewY(${tf.skewY}deg) `;
    if (tf.scale != null) out += `scale(${tf.scale}) `;
    if (tf.scaleX != null || tf.scaleY != null) out += `scale(${tf.scaleX ?? 1}, ${tf.scaleY ?? 1}) `;
    s.transform = out.trim() || 'none';
  }
  return el;
}

/**
 * Split an element's text into inline-block word and char spans for per-letter
 * animation. Words never break internally. Returns { words, chars }.
 */
export function splitText(el) {
  el = $(el);
  if (el._mvSplit) return el._mvSplit;
  const text = el.textContent;
  el.textContent = '';
  const words = [], chars = [];
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      el.append(document.createTextNode(' '));
      continue;
    }
    const w = h('span', { class: 'mv-word', style: 'display:inline-block;white-space:nowrap' });
    for (const ch of part) {
      const c = h('span', { class: 'mv-char', style: 'display:inline-block' }, ch);
      w.append(c);
      chars.push(c);
    }
    el.append(w);
    words.push(w);
  }
  el._mvSplit = { words, chars };
  return el._mvSplit;
}

/**
 * Shrink an element's font-size until its text fits the box (call in build()).
 * fitText(el, { max: 140, min: 40 }) uses the element's own width/height unless
 * width/height are given.
 */
export function fitText(el, { max = 200, min = 12, width, height } = {}) {
  el = $(el);
  const W = width ?? el.clientWidth;
  const H = height ?? el.clientHeight;
  let lo = min, hi = max, best = min;
  for (let i = 0; i < 18 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = `${mid}px`;
    const fits = el.scrollWidth <= W + 0.5 && (!H || el.scrollHeight <= H + 0.5);
    if (fits) {
      best = mid;
      lo = mid;
    } else hi = mid;
  }
  el.style.fontSize = `${best}px`;
  return best;
}

/**
 * The line boxes of an element's text in frame pixels: [{ x, y, w, h }] top to
 * bottom (call in build, after fitText). Use it to size underlines to the last
 * line or to place highlight boxes behind words.
 */
export function textLines(el) {
  el = $(el);
  const stage = el.closest('[data-mv-stage]') || document.body;
  const sr = stage.getBoundingClientRect();
  const k = stage.offsetWidth ? sr.width / stage.offsetWidth : 1;
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const box = { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k };
    const line = lines.find((l) => Math.abs(l.y + l.h / 2 - (box.y + box.h / 2)) < Math.max(l.h, box.h) * 0.5);
    if (line) {
      const r2 = Math.max(line.x + line.w, box.x + box.w), b2 = Math.max(line.y + line.h, box.y + box.h);
      line.x = Math.min(line.x, box.x);
      line.y = Math.min(line.y, box.y);
      line.w = r2 - line.x;
      line.h = b2 - line.y;
    } else lines.push(box);
  }
  return lines.sort((a, b) => a.y - b.y);
}

/** Typewriter: show the first p (0-1) of `text`, with an optional blinking caret. */
export function typeOn(el, text, p, { caret = '', t = 0, blink = 2 } = {}) {
  el = $(el);
  const n = Math.round(clamp(p) * text.length);
  const on = caret && (p < 1 || Math.floor(t * blink * 2) % 2 === 0);
  el.textContent = text.slice(0, n) + (on ? caret : '');
  return el;
}

/** Format a counting number: countUp(p, 0, 1250, { decimals: 0, prefix: '$' }). */
export function countUp(p, from, to, { decimals = 0, prefix = '', suffix = '', locale = 'en-US' } = {}) {
  const v = lerp(from, to, clamp(p));
  return prefix + v.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
}

/** Draw an SVG stroke on: drawOn(pathEl, p). Works on path, line, circle, rect, polyline. */
export function drawOn(el, p, { reverse = false } = {}) {
  el = $(el);
  const len = (el._mvLen ??= el.getTotalLength ? el.getTotalLength() : 0);
  el.style.strokeDasharray = `${len} ${len}`;
  el.style.strokeDashoffset = `${(reverse ? -1 : 1) * len * (1 - clamp(p))}`;
  return el;
}

/** Sample points along an SVG path element (for motion paths): pointAt(path, 0.5) → {x, y, angle}. */
export function pointAt(el, p) {
  el = $(el);
  const len = (el._mvLen ??= el.getTotalLength());
  const d = clamp(p) * len;
  const a = el.getPointAtLength(d);
  const b = el.getPointAtLength(Math.min(len, d + 0.5));
  const c = el.getPointAtLength(Math.max(0, d - 0.5));
  return { x: a.x, y: a.y, angle: deg(Math.atan2(b.y - c.y, b.x - c.x)) };
}

// ────────────────────────────────────────────────────────────── media ──

/** Load and decode an image (await in setup/build). */
export async function loadImage(src) {
  const img = new Image();
  img.decoding = 'sync';
  img.src = src;
  await img.decode();
  return img;
}
/**
 * Fetch JSON relative to the page. With { optional: true } a missing file
 * resolves to null instead of throwing (and the renderer doesn't report it).
 */
export async function loadJSON(src, { optional = false } = {}) {
  const url = optional ? `${src}${src.includes('?') ? '&' : '?'}optional` : src;
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    if (optional) return null;
    throw e;
  }
  if (optional && (r.status === 204 || r.status === 404)) return null;
  if (!r.ok) throw new Error(`loadJSON(${src}): HTTP ${r.status}`);
  return r.json();
}

const norm = (w) =>
  String(w)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '');

/**
 * Narration timing helper. Load the words JSON written by scripts/tts.py or
 * scripts/align.py and sync visuals to the voice:
 *   const vo = await loadWords('assets/narration.words.json');
 *   vo.cue('electricity')        // start time (s) of the first occurrence
 *   vo.cue('a function of time') // phrase → start of its first word
 *   vo.cue('frames', 2)          // second occurrence
 *   vo.cueEnd('of time')         // end time of the phrase's last word
 *   vo.captionAt(t)              // { text, words, active, start, end } for captions
 */
export async function loadWords(src, opts = {}) {
  const data = await loadJSON(src, opts);
  return data ? narration(data, opts) : null;
}
export function narration(data, { offset = 0 } = {}) {
  const raw = data.words || data;
  const words = raw.map((w) => ({
    w: w.w ?? w.word ?? w.text,
    s: (w.s ?? w.start) + offset,
    e: (w.e ?? w.end) + offset,
  }));
  const tokens = words.map((w) => norm(w.w));
  const find = (phrase, n = 1) => {
    const q = String(phrase).split(/\s+/).map(norm).filter(Boolean);
    let seen = 0;
    for (let i = 0; i + q.length <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < q.length; j++) if (tokens[i + j] !== q[j]) { ok = false; break; }
      if (ok && ++seen === n) return [i, i + q.length - 1];
    }
    return null;
  };
  const miss = (phrase) => {
    const near = tokens.filter((tk) => tk && norm(phrase).slice(0, 3) && tk.startsWith(norm(phrase).slice(0, 3))).slice(0, 8);
    return new Error(`narration cue "${phrase}" not found${near.length ? ` (similar: ${near.join(', ')})` : ''}`);
  };
  let chunks = null;
  const vo = {
    words,
    duration: data.duration ?? (words.length ? words[words.length - 1].e : 0),
    has: (phrase, n = 1) => !!find(phrase, n),
    cue(phrase, n = 1) {
      const r = find(phrase, n);
      if (!r) throw miss(phrase);
      return words[r[0]].s;
    },
    cueEnd(phrase, n = 1) {
      const r = find(phrase, n);
      if (!r) throw miss(phrase);
      return words[r[1]].e;
    },
    wordAt(t) {
      for (let i = 0; i < words.length; i++) if (t >= words[i].s && t < words[i].e) return i;
      return -1;
    },
    /** Group words into caption chunks: break at sentence ends and pauses, then split long phrases evenly. */
    chunks({ maxWords = 6, maxChars = 32, pause = 0.45 } = {}) {
      const phrases = [];
      let cur = [];
      words.forEach((w, i) => {
        if (cur.length && w.s - words[cur[cur.length - 1]].e > pause) {
          phrases.push(cur);
          cur = [];
        }
        cur.push(i);
        if (/[.!?;:]$/.test(w.w) || (/,$/.test(w.w) && cur.length >= Math.max(3, maxWords >> 1))) {
          phrases.push(cur);
          cur = [];
        }
      });
      if (cur.length) phrases.push(cur);
      const out = [];
      for (const ph of phrases) {
        const chars = ph.reduce((n, j) => n + words[j].w.length + 1, -1);
        const n = Math.max(1, Math.ceil(ph.length / maxWords), Math.ceil(chars / maxChars));
        const size = Math.ceil(ph.length / n);
        for (let k = 0; k < ph.length; k += size) {
          const ids = ph.slice(k, k + size);
          out.push({ start: words[ids[0]].s, end: words[ids[ids.length - 1]].e, words: ids, text: ids.map((j) => words[j].w).join(' ') });
        }
      }
      return out;
    },
    /** Caption state at time t: { text, words: [{w, s, e, active, spoken}], start, end } or null. */
    captionAt(t, opts) {
      chunks ||= vo.chunks(opts);
      for (let k = 0; k < chunks.length; k++) {
        const c = chunks[k];
        const next = chunks[k + 1];
        const hold = next ? Math.min(next.start, c.end + 0.6) : c.end + 0.6;
        if (t >= c.start - 0.05 && t < hold) {
          return {
            ...c,
            index: k,
            words: c.words.map((i) => ({ ...words[i], active: t >= words[i].s && t < words[i].e, spoken: t >= words[i].s })),
          };
        }
      }
      return null;
    },
  };
  return vo;
}

const mediaPending = new Set();
/**
 * A seekable <video> layer. Headless Chromium can't decode H.264: convert clips
 * to WebM first (scripts/media.py clip in.mp4 assets/clip.webm). In render(t):
 *   return clip.seek(localT)   // render may be async; the frame waits for the seek
 */
export function videoClip(src, { loop = false, rate = 1 } = {}) {
  const v = h('video', { src, muted: true, playsinline: true, preload: 'auto' });
  v.muted = true;
  v.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover';
  const ready = new Promise((res, rej) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', () => rej(new Error(`videoClip: cannot load ${src} (use WebM/VP9 in headless Chromium)`)), { once: true });
  });
  mediaPending.add(ready);
  ready.catch(() => {});
  v.seek = async (time) => {
    await ready;
    let target = Math.max(0, time * rate);
    if (loop && v.duration) target %= v.duration;
    else if (v.duration) target = Math.min(target, v.duration - 0.001);
    if (Math.abs(v.currentTime - target) < 1e-4) return;
    await new Promise((res) => {
      v.addEventListener('seeked', res, { once: true });
      v.currentTime = target;
    });
    if (v.requestVideoFrameCallback) await new Promise((res) => { v.requestVideoFrameCallback(() => res()); setTimeout(res, 50); });
  };
  return v;
}

// ─────────────────────────────────────────────────────────── timeline ──

const EPS = 1e-6;

function normTransition(tr) {
  if (!tr) return { type: 'cut', duration: 0, ease: ease.inOutCubic };
  if (typeof tr === 'string') {
    const [type, dur] = tr.split(':');
    return { type, duration: type === 'cut' ? 0 : dur ? +dur : 0.6, ease: ease.inOutCubic };
  }
  return { type: tr.type || 'fade', duration: tr.type === 'cut' ? 0 : tr.duration ?? 0.6, ease: tr.ease || ease.inOutCubic, ...tr };
}

function resolveEl(spec, kind, name, stage) {
  if (spec instanceof Element) return spec;
  if (typeof spec === 'string') {
    const found = document.querySelector(spec);
    if (!found) throw new Error(`${kind} "${name}": element ${spec} not found`);
    return found;
  }
  const found = document.querySelector(`[data-${kind}="${CSS.escape(name)}"]`);
  return found || h('section');
}

/**
 * Register the composition. Pass a config object, or a (possibly async)
 * function returning one — handy when scene timing depends on loaded assets
 * such as narration word timings.
 *
 * Config: { width, height, fps, duration?, background, title,
 *           scenes: [{ name, duration | start, transition, build(el, s), render(t, s), canvas, beat, label, note }],
 *           layers: [{ name, start, end, under, build, render, canvas }],
 *           setup(stage), render(t, info), beats: [{ t, label, note }],
 *           audio(a) — procedural sound (see mv-audio.js), tracks: [{ src, at, gain, role }] }
 */
export function defineVideo(spec) {
  if (window.__MV__) throw new Error('defineVideo() was called twice');
  const mv = (window.__MV__ = { version: VERSION, error: null, config: null });
  const runtimeUrl = import.meta.url;
  let cfg = null;
  let stage = null;
  let clips = [];
  let debugEl = null;
  let showDebug = debugParam;
  let lastT = 0;

  const fail = (e) => {
    mv.error = String((e && e.stack) || e);
    console.error('[mv]', e);
    showErrorOverlay(mv.error);
    throw e;
  };

  function normalize(user) {
    const c = {
      width: 1920,
      height: 1080,
      fps: 30,
      background: '#000',
      title: document.title || 'video',
      scenes: [],
      layers: [],
      beats: [],
      tracks: [],
      ...user,
    };
    for (const k of ['width', 'height', 'fps']) {
      if (!(Number.isFinite(c[k]) && c[k] > 0)) throw new Error(`config.${k} must be a positive number (got ${c[k]})`);
    }
    c.width = Math.round(c.width);
    c.height = Math.round(c.height);

    // Sequence scenes: each starts when the previous ends, minus the
    // overlap its entering transition needs. Explicit `start` wins.
    const scenes = c.scenes.map((s, i) => ({ ...s, name: s.name || `scene-${i + 1}`, kind: 'scene', index: i, tr: normTransition(s.transition ?? c.transition) }));
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i], prev = scenes[i - 1];
      if (i === 0) s.tr = normTransition('cut');
      if (s.start == null) s.start = prev ? prev.end - s.tr.duration : 0;
      if (s.duration != null) s.end = s.start + s.duration;
      else {
        const next = scenes[i + 1];
        if (next && next.start != null) s.end = next.start + normTransition(next.transition ?? c.transition).duration;
        else if (!next && c.duration != null) s.end = c.duration;
        else throw new Error(`scene "${s.name}" needs a duration (or the next scene needs a start)`);
      }
      s.duration = s.end - s.start;
      if (s.duration <= 0) throw new Error(`scene "${s.name}" has non-positive duration`);
    }
    const sceneEnd = scenes.length ? Math.max(...scenes.map((s) => s.end)) : 0;
    c.duration ??= Math.max(sceneEnd, ...c.layers.map((l) => (l.end ?? 0)));
    if (!(c.duration > 0)) throw new Error('config.duration could not be determined — give scenes durations or set duration');
    const layers = c.layers.map((l, i) => ({ ...l, name: l.name || `layer-${i + 1}`, kind: 'layer', index: i, start: l.start ?? 0, end: l.end ?? c.duration, tr: normTransition('cut') }));
    for (const l of layers) l.duration = l.end - l.start;

    // Stacking: under-layers, then scenes (later on top), then over-layers.
    let zu = 1, zo = 100000;
    for (const l of layers) l.z = l.z ?? (l.under ? zu++ : zo++);
    scenes.forEach((s, i) => (s.z = 1000 + i));
    c._scenes = scenes;
    c._layers = layers;
    c.frames = Math.max(1, Math.round(c.duration * c.fps));
    if (!c.beats.length) {
      c.beats = scenes.map((s) => ({
        t: s.start + (s.beat ?? Math.min(s.duration * 0.65, Math.max(0, s.duration - 0.25))),
        label: s.label || s.name,
        note: s.note || '',
        scene: s.name,
      }));
    } else c.beats = c.beats.map((b, i) => ({ label: `beat ${i + 1}`, note: '', ...b }));
    return c;
  }

  function buildStage() {
    const base = h('style', {
      text: `
html, body { margin: 0; padding: 0; overflow: hidden; background: ${isRender ? 'transparent' : '#111'}; }
*, *::before, *::after { transition: none !important; caret-color: transparent; font-synthesis: none; }
#mv-stage { position: absolute; left: 0; top: 0; width: ${cfg.width}px; height: ${cfg.height}px; overflow: hidden;
  background: ${cfg.background}; transform-origin: 0 0; contain: strict; }
#mv-stage > .mv-clip, #mv-stage > [data-mv-clip] { position: absolute; left: 0; top: 0; width: ${cfg.width}px; height: ${cfg.height}px; overflow: hidden; visibility: hidden; }
.mv-clip > canvas.mv-canvas { position: absolute; left: 0; top: 0; width: ${cfg.width}px; height: ${cfg.height}px; }
`,
    });
    document.head.prepend(base);
    stage = document.getElementById('mv-stage') || h('div', { id: 'mv-stage' });
    if (!stage.isConnected) document.body.append(stage);
    stage.setAttribute('data-mv-stage', '');

    clips = [...cfg._layers.filter((l) => l.under), ...cfg._scenes, ...cfg._layers.filter((l) => !l.under)];
    for (const c of clips) {
      const el = resolveEl(c.el, c.kind, c.name, stage);
      el.classList.add('mv-clip');
      el.setAttribute('data-mv-clip', c.name);
      el._mvStart = c.start;
      el.style.zIndex = c.z;
      if (el.parentElement !== stage) stage.append(el);
      c.elem = el;
      c.visible = false;
      if (c.canvas) {
        const dpr = c.canvas.dpr ?? window.devicePixelRatio ?? 1;
        const cv = h('canvas', { class: 'mv-canvas', width: Math.round(cfg.width * dpr), height: Math.round(cfg.height * dpr) });
        el.prepend(cv);
        c.cv = cv;
        c.ctx2d = cv.getContext('2d');
        c.dpr = dpr;
        c.clear = c.canvas.clear !== false;
      }
      c.info = makeInfo(c);
    }
  }

  function makeInfo(c) {
    const info = {
      name: c.name,
      index: c.index,
      kind: c.kind,
      start: c.start,
      end: c.end,
      d: c.duration,
      duration: c.duration,
      el: c.elem,
      canvas: c.cv || null,
      ctx: c.ctx2d || null,
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
      total: cfg.duration,
      frames: cfg.frames,
      t: 0,
      T: 0,
      p: 0,
      frame: 0,
      in: 1,
      out: 0,
      /** Eased local progress between local times a and b (negative = from the end). */
      at(a, b, easing = ease.inOutCubic) {
        const A = a < 0 ? c.duration + a : a;
        const B = b < 0 ? c.duration + b : b;
        return easing(clamp(invLerp(A, B, info.t)));
      },
      $: (sel) => c.elem.querySelector(sel),
      $$: (sel) => Array.from(c.elem.querySelectorAll(sel)),
    };
    return info;
  }

  function resetTransitionStyle(el) {
    if (el._mvEdge) el._mvEdge.style.visibility = 'hidden';
    if (!el._mvTr) return;
    el.style.opacity = '';
    el.style.transform = '';
    el.style.clipPath = '';
    el.style.filter = '';
    el._mvTr = false;
  }

  function applyTransition(el, tr, p, entering) {
    const W = cfg.width, H = cfg.height;
    const e = tr.ease(clamp(p));
    el._mvTr = true;
    const type = tr.type;
    // Scenes are usually transparent over a shared backdrop, so the outgoing
    // scene leaves before the incoming one fully arrives — text never sits on text.
    const outGoing = clamp(e / 0.55);
    const inComing = clamp((e - 0.45) / 0.55);
    if (type === 'fade') el.style.opacity = entering ? inComing : 1 - outGoing;
    else if (type === 'crossfade') el.style.opacity = entering ? e : 1 - e;
    else if (type === 'fade-over') el.style.opacity = entering ? e : 1;
    else if (type === 'dip') {
      // Out over the first half, in over the second; the stage background shows between.
      el.style.opacity = entering ? clamp(e * 2 - 1) : clamp(1 - e * 2);
    } else if (type.startsWith('slide-') || type.startsWith('push-')) {
      const dir = type.split('-')[1];
      const [dx, dy] = { left: [-W, 0], right: [W, 0], up: [0, -H], down: [0, H] }[dir] || [-W, 0];
      // Content moves in direction `dir`; the entering scene arrives from the opposite side.
      const k = entering ? e - 1 : e;
      el.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    } else if (type.startsWith('cover-')) {
      const dir = type.split('-')[1];
      const [dx, dy] = { left: [-W, 0], right: [W, 0], up: [0, -H], down: [0, H] }[dir] || [-W, 0];
      if (entering) el.style.transform = `translate(${dx * (e - 1)}px, ${dy * (e - 1)}px)`;
      else {
        el.style.transform = `translate(${dx * e * 0.25}px, ${dy * e * 0.25}px)`;
        el.style.opacity = 1 - outGoing;
      }
    } else if (type.startsWith('wipe-')) {
      const dir = type.split('-')[1];
      const r = (1 - e) * 100, q = e * 100;
      // The incoming scene is revealed where the outgoing one is hidden, so they never overlap.
      const inClip = { right: `inset(0 ${r}% 0 0)`, left: `inset(0 0 0 ${r}%)`, down: `inset(0 0 ${r}% 0)`, up: `inset(${r}% 0 0 0)` };
      const outClip = { right: `inset(0 0 0 ${q}%)`, left: `inset(0 ${q}% 0 0)`, down: `inset(${q}% 0 0 0)`, up: `inset(0 0 ${q}% 0)` };
      el.style.clipPath = (entering ? inClip : outClip)[dir] || (entering ? inClip.right : outClip.right);
      if (entering && tr.edge) {
        // A colored bar riding the wipe front: { type: 'wipe-right', edge: '#ff48b0', edgeWidth: 24 }
        const bar = (el._mvEdge ||= h('div', { class: 'mv-wipe-edge', style: 'position:absolute;pointer-events:none' }));
        if (!bar.isConnected) stage.append(bar);
        const thick = tr.edgeWidth ?? Math.round(Math.min(W, H) * 0.025);
        const horiz = dir === 'right' || dir === 'left';
        const pos = horiz ? (dir === 'right' ? e * W : (1 - e) * W) : dir === 'down' ? e * H : (1 - e) * H;
        bar.style.cssText = `position:absolute;pointer-events:none;background:${tr.edge};z-index:${+el.style.zIndex + 1};visibility:${e > 0 && e < 1 ? 'visible' : 'hidden'};` +
          (horiz ? `top:0;height:${H}px;width:${thick}px;left:${pos - thick / 2}px` : `left:0;width:${W}px;height:${thick}px;top:${pos - thick / 2}px`);
      }
    } else if (type === 'iris') {
      if (entering) {
        const cx = tr.x ?? W / 2, cy = tr.y ?? H / 2;
        const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
        el.style.clipPath = `circle(${e * R}px at ${cx}px ${cy}px)`;
      } else el.style.opacity = 1 - clamp(e / 0.35);
    } else if (type === 'zoom') {
      if (entering) {
        el.style.opacity = inComing;
        el.style.transform = `scale(${lerp(tr.from ?? 1.12, 1, ease.outCubic(inComing))})`;
      } else {
        el.style.opacity = 1 - outGoing;
        el.style.transform = `scale(${lerp(1, tr.to ?? 0.92, ease.inCubic(outGoing))})`;
      }
    } else if (type === 'blur') {
      const k = entering ? inComing : outGoing;
      el.style.opacity = entering ? inComing : 1 - outGoing;
      el.style.filter = `blur(${(entering ? 1 - k : k) * (tr.amount ?? 24)}px)`;
    }
  }

  async function seek(tIn) {
    let t = +tIn;
    if (!Number.isFinite(t)) t = 0;
    t = clamp(t, 0, cfg.duration - 1e-4);
    lastT = t;
    const frame = Math.round(t * cfg.fps);
    const pending = [];
    const scenes = cfg._scenes;
    for (const c of clips) {
      const active = t >= c.start - EPS && t < c.end - EPS;
      if (!active) {
        if (c.visible) {
          c.elem.style.visibility = 'hidden';
          resetTransitionStyle(c.elem);
          c.visible = false;
        }
        continue;
      }
      if (!c.visible) {
        c.elem.style.visibility = 'visible';
        c.visible = true;
      }
      const info = c.info;
      info.T = t;
      info.t = t - c.start;
      info.p = clamp(info.t / c.duration);
      info.frame = frame;
      // Enter/exit progress from this scene's transition and the next one's.
      const next = c.kind === 'scene' ? scenes[c.index + 1] : null;
      const trIn = c.tr;
      info.in = trIn.duration > 0 ? clamp((t - c.start) / trIn.duration) : 1;
      info.out = next && next.tr.duration > 0 ? clamp((t - next.start) / next.tr.duration) : 0;
      resetTransitionStyle(c.elem);
      if (c.kind === 'scene') {
        if (info.in < 1 && trIn.duration > 0) applyTransition(c.elem, trIn, info.in, true);
        else if (info.out > 0) applyTransition(c.elem, next.tr, info.out, false);
      }
      if (c.ctx2d) {
        c.ctx2d.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
        if (c.clear) c.ctx2d.clearRect(0, 0, cfg.width, cfg.height);
      }
      if (c.render) {
        const r = c.render(info.t, info);
        if (r && typeof r.then === 'function') pending.push(r);
      }
    }
    if (cfg.render) {
      const r = cfg.render(t, { t, frame, fps: cfg.fps, width: cfg.width, height: cfg.height, stage, duration: cfg.duration });
      if (r && typeof r.then === 'function') pending.push(r);
    }
    seekAnimations(t);
    if (pending.length) await Promise.all(pending);
    if (showDebug) drawDebug(t, frame);
    return frame;
  }

  function seekAnimations(t) {
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      const target = a.effect && a.effect.target;
      const clipEl = target && target.closest && target.closest('[data-mv-clip]');
      const offset = clipEl ? clipEl._mvStart || 0 : 0;
      a.pause();
      a.currentTime = Math.max(0, t - offset) * 1000;
    }
  }

  // ── debug overlay (timecode + safe areas) ──
  function drawDebug(t, frame) {
    if (!debugEl) {
      const W = cfg.width, H = cfg.height;
      const vertical = H > W;
      const zones = vertical
        ? `<div style="position:absolute;left:0;right:0;top:0;height:${Math.round(H * 0.11)}px;background:rgba(255,0,80,.18)"></div>
           <div style="position:absolute;left:0;right:0;bottom:0;height:${Math.round(H * 0.2)}px;background:rgba(255,0,80,.18)"></div>
           <div style="position:absolute;right:0;top:${Math.round(H * 0.11)}px;bottom:${Math.round(H * 0.2)}px;width:${Math.round(W * 0.13)}px;background:rgba(255,0,80,.12)"></div>`
        : '';
      debugEl = h('div', {
        class: 'mv-debug',
        style: `position:absolute;inset:0;pointer-events:none;z-index:2147483000;font:600 ${Math.round(Math.min(W, H) / 40)}px/1.2 ui-monospace,Menlo,monospace;color:#fff`,
        html: `${zones}
          <div style="position:absolute;left:5%;top:5%;right:5%;bottom:5%;outline:2px dashed rgba(0,255,200,.55)"></div>
          <div style="position:absolute;left:10%;top:10%;right:10%;bottom:10%;outline:2px dashed rgba(255,220,0,.6)"></div>
          <div class="mv-debug-tc" style="position:absolute;left:12px;top:12px;padding:6px 10px;background:rgba(0,0,0,.7);border-radius:6px"></div>`,
      });
      stage.append(debugEl);
    }
    debugEl.style.display = showDebug ? '' : 'none';
    const active = clips.filter((c) => c.visible).map((c) => c.name).join(' + ');
    debugEl.querySelector('.mv-debug-tc').textContent = `${fmtTime(t)}  f${frame}  ${active}`;
  }

  // ── audio (procedural sound via OfflineAudioContext) ──
  async function renderAudioBuffer(sampleRate = 48000) {
    if (!cfg.audio) return null;
    const { createAudioKit } = await import(new URL('./mv-audio.js', runtimeUrl).href);
    const length = Math.ceil(cfg.duration * sampleRate);
    const ctx = new OfflineAudioContext(4, length, sampleRate);
    const kit = createAudioKit(ctx, {
      duration: cfg.duration,
      fps: cfg.fps,
      scenes: cfg._scenes.map((s) => ({ name: s.name, start: s.start, end: s.end, transition: s.tr.type, transitionDuration: s.tr.duration })),
      beats: cfg.beats.map((b) => ({ t: b.t, label: b.label })),
    });
    await cfg.audio(kit, ctx);
    return ctx.startRendering();
  }
  mv.renderAudio = async (sampleRate = 48000) => {
    const buf = await renderAudioBuffer(sampleRate);
    mv._audio = buf;
    if (!buf) return null;
    let peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
    return { channels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate, peak };
  };
  /** Interleaved little-endian float32 PCM for [start, start+count) frames, base64. */
  mv.audioChunk = (start, count) => {
    const buf = mv._audio;
    const n = Math.max(0, Math.min(count, buf.length - start));
    const chs = buf.numberOfChannels;
    const out = new Float32Array(n * chs);
    const data = Array.from({ length: chs }, (_, ch) => buf.getChannelData(ch));
    for (let i = 0; i < n; i++) for (let ch = 0; ch < chs; ch++) out[i * chs + ch] = data[ch][start + i];
    const bytes = new Uint8Array(out.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  // ── layout audit (used by the renderer's QA pass) ──
  mv.audit = () => auditFrame(stage, cfg, clips);

  mv.info = () => ({
    version: VERSION,
    title: cfg.title,
    width: cfg.width,
    height: cfg.height,
    fps: cfg.fps,
    duration: cfg.duration,
    frames: cfg.frames,
    background: cfg.background,
    hasAudio: !!cfg.audio,
    tracks: (cfg.tracks || []).map((tr) => ({ at: 0, gain: 1, role: 'music', ...tr })),
    scenes: cfg._scenes.map((s) => ({ name: s.name, start: s.start, end: s.end, transition: s.tr.type, transitionDuration: s.tr.duration, label: s.label || s.name, note: s.note || '' })),
    layers: cfg._layers.map((l) => ({ name: l.name, start: l.start, end: l.end, under: !!l.under })),
    beats: cfg.beats.map((b) => ({ t: b.t, label: b.label, note: b.note || '', scene: b.scene || sceneAt(b.t) })),
  });
  const sceneAt = (t) => {
    const s = cfg._scenes.filter((x) => t >= x.start && t < x.end).pop();
    return s ? s.name : '';
  };
  mv.seek = (t) => seek(t);
  mv.setDebug = (on) => {
    showDebug = !!on;
    if (debugEl) debugEl.style.display = showDebug ? '' : 'none';
    if (showDebug) drawDebug(lastT, Math.round(lastT * cfg.fps));
  };

  mv.ready = (async () => {
    try {
      if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
      const user = typeof spec === 'function' ? await spec() : spec;
      cfg = normalize(user);
      mv.config = cfg;
      buildStage();
      // Load every declared @font-face up front so text never renders in a fallback font.
      await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})));
      for (const c of clips) if (c.build) await c.build(c.elem, c.info);
      if (cfg.setup) await cfg.setup(stage);
      await Promise.all([...document.fonts].map((f) => (f.status === 'unloaded' ? f.load().catch(() => {}) : null)));
      await document.fonts.ready;
      await Promise.all(
        [...stage.querySelectorAll('img')].map((img) => (img.complete ? null : img.decode().catch(() => {}))),
      );
      if (mediaPending.size) await Promise.all(mediaPending);
      const hashT = /t=([\d.]+)/.exec(location.hash);
      await seek(hashT ? +hashT[1] : 0);
      if (!isRender) startPreview();
      return mv.info();
    } catch (e) {
      return fail(e);
    }
  })();
  mv.ready.catch(() => {});

  // ── preview player (only when a person opens the page) ──
  function startPreview() {
    const W = cfg.width, H = cfg.height;
    const bar = h('div', { class: 'mv-bar' });
    const style = h('style', {
      text: `
.mv-bar { position: fixed; left: 0; right: 0; bottom: 0; height: 64px; background: #0c0c0e; color: #eee; display: flex; align-items: center; gap: 12px; padding: 0 16px; font: 13px/1 system-ui, sans-serif; z-index: 2147483600; user-select: none; }
.mv-bar button { background: #26262b; color: #eee; border: 0; border-radius: 8px; height: 36px; min-width: 40px; padding: 0 10px; font: inherit; cursor: pointer; }
.mv-bar button:hover { background: #34343b; }
.mv-track { position: relative; flex: 1; height: 36px; cursor: pointer; }
.mv-track .seg { position: absolute; top: 12px; height: 12px; border-radius: 3px; background: #2e2e36; box-shadow: inset 0 0 0 1px #3c3c46; overflow: hidden; }
.mv-track .seg span { position: absolute; left: 6px; top: -1px; font-size: 10px; color: #9a9aa8; white-space: nowrap; }
.mv-track .beat { position: absolute; top: 6px; width: 2px; height: 24px; background: #ffb020; opacity: .7; }
.mv-track .head { position: absolute; top: 2px; width: 2px; height: 32px; background: #ff3b5c; }
.mv-time { font-variant-numeric: tabular-nums; min-width: 132px; }
#mv-stage { box-shadow: 0 10px 40px rgba(0,0,0,.6); }`,
    });
    document.head.append(style);
    const playBtn = h('button', { title: 'Play/pause (space)' }, '▶');
    const time = h('div', { class: 'mv-time' });
    const track = h('div', { class: 'mv-track' });
    const head = h('div', { class: 'head' });
    for (const s of cfg._scenes) {
      track.append(h('div', { class: 'seg', style: `left:${(s.start / cfg.duration) * 100}%;width:${(s.duration / cfg.duration) * 100}%` }, h('span', {}, s.name)));
    }
    for (const b of cfg.beats) track.append(h('div', { class: 'beat', title: b.label, style: `left:${(b.t / cfg.duration) * 100}%` }));
    track.append(head);
    const dbgBtn = h('button', { title: 'Safe areas + timecode (d)' }, 'guides');
    const muteBtn = h('button', { title: 'Mute (m)' }, cfg.audio || cfg.tracks.length ? 'sound on' : 'no audio');
    bar.append(playBtn, time, track, dbgBtn, muteBtn);
    document.body.append(bar);

    const fit = () => {
      const s = Math.min(innerWidth / W, (innerHeight - 64) / H);
      stage.style.transform = `translate(${(innerWidth - W * s) / 2}px, ${(innerHeight - 64 - H * s) / 2}px) scale(${s})`;
    };
    fit();
    addEventListener('resize', fit);

    let playing = false, t0 = lastT, clock0 = 0, busy = false, muted = false;
    let actx = null, procBuf = null, trackBufs = null, sources = [];
    const ui = () => {
      time.textContent = `${fmtTime(lastT)} / ${fmtTime(cfg.duration)}`;
      head.style.left = `${(lastT / cfg.duration) * 100}%`;
      playBtn.textContent = playing ? '❚❚' : '▶';
    };
    const stopAudio = () => {
      for (const s of sources) try { s.stop(); } catch {}
      sources = [];
    };
    const startAudio = async (at) => {
      if (muted || !(cfg.audio || cfg.tracks.length)) return;
      actx ||= new AudioContext({ sampleRate: 48000 });
      if (actx.state === 'suspended') await actx.resume();
      if (cfg.audio && !procBuf) procBuf = await renderAudioBuffer(48000);
      if (!trackBufs) {
        trackBufs = await Promise.all(
          (cfg.tracks || []).map(async (tr) => {
            try {
              const ab = await (await fetch(tr.src)).arrayBuffer();
              return { tr, buf: await actx.decodeAudioData(ab) };
            } catch {
              console.warn('[mv] preview cannot decode', tr.src);
              return null;
            }
          }),
        );
      }
      if (!playing) return;
      const now = actx.currentTime + 0.03;
      if (procBuf) {
        const src = actx.createBufferSource();
        src.buffer = procBuf;
        const split = actx.createChannelSplitter(4), merge = actx.createChannelMerger(2);
        src.connect(split);
        split.connect(merge, 0, 0); split.connect(merge, 1, 1); split.connect(merge, 2, 0); split.connect(merge, 3, 1);
        merge.connect(actx.destination);
        src.start(now, at);
        sources.push(src);
      }
      for (const item of trackBufs) {
        if (!item) continue;
        const { tr, buf } = item;
        const start = tr.at || 0;
        const offset = Math.max(0, at - start) + (tr.trim || 0);
        if (offset >= buf.duration) continue;
        const src = actx.createBufferSource();
        src.buffer = buf;
        const g = actx.createGain();
        g.gain.value = tr.gain ?? 1;
        src.connect(g).connect(actx.destination);
        src.start(now + Math.max(0, start - at), offset);
        sources.push(src);
      }
    };
    const play = () => {
      if (lastT >= cfg.duration - 1 / cfg.fps) lastT = 0;
      playing = true;
      t0 = lastT;
      clock0 = performance.now();
      startAudio(lastT);
      ui();
    };
    const pause = () => {
      playing = false;
      stopAudio();
      ui();
    };
    const goto = async (t) => {
      const was = playing;
      if (was) pause();
      await seek(clamp(t, 0, cfg.duration));
      ui();
      if (was) play();
    };
    const loop = async (now) => {
      requestAnimationFrame(loop);
      if (!playing || busy) return;
      let t = t0 + (now - clock0) / 1000;
      if (t >= cfg.duration) {
        stopAudio();
        t0 = 0;
        clock0 = now;
        t = 0;
        startAudio(0);
      }
      busy = true;
      try {
        await seek(t);
      } finally {
        busy = false;
      }
      ui();
    };
    requestAnimationFrame(loop);
    playBtn.onclick = () => (playing ? pause() : play());
    dbgBtn.onclick = () => mv.setDebug(!showDebug);
    muteBtn.onclick = () => {
      muted = !muted;
      muteBtn.textContent = muted ? 'muted' : 'sound on';
      if (muted) stopAudio();
      else if (playing) startAudio(lastT);
    };
    const scrub = (ev) => {
      const r = track.getBoundingClientRect();
      goto(clamp((ev.clientX - r.left) / r.width) * cfg.duration);
    };
    track.addEventListener('pointerdown', (ev) => {
      scrub(ev);
      const move = (e) => scrub(e);
      addEventListener('pointermove', move);
      addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true });
    });
    addEventListener('keydown', (e) => {
      const f = 1 / cfg.fps;
      if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
      else if (e.key === 'ArrowRight') goto(lastT + (e.shiftKey ? 1 : f));
      else if (e.key === 'ArrowLeft') goto(lastT - (e.shiftKey ? 1 : f));
      else if (e.key === 'Home') goto(0);
      else if (e.key === 'End') goto(cfg.duration);
      else if (e.key === 'd') mv.setDebug(!showDebug);
      else if (e.key === 'm') muteBtn.onclick();
    });
    ui();
  }

  return mv;
}

export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function showErrorOverlay(msg) {
  if (isRender) return;
  const box = h('pre', {
    style:
      'position:fixed;left:16px;right:16px;top:16px;max-height:80vh;overflow:auto;padding:16px;background:#2a0d12;color:#ffd7dc;border:1px solid #ff5a72;border-radius:8px;font:12px/1.5 ui-monospace,monospace;z-index:2147483647;white-space:pre-wrap',
  });
  box.textContent = `Composition error:\n${msg}`;
  (document.body || document.documentElement).append(box);
}

// ──────────────────────────────────────────────────────────────── audit ──

const glyphCache = new Map();
/** Non-ASCII characters of `text` that `family` doesn't contain (classic two-fallback width test). */
function missingGlyphs(family, text) {
  const out = [];
  const c = (missingGlyphs.ctx ||= document.createElement('canvas').getContext('2d'));
  for (const ch of new Set(text)) {
    if (ch.charCodeAt(0) < 128 || /\s/.test(ch)) continue;
    const key = `${family}|${ch}`;
    if (!glyphCache.has(key)) {
      c.font = `64px "${family}", monospace`;
      const a = c.measureText(ch).width;
      c.font = `64px "${family}", serif`;
      const b = c.measureText(ch).width;
      glyphCache.set(key, Math.abs(a - b) > 0.01);
    }
    if (glyphCache.get(key)) out.push(ch);
  }
  return out;
}

const fontAvail = new Map();
function fontAvailable(family) {
  if (fontAvail.has(family)) return fontAvail.get(family);
  const generic = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'emoji', 'math'];
  if (generic.includes(family)) return true;
  const c = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlliWW@#0123456789abc';
  let ok = false;
  for (const fb of ['monospace', 'serif', 'sans-serif']) {
    c.font = `72px ${fb}`;
    const base = c.measureText(sample).width;
    c.font = `72px "${family}", ${fb}`;
    if (Math.abs(c.measureText(sample).width - base) > 0.5) {
      ok = true;
      break;
    }
  }
  if (!ok && document.fonts.check(`16px "${family}"`)) {
    ok = [...document.fonts].some((f) => f.family.replace(/["']/g, '') === family && f.status === 'loaded');
  }
  fontAvail.set(family, ok);
  return ok;
}

const inkCache = new Map();
/** Fraction of the font's content box above/below the actual ink of `text` (canvas metrics). */
function inkInsets(cs, text) {
  const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontStretch}|${cs.fontFamily}|${text}`;
  if (inkCache.has(key)) return inkCache.get(key);
  const c = (inkInsets.ctx ||= document.createElement('canvas').getContext('2d'));
  c.font = `${cs.fontStyle} ${cs.fontWeight} 100px ${cs.fontFamily}`;
  const m = c.measureText(text || 'Hg');
  const fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
  let out = { top: 0, bottom: 0 };
  if (fa > 0 && fd >= 0 && Number.isFinite(m.actualBoundingBoxAscent)) {
    const total = fa + fd;
    out = { top: clamp((fa - m.actualBoundingBoxAscent) / total, 0, 0.6), bottom: clamp((fd - m.actualBoundingBoxDescent) / total, 0, 0.6) };
  }
  inkCache.set(key, out);
  return out;
}

/** Screen-reader-only text (1px clipped boxes, e.g. KaTeX's MathML) is not on screen. */
function visuallyHidden(el, stage) {
  for (let n = el; n && n !== stage; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.clip && cs.clip !== 'auto') return true;
    if (cs.overflow !== 'visible') {
      const r = n.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return true;
    }
  }
  return false;
}

function auditFrame(stage, cfg, clips) {
  const W = cfg.width, H = cfg.height;
  const sr = stage.getBoundingClientRect();
  const k = sr.width / W || 1;
  const toStage = (r) => ({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k });
  const issues = [];
  const texts = [];
  const effOpacity = (el) => {
    let o = 1;
    for (let n = el; n && n !== stage.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
      o *= +cs.opacity;
    }
    return o;
  };
  const describe = (el) => {
    const clip = el.closest('[data-mv-clip]');
    let sel = el.tagName.toLowerCase();
    if (el.id) sel += `#${el.id}`;
    else if (el.classList.length) sel += `.${[...el.classList].filter((c) => !c.startsWith('mv-')).slice(0, 2).join('.')}`;
    return { clip: clip ? clip.getAttribute('data-mv-clip') : '', selector: sel.replace(/\.$/, '') };
  };
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest('.mv-debug')) continue;
    const owner = el.closest('.mv-char') ? el.closest('.mv-word')?.parentElement || el : el.closest('.mv-word') ? el.closest('.mv-word').parentElement : el;
    if (seen.has(owner)) continue;
    if (visuallyHidden(owner, stage)) {
      seen.add(owner);
      continue;
    }
    seen.add(owner);
    const op = effOpacity(owner);
    if (op < 0.15) continue;
    // Split text: measure only the characters that are actually visible right now.
    const chars = owner.querySelectorAll('.mv-char');
    let rects;
    if (chars.length) {
      rects = [];
      for (const c of chars) {
        if (+getComputedStyle(c).opacity <= 0.15) continue;
        let r = c.getBoundingClientRect();
        const word = c.parentElement;
        if (word && getComputedStyle(word).overflow !== 'visible') {
          const wr = word.getBoundingClientRect();
          const x1 = Math.max(r.left, wr.left), y1 = Math.max(r.top, wr.top);
          const x2 = Math.min(r.right, wr.right), y2 = Math.min(r.bottom, wr.bottom);
          if (x2 - x1 < 0.5 || y2 - y1 < 0.5) continue;
          r = { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
        }
        rects.push(r);
      }
    } else {
      const range = document.createRange();
      range.selectNodeContents(owner);
      rects = [...range.getClientRects()];
    }
    rects = rects.filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const cs = getComputedStyle(owner);
    // Range rects cover the font's full content area; trim them to the glyphs' ink.
    const ink = inkInsets(cs, owner.textContent.trim().slice(0, 80));
    const xs = rects.map((r) => toStage(r)).map((r) => ({ x: r.x, w: r.w, y: r.y + r.h * ink.top, h: r.h * (1 - ink.top - ink.bottom) }));
    const box = {
      x: Math.min(...xs.map((r) => r.x)),
      y: Math.min(...xs.map((r) => r.y)),
      r: Math.max(...xs.map((r) => r.x + r.w)),
      b: Math.max(...xs.map((r) => r.y + r.h)),
    };
    const scale = owner.offsetWidth ? owner.getBoundingClientRect().width / k / owner.offsetWidth : 1;
    const text = owner.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    const fam = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    const clipEl = owner.closest('[data-mv-clip]');
    texts.push({ el: owner, box, text, opacity: op, size: parseFloat(cs.fontSize) * scale, family: fam, transitioning: !!(clipEl && clipEl._mvTr), ...describe(owner) });
  }
  const minSide = Math.min(W, H);
  const safeX = W * 0.05, safeY = H * 0.05;
  const vertical = H > W;
  for (const tx of texts) {
    const { box } = tx;
    const visible = box.r > 0 && box.b > 0 && box.x < W && box.y < H;
    if (!visible) continue;
    if (box.x < -1 || box.y < -1 || box.r > W + 1 || box.b > H + 1) {
      issues.push({ type: 'clipped', severity: 'error', text: tx.text, clip: tx.clip, selector: tx.selector, detail: `text runs off the frame (x ${box.x | 0}..${box.r | 0}, y ${box.y | 0}..${box.b | 0} of ${W}x${H})` });
    } else {
      let ancestor = tx.el.parentElement;
      while (ancestor && ancestor !== stage) {
        const cs = getComputedStyle(ancestor);
        if ((cs.overflow !== 'visible' || cs.overflowX !== 'visible') && !ancestor.hasAttribute('data-mv-clip')) {
          const ar = toStage(ancestor.getBoundingClientRect());
          // Glyph boxes include the font's full ascent/descent; allow that overhang vertically.
          const tolV = Math.max(2, tx.size * 0.3);
          if (box.x < ar.x - 2 || box.r > ar.x + ar.w + 2 || box.y < ar.y - tolV || box.b > ar.y + ar.h + tolV) {
            issues.push({ type: 'clipped', severity: 'error', text: tx.text, clip: tx.clip, selector: tx.selector, detail: `text is cut off by its overflow:hidden container ${describe(ancestor).selector}` });
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      const unsafe = vertical
        ? box.y < H * 0.11 || box.b > H * 0.8 || box.x < safeX || box.r > W - Math.max(safeX, W * 0.13)
        : box.x < safeX || box.y < safeY || box.r > W - safeX || box.b > H - safeY;
      if (unsafe) issues.push({ type: 'unsafe', severity: 'warn', text: tx.text, clip: tx.clip, selector: tx.selector, detail: vertical ? 'text sits under social-app UI zones (top 11%, bottom 20%, right 13%)' : 'text outside the 5% action-safe margin' });
    }
    if (tx.size < minSide * 0.022 && tx.opacity > 0.5) {
      issues.push({ type: 'tiny', severity: 'warn', text: tx.text, clip: tx.clip, selector: tx.selector, detail: `font renders at ~${tx.size.toFixed(0)}px; keep text ≥ ${Math.round(minSide * 0.022)}px for phone screens` });
    }
    if (tx.family && !fontAvailable(tx.family)) {
      issues.push({ type: 'font', severity: 'warn', text: tx.text, clip: tx.clip, selector: tx.selector, detail: `font "${tx.family}" is not available — falling back` });
    } else if (tx.family) {
      const missing = missingGlyphs(tx.family, tx.text);
      if (missing.length) issues.push({ type: 'glyph', severity: 'warn', text: tx.text, clip: tx.clip, selector: tx.selector, detail: `"${missing.join('')}" not in font "${tx.family}" — drawn with a fallback font; pick another character or draw it` });
    }
  }
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.opacity < 0.35 || b.opacity < 0.35) continue;
      // Scenes mid-transition are separated by the transition itself (clips, fades).
      if (a.clip !== b.clip && (a.transitioning || b.transitioning)) continue;
      const ix = Math.min(a.box.r, b.box.r) - Math.max(a.box.x, b.box.x);
      const iy = Math.min(a.box.b, b.box.b) - Math.max(a.box.y, b.box.y);
      if (ix <= 0 || iy <= 0) continue;
      const areaA = (a.box.r - a.box.x) * (a.box.b - a.box.y);
      const areaB = (b.box.r - b.box.x) * (b.box.b - b.box.y);
      const frac = (ix * iy) / Math.max(1, Math.min(areaA, areaB));
      if (frac > 0.12) {
        issues.push({ type: 'overlap', severity: 'warn', text: `${a.text} ⟷ ${b.text}`, clip: a.clip || b.clip, selector: `${a.selector} / ${b.selector}`, detail: `text boxes overlap ${(frac * 100).toFixed(0)}%` });
      }
    }
  }
  for (const img of stage.querySelectorAll('img')) {
    if (effOpacity(img) < 0.15) continue;
    if (img.complete && img.naturalWidth === 0) {
      issues.push({ type: 'image', severity: 'error', text: img.getAttribute('src') || '', ...describe(img), detail: 'image failed to load' });
    }
  }
  return {
    issues,
    texts: texts.map((tx) => ({ text: tx.text, clip: tx.clip, selector: tx.selector, box: [tx.box.x, tx.box.y, tx.box.r, tx.box.b].map((v) => Math.round(v)), opacity: +tx.opacity.toFixed(2) })),
  };
}
