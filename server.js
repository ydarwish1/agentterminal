
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const NUL = String.fromCharCode(0);

function readJson(file, optional) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (optional && err && err.code === 'ENOENT') return null;
    console.error('[agent-console] cannot read ' + file + ': ' + String(err.message || err));
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[agent-console] ' + file + ' is not valid JSON: ' + String(err.message || err));
    console.error('[agent-console] fix it, or delete it to fall back to the defaults.');
    process.exit(1);
  }
}

const DEFAULTS = readJson(path.join(__dirname, 'config.default.json'), false) || {};
const USER = readJson(process.env.AGENT_CONSOLE_CONFIG || path.join(__dirname, 'config.json'), true) || {};

function opt(key, fallback) {
  if (USER[key] !== undefined && USER[key] !== null && USER[key] !== '') return USER[key];
  if (DEFAULTS[key] !== undefined && DEFAULTS[key] !== null && DEFAULTS[key] !== '') return DEFAULTS[key];
  return fallback;
}

(function loadDotEnv() {
  let raw;
  try { raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch (err) { return; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = t.slice(eq + 1).trim();
  }
})();

const STATE_DIR = process.env.AGENT_CONSOLE_STATE_DIR || path.join(os.homedir(), '.agent-console');
const WORK_ROOT = path.join(STATE_DIR, 'work');

const HARNESSES = Object.assign({}, DEFAULTS.harnesses || {}, USER.harnesses || {});

const AGENTS = (opt('agents', []) || []).filter(function (a) {
  return a && typeof a.id === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(a.id) && HARNESSES[a.harness];
});
for (const a of (opt('agents', []) || [])) {
  if (AGENTS.indexOf(a) === -1) {
    console.warn('[agent-console] ignoring agent ' + JSON.stringify(a && a.id) + ': ' +
      (a && a.harness && !HARNESSES[a.harness]
        ? 'no harness named "' + a.harness + '" (have: ' + Object.keys(HARNESSES).join(', ') + ')'
        : 'needs an id of lowercase letters, digits and dashes, and a known harness'));
  }
}
const AGENT_IDS = AGENTS.map(function (a) { return a.id; });
const AGENT_BY_ID = {};
for (const a of AGENTS) AGENT_BY_ID[a.id] = a;

const WORK_ROOTS = (opt('workRoots', []) || []).map(function (p) { return String(p); })
  .filter(Boolean).concat([WORK_ROOT]);

const LIMITS = Object.assign({}, DEFAULTS.limits || {}, USER.limits || {});

const CONFIG = {
  title: opt('title', 'Agent Console'),

  home: process.env.AGENT_CONSOLE_HOME || path.join(STATE_DIR, 'home'),
  oauthTokenFile: opt('oauthTokenFile', null),
  oauthTokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
  mirrorSettingsFile: opt('mirrorSettingsFile', null),
  mirrorSettingKeys: ['model', 'effortLevel', 'hooks'],
  sharedHomeLinks: opt('sharedHomeLinks', []),
  sharedClaudeMdFile: opt('sharedClaudeMdFile', null),

  agentIds: AGENT_IDS,
  agents: AGENTS,

  scrubEnv: ['TELEGRAM_STATE_DIR', 'TELEGRAM_BOT_TOKEN'],
  term: 'xterm-256color',
  colorterm: 'truecolor',
  langIfUnset: 'C.UTF-8',

  colsMin: 20, colsMax: 400, colsDefault: 100,
  rowsMin: 5, rowsMax: 200, rowsDefault: 30,

  ringBytes: LIMITS.ringBytes || 512 * 1024,
  heartbeatMs: 15000,
  killGraceMs: 3000,
  maxInputBytes: 256 * 1024,
  sseMaxBuffer: 4 * 1024 * 1024,
  maxStreams: LIMITS.maxStreams || 32,
  muxMaxSessions: 24,
  streamFetchDest: 'empty',

  guardHeader: 'x-agent-console',
  guardValue: '1',
  allowedHostNames: ['localhost', '127.0.0.1', '[::1]'].concat(
    (opt('allowedHostNames', []) || []).filter(function (n) {
      return n && ['localhost', '127.0.0.1', '[::1]'].indexOf(n) === -1;
    })
  ),

  harnesses: HARNESSES,
  harnessHome: process.env.AGENT_CONSOLE_HARNESS_HOME || os.homedir(),
  harnessPathPrefix: opt('pathPrefix', path.join(os.homedir(), '.local', 'bin')),
  harnessRoots: WORK_ROOTS,
  harnessDefaultCwd: opt('defaultCwd', '') || WORK_ROOTS[0] || WORK_ROOT,
  harnessWorkRoot: WORK_ROOT,
  harnessProjectsRoot: opt('projectsRoot', '') || WORK_ROOTS[0] || WORK_ROOT,
  maxHarnessSessions: LIMITS.maxHarnessSessions || 12,
  harnessProbeMs: 30000,
  privateStartGapMs: 3000,
  harnessScrubEnv: (opt('scrubEnv', []) || []),
  harnessScrubPrefixes: (opt('scrubEnvPrefixes', []) || []),
  dropPrivileges: opt('dropPrivileges', false) === true,

  workspacesFile: process.env.AGENT_CONSOLE_WORKSPACES || path.join(STATE_DIR, 'workspaces.json'),
  maxWorkspacesBytes: 65536,
  maxWorkspaceOpaqueBytes: 16384,
};

const HARNESS_SESSION_RE = new RegExp('^(' + Object.keys(CONFIG.harnesses).join('|') + ')-[a-z0-9]{5}$');
const HARNESS_SHAPE_RE = /^[a-z]+-[a-z0-9]{5}$/;

const PORT = parseInt(process.env.AGENT_CONSOLE_PORT || String(opt('port', 5075)), 10);
const HOST = process.env.AGENT_CONSOLE_HOST || String(opt('bindHost', '127.0.0.1'));
const PAGE = path.join(__dirname, 'index.html');
const VENDOR_DIR = path.join(__dirname, 'vendor');

const ALLOWED_HOSTS = CONFIG.allowedHostNames.map(function (n) { return n + ':' + PORT; });
const ALLOWED_ORIGINS = CONFIG.allowedHostNames.map(function (n) { return 'http://' + n + ':' + PORT; });

const VENDOR = [
  { name: 'xterm.js', type: 'application/javascript; charset=utf-8' },
  { name: 'xterm.css', type: 'text/css; charset=utf-8' },
  { name: 'addon-fit.js', type: 'application/javascript; charset=utf-8' },
];

function msg(err) { return String((err && err.message) || err); }

function privateHomeBin() {
  const def = CONFIG.harnesses.claude;
  return (def && def.bin) || 'claude';
}
function agentStateDir(id) { return path.join(STATE_DIR, 'telegram', id); }

let pty = null;
let ptyError = null;
try {
  pty = require('node-pty');
} catch (err) {
  ptyError = msg(err);
  console.error(
    '[agent-console] node-pty did not load (' + ptyError + '). Serving the page ' +
    'with a "pty backend missing" banner; /api/start will refuse. Fix: run ' +
    '`npm install` in this folder, then start the server again.'
  );
}

const SEED_PROJECT_KEYS = [
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
  'hasCompletedProjectOnboarding',
];

function probeEnv() {
  const env = {
    HOME: CONFIG.home,
    PATH: process.env.PATH || '',
    TERM: CONFIG.term,
  };
  for (const key of CONFIG.scrubEnv) delete env[key];
  scrubClaudeMarkers(env);
  scrubHarnessEnv(env);
  return env;
}

let cliVersion;
function claudeVersion() {
  if (cliVersion !== undefined) return cliVersion;
  cliVersion = null;
  try {
    const out = execFileSync(privateHomeBin(), ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      env: probeEnv(),
    });
    const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(out);
    if (m) cliVersion = m[1];
  } catch (err) {
    console.warn('[agent-console] could not read the claude version (' + msg(err) +
      '); skipping lastOnboardingVersion');
  }
  return cliVersion;
}

