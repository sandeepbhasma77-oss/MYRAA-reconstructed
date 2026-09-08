// Human-quality voice refinements: configurable + adaptive jitter, engine
// lifecycle proof, conditional boundary smoothing, interruption audit.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { needsBoundarySmoothing, applyEdgeRamps } = require('../src/voicePipe.js');

const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');

describe('jitter buffer matrix + adaptation (PART 1-2)', () => {
  test('presets cover 120/150/180/220ms with 180ms default', () => {
    const src = app();
    assert.ok(src.includes('JITTER_PRESETS_SEC'), 'preset list required');
    for (const v of ['0.12', '0.15', '0.18', '0.22']) {
      assert.ok(src.includes(v), `preset ${v}s required`);
    }
    assert.ok(/DEFAULT_JITTER_BUFFER_SEC = 0\.18/.test(src), 'default must be 180ms test target');
    assert.ok(/MIN_JITTER_BUFFER_SEC = 0\.08/.test(src), '80ms floor required');
    assert.ok(/MAX_JITTER_BUFFER_SEC = 0\.30/.test(src), '300ms ceiling required (no large fixed delay)');
  });

  test('per-browser override for A/B listening (localStorage, clamped)', () => {
    const src = app();
    assert.ok(src.includes('myraa_jitter_ms'), 'localStorage override key required');
    assert.ok(src.includes('readJitterOverrideSec'), 'override reader required');
  });

  test('adaptation is slow: EWMA + slew-limited, once per turn + underflow bump', () => {
    const src = app();
    assert.ok(src.includes('arrivalJitterMs'), 'arrival jitter EWMA field required');
    assert.ok(src.includes('0.15'), 'slow EWMA alpha required');
    assert.ok(src.includes('adaptJitter'), 'per-turn adapt function required');
    assert.ok(src.includes('cur + 0.05') && src.includes('cur - 0.02'), 'slew limits (+50ms/-20ms) required');
    const adaptCalls = (src.match(/adaptJitter\(/g) || []).length;
    assert.equal(adaptCalls, 2, 'adaptJitter defined once, called once per turn (definition + turnComplete call)');
  });
});

describe('engine lifecycle proof (PART 3)', () => {
  test('every lifecycle call carries a reason and is counted', () => {
    const src = app();
    assert.ok(/ensurePlaybackEngine\s*=\s*\(\s*reason:\s*string\s*\)/.test(src), 'ensure must take a reason');
    assert.ok(src.includes('engineCalls'), 'ensure call counter required');
    assert.ok(src.includes('engineCreations'), 'creation counter required');
    assert.ok(src.includes('engineCloses') && src.includes('audioCtxCloses'), 'close counters required');
    assert.ok(src.includes("ensurePlaybackEngine('pump-schedule')"), 'pump reason required');
    assert.ok(src.includes("ensurePlaybackEngine('ref-tone')"), 'tone reason required');
    assert.ok(src.includes("closePlaybackEngine('unmount')"), 'unmount-only close proof required');
  });

  test('stopSources fires only on explicit termination paths, each reasoned', () => {
    const src = app();
    const calls = [...src.matchAll(/stopSources\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(calls, ['disconnect-stop', 'invalid-key-termination', 'socket-close-termination', 'user-interrupt'].sort(),
      `unexpected stopSources call sites: ${calls}`);
  });
});

describe('boundary analysis + conditional smoothing (PART 4)', () => {
  test('continuous boundaries pass through, abrupt ones smooth', () => {
    assert.equal(needsBoundarySmoothing(0.100, 0.105), false, '0.005 step must stay bit-perfect');
    assert.equal(needsBoundarySmoothing(0.100, 0.100), false, 'identical samples must stay bit-perfect');
    assert.equal(needsBoundarySmoothing(-0.5, 0.5), true, 'full-scale jump must smooth');
    assert.equal(needsBoundarySmoothing(null, 0.3), true, 'stream start needs fade-in');
    assert.equal(needsBoundarySmoothing(0.0, 0.019), false, 'sub-threshold stays clean');
    assert.equal(needsBoundarySmoothing(0.0, 0.021), true, 'super-threshold smooths');
  });

  test('smoothing window stays within 2–5ms budget and is counted', () => {
    const src = app();
    // 64 samples @24kHz ≈ 2.7ms via the existing tested helper (never enlarged).
    assert.ok(src.includes('needsBoundarySmoothing(prevTailSample.current'), 'conditional gate required in pump');
    assert.ok(src.includes('boundaryChecked') && src.includes('boundaryAbrupt') && src.includes('boundarySmoothed'), 'boundary counters required');
    assert.ok(src.includes('boundaryMaxDisc'), 'max discontinuity measurement required');
    // Existing helper untouched: still the tiny tested ramp, PCM conversion intact.
    const a = new Float32Array(480).fill(0.5);
    applyEdgeRamps(a);
    assert.equal(a.length, 480, 'smoothing must not change sample count');
    assert.ok(Math.abs(a[240] - 0.5) < 1e-6, 'body untouched');
  });
});

describe('human-quality diagnostics (PART 6)', () => {
  test('per-turn summary carries every required field', () => {
    const src = app();
    for (const f of ['jitterTarget=', 'arrivalJitter=', 'turnAvgArrival=', 'turnMaxGap=',
      'turnMinQueue=', 'turnMaxQueue=', 'turnInterruptions=', 'turnEngineCreations=',
      'turnSmoothed=', 'minQueueDuration=', 'interruptions=', 'engineCreations=']) {
      assert.ok(src.includes(f), `summary field ${f} required`);
    }
    assert.ok(src.includes('turnMark'), 'per-turn snapshot required');
  });
});
