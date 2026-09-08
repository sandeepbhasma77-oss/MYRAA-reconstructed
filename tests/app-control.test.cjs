// App control surface: layered discovery, index cache, fuzzy matching,
// guarded launch, fallback, logging. Static checks; live runs hit the agent.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ext = () => fs.readFileSync(path.join(__dirname, '..', 'agent', 'desktop_agent', 'tools_ext.py'), 'utf-8');
const main = () => fs.readFileSync(path.join(__dirname, '..', 'agent', 'desktop_agent', 'main.py'), 'utf-8');
const agentTs = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'agent.ts'), 'utf-8');
const srv = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'server.ts'), 'utf-8');

const NEW_TOOLS = ['findApplication', 'listApplicationMatches', 'refreshApplicationIndex', 'focusApplication'];

describe('app tool surface (OPEN <name>)', () => {
  test('agent REGISTRY exposes the tools', () => {
    const m = main();
    for (const t of NEW_TOOLS) assert.ok(m.includes(`'${t}':`), `main.py missing ${t}`);
  });

  test('permission levels assigned (parity)', () => {
    const e = ext();
    for (const t of NEW_TOOLS) assert.ok(e.includes(`'${t}':`), `TOOL_PERMISSIONS missing ${t}`);
  });

  test('Node DESKTOP_TOOLS + Gemini declarations exist', () => {
    const a = agentTs(), s = srv();
    for (const t of NEW_TOOLS) {
      assert.ok(a.includes(`'${t}'`), `agent.ts missing ${t}`);
      assert.ok(s.includes(`${t}:`), `server.ts missing declaration ${t}`);
    }
  });
});

describe('layered discovery + index cache', () => {
  test('index built once, cached with TTL, refreshed on command', () => {
    const e = ext();
    assert.ok(e.includes('build_application_index'), 'index builder required');
    assert.ok(e.includes('_APP_INDEX_TTL_SEC'), 'TTL required (no per-command rescan)');
    assert.ok(e.includes('refresh_application_index'), 'refresh command required');
  });

  test('all layers scanned: system, startmenu, desktop, apppaths, uninstall, startapps', () => {
    const e = ext();
    for (const layer of ['_scan_system', '_scan_shortcut_dir', '_scan_app_paths', '_scan_uninstall', '_scan_startapps']) {
      assert.ok(e.includes(layer), `layer ${layer} required`);
    }
    assert.ok(e.includes('.application-ref'), '.application-ref shortcuts required');
    assert.ok(e.includes("'.url'") || e.includes('*.url'), '.url shortcuts required');
    assert.ok(e.includes("Desktop', 'desktop', False") || /Desktop.*desktop.*False/.test(e), 'Desktop layer must be non-recursive');
  });

  test('fuzzy matching with confidence + disambiguation question', () => {
    const e = ext();
    assert.ok(e.includes('_match_score'), 'scorer required');
    assert.ok(e.includes('difflib') || e.includes('SequenceMatcher'), 'fuzzy similarity required');
    for (const s of ["'exact'", "'alias'", "'prefix'", "'contains'", "'fuzzy'"]) {
      assert.ok(e.includes(s), `strategy ${s} required`);
    }
    assert.ok(e.includes('Which one should I open?'), 'ambiguity question required');
    assert.ok(e.includes('best_by_name') || e.includes('collapse'), 'cross-source duplicates must collapse to one candidate');
    assert.ok(e.includes("best['score'] < 100"), 'exact/alias-canon hits must launch outright, never ambiguate');
  });
});

describe('guarded launch + fallback + logging', () => {
  test('duplicate guard: one request = one launch', () => {
    const e = ext();
    assert.ok(e.includes('_RECENT_LAUNCHES'), 'recent-launch guard required');
    assert.ok(e.includes('duplicate request suppressed'), 'suppression message required');
  });

  test('Start-search fallback is sanitized, single-Enter, last-resort', () => {
    const e = ext();
    assert.ok(e.includes('_start_search_fallback'), 'fallback required');
    assert.ok(e.includes('exactly once'), 'single-Enter proof required');
    assert.ok(/A-Za-z0-9 .\+_/.test(e), 'allowlist sanitization required');
  });

  test('APP_LAUNCH lifecycle logged', () => {
    const e = ext();
    for (const tag of ['APP_LAUNCH_REQUEST', 'APP_MATCH_FOUND', 'APP_LAUNCH_STARTED', 'APP_LAUNCH_VERIFIED']) {
      assert.ok(e.includes(tag), `log tag ${tag} required`);
    }
  });

  test('per-request diagnostics returned', () => {
    const e = ext();
    for (const f of ['requestedName', 'normalizedName', 'aliasUsed', 'matchingStrategy', 'matchedApplication', 'shortcutPath', 'targetPath', 'launchMethod', 'verificationResult']) {
      assert.ok(e.includes(f), `diagnostic field ${f} required`);
    }
  });

  test('honest verification strings, no false success', () => {
    const e = ext();
    assert.ok(e.includes('Opened {disp}.'), 'success string required');
    assert.ok(e.includes('but Windows did not confirm that it opened'), 'unconfirmed string required');
  });

  test('voice verbs normalized (open/launch/start/run)', () => {
    const e = ext();
    for (const v of ["'open '", "'launch '", "'start '", "'run '"]) {
      assert.ok(e.includes(v), `verb ${v} required in normalize`);
    }
  });
});