function seedHome() {
  fs.mkdirSync(CONFIG.home, { recursive: true, mode: 0o700 });
  const file = path.join(CONFIG.home, '.claude.json');

  let cfg = {};
  let note = 'unchanged';
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cfg = parsed;
      } else {
        console.warn('[agent-console] ' + file + ' was not a JSON object; replacing it');
        note = 'replaced (not an object)';
      }
    } catch (err) {
      console.warn('[agent-console] ' + file + ' is corrupt (' + msg(err) +
        '); replacing it with a fresh seed');
      note = 'replaced (corrupt)';
      cfg = {};
    }
  } else {
    note = 'created';
  }

  let changed = false;
  if (cfg.hasCompletedOnboarding !== true) { cfg.hasCompletedOnboarding = true; changed = true; }
  if (!cfg.theme) { cfg.theme = 'dark'; changed = true; }
  const ver = claudeVersion();
  if (ver && cfg.lastOnboardingVersion !== ver) { cfg.lastOnboardingVersion = ver; changed = true; }

  if (!cfg.projects || typeof cfg.projects !== 'object') { cfg.projects = {}; changed = true; }
  if (!cfg.projects[CONFIG.harnessDefaultCwd] || typeof cfg.projects[CONFIG.harnessDefaultCwd] !== 'object') {
    cfg.projects[CONFIG.harnessDefaultCwd] = {};
    changed = true;
  }
  for (const key of SEED_PROJECT_KEYS) {
    if (cfg.projects[CONFIG.harnessDefaultCwd][key] !== true) {
      cfg.projects[CONFIG.harnessDefaultCwd][key] = true;
      changed = true;
    }
  }

  if (!changed && note === 'unchanged') return 'already seeded';
  writeJsonAtomic(file, cfg);
  return note === 'unchanged' ? 'updated' : note;
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { }
    throw err;
  }
}

function seedSettings() {
  let src;
  try {
    src = JSON.parse(fs.readFileSync(CONFIG.mirrorSettingsFile, 'utf8'));
  } catch (err) {
    return 'no source settings to mirror';
  }
  if (!src || typeof src !== 'object') return 'source settings not an object';

  const dir = path.join(CONFIG.home, '.claude');
  const file = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });

  let ours = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ours = parsed;
  } catch (err) {
    ours = {};
  }

  const set = [];
  const removed = [];
  for (const key of CONFIG.mirrorSettingKeys) {
    if (src[key] === undefined) {
      if (Object.prototype.hasOwnProperty.call(ours, key)) {
        delete ours[key];
        removed.push(key);
      }
      continue;
    }
    if (JSON.stringify(ours[key]) !== JSON.stringify(src[key])) {
      ours[key] = src[key];
      set.push(key);
    }
  }
  if (set.length === 0 && removed.length === 0) return 'settings already mirrored';

  writeJsonAtomic(file, ours);
  const parts = [];
  if (set.length) parts.push('set ' + set.join(', '));
  if (removed.length) parts.push('REMOVED ' + removed.join(', ') + ' (gone from the source file)');
  return parts.join('; ');
}

function linkSharedHome() {
  const dir = path.join(CONFIG.home, '.claude');
  fs.mkdirSync(dir, { recursive: true });

  const made = [];
  const kept = [];
  const skipped = [];

  for (const entry of CONFIG.sharedHomeLinks) {
    const link = path.join(dir, entry.name);

    if (!fs.existsSync(entry.target)) {
      console.warn('[agent-console] shared ' + entry.name + ': target ' + entry.target +
        ' does not exist; not linking it');
      skipped.push(entry.name + ' (no target)');
      continue;
    }

    let st = null;
    try {
      st = fs.lstatSync(link);
    } catch (err) {
      st = null;
    }

    if (st && st.isSymbolicLink()) {
      let current = null;
      try { current = fs.readlinkSync(link); } catch (err) { current = null; }
      if (current === entry.target) {
        kept.push(entry.name);
        continue;
      }
      try {
        fs.unlinkSync(link);
      } catch (err) {
        console.warn('[agent-console] shared ' + entry.name + ': could not replace a link ' +
          'pointing at ' + current + ' (' + msg(err) + ')');
        skipped.push(entry.name + ' (replace failed)');
        continue;
      }
    } else if (st) {
      console.warn('[agent-console] shared ' + entry.name + ': a real ' +
        (st.isDirectory() ? 'directory' : 'file') + ' is at ' + link +
        '; leaving it untouched and NOT linking the source copy');
      skipped.push(entry.name + ' (real file/dir kept)');
      continue;
    }

    try {
      fs.symlinkSync(entry.target, link);
      made.push(entry.name);
    } catch (err) {
      console.warn('[agent-console] shared ' + entry.name + ': symlink failed (' + msg(err) + ')');
      skipped.push(entry.name + ' (symlink failed)');
    }
  }

  const parts = [];
  if (made.length) parts.push('linked ' + made.join(', '));
  if (kept.length) parts.push('already linked ' + kept.join(', '));
  if (skipped.length) parts.push('SKIPPED ' + skipped.join('; '));
  return parts.length ? parts.join(' | ') : 'nothing to link';
}

function mirrorClaudeMd() {
  let srcBytes;
  try {
    srcBytes = fs.readFileSync(CONFIG.sharedClaudeMdFile);
  } catch (err) {
    return 'no source CLAUDE.md to mirror';
  }

  const dir = path.join(CONFIG.home, '.claude');
  const file = path.join(dir, 'CLAUDE.md');
  fs.mkdirSync(dir, { recursive: true });

  let st = null;
  try { st = fs.lstatSync(file); } catch (err) { st = null; }

  let note = 'copied';
  if (st && st.isSymbolicLink()) {
    let current = null;
    try { current = fs.readlinkSync(file); } catch (err) { current = null; }
    console.warn('[agent-console] CLAUDE.md was a symlink to ' + current + '; removing it ' +
      'and writing a private copy - a `#` memory write through that link would have ' +
      'edited the instruction file every agent on this box loads');
    fs.unlinkSync(file);
    note = 'replaced a symlink with a private copy';
  } else if (st && st.isDirectory()) {
    console.warn('[agent-console] CLAUDE.md is a DIRECTORY at ' + file +
      '; leaving it alone and not mirroring');
    return 'SKIPPED (a directory is at ' + file + ')';
  } else if (st) {
    let ourBytes = null;
    try { ourBytes = fs.readFileSync(file); } catch (err) { ourBytes = null; }
    if (ourBytes && ourBytes.equals(srcBytes)) return 'CLAUDE.md already mirrored';
    note = 'refreshed';
  }

  const tmp = file + '.tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, srcBytes);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { }
    throw err;
  }
  return 'CLAUDE.md ' + note + ' (' + srcBytes.length + ' bytes)';
}

function readToken() {
  try {
    if (!CONFIG.oauthTokenFile) return '';
    return fs.readFileSync(CONFIG.oauthTokenFile, 'utf8').replace(/\s/g, '');
  } catch (err) {
    return '';
  }
}

function authState() {
  return readToken() ? 'token' : 'none';
}

function makeSession(id, spec) {
  return {
    id: id,
    spec: spec,
    proc: null,
    pid: null,
    startedAt: null,
    cols: null,
    rows: null,
    auth: null,
    lastExit: null,
    starting: false,
    queued: false,
    cancelQueued: false,
    ring: [],
    ringSize: 0,
    epoch: 0,
    seq: 0,
    streams: new Set(),
    exitWaiters: [],
  };
}

