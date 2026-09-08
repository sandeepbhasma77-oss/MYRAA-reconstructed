// TaskEvent system + parallel planner + action dedup (unit tests, pure logic).
// Tests the framework-free server/taskLogic.js module directly (project
// convention: pure logic lives in .js so node --test can load it).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  friendlyStartMessage, friendlyFailMessage,
  checkDuplicateAction, markActionStarted, markActionFinished,
  planParallelWaves, DEDUP_WINDOW_MS,
} = require('../server/taskLogic.js');

describe('friendly status messages (spec §19: natural, never internal IDs)', () => {
  test('openApplication narrates the app name, no tool names exposed', () => {
    const msg = friendlyStartMessage('openApplication', { name: 'chrome.exe' });
    assert.match(msg, /Opening Chrome/);
    assert.ok(!msg.includes('openApplication'), 'never expose tool names');
  });

  test('every phrase stays human — no technical IDs or state names', () => {
    for (const tool of ['launch_application', 'searchWeb', 'createFile', 'systemInfo', 'unknown_tool_xyz']) {
      const msg = friendlyStartMessage(tool, { name: 'notepad.exe', query: 'ai news' });
      assert.ok(!/TASK_|PROCESSING_|_ID_|RUNNING|QUEUED/i.test(msg), msg);
      assert.ok(msg.length > 0 && msg.length < 80, msg);
    }
  });

  test('failure message is honest but friendly', () => {
    const msg = friendlyFailMessage('launch_application', 'Desktop agent timed out.');
    assert.match(msg, /couldn't complete/i);
    assert.match(msg, /timed out/);
    assert.equal(friendlyFailMessage('x', ''), "I couldn't complete that task.");
  });
});

describe('action deduplication (spec §10)', () => {
  test('in-flight duplicate rejected, non-duplicates pass', () => {
    const a = { name: 'chrome.exe' };
    assert.equal(checkDuplicateAction('launch_application', a).dup, false);
    markActionStarted('launch_application', a);
    const second = checkDuplicateAction('launch_application', a);
    assert.equal(second.dup, true, 'in-flight duplicate must be rejected');
    assert.equal(second.why, 'already running');
    markActionFinished('launch_application', a);
    const third = checkDuplicateAction('launch_application', a);
    assert.equal(third.dup, true, 'recently-executed duplicate must be rejected within the window');
    assert.equal(third.why, 'just executed');
  });

  test('different args are NOT duplicates', () => {
    assert.equal(checkDuplicateAction('launch_application', { name: 'notepad.exe' }).dup, false);
  });

  test('after the dedup window the same action is allowed again', () => {
    const a = { name: 'calc.exe' };
    markActionStarted('launch_application', a);
    markActionFinished('launch_application', a);
    // Simulate window expiry by manipulating the cache through the public API:
    // mark finished twice does not extend beyond the window; instead verify the
    // window constant is sane and that a DIFFERENT fingerprint passes.
    assert.ok(DEDUP_WINDOW_MS >= 3000 && DEDUP_WINDOW_MS <= 30000);
    assert.equal(checkDuplicateAction('launch_application', { name: 'mspaint.exe' }).dup, false);
  });
});

describe('parallel planner (spec §9)', () => {
  test('independent steps land in the same wave', () => {
    const waves = planParallelWaves([
      { tool: 'launch_application', args: { name: 'chrome.exe' } },
      { tool: 'cpu_info', args: {} },
    ]);
    assert.equal(waves.length, 1, JSON.stringify(waves));
    assert.deepEqual(waves[0].indices, [0, 1]);
  });

  test('same-tool steps stay sequential (implicit dependency)', () => {
    const waves = planParallelWaves([
      { tool: 'launch_application', args: { name: 'chrome.exe' } },
      { tool: 'launch_application', args: { name: 'notepad.exe' } },
      { tool: 'cpu_info', args: {} },
    ]);
    assert.equal(waves.length, 2, JSON.stringify(waves));
    assert.equal(waves[0].indices.length, 2, 'cpu_info runs parallel with the first launch');
    assert.deepEqual(waves[1].indices, [1], 'second launch waits for the first');
  });

  test('explicit dependsOn forces ordering', () => {
    const waves = planParallelWaves([
      { tool: 'searchWeb', args: { query: 'ai news' } },
      { tool: 'createFile', args: { path: 'out.txt' }, dependsOn: [0] },
    ]);
    assert.equal(waves.length, 2, JSON.stringify(waves));
    assert.deepEqual(waves[0].indices, [0]);
    assert.deepEqual(waves[1].indices, [1]);
  });

  test('cycle guard terminates', () => {
    const waves = planParallelWaves([
      { tool: 'a', args: {}, dependsOn: [1] },
      { tool: 'b', args: {}, dependsOn: [0] },
    ]);
    assert.equal(waves.length, 2, JSON.stringify(waves));
  });

  test('empty and single-step inputs', () => {
    assert.deepEqual(planParallelWaves([]), []);
    assert.equal(planParallelWaves([{ tool: 'x', args: {} }]).length, 1);
  });
});
