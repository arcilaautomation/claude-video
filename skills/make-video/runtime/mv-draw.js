/*!
 * mv-draw.js — canvas helpers for make-video's style presets (MIT).
 *
 * Textures (paper, chalkboard, graph paper, film grain), hand-drawn lines,
 * hatching, cut-paper shapes, risograph overprint, isometric projection,
 * chalk strokes, glow strokes and a small original mascot. Every function is
 * deterministic: randomness comes from seeds, never Math.random(), and
 * "boiling" (hand-drawn jitter) is driven by time via boil(t).
 *
 * Coordinates are canvas CSS pixels (the runtime pre-scales clip canvases).
 */

import { rng, noise, fbm, clamp, lerp, hash, TAU, alpha, shade, mixColor } from './mv.js';

// ───────────────────────────────────────────────────────────── basics ──

export function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Seed offset that changes `rate` times per second — hand-drawn "line boil". */
export const boil = (t, rate = 8) => Math.floor(t * rate + 1e-6);

export function roundRect(ctx, x, y, w, h, r = 12) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function polyPath(ctx, pts, close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

/** Smooth closed/open curve through points (Catmull-Rom). */
export function smoothPath(ctx, pts, { closed = true, tension = 0.5 } = {}) {
  const n = pts.length;
  if (n < 3) return polyPath(ctx, pts, closed);
  const P = (i) => pts[closed ? (i + n) % n : clamp(i, 0, n - 1)];
  ctx.beginPath();
  ctx.moveTo(...P(0));
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const k = tension / 3;
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k,
      p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k,
      p2[0], p2[1],
    );
  }
  if (closed) ctx.closePath();
}

export const rectPoints = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
export function circlePoints(cx, cy, r, n = 64, ry = r) {
  return Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * TAU) * r, cy + Math.sin((i / n) * TAU) * ry]);
}
/** Organic closed blob outline. */
export function blobPoints(cx, cy, r, { seed = 1, n = 64, wobble = 0.12, freq = 1.6, t = 0, speed = 0.3 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    const k = 1 + wobble * noise(Math.cos(a) * freq + seed * 7.1, Math.sin(a) * freq + seed * 3.3, t * speed);
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k];
  });
}
export function starPoints(cx, cy, r1, r2, n = 5, rot = -Math.PI / 2) {
  return Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? r2 : r1;
    const a = rot + (i / (n * 2)) * TAU;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

/** Resample a polyline every `step` px. Returns points with cumulative length. */
export function resample(pts, step = 6, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [];
  let acc = 0;
  for (let i = 0; i < src.length - 1; i++) {
    const [x1, y1] = src[i], [x2, y2] = src[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < n; j++) {
      const f = j / n;
      out.push([lerp(x1, x2, f), lerp(y1, y2, f), acc + len * f]);
    }
    acc += len;
  }
  const last = src[src.length - 1];
  out.push([last[0], last[1], acc]);
  return out;
}
/** Keep the first fraction p of a polyline (for canvas draw-on). */
export function trimPath(pts, p) {
  if (p >= 1) return pts;
  const r = resample(pts, 3);
  const total = r[r.length - 1][2];
  const lim = total * clamp(p);
  return r.filter((q) => q[2] <= lim).map(([x, y]) => [x, y]);
}

// ─────────────────────────────────────────────────────────── textures ──

const cache = new Map();
const memo = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};