const SESSIONS = {};
for (const a of CONFIG.agents) {
  const def = CONFIG.harnesses[a.harness];
  const args = (def.args || []).slice();
  if (a.telegram && a.telegram.tokenEnv && def.telegramChannel) {
    args.push('--channels', def.telegramChannel);
  }
  SESSIONS[a.id] = makeSession(a.id, {
    kind: 'agent',
    harness: a.harness,
    command: def.bin,
    args: args,
    cwd: a.cwd || CONFIG.harnessDefaultCwd,
    agent: a,
  });
}
SESSIONS.classic = makeSession('classic', {
  kind: 'classic',
  command: (CONFIG.harnesses.claude && CONFIG.harnesses.claude.bin) || 'claude',
  args: ((CONFIG.harnesses.claude && CONFIG.harnesses.claude.args) || []).slice(),
  cwd: CONFIG.harnessDefaultCwd,
});
function sessionIds() { return Object.keys(SESSIONS); }

function ringPush(sess, buf) {
  if (!buf || buf.length === 0) return;
  sess.seq += buf.length;
  sess.ring.push(buf);
  sess.ringSize += buf.length;
  while (sess.ringSize > CONFIG.ringBytes && sess.ring.length) {
    const over = sess.ringSize - CONFIG.ringBytes;
    const head = sess.ring[0];
    if (head.length <= over) {
      sess.ring.shift();
      sess.ringSize -= head.length;
    } else {
      sess.ring[0] = head.subarray(over);
      sess.ringSize -= over;
    }
  }
}

function ringBuffer(sess) {
  return sess.ring.length ? Buffer.concat(sess.ring, sess.ringSize) : Buffer.alloc(0);
}

const MUX_STREAMS = new Set();

function muxCursor(sess) {
  return sess.epoch + '.' + sess.seq;
}

function muxLine(id, cursor, payload) {
  return id + ' ' + cursor + ' ' + payload;
}

function muxWrite(reader, event, id, cursor, payload) {
  try {
    reader.res.write('event: ' + event + '\ndata: ' + muxLine(id, cursor, payload) + '\n\n');
    if (reader.res.writableLength > CONFIG.sseMaxBuffer) {
      console.warn('[agent-console] mux SSE client buffered ' + reader.res.writableLength +
        ' bytes (> ' + CONFIG.sseMaxBuffer + '); dropping it, it can reconnect');
      MUX_STREAMS.delete(reader);
      reader.res.destroy();
    }
  } catch (err) {
    MUX_STREAMS.delete(reader);
  }
}

function muxBroadcast(sess, event, data) {
  if (MUX_STREAMS.size === 0) return;
  for (const reader of Array.from(MUX_STREAMS)) {
    if (!reader.ids.has(sess.id)) continue;
    muxWrite(reader, event, sess.id, muxCursor(sess), data);
  }
}

function streamCount() {
  let n = 0;
  for (const id of sessionIds()) n += SESSIONS[id].streams.size;
  return n + MUX_STREAMS.size;
}

function sseWrite(sess, res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + data + '\n\n');
    if (res.writableLength > CONFIG.sseMaxBuffer) {
      console.warn('[agent-console] SSE client on ' + sess.id + ' buffered ' + res.writableLength +
        ' bytes (> ' + CONFIG.sseMaxBuffer + '); dropping it, it can reconnect');
      sess.streams.delete(res);
      res.destroy();
    }
  } catch (err) {
    sess.streams.delete(res);
  }
}

function broadcast(sess, event, data) {
  for (const res of Array.from(sess.streams)) sseWrite(sess, res, event, data);
  muxBroadcast(sess, event, data);
}

function clampInt(value, lo, hi, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function scrubClaudeMarkers(env) {
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|AI_AGENT)/.test(key)) delete env[key];
  }
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
}

function prepareClassic() {
  let seeded;
  try {
    seeded = seedHome();
  } catch (err) {
    if (err && typeof err === 'object') err.claudeTermStep = 'HOME seeding';
    throw err;
  }
  console.log('[agent-console] classic HOME ' + CONFIG.home + ' seed: ' + seeded);
  let mirrored;
  try {
    mirrored = seedSettings();
  } catch (err) {
    mirrored = 'FAILED (' + msg(err) + ')';
  }
  console.log('[agent-console] classic settings: ' + mirrored);
  let shared;
  try {
    shared = linkSharedHome();
  } catch (err) {
    shared = 'FAILED (' + msg(err) + ')';
  }
  console.log('[agent-console] classic shared home: ' + shared);
  let globals;
  try {
    globals = mirrorClaudeMd();
  } catch (err) {
    globals = 'FAILED (' + msg(err) + ')';
  }
  console.log('[agent-console] classic globals: ' + globals);

  const env = Object.assign({}, process.env);
  for (const key of CONFIG.scrubEnv) delete env[key];
  scrubClaudeMarkers(env);
  env.TERM = CONFIG.term;
  env.COLORTERM = CONFIG.colorterm;
  if (!env.LANG) env.LANG = CONFIG.langIfUnset;
  env.HOME = CONFIG.home;

  const token = readToken();
  const auth = token ? 'token' : 'none';
  if (token) {
    env[CONFIG.oauthTokenEnv] = token;
  } else {
    delete env[CONFIG.oauthTokenEnv];
    console.warn('[agent-console] no usable token at ' + CONFIG.oauthTokenFile +
      ' - the classic session will open logged out (auth: none)');
  }
  return { env: env, auth: auth };
}

function resolveBin(bin) {
  if (path.isAbsolute(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return fs.statSync(bin).isFile() ? bin : null;
    } catch (err) { return null; }
  }
  const dirs = (CONFIG.harnessPathPrefix + ':' + (process.env.PATH || '')).split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch (err) { }
  }
  return null;
}

let harnessProbe = null;

function harnessTable(force) {
  if (!force && harnessProbe && Date.now() - harnessProbe.at < CONFIG.harnessProbeMs) {
    return harnessProbe.map;
  }
  const map = {};
  for (const id of Object.keys(CONFIG.harnesses)) {
    const bin = resolveBin(CONFIG.harnesses[id].bin);
    map[id] = { installed: !!bin, bin: bin };
  }
  harnessProbe = { at: Date.now(), map: map };
  return map;
}

function harnessCount() {
  let n = 0;
  for (const id of sessionIds()) if (SESSIONS[id].spec.kind === 'harness') n++;
  return n;
}

function underHarnessRoot(real) {
  for (const root of CONFIG.harnessRoots) {
    let rr;
    try { rr = fs.realpathSync(root); } catch (err) { continue; }
    if (real === rr) return true;
    if (real.indexOf(rr + path.sep) === 0) return true;
  }
  return false;
}

function harnessCwd(value) {
  if (value === undefined || value === null || value === '') return { cwd: CONFIG.harnessDefaultCwd };
  if (typeof value !== 'string') return { reason: 'not a string' };
  if (value.length > 512) return { reason: 'longer than 512 characters' };
  if (!path.isAbsolute(value)) return { reason: 'not an absolute path' };
  let real;
  try {
    real = fs.realpathSync(value);
  } catch (err) {
    return { reason: 'does not exist' };
  }
  let st;
  try { st = fs.statSync(real); } catch (err) { return { reason: 'does not exist' }; }
  if (!st.isDirectory()) return { reason: 'not a directory' };
  if (!underHarnessRoot(real)) return { reason: 'outside the allowed roots' };
  return { cwd: real };
}

