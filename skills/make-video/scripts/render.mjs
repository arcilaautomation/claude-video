#!/usr/bin/env node
/**
 * render.mjs — render a make-video composition with headless Chromium + ffmpeg.
 *
 *   node render.mjs [command] <project-dir> [options]
 *
 * Commands
 *   video       (default) render the MP4, then a contact sheet + QA report
 *   storyboard  render each beat as a still + a numbered storyboard sheet
 *   stills      render PNG stills (--at 1.5,3,4.2; default: the beats)
 *   sheet       quick contact sheet sampled across the timeline (no video)
 *   audit       layout audit (clipped/overlapping/tiny text) + determinism check
 *   audio       render just the mixed soundtrack to WAV
 *   info        print the composition timeline as JSON
 *   serve       live preview server with a scrubber (open the printed URL)
 *   doctor      check node / playwright / chromium / ffmpeg
 *
 * Common options
 *   --out PATH        output file (video/audio/sheet) or directory (stills/storyboard)
 *   --draft           fast preview: half resolution, JPEG frames, quick encode
 *   --scale F         render scale (0.5 = half size, 2 = 4K from a 1080p comp)
 *   --fps N           override the composition's fps
 *   --from T --to T   render only part of the timeline (seconds or MM:SS)
 *   --workers N       parallel browser workers (default: min(6, CPU count))
 *   --format F        mp4 (default) | mov (ProRes 4444 with alpha) | gif
 *   --crf N --preset P  x264 quality (default 18 / medium; draft 28 / veryfast)
 *   --frames png      lossless PNG frame transport (default JPEG q95 — ~1.5x faster, visually identical)
 *   --lufs N          loudness target (default -14)
 *   --no-audio --no-sheet --no-qa --debug (draw safe-area guides) --json
 *
 * Every frame is rendered by seeking the page to t = frame / fps and taking a
 * screenshot, so frames can be drawn in any order — that's what lets several
 * browser workers render contiguous chunks in parallel, each piping into its
 * own ffmpeg segment encoder, before the segments are concatenated.
 */

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const RUNTIME_DIR = path.join(SKILL_DIR, 'runtime');
const COMMANDS = new Set(['video', 'storyboard', 'stills', 'sheet', 'audit', 'audio', 'info', 'serve', 'doctor']);
const RANDOM_SEED = 1337;

// ───────────────────────────────────────────────────────────── cli ──

function parseTime(v) {
  if (v == null || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map(parseFloat);
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`bad time "${v}" (use seconds, MM:SS or HH:MM:SS)`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseArgs(argv) {
  const opts = { _: [] };
  const flags = new Set(['draft', 'no-audio', 'no-sheet', 'no-qa', 'debug', 'json', 'quiet', 'alpha', 'open', 'keep-temp']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (flags.has(k)) opts[k] = inline === undefined ? true : inline !== 'false';
      else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        opts[k] = v;
      }
    } else opts._.push(a);
  }
  let command = 'video';
  if (opts._.length && COMMANDS.has(opts._[0])) command = opts._.shift();
  opts.command = command;
  opts.project = opts._[0];
  return opts;
}

