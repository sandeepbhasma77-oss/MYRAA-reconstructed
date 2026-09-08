// UI + voice contract: fullscreen/responsive shell, circular one-way visualizer,
// minimal home, mic separation, single engine/worker, ERROR state, barge gate.
// Static checks (no window, mic, or speaker needed); live behavior runs on HW.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { VoiceSession, STATES } = require('../src/voicePipe.js');

const main = () => fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf-8');
const css = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf-8');
const app = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');

describe('fullscreen window + responsive shell (PART 1-3)', () => {
  test('Electron opens maximized, never exclusive fullscreen', () => {
    const m = main();
    assert.ok(m.includes('.maximize()'), 'window must open maximized');
    assert.ok(!m.includes('fullscreen: true') && !m.includes('setFullScreen'), 'no exclusive OS fullscreen');
    assert.ok(/minWidth:\s*940/.test(m) && /minHeight:\s*600/.test(m), 'sane minima without locking size');
  });

  test('root fills viewport without hardcoded main dimensions', () => {
    const c = css();
    assert.ok(/html,\s*body,\s*#root\s*\{[^}]*width:\s*100%/.test(c), 'root width 100%');
    assert.ok(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%/.test(c), 'root height 100%');
    assert.ok(/100dvh|100vh/.test(c), 'shell fills viewport height');
    assert.ok(!/(?<![\w-])width:\s*900px/.test(c) && !/(?<![\w-])height:\s*700px/.test(c), 'no hardcoded main-app dimensions (media-query breakpoints excluded)');
    assert.ok(c.includes('@media') && c.includes('clamp('), 'responsive rules required');
  });

  test('home stage centers content fluidly (no pixel centering)', () => {
    const c = css();
    assert.ok(/\.home\.fullscreen\s*\{[^}]*width:\s*100%/.test(c), 'home fills available space');
    assert.ok(!/left:\s*\d+px;\s*top:\s*\d+px/.test(c), 'no hardcoded pixel centering');
  });
});

describe('circular one-way visualizer, minimal home (PART 25/28/29)', () => {
  test('no bar/equalizer visualizer exists', () => {
    const a = app(), c = css();
    assert.ok(!/equali[sz]er/i.test(a + c), 'no equalizer');
    assert.ok(!/eq-bar|eqBar|freq-bar|freqBar/i.test(a + c), 'no bar elements');
  });

  test('orb is circular, amplitude-driven, and never touches audio', () => {
    const a = app();
    for (const part of ['orb-core', 'orb-ring', 'orb-wave', 'orb-bloom']) {
      assert.ok(a.includes(part), `orb part ${part} required`);
    }
    const orbBody = a.slice(a.indexOf('function VoiceOrb'), a.indexOf('function VoiceOrb') + 2500);
    assert.ok(!/AudioContext|AudioBuffer|createBuffer|getChannelData/.test(orbBody), 'visualizer must not touch audio');
    assert.ok(orbBody.includes('ampRef'), 'orb follows live amplitude refs');
    assert.ok(orbBody.includes('requestAnimationFrame'), 'rAF-driven, no re-render spam');
  });

  test('home stays minimal: no feature-button restoration', () => {
    const a = app();
    for (const label of ['Open an app', 'Find a file', 'Browse the web', 'Control my PC', 'Take a screenshot', 'Check system']) {
      assert.ok(!a.includes(label), `home must not restore "${label}"`);
    }
    assert.ok(a.includes('className="character"'), 'character present');
    assert.ok(a.includes('<VoiceOrb'), 'voice orb present');
    assert.ok(a.includes('<Composer'), 'composer present');
  });
});

describe('voice state machine incl. ERROR (PART 26)', () => {
  test('STATES covers the full contract', () => {
    for (const s of ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'INTERRUPTED', 'ERROR']) {
      assert.ok(STATES.includes(s), s);
    }
  });

  test('ERROR reachable from active speech, recoverable to IDLE', () => {
    const s = new VoiceSession(() => {});
    s.transition('LISTENING');
    s.transition('THINKING');
    s.transition('SPEAKING');
    assert.equal(s.transition('ERROR'), true);
    assert.equal(s.transition('IDLE'), true);
    assert.equal(s.transition('SPEAKING'), false, 'ERROR must not jump straight back to speech');
  });
});

describe('mic separation: echo suite, no bleed, gated send (PART 23)', () => {
  test('capture suite + zero-gain monitor + generation-gated send', () => {
    const a = app();
    for (const k of ['echoCancellation: true', 'noiseSuppression: true', 'autoGainControl: true', 'channelCount: 1']) {
      assert.ok(a.includes(k), `mic constraint ${k} required`);
    }
    assert.ok(a.includes('monitorGuard.gain.value = 0'), 'mic monitor must be zero-gain (no speaker bleed)');
    assert.ok(a.includes('micSend.current && connRef.current!.canSend()'), 'mic sends only while intended + connected');
  });

  test('exactly two audio contexts, no legacy constructors', () => {
    const a = app();
    assert.equal((a.match(/new AudioContext\(/g) || []).length, 2, 'one shared playback ctx + one mic ctx');
    assert.ok(!a.includes('webkitAudioContext'), 'no legacy constructors');
  });
});

describe('false barge-in suppression (cut-word guard, PART 11/15)', () => {
  test('interruption requires real mic energy, echo is logged not obeyed', () => {
    const a = app();
    assert.ok(a.includes('BARGE_MIC_RMS_THRESHOLD'), 'threshold constant required');
    assert.ok(a.includes('ampRef.current.mic || 0'), 'decision must read live mic RMS');
    assert.ok(a.includes('BARGE_IGNORED'), 'ignored events must be logged');
    assert.ok(a.includes('falseBargeIgnored'), 'ignored count must be tracked');
  });
});
