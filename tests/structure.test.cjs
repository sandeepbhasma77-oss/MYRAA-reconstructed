const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('project structure (reconstruction contract)', () => {
  for (const f of [
    'package.json', 'vite.config.ts', 'index.html', 'electron-builder.yml',
    'electron/main.cjs', 'electron/preload.cjs', 'electron/splash.html',
    'electron/launcher.cs', 'server/server.ts', 'server/paths.ts',
    'server/memory.ts', 'server/agent.ts', 'server/proxy.ts',
    'src/App.tsx', 'src/main.tsx', 'src/api.ts',
    'agent/desktop_agent/main.py', 'agent/desktop_agent/tools.py',
    'build/icon.ico', 'assets/idle.mp4',
  ]) {
    test(`exists: ${f}`, () => assert.ok(fs.existsSync(path.join(ROOT, f)), f));
  }
});

describe('recovered baseline preserved', () => {
  test('recovered server bundle present', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'recovered', 'dist', 'server.cjs')));
  });
  test('package identity matches original', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.equal(pkg.name, 'myraa');
    assert.equal(pkg.version, '1.0.0');
  });
});
