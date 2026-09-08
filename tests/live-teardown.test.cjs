// Regression test (TASK 1): one /live session disconnect must not kill the backend.
// Spins the built server as a child on :3000 with an EMPTY data dir (no API key),
// connects /live, gets the NO_API_KEY error, destroys the socket abruptly,
// then asserts /api/status still answers. Skips if :3000 is already in use.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'dist', 'server.cjs');

async function portFree() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/status', { signal: AbortSignal.timeout(3000) });
    await res.text().catch(() => {});
    return false;
  } catch { return true; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('live teardown containment', () => {
  test('abrupt /live close keeps backend alive', async () => {
    if (!fs.existsSync(SERVER)) { console.log('skip: dist/server.cjs not built'); return; }
    if (!(await portFree())) { console.log('skip: :3000 busy'); return; }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myraa-test-'));
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', MYRAA_DATA_DIR: dataDir },
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      let up = false;
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch('http://127.0.0.1:3000/api/status', { signal: AbortSignal.timeout(2000) });
          if (r.ok) { up = true; break; }
        } catch { /* booting */ }
        await sleep(1000);
      }
      assert.ok(up, 'backend did not boot');
      assert.equal(child.exitCode, null, 'backend exited during boot');

      // Abrupt /live teardown with no API key configured.
      const Ws = require('ws');
      await new Promise((resolve) => {
        const ws = new Ws('ws://127.0.0.1:3000/live');
        ws.on('message', (d) => {
          const m = JSON.parse(d.toString());
          if (m.type === 'error') ws._socket.destroy();
        });
        ws.on('close', () => resolve());
        setTimeout(resolve, 15000);
      });
      await sleep(2000);
      assert.equal(child.exitCode, null, 'backend died after session disconnect');
      const st = await fetch('http://127.0.0.1:3000/api/status', { signal: AbortSignal.timeout(5000) });
      assert.ok(st.ok, 'backend not answering after session disconnect');
    } finally {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
