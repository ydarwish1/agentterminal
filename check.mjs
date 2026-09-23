
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');

let failed = 0;
const G = (s) => '\x1b[32m' + s + '\x1b[0m';
const Rd = (s) => '\x1b[31m' + s + '\x1b[0m';
const DIM = (s) => '\x1b[2m' + s + '\x1b[0m';

function ok(name, cond, detail) {
  console.log('  ' + (cond ? G('PASS') : Rd('FAIL')) + '  ' + name + (detail ? DIM('  ' + detail) : ''));
  if (!cond) failed++;
  return cond;
}

console.log('\n  Agent Console — check\n');

const pageGuard = (PAGE.match(/var GUARD = '([^']+)'/) || [])[1];
const srvGuard = (SERVER.match(/guardHeader: '([^']+)'/) || [])[1];
ok('page and server agree on the guard header',
   Boolean(pageGuard) && pageGuard === srvGuard,
   'page=' + pageGuard + ' server=' + srvGuard);

const blocks = [...PAGE.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const script = blocks.join('\n');
let parsed = false;
try {
  new vm.Script(script, { filename: 'index.html <script>' });
  parsed = true;
} catch (err) {
  ok('the page script parses', false, String(err.message));
}
if (parsed) ok('the page script parses', true, blocks.length + ' block(s), ' + script.split('\n').length + ' lines');

const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
  'do', 'else', 'try', 'delete', 'void', 'in', 'of', 'case', 'await', 'yield',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'Promise', 'Set', 'Map', 'WeakMap', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'fetch', 'alert', 'confirm', 'prompt', 'atob', 'btoa', 'getComputedStyle', 'matchMedia',
  'EventSource', 'WebSocket', 'AbortController', 'URLSearchParams', 'URL', 'Blob',
  'TextEncoder', 'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'DataView', 'Intl',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'CustomEvent', 'Event',
  'Image', 'FormData', 'Headers', 'Request', 'Response', 'DOMParser', 'Node', 'Element',
  'HTMLElement', 'CanvasRenderingContext2D', 'Terminal', 'FitAddon', 'localStorage',
  'sessionStorage', 'console', 'window', 'document', 'navigator', 'location', 'history',
]);

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let k = i + 1;
      while (k < n) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === quote) { k++; break; }
        k++;
      }
      for (let j = i; j < Math.min(k, n); j++) out += src[j] === '\n' ? '\n' : ' ';
      i = Math.min(k, n);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const code = stripCommentsAndStrings(script);

const declared = new Set();
for (const re of [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g,
  /\b([A-Za-z_$][\w$]*)\s*=\s*function\b/g,
  /\b([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>/g,
  /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  /\bfunction\s*\(([^)]*)\)/g,
]) {
  for (const m of code.matchAll(re)) {
    for (const part of String(m[1]).split(',')) {
      const n = part.trim().replace(/[^\w$].*$/, '');
      if (n) declared.add(n);
    }
  }
}

const called = new Set();
for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[2]);

const undefinedCalls = [...called].filter((n) => !declared.has(n) && !GLOBALS.has(n)).sort();
ok('every function the page calls is defined',
   undefinedCalls.length === 0,
   undefinedCalls.length ? 'missing: ' + undefinedCalls.join(', ') : 'none missing');

function stmtOf(name) {
  const m = new RegExp('\\bvar\\s+' + name + '\\s*=[^;]*;').exec(code);
  return m ? script.slice(m.index, m.index + m[0].length) : null;
}
function fnOf(name) {
  const at = code.indexOf('function ' + name + '(');
  const open = at === -1 ? -1 : code.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return script.slice(at, k + 1);
  }
  return null;
}