function prepareHarness(sess) {
  const def = CONFIG.harnesses[sess.spec.harness];
  let prep;
  if (def.home === 'private') {
    prep = prepareClassic();
  } else {
    const env = Object.assign({}, process.env);
    for (const key of CONFIG.scrubEnv) delete env[key];
    scrubClaudeMarkers(env);
    delete env[CONFIG.oauthTokenEnv];
    env.HOME = (def.home === 'shared' || !def.home) ? CONFIG.harnessHome : def.home;
    env.TERM = CONFIG.term;
    env.COLORTERM = CONFIG.colorterm;
    if (!env.LANG) env.LANG = CONFIG.langIfUnset;
    env.PATH = CONFIG.harnessPathPrefix + (env.PATH ? ':' + env.PATH : '');
    prep = { env: env, auth: null };
  }
  scrubHarnessEnv(prep.env);
  const ag = sess.spec.agent;
  if (ag && ag.telegram && ag.telegram.tokenEnv) {
    const token = process.env[ag.telegram.tokenEnv];
    if (token) {
      prep.env.TELEGRAM_BOT_TOKEN = token;
      prep.env.TELEGRAM_STATE_DIR = agentStateDir(ag.id);
      try { fs.mkdirSync(prep.env.TELEGRAM_STATE_DIR, { recursive: true }); } catch (err) { }
    }
  }
  return prep;
}

function harnessDrop(sess) {
  if (sess.spec.kind !== 'harness') return null;
  const def = CONFIG.harnesses[sess.spec.harness];
  if (!CONFIG.dropPrivileges) return null;
  if (!def || def.dropToOwner !== true) return null;
  const cwd = sess.spec.cwd;
  if (cwd !== CONFIG.harnessWorkRoot && cwd.indexOf(CONFIG.harnessWorkRoot + path.sep) !== 0) return null;
  try {
    const st = fs.statSync(cwd);
    if (st.uid === 0) return null;
    const rows = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    for (const row of rows) {
      const fields = row.split(':');
      if (fields[2] === String(st.uid)) {
        if (fields.length < 7 || fields[3] === '0' || !fields[5]) {
          return new Error('passwd row for uid ' + st.uid + ' is unusable (gid ' + fields[3] +
            ', home ' + JSON.stringify(fields[5]) + ')');
        }
        return { uid: st.uid, gid: Number(fields[3]), home: fields[5] };
      }
    }
    return new Error('No passwd entry for directory owner uid ' + st.uid);
  } catch (err) {
    return err;
  }
}

function scrubHarnessEnv(env) {
  for (const key of CONFIG.harnessScrubEnv) delete env[key];
  for (const key of Object.keys(env)) {
    for (const prefix of CONFIG.harnessScrubPrefixes) {
      if (key.indexOf(prefix) === 0) { delete env[key]; break; }
    }
  }
}

function startPtySession(sess, cols, rows) {
  const prep = sess.spec.kind === 'classic' ? prepareClassic() : prepareHarness(sess);

  const drop = sess.spec.kind === 'harness' ? harnessDrop(sess) : null;
  if (drop instanceof Error) {
    drop.claudeTermStep = 'privilege drop';
    throw drop;
  }
  let command = sess.spec.command;
  let args = sess.spec.args;
  if (drop) {
    command = '/usr/bin/setpriv';
    args = ['--reuid=' + drop.uid, '--regid=' + drop.gid, '--init-groups', '--',
      sess.spec.command].concat(sess.spec.args);
    prep.env.HOME = drop.home;
  }

  const proc = pty.spawn(command, args, {
    name: CONFIG.term,
    cols: cols,
    rows: rows,
    cwd: sess.spec.cwd,
    env: prep.env,
  });

  if (drop) console.log('[agent-console] ' + sess.id + ': drops to uid ' + drop.uid +
    ' (owner of ' + sess.spec.cwd + ')');

  sess.ring = [];
  sess.ringSize = 0;
  sess.seq = 0;
  sess.epoch += 1;
  sess.lastExit = null;
  sess.proc = proc;
  sess.pid = proc.pid;
  sess.startedAt = new Date().toISOString();
  sess.cols = cols;
  sess.rows = rows;
  sess.auth = prep.auth;

  proc.onData(function (chunk) {
    const buf = Buffer.from(chunk, 'utf8');
    ringPush(sess, buf);
    broadcast(sess, 'bytes', buf.toString('base64'));
  });

  proc.onExit(function (ev) {
    const code = ev && typeof ev.exitCode === 'number' ? ev.exitCode : null;
    const signal = ev && ev.signal ? ev.signal : null;
    sess.lastExit = { code: code, signal: signal, at: new Date().toISOString() };
    sess.proc = null;
    sess.pid = null;
    sess.starting = false;
    console.log('[agent-console] ' + sess.id + ' exited code=' + code + ' signal=' + signal);
    broadcast(sess, 'exit', JSON.stringify({ code: code, signal: signal }));
    const waiters = sess.exitWaiters;
    sess.exitWaiters = [];
    for (const fn of waiters) {
      try { fn(); } catch (err) { }
    }
  });

  console.log('[agent-console] ' + sess.id + ' started pid=' + sess.pid + ' ' +
    cols + 'x' + rows + ' cwd=' + sess.spec.cwd);
  return sess;
}

let privateStartChain = Promise.resolve();
let lastPrivateStartAt = 0;
const privateStartWaiting = new Set();

function isPrivateHomeSession(sess) {
  if (sess.spec.kind === 'classic') return true;
  if (sess.spec.kind !== 'harness') return false;
  const def = CONFIG.harnesses[sess.spec.harness];
  return !!def && def.home === 'private';
}

function queuePrivateStart(sess, cols, rows) {
  privateStartWaiting.add(sess.id);
  const task = privateStartChain.then(function () {
    const wait = Math.max(0, lastPrivateStartAt + CONFIG.privateStartGapMs - Date.now());
    if (wait > 0) {
      console.log('[agent-console] ' + sess.id + ': waiting ' + wait + ' ms - another spawn is ' +
        'seeding the private HOME ' + CONFIG.home);
    }
    return new Promise(function (resolve) { setTimeout(resolve, wait); });
  }).then(function () {
    if (SESSIONS[sess.id] !== sess) {
      console.warn('[agent-console] ' + sess.id + ': start abandoned: session forgotten while waiting');
      const gone = new Error('session forgotten while starting');
      gone.claudeTermForgotten = true;
      throw gone;
    }
    try {
      startPtySession(sess, cols, rows);
    } finally {
      lastPrivateStartAt = Date.now();
    }
  });
  privateStartChain = task.then(function () {}, function () {});
  const done = function () { privateStartWaiting.delete(sess.id); };
  task.then(done, done);
  return task;
}

let queueChain = Promise.resolve();

let harnessRootsCache = null;

function harnessRootsPayload() {
  if (harnessRootsCache && Date.now() - harnessRootsCache.at < CONFIG.harnessProbeMs) {
    return harnessRootsCache.payload;
  }
  const dirs = [{ label: 'default folder', path: CONFIG.harnessDefaultCwd }];
  let names = [];
  try {
    names = fs.readdirSync(CONFIG.harnessProjectsRoot, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory() && e.name[0] !== '.' && e.name[0] !== '_'; })
      .map(function (e) { return e.name; })
      .sort();
  } catch (err) {
    console.warn('[agent-console] harness roots: cannot read ' + CONFIG.harnessProjectsRoot +
      ' (' + msg(err) + '); offering the console root only');
  }
  for (const n of names) {
    dirs.push({ label: 'projects/' + n, path: CONFIG.harnessProjectsRoot + '/' + n });
  }
  const payload = {
    default: CONFIG.harnessDefaultCwd,
    roots: CONFIG.harnessRoots.slice(),
    dirs: dirs,
  };
  harnessRootsCache = { at: Date.now(), payload: payload };
  return payload;
}

