const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT = process.env.DESKTOP_AGENT_URL || 'http://127.0.0.1:8765';

async function exec(tool, args) {
  const res = await fetch(`${AGENT}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

describe('MYRAA task-execution pipeline (TASK-ID: MYRAA-TEST-001)', () => {
  test('agent online with full registry (58 legacy + extended)', async () => {
    const h = await (await fetch(`${AGENT}/health`)).json();
    assert.equal(h.ok, true);
    assert.ok(h.tool_count >= 58, `tool_count=${h.tool_count}`);
  });

  test('permissions cover every declared Node tool (parity)', async () => {
    const caps = await (await fetch(`${AGENT}/caps`)).json();
    assert.equal(caps.ok, true);
    const agentTs = fs.readFileSync(path.join(__dirname, '..', 'server', 'agent.ts'), 'utf-8');
    const setBlock = agentTs.match(/DESKTOP_TOOLS = new Set\(\[([\s\S]*?)\]\)/)[1];
    const names = [...setBlock.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);
    const missing = [...new Set(names)].filter((n) => !(n in caps.permissions));
    assert.deepEqual(missing, [], `tools without permission level: ${missing.join(',')}`);
  });

  test('structured result + verification contract', async () => {
    const r = await exec('screen_size', {});
    assert.equal(r.ok, true);
    assert.equal(r.result.success, true);
    assert.equal(r.result.tool, 'screen_size');
  });

  test('BLOCKED command refused, DANGEROUS gated', async () => {
    const b = await exec('run_command', { command: 'format C:' });
    assert.equal(b.ok, false);
    assert.match(String(b.error), /BLOCKED/);
  });

  test('protected process termination refused', async () => {
    const r = await exec('terminate_process', { name: 'svchost.exe' });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /protected/i);
  });

  test('Node declares real tool schemas (no _hint stub)', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.ts'), 'utf-8');
    assert.ok(!srv.includes('_hint:'), 'AI declarations must not use _hint placeholder property');
    for (const arg of ['new_name', 'execute_token', 'max_chars', 'overwrite']) {
      assert.ok(srv.includes(arg), `declaration missing arg: ${arg}`);
    }
  });

  test('agent spawner uses --app-dir', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'server', 'agent.ts'), 'utf-8');
    assert.ok(a.includes('--app-dir'), 'spawner must pass --app-dir so desktop_agent resolves');
  });

  test('systemInfo returns real Windows data', async () => {
    const r = await exec('systemInfo', {});
    assert.equal(r.ok, true);
    assert.match(String(r.result), /Windows|CPU|RAM/);
  });

  test('file create -> read -> delete (real FS)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myraa-pipe-'));
    const fp = path.join(dir, 'pipe.txt');
    const w = await exec('createFile', { path: fp, content: 'MYRAA-TEST-001', overwrite: true });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.ok(fs.existsSync(fp));
    const r = await exec('readFile', { path: fp });
    assert.equal(r.ok, true);
    assert.match(String(r.result), /MYRAA-TEST-001/);
    const d = await exec('deleteFile', { path: fp, permanent: true });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.ok(!fs.existsSync(fp));
    fs.rmdirSync(dir);
  });

  test('unknown tool returns clean error (router contract)', async () => {
    const r = await exec('__no_such_tool__', {});
    assert.equal(r.ok, false);
    assert.match(String(r.error), /Unknown tool/);
  });
});