const log = (...a) => console.error('[render]', ...a);
const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'video';
const hhmm = (sec) => (sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`);

// ──────────────────────────────────────────────── dependency lookup ──

function depsHome() {
  if (process.env.MAKE_VIDEO_HOME) return process.env.MAKE_VIDEO_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'make-video');
  return path.join(os.homedir(), '.cache', 'make-video');
}

function npmGlobalRoot() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function loadPlaywright(projectDir) {
  const bases = [depsHome(), projectDir, SKILL_DIR].filter(Boolean);
  const tried = [];
  const attempt = (base) => {
    for (const name of ['playwright-core', 'playwright']) {
      try {
        const req = createRequire(path.join(base, '__resolve__.js'));
        const mod = req(name);
        if (mod && mod.chromium) return { mod, name, from: path.dirname(req.resolve(`${name}/package.json`)) };
      } catch (e) {
        tried.push(`${name} from ${base}`);
      }
    }
    return null;
  };
  for (const b of bases) {
    const r = attempt(b);
    if (r) return r;
  }
  const g = npmGlobalRoot();
  if (g) {
    const r = attempt(g);
    if (r) return r;
  }
  const err = new Error(
    'Playwright is not installed. Run the setup once:\n' +
      `  python3 "${path.join(SKILL_DIR, 'scripts', 'setup.py')}"\n` +
      `(it installs playwright-core + fonts into ${depsHome()} and downloads Chromium)`,
  );
  err.code = 'NO_PLAYWRIGHT';
  throw err;
}

function chromiumCandidates() {
  const out = [];
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter((p) => p && p !== '0');
  const rels = [
    ['chrome-linux', 'headless_shell'], ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-linux', 'chrome'], ['chrome-linux64', 'chrome'],
    ['chrome-mac', 'headless_shell'], ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'], ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win', 'headless_shell.exe'], ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-win', 'chrome.exe'], ['chrome-win64', 'chrome.exe'],
  ];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d));
    } catch {
      continue;
    }
    dirs.sort((a, b) => +b.split('-').pop() - +a.split('-').pop() || (a.includes('headless') ? -1 : 1));
    for (const d of dirs) for (const rel of rels) {
      const p = path.join(root, d, ...rel);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  const system = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of system) if (fs.existsSync(p)) out.push(p);
  return [...new Set(out)];
}

const CHROME_ARGS = [
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-dev-shm-usage',
];

async function launchBrowser(pw, opts) {
  const tries = [];
  const explicit = opts.chromium || process.env.MAKE_VIDEO_CHROMIUM;
  if (explicit) tries.push({ executablePath: explicit });
  tries.push({});
  for (const p of chromiumCandidates()) tries.push({ executablePath: p });
  tries.push({ channel: 'chrome' });
  const errors = [];
  for (const extra of tries) {
    try {
      const browser = await pw.mod.chromium.launch({ headless: true, args: CHROME_ARGS, ...extra });
      return { browser, how: extra.executablePath || extra.channel || 'playwright-managed' };
    } catch (e) {
      errors.push(`${extra.executablePath || extra.channel || 'default'}: ${String(e.message).split('\n')[0]}`);
    }
  }
  const err = new Error(
    'Could not launch Chromium. Install it once with:\n' +
      `  python3 "${path.join(SKILL_DIR, 'scripts', 'setup.py')}"\n` +
      'or point MAKE_VIDEO_CHROMIUM at a Chrome/Chromium binary.\nAttempts:\n  ' +
      errors.slice(0, 6).join('\n  '),
  );
  err.code = 'NO_CHROMIUM';
  throw err;
}

function hasBinary(name) {
  const r = spawnSync(name, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0] : null;
}

// ─────────────────────────────────────────────────── static server ──

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function startServer(root, { port = 0, host = '127.0.0.1', onMissing } = {}) {
  const rootAbs = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      let base = rootAbs;
      if (rel.startsWith('/__mv/')) {
        base = RUNTIME_DIR;
        rel = rel.slice(5);
      } else if (rel.startsWith('/__out/')) {
        base = path.join(rootAbs, 'out');
        rel = rel.slice(6);
      }
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(base, `.${rel}`);
      if (file !== base && !file.startsWith(base + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile()) {
        // loadJSON(src, { optional: true }) asks with ?optional — absence is expected, not an error.
        if (new URL(req.url, 'http://local').searchParams.has('optional')) {
          res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
          return;
        }
        if (onMissing && !rel.endsWith('favicon.ico')) onMissing(rel);
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        let start = range[1] ? +range[1] : st.size - +range[2];
        let end = range[1] && range[2] ? +range[2] : st.size - 1;
        start = Math.max(0, start);
        end = Math.min(end, st.size - 1);
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file).pipe(res);
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

// ───────────────────────────────────────────────── composition pages ──

class CompositionError extends Error {}

async function openPage(browser, baseUrl, { width = 1920, height = 1080, scale = 1, debug = false, alpha = false, timeout = 60000, problems }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'light' });
  await context.addInitScript((seed) => {
    // Same Math.random sequence in every worker so frames agree across chunks.
    let a = seed >>> 0;
    Math.random = function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    window.__MV_RENDER__ = true;
  }, RANDOM_SEED);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const text = m.text();
      if (problems && problems.size < 40) problems.add(`[page ${m.type()}] ${text}`);
      if (m.type() === 'error') errors.push(text);
    }
  });
  const optional = (u) => /[?&]optional(&|$)/.test(u);
  page.on('requestfailed', (r) => problems && !optional(r.url()) && problems.add(`[load failed] ${r.url()} — ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && problems && !optional(r.url())) problems.add(`[http ${r.status()}] ${r.url()}`);
  });
  page.setDefaultTimeout(timeout);
  const url = `${baseUrl}/index.html?render${debug ? '&debug' : ''}`;
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__MV__ !== undefined, null, { timeout: Math.min(timeout, 30000) });
  } catch {
    throw new CompositionError(
      `The page never called defineVideo() (no window.__MV__).\n${errors.length ? `Page errors:\n  ${errors.slice(0, 5).join('\n  ')}` : 'Check index.html imports ./lib/mv.js and calls defineVideo({...}).'}`,
    );
  }
  const info = await page.evaluate(async () => {
    try {
      return await window.__MV__.ready;
    } catch (e) {
      return { __error: window.__MV__.error || String((e && e.stack) || e) };
    }
  });
  if (!info || info.__error) throw new CompositionError(`Composition failed during setup:\n${(info && info.__error) || errors.join('\n')}`);
  // The page is opened before its size is known: match the viewport to the
  // composition so screenshots never clip past it (vertical, 21:9, 4K…).
  if (info.width !== width || info.height !== height) await page.setViewportSize({ width: info.width, height: info.height });
  const cdp = await context.newCDPSession(page);
  if (alpha) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  return { context, page, cdp, info, errors };
}

async function seekTo(pg, t, timeoutMs) {
  let timer;
  const killer = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`frame at t=${t.toFixed(3)}s took longer than ${timeoutMs / 1000}s (a render() promise never resolved?)`)), timeoutMs);
  });
  try {
    await Promise.race([pg.page.evaluate((x) => window.__MV__.seek(x), t), killer]);
  } catch (e) {
    const pageErr = pg.errors.length ? `\n${pg.errors[pg.errors.length - 1]}` : '';
    throw new CompositionError(`render(t=${t.toFixed(3)}) failed: ${String(e.message).split('\n')[0]}${pageErr}`);
  } finally {
    clearTimeout(timer);
  }
}

async function capture(pg, info, scale, format = 'png', quality = 90) {
  const r = await pg.cdp.send('Page.captureScreenshot', {
    format,
    ...(format === 'jpeg' ? { quality } : {}),
    optimizeForSpeed: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: info.width, height: info.height, scale },
  });
  return Buffer.from(r.data, 'base64');
}

// ──────────────────────────────────────────────────────────── ffmpeg ──

function runFfmpeg(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-6).join('\n')}`))));
    if (input) {
      p.stdin.end(input);
    }
  });
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const d = parseFloat(r.stdout);
  return Number.isFinite(d) ? d : null;
}

function videoEncodeArgs({ format, crf, preset, fps, inputCodec }) {
  if (format === 'mov') return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-r', String(fps)];
  const inMatrix = inputCodec === 'mjpeg' ? 'in_color_matrix=bt601:in_range=full:' : '';
  return [
    '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2:${inMatrix}out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p`,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-g', String(Math.round(fps * 2)), '-bf', '2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-r', String(fps), '-movflags', '+faststart',
  ];
}

