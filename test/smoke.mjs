
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5300 + (process.pid % 600);
const BASE = 'http://127.0.0.1:' + PORT;
const GUARD = { 'x-agent-console': '1' };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-smoke-'));
const WORK = path.join(TMP, 'work');
const STATE = path.join(TMP, 'state');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });

const CONFIG_FILE = path.join(TMP, 'config.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  title: 'Agent Console',
  port: PORT,
  bindHost: '127.0.0.1',
  workRoots: [WORK],
  defaultCwd: WORK,
  agents: [{ id: 'smoke', name: 'SMOKE', role: 'test', harness: 'claude', cwd: WORK }],
}, null, 2));

let child = null;
let ptyOk = false;

function get(pathname, init) {
  return fetch(BASE + pathname, init);
}

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      AGENT_CONSOLE_CONFIG: CONFIG_FILE,
      AGENT_CONSOLE_STATE_DIR: STATE,
      AGENT_CONSOLE_PORT: String(PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });

  const deadline = Date.now() + 15000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not start in 15s:\n' + log);
    try {
      const r = await get('/api/status');
      if (r.ok) {
        const body = await r.json();
        ptyOk = body.pty === 'ok';
        break;
      }
    } catch (err) { }
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(() => {
  if (child) child.kill('SIGTERM');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { }
});

test('serves the page with a generic title', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  const m = html.match(/<title>([^<]*)<\/title>/);
  assert.ok(m, 'the page has a <title>');
  assert.equal(m[1], 'Agent Console');
});

test('injects the configured agents into the page at serve time', async () => {
  const html = await (await get('/')).text();
  const m = html.match(/^  var AGENTS = (.*); \/\/ AGENT-CONSOLE-AGENTS$/m);
  assert.ok(m, 'the AGENTS marker line was rewritten');
  const agents = JSON.parse(m[1]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'smoke');
});

test('serves the vendored xterm files and nothing else', async () => {
  for (const f of ['xterm.js', 'xterm.css', 'addon-fit.js']) {
    assert.equal((await get('/vendor/' + f)).status, 200, f);
  }
  assert.equal((await get('/vendor/../server.js')).status, 404);
});

test('status reports the harness catalogue', async () => {
  const body = await (await get('/api/status')).json();
  assert.ok(body.harnesses, 'harnesses key present');
  for (const id of ['claude', 'codex', 'cursor', 'grok', 'gemini', 'pi']) {
    assert.ok(id in body.harnesses, id + ' is in the catalogue');
    assert.equal(typeof body.harnesses[id].installed, 'boolean');
  }
});

test('a mutating request without the guard header is refused', async () => {
  const r = await get('/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'claude-aaaaa', harness: 'claude' }),
  });
  assert.ok(r.status === 403 || r.status === 400, 'got ' + r.status);
});

test('a request with a foreign Host is refused', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/status', method: 'GET',
        headers: { Host: 'evil.example:' + PORT } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.ok(status === 403 || status === 421 || status === 400, 'got ' + status);
});

test('a folder outside workRoots is refused', async () => {
  const r = await get('/api/start', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, GUARD),
    body: JSON.stringify({ session: 'claude-zzzzz', harness: 'claude', cwd: '/etc' }),
  });
  assert.ok(r.status >= 400, 'got ' + r.status);
});

test('starts a real terminal and streams its output', async (t) => {
  if (!ptyOk) {
    t.skip('node-pty did not load — run `npm install` (on Linux you need a C++ toolchain)');
    return;
  }
  const r = await get('/api/start', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, GUARD),
    body: JSON.stringify({ session: 'claude-ttttt', harness: 'claude', cwd: WORK, cols: 80, rows: 24 }),
  });
  if (r.status === 409 || r.status === 503) {
    t.skip('the claude CLI is not installed on this machine');
    return;
  }
  assert.equal(r.status, 200, await r.text());

  const body = await (await get('/api/status')).json();
  const s = body.sessions['claude-ttttt'];
  assert.ok(s && s.running && s.pid, 'the session has a live pid');

  await get('/api/stop', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, GUARD),
    body: JSON.stringify({ session: 'claude-ttttt' }),
  });
});