function lowResNoise(w, h, { scale = 0.004, seed = 1, octaves = 4, cell = 8 }) {
  const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1;
  const { canvas, ctx } = makeCanvas(gw, gh);
  const img = ctx.createImageData(gw, gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = fbm(x * cell * scale + seed * 13.1, y * cell * scale + seed * 7.7, seed, octaves);
      const c = clamp(128 + v * 255, 0, 255);
      const i = (y * gw + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function addGrain(ctx, w, h, amount, seed, mono = true) {
  if (amount <= 0) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const r = rng(seed);
  const a = amount * 255;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r.next() - 0.5) * a;
    if (mono) {
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    } else {
      d[i] += (r.next() - 0.5) * a;
      d[i + 1] += (r.next() - 0.5) * a;
      d[i + 2] += (r.next() - 0.5) * a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Paper texture (cached canvas): blotchy tone variation, fibers, grain, vignette.
 * ctx.drawImage(paper(W, H, { color: '#f1e9da' }), 0, 0)
 */
export function paper(w, h, { color = '#f2ebdd', blotch = 0.06, fibers = 0.05, grain = 0.045, vignette = 0.14, seed = 1 } = {}) {
  return memo(`paper|${w}|${h}|${color}|${blotch}|${fibers}|${grain}|${vignette}|${seed}`, () => {
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    if (blotch > 0) {
      ctx.save();
      ctx.globalAlpha = blotch;
      ctx.globalCompositeOperation = 'overlay';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(lowResNoise(w, h, { scale: 0.0025, seed, cell: 10 }), 0, 0, w, h);
      ctx.globalAlpha = blotch * 0.6;
      ctx.drawImage(lowResNoise(w, h, { scale: 0.012, seed: seed + 3, cell: 4 }), 0, 0, w, h);
      ctx.restore();
    }
    if (fibers > 0) {
      const r = rng(seed + 11);
      const n = Math.round((w * h) / 900);
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const x = r.range(0, w), y = r.range(0, h), a = r.range(0, TAU), l = r.range(4, 22);
        ctx.strokeStyle = r.chance(0.5) ? `rgba(255,255,255,${fibers * r.range(0.6, 1.4)})` : `rgba(70,50,30,${fibers * r.range(0.3, 0.9)})`;
        ctx.lineWidth = r.range(0.4, 1.1);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
        ctx.stroke();
      }
      ctx.restore();
    }
    addGrain(ctx, w, h, grain, seed + 5);
    if (vignette > 0) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(40,25,10,${vignette})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    return canvas;
  });
}

/** Chalkboard / slate texture (cached): smudges and ghosts of erased chalk. */
export function board(w, h, { color = '#1e2622', smudge = 0.09, ghosts = 0.05, grain = 0.05, vignette = 0.35, seed = 2 } = {}) {
  return memo(`board|${w}|${h}|${color}|${smudge}|${ghosts}|${grain}|${vignette}|${seed}`, () => {
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = smudge;
    ctx.drawImage(lowResNoise(w, h, { scale: 0.003, seed, cell: 12 }), 0, 0, w, h);
    ctx.restore();
    if (ghosts > 0) {
      const r = rng(seed + 9);
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 26; i++) {
        const x = r.range(0, w), y = r.range(0, h);
        ctx.strokeStyle = `rgba(230,235,225,${ghosts * r.range(0.3, 1)})`;
        ctx.lineWidth = r.range(20, 70);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + r.range(-200, 200), y + r.range(-60, 60), x + r.range(-200, 200), y + r.range(-60, 60), x + r.range(-320, 320), y + r.range(-40, 40));
        ctx.stroke();
      }
      ctx.restore();
    }
    addGrain(ctx, w, h, grain, seed + 1);
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return canvas;
  });
}

/** Graph / dot-grid paper (cached). */
export function gridPaper(w, h, { color = '#fbfaf5', line = '#d7e3ee', major = '#b9cfe2', spacing = 48, majorEvery = 5, dots = false, margin = null, grain = 0.03, seed = 3 } = {}) {
  return memo(`grid|${w}|${h}|${color}|${line}|${major}|${spacing}|${majorEvery}|${dots}|${margin}|${grain}`, () => {
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    const ox = (w % spacing) / 2, oy = (h % spacing) / 2;
    if (dots) {
      ctx.fillStyle = line;
      for (let y = oy; y <= h; y += spacing) for (let x = ox; x <= w; x += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, TAU);
        ctx.fill();
      }
    } else {
      for (let i = 0, x = ox; x <= w; x += spacing, i++) {
        ctx.strokeStyle = majorEvery && i % majorEvery === 0 ? major : line;
        ctx.lineWidth = majorEvery && i % majorEvery === 0 ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let i = 0, y = oy; y <= h; y += spacing, i++) {
        ctx.strokeStyle = majorEvery && i % majorEvery === 0 ? major : line;
        ctx.lineWidth = majorEvery && i % majorEvery === 0 ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
    if (margin) {
      ctx.strokeStyle = margin;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w * 0.09, 0);
      ctx.lineTo(w * 0.09, h);
      ctx.stroke();
    }
    addGrain(ctx, w, h, grain, seed);
    return canvas;
  });
}

/** Soft two-color gradient backdrop (cached). */
export function gradient(w, h, { from = '#eef2ff', to = '#dfe6ff', angle = 90, grain = 0.02, seed = 4 } = {}) {
  return memo(`grad|${w}|${h}|${from}|${to}|${angle}|${grain}`, () => {
    const { canvas, ctx } = makeCanvas(w, h);
    const a = (angle * Math.PI) / 180;
    const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) / 2;
    const g = ctx.createLinearGradient(cx - Math.cos(a) * R, cy - Math.sin(a) * R, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    addGrain(ctx, w, h, grain, seed);
    return canvas;
  });
}

/**
 * Animated film grain over the whole frame. Tiles are cached; the tile changes
 * `rate` times a second so the grain "lives" without per-frame noise cost.
 */
export function grain(ctx, w, h, t, { amount = 0.07, rate = 12, blend = 'overlay', size = 256, tiles = 6, seed = 9 } = {}) {
  const set = memo(`grain|${size}|${tiles}|${seed}`, () =>
    Array.from({ length: tiles }, (_, k) => {
      const { canvas, ctx: c } = makeCanvas(size, size);
      const img = c.createImageData(size, size);
      const r = rng(seed * 100 + k);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = r.next() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      c.putImageData(img, 0, 0);
      return canvas;
    }),
  );
  const tile = set[boil(t, rate) % tiles];
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = blend;
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ──────────────────────────────────────────────────── hand-drawn lines ──

function jitterLine(pts, { seed, rough, step = 8, freq = 0.012 }) {
  const r = resample(pts, step);
  const out = [];
  for (let i = 0; i < r.length; i++) {
    const [x, y, s] = r[i];
    const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = noise(s * freq + seed * 3.17, seed * 1.31) * rough * 3.2 + (hash(seed, i) - 0.5) * rough * 0.9;
    out.push([x + nx * off, y + ny * off, s]);
  }
  return out;
}

/**
 * Hand-drawn polyline: a couple of slightly different passes, optional taper
 * and draw-on progress.
 * sketch(ctx, pts, { color, width: 4, seed: boil(t), rough: 1, passes: 2, progress: p })
 */
export function sketch(ctx, pts, { color = '#222', width = 3, seed = 1, rough = 1, passes = 2, progress = 1, closed = false, taper = false, alpha: a = 1, cap = 'round' } = {}) {
  if (progress <= 0 || pts.length < 2) return;
  let path = closed ? [...pts, pts[0]] : pts;
  // A slight overshoot so closed shapes look drawn, not computed.
  if (closed && path.length > 2) {
    const [x0, y0] = path[1];
    path = [...path, [lerp(path[0][0], x0, 0.12), lerp(path[0][1], y0, 0.12)]];
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
  ctx.globalAlpha *= a;
  for (let pass = 0; pass < passes; pass++) {
    let jp = jitterLine(path, { seed: seed * 7 + pass * 101, rough });
    if (progress < 1) {
      const total = jp[jp.length - 1][2];
      jp = jp.filter((q) => q[2] <= total * progress);
      if (jp.length < 2) continue;
    }
    const total = jp[jp.length - 1][2] || 1;
    const lw = width * (pass ? 0.7 : 1);
    if (!taper) {
      ctx.lineWidth = lw;
      ctx.beginPath();
      jp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    } else {
      for (let i = 1; i < jp.length; i++) {
        const f = jp[i][2] / total;
        ctx.lineWidth = lw * (0.35 + 0.65 * Math.sin(Math.PI * clamp(f * 1.1)));
        ctx.beginPath();
        ctx.moveTo(jp[i - 1][0], jp[i - 1][1]);
        ctx.lineTo(jp[i][0], jp[i][1]);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
export function sketchLine(ctx, x1, y1, x2, y2, opts) {
  // A gentle bow makes straight lines read as hand-drawn.
  const bow = (opts && opts.bow) ?? 0.015;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const nx = -(y2 - y1) / (len || 1), ny = (x2 - x1) / (len || 1);
  const b = len * bow * (hash((opts && opts.seed) || 1, 3) - 0.3);
  sketch(ctx, [[x1, y1], [mx + nx * b, my + ny * b], [x2, y2]], opts);
}
export function sketchRect(ctx, x, y, w, h, opts = {}) {
  const o = 4 * (opts.rough ?? 1);
  const s = opts.seed ?? 1;
  const p = opts.progress ?? 1;
  const sides = [
    [[x - o * hash(s, 1), y], [x + w + o * hash(s, 2), y]],
    [[x + w, y - o * hash(s, 3)], [x + w, y + h + o * hash(s, 4)]],
    [[x + w + o * hash(s, 5), y + h], [x - o * hash(s, 6), y + h]],
    [[x, y + h + o * hash(s, 7)], [x, y - o * hash(s, 8)]],
  ];
  sides.forEach((sd, i) => {
    const sp = clamp(p * 4 - i);
    if (sp > 0) sketchLine(ctx, sd[0][0], sd[0][1], sd[1][0], sd[1][1], { ...opts, seed: s + i * 13, progress: sp });
  });
}
export function sketchCircle(ctx, cx, cy, r, opts = {}) {
  const ry = opts.ry ?? r;
  const s = opts.seed ?? 1;
  const n = 48;
  const start = hash(s, 9) * TAU;
  const sweep = TAU * 1.06;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const a = start + (i / n) * sweep;
    const k = 1 + (hash(s, i) - 0.5) * 0.02 * (opts.rough ?? 1);
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * ry * k];
  });
  sketch(ctx, pts, { ...opts, closed: false });
}
/** Hand-drawn arrow with a two-stroke head. `curve` bends the shaft. */
export function sketchArrow(ctx, x1, y1, x2, y2, opts = {}) {
  const { curve = 0.15, head = 22, progress = 1 } = opts;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
  const cx = mx + nx * len * curve, cy = my + ny * len * curve;
  const pts = Array.from({ length: 24 }, (_, i) => {
    const f = i / 23;
    return [(1 - f) * (1 - f) * x1 + 2 * (1 - f) * f * cx + f * f * x2, (1 - f) * (1 - f) * y1 + 2 * (1 - f) * f * cy + f * f * y2];
  });
  sketch(ctx, pts, { ...opts, progress: clamp(progress / 0.8) });
  const hp = clamp((progress - 0.8) / 0.2);
  if (hp > 0) {
    const ang = Math.atan2(y2 - cy, x2 - cx);
    for (const side of [-1, 1]) {
      const a = ang + Math.PI + side * 0.45;
      sketch(ctx, [[x2, y2], [x2 + Math.cos(a) * head, y2 + Math.sin(a) * head]], { ...opts, seed: (opts.seed ?? 1) + side * 5, progress: hp, passes: 1 });
    }
  }
}

/**
 * Hatch-fill a shape (polygon points or a path callback). Lines are clipped to
 * the shape; `gap` controls tone (smaller = darker); `cross` adds a 2nd layer.
 */
export function hatch(ctx, shape, { angle = -40, gap = 10, width = 1.6, color = '#1d1b19', seed = 1, rough = 0.5, cross = false, progress = 1, alpha: a = 1, bounds = null } = {}) {
  if (progress <= 0) return;
  ctx.save();
  if (typeof shape === 'function') shape(ctx);
  else polyPath(ctx, shape);
  ctx.clip();
  let bx, by, bw, bh;
  if (bounds) [bx, by, bw, bh] = bounds;
  else if (Array.isArray(shape)) {
    const xs = shape.map((q) => q[0]), ys = shape.map((q) => q[1]);
    bx = Math.min(...xs); by = Math.min(...ys); bw = Math.max(...xs) - bx; bh = Math.max(...ys) - by;
  } else {
    bx = 0; by = 0; bw = ctx.canvas.width; bh = ctx.canvas.height;
  }
  const layers = cross ? [angle, angle + 90] : [angle];
  layers.forEach((ang, li) => {
    const rad = (ang * Math.PI) / 180;
    const cx = bx + bw / 2, cy = by + bh / 2;
    const R = Math.hypot(bw, bh) / 2 + gap;
    const dx = Math.cos(rad), dy = Math.sin(rad), nx = -dy, ny = dx;
    const count = Math.ceil((2 * R) / gap);
    const shown = Math.floor(count * clamp(progress * (cross ? 2 : 1) - li));
    for (let i = 0; i < shown; i++) {
      const o = -R + i * gap + (hash(seed, i, li) - 0.5) * gap * 0.35;
      const sx = cx + nx * o - dx * R, sy = cy + ny * o - dy * R;
      const ex = cx + nx * o + dx * R, ey = cy + ny * o + dy * R;
      sketch(ctx, [[sx, sy], [ex, ey]], { color, width, seed: seed * 31 + i + li * 1000, rough, passes: 1, alpha: a });
    }
  });
  ctx.restore();
}

// ──────────────────────────────────────────────────────────── cut paper ──

/** Roughen polygon edges like scissor-cut paper. */
export function cutEdge(pts, { jag = 1.6, seed = 1, step = 10 } = {}) {
  return jitterLine([...pts, pts[0]], { seed, rough: jag, step, freq: 0.05 }).map(([x, y]) => [x, y]);
}

/**
 * Cut-paper shape: jagged edge, soft drop shadow, fiber texture, light edge.
 * paperShape(ctx, blobPoints(400, 300, 120), { color: '#e4572e', seed: 3 })
 */
export function paperShape(ctx, pts, { color = '#e4572e', seed = 1, jag = 1.4, shadow = 'rgba(45,30,15,.32)', blur = 16, dx = 5, dy = 9, texture = 0.08, smooth = false } = {}) {
  const edge = cutEdge(pts, { jag, seed });
  const path = () => (smooth ? smoothPath(ctx, edge) : polyPath(ctx, edge));
  ctx.save();
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = dx;
    ctx.shadowOffsetY = dy;
  }
  ctx.fillStyle = color;
  path();
  ctx.fill();
  ctx.restore();
  if (texture > 0) {
    const tex = memo(`fiber|${seed % 4}`, () => paper(256, 256, { color: '#808080', blotch: 0.25, fibers: 0.12, grain: 0.12, vignette: 0, seed: 40 + (seed % 4) }));
    ctx.save();
    path();
    ctx.clip();
    ctx.globalAlpha = texture * 2.2;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = ctx.createPattern(tex, 'repeat');
    ctx.fillRect(-10000, -10000, 20000, 20000);
    ctx.restore();
  }
  ctx.save();
  path();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

// ─────────────────────────────────────────────────────────── risograph ──

/** Standard riso ink colors. */
export const RISO = {
  pink: '#ff48b0', blue: '#0078bf', yellow: '#ffe800', teal: '#00838a', orange: '#ff6c2f',
  green: '#00a95c', purple: '#765ba7', red: '#ff665e', federal: '#3d5588', mint: '#82d8d5', black: '#1b1b1b',
};

/**
 * Print one ink layer: drawFn(layerCtx) draws shapes in the ink color, the
 * layer gets speckled grain, then it's multiplied onto ctx with a small
 * misregistration offset. Call once per ink, lightest first.
 */
export function risoLayer(ctx, ink, drawFn, { w = ctx.canvas.width, h = ctx.canvas.height, offset = [0, 0], grain: g = 0.35, seed = 1, t = 0, rate = 0, key = 0 } = {}) {
  const layer = memo(`riso-layer|${w}|${h}|${key}`, () => makeCanvas(w, h));
  const lc = layer.ctx;
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, w, h);
  lc.fillStyle = ink;
  lc.strokeStyle = ink;
  drawFn(lc);
  if (g > 0) {
    const frame = rate > 0 ? boil(t, rate) % 4 : 0;
    const speck = memo(`riso-speck|${seed}|${frame}`, () => {
      const { canvas, ctx: c } = makeCanvas(384, 384);
      const img = c.createImageData(384, 384);
      const r = rng(seed * 50 + frame);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = r.next();
        img.data[i + 3] = v < 0.5 ? (0.5 - v) * 2 * 255 : 0;
      }
      c.putImageData(img, 0, 0);
      return canvas;
    });
    lc.save();
    lc.globalCompositeOperation = 'destination-out';
    lc.globalAlpha = g;
    lc.fillStyle = lc.createPattern(speck, 'repeat');
    lc.fillRect(0, 0, w, h);
    lc.restore();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(layer.canvas, offset[0], offset[1]);
  ctx.restore();
}

/** Halftone dots whose radius follows value(u, v) ∈ [0,1] over a rectangle. */
export function halftone(ctx, x, y, w, h, { value = (u) => u, cell = 12, angle = 20, color = '#000', max = 0.62 } = {}) {
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const R = Math.hypot(w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = color;
  const cx = x + w / 2, cy = y + h / 2;
  for (let i = -R / cell; i <= R / cell; i++) {
    for (let j = -R / cell; j <= R / cell; j++) {
      const px = cx + (i * ca - j * sa) * cell, py = cy + (i * sa + j * ca) * cell;
      if (px < x - cell || px > x + w + cell || py < y - cell || py > y + h + cell) continue;
      const v = clamp(value((px - x) / w, (py - y) / h));
      const r = Math.sqrt(v) * cell * max;
      if (r < 0.3) continue;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────── isometric ──

/**
 * Isometric projector: const I = iso(960, 640, 60);
 * I.p(x, y, z) → [sx, sy]; I.box(ctx, x, y, z, w, d, h, { color });
 * Draw boxes back-to-front (sort by x + y, then z).
 */
export function iso(ox, oy, unit = 48) {
  const cx = Math.cos(Math.PI / 6) * unit, sy = Math.sin(Math.PI / 6) * unit;
  const p = (x, y, z = 0) => [ox + (x - y) * cx, oy + (x + y) * sy - z * unit];
  const face = (ctx, pts, fill, stroke, lw) => {
    polyPath(ctx, pts.map((q) => p(...q)));
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };
  return {
    p,
    unit,
    /** Box with lit top, mid left face, dark right face. */
    box(ctx, x, y, z, w, d, h, { color = '#818cf8', top, left, right, stroke = null, lineWidth = 2 } = {}) {
      const T = top || shade(color, 0.14), L = left || color, Rr = right || shade(color, -0.16);
      face(ctx, [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], L, stroke, lineWidth);
      face(ctx, [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], Rr, stroke, lineWidth);
      face(ctx, [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], T, stroke, lineWidth);
    },
    /** Flat tile on the ground plane. */
    tile(ctx, x, y, w, d, { color = '#c7d2fe', z = 0, stroke = null, lineWidth = 1 } = {}) {
      face(ctx, [[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]], color, stroke, lineWidth);
    },
    /** Ground grid lines. */
    grid(ctx, nx, ny, { color = 'rgba(80,90,160,.18)', lineWidth = 1, x0 = 0, y0 = 0 } = {}) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (let i = 0; i <= nx; i++) {
        ctx.moveTo(...p(x0 + i, y0));
        ctx.lineTo(...p(x0 + i, y0 + ny));
      }
      for (let j = 0; j <= ny; j++) {
        ctx.moveTo(...p(x0, y0 + j));
        ctx.lineTo(...p(x0 + nx, y0 + j));
      }
      ctx.stroke();
      ctx.restore();
    },
    /** Soft elliptical contact shadow under an object. */
    shadow(ctx, x, y, w, d, { color = 'rgba(30,30,80,.18)', blur = 18 } = {}) {
      ctx.save();
      ctx.filter = `blur(${blur}px)`;
      face(ctx, [[x, y, 0], [x + w, y, 0], [x + w, y + d, 0], [x, y + d, 0]], color);
      ctx.restore();
    },
  };
}

// ─────────────────────────────────────────────────────────────── chalk ──

/** Dusty chalk stroke along points (draw on with `progress`). */
export function chalk(ctx, pts, { color = '#f1efe6', width = 6, seed = 1, progress = 1, rough = 0.7, density = 0.9 } = {}) {
  if (progress <= 0) return;
  let path = trimPath(pts, progress);
  if (path.length < 2) return;
  const jp = jitterLine(path, { seed, rough, step: 2 });
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < jp.length; i++) {
    const [x, y] = jp[i];
    const k = hash(seed, i);
    if (k > density) continue;
    const n = 3;
    for (let j = 0; j < n; j++) {
      const ox = (hash(seed, i, j) - 0.5) * width, oy = (hash(seed + 1, i, j) - 0.5) * width;
      ctx.globalAlpha = 0.25 + 0.6 * hash(seed + 2, i, j);
      const s = 1 + hash(seed + 3, i, j) * width * 0.35;
      ctx.fillRect(x + ox - s / 2, y + oy - s / 2, s, s);
    }
  }
  ctx.restore();
}

/**
 * A CSS mask that breaks DOM text/shapes up like chalk or worn ink:
 * el.style.webkitMaskImage = el.style.maskImage = chalkMask(); (cached data URL)
 */
export function chalkMask({ amount = 0.35, seed = 21, size = 192 } = {}) {
  return memo(`chalkmask|${amount}|${seed}|${size}`, () => {
    const { canvas, ctx } = makeCanvas(size, size);
    const img = ctx.createImageData(size, size);
    const r = rng(seed);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = r.next();
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = v < amount ? Math.round(255 * (0.15 + 0.6 * (v / amount))) : 255;
    }
    ctx.putImageData(img, 0, 0);
    return `url(${canvas.toDataURL('image/png')})`;
  });
}

/** Clean neon/vector stroke with glow (dark explainer look). pathFn draws the path. */
export function glowStroke(ctx, pathFn, { color = '#5cc8ff', width = 5, glow = 18, alpha: a = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.lineWidth = width;
  pathFn(ctx);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = mixColor(color, '#ffffff', 0.45);
  ctx.lineWidth = Math.max(1, width * 0.4);
  pathFn(ctx);
  ctx.stroke();
  ctx.restore();
}

// ──────────────────────────────────────────────────────────── mascot ──

/**
 * "Pip" — a small original blob mascot rig for recurring-character videos.
 * buddy(ctx, x, y, 180, { t, color: '#ff7a59', look: [0.4, 0], talk: vo ? amp : 0 })
 * x, y is the ground point under the character. Blinks on its own schedule.
 */
export function buddy(ctx, x, y, size, { t = 0, color = '#ff7a59', ink = '#1d1b19', look = [0, 0], talk = 0, mood = 'happy', squash = 0, wave = 0, seed = 1, outline = true, cheeks = true } = {}) {
  const s = size / 200;
  const breathe = Math.sin(t * 2.4 + seed) * 0.015;
  const sx = 1 + squash * 0.18 - breathe, sy = 1 - squash * 0.18 + breathe;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * sx, s * sy);
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 70, 12, 0, 0, TAU);
  ctx.fill();
  // body
  const body = blobPoints(0, -95, 92, { seed: seed + 2, wobble: 0.05, t, speed: 0.6 });
  smoothPath(ctx, body);
  ctx.fillStyle = color;
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6;
    ctx.stroke();
  }
  // belly highlight
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.ellipse(-26, -128, 30, 20, -0.5, 0, TAU);
  ctx.fill();
  // waving arm
  if (wave > 0) {
    const a = -0.6 + Math.sin(t * 9) * 0.45 * wave;
    ctx.save();
    ctx.translate(78, -100);
    ctx.rotate(a);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(26, -18, 40, -46);
    ctx.stroke();
    ctx.restore();
  }
  // eyes (blink: ~every 3.2 s, 0.12 s long, schedule jittered by seed)
  const period = 3.2 + hash(seed) * 1.2;
  const ph = (t + hash(seed, 2) * period) % period;
  const blink = ph < 0.12 ? Math.sin((ph / 0.12) * Math.PI) : 0;
  const [lx, ly] = [clamp(look[0], -1, 1), clamp(look[1], -1, 1)];
  for (const ex of [-30, 30]) {
    ctx.save();
    ctx.translate(ex + lx * 8, -112 + ly * 6);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 21 * (1 - blink * 0.92), 0, 0, TAU);
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    if (blink < 0.6) {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.ellipse(lx * 6, ly * 7 + 2, 8, 10 * (1 - blink), 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(lx * 6 - 3, ly * 7 - 2, 2.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
  if (cheeks) {
    ctx.fillStyle = 'rgba(255,90,110,0.35)';
    for (const cx of [-54, 54]) {
      ctx.beginPath();
      ctx.ellipse(cx + lx * 6, -84, 12, 8, 0, 0, TAU);
      ctx.fill();
    }
  }
  // mouth: smile, or open when talking (talk ∈ [0,1])
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  const mx = lx * 7, my = -76 + ly * 4;
  if (talk > 0.05) {
    ctx.beginPath();
    ctx.ellipse(mx, my, 13, 4 + talk * 13, 0, 0, TAU);
    ctx.fill();
  } else {
    ctx.beginPath();
    if (mood === 'sad') ctx.arc(mx, my + 14, 14, Math.PI * 1.15, Math.PI * 1.85);
    else if (mood === 'surprised') ctx.ellipse(mx, my, 8, 10, 0, 0, TAU);
    else ctx.arc(mx, my - 8, 15, Math.PI * 0.18, Math.PI * 0.82);
    ctx.stroke();
  }
  ctx.restore();
}

/** Mouth openness from narration words at time t (for buddy's `talk`). */
export function talkAmount(vo, t, { rate = 11 } = {}) {
  if (!vo) return 0;
  const i = vo.wordAt(t);
  if (i < 0) return 0;
  const w = vo.words[i];
  const k = (t - w.s) / Math.max(0.05, w.e - w.s);
  return clamp(0.35 + 0.65 * Math.abs(Math.sin(k * Math.PI * Math.max(1, (w.e - w.s) * rate * 0.5))));
}

// ─────────────────────────────────────────────────────────────── text ──

/** Word-wrap text for canvas fillText. */
export function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Background for a theme's texture spec (cached canvas sized w×h). */
export function themeBackground(theme, w, h) {
  const tx = theme.texture || { kind: 'flat' };
  const pal = theme.palette;
  switch (tx.kind) {
    case 'paper':
      return paper(w, h, { color: tx.color || pal.bg, blotch: tx.blotch ?? 0.06, fibers: tx.fibers ?? 0.05, grain: tx.grain ?? 0.045, vignette: tx.vignette ?? 0.14, seed: tx.seed ?? 1 });
    case 'board':
      return board(w, h, { color: tx.color || pal.bg, smudge: tx.smudge ?? 0.09, ghosts: tx.ghosts ?? 0.05, grain: tx.grain ?? 0.05, vignette: tx.vignette ?? 0.35 });
    case 'grid':
      return gridPaper(w, h, { color: tx.color || pal.bg, line: tx.line, major: tx.major, spacing: tx.spacing ?? 48, majorEvery: tx.majorEvery ?? 5, dots: !!tx.dots, margin: tx.margin || null });
    case 'gradient':
      return gradient(w, h, { from: tx.from || pal.bg, to: tx.to || shade(pal.bg, -0.05), angle: tx.angle ?? 90, grain: tx.grain ?? 0.02 });
    default:
      return memo(`flat|${w}|${h}|${pal.bg}`, () => {
        const { canvas, ctx } = makeCanvas(w, h);
        ctx.fillStyle = pal.bg;
        ctx.fillRect(0, 0, w, h);
        return canvas;
      });
  }
}

// ────────────────────────────────────────────────────────── backdrops ──

/**
 * Animated, on-style backdrop for a theme: texture + a quiet motif in the
 * corners that never competes with centered text. Call from an `under` canvas
 * layer: render(t, s) { backdrop(s.ctx, theme, t, s.width, s.height) }.
 * opts: { intensity: 0..1 (motif strength), motif: false to draw texture only, seed }
 */
export function backdrop(ctx, theme, t, w, h, { intensity = 1, motif = true, seed = 1 } = {}) {
  ctx.drawImage(themeBackground(theme, w, h), 0, 0, w, h);
  if (!motif || intensity <= 0) return;
  const P = theme.palette;
  const C = P.colors;
  const u = Math.min(w, h);
  const kind = theme.key || Object.keys(THEME_KEYS).find((k) => THEME_KEYS[k] === theme.name) || '';
  ctx.save();
  ctx.globalAlpha = intensity;
  switch (kind) {
    case 'cut-paper': {
      // Low, overlapping paper hills frame the bottom edge; a small sun top-right.
      const ts = Math.floor(t * 12) / 12; // stop-motion: on twos
      const hills = [
        { x: 0.04, y: 1.13, r: 0.3, c: C[4], s: 3 },
        { x: 0.26, y: 1.19, r: 0.24, c: C[1], s: 5 },
        { x: 0.98, y: 1.12, r: 0.31, c: C[3], s: 7 },
        { x: 0.78, y: 1.2, r: 0.22, c: C[0], s: 9 },
      ];
      for (const hl of hills) {
        const bob = Math.sin(ts * 1.3 + hl.s) * u * 0.006;
        paperShape(ctx, blobPoints(hl.x * w, hl.y * h + bob, hl.r * u, { seed: hl.s, wobble: 0.07, n: 48 }), { color: hl.c, seed: hl.s, blur: 16, dy: 8 });
      }
      const sun = blobPoints(w * 0.9, h * 0.14 + Math.sin(ts * 2) * u * 0.005, u * 0.055, { seed: 11, wobble: 0.05, n: 40 });
      paperShape(ctx, sun, { color: C[1], seed: 11 });
      break;
    }
    case 'cross-hatch': {
      const sd = boil(t, theme.motion?.boil || 8);
      const cx = w * 0.88, cy = h * 0.18, r = u * 0.09;
      hatch(ctx, circlePoints(cx, cy, r, 40), { gap: 8, angle: -35, cross: true, color: P.ink, seed: sd, rough: 0.6, width: 1.2, alpha: 0.75 });
      sketchCircle(ctx, cx, cy, r, { color: P.ink, width: 2.4, seed: sd, rough: 0.8, passes: 2 });
      // An engraved hillock in the bottom-left corner.
      const hill = Array.from({ length: 33 }, (_, i) => {
        const a = Math.PI + (i / 32) * Math.PI;
        return [w * 0.02 + Math.cos(a) * u * 0.3 + u * 0.3, h + Math.sin(a) * u * 0.11];
      });
      hatch(ctx, hill, { gap: 7, angle: 30, color: P.ink, seed: sd + 9, rough: 0.5, width: 1.1, alpha: 0.55 });
      sketch(ctx, hill, { color: P.ink, width: 2, seed: sd + 4, rough: 0.7, passes: 2 });
      break;
    }
    case 'risograph': {
      const reg = theme.motion?.registration ?? 4;
      const k = boil(t, theme.motion?.registrationFps || 6);
      const off = (i) => [(hash(k, i) - 0.5) * reg * 2, (hash(k, i, 1) - 0.5) * reg * 2];
      const drawShapes = (lc, i) => {
        lc.beginPath();
        if (i === 0) lc.arc(w * 0.86, h * 0.22, u * 0.12, 0, TAU);
        else lc.arc(w * 0.06, h * 0.95, u * 0.1, 0, TAU);
        lc.fill();
        if (i === 1) halftone(lc, w * 0.62, h * 0.82, w * 0.34, h * 0.14, { value: (a) => a * 0.8, cell: 12, max: 0.5, color: lc.fillStyle });
      };
      risoLayer(ctx, C[1], (lc) => drawShapes(lc, 1), { w, h, offset: off(1), seed: 3, t, key: 1 });
      risoLayer(ctx, C[0], (lc) => drawShapes(lc, 0), { w, h, offset: off(0), seed: 5, t, key: 0 });
      grain(ctx, w, h, t, { amount: 0.025, rate: 4, blend: 'multiply' });
      break;
    }
    case 'sketchbook': {
      const sd = boil(t, theme.motion?.boil || 6);
      const star = starPoints(w * 0.89, h * 0.16, u * 0.075, u * 0.034);
      ctx.save();
      ctx.globalAlpha = 0.55;
      polyPath(ctx, star);
      ctx.fillStyle = C[0];
      ctx.fill();
      ctx.restore();
      sketch(ctx, star, { closed: true, color: P.ink, width: 3.5, seed: sd, rough: 0.9 });
      const sp = Array.from({ length: 70 }, (_, i) => {
        const a = i * 0.3;
        const r = 4 + i * u * 0.0013;
        return [w * 0.08 + Math.cos(a) * r, h * 0.86 + Math.sin(a) * r];
      });
      sketch(ctx, sp, { color: P.muted, width: 3, seed: sd + 3, rough: 0.5, passes: 1 });
      const sq = Array.from({ length: 36 }, (_, i) => [w * 0.7 + i * u * 0.0075, h * 0.91 + Math.sin(i * 0.8) * u * 0.016]);
      sketch(ctx, sq, { color: C[1], width: 4.5, seed: sd + 5, rough: 0.6, passes: 1 });
      break;
    }
    case 'isometric': {
      // One composed cluster in the bottom-right corner; the text column stays clear.
      const I = iso(w * 0.86, h * 0.8, u * 0.04);
      I.grid(ctx, 6, 6, { x0: -3, y0: -3, color: alpha(P.ink, 0.08) });
      const blocks = [
        [-2, -2, 1.6, C[0]], [-1, -2, 0.9, C[5] || C[0]], [-2, -1, 0.6, C[3]], [0, -1, 2.2, C[1]],
        [-1, 0, 0.8, C[4]], [1, 0, 1.2, C[2]], [0, 1, 0.5, C[3]], [1, 1, 0.9, C[0]],
      ];
      blocks.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
      for (const [bx, by, bh, col] of blocks) {
        const z = Math.max(0, Math.sin(t * 1.1 + bx * 0.9 + by * 1.7)) * 0.12;
        I.box(ctx, bx, by, z, 1, 1, bh, { color: col });
      }
      break;
    }
    case 'chalkboard': {
      const sd = theme.motion?.boil ? boil(t, theme.motion.boil) : 1;
      const x0 = w * 0.72, y0 = h * 0.92, ax = w * 0.22, ay = h * 0.17;
      ctx.globalAlpha = 0.5 * intensity;
      chalk(ctx, [[x0, y0], [x0 + ax, y0]], { color: P.ink, width: 4, seed: sd });
      chalk(ctx, [[x0, y0], [x0, y0 - ay]], { color: P.ink, width: 4, seed: sd + 1 });
      const wave = Array.from({ length: 50 }, (_, i) => [x0 + (i / 49) * ax, y0 - ay * 0.5 - Math.sin((i / 49) * TAU * 1.5 + t * 0.8) * ay * 0.3]);
      chalk(ctx, wave, { color: C[0], width: 4, seed: sd + 2 });
      chalk(ctx, circlePoints(w * 0.9, h * 0.15, u * 0.05, 40), { color: C[1], width: 4, seed: sd + 3 });
      break;
    }
    case 'kinetic-type': {
      ctx.strokeStyle = alpha(P.ink, 0.06);
      ctx.lineWidth = 1;
      const step = u / 12;
      ctx.beginPath();
      for (let x = (w % step) / 2; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = (h % step) / 2; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      grain(ctx, w, h, t, { amount: 0.06 });
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

const THEME_KEYS = {
  'cut-paper': 'Cut Paper', 'cross-hatch': 'Cross-Hatch', risograph: 'Risograph', sketchbook: 'Sketchbook',
  isometric: 'Isometric', chalkboard: 'Chalkboard', 'kinetic-type': 'Kinetic Type',
};