function startEncoder(outFile, { fps, format, crf, preset, inputCodec }) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', inputCodec, '-i', '-',
    ...videoEncodeArgs({ format, crf, preset, fps, inputCodec }),
    outFile,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg encoder exited ${code}: ${err.trim().split('\n').slice(-5).join('\n')}`))));
  });
  done.catch(() => {});
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (proc.stdin.destroyed) return reject(new Error(`ffmpeg encoder closed early: ${err.trim()}`));
      const ok = proc.stdin.write(buf, (e) => (e ? reject(e) : null));
      if (ok) resolve();
      else proc.stdin.once('drain', resolve);
    });
  const end = () => {
    proc.stdin.end();
    return done;
  };
  const kill = () => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  };
  return { write, end, kill };
}

// ───────────────────────────────────────────────────────────── audio ──

function wavHeaderFloat(channels, sampleRate, frames) {
  const dataBytes = frames * channels * 4;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 4, 28);
  b.writeUInt16LE(channels * 4, 32);
  b.writeUInt16LE(32, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

async function renderProceduralAudio(pg, outFile, sampleRate = 48000) {
  const meta = await pg.page.evaluate((sr) => window.__MV__.renderAudio(sr), sampleRate);
  if (!meta) return null;
  const fd = await fsp.open(outFile, 'w');
  try {
    await fd.write(wavHeaderFloat(meta.channels, meta.sampleRate, meta.length));
    const chunk = sampleRate * 5;
    for (let s = 0; s < meta.length; s += chunk) {
      const b64 = await pg.page.evaluate(([a, b]) => window.__MV__.audioChunk(a, b), [s, chunk]);
      await fd.write(Buffer.from(b64, 'base64'));
    }
  } finally {
    await fd.close();
  }
  return meta;
}

/**
 * Mix procedural stems + track files into one stereo float WAV, ducking the
 * music under any voice tracks, trimmed to [from, to].
 */
async function mixAudio({ info, projectDir, procWav, from, to, outWav }) {
  const inputs = [];
  const chains = [];
  const buses = { voice: [], music: [], fx: [] };
  if (procWav) {
    inputs.push(procWav);
    chains.push('[0:a]asplit=2[pa][pb]', '[pa]pan=stereo|c0=c0|c1=c1[pm]', '[pb]pan=stereo|c0=c2|c1=c3[pf]');
    buses.music.push('[pm]');
    buses.fx.push('[pf]');
  }
  for (const tr of info.tracks) {
    const file = path.resolve(projectDir, tr.src);
    if (!fs.existsSync(file)) throw new CompositionError(`audio track not found: ${tr.src} (resolved to ${file})`);
    const idx = inputs.push(file) - 1;
    const role = ['voice', 'music', 'fx'].includes(tr.role) ? tr.role : 'music';
    const at = Math.max(0, +tr.at || 0);
    const trim = Math.max(0, +tr.trim || 0);
    const srcDur = probeDuration(file) ?? 0;
    let len = Math.max(0, srcDur - trim);
    if (tr.duration) len = Math.min(len, +tr.duration);
    const f = [`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`];
    if (trim || tr.duration) f.push(`atrim=start=${trim}${tr.duration ? `:duration=${+tr.duration}` : ''}`, 'asetpts=PTS-STARTPTS');
    if (tr.loop && len > 0) f.push(`aloop=loop=-1:size=${Math.round(len * 48000)}`, `atrim=duration=${Math.max(0, info.duration - at)}`, 'asetpts=PTS-STARTPTS');
    if ((tr.gain ?? 1) !== 1) f.push(`volume=${+tr.gain}`);
    const playLen = tr.loop ? Math.max(0, info.duration - at) : len;
    if (tr.fadeIn) f.push(`afade=t=in:st=0:d=${+tr.fadeIn}`);
    if (tr.fadeOut && playLen > 0) f.push(`afade=t=out:st=${Math.max(0, playLen - tr.fadeOut).toFixed(3)}:d=${+tr.fadeOut}`);
    if (at > 0) f.push(`adelay=${Math.round(at * 1000)}:all=1`);
    chains.push(`${f.join(',')}[t${idx}]`);
    buses[role].push(`[t${idx}]`);
  }
  if (!inputs.length) return null;
  const busOut = {};
  for (const [name, list] of Object.entries(buses)) {
    if (!list.length) continue;
    if (list.length === 1) busOut[name] = list[0];
    else {
      chains.push(`${list.join('')}amix=inputs=${list.length}:normalize=0:duration=longest[${name}mix]`);
      busOut[name] = `[${name}mix]`;
    }
  }
  if (busOut.voice && busOut.music) {
    chains.push(`${busOut.voice}asplit=2[vmain][vkey]`);
    chains.push(`${busOut.music}[vkey]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400:makeup=1[mducked]`);
    busOut.voice = '[vmain]';
    busOut.music = '[mducked]';
  }
  const finals = Object.values(busOut);
  const total = info.duration;
  const start = from ?? 0;
  const end = to ?? total;
  const tail = `apad=whole_dur=${total.toFixed(4)},atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)},asetpts=PTS-STARTPTS`;
  if (finals.length === 1) chains.push(`${finals[0]}${tail}[mix]`);
  else chains.push(`${finals.join('')}amix=inputs=${finals.length}:normalize=0:duration=longest,${tail}[mix]`);
  const args = ['-loglevel', 'error', '-y'];
  for (const i of inputs) args.push('-i', i);
  args.push('-filter_complex', chains.join(';'), '-map', '[mix]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', outWav);
  await runFfmpeg(args);
  return outWav;
}

const LIMITER = 'alimiter=limit=0.85:attack=2:release=60:level=false';

/** Two-pass EBU R128 normalization to `lufs`, with a brickwall limiter after it. */
async function loudnessFilter(wav, lufs = -14) {
  try {
    const { err } = await runFfmpeg(['-y', '-i', wav, '-af', `loudnorm=I=${lufs}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
    const m = /\{[\s\S]*?"input_i"[\s\S]*?\}/.exec(err);
    if (!m) return { filter: LIMITER, measured: null };
    const j = JSON.parse(m[0]);
    const I = parseFloat(j.input_i);
    if (!Number.isFinite(I) || I < -60) return { filter: LIMITER, measured: j };
    return {
      filter: `loudnorm=I=${lufs}:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000,${LIMITER}`,
      measured: j,
    };
  } catch {
    return { filter: LIMITER, measured: null };
  }
}

// ──────────────────────────────────────────────────────── utilities ──

function frameRange(info, fps, from, to) {
  const total = Math.max(1, Math.round(info.duration * fps));
  const a = from != null ? Math.max(0, Math.round(from * fps)) : 0;
  const b = to != null ? Math.min(total, Math.round(to * fps)) : total;
  if (b <= a) throw new Error(`empty frame range (--from ${from} --to ${to})`);
  return [a, b];
}

function sceneAt(info, t) {
  const hits = info.scenes.filter((s) => t >= s.start - 1e-6 && t < s.end - 1e-6);
  return hits.length ? hits[hits.length - 1].name : '';
}