const WS_ID_RE = /^ws-[a-z0-9]{5}$/;
const WS_NAME_RE = /^[A-Za-z0-9 ._/&+-]+$/;
const WS_COLORS = ['orange', 'yellow', 'cream', 'muted'];
const WS_KEYS = ['id', 'name', 'color', 'cwd', 'tiles', 'layout', 'links'];
const TILE_KEYS = ['id', 'kind', 'harness'];

function loadWorkspaces() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG.workspacesFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { doc: { v: 1, rev: 0, updatedAt: null, workspaces: [] } };
    }
    return { error: 'cannot read ' + CONFIG.workspacesFile + ': ' + msg(err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: CONFIG.workspacesFile + ' is not parseable JSON (' + msg(err) + ')' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.workspaces)) {
    return { error: CONFIG.workspacesFile + ' is not a workspaces document' };
  }
  return {
    doc: {
      v: 1,
      rev: Number.isInteger(parsed.rev) && parsed.rev >= 0 ? parsed.rev : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      workspaces: parsed.workspaces,
    },
  };
}

function opaqueField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'must be an object';
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (err) {
    return 'is not serialisable';
  }
  if (bytes > CONFIG.maxWorkspaceOpaqueBytes) {
    return 'is ' + bytes + ' bytes of JSON, over the ' + CONFIG.maxWorkspaceOpaqueBytes + ' cap';
  }
  return null;
}

function validateWorkspaces(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: 'the document must be a JSON object', path: '' };
  }
  const list = doc.workspaces;
  if (!Array.isArray(list)) return { error: 'must be an array', path: 'workspaces' };
  if (list.length < 1 || list.length > 24) {
    return { error: 'must hold 1 to 24 workspaces, got ' + list.length, path: 'workspaces' };
  }
  const seen = Object.create(null);
  const harnessSeen = Object.create(null);
  let mains = 0;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    const at = 'workspaces[' + i + ']';
    if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'must be an object', path: at };
    for (const key of Object.keys(w)) {
      if (WS_KEYS.indexOf(key) === -1) {
        return { error: 'unknown key - a workspace holds only ' + WS_KEYS.join(', '), path: at + '.' + key };
      }
    }
    if (typeof w.id !== 'string') return { error: 'must be a string', path: at + '.id' };
    if (w.id === 'main') mains++;
    else if (!WS_ID_RE.test(w.id)) return { error: 'must be "main" or ws-<5 base36>', path: at + '.id' };
    if (seen[w.id]) return { error: 'duplicate workspace id', path: at + '.id' };
    seen[w.id] = true;
    if (typeof w.name !== 'string' || w.name.length < 1 || w.name.length > 24 || !WS_NAME_RE.test(w.name)) {
      return { error: 'must be 1 to 24 characters of [A-Za-z0-9 ._/&+-]', path: at + '.name' };
    }
    if (w.name.trim().length === 0) {
      return { error: 'must not be blank', path: at + '.name' };
    }
    if (WS_COLORS.indexOf(w.color) === -1) {
      return { error: 'must be one of ' + WS_COLORS.join(', '), path: at + '.color' };
    }
    if (!(w.cwd === null || (typeof w.cwd === 'string' && w.cwd.length <= 512))) {
      return { error: 'must be null or a string of at most 512 characters', path: at + '.cwd' };
    }
    if (!Array.isArray(w.tiles)) return { error: 'must be an array', path: at + '.tiles' };
    if (w.tiles.length > 24) {
      return { error: 'must hold at most 24 tiles, got ' + w.tiles.length, path: at + '.tiles' };
    }
    const tseen = Object.create(null);
    for (let j = 0; j < w.tiles.length; j++) {
      const t = w.tiles[j];
      const tat = at + '.tiles[' + j + ']';
      if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: 'must be an object', path: tat };
      for (const key of Object.keys(t)) {
        if (TILE_KEYS.indexOf(key) === -1 || (key === 'harness' && t.kind !== 'harness')) {
          return {
            error: 'unknown key - a tile holds only id, kind' +
              (t.kind === 'harness' ? ' and harness' : ''),
            path: tat + '.' + key,
          };
        }
      }
      if (typeof t.id !== 'string') return { error: 'must be a string', path: tat + '.id' };
      if (t.kind === 'agent') {
        if (AGENT_IDS.indexOf(t.id) === -1) {
          return { error: 'must be one of ' + AGENT_IDS.join(', '), path: tat + '.id' };
        }
      } else if (t.kind === 'harness') {
        if (!HARNESS_SESSION_RE.test(t.id)) {
          return { error: 'must be <harness>-<5 base36>', path: tat + '.id' };
        }
        if (t.harness !== t.id.slice(0, t.id.lastIndexOf('-'))) {
          return { error: 'must equal the id prefix', path: tat + '.harness' };
        }
      } else {
        return { error: 'must be agent or harness', path: tat + '.kind' };
      }
      if (tseen[t.id]) return { error: 'duplicate tile id in this workspace', path: tat + '.id' };
      tseen[t.id] = true;
      if (t.kind === 'harness') {
        if (harnessSeen[t.id]) {
          return {
            error: 'a harness tile lives in exactly one workspace (already in "' +
              harnessSeen[t.id] + '")',
            path: tat + '.id',
          };
        }
        harnessSeen[t.id] = w.id;
      }
    }
    const layBad = opaqueField(w.layout);
    if (layBad) return { error: layBad, path: at + '.layout' };
    const lnkBad = opaqueField(w.links);
    if (lnkBad) return { error: lnkBad, path: at + '.links' };
  }
  if (mains !== 1) {
    return { error: 'exactly one workspace must have id "main", found ' + mains, path: 'workspaces' };
  }
  return null;
}

function handleWorkspacesGet(res) {
  const loaded = loadWorkspaces();
  if (loaded.error) {
    console.warn('[agent-console] workspaces: ' + loaded.error);
    sendJson(res, 500, { error: 'workspaces file unreadable', detail: loaded.error });
    return;
  }
  sendJson(res, 200, loaded.doc);
}

function handleWorkspacesPut(body, res) {
  const doc = parseJsonBody(body);
  const bad = validateWorkspaces(doc);
  if (bad) {
    sendJson(res, 400, { error: bad.error, path: bad.path });
    return;
  }
  const loaded = loadWorkspaces();
  if (loaded.error) {
    console.warn('[agent-console] workspaces: ' + loaded.error);
    sendJson(res, 500, { error: 'workspaces file unreadable', detail: loaded.error });
    return;
  }
  if (doc.rev !== loaded.doc.rev) {
    sendJson(res, 409, { error: 'stale', rev: loaded.doc.rev });
    return;
  }
  const out = {
    v: 1,
    rev: loaded.doc.rev + 1,
    updatedAt: new Date().toISOString(),
    workspaces: doc.workspaces,
  };
  try {
    fs.mkdirSync(path.dirname(CONFIG.workspacesFile), { recursive: true });
    writeJsonAtomic(CONFIG.workspacesFile, out);
  } catch (err) {
    console.error('[agent-console] workspaces: could not write ' + CONFIG.workspacesFile +
      ' (' + msg(err) + ')');
    sendJson(res, 500, { error: 'could not write the workspaces file', detail: msg(err) });
    return;
  }
  sendJson(res, 200, out);
}

function handleForget(body, res) {
  const opts = parseJsonBody(body);
  const sess = sessionFrom(opts.session);
  if (!sess) {
    sendJson(res, 404, { error: 'unknown session', known: sessionIds() });
    return;
  }
  if (sess.spec.kind !== 'harness') {
    sendJson(res, 403, { error: 'not a harness session', session: sess.id });
    return;
  }
  if (sess.proc) {
    sendJson(res, 409, { error: 'still running', session: sess.id, pid: sess.pid });
    return;
  }
  if (privateStartWaiting.has(sess.id)) {
    sendJson(res, 409, { error: 'still starting', session: sess.id });
    return;
  }
  for (const stream of Array.from(sess.streams)) {
    try { stream.end(); } catch (err) { }
  }
  sess.streams.clear();
  sess.ring = [];
  sess.ringSize = 0;
  delete SESSIONS[sess.id];
  console.log('[agent-console] ' + sess.id + ': forgotten (harness slot released)');
  sendJson(res, 200, { forgotten: sess.id });
}

