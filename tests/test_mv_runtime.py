"""mv.js pure helpers (easing, interpolation, noise, narration cues) run under Node."""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from conftest import MV_DIR

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is required")

SCRIPT = r"""
const mv = await import(process.argv[1]);
const out = {};
const { ease, keys, tween, mix, rng, hash, noise, narration, clamp, progress, stepTime, bezier, springEase, remap } = mv;

// Every easing maps 0 → 0 and 1 → 1.
out.easeEnds = Object.entries(ease)
  .filter(([, f]) => typeof f === 'function' && f.length === 1 && !['bezier', 'spring', 'back', 'steps', 'reverse', 'inOut'].includes(f.name))
  .map(([k, f]) => [k, +f(0).toFixed(6), +f(1).toFixed(6)]);
out.bezierLinear = [0.1, 0.5, 0.9].map((x) => +bezier(0, 0, 1, 1)(x).toFixed(4));
const b = bezier(0.42, 0, 0.58, 1);
out.bezierMonotonic = [0.1, 0.3, 0.5, 0.7, 0.9].map(b).every((v, i, a) => i === 0 || v > a[i - 1]);
out.spring = [springEase({ bounce: 0 })(0), +springEase({ bounce: 0.4 })(1).toFixed(6), Math.max(...Array.from({ length: 100 }, (_, i) => springEase({ bounce: 0.6 })(i / 100)))];
out.keys = [keys(-1, [[0, 0], [1, 10], [2, 30]]), keys(0.5, [[0, 0], [1, 10, ease.linear], [2, 30]], ease.linear), keys(1.5, [[0, 0], [1, 10, ease.linear], [2, 30]]), keys(9, [[0, 0], [1, 10]])];
out.tween = tween(1, 0, 2, 0, 100, ease.linear);
out.mixArray = mix([0, 10], [10, 20], 0.5);
out.mixObject = mix({ a: 0, b: 'x' }, { a: 4, b: 'y' }, 0.25);
out.mixHex = mix('#000000', '#ffffff', 0);
out.clamp = [clamp(-1), clamp(2), clamp(5, 0, 10)];
out.progress = [progress(5, 0, 10), progress(-1, 0, 10), progress(20, 0, 10)];
out.remap = remap(5, 0, 10, 100, 200);
out.step = [stepTime(0.09, 12), stepTime(0.1, 12)];
out.rng = [rng(42).next(), rng(42).next(), rng('scene').int(1, 6)];
const r = rng(3); out.rngRange = Array.from({ length: 200 }, () => r.range(-2, 2)).every((v) => v >= -2 && v < 2);
out.hash = [hash(1, 2), hash(1, 2), hash(2, 1)];
out.noise = [noise(0.3, 0.7), noise(0.3, 0.7), Math.abs(noise(1.37, 2.11)) <= 1.2];

const vo = narration({ duration: 6, words: [
  { w: 'Every', s: 0.1, e: 0.4 }, { w: 'frame', s: 0.4, e: 0.8 }, { w: 'is', s: 0.8, e: 0.9 }, { w: 'a', s: 0.9, e: 1.0 },
  { w: 'function', s: 1.0, e: 1.5 }, { w: 'of', s: 1.5, e: 1.6 }, { w: 'time.', s: 1.6, e: 2.0 },
  { w: 'Every', s: 3.0, e: 3.3 }, { w: "frame's", s: 3.3, e: 3.7 }, { w: 'drawn', s: 3.7, e: 4.0 }, { w: 'twice!', s: 4.0, e: 4.5 },
] });
out.cues = [vo.cue('every frame'), vo.cue('Function of TIME'), vo.cueEnd('of time'), vo.cue('every', 2), vo.has('nope'), vo.cue("frame's drawn")];
try { vo.cue('functon'); out.missing = 'no error'; } catch (e) { out.missing = String(e.message); }
out.wordAt = [vo.wordAt(1.2), vo.wordAt(2.5)];
out.chunks = vo.chunks({ maxWords: 4 }).map((c) => c.text);
const cap = vo.captionAt(1.2);
out.caption = cap && { text: cap.text, active: cap.words.filter((w) => w.active).map((w) => w.w), spoken: cap.words.filter((w) => w.spoken).length };
out.captionGap = vo.captionAt(2.8);
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def results():
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", SCRIPT, str(MV_DIR / "runtime" / "mv.js")],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_easing_endpoints(results):
    bad = [k for k, a, b in results["easeEnds"] if a != 0 or b != 1]
    assert not bad, f"easings not pinned to 0→1: {bad}"
    assert results["bezierLinear"] == [0.1, 0.5, 0.9]
    assert results["bezierMonotonic"]
    lo, end, peak = results["spring"]
    assert lo == 0 and end == 1 and peak > 1.0  # bouncy springs overshoot


def test_interpolation(results):
    assert results["keys"] == [0, 5, 20, 10]
    assert results["tween"] == 50
    assert results["mixArray"] == [5, 15]
    assert results["mixObject"] == {"a": 1, "b": "x"}
    assert results["mixHex"] == "rgb(0, 0, 0)"
    assert results["clamp"] == [0, 1, 5]
    assert results["progress"] == [0.5, 0, 1]
    assert results["remap"] == 150
    assert results["step"][0] == 1 / 12 and results["step"][1] == 1 / 12


def test_randomness_is_seeded(results):
    a, b, die = results["rng"]
    assert a == b and 1 <= die <= 6
    assert results["rngRange"]
    h1, h2, h3 = results["hash"]
    assert h1 == h2 and h1 != h3 and 0 <= h1 < 1
    n1, n2, bounded = results["noise"]
    assert n1 == n2 and bounded


def test_narration_cues(results):
    assert results["cues"] == [0.1, 1.0, 2.0, 3.0, False, 3.3]
    assert "not found" in results["missing"] and "function" in results["missing"]
    assert results["wordAt"] == [4, -1]
    # A 7-word sentence splits evenly (4 + 3), the pause starts a new chunk.
    assert results["chunks"] == ["Every frame is a", "function of time.", "Every frame's drawn twice!"]
    assert results["caption"]["active"] == ["function"]
    assert results["captionGap"] is None