function sampleTimes(info, count, from = 0, to = info.duration) {
  const span = to - from;
  const times = [];
  const beats = info.beats.map((b) => b.t).filter((t) => t >= from && t < to);
  const even = Math.max(2, count - beats.length);
  for (let i = 0; i < even; i++) times.push(from + (span * (i + 0.5)) / even);
  times.push(...beats);
  times.sort((a, b) => a - b);
  const out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > span / (count * 3)) out.push(t);
  return out.slice(0, Math.max(count, beats.length));
}

function gridFor(info, n) {
  const ar = info.width / info.height;
  const cols = ar >= 1.5 ? 4 : ar > 0.8 ? 5 : 6;
  return { cols, rows: Math.ceil(n / cols) };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Compose labeled frame thumbnails into one sheet image via a browser page. */
async function composeSheet(browser, { title, subtitle, items, info, outFile, cols, numbered = false, notes = false }) {
  const W = 1920;
  const gap = 14;
  const pad = 28;
  const thumbW = Math.floor((W - pad * 2 - gap * (cols - 1)) / cols);
  const thumbH = Math.round((thumbW * info.height) / info.width);
  const cells = items
    .map(
      (it, i) => `<figure><img src="data:image/${it.type};base64,${it.data.toString('base64')}">
      <figcaption>${numbered ? `<b>${i + 1}</b>` : ''}<span class="tc">${esc(fmtTime(it.t))}</span>${it.label ? `<span class="lb">${esc(it.label)}</span>` : ''}</figcaption>
      ${notes && it.note ? `<p>${esc(it.note)}</p>` : ''}</figure>`,
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#141416;color:#e9e9ee;font:16px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;width:${W}px}
    header{padding:${pad}px ${pad}px 10px} h1{margin:0;font-size:28px;font-weight:700} .sub{color:#9a9aa6;margin-top:6px;font-size:15px}
    main{display:grid;grid-template-columns:repeat(${cols},${thumbW}px);gap:${gap}px;padding:12px ${pad}px ${pad}px}
    figure{margin:0;background:#1e1e22;border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px #2c2c33}
    img{display:block;width:${thumbW}px;height:${thumbH}px;object-fit:cover;background:#000}
    figcaption{display:flex;gap:8px;align-items:center;padding:7px 9px;font-size:14px;white-space:nowrap;overflow:hidden}
    figcaption b{background:#ffb020;color:#111;border-radius:5px;padding:1px 7px;font-size:13px}
    .tc{font-variant-numeric:tabular-nums;color:#ffcf6b}.lb{color:#c9c9d3;overflow:hidden;text-overflow:ellipsis}
    p{margin:0;padding:0 9px 10px;color:#a9a9b5;font-size:13.5px;line-height:1.35}
  </style></head><body><header><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></header><main>${cells}</main></body></html>`;
  const context = await browser.newContext({ viewport: { width: W, height: 400 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    await page.setViewportSize({ width: W, height });
    const isPng = outFile.endsWith('.png');
    await page.screenshot({ path: outFile, fullPage: true, type: isPng ? 'png' : 'jpeg', ...(isPng ? {} : { quality: 86 }) });
  } finally {
    await context.close();
  }
  return outFile;
}

function runQa(file, opts) {
  if (opts['no-qa']) return null;
  const qa = path.join(SCRIPT_DIR, 'qa.py');
  for (const py of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(py, [qa, file, '--json'], { encoding: 'utf8', timeout: 300000 });
    if (r.error) continue;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { error: (r.stderr || r.stdout || '').trim().slice(0, 400) };
    }
  }
  return null;
}

function groupIssues(found) {
  const groups = new Map();
  for (const { t, issue } of found) {
    const key = `${issue.type}|${issue.clip}|${issue.selector}|${issue.text}`;
    if (!groups.has(key)) groups.set(key, { ...issue, times: [] });
    groups.get(key).times.push(t);
  }
  return [...groups.values()].map((g) => ({ ...g, from: Math.min(...g.times), to: Math.max(...g.times), samples: g.times.length, times: undefined }));
}

// ─────────────────────────────────────────────────────────── session ──

async function session(opts, fn) {
  if (!opts.project) throw new Error('usage: node render.mjs [command] <project-dir> [options]');
  const projectDir = path.resolve(opts.project);
  if (!fs.existsSync(path.join(projectDir, 'index.html'))) throw new Error(`${projectDir} has no index.html — scaffold one with scripts/new_project.py`);
  if (!hasBinary('ffmpeg') && ['video', 'audio'].includes(opts.command)) throw new Error('ffmpeg is not on PATH — run scripts/setup.py');
  const pw = loadPlaywright(projectDir);
  const problems = new Set();
  const { server, url } = await startServer(projectDir, { onMissing: (rel) => problems.add(`[404] ${rel}`) });
  const { browser } = await launchBrowser(pw, opts);
  const cleanup = async () => {
    await browser.close().catch(() => {});
    server.close();
  };
  try {
    return await fn({ projectDir, browser, url, problems, pw });
  } finally {
    await cleanup();
  }
}

// ───────────────────────────────────────────────────────── commands ──

async function cmdInfo(opts) {
  return session(opts, async ({ browser, url, problems }) => {
    const pg = await openPage(browser, url, { problems });
    const info = pg.info;
    console.log(JSON.stringify(info, null, 2));
    return info;
  });
}

async function cmdVideo(opts) {
  const t0 = Date.now();
  return session(opts, async ({ projectDir, browser, url, problems }) => {
    const draft = !!opts.draft;
    const format = opts.alpha ? 'mov' : (opts.format || 'mp4').toLowerCase();
    if (!['mp4', 'mov', 'gif'].includes(format)) throw new Error(`--format must be mp4, mov or gif (got ${format})`);
    const probe = await openPage(browser, url, { problems, alpha: format === 'mov' });
    const info = probe.info;
    const fps = opts.fps ? +opts.fps : format === 'gif' ? Math.min(info.fps, 15) : info.fps;
    const scale = opts.scale ? +opts.scale : draft ? 0.5 : format === 'gif' ? Math.min(1, 640 / info.width) : 1;
    const from = parseTime(opts.from);
    const to = parseTime(opts.to);
    const [f0, f1] = frameRange(info, fps, from, to);
    const nFrames = f1 - f0;
    const outW = Math.round(info.width * scale), outH = Math.round(info.height * scale);
    const name = slug(path.basename(projectDir));
    const ext = format === 'gif' ? 'gif' : format;
    const outFile = path.resolve(opts.out || path.join(projectDir, 'out', `${name}${draft ? '.draft' : ''}${from != null || to != null ? `.${(from ?? 0).toFixed(1)}-${(to ?? info.duration).toFixed(1)}` : ''}.${ext}`));
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-render-'));
    const workers = Math.max(1, Math.min(+opts.workers || Math.min(6, os.cpus().length), Math.ceil(nFrames / 8)));
    const inputCodec = format === 'mov' || opts.frames === 'png' ? 'png' : 'mjpeg';
    const crf = opts.crf ? +opts.crf : draft ? 28 : 18;
    const preset = opts.preset || (draft ? 'veryfast' : 'medium');
    const segFormat = format === 'mov' ? 'mov' : 'mp4';
    const timeoutMs = (+opts.timeout || 60) * 1000;
    if (format === 'mov' && !/transparent|rgba\(.*,\s*0\)/.test(String(info.background))) log('note: --alpha/mov keeps transparency only where the composition background is transparent (background: "transparent")');
    log(`${info.title} — ${info.width}x${info.height} @ ${fps}fps, ${info.duration.toFixed(2)}s, ${info.scenes.length} scenes`);
    log(`rendering ${nFrames} frames (${fmtTime(f0 / fps)}–${fmtTime(f1 / fps)}) at ${outW}x${outH} with ${workers} worker${workers > 1 ? 's' : ''}${draft ? ' [draft]' : ''}`);

    // Contiguous chunks → one segment per worker.
    const chunks = [];
    const per = Math.ceil(nFrames / workers);
    for (let w = 0; w < workers; w++) {
      const a = f0 + w * per, b = Math.min(f1, a + per);
      if (a < b) chunks.push([a, b]);
    }
    let done = 0;
    let lastPct = -1;
    const tStart = Date.now();
    const report = () => {
      const pct = Math.floor((done / nFrames) * 10) * 10;
      if (pct !== lastPct && !opts.quiet) {
        lastPct = pct;
        const el = (Date.now() - tStart) / 1000;
        const rate = done / Math.max(el, 1e-3);
        log(`  ${String(pct).padStart(3)}%  ${done}/${nFrames} frames  ${rate.toFixed(1)} fps  eta ${hhmm((nFrames - done) / Math.max(rate, 1e-3))}`);
      }
    };
    const encoders = [];
    const segFiles = [];
    try {
      await Promise.all(
        chunks.map(async ([a, b], w) => {
          const pg = w === 0 && scale === 1 ? probe : await openPage(browser, url, { width: info.width, height: info.height, scale, problems, alpha: format === 'mov', timeout: timeoutMs });
          const seg = path.join(tmp, `seg_${String(w).padStart(3, '0')}.${segFormat}`);
          segFiles[w] = seg;
          const enc = startEncoder(seg, { fps, format: format === 'mov' ? 'mov' : 'mp4', crf, preset, inputCodec });
          encoders.push(enc);
          for (let i = a; i < b; i++) {
            await seekTo(pg, i / fps, timeoutMs);
            const buf = await capture(pg, info, scale, inputCodec === 'png' ? 'png' : 'jpeg', draft ? 85 : 95);
            await enc.write(buf);
            done++;
            report();
          }
          await enc.end();
          if (pg !== probe) await pg.context.close();
        }),
      );
    } catch (e) {
      for (const enc of encoders) enc.kill();
      throw e;
    }
    const renderSecs = (Date.now() - tStart) / 1000;

    // Join segments.
    const silent = path.join(tmp, `video_silent.${segFormat}`);
    if (segFiles.length === 1) await fsp.rename(segFiles[0], silent);
    else {
      const list = path.join(tmp, 'segments.txt');
      await fsp.writeFile(list, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      await runFfmpeg(['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(segFormat === 'mp4' ? ['-movflags', '+faststart'] : []), silent]);
    }

    // Soundtrack.
    let audioNote = 'no audio';
    let loud = null;
    let mixWav = null;
    if (!opts['no-audio'] && format !== 'gif' && (info.hasAudio || info.tracks.length)) {
      const procWav = info.hasAudio ? path.join(tmp, 'procedural.wav') : null;
      let meta = null;
      if (procWav) {
        meta = await renderProceduralAudio(probe, procWav);
        if (meta && meta.peak > 1.0) log(`warning: procedural audio peaks at ${meta.peak.toFixed(2)} (>1.0) before the limiter — lower some gains`);
      }
      mixWav = await mixAudio({ info: { ...info, duration: info.duration }, projectDir, procWav: meta ? procWav : null, from: f0 / fps, to: f1 / fps, outWav: path.join(tmp, 'mix.wav') });
      if (mixWav) {
        loud = await loudnessFilter(mixWav, opts.lufs ? +opts.lufs : -14);
        const parts = [];
        if (meta) parts.push('procedural (music+fx)');
        if (info.tracks.length) parts.push(`${info.tracks.length} track${info.tracks.length > 1 ? 's' : ''} (${[...new Set(info.tracks.map((t) => t.role || 'music'))].join(', ')})`);
        audioNote = parts.join(' + ');
      }
    }

    // Final mux / encode.
    if (format === 'gif') {
      await runFfmpeg(['-loglevel', 'error', '-y', '-i', silent, '-vf', `fps=${fps},split[a][b];[a]palettegen=stats_mode=diff:max_colors=200[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, outFile]);
    } else if (mixWav) {
      const audioCodec = format === 'mov' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k'];
      await runFfmpeg([
        '-loglevel', 'error', '-y', '-i', silent, '-i', mixWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
        '-af', loud.filter, ...audioCodec, '-ar', '48000', '-t', ((f1 - f0) / fps).toFixed(4),
        ...(format === 'mp4' ? ['-movflags', '+faststart'] : []), outFile,
      ]);
    } else {
      await fsp.copyFile(silent, outFile);
    }
    const size = fs.statSync(outFile).size;

    // Contact sheet from the encoded file.
    let sheetFile = null;
    if (!opts['no-sheet'] && format !== 'gif') {
      const sampleList = sampleTimes(info, 20, f0 / fps, f1 / fps);
      const sheetDir = path.join(tmp, 'sheet');
      await fsp.mkdir(sheetDir);
      const sel = sampleList.map((t) => `eq(n\\,${Math.min(f1 - f0 - 1, Math.max(0, Math.round(t * fps) - f0))})`).join('+');
      await runFfmpeg(['-loglevel', 'error', '-y', '-i', outFile, '-vf', `select='${sel}',scale=640:-2`, '-fps_mode', 'passthrough', '-q:v', '3', path.join(sheetDir, 'f_%03d.jpg')]).catch(async () => {
        await runFfmpeg(['-loglevel', 'error', '-y', '-i', outFile, '-vf', `select='${sel}',scale=640:-2`, '-vsync', '0', '-q:v', '3', path.join(sheetDir, 'f_%03d.jpg')]);
      });
      const files = (await fsp.readdir(sheetDir)).filter((f) => f.endsWith('.jpg')).sort();
      const items = files.map((f, i) => ({ t: sampleList[i] ?? 0, label: sceneAt(info, sampleList[i] ?? 0), data: fs.readFileSync(path.join(sheetDir, f)), type: 'jpeg' }));
      sheetFile = outFile.replace(/\.[^.]+$/, '.sheet.jpg');
      const { cols } = gridFor(info, items.length);
      await composeSheet(browser, {
        title: `${info.title} — contact sheet`,
        subtitle: `${outW}x${outH} · ${fps} fps · ${((f1 - f0) / fps).toFixed(2)}s · ${items.length} frames · labels: timecode + scene`,
        items, info, outFile: sheetFile, cols,
      });
    }

    const qa = format === 'gif' ? null : runQa(outFile, opts);
    const reportFile = outFile.replace(/\.[^.]+$/, '.report.json');
    const summary = {
      file: outFile, sheet: sheetFile, report: reportFile, width: outW, height: outH, fps, frames: nFrames,
      duration: +((f1 - f0) / fps).toFixed(3), bytes: size, renderSeconds: +renderSecs.toFixed(1), totalSeconds: +((Date.now() - t0) / 1000).toFixed(1),
      workers, audio: audioNote, loudness: loud && loud.measured ? { input_i: loud.measured.input_i, input_tp: loud.measured.input_tp } : null,
      qa, problems: [...problems],
    };
    await fsp.writeFile(reportFile, JSON.stringify(summary, null, 2));
    if (!opts['keep-temp']) await fsp.rm(tmp, { recursive: true, force: true });
    else log(`temp files kept in ${tmp}`);

    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`\nwrote ${outFile}`);
      console.log(`  ${outW}x${outH} · ${fps} fps · ${summary.duration}s · ${(size / 1048576).toFixed(1)} MB · frames in ${hhmm(renderSecs)} (${(nFrames / renderSecs).toFixed(1)} fps, ${workers} workers) · total ${hhmm(summary.totalSeconds)}`);
      console.log(`  audio: ${audioNote}${summary.loudness ? ` (source ${summary.loudness.input_i} LUFS → normalized to ${opts.lufs || -14})` : ''}`);
      if (sheetFile) console.log(`  contact sheet: ${sheetFile}   ← Read this image to review the render`);
      if (qa && !qa.error) {
        console.log(`  qa: ${qa.summary || 'ok'}`);
        for (const w of qa.warnings || []) console.log(`    - ${w}`);
      } else if (qa && qa.error) console.log(`  qa: could not run (${qa.error})`);
      if (problems.size) {
        console.log('  page problems:');
        for (const p of [...problems].slice(0, 12)) console.log(`    - ${p}`);
      }
    }
    return summary;
  });
}

async function renderStills(browser, url, info, times, { scale = 1, debug = false, problems, dir, prefix = 't' }) {
  const pg = await openPage(browser, url, { width: info.width, height: info.height, scale, debug, problems });
  const out = [];
  try {
    for (const [i, t] of times.entries()) {
      await seekTo(pg, t, 60000);
      const buf = await capture(pg, info, scale, 'png');
      const file = dir ? path.join(dir, prefix === 'beat' ? `beat-${String(i + 1).padStart(2, '0')}.png` : `t${t.toFixed(2).padStart(6, '0')}.png`) : null;
      if (file) await fsp.writeFile(file, buf);
      out.push({ t, file, data: buf });
    }
  } finally {
    await pg.context.close();
  }
  return out;
}

async function cmdStills(opts) {
  return session(opts, async ({ projectDir, browser, url, problems }) => {
    const probe = await openPage(browser, url, { problems });
    const info = probe.info;
    await probe.context.close();
    const times = opts.at ? String(opts.at).split(',').map(parseTime) : info.beats.map((b) => b.t);
    const dir = path.resolve(opts.out || path.join(projectDir, 'out', 'stills'));
    await fsp.mkdir(dir, { recursive: true });
    const scale = opts.scale ? +opts.scale : 1;
    const shots = await renderStills(browser, url, info, times, { scale, debug: !!opts.debug, problems, dir });
    if (opts.json) console.log(JSON.stringify(shots.map((s) => ({ t: s.t, file: s.file, scene: sceneAt(info, s.t) })), null, 2));
    else {
      console.log(`${shots.length} still${shots.length === 1 ? '' : 's'} (${Math.round(info.width * scale)}x${Math.round(info.height * scale)}${opts.debug ? ', with safe-area guides' : ''}) — Read them to inspect:`);
      for (const s of shots) console.log(`  ${s.file}   t=${fmtTime(s.t)}  [${sceneAt(info, s.t)}]`);
      for (const p of [...problems].slice(0, 10)) console.log(`  ! ${p}`);
    }
    return shots;
  });
}

async function cmdStoryboard(opts) {
  return session(opts, async ({ projectDir, browser, url, problems }) => {
    const probe = await openPage(browser, url, { problems });
    const info = probe.info;
    await probe.context.close();
    const dir = path.resolve(opts.out || path.join(projectDir, 'out', 'storyboard'));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const beats = info.beats;
    if (!beats.length) throw new Error('no beats: add scenes or a beats: [...] list to the composition');
    const scale = opts.scale ? +opts.scale : Math.min(1, 1280 / Math.max(info.width, info.height));
    const shots = await renderStills(browser, url, info, beats.map((b) => b.t), { scale, debug: !!opts.debug, problems, dir, prefix: 'beat' });
    const items = shots.map((s, i) => ({ t: s.t, label: beats[i].label, note: beats[i].note, data: s.data, type: 'png' }));
    const ar = info.width / info.height;
    const cols = ar >= 1.5 ? 3 : ar > 0.8 ? 4 : 5;
    const sheet = path.join(dir, 'storyboard.png');
    await composeSheet(browser, {
      title: `${info.title}: storyboard`,
      subtitle: `${info.width}x${info.height} · ${info.fps} fps · ${info.duration.toFixed(1)}s · ${info.scenes.length} scenes · ${beats.length} beats`,
      items, info, outFile: sheet, cols, numbered: true, notes: true,
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(info.title)} — storyboard</title><style>
      body{margin:0;background:#111;color:#eee;font:16px/1.5 system-ui,sans-serif;padding:32px}
      h1{margin:0 0 4px}.sub{color:#999;margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${ar >= 1 ? 420 : 260}px,1fr));gap:20px}
      figure{margin:0;background:#1c1c1f;border-radius:10px;overflow:hidden}img{width:100%;display:block}
      figcaption{padding:10px 14px}.n{display:inline-block;background:#ffb020;color:#111;border-radius:6px;padding:0 8px;margin-right:8px;font-weight:700}
      .t{color:#ffcf6b;font-variant-numeric:tabular-nums;margin-right:8px}.note{color:#aaa;font-size:14px;margin-top:4px}</style></head><body>
      <h1>${esc(info.title)}: storyboard</h1><div class="sub">${info.width}x${info.height} · ${info.fps} fps · ${info.duration.toFixed(1)}s</div><div class="grid">
      ${shots.map((s, i) => `<figure><img src="${path.basename(s.file)}"><figcaption><span class="n">${i + 1}</span><span class="t">${fmtTime(s.t)}</span>${esc(beats[i].label)}<div class="note">${esc(beats[i].note || '')}</div></figcaption></figure>`).join('')}
      </div></body></html>`;
    await fsp.writeFile(path.join(dir, 'index.html'), html);
    if (opts.json) console.log(JSON.stringify({ sheet, dir, beats: shots.map((s, i) => ({ ...beats[i], file: s.file })) }, null, 2));
    else {
      console.log(`storyboard: ${sheet}   ← Read this, then show it to the user for approval`);
      console.log(`  page for the user: ${path.join(dir, 'index.html')}`);
      shots.forEach((s, i) => console.log(`  ${i + 1}. ${fmtTime(s.t)}  ${beats[i].label}${beats[i].note ? ` — ${beats[i].note}` : ''}`));
      for (const p of [...problems].slice(0, 10)) console.log(`  ! ${p}`);
    }
    return { sheet, dir };
  });
}

async function cmdSheet(opts) {
  return session(opts, async ({ projectDir, browser, url, problems }) => {
    const probe = await openPage(browser, url, { problems });
    const info = probe.info;
    await probe.context.close();
    const count = +opts.count || 20;
    const times = sampleTimes(info, count, parseTime(opts.from) ?? 0, parseTime(opts.to) ?? info.duration);
    const scale = Math.min(1, 640 / info.width);
    const shots = await renderStills(browser, url, info, times, { scale, debug: !!opts.debug, problems });
    const out = path.resolve(opts.out || path.join(projectDir, 'out', 'sheet.jpg'));
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const { cols } = gridFor(info, shots.length);
    await composeSheet(browser, {
      title: `${info.title} — timeline sheet`,
      subtitle: `${info.width}x${info.height} · ${info.fps} fps · ${info.duration.toFixed(2)}s · ${shots.length} sampled frames (rendered directly, not from a video file)`,
      items: shots.map((s) => ({ t: s.t, label: sceneAt(info, s.t), data: s.data, type: 'png' })), info, outFile: out, cols,
    });
    console.log(`timeline sheet: ${out}   ← Read this image`);
    for (const p of [...problems].slice(0, 10)) console.log(`  ! ${p}`);
    return out;
  });
}

async function cmdAudit(opts) {
  return session(opts, async ({ projectDir, browser, url, problems }) => {
    const pg = await openPage(browser, url, { problems });
    const info = pg.info;
    const every = +opts.every || 0.25;
    const from = parseTime(opts.from) ?? 0;
    const to = parseTime(opts.to) ?? info.duration;
    const dt = Math.max(2 / info.fps, 0.125); // long enough to see stop-motion (12 fps) steps move
    const found = [];
    const keyOf = (x) => `${x.clip}|${x.selector}|${x.text}`;
    let samples = 0;
    for (let t = from; t < to; t += every) {
      samples++;
      await seekTo(pg, t, 60000);
      const a = await pg.page.evaluate(() => window.__MV__.audit());
      if (!a.issues.length) continue;
      // Motion check: issues on text that is still moving are transient (sliding in, etc.).
      await seekTo(pg, Math.min(info.duration - 1e-3, t + dt), 60000);
      const b = await pg.page.evaluate(() => window.__MV__.audit());
      const boxes = new Map(b.texts.map((x) => [keyOf(x), x.box]));
      const atRest = (txt) => {
        const before = a.texts.find((x) => keyOf(x) === txt);
        const after = boxes.get(txt);
        if (!before || !after) return false;
        return before.box.every((v, i) => Math.abs(v - after[i]) < 1.5);
      };
      for (const issue of a.issues) {
        if (issue.type === 'overlap') {
          const [ta, tb] = issue.text.split(' ⟷ ');
          const [sa, sb] = issue.selector.split(' / ');
          const ka = a.texts.find((x) => x.text === ta && x.selector === sa);
          const kb = a.texts.find((x) => x.text === tb && x.selector === sb);
          if (!(ka && kb && atRest(keyOf(ka)) && atRest(keyOf(kb)))) continue;
        } else if (['clipped', 'unsafe', 'tiny'].includes(issue.type)) {
          const k = a.texts.find((x) => x.text === issue.text && x.selector === issue.selector);
          if (!k || !atRest(keyOf(k))) continue;
        }
        found.push({ t, issue });
      }
    }
    // Determinism: the same t must give the same pixels regardless of render order.
    const probes = Math.min(8, Math.max(3, Math.round(info.duration / 3)));
    const times = Array.from({ length: probes }, (_, i) => +(((i + 0.37) / probes) * info.duration).toFixed(3));
    const hashAt = async (t) => {
      await seekTo(pg, t, 60000);
      return crypto.createHash('sha1').update(await capture(pg, info, 0.5, 'png')).digest('hex');
    };
    const forward = [];
    for (const t of times) forward.push(await hashAt(t));
    const mismatches = [];
    for (let i = times.length - 1; i >= 0; i--) {
      await seekTo(pg, info.duration * (i % 2 ? 0.02 : 0.98), 60000);
      const h = await hashAt(times[i]);
      if (h !== forward[i]) mismatches.push(times[i]);
    }
    await pg.context.close();
    const issues = groupIssues(found).sort((x, y) => (x.severity === y.severity ? x.from - y.from : x.severity === 'error' ? -1 : 1));
    const result = { samples, every, issues, determinism: { checked: times.length, mismatches }, problems: [...problems] };
    const outFile = path.join(projectDir, 'out', 'audit.json');
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.writeFile(outFile, JSON.stringify(result, null, 2));
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`audit: ${samples} samples every ${every}s · ${issues.length} issue${issues.length === 1 ? '' : 's'} · determinism ${mismatches.length ? `FAILED at ${mismatches.map(fmtTime).join(', ')}` : 'ok'}`);
      for (const i of issues) console.log(`  ${i.severity === 'error' ? 'ERROR' : 'warn '} ${fmtTime(i.from)}${i.to > i.from ? `–${fmtTime(i.to)}` : ''} [${i.clip}] ${i.type}: "${i.text}" — ${i.detail} (${i.selector})`);
      if (mismatches.length) console.log('  Frames differ depending on what was rendered before them: some property is set only in some frames, or state persists between frames. Set every animated property on every frame and use the seeded rng()/noise().');
      for (const p of [...problems].slice(0, 10)) console.log(`  ! ${p}`);
      console.log(`  details: ${outFile}`);
    }
    return result;
  });
}

async function cmdAudio(opts) {
  return session(opts, async ({ projectDir, browser, url, problems }) => {
    const pg = await openPage(browser, url, { problems });
    const info = pg.info;
    if (!info.hasAudio && !info.tracks.length) {
      console.log('this composition has no audio (no audio() function and no tracks)');
      return null;
    }
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mv-audio-'));
    const procWav = info.hasAudio ? path.join(tmp, 'procedural.wav') : null;
    const meta = procWav ? await renderProceduralAudio(pg, procWav) : null;
    const mix = await mixAudio({ info, projectDir, procWav: meta ? procWav : null, from: parseTime(opts.from), to: parseTime(opts.to), outWav: path.join(tmp, 'mix.wav') });
    const out = path.resolve(opts.out || path.join(projectDir, 'out', 'audio.wav'));
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const loud = await loudnessFilter(mix, opts.lufs ? +opts.lufs : -14);
    await runFfmpeg(['-loglevel', 'error', '-y', '-i', mix, '-af', loud.filter, '-ar', '48000', '-c:a', 'pcm_s16le', out]);
    await fsp.rm(tmp, { recursive: true, force: true });
    console.log(`wrote ${out} (${probeDuration(out)?.toFixed(2)}s${meta ? `, procedural peak ${meta.peak.toFixed(2)}` : ''})`);
    return out;
  });
}

async function cmdServe(opts) {
  if (!opts.project) throw new Error('usage: node render.mjs serve <project-dir> [--port 5173]');
  const projectDir = path.resolve(opts.project);
  let port = +opts.port || 5173;
  for (let i = 0; i < 20; i++) {
    try {
      const { url } = await startServer(projectDir, { port, host: opts.host || '127.0.0.1' });
      console.log(`preview: ${url}/index.html   (space = play/pause, ←/→ = frame step, shift+←/→ = 1s, d = safe-area guides)`);
      console.log('Ctrl+C to stop.');
      if (opts.open) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(opener, [`${url}/index.html`], { stdio: 'ignore', shell: process.platform === 'win32', detached: true }).unref();
      }
      return new Promise(() => {});
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      port++;
    }
  }
  throw new Error('no free port found');
}

async function cmdDoctor(opts) {
  const report = { node: process.version, depsHome: depsHome(), skillDir: SKILL_DIR, ok: true };
  const major = +process.versions.node.split('.')[0];
  report.nodeOk = major >= 18;
  report.ffmpeg = hasBinary('ffmpeg');
  report.ffprobe = hasBinary('ffprobe');
  try {
    const pw = loadPlaywright(opts.project ? path.resolve(opts.project) : null);
    report.playwright = `${pw.name} from ${pw.from}`;
    try {
      const { browser, how } = await launchBrowser(pw, opts);
      report.chromium = `${browser.version()} (${how})`;
      await browser.close();
    } catch (e) {
      report.chromium = null;
      report.chromiumError = e.message;
    }
  } catch (e) {
    report.playwright = null;
    report.playwrightError = e.message;
  }
  report.fonts = fs.existsSync(path.join(depsHome(), 'node_modules', '@fontsource-variable', 'inter'));
  report.ok = !!(report.nodeOk && report.ffmpeg && report.ffprobe && report.playwright && report.chromium);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(16)} ${v === null ? 'MISSING' : v}`);
  }
  if (!report.ok) process.exitCode = 2;
  return report;
}

// ───────────────────────────────────────────────────────────── main ──

const opts = parseArgs(process.argv.slice(2));
const handlers = { video: cmdVideo, stills: cmdStills, storyboard: cmdStoryboard, sheet: cmdSheet, audit: cmdAudit, audio: cmdAudio, info: cmdInfo, serve: cmdServe, doctor: cmdDoctor };
handlers[opts.command](opts).catch((e) => {
  const msg = e instanceof CompositionError ? `composition error: ${e.message}` : e.code === 'NO_PLAYWRIGHT' || e.code === 'NO_CHROMIUM' ? e.message : e.stack || e.message;
  console.error(`[render] ${msg}`);
  process.exit(e instanceof CompositionError ? 3 : 1);
});