function sessionPayload(sess) {
  const isAgent = sess.spec.kind === 'agent';
  const isHarness = sess.spec.kind === 'harness';
  const base = {
    kind: sess.spec.kind,
    running: !!sess.proc,
    pid: sess.pid,
    startedAt: sess.startedAt,
    cols: sess.cols,
    rows: sess.rows,
    lastExit: sess.lastExit,
    starting: !!sess.starting,
    auth: isAgent ? (sess.proc ? sess.auth : null)
      : (isHarness ? (sess.proc ? sess.auth : null)
        : (sess.proc ? sess.auth : authState())),
  };
  if (!isHarness) return base;
  base.harness = sess.spec.harness;
  base.cwd = sess.spec.cwd;
  return base;
}

function statusPayload() {
  const sessions = {};
  for (const id of sessionIds()) sessions[id] = sessionPayload(SESSIONS[id]);
  return {
    pty: pty ? 'ok' : 'missing',
    ptyError: ptyError,
    agents: CONFIG.agents.map(function (a) {
      return {
        id: a.id, name: a.name || a.id.toUpperCase(), role: a.role || '',
        icon: a.icon || null, color: a.color || null,
        harness: a.harness, cwd: a.cwd || CONFIG.harnessDefaultCwd,
        telegram: !!(a.telegram && a.telegram.tokenEnv),
      };
    }),
    title: CONFIG.title,
    defaultCwd: CONFIG.harnessDefaultCwd,
    harnesses: harnessTable(false),
    workspaces: { available: true },
    stream: { mux: true, maxSessions: CONFIG.muxMaxSessions },
    sessions: sessions,
  };
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendText(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, res, limit, cb) {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', function (chunk) {
    if (over) return;
    size += chunk.length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      const payload = JSON.stringify({ error: 'body too large', limit: limit });
      res.writeHead(413, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(payload);
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (!over) cb(Buffer.concat(chunks, size));
  });
  req.on('error', function () { over = true; });
}

function parseJsonBody(buf) {
  if (!buf || !buf.length) return {};
  try {
    const val = JSON.parse(buf.toString('utf8'));
    return val && typeof val === 'object' ? val : {};
  } catch (err) {
    return {};
  }
}

function sessionFrom(value) {
  if (typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SESSIONS, value) ? SESSIONS[value] : null;
}

function hostAllowed(req) {
  const host = req.headers.host;
  if (!host) return false;
  return ALLOWED_HOSTS.indexOf(host) !== -1;
}

function mutationGuardError(req) {
  if (req.headers[CONFIG.guardHeader] !== CONFIG.guardValue) {
    return { code: 403, body: { error: 'missing guard header' } };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && ALLOWED_ORIGINS.indexOf(origin) === -1) {
    return { code: 403, body: { error: 'bad origin' } };
  }
  return null;
}

function streamGateError(req) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== undefined && dest !== CONFIG.streamFetchDest) {
    return { code: 403, body: { error: 'bad fetch destination', dest: String(dest) } };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && ALLOWED_ORIGINS.indexOf(origin) === -1) {
    return { code: 403, body: { error: 'bad origin' } };
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site === 'cross-site') {
    return { code: 403, body: { error: 'cross-site request' } };
  }
  const open = streamCount();
  if (open >= CONFIG.maxStreams) {
    console.warn('[agent-console] stream refused: ' + open + ' already open (cap ' +
      CONFIG.maxStreams + ')');
    return { code: 503, body: { error: 'too many streams', limit: CONFIG.maxStreams } };
  }
  return null;
}

const PAGE_ICONS = ['dot', 'ring', 'bar', 'grok'];

const PAGE_MARKERS = [
  { marker: '<title>', line: function () {
    return '<title>' + String(CONFIG.title).replace(/[<>&]/g, '') + '</title>';
  } },
  { marker: '// AGENT-CONSOLE-AGENTS', line: function () {
    const list = CONFIG.agents.map(function (a) {
      return {
        id: a.id,
        name: a.name || a.id.toUpperCase(),
        role: a.role || '',
        color: a.color || '#e8e2d2',
        accent: a.accent === true,
        icon: PAGE_ICONS.indexOf(a.icon) === -1 ? 'dot' : a.icon,
        telegram: !!(a.telegram && a.telegram.tokenEnv),
      };
    });
    return '  var AGENTS = ' + JSON.stringify(list) + '; // AGENT-CONSOLE-AGENTS';
  } },
  { marker: '// AGENT-CONSOLE-DEFAULT-CWD', line: function () {
    return '  var WS_DEFAULT_CWD = ' + JSON.stringify(CONFIG.harnessDefaultCwd) +
      '; // AGENT-CONSOLE-DEFAULT-CWD';
  } },
  { marker: '// AGENT-CONSOLE-LINK-TOOL', line: function () {
    return '  var LINK_TOOL = ' +
      JSON.stringify('node ' + path.join(__dirname, 'tools', 'agent-link.mjs') + ' ') +
      '; // AGENT-CONSOLE-LINK-TOOL';
  } },
];

function injectConfig(html) {
  const lines = html.split('\n');
  for (const m of PAGE_MARKERS) {
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(m.marker) !== -1) { hit = i; break; }
    }
    if (hit === -1) {
      console.warn('[agent-console] index.html has no ' + m.marker +
        ' line — serving the page unmodified');
      continue;
    }
    lines[hit] = m.line();
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

function servePage(res, headOnly) {
  if (!fs.existsSync(PAGE)) {
    sendText(res, 500, 'index.html is missing next to server.js');
    return;
  }
  const body = injectConfig(fs.readFileSync(PAGE, 'utf8'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; connect-src 'self'; form-action 'none'",
  });
  if (headOnly) res.end(); else res.end(body);
}