let arrivalOk = false;
let arrival = '';
try {
  const parts = {
    COLS: stmtOf('COLS'),
    NEWCS: stmtOf('NEWCS'),
    DEFLAY: stmtOf('DEFLAY'),
    recIn: fnOf('recIn'),
    wsDefaultLayout: fnOf('wsDefaultLayout'),
  };
  const absent = Object.keys(parts).filter((k) => !parts[k]);
  if (absent.length) throw new Error('not found in index.html: ' + absent.join(', '));

  const ctx = vm.createContext({});
  vm.runInContext(Object.values(parts).join('\n'), ctx, { filename: 'index.html layout engine' });
  for (const name of ['COLS', 'ROWS', 'ROWSMAX', 'MINCS', 'MINRS', 'NEWCS', 'NEWRS']) {
    if (!Number.isFinite(ctx[name])) throw new Error(name + ' did not evaluate to a number');
  }
  if (typeof ctx.wsDefaultLayout !== 'function') throw new Error('wsDefaultLayout is not a function');
  const { COLS, ROWS, ROWSMAX, MINCS, MINRS, NEWCS, NEWRS } = ctx;

  const fits = Math.max(1, Math.floor(COLS / NEWCS)) * Math.max(1, Math.floor(ROWSMAX / NEWRS));
  const bad = [];
  for (const wsid of ['main', 'ws2']) {
    for (let n = 1; n <= fits + 3 && !bad.length; n++) {
      const tiles = [];
      for (let i = 0; i < n; i++) tiles.push({ id: 't' + i, kind: 'harness' });
      const got = ctx.wsDefaultLayout({ id: wsid, tiles: tiles }).widgets;
      const where = wsid + ' with ' + n + ' tile(s)';
      if (got.length !== n) { bad.push(where + ': laid out ' + got.length); break; }
      for (const w of got) {
        const at = where + ', ' + w.id + ' = ' + w.cs + 'x' + w.rs + ' at c' + w.c + ' r' + w.r;
        if (!(w.rs < ROWS)) bad.push(at + ': arrives FULL HEIGHT (rs is not below ROWS ' + ROWS + ')');
        else if (!(w.cs < COLS)) bad.push(at + ': arrives FULL WIDTH (cs is not below COLS ' + COLS + ')');
        else if (w.cs < MINCS || w.rs < MINRS) bad.push(at + ': under the ' + MINCS + 'x' + MINRS + ' floor');
        else if (w.c < 0 || w.c + w.cs > COLS) bad.push(at + ': off the board sideways');
        else if (w.r < 0 || w.r + w.rs > ROWSMAX) bad.push(at + ': past ROWSMAX ' + ROWSMAX);
        if (bad.length) break;
      }
      for (let a = 0; a < got.length && !bad.length && n <= fits; a++) {
        for (let b = a + 1; b < got.length; b++) {
          const p = got[a], q = got[b];
          if (p.c < q.c + q.cs && q.c < p.c + p.cs && p.r < q.r + q.rs && q.r < p.r + p.rs) {
            bad.push(where + ': ' + p.id + ' and ' + q.id + ' arrive on top of each other');
            break;
          }
        }
      }
    }
    if (bad.length) break;
  }
  arrivalOk = bad.length === 0;
  arrival = bad.length
    ? bad[0]
    : 'arrives ' + NEWCS + 'x' + NEWRS + ' on a ' + COLS + 'x' + ROWS + ' board, ' + fits + ' clear of each other';
} catch (err) {
  arrival = String(err.message);
}
ok('a new tile arrives adjustable, not filling the board', arrivalOk, arrival);

const PORT = 5200 + (process.pid % 700);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-check-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK, { recursive: true });
const CFG = path.join(TMP, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({
  port: PORT, bindHost: '127.0.0.1', workRoots: [WORK], defaultCwd: WORK, agents: [],
}));

const child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
  cwd: HERE,
  env: Object.assign({}, process.env, {
    AGENT_CONSOLE_CONFIG: CFG,
    AGENT_CONSOLE_STATE_DIR: path.join(TMP, 'state'),
    AGENT_CONSOLE_PORT: String(PORT),
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (b) => { log += b; });
child.stderr.on('data', (b) => { log += b; });

const BASE = 'http://127.0.0.1:' + PORT;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(BASE + '/api/status')).ok) { up = true; break; }
  } catch (err) { }
  await new Promise((r) => setTimeout(r, 250));
}
ok('the server starts and answers', up, up ? 'port ' + PORT : log.slice(-300));

if (up) {
  const status = await (await fetch(BASE + '/api/status')).json();
  ok('the terminal backend loaded', status.pty === 'ok',
     status.pty === 'ok' ? '' : 'node-pty is missing — run npm install');

  const installed = Object.entries(status.harnesses || {}).filter(([, h]) => h.installed);
  ok('at least one coding CLI is installed', installed.length > 0,
     installed.length ? installed.map(([k]) => k).join(', ')
       : 'none of ' + Object.keys(status.harnesses || {}).join(', ') + ' are on PATH');

  if (status.pty === 'ok' && installed.length) {
    const harness = installed[0][0];
    const id = harness + '-chk01';
    const start = await fetch(BASE + '/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [pageGuard]: '1' },
      body: JSON.stringify({ session: id, harness, cwd: WORK, cols: 80, rows: 24 }),
    });
    const started = ok('a real terminal starts, using the header the page sends',
                       start.status === 200, 'status ' + start.status);
    if (started) {
      await new Promise((r) => setTimeout(r, 1500));
      const s2 = await (await fetch(BASE + '/api/status')).json();
      const sess = s2.sessions[id];
      ok('the terminal has a live pid', Boolean(sess && sess.running && sess.pid),
         sess ? 'pid ' + sess.pid : 'no session');
      await fetch(BASE + '/api/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [pageGuard]: '1' },
        body: JSON.stringify({ session: id }),
      });
    }
  }
}

child.kill('SIGTERM');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { }

console.log();
if (failed) {
  console.log('  ' + Rd(failed + ' check(s) failed') + ' — the console will not work correctly.\n');
  process.exit(1);
}
console.log('  ' + G('all checks passed') + ' — the page and the server agree and a real terminal ran.\n');
