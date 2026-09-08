// Part 3/10/12 regression: user file-access + drive tools must exist in the
// agent registry, permission map, Node tool set, and Gemini declarations.
// Static checks only — live behavior is covered by the acceptance probes.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = ['file_exists', 'file_info', 'find_file', 'search_drive'];

describe('file access + drive tool surface (PART 3/10)', () => {
  test('agent REGISTRY exposes the tools', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'agent', 'desktop_agent', 'main.py'), 'utf-8');
    for (const t of REQUIRED) assert.ok(main.includes(`'${t}':`), `main.py missing ${t}`);
  });

  test('permission levels assigned (parity)', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'agent', 'desktop_agent', 'tools_ext.py'), 'utf-8');
    for (const t of REQUIRED) assert.ok(ext.includes(`'${t}':`), `TOOL_PERMISSIONS missing ${t}`);
  });

  test('Node DESKTOP_TOOLS declares the tools', () => {
    const agent = fs.readFileSync(path.join(__dirname, '..', 'server', 'agent.ts'), 'utf-8');
    for (const t of REQUIRED) assert.ok(agent.includes(`'${t}'`), `agent.ts missing ${t}`);
  });

  test('Gemini function declarations exist (AI can call them)', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.ts'), 'utf-8');
    for (const t of REQUIRED) assert.ok(srv.includes(`${t}:`), `server.ts missing declaration ${t}`);
  });

  test('friendly+filename resolution ("save X on my desktop")', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'agent', 'desktop_agent', 'tools_ext.py'), 'utf-8');
    assert.ok(ext.includes('friendly+filename'), 'resolve_path must keep the filename from the sentence');
  });

  test('app discovery covers registry + store (PART 5)', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'agent', 'desktop_agent', 'tools_ext.py'), 'utf-8');
    assert.ok(ext.includes('Uninstall'), 'find_windows_app must search installed-apps registry (Method 4)');
    assert.ok(ext.includes('Get-StartApps'), 'app discovery must support Store/AppX (Method 5)');
  });
});