function serveVendor(name, res, headOnly) {
  let hit = null;
  for (const entry of VENDOR) if (entry.name === name) hit = entry;
  if (!hit) {
    sendText(res, 404, 'Not found');
    return;
  }
  const file = path.join(VENDOR_DIR, hit.name);
  if (!fs.existsSync(file)) {
    sendText(res, 404, hit.name + ' has not been deployed into vendor/ yet');
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': hit.type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (headOnly) res.end(); else res.end(body);
}

function handleStream(req, res, sess) {
  const gate = streamGateError(req);
  if (gate) {
    sendJson(res, gate.code, gate.body);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);

  res.write(': agent-term stream open (' + sess.id + ')\n\n');
  if (sess.ringSize > 0) sseWrite(sess, res, 'bytes', ringBuffer(sess).toString('base64'));
  if (!sess.proc && sess.lastExit) {
    sseWrite(sess, res, 'exit', JSON.stringify({ code: sess.lastExit.code, signal: sess.lastExit.signal }));
  }
  sess.streams.add(res);

  const beat = setInterval(function () {
    try { res.write(': hb\n\n'); } catch (err) { }
  }, CONFIG.heartbeatMs);
  if (typeof beat.unref === 'function') beat.unref();

  const close = function () {
    clearInterval(beat);
    sess.streams.delete(res);
  };
  req.on('close', close);
  res.on('close', close);
}

function handleStreamMulti(req, res, idsParam, sinceParam) {
  const gate = streamGateError(req);
  if (gate) {
    sendJson(res, gate.code, gate.body);
    return;
  }
  const ids = [];
  for (const raw of String(idsParam).split(',')) {
    const sess = sessionFrom(raw);
    if (sess && ids.indexOf(sess.id) === -1) ids.push(sess.id);
    if (ids.length >= CONFIG.muxMaxSessions) break;
  }
  if (!ids.length) {
    sendJson(res, 404, { error: 'no known session named', known: sessionIds() });
    return;
  }
  const since = {};
  if (sinceParam) {
    for (const pair of String(sinceParam).split(',')) {
      const at = pair.lastIndexOf(':');
      if (at <= 0) continue;
      const id = pair.slice(0, at);
      const dot = pair.indexOf('.', at + 1);
      if (dot < 0) continue;
      const epoch = parseInt(pair.slice(at + 1, dot), 10);
      const n = parseInt(pair.slice(dot + 1), 10);
      if (Number.isFinite(epoch) && Number.isFinite(n) && epoch >= 0 && n >= 0) {
        since[id] = { epoch: epoch, seq: n };
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
  res.write(': agent-term mux stream open (' + ids.join(',') + ')\n\n');

  const reader = { res: res, ids: new Set(ids) };
  MUX_STREAMS.add(reader);

  for (const id of ids) {
    const sess = SESSIONS[id];
    const ringStart = sess.seq - sess.ringSize;
    const from = since[id];
    const cursor = muxCursor(sess);
    if (from && from.epoch === sess.epoch && from.seq >= ringStart && from.seq <= sess.seq) {
      const tail = ringBuffer(sess).subarray(from.seq - ringStart);
      if (tail.length) muxWrite(reader, 'bytes', id, cursor, tail.toString('base64'));
      else muxWrite(reader, 'sync', id, cursor, '');
    } else {
      muxWrite(reader, 'snap', id, cursor, ringBuffer(sess).toString('base64'));
    }
    if (!sess.proc && sess.lastExit) {
      muxWrite(reader, 'exit', id, cursor,
        JSON.stringify({ code: sess.lastExit.code, signal: sess.lastExit.signal }));
    }
  }

  const beat = setInterval(function () {
    try { res.write(': hb\n\n'); } catch (err) { }
  }, CONFIG.heartbeatMs);
  if (typeof beat.unref === 'function') beat.unref();

  const close = function () {
    clearInterval(beat);
    MUX_STREAMS.delete(reader);
  };
  req.on('close', close);
  res.on('close', close);
}

function startFailed(sess, err, res) {
  const step = (err && err.claudeTermStep) || 'spawn';
  const detail = msg(err);
  console.error('[agent-console] ' + sess.id + ': ' + step + ' failed: ' + detail);
  sendJson(res, 500, { error: step + ' failed', session: sess.id, detail: detail });
}

function createHarnessSession(opts, res) {
  const id = typeof opts.session === 'string' ? opts.session : '';
  if (!HARNESS_SHAPE_RE.test(id)) {
    sendJson(res, 404, { error: 'unknown session', known: sessionIds() });
    return null;
  }
  if (!pty) {
    sendJson(res, 503, {
      error: 'pty backend missing',
      detail: ptyError,
      hint: 'run `npm install` in the app folder, then restart the server',
    });
    return null;
  }
  const harness = id.slice(0, id.lastIndexOf('-'));
  const def = Object.prototype.hasOwnProperty.call(CONFIG.harnesses, harness)
    ? CONFIG.harnesses[harness] : null;
  if (!def || opts.harness !== harness) {
    sendJson(res, 404, {
      error: 'unknown harness',
      session: id,
      known: Object.keys(CONFIG.harnesses),
    });
    return null;
  }
  const bin = resolveBin(def.bin);
  if (!bin) {
    sendJson(res, 409, { error: 'harness not installed', harness: harness });
    return null;
  }
  const cwd = harnessCwd(opts.cwd);
  if (cwd.reason) {
    sendJson(res, 400, { error: 'bad cwd', reason: cwd.reason });
    return null;
  }
  if (harnessCount() >= CONFIG.maxHarnessSessions) {
    sendJson(res, 429, { error: 'too many harness sessions', max: CONFIG.maxHarnessSessions });
    return null;
  }
  const sess = makeSession(id, {
    kind: 'harness',
    harness: harness,
    command: bin,
    args: def.args.slice(),
    cwd: cwd.cwd,
  });
  SESSIONS[id] = sess;
  console.log('[agent-console] ' + id + ': harness session created (' + bin + ' in ' + cwd.cwd + ')');
  return sess;
}

function harnessSpecCheck(sess, opts) {
  if (opts.harness !== undefined && opts.harness !== sess.spec.harness) {
    return { code: 409, body: { error: 'spec mismatch', session: sess.id, harness: sess.spec.harness } };
  }
  if (opts.cwd === undefined || opts.cwd === null || opts.cwd === '') {
    if (sess.proc) return null;
    if (sess.spec.cwd === CONFIG.harnessDefaultCwd) return null;
    return { cwd: CONFIG.harnessDefaultCwd };
  }
  let real = null;
  try { real = fs.realpathSync(String(opts.cwd)); } catch (err) { real = null; }
  if (real !== null && real === sess.spec.cwd) return null;
  if (sess.proc) {
    return { code: 409, body: { error: 'spec mismatch', session: sess.id, cwd: sess.spec.cwd } };
  }
  const checked = harnessCwd(opts.cwd);
  if (checked.reason) {
    return { code: 400, body: { error: 'bad cwd', reason: checked.reason } };
  }
  return { cwd: checked.cwd };
}

function handleStart(body, res) {
  const opts = parseJsonBody(body);
  const wantId = typeof opts.session === 'string' ? opts.session : '';
  if (wantId && privateStartWaiting.has(wantId)) {
    sendJson(res, 409, { error: 'already starting', session: wantId });
    return;
  }
  let sess = sessionFrom(opts.session);
  let adoptCwd = null;
  if (!sess) {
    sess = createHarnessSession(opts, res);
    if (!sess) return;
  } else if (sess.spec.kind === 'harness') {
    const check = harnessSpecCheck(sess, opts);
    if (check && check.code) {
      sendJson(res, check.code, check.body);
      return;
    }
    if (check && check.cwd) adoptCwd = check.cwd;
  }
  if (!pty) {
    sendJson(res, 503, {
      error: 'pty backend missing',
      detail: ptyError,
      hint: 'run `npm install` in the app folder, then restart the server',
    });
    return;
  }
  if (sess.proc) {
    sendJson(res, 409, { error: 'already running', session: sess.id, pid: sess.pid });
    return;
  }
  const cols = clampInt(opts.cols, CONFIG.colsMin, CONFIG.colsMax, CONFIG.colsDefault);
  const rows = clampInt(opts.rows, CONFIG.rowsMin, CONFIG.rowsMax, CONFIG.rowsDefault);

  if (adoptCwd) {
    console.log('[agent-console] ' + sess.id + ': cwd re-pointed ' + sess.spec.cwd + ' -> ' + adoptCwd);
    sess.spec.cwd = adoptCwd;
  }

  if (sess.spec.kind === 'classic' || sess.spec.kind === 'harness' ||
      sess.spec.kind === 'agent') {
    if (isPrivateHomeSession(sess)) {
      queuePrivateStart(sess, cols, rows).then(function () {
        sendJson(res, 200, statusPayload());
      }, function (err) {
        if (err && err.claudeTermForgotten) {
          sendJson(res, 410, { error: 'session forgotten while starting', session: sess.id });
          return;
        }
        startFailed(sess, err, res);
      });
      return;
    }
    try {
      startPtySession(sess, cols, rows);
    } catch (err) {
      startFailed(sess, err, res);
      return;
    }
    sendJson(res, 200, statusPayload());
    return;
  }

}

function handleInput(sess, body, res) {
  if (!sess.proc) {
    sendJson(res, 409, { error: 'no session', session: sess.id });
    return;
  }
  if (!body.length) {
    sendJson(res, 200, { ok: true, bytes: 0 });
    return;
  }
  try {
    sess.proc.write(body.toString('utf8'));
  } catch (err) {
    sendJson(res, 500, { error: 'write failed', detail: msg(err) });
    return;
  }
  sendJson(res, 200, { ok: true, session: sess.id, bytes: body.length });
}

function handleResize(body, res) {
  const opts = parseJsonBody(body);
  const sess = sessionFrom(opts.session);
  if (!sess) {
    sendJson(res, 404, { error: 'unknown session', known: sessionIds() });
    return;
  }
  if (!sess.proc) {
    sendJson(res, 409, { error: 'no session', session: sess.id });
    return;
  }
  const cols = clampInt(opts.cols, CONFIG.colsMin, CONFIG.colsMax, sess.cols);
  const rows = clampInt(opts.rows, CONFIG.rowsMin, CONFIG.rowsMax, sess.rows);
  try {
    sess.proc.resize(cols, rows);
  } catch (err) {
    sendJson(res, 500, { error: 'resize failed', detail: msg(err) });
    return;
  }
  sess.cols = cols;
  sess.rows = rows;
  sendJson(res, 200, { ok: true, session: sess.id, cols: cols, rows: rows });
}

function killSession(sess, signal) {
  if (sess.spec.kind === 'agent' && sess.pid) {
    try {
      process.kill(-sess.pid, signal);
      return;
    } catch (err) {
    }
  }
  sess.proc.kill(signal);
}

function handleStop(body, res) {
  const opts = parseJsonBody(body);
  const sess = sessionFrom(opts.session);
  if (!sess) {
    sendJson(res, 404, { error: 'unknown session', known: sessionIds() });
    return;
  }

  if (!sess.proc && sess.queued) {
    sess.cancelQueued = true;
    console.log('[agent-console] ' + sess.id + ': STOP while queued - the queued start is cancelled');
    sendJson(res, 200, {
      running: false,
      session: sess.id,
      action: 'cancelled-queued',
      lastExit: sess.lastExit,
    });
    return;
  }

  if (!sess.proc) {
    sendJson(res, 200, { running: false, session: sess.id, action: 'none', lastExit: sess.lastExit });
    return;
  }
  const pid = sess.pid;
  let timer = null;
  let settled = false;
  let sentSignal = 'SIGHUP';

  const reply = function (action) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    sess.exitWaiters = sess.exitWaiters.filter(function (fn) { return fn !== onExit; });
    sendJson(res, 200, {
      running: !!sess.proc,
      session: sess.id,
      action: action,
      pid: pid,
      lastExit: sess.lastExit,
    });
  };
  const onExit = function () { reply(sentSignal); };
  sess.exitWaiters.push(onExit);

  try {
    killSession(sess, 'SIGHUP');
  } catch (err) {
    reply('SIGHUP failed: ' + msg(err));
    return;
  }

  timer = setTimeout(function () {
    if (sess.proc && sess.pid === pid) {
      console.log('[agent-console] ' + sess.id + ': pid ' + pid + ' survived SIGHUP, sending SIGKILL');
      sentSignal = 'SIGKILL';
      try { killSession(sess, 'SIGKILL'); } catch (err) { }
      setTimeout(function () { reply(sentSignal); }, 400);
    } else {
      reply(sentSignal);
    }
  }, CONFIG.killGraceMs);
}

const server = http.createServer(function (req, res) {
  const target = req.url || '';
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(target) || target.slice(0, 2) === '//') {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (!hostAllowed(req)) {
    sendJson(res, 403, { error: 'bad host' });
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  } catch (err) {
    sendText(res, 400, 'Bad request');
    return;
  }
  const pathname = url.pathname;

  if (req.method === 'GET' || req.method === 'HEAD') {
    const headOnly = req.method === 'HEAD';
    if (pathname === '/' || pathname === '/index.html') return servePage(res, headOnly);
    if (pathname.indexOf('/vendor/') === 0) {
      return serveVendor(pathname.slice('/vendor/'.length), res, headOnly);
    }
    if (pathname === '/api/status') return sendJson(res, 200, statusPayload());
    if (pathname === '/api/stream') {
      const many = url.searchParams.get('sessions');
      if (many) return handleStreamMulti(req, res, many, url.searchParams.get('since'));
      const sess = sessionFrom(url.searchParams.get('session'));
      if (!sess) return sendJson(res, 404, { error: 'unknown session', known: sessionIds() });
      return handleStream(req, res, sess);
    }
    if (pathname === '/api/harness-roots') return sendJson(res, 200, harnessRootsPayload());
    if (pathname === '/api/workspaces') return handleWorkspacesGet(res);
    return sendText(res, 404, 'Not found');
  }

  if (req.method === 'POST') {
    const guard = mutationGuardError(req);
    if (guard) {
      sendJson(res, guard.code, guard.body);
      return;
    }
    if (pathname === '/api/start') {
      return readBody(req, res, 4096, function (body) { handleStart(body, res); });
    }
    if (pathname === '/api/input') {
      const sess = sessionFrom(url.searchParams.get('session'));
      if (!sess) return sendJson(res, 404, { error: 'unknown session', known: sessionIds() });
      return readBody(req, res, CONFIG.maxInputBytes, function (body) { handleInput(sess, body, res); });
    }
    if (pathname === '/api/resize') {
      return readBody(req, res, 4096, function (body) { handleResize(body, res); });
    }
    if (pathname === '/api/stop') {
      return readBody(req, res, 4096, function (body) { handleStop(body, res); });
    }
    if (pathname === '/api/forget') {
      return readBody(req, res, 4096, function (body) { handleForget(body, res); });
    }
    return sendText(res, 404, 'Not found');
  }

  if (req.method === 'PUT') {
    const guard = mutationGuardError(req);
    if (guard) {
      sendJson(res, guard.code, guard.body);
      return;
    }
    if (pathname === '/api/workspaces') {
      return readBody(req, res, CONFIG.maxWorkspacesBytes, function (body) {
        handleWorkspacesPut(body, res);
      });
    }
    return sendText(res, 404, 'Not found');
  }

  sendText(res, 405, 'Method not allowed');
});

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[agent-console] port ' + PORT + ' is already in use.');
    console.error('[agent-console] change "port" in config.json, or start with ' +
      'AGENT_CONSOLE_PORT=<other> npm start');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error('[agent-console] not allowed to bind port ' + PORT +
      ' — ports below 1024 need root. Pick a higher one in config.json.');
    process.exit(1);
  }
  console.error('[agent-console] server error: ' + msg(err));
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  console.log('[agent-console] ' + CONFIG.title + ' running at http://' +
    (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('[agent-console] pty backend: ' + (pty ? 'node-pty ok' : 'MISSING — ' + ptyError));
  console.log('[agent-console] agents: ' + (CONFIG.agentIds.length ? CONFIG.agentIds.join(', ') : 'none configured'));
  console.log('[agent-console] accepted Host: ' + ALLOWED_HOSTS.join(', '));
  const table = harnessTable(true);
  console.log('[agent-console] harnesses: ' + Object.keys(table).map(function (h) {
    return h + '=' + (table[h].installed ? table[h].bin : 'NOT INSTALLED');
  }).join(', '));
  try {
    fs.mkdirSync(CONFIG.harnessWorkRoot, { recursive: true });
  } catch (err) {
    console.warn('[agent-console] could not create ' + CONFIG.harnessWorkRoot +
      ' (' + msg(err) + ') — that folder stays inert');
  }
  console.log('[agent-console] folders terminals may open in: ' + CONFIG.harnessRoots.join(', '));
  console.log('[agent-console] state: ' + STATE_DIR);
});
