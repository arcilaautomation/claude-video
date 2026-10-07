/*!
 * mv-audio.js — procedural sound for make-video (MIT).
 *
 * Your composition's `audio(a)` function receives the kit built here and
 * schedules sound at absolute times (seconds), exactly like visuals:
 *
 *   audio(a) {
 *     a.pad({ chords: ['Fmaj7', 'Am7', 'Dm7', 'C'], gain: 0.14 });
 *     a.whoosh(2.4);            // scene transition
 *     a.pop(3.1);               // element lands
 *     a.impact(8.0);            // big reveal
 *   }
 *
 * Everything renders offline (OfflineAudioContext), so it is deterministic and
 * faster than real time. Output is two stereo stems — music and fx — which
 * the renderer mixes with narration/music files, ducking the music stem under
 * the voice.
 */

import { rng, clamp } from './mv.js';

const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

const CHORDS = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7],
  5: [0, 7, 12], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10], mmaj7: [0, 3, 7, 11], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], '7sus4': [0, 5, 7, 10],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8], 11: [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17],
};

/** MIDI number for a note name: midi('A4') → 69. Numbers pass through. */
export function midi(note) {
  if (typeof note === 'number') return note;
  const m = /^([A-G][#b]?)(-?\d)$/.exec(note.trim());
  if (!m) throw new Error(`bad note "${note}" (use names like C4, F#3, Bb5)`);
  return 12 * (+m[2] + 1) + NOTE[m[1]];
}
/** Frequency in Hz: freq('A4') → 440, freq(69) → 440. */
export const freq = (note) => 440 * Math.pow(2, (midi(note) - 69) / 12);

/**
 * Chord name → MIDI notes, voiced around `octave`: chord('Am7') → [57, 60, 64, 67].
 * Supports maj/m/7/maj7/m7/9/add9/sus2/sus4/dim/aug/6 and slash bass (C/G).
 */
export function chord(name, octave = 3) {
  const [main, slash] = name.split('/');
  const m = /^([A-G][#b]?)(.*)$/.exec(main.trim());
  if (!m) throw new Error(`bad chord "${name}"`);
  const q = m[2].replace(/[()]/g, '');
  const iv = CHORDS[q];
  if (!iv) throw new Error(`unknown chord quality "${q}" in "${name}"`);
  const root = 12 * (octave + 1) + NOTE[m[1]];
  const notes = iv.map((i) => root + i);
  if (slash) notes.unshift(12 * octave + NOTE[slash.trim()]);
  return notes;
}

export function createAudioKit(ctx, { duration, fps = 30, seed = 7, scenes = [], beats = [] } = {}) {
  const sr = ctx.sampleRate;
  const end = duration;
  const R = rng(seed);

  // ── buses: music → channels 0/1, fx → channels 2/3 of a 4-channel render ──
  const merger = ctx.createChannelMerger(4);
  ctx.destination.channelInterpretation = 'discrete';
  merger.connect(ctx.destination);
  const makeBus = (ch) => {
    const input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const split = ctx.createChannelSplitter(2);
    input.connect(limiter).connect(split);
    split.connect(merger, 0, ch);
    split.connect(merger, 1, ch + 1);
    return input;
  };
  const music = makeBus(0);
  const fx = makeBus(2);

  // Shared white noise (seeded → identical every render).
  const noiseBuf = ctx.createBuffer(1, sr * 2, sr);
  {
    const d = noiseBuf.getChannelData(0);
    const r = rng(seed * 31 + 1);
    for (let i = 0; i < d.length; i++) d[i] = r.next() * 2 - 1;
  }
  const makeReverb = (seconds, decay, bus) => {
    const len = Math.floor(sr * seconds);
    const ir = ctx.createBuffer(2, len, sr);
    const r = rng(seed * 97 + Math.round(seconds * 10));
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (r.next() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const send = ctx.createGain();
    send.gain.value = 1;
    send.connect(conv).connect(bus);
    return send;
  };
  const musicVerb = makeReverb(3.2, 2.6, music);
  const fxVerb = makeReverb(1.6, 3.2, fx);

  const live = (t) => t >= 0 && t < end;
  const out = (busName) => (busName === 'music' ? music : fx);
  const verbFor = (busName) => (busName === 'music' ? musicVerb : fxVerb);

  function noiseSrc(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.loopStart = 0;
    s.loopEnd = noiseBuf.duration;
    s.start(t, R.next() * 1.5);
    s.stop(t + dur + 0.05);
    return s;
  }
  function panner(pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }
  /** Envelope helper: a gain node shaped attack → decay to 0. */
  function env(t, { peak = 1, attack = 0.005, decay = 0.2, hold = 0 }) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
    g.gain.setValueAtTime(0, t + attack + hold + decay + 0.01);
    return g;
  }
  function route(node, { bus = 'fx', pan = 0, verb = 0 } = {}) {
    const p = panner(pan);
    node.connect(p).connect(out(bus));
    if (verb > 0) {
      const s = ctx.createGain();
      s.gain.value = verb;
      p.connect(s).connect(verbFor(bus));
    }
  }

  const kit = {
    ctx,
    sampleRate: sr,
    duration,
    fps,
    /** Raw stereo bus inputs if you want to build your own Web Audio graph. */
    music,
    fx,
    rng: R,
    /** Scene timing from the composition: [{ name, start, end, transition, transitionDuration }]. */
    scenes,
    beats,
    /** Timing of one scene by name: a.scene('outro').start */
    scene(name) {
      const s = scenes.find((x) => x.name === name);
      if (!s) throw new Error(`audio: no scene named "${name}" (have: ${scenes.map((x) => x.name).join(', ')})`);
      return s;
    },
    freq,
    midi,
    chord,

    // ───────────────────────────────────────────────────────── sfx ──

    /** Air whoosh for transitions; peaks ~55% through `dur`. */
    whoosh(t, { dur = 0.7, gain = 0.5, from = 250, to = 2400, pan = 0, q = 0.9, verb = 0.15 } = {}) {
      if (!live(t) || gain <= 0) return;
      const src = noiseSrc(t, dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(from, t);
      bp.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
      bp.frequency.exponentialRampToValueAtTime(Math.max(80, from * 1.5), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(-pan, t);
      p.pan.linearRampToValueAtTime(pan, t + dur);
      src.connect(bp).connect(g).connect(p).connect(fx);
      if (verb) {
        const s = ctx.createGain();
        s.gain.value = verb;
        p.connect(s).connect(fxVerb);
      }
    },
    /** Short, bright swish (UI-scale whoosh). */
    swish(t, opts = {}) {
      kit.whoosh(t, { dur: 0.32, from: 900, to: 5200, gain: 0.32, q: 1.4, verb: 0.08, ...opts });
    },
    /** Bubbly pop for elements landing. */
    pop(t, { gain = 0.45, pitch = 520, pan = 0, verb = 0.12 } = {}) {
      if (!live(t)) return;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(pitch * 1.9, t);
      o.frequency.exponentialRampToValueAtTime(pitch * 0.62, t + 0.09);
      const g = env(t, { peak: gain, attack: 0.002, decay: 0.13 });
      o.connect(g);
      o.start(t);
      o.stop(t + 0.2);
      route(g, { pan, verb });
    },
    /** Crisp UI click. */
    click(t, { gain = 0.3, tone = 2800, pan = 0 } = {}) {
      if (!live(t)) return;
      const src = noiseSrc(t, 0.03);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = tone;
      bp.Q.value = 1.6;
      const g = env(t, { peak: gain * 1.6, attack: 0.0008, decay: 0.022 });
      src.connect(bp).connect(g);
      const o = ctx.createOscillator();
      o.frequency.value = tone * 0.6;
      const g2 = env(t, { peak: gain * 0.35, attack: 0.0008, decay: 0.03 });
      o.connect(g2);
      o.start(t);
      o.stop(t + 0.05);
      route(g, { pan });
      route(g2, { pan });
    },
    /** Tiny tick — counters, ticking clocks, typing. */
    tick(t, { gain = 0.18, tone = 5200, pan = 0 } = {}) {
      kit.click(t, { gain, tone, pan });
    },
    /** Short tonal blip (notifications, bullet points). */
    blip(t, { note = 'C6', gain = 0.2, type = 'triangle', dur = 0.12, pan = 0, verb = 0.1 } = {}) {
      if (!live(t)) return;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq(note);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4500;
      const g = env(t, { peak: gain, attack: 0.003, decay: dur });
      o.connect(lp).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
      route(g, { pan, verb });
    },
    /** FM bell / chime. */
    chime(t, { note = 'E6', gain = 0.22, decay = 1.8, ratio = 3.5, pan = 0, verb = 0.35 } = {}) {
      if (!live(t)) return;
      const f = freq(note);
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.frequency.value = f * ratio;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 2.2, t);
      mg.gain.exponentialRampToValueAtTime(f * 0.05, t + decay * 0.6);
      mod.connect(mg).connect(car.frequency);
      const g = env(t, { peak: gain, attack: 0.002, decay });
      car.connect(g);
      car.start(t);
      mod.start(t);
      car.stop(t + decay + 0.1);
      mod.stop(t + decay + 0.1);
      route(g, { pan, verb });
    },
    /** Two-note "success" chime. */
    success(t, { gain = 0.2, notes = ['E6', 'B6'] } = {}) {
      kit.chime(t, { note: notes[0], gain, decay: 1.2 });
      kit.chime(t + 0.11, { note: notes[1], gain: gain * 0.9, decay: 1.6 });
    },
    /** Tension riser that peaks at t + dur (schedule it to end on the hit). */
    riser(t, { dur = 1.6, gain = 0.32, from = 300, to = 7000, pan = 0 } = {}) {
      if (!live(t + dur * 0.5) || gain <= 0) return;
      const src = noiseSrc(t, dur);
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.Q.value = 2.5;
      hp.frequency.setValueAtTime(from, t);
      hp.frequency.exponentialRampToValueAtTime(to, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.04);
      src.connect(hp).connect(g);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(880, t + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.exponentialRampToValueAtTime(3000, t + dur);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(gain * 0.25, t + dur);
      g2.gain.linearRampToValueAtTime(0, t + dur + 0.04);
      o.connect(lp).connect(g2);
      o.start(t);
      o.stop(t + dur + 0.1);
      route(g, { pan, verb: 0.2 });
      route(g2, { pan, verb: 0.2 });
    },
    /** Deep cinematic hit (sub drop + noise burst). */
    impact(t, { gain = 0.7, pan = 0, verb = 0.3 } = {}) {
      if (!live(t)) return;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(36, t + 0.5);
      const g = env(t, { peak: gain, attack: 0.004, decay: 1.1 });
      o.connect(g);
      o.start(t);
      o.stop(t + 1.3);
      const src = noiseSrc(t, 0.5);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2400, t);
      lp.frequency.exponentialRampToValueAtTime(200, t + 0.4);
      const g2 = env(t, { peak: gain * 0.5, attack: 0.002, decay: 0.4 });
      src.connect(lp).connect(g2);
      route(g, { pan, verb });
      route(g2, { pan, verb });
    },
    /** Soft thud — heavier than pop, lighter than impact. */
    thud(t, { gain = 0.5, pan = 0 } = {}) {
      if (!live(t)) return;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.15);
      const g = env(t, { peak: gain, attack: 0.002, decay: 0.25 });
      o.connect(g);
      o.start(t);
      o.stop(t + 0.35);
      route(g, { pan, verb: 0.1 });
    },
    /** Keyboard typing for `dur` seconds (~rate keys/s). */
    typing(t, { dur = 1, rate = 11, gain = 0.2, seed: s = 3 } = {}) {
      const r = rng(s);
      let x = t;
      while (x < t + dur) {
        kit.click(x, { gain: gain * r.range(0.6, 1.1), tone: r.range(2200, 4200), pan: r.range(-0.2, 0.2) });
        x += (1 / rate) * r.range(0.55, 1.5);
      }
    },
    /** Shimmering sparkle of high chimes. */
    sparkle(t, { dur = 0.8, gain = 0.12, notes = ['E6', 'G#6', 'B6', 'E7'], seed: s = 5 } = {}) {
      const r = rng(s);
      const n = Math.max(3, Math.round(dur * 8));
      for (let i = 0; i < n; i++) kit.chime(t + (i / n) * dur, { note: r.pick(notes), gain: gain * r.range(0.5, 1), decay: 0.9, pan: r.range(-0.6, 0.6), verb: 0.5 });
    },

    // ─────────────────────────────────────────────────────── music ──

    /**
     * Warm chord pad. chords cycle every `every` seconds from `start` to `end`.
     * a.pad({ chords: ['Cmaj7', 'Am7', 'Fmaj7', 'G6'], every: 4, gain: 0.14 })
     */
    pad({ start = 0, end: stop = end, chords = ['Cmaj7', 'Am7', 'Fmaj7', 'G6'], every = 4, gain = 0.14, cutoff = 1500, octave = 3, attack = 1.2, release = 1.6, fadeIn = 1.5, fadeOut = 2.5 } = {}) {
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, start);
      master.gain.linearRampToValueAtTime(1, start + fadeIn);
      master.gain.setValueAtTime(1, Math.max(start + fadeIn, stop - fadeOut));
      master.gain.linearRampToValueAtTime(0, stop);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      lp.Q.value = 0.4;
      master.connect(lp);
      route(lp, { bus: 'music', verb: 0.45 });
      let k = 0;
      for (let t = start; t < stop; t += every, k++) {
        const notes = chord(chords[k % chords.length], octave);
        const tEnd = Math.min(stop, t + every);
        notes.forEach((n, i) => {
          for (const det of [-7, 6]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = freq(n);
            o.detune.value = det + (i % 2 ? 2 : -2);
            const g = ctx.createGain();
            const level = (gain / notes.length) * (i === 0 ? 0.9 : 0.7);
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(level, t + attack);
            g.gain.setValueAtTime(level, tEnd);
            g.gain.linearRampToValueAtTime(0, tEnd + release);
            o.connect(g).connect(master);
            o.start(t);
            o.stop(tEnd + release + 0.05);
          }
        });
        // Soft sub on the root.
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = freq(notes[0] - 12);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0, t);
        sg.gain.linearRampToValueAtTime(gain * 0.6, t + attack);
        sg.gain.setValueAtTime(gain * 0.6, tEnd);
        sg.gain.linearRampToValueAtTime(0, tEnd + release);
        sub.connect(sg).connect(master);
        sub.start(t);
        sub.stop(tEnd + release + 0.05);
      }
    },
    /** Plucked arpeggio over the same chord cycle; `rate` notes per second. */
    arp({ start = 0, end: stop = end, chords = ['Cmaj7', 'Am7', 'Fmaj7', 'G6'], every = 4, rate = 4, gain = 0.1, octave = 4, pattern = 'updown', decay = 0.35 } = {}) {
      let k = 0;
      for (let t = start; t < stop; t += every, k++) {
        const notes = chord(chords[k % chords.length], octave);
        const seq = pattern === 'up' ? notes : pattern === 'down' ? notes.slice().reverse() : [...notes, ...notes.slice(1, -1).reverse()];
        const steps = Math.round(every * rate);
        for (let i = 0; i < steps; i++) {
          const nt = t + i / rate;
          if (nt >= stop) break;
          const n = pattern === 'random' ? R.pick(notes) : seq[i % seq.length];
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = freq(n + (i % 8 >= 4 ? 12 : 0));
          const g = env(nt, { peak: gain, attack: 0.004, decay });
          o.connect(g);
          o.start(nt);
          o.stop(nt + decay + 0.05);
          route(g, { bus: 'music', pan: i % 2 ? 0.25 : -0.25, verb: 0.35 });
        }
      }
    },
    /** Root-note bass pulse on every beat (or `every` beats). */
    bass({ start = 0, end: stop = end, chords = ['Cmaj7', 'Am7', 'Fmaj7', 'G6'], every = 4, bpm = 100, gain = 0.22, octave = 2, beats = 1 } = {}) {
      const spb = 60 / bpm;
      for (let t = start; t < stop - 1e-6; t += spb * beats) {
        const k = Math.floor((t - start) / every + 1e-6);
        const root = chord(chords[k % chords.length], octave)[0];
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq(root);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 600;
        const g = env(t, { peak: gain, attack: 0.01, decay: spb * beats * 0.9 });
        o.connect(lp).connect(g);
        o.start(t);
        o.stop(t + spb * beats + 0.05);
        route(g, { bus: 'music' });
      }
    },
    /**
     * Synthesized drums. Patterns are 16 steps per bar ('x' = hit, '.' = rest).
     * a.drums({ bpm: 96, kick: 'x...x...x...x...', hat: '..x...x...x...x.', snare: '....x.......x...' })
     */
    drums({ start = 0, end: stop = end, bpm = 100, kick = 'x.......x.......', snare = '....x.......x...', hat = '..x...x...x...x.', gain = 0.4, swing = 0 } = {}) {
      const step = 60 / bpm / 4;
      for (let i = 0, t = start; t < stop - 1e-6; i++, t = start + i * step) {
        const s = i % 16;
        const tt = t + (s % 2 ? swing * step : 0);
        if (kick[s] === 'x') {
          const o = ctx.createOscillator();
          o.frequency.setValueAtTime(150, tt);
          o.frequency.exponentialRampToValueAtTime(42, tt + 0.12);
          const g = env(tt, { peak: gain, attack: 0.002, decay: 0.32 });
          o.connect(g);
          o.start(tt);
          o.stop(tt + 0.4);
          route(g, { bus: 'music' });
        }
        if (snare[s] === 'x') {
          const src = noiseSrc(tt, 0.2);
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 1800;
          bp.Q.value = 0.8;
          const g = env(tt, { peak: gain * 0.55, attack: 0.001, decay: 0.16 });
          src.connect(bp).connect(g);
          route(g, { bus: 'music', verb: 0.2 });
        }
        if (hat[s] === 'x') {
          const src = noiseSrc(tt, 0.06);
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 7500;
          const g = env(tt, { peak: gain * 0.28, attack: 0.001, decay: 0.045 });
          src.connect(hp).connect(g);
          route(g, { bus: 'music', pan: 0.15 });
        }
      }
    },

    // ─────────────────────────────────────────────────── samples ──

    /** Decode an audio file (wav/mp3/ogg/flac). */
    async load(src) {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`audio load ${src}: HTTP ${res.status}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    },
    /**
     * Schedule a sound file (await it): await a.sample('assets/ding.wav', 2.5, { gain: 0.6 }).
     * For narration or a music bed, prefer config.tracks — the renderer mixes and ducks those.
     */
    async sample(src, t, { gain = 1, rate = 1, offset = 0, dur, fadeIn = 0, fadeOut = 0, bus = 'fx', pan = 0, verb = 0 } = {}) {
      const buf = typeof src === 'string' ? await kit.load(src) : src;
      if (!live(t)) return buf;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = rate;
      const length = dur ?? (buf.duration - offset) / rate;
      const g = ctx.createGain();
      g.gain.setValueAtTime(fadeIn ? 0 : gain, t);
      if (fadeIn) g.gain.linearRampToValueAtTime(gain, t + fadeIn);
      if (fadeOut) {
        g.gain.setValueAtTime(gain, Math.max(t + fadeIn, t + length - fadeOut));
        g.gain.linearRampToValueAtTime(0, t + length);
      }
      s.connect(g);
      s.start(t, offset, length * rate);
      route(g, { bus, pan, verb });
      return buf;
    },
  };
  return kit;
}
