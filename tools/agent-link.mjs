import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import http from 'node:http';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SELF = url.fileURLToPath(import.meta.url);
const PAGE = process.env.AGENT_LINK_PAGE ||
  path.join(HERE, '..', 'templates', 'claude-term', 'index.html');
const LINE_RE = /^ {2}var PROJECTS = (\{.*\}); \/\/ AGENT-PROJECTS$/;
const LINKFEED_RE = /^ {2}var LINKFEED = (\{.*\}); \/\/ AGENT-LINKS$/;
const LINKFEED_MAX = 4096;
const LINKFEED_ENTRY_MAX = 512;

const TERM = process.env.AGENT_LINK_TERM ||
  ('http://127.0.0.1:' + consolePort());
const TERM_TIMEOUT_MS = 3000;
const ENTER_DELAY_MS = 150;
const CLAUDE_HOME = process.env.AGENT_LINK_CLAUDE_HOME ||
  path.join(os.homedir(), '.claude');
const PROC = process.env.AGENT_LINK_PROC || '/proc';

const PACKET_MAX = 64 * 1024;
const RECAP_MAX = 4000;
const SUMMARY_MAX = 160;
const TYPED_MAX = 400;

function loadConsoleConfig() {
  const here = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  const read = function (f) {
    try { return JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')); } catch (e) { return {}; }
  };
  const d = read('config.default.json');
  const u = read('config.json');
  return {
    root: here,
    agents: (u.agents !== undefined ? u.agents : d.agents) || [],
    workRoots: (u.workRoots !== undefined ? u.workRoots : d.workRoots) || [],
  };
}
const CONSOLE = loadConsoleConfig();

function consolePort() {
  const here = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  const read = function (f) {
    try { return JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')); } catch (e) { return {}; }
  };
  const u = read('config.json');
  const d = read('config.default.json');
  return process.env.AGENT_CONSOLE_PORT || u.port || d.port || 5075;
}
const IDS = CONSOLE.agents.map(function (a) { return a.id; });
const ROLES = {};
for (const a of CONSOLE.agents) ROLES[a.id] = a.role || 'agent';
const HARNESS_RE = /^(claude|codex|cursor|grok|gemini|pi)-[a-z0-9]{5}$/;
const HARNESS_ROLES = {
  claude: 'Claude Code harness',
  codex: 'OpenAI Codex harness',
  cursor: 'Cursor Agent harness',
  grok: 'Grok Build harness',
  gemini: 'Gemini CLI harness',
  pi: 'Pi harness',
};
const ID_HELP = (IDS.length ? IDS.join(' ') + ', or a' : 'a') +
  ' harness tile id (<harness>-<5 lowercase letters/digits>, e.g. codex-k9x2a)';

function isId(id) {
  return IDS.indexOf(id) !== -1 || HARNESS_RE.test(id);
}

function roleOf(id) {
  if (IDS.indexOf(id) !== -1) return ROLES[id];
  return HARNESS_ROLES[id.slice(0, id.indexOf('-'))];
}

function orderIds(rows) {
  const out = IDS.filter(function (id) { return rows[id]; });
  const harness = Object.keys(rows).filter(function (id) { return IDS.indexOf(id) === -1; }).sort();
  for (const id of harness) out.push(id);
  return out;
}

const GID_RE = /^tl-[a-z0-9]{4,8}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const ROOTS = CONSOLE.workRoots.length
  ? CONSOLE.workRoots.slice()
  : [path.join(os.homedir(), '.agent-console', 'work')];

const START = '<!-- agent-link:members:start -->';
const END = '<!-- agent-link:members:end -->';
const HEAD = '| agent | role | project bar | joined | NOW |';
const SEP = '|---|---|---|---|---|';

const NOW_MAX = 160;
const NOW_OK = /^[A-Za-z0-9 ._/&+:,()[\]#'";!?=%@*-]+$/;
const LABEL_BAD = /[^A-Za-z0-9 ._/&+-]+/g;
const LABEL_MAX = 24;
const NONE = '\u2014';
const DOT = ' \u00b7 ';

let HELD_LOCK = null;

function die(code, msg) {
  if (HELD_LOCK) {
    try { fs.unlinkSync(HELD_LOCK); } catch (e) { }
    HELD_LOCK = null;
  }
  console.error('agent-link: ' + msg);
  process.exit(code);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function stamp(d) {
  const g = {};
  for (const p of FMT.formatToParts(d || new Date())) {
    if (p.type !== 'literal') g[p.type] = p.value;
  }
  return g.year + '-' + g.month + '-' + g.day + ' ' + g.hour + ':' + g.minute;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (err) { return false; }
}

function projectsRoot() {
  const env = process.env.AGENT_LINK_ROOT;
  if (env) {
    if (!isDir(env)) die(3, 'AGENT_LINK_ROOT is not a directory: ' + env);
    return env;
  }
  for (const r of ROOTS) if (isDir(r)) return r;
  die(3, 'no projects root found; tried ' + ROOTS.join(', '));
}

function folderFor(root, gid) {
  return path.join(root, gid + '-link');
}

function pageLabels() {
  let text;
  try { text = fs.readFileSync(PAGE, 'utf8'); } catch (err) { return {}; }
  const hits = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) hits.push(m[1]);
  }
  if (hits.length !== 1) return {};
  let data;
  try { data = JSON.parse(hits[0]); } catch (err) { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const id of IDS) {
    const r = data[id];
    if (!r || typeof r !== 'object') continue;
    if (typeof r.project !== 'string') continue;
    const label = r.project.replace(LABEL_BAD, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
    if (label) out[id] = label;
  }
  return out;
}

let STATUS = undefined;

function termUrl() {
  try { return new URL(TERM); } catch (err) { return null; }
}

function request(method, pathname, body) {
  return new Promise(function (resolve) {
    const u = termUrl();
    if (!u) { resolve({ ok: false, status: 0, body: '', why: 'bad AGENT_LINK_TERM ' + TERM }); return; }
    const headers = { Host: u.host };
    if (method !== 'GET') {
      headers['x-agent-console'] = '1';
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = Buffer.byteLength(body || '');
    }
    let done = false;
    const finish = function (r) { if (!done) { done = true; resolve(r); } };
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: pathname,
      method: method,
      headers: headers,
    }, function (res) {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { out += c; });
      res.on('end', function () {
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: out, why: '' });
      });
    });
    req.setTimeout(TERM_TIMEOUT_MS, function () {
      req.destroy();
      finish({ ok: false, status: 0, body: '', why: 'timeout after ' + TERM_TIMEOUT_MS + 'ms' });
    });
    req.on('error', function (err) { finish({ ok: false, status: 0, body: '', why: err.code || err.message }); });
    if (method !== 'GET' && body) req.write(body);
    req.end();
  });
}

async function status() {
  if (STATUS !== undefined) return STATUS;
  const r = await request('GET', '/api/status', null);
  if (!r.ok) { STATUS = null; return STATUS; }
  try {
    const data = JSON.parse(r.body);
    STATUS = (data && typeof data === 'object' && data.sessions && typeof data.sessions === 'object')
      ? data : null;
  } catch (err) {
    STATUS = null;
  }
  return STATUS;
}

function sleepAsync(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function withLock(folder, fn) {
  const lock = path.join(folder, '.agent-link.lock');
  const deadline = Date.now() + 5000;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') die(3, 'cannot take the lock (' + err.message + ')');
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (e) { continue; }
      if (age > 30000) {
        try { fs.unlinkSync(lock); } catch (e) { }
        continue;
      }
      if (Date.now() > deadline) die(3, 'another writer has held ' + lock + ' for 5s');
      sleepMs(40);
    }
  }
  HELD_LOCK = lock;
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (e) { }
    try { fs.unlinkSync(lock); } catch (e) { }
    HELD_LOCK = null;
  }
}

function ctxPath(folder) { return path.join(folder, 'context.md'); }
function logPath(folder) { return path.join(folder, 'session-log.md'); }

function readCtx(folder) {
  const file = ctxPath(folder);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(3, 'cannot read ' + file + ' (' + err.message + ')');
  }
  const lines = text.split('\n');
  const starts = [];
  const ends = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === START) starts.push(i);
    if (lines[i].trim() === END) ends.push(i);
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    die(3, file + ' has no single agent-link members region (' + starts.length +
      ' start marker(s), ' + ends.length + ' end marker(s)) — restore the two ' +
      'marker lines; this tool will not rewrite prose it did not write');
  }
  const rows = {};
  for (let i = starts[0] + 1; i < ends[0]; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.trim() === HEAD || line.trim() === SEP) continue;
    const row = parseRow(line, file, i + 1);
    rows[row.id] = row;
  }
  return { file, lines, start: starts[0], end: ends[0], rows };
}

function parseRow(line, file, lineNo) {
  const raw = line.split('|');
  if (raw.length !== 7 || raw[0].trim() !== '' || raw[6].trim() !== '') {
    die(3, file + ':' + lineNo + ' is inside the agent-link members region but is not a ' +
      '5-column table row — the region between the markers is CLI-managed; put prose outside it');
  }
  const cells = raw.slice(1, 6).map(function (c) { return c.trim(); });
  const id = cells[0].toLowerCase();
  if (!isId(id)) {
    die(3, file + ':' + lineNo + ' names "' + cells[0] + '", which is not one of ' + ID_HELP);
  }
  const joinedCell = cells[3];
  let state = null;
  let at = '';
  if (joinedCell === 'not joined yet') {
    state = 'none';
  } else if (/^left /.test(joinedCell) && STAMP_RE.test(joinedCell.slice(5))) {
    state = 'left';
    at = joinedCell.slice(5);
  } else if (STAMP_RE.test(joinedCell)) {
    state = 'joined';
    at = joinedCell;
  } else {
    die(3, file + ':' + lineNo + ' has a joined cell this tool did not write ("' + joinedCell +
      '"); expected a YYYY-MM-DD HH:MM stamp, "left <stamp>" or "not joined yet"');
  }
  const nowCell = cells[4];
  let now = '';
  let nowAt = '';
  if (nowCell !== '(not set)') {
    const m = /^(.*) \((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)$/.exec(nowCell);
    if (!m) {
      die(3, file + ':' + lineNo + ' has a NOW cell this tool did not write ("' + nowCell +
        '"); expected "(not set)" or "<text> (<stamp>)"');
    }
    now = m[1];
    nowAt = m[2];
  }
  return { id, state: state, at: at, now: now, nowAt: nowAt };
}

function emitRegion(rows, labels) {
  const out = [HEAD, SEP];
  for (const id of orderIds(rows)) {
    const r = rows[id];
    const joined = r.state === 'joined' ? r.at : (r.state === 'left' ? 'left ' + r.at : 'not joined yet');
    const now = r.now ? r.now + ' (' + r.nowAt + ')' : '(not set)';
    out.push('| ' + id.toUpperCase() + ' | ' + roleOf(id) + ' | ' + (labels[id] || NONE) +
      ' | ' + joined + ' | ' + now + ' |');
  }
  return out;
}

function writeCtx(ctx, region) {
  const next = ctx.lines.slice(0, ctx.start + 1)
    .concat(region)
    .concat(ctx.lines.slice(ctx.end));
  const tmp = ctx.file + '.tmp-agent-link-' + process.pid;
  try {
    fs.writeFileSync(tmp, next.join('\n'));
    fs.renameSync(tmp, ctx.file);
  } catch (err) {
    die(3, 'cannot write ' + ctx.file + ' (' + err.message + ')');
  }
  const back = readCtx(path.dirname(ctx.file));
  const wroteOut = ctx.lines.slice(0, ctx.start + 1).concat(ctx.lines.slice(ctx.end));
  const backOut = back.lines.slice(0, back.start + 1).concat(back.lines.slice(back.end));
  if (wroteOut.join('\n') !== backOut.join('\n')) {
    die(3, 'wrote ' + ctx.file + ' but a line OUTSIDE the members region changed — check the file');
  }
  const backRegion = back.lines.slice(back.start + 1, back.end);
  if (backRegion.join('\n') !== region.join('\n')) {
    die(3, 'wrote ' + ctx.file + ' but read back a different members region — check the file');
  }
}

function appendLog(folder, line) {
  const file = logPath(folder);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(3, 'cannot read ' + file + ' (' + err.message + ')');
  }
  const next = text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
  const tmp = file + '.tmp-agent-link-' + process.pid;
  try {
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
  } catch (err) {
    die(3, 'cannot write ' + file + ' (' + err.message + ')');
  }
  let back;
  try { back = fs.readFileSync(file, 'utf8'); } catch (err) { back = ''; }
  if (back !== next) die(3, 'wrote ' + file + ' but read back something else — check the file');
}

function withPageLock(fn) {
  const lock = PAGE + '.lock';
  const deadline = Date.now() + 5000;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, why: 'cannot take ' + lock + ' (' + err.message + ')' };
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (e) { continue; }
      if (age > 30000) {
        try { fs.unlinkSync(lock); } catch (e) { }
        continue;
      }
      if (Date.now() > deadline) return { ok: false, why: 'another writer has held ' + lock + ' for 5s' };
      sleepMs(40);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (e) { }
    try { fs.unlinkSync(lock); } catch (e) { }
  }
}

const HTML_UNSAFE_G = /[<>&\u2028\u2029]/g;
const HTML_UNSAFE = /[<>&\u2028\u2029]/;

function safeJson(value) {
  return JSON.stringify(value).replace(HTML_UNSAFE_G, function (ch) {
    return '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0');
  });
}

function linkFeedWarn(why) {
  console.error('agent-link: the page link count was not updated (' + why + ')');
  return false;
}

function linkFeedOverWarn(why) {
  console.error('agent-link: the page link count was left as it was (' + why + ')');
  return false;
}

function updateLinkFeed(gid, patch) {
  const res = withPageLock(function () {
    let text;
    try {
      text = fs.readFileSync(PAGE, 'utf8');
    } catch (err) {
      return { ok: false, why: 'cannot read ' + PAGE + ': ' + err.message };
    }
    const lines = text.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (LINKFEED_RE.test(lines[i])) hits.push(i);
    if (hits.length === 0) {
      return { ok: false, why: 'no AGENT-LINKS line in ' + PAGE + ' — the link works, the count does not' };
    }
    if (hits.length !== 1) {
      return { ok: false, why: hits.length + ' AGENT-LINKS lines in ' + PAGE + ' — refusing to guess which one' };
    }
    const idx = hits[0];
    let data;
    try { data = JSON.parse(LINKFEED_RE.exec(lines[idx])[1]); } catch (err) {
      return { ok: false, why: 'the AGENT-LINKS line is not valid JSON (' + err.message + ')' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, why: 'the AGENT-LINKS line is not a JSON object' };
    }
    if (patch === null) delete data[gid];
    else data[gid] = patch;
    function tooBig() { return JSON.stringify(data).length > LINKFEED_MAX; }
    function blankFields(k) {
      if (!data[k]) return;
      data[k] = { members: data[k].members || [], packets: data[k].packets || 0,
        last: '', from: '', kind: '' };
    }
    if (data[gid] && JSON.stringify({ g: data[gid] }).length > LINKFEED_ENTRY_MAX) {
      console.error('agent-link: the ' + gid + ' entry is over ' + LINKFEED_ENTRY_MAX +
        ' chars on its own — writing it without last/from/kind rather than evicting other groups');
      blankFields(gid);
    }
    while (tooBig()) {
      const others = Object.keys(data).filter(function (k) { return k !== gid; });
      if (!others.length) break;
      others.sort(function (a, b) { return String(data[a].last || '') < String(data[b].last || '') ? -1 : 1; });
      delete data[others[0]];
    }
    if (tooBig()) blankFields(gid);
    if (tooBig()) {
      return { ok: false, over: true,
        why: 'the AGENT-LINKS value would be ' + JSON.stringify(data).length + ' chars, over the ' +
          LINKFEED_MAX + ' cap, even with nothing left to drop — the page line is unchanged' };
    }
    const line = '  var LINKFEED = ' + safeJson(data) + '; // AGENT-LINKS';
    if (!LINKFEED_RE.test(line)) return { ok: false, why: 'the new line does not match its own marker' };
    if (HTML_UNSAFE.test(line)) {
      return { ok: false, why: 'refusing to write: the line still holds a character that can end the script element' };
    }
    const next = lines.slice();
    next[idx] = line;
    for (let i = 0; i < next.length; i++) {
      if (i !== idx && next[i] !== lines[i]) return { ok: false, why: 'line ' + i + ' would change' };
    }
    const tmp = PAGE + '.tmp-agent-link-' + process.pid;
    try {
      fs.writeFileSync(tmp, next.join('\n'));
      fs.renameSync(tmp, PAGE);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (e) { }
      return { ok: false, why: 'cannot write ' + PAGE + ': ' + err.message };
    }
    let back;
    try { back = fs.readFileSync(PAGE, 'utf8').split('\n'); } catch (err) {
      return { ok: false, why: 'wrote the line but cannot read ' + PAGE + ' back' };
    }
    const backHits = [];
    for (let i = 0; i < back.length; i++) if (LINKFEED_RE.test(back[i])) backHits.push(i);
    if (backHits.length !== 1 || back[backHits[0]] !== line) {
      return { ok: false, why: 'wrote the AGENT-LINKS line but read back something else — check ' + PAGE };
    }
    if (HTML_UNSAFE.test(back[backHits[0]])) {
      return { ok: false, why: 'wrote the AGENT-LINKS line and read back a character that can end the script element — check ' + PAGE };
    }
    return { ok: true };
  });
  if (res && res.over) return linkFeedOverWarn(res.why);
  if (!res || !res.ok) return linkFeedWarn(res ? res.why : 'unknown');
  return true;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function linkFeedEntry(gid, folder, ctx, last) {
  const members = orderIds(ctx.rows)
    .filter(function (id) { return ctx.rows[id].state !== 'left' && isId(id); }).sort();
  const feed = readFeed(folder);
  const e = { members: members, packets: feed.length, last: '', from: '', kind: '' };
  const newest = last || (feed.length ? feed[feed.length - 1] : null);
  if (newest) {
    const from = String(newest.from || '').toLowerCase();
    const kind = String(newest.kind || '');
    if (validAt(String(newest.at || '')) && isId(from) && FEED_KINDS.indexOf(kind) !== -1) {
      e.last = isoOf(newest.at) || newest.at;
      e.from = from;
      e.kind = kind;
    }
  }
  if (!Number.isInteger(e.packets) || e.packets < 0) e.packets = 0;
  return { entry: e, empty: members.length === 0 };
}

function refreshLinkFeed(gid, folder, last) {
  let ctx;
  try { ctx = readCtxSafe(folder); } catch (err) { return false; }
  if (!ctx) return false;
  const r = linkFeedEntry(gid, folder, ctx, last);
  return updateLinkFeed(gid, r.empty ? null : r.entry);
}

function readCtxSafe(folder) {
  try {
    const text = fs.readFileSync(ctxPath(folder), 'utf8');
    const lines = text.split('\n');
    let s = -1;
    let e = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === START) s = i;
      if (lines[i].trim() === END) e = i;
    }
    if (s === -1 || e === -1 || e < s) return null;
    const rows = {};
    for (let i = s + 1; i < e; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim() === HEAD || line.trim() === SEP) continue;
      const cells = line.split('|');
      if (cells.length !== 7) continue;
      const id = cells[1].trim().toLowerCase();
      if (!isId(id)) continue;
      const j = cells[4].trim();
      rows[id] = { id: id, state: /^left /.test(j) ? 'left' : (STAMP_RE.test(j) ? 'joined' : 'none') };
    }
    return { lines: lines, start: s, end: e, rows: rows };
  } catch (err) {
    return null;
  }
}

function feedPath(folder) { return path.join(folder, 'feed.md'); }
function packetsDir(folder) { return path.join(folder, 'packets'); }
function seenPath(folder, id) { return path.join(folder, '.seen-' + id); }
function lastRecapPath(folder, id) { return path.join(folder, '.last-recap-' + id); }

function isoNow() { return new Date().toISOString(); }

function fileStamp(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu;

function sanitiseLine(s) {
  return String(s == null ? '' : s).replace(CTRL_RE, '').replace(/ {2,}/g, ' ');
}

const MARK_RE = /\p{M}/gu;
const LONG_DASH_RE = /[\u2013\u2014]/g;
const NON_ASCII_RE = /[^\u0020-\u007E]/g;

function asciiPreview(s) {
  let out = String(s == null ? '' : s).normalize('NFKD');
  out = out.replace(CTRL_RE, '').replace(MARK_RE, '');
  out = out.replace(LONG_DASH_RE, '-');
  out = out.replace(NON_ASCII_RE, '?').replace(/\?{2,}/g, '?');
  out = out.split('[LINK').join('(LINK');
  out = out.replace(/full:/gi, 'full-');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > SUMMARY_MAX) out = out.slice(0, SUMMARY_MAX - 3).trim() + '...';
  return out;
}

function summarise(body) {
  const lines = String(body == null ? '' : body).split('\n');
  let first = '';
  for (const l of lines) {
    if (l.trim()) { first = l; break; }
  }
  return asciiPreview(first);
}

function cutBytes(s, max) {
  let out = s;
  while (Buffer.byteLength(out) > max) out = out.slice(0, out.length - 1);
  return out;
}

function typedLine(gid, fromId, kind, summary, packetFile) {
  const head = '[LINK ' + gid + ' · ' + fromId.toUpperCase() + ' · ' + kind + '] ';
  const tail = ' — full: ' + packetFile;
  const fixed = Buffer.byteLength(head) + Buffer.byteLength(tail);
  let s = asciiPreview(summary);
  if (fixed >= TYPED_MAX) {
    console.error('agent-link: the packet path alone is ' + Buffer.byteLength(tail) +
      ' bytes, over the ' + TYPED_MAX + ' byte line budget — sending it uncut, ' +
      'with no summary (a truncated path is worse than a long line)');
    return sanitiseLine(head + tail);
  }
  const room = TYPED_MAX - fixed;
  if (Buffer.byteLength(s) > room) {
    s = room > 3 ? cutBytes(s, room - 3).trim() + '...' : '';
    if (Buffer.byteLength(s) > room) s = '';
  }
  return sanitiseLine(head + s + tail);
}

const FEED_KINDS = ['handoff', 'message', 'recap'];
const FEED_HEAD_RE =
  /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) · ([A-Z0-9-]+) → (\S+) · (handoff|message|recap)$/;

const AT_FLOOR_MS = Date.parse('2020-01-01T00:00:00Z');
const AT_SLACK_MS = 24 * 60 * 60 * 1000;

function isoOf(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  try { return new Date(t).toISOString(); } catch (err) { return ''; }
}

function atMs(at) {
  const t = Date.parse(String(at == null ? '' : at));
  return Number.isFinite(t) ? t : NaN;
}

function validAt(at) {
  if (typeof at !== 'string' || !ISO_RE.test(at)) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  let iso;
  try { iso = new Date(t).toISOString(); } catch (err) { return false; }
  if (iso.slice(0, 19) !== at.slice(0, 19)) return false;
  return t >= AT_FLOOR_MS && t <= Date.now() + AT_SLACK_MS;
}

function feedHead(line) {
  const m = FEED_HEAD_RE.exec(line);
  if (!m) return null;
  if (!validAt(m[1])) return null;
  const from = m[2].toLowerCase();
  if (!isId(from)) return null;
  const to = m[3] === 'all' ? 'all' : m[3].toLowerCase();
  if (to !== 'all' && !isId(to)) return null;
  return { at: m[1], from: from.toUpperCase(), to: to, kind: m[4] };
}

function isPacketPath(p) {
  if (typeof p !== 'string' || p.charAt(0) !== '/') return false;
  for (const ch of p) {
    const c = ch.codePointAt(0);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

const NO_PATH = '(no packet path)';

function readFeed(folder) {
  let text;
  try { text = fs.readFileSync(feedPath(folder), 'utf8'); } catch (err) { return []; }
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = feedHead(lines[i]);
    if (!m) continue;
    if (i === 0 || lines[i - 1] !== '') continue;
    let summary = '';
    let full = '';
    for (let k = i + 1; k < lines.length; k++) {
      if (feedHead(lines[k]) && lines[k - 1] === '') break;
      if (!summary && /^summary: /.test(lines[k])) { summary = asciiPreview(lines[k].slice(9)); continue; }
      if (!full && /^full: /.test(lines[k])) {
        const raw = lines[k].slice(6).trim();
        full = isPacketPath(raw) ? raw : '';
        continue;
      }
    }
    out.push({ at: m.at, from: m.from, to: m.to, kind: m.kind, summary: summary, full: full });
  }
  return out;
}

function initialFeed(gid) {
  return [
    '# Feed — ' + gid,
    '',
    'Every handoff, message and turn recap that has crossed this link, oldest first.',
    'One entry per packet; the packet itself is the file named under full:.',
    'Written by tools/agent-link.mjs — append-only, never edited by hand.',
    'Grammar: a "## " header counts only when a blank line precedes it, and inside an',
    'entry only the two keyword lines are read. A body cannot forge either.',
    '',
  ].join('\n');
}

function writePacket(folder, gid, fromId, kind, to, body) {
  const at = isoNow();
  try {
    fs.mkdirSync(packetsDir(folder), { recursive: true });
  } catch (err) {
    die(3, 'cannot create ' + packetsDir(folder) + ' (' + err.message + ')');
  }
  const header = [
    '# ' + kind.toUpperCase() + ' from ' + fromId.toUpperCase() + ' · ' + at,
    'group: ' + gid,
    'to: ' + to,
    '',
    '',
  ].join('\n');
  const stampPart = fileStamp(at);
  let file = null;
  for (let n = 0; n < 50; n++) {
    const cand = path.join(packetsDir(folder), fromId + '-' + stampPart + (n ? '-' + (n + 1) : '') + '.md');
    try {
      fs.writeFileSync(cand, header + body + (body.endsWith('\n') ? '' : '\n'), { flag: 'wx' });
      file = cand;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') die(3, 'cannot write ' + cand + ' (' + err.message + ')');
    }
  }
  if (!file) die(3, 'cannot find a free packet name in ' + packetsDir(folder));

  const summary = summarise(body);
  const entry = [
    '## ' + at + ' · ' + fromId.toUpperCase() + ' → ' + (to === 'all' ? 'all' : to.toUpperCase()) +
      ' · ' + kind,
    '',
    'summary: ' + summary,
    'full: ' + file,
    '',
  ].join('\n');
  const ffile = feedPath(folder);
  let text;
  try {
    text = fs.readFileSync(ffile, 'utf8');
  } catch (err) {
    text = initialFeed(gid);
  }
  const gap = text.endsWith('\n\n') ? '' : (text.endsWith('\n') ? '\n' : '\n\n');
  const next = text + gap + entry;
  const tmp = ffile + '.tmp-agent-link-' + process.pid;
  try {
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, ffile);
  } catch (err) {
    die(3, 'cannot write ' + ffile + ' (' + err.message + ')');
  }
  let back;
  try { back = fs.readFileSync(ffile, 'utf8'); } catch (err) { back = ''; }
  if (back !== next) die(3, 'wrote ' + ffile + ' but read back something else — check the file');
  return { at: at, file: file, summary: summary, kind: kind, from: fromId, to: to };
}

function unreadFor(folder, me) {
  if (!me) return [];
  let cursor = '';
  try { cursor = fs.readFileSync(seenPath(folder, me), 'utf8').trim(); } catch (err) { cursor = ''; }
  let cursorMs = NaN;
  if (cursor) {
    const ct = atMs(cursor);
    if (!Number.isFinite(ct) || ct > Date.now()) cursorMs = NaN;
    else cursorMs = ct;
  }
  const ME = me.toUpperCase();
  return readFeed(folder).filter(function (e) {
    if (e.from === ME) return false;
    if (e.to !== 'all' && e.to !== me) return false;
    if (!Number.isFinite(cursorMs)) return true;
    const em = atMs(e.at);
    return !Number.isFinite(em) || em > cursorMs;
  });
}

function markSeen(folder, me, entries) {
  if (!me || !entries.length) return;
  const now = Date.now();
  let best = NaN;
  for (const e of entries) {
    const m = atMs(e.at);
    if (Number.isFinite(m) && (!Number.isFinite(best) || m > best)) best = m;
  }
  if (!Number.isFinite(best) || best > now) best = now;
  let newest = new Date(best).toISOString();
  try {
    fs.writeFileSync(seenPath(folder, me) + '.tmp-' + process.pid, newest + '\n');
    fs.renameSync(seenPath(folder, me) + '.tmp-' + process.pid, seenPath(folder, me));
  } catch (err) { }
}

function feedAt(e) { return asciiPreview(e.at); }
function feedFrom(e) { return asciiPreview(e.from); }
function feedTo(e) { return asciiPreview(e.to); }
function feedFull(e) { return isPacketPath(e.full) ? e.full : NO_PATH; }

function unreadBlock(entries) {
  const out = ['## Unread'];
  if (!entries.length) { out.push('(none)'); return out; }
  for (const e of entries) {
    out.push(feedAt(e) + ' · ' + feedFrom(e) + ' · ' + e.kind + ' · ' + e.summary +
      ' — full: ' + feedFull(e));
  }
  return out;
}

async function deliver(gid, folder, packet, members, only) {
  const st = await status();
  const body = typedLine(gid, packet.from, packet.kind, packet.summary, packet.file);
  const out = [];
  const targets = members.filter(function (id) {
    if (id === packet.from) return false;
    if (only) return id === only;
    return true;
  });
  for (const id of targets) {
    const NAME = id.toUpperCase();
    const s = st && st.sessions ? st.sessions[id] : null;
    if (!st || !s || s.running !== true) {
      out.push('→ ' + NAME + ' queued (not live)');
      continue;
    }
    const q = '/api/input?session=' + encodeURIComponent(id);
    const r1 = await request('POST', q, body);
    if (!r1.ok) {
      if (r1.status === 409 || r1.status === 0) {
        out.push('→ ' + NAME + ' queued (not live' + (r1.why ? ': ' + r1.why : '') + ')');
      } else {
        out.push('→ ' + NAME + ' failed: HTTP ' + r1.status);
      }
      continue;
    }
    await sleepAsync(ENTER_DELAY_MS);
    const r2 = await request('POST', q, '\r');
    if (!r2.ok) {
      out.push('→ ' + NAME + ' failed: the line was typed but the return was not (' +
        (r2.status ? 'HTTP ' + r2.status : r2.why) + ')');
      continue;
    }
    out.push('→ ' + NAME + ' delivered (typed)');
  }
  return { lines: out, body: body };
}

function procPPid(pid) {
  let text;
  try { text = fs.readFileSync(path.join(PROC, String(pid), 'status'), 'utf8'); } catch (err) { return 0; }
  const m = /^PPid:\s*(\d+)/m.exec(text);
  return m ? Number(m[1]) : 0;
}

async function whoamiId() {
  const st = await status();
  if (!st) return { err: 3, msg: 'cannot reach the Agent Terminal at ' + TERM };
  const byPid = {};
  for (const id of Object.keys(st.sessions)) {
    const s = st.sessions[id];
    if (s && typeof s.pid === 'number' && s.pid > 0) byPid[String(s.pid)] = id;
  }
  const chain = [];
  let pid = process.ppid;
  const seen = {};
  while (pid && pid > 1 && !seen[pid]) {
    seen[pid] = true;
    chain.push(pid);
    if (byPid[String(pid)]) return { id: byPid[String(pid)], chain: chain };
    pid = procPPid(pid);
  }
  return { err: 2, msg: 'not inside an Agent Terminal session', chain: chain };
}

function childPids(pid) {
  try {
    return fs.readFileSync(path.join(PROC, String(pid), 'task', String(pid), 'children'), 'utf8')
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (err) { }
  let names;
  try { names = fs.readdirSync(PROC); } catch (err) { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    if (procPPid(Number(n)) === pid) out.push(Number(n));
  }
  return out;
}

function cmdlineOf(pid) {
  try {
    return fs.readFileSync(path.join(PROC, String(pid), 'cmdline'), 'utf8')
      .split(/[\u0000\s]+/).filter(Boolean);
  } catch (err) { return []; }
}

function sendMessageName(id, st) {
  if (HARNESS_RE.test(id)) {
    if (id.slice(0, id.indexOf('-')) === 'claude') return '— (private HOME)';
    return null;
  }
  const s = st && st.sessions ? st.sessions[id] : null;
  if (!s || typeof s.pid !== 'number' || s.pid <= 0 || s.running !== true) return null;
  const queue = childPids(s.pid);
  for (let i = 0; i < queue.length && i < 64; i++) {
    const pid = queue[i];
    const argv = cmdlineOf(pid);
    const exe = argv.length ? path.basename(argv[0]) : '';
    if (/^claude/.test(exe)) {
      try {
        const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, 'sessions', pid + '.json'), 'utf8'));
        if (reg && typeof reg.name === 'string' && reg.name) return reg.name;
      } catch (err) { return '—'; }
      return '—';
    }
    for (const c of childPids(pid)) if (queue.indexOf(c) === -1) queue.push(c);
  }
  return '—';
}

function protocolBlock(gid, me) {
  const T = 'node ' + SELF;
  return [
    '## Protocol',
    '(a) This line was typed into your terminal by Agent Console because your operator linked your tile to',
    '    the tiles above. You were linked MID-WORK: do not ask what you are doing today, and do not stop.',
    '(b) NOW, before anything else, write your handoff packet from what you already know — TASK, STATE,',
    '    DECISIONS, FILES TOUCHED, NEXT, OPEN QUESTIONS, 400 words max:',
    '      ' + T + ' handoff ' + gid + ' --me ' + me + ' --text "..."',
    '    (or --file <path>, or - to read it from stdin). Your peers get its summary at their prompt the',
    '    moment you run it, and the packet itself is a file they can open.',
    '(c) Read every packet listed under Unread above before your next chunk of work. The summary in',
    '    the typed line is the essential content; the packet holds the detail. If your session asks',
    '    permission to read the packets folder, that is expected — allow it for the session.',
    '(d) Then say in 3 lines or fewer who you are linked with and what they are on, and CONTINUE.',
    '(e) Anything a peer needs now: ' + T + ' send ' + gid + ' --me ' + me + ' [--to <peer>] --text "..."',
    '    Catch up any time: show ' + gid + ' --me ' + me + '  and  feed ' + gid + ' --me ' + me,
    '    A decision that touches a peer\'s files goes under Key Decisions in context.md, NAMING the peer.',
    '    Your first line becomes the PREVIEW a peer is shown, and it is printable ASCII by construction:',
    '    accents fold to their base letter (cafe), long dashes become -, anything else non-ASCII shows as',
    '    ?, [LINK becomes (LINK and full: becomes full-. Your packet keeps the text exactly as you wrote',
    '    it, so write the first line so it still reads in ASCII, and put the detail in the body.',
    '(f) Claude Code and Codex tiles push their turn recap through this link automatically after every',
    '    finished turn — nothing to do. A pi, cursor or grok tile has no auto-recap wired: run send',
    '    yourself after a meaningful chunk of work.',
    '(g) A peer shown above as SendMessage: <name> is a Claude Code session you can ALSO reach in-band',
    '    with the SendMessage tool at that name. The typed delivery happens either way — it is not a',
    '    replacement for the packet, it is a second door for a live back-and-forth.',
    '(h) leave arrives typed by the page when the link is cut, and a join with a different group id',
    '    replaces this group. Only ever run these commands with --me ' + me + ' — your own id.',
  ];
}

function initialContext(gid, at) {
  return [
    '# ' + gid + ' \u2014 Terminal link (Agent Terminal :5075)',
    '',
    '**Created:** ' + at + ' ET   **Status:** In Progress',
    '**What this is:** these terminals are linked on Agent Console. Every member runs in',
    'coordination mode: read this file before starting a new chunk of work, keep your NOW line current',
    '(`agent-link.mjs now`), log decisions here and sessions in session-log.md.',
    '',
    '## Members',
    START,
    HEAD,
    SEP,
    END,
    '',
    '## Protocol',
    '- Before a new chunk of work: `agent-link.mjs show ' + gid + '` (peers\' NOW + decisions).',
    '- After a meaningful chunk: `agent-link.mjs now ' + gid + ' --me <id> "<what, which files>"` and a session-log entry.',
    '- A decision that touches a peer\'s files or work: write it under Key Decisions and NAME the peer.',
    '- Shared output lives in this folder or is named here by path.',
    '',
    '## Key Decisions',
    '- (none yet)',
    '',
    '## Open Questions',
    '- (none yet)',
    '',
  ].join('\n');
}

function initialLog(gid) {
  return [
    '# Session Log \u2014 ' + gid,
    '',
    'Append-only. One entry per meaningful chunk of work, newest last:',
    '`## <YYYY-MM-DD HH:MM ET> \u2014 <NAME> <what happened>` (Goal / Done / Decisions / Next underneath).',
    '',
  ].join('\n');
}

function createIfAbsent(file, body) {
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    die(3, 'cannot create ' + file + ' (' + err.message + ')');
  }
}

function sectionBody(lines, heading) {
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() === heading) { i = k; break; }
  }
  if (i === -1) return [heading, '(section missing from context.md)'];
  const out = [lines[i]];
  for (let k = i + 1; k < lines.length; k++) {
    if (/^## /.test(lines[k])) break;
    out.push(lines[k]);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function lastLogEntries(folder, n) {
  let text;
  try { text = fs.readFileSync(logPath(folder), 'utf8'); } catch (err) { return []; }
  const lines = text.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (/^## /.test(lines[i])) starts.push(i);
  if (!starts.length) return [];
  const take = starts.slice(-n);
  const out = [];
  for (let k = 0; k < take.length; k++) {
    const from = take[k];
    const to = (k + 1 < take.length) ? take[k + 1] : lines.length;
    const block = lines.slice(from, to);
    while (block.length && !block[block.length - 1].trim()) block.pop();
    for (const l of block) out.push(l);
  }
  return out;
}

function brief(gid, folder, ctx, labels, opts) {
  const o = opts || {};
  const st = o.st || null;
  const out = [];
  out.push(gid + ' ' + NONE + ' ' + folder + path.sep);
  out.push('');
  const present = orderIds(ctx.rows);
  for (const id of present) {
    const r = ctx.rows[id];
    const state = r.state === 'joined' ? 'joined ' + r.at
      : (r.state === 'left' ? 'left ' + r.at : 'not joined yet');
    let line = id.toUpperCase() + DOT + roleOf(id) + DOT + 'project bar: ' + (labels[id] || NONE) +
      DOT + state;
    const s = st && st.sessions ? st.sessions[id] : null;
    line += DOT + 'live: ' + (!st ? 'unknown' : (s && s.running === true ? 'yes' : 'no'));
    const name = st ? sendMessageName(id, st) : null;
    if (name) line += DOT + 'SendMessage: ' + name;
    out.push(line);
  }
  out.push('');
  for (const id of present) {
    const r = ctx.rows[id];
    out.push(r.now ? id.toUpperCase() + ' NOW (' + r.nowAt + '): ' + r.now
      : id.toUpperCase() + ' NOW: (not set)');
  }
  out.push('');
  for (const l of (o.extra || [])) out.push(l);
  if (o.extra && o.extra.length) out.push('');
  for (const l of sectionBody(ctx.lines, '## Key Decisions')) out.push(l);
  out.push('');
  for (const l of sectionBody(ctx.lines, '## Open Questions')) out.push(l);
  out.push('');
  out.push('## Session log (last 5)');
  const entries = lastLogEntries(folder, 5);
  if (!entries.length) out.push('(none yet)');
  for (const l of entries) out.push(l);
  return out.join('\n');
}

function usage() {
  console.error([
    'usage:',
    '  agent-link.mjs join    <gid> --me <id> [--members a,b,c]',
    '  agent-link.mjs now     <gid> --me <id> "<what you are doing, which files>"',
    '  agent-link.mjs leave   <gid> --me <id>',
    '  agent-link.mjs show    <gid> [--me <id>]',
    '  agent-link.mjs list',
    '  agent-link.mjs handoff <gid> --me <id> [--to <peer>] (--text "..." | --file <p> | -)',
    '  agent-link.mjs send    <gid> --me <id> [--to <peer>] (--text "..." | --file <p> | -)',
    '  agent-link.mjs feed    <gid> [--me <id>] [--since <iso>]',
    '  agent-link.mjs push    --auto|--me <id> [--payload -] [--codex] [--gemini] [--text "..."]',
    '  agent-link.mjs whoami',
    '',
    'typed at a linked session by the Agent Terminal, not run by hand. The folder is',
    '<projects root>/<gid>-link/; join prints the whole protocol.',
    '',
    '  gid:  tl- + 4..8 lowercase letters/digits',
    '  id:   ' + IDS.join(' '),
    '        or a harness tile id: <claude|codex|cursor|grok|gemini|pi>-<5 lowercase letters/digits>',
    '  now:  <= ' + NOW_MAX + ' chars, letters digits space and . _ / & + : , ( ) [ ] # \' " ; ! ? = % @ * -',
    '        (it lands in a markdown table cell: no | < > backtick $ or newline)',
    '',
    'exit: 0 ok  2 refusal  3 IO/lock failure',
  ].join('\n'));
}

function parseArgs(argv) {
  const positional = [];
  const out = {
    me: null, members: null, to: null, text: null, file: null,
    payload: null, transcript: null, since: null,
    auto: false, codex: false, gemini: false,
  };
  const VALUED = {
    '--me': 'me', '--members': 'members', '--to': 'to', '--text': 'text',
    '--file': 'file', '--payload': 'payload', '--transcript': 'transcript', '--since': 'since',
  };
  const FLAGS = { '--auto': 'auto', '--codex': 'codex', '--gemini': 'gemini' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED[a]) {
      const v = argv[++i];
      if (v === undefined) { usage(); die(2, a + ' needs a value'); }
      out[VALUED[a]] = v;
    } else if (FLAGS[a]) {
      out[FLAGS[a]] = true;
    } else {
      positional.push(a);
    }
  }
  out.positional = positional;
  return out;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch (err) { return ''; }
}

function needGid(gid) {
  if (!gid) { usage(); die(2, 'a group id is required (tl-xxxxx)'); }
  if (!GID_RE.test(gid)) {
    die(2, 'bad group id "' + gid + '" — expected tl- followed by 4 to 8 lowercase letters or digits');
  }
  return gid;
}

function needMe(me) {
  if (!me) { usage(); die(2, '--me <id> is required — the CLI records who is speaking'); }
  if (!isId(me)) die(2, 'unknown id "' + me + '" — expected one of ' + ID_HELP);
  return me;
}

function parseMembers(spec) {
  if (!spec) return [];
  const out = [];
  for (const raw of spec.split(',')) {
    const id = raw.trim();
    if (!id) continue;
    if (!isId(id)) {
      die(2, 'unknown id "' + id + '" in --members — expected ' + ID_HELP);
    }
    if (out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

function needFolder(root, gid) {
  const folder = folderFor(root, gid);
  if (!isDir(folder)) die(2, 'unknown group ' + gid + ' (no ' + folder + ')');
  return folder;
}

async function cmdJoin(gid, me, memberSpec) {
  const root = projectsRoot();
  const folder = folderFor(root, gid);
  const members = parseMembers(memberSpec);
  if (members.indexOf(me) === -1) members.push(me);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    die(3, 'cannot create ' + folder + ' (' + err.message + ')');
  }
  const at = stamp();
  let already = false;
  withLock(folder, function () {
    createIfAbsent(ctxPath(folder), initialContext(gid, at));
    createIfAbsent(logPath(folder), initialLog(gid));
    const ctx = readCtx(folder);
    const labels = pageLabels();
    for (const id of members) {
      if (!ctx.rows[id]) ctx.rows[id] = { id: id, state: 'none', at: '', now: '', nowAt: '' };
    }
    already = ctx.rows[me].state === 'joined';
    if (!already) {
      ctx.rows[me].state = 'joined';
      ctx.rows[me].at = at;
    }
    const region = emitRegion(ctx.rows, labels);
    if (region.join('\n') !== ctx.lines.slice(ctx.start + 1, ctx.end).join('\n')) {
      writeCtx(ctx, region);
    }
    if (!already) appendLog(folder, '## ' + at + ' \u2014 ' + me.toUpperCase() + ' joined');
  });
  const ctx = readCtx(folder);
  refreshLinkFeed(gid, folder, null);
  const st = await status();
  const unread = unreadFor(folder, me);
  console.log('LINKED on Agent Console ' + NONE + ' you are ' + me.toUpperCase() +
    ' in ' + gid + ' (' + folder + path.sep + ')');
  console.log((already ? 'already joined ' : 'joined ') + gid + ' as ' + me.toUpperCase());
  console.log(brief(gid, folder, ctx, pageLabels(), {
    st: st,
    extra: unreadBlock(unread).concat(['']).concat(protocolBlock(gid, me)),
  }));
  markSeen(folder, me, unread);
}

function cmdNow(gid, me, textParts) {
  const raw = textParts.join(' ').replace(/\s+/g, ' ').trim();
  if (!raw) die(2, 'now needs one line of text — what you are doing and which files');
  if (raw.length > NOW_MAX) {
    die(2, 'now text is ' + raw.length + ' chars, the cell holds ' + NOW_MAX +
      ' — one sentence, not a paragraph');
  }
  if (!NOW_OK.test(raw)) {
    die(2, 'now text has characters the members table cannot hold; allowed: letters, digits, ' +
      'space . _ / & + : , ( ) [ ] # \' -');
  }
  const root = projectsRoot();
  const folder = needFolder(root, gid);
  const at = stamp();
  withLock(folder, function () {
    const ctx = readCtx(folder);
    if (!ctx.rows[me]) die(2, me + ' is not a member of ' + gid + ' — run join first');
    ctx.rows[me].now = raw;
    ctx.rows[me].nowAt = at;
    writeCtx(ctx, emitRegion(ctx.rows, pageLabels()));
    appendLog(folder, '## ' + at + ' \u2014 ' + me.toUpperCase() + ' now: ' + raw);
  });
  console.log(me.toUpperCase() + ' NOW (' + at + '): ' + raw + '   [' + gid + ']');
}

function cmdLeave(gid, me) {
  const root = projectsRoot();
  const folder = needFolder(root, gid);
  const at = stamp();
  let already = false;
  withLock(folder, function () {
    const ctx = readCtx(folder);
    if (!ctx.rows[me]) die(2, me + ' is not a member of ' + gid);
    already = ctx.rows[me].state === 'left';
    if (already) return;
    ctx.rows[me].state = 'left';
    ctx.rows[me].at = at;
    ctx.rows[me].now = '';
    ctx.rows[me].nowAt = '';
    writeCtx(ctx, emitRegion(ctx.rows, pageLabels()));
    appendLog(folder, '## ' + at + ' \u2014 ' + me.toUpperCase() + ' left');
  });
  refreshLinkFeed(gid, folder, null);
  console.log(me.toUpperCase() + (already ? ' had already left ' : ' left ') + gid);
}

async function cmdShow(gid, me) {
  const root = projectsRoot();
  const folder = needFolder(root, gid);
  const ctx = readCtx(folder);
  if (me && !ctx.rows[me]) die(2, me + ' is not a member of ' + gid + ' \u2014 run join first');
  const st = await status();
  const unread = me ? unreadFor(folder, me) : [];
  console.log(brief(gid, folder, ctx, pageLabels(), {
    st: st,
    extra: me ? unreadBlock(unread) : null,
  }));
  if (me) markSeen(folder, me, unread);
}

function packetBody(args, what) {
  if (args.text !== null) return args.text;
  if (args.file !== null) {
    try { return fs.readFileSync(args.file, 'utf8'); } catch (err) {
      die(2, 'cannot read ' + args.file + ' (' + err.message + ')');
    }
  }
  if (args.positional.indexOf('-') !== -1) return readStdin();
  die(2, what + ' needs a body: --text "..." , --file <path>, or - to read stdin');
}

async function cmdPacket(kind, gid, me, args) {
  const root = projectsRoot();
  const folder = needFolder(root, gid);
  const body = packetBody(args, kind);
  if (!String(body).trim()) die(2, kind + ' body is empty \u2014 say something a peer can act on');
  if (Buffer.byteLength(body) > PACKET_MAX) {
    die(2, kind + ' body is ' + Buffer.byteLength(body) + ' bytes, the cap is ' + PACKET_MAX +
      ' \u2014 put the detail in a file in the group folder and name it in the body');
  }
  const ctx = readCtx(folder);
  if (!ctx.rows[me]) die(2, me + ' is not a member of ' + gid + ' \u2014 run join first');
  let only = null;
  if (args.to) {
    only = args.to;
    if (!isId(only)) die(2, 'unknown id "' + only + '" in --to \u2014 expected ' + ID_HELP);
    if (!ctx.rows[only]) die(2, only + ' is not a member of ' + gid);
    if (only === me) die(2, '--to names you; a packet is never delivered to its sender');
  }
  let packet = null;
  withLock(folder, function () {
    packet = writePacket(folder, gid, me, kind, only || 'all', body);
    appendLog(folder, '## ' + stamp() + ' \u2014 ' + me.toUpperCase() + ' ' + kind + ': ' + packet.summary);
  });
  refreshLinkFeed(gid, folder, {
    at: packet.at, from: me.toUpperCase(), kind: kind, summary: packet.summary, full: packet.file,
  });
  const members = orderIds(ctx.rows).filter(function (id) { return ctx.rows[id].state !== 'left'; });
  const d = await deliver(gid, folder, packet, members, only);
  console.log(kind + ' ' + packet.file);
  console.log('summary: ' + packet.summary);
  for (const l of d.lines) console.log(l);
}

function cmdFeed(gid, me, since) {
  const root = projectsRoot();
  const folder = needFolder(root, gid);
  if (me) {
    const ctx = readCtx(folder);
    if (!ctx.rows[me]) die(2, me + ' is not a member of ' + gid + ' \u2014 run join first');
  }
  let entries = readFeed(folder);
  if (since) {
    const sinceMs = atMs(since);
    if (!ISO_RE.test(since) || !Number.isFinite(sinceMs) ||
        isoOf(since).slice(0, 19) !== since.slice(0, 19)) {
      die(2, 'bad --since "' + since + '" — expected an ISO stamp like ' +
        '2026-09-05T22:22:11Z or 2026-09-05T22:22:11.068Z');
    }
    entries = entries.filter(function (e) {
      const em = atMs(e.at);
      return Number.isFinite(em) && em > sinceMs;
    });
  }
  if (!entries.length) {
    console.log('no context has crossed ' + gid + (since ? ' since ' + since : '') + ' yet');
  } else {
    for (const e of entries) {
      console.log(feedAt(e) + ' \u00b7 ' + feedFrom(e) + ' \u2192 ' + feedTo(e) + ' \u00b7 ' + e.kind +
        ' \u00b7 ' + e.summary + ' \u2014 full: ' + feedFull(e));
    }
  }
  if (me) markSeen(folder, me, readFeed(folder));
}

const TRANSCRIPT_TAIL_MAX = 1024 * 1024;

function claudeRecapFromTranscript(file) {
  let text = '';
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    const size = st.size;
    if (!size) return '';
    const len = Math.min(size, TRANSCRIPT_TAIL_MAX);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, size - len);
    text = buf.slice(0, got).toString('utf8');
    if (len < size) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
  } catch (err) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { }
    }
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let o;
    try { o = JSON.parse(raw); } catch (err) { continue; }
    if (!o || o.type !== 'assistant' || o.isSidechain === true) continue;
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (let k = content.length - 1; k >= 0; k--) {
      const b = content[k];
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
    }
  }
  return '';
}

function pushRecap(args, argv) {
  if (args.text !== null) return args.text;
  if (args.codex) {
    for (let i = argv.length - 1; i >= 0; i--) {
      const a = argv[i];
      if (typeof a !== 'string' || a.charAt(0) !== '{') continue;
      let o;
      try { o = JSON.parse(a); } catch (err) { continue; }
      if (!o || typeof o !== 'object') continue;
      if (o.type && o.type !== 'agent-turn-complete') return '';
      return String(o['last-assistant-message'] || '');
    }
    return '';
  }
  const raw = (args.payload !== null || args.gemini) ? readStdin() : '';
  if (args.transcript) {
    const t = claudeRecapFromTranscript(args.transcript);
    if (t) return t;
  }
  if (!raw.trim()) return '';
  let o;
  try { o = JSON.parse(raw); } catch (err) { return ''; }
  if (!o || typeof o !== 'object') return '';
  if (args.gemini) return typeof o.prompt_response === 'string' ? o.prompt_response : '';
  if (typeof o.last_assistant_message === 'string' && o.last_assistant_message.trim()) {
    return o.last_assistant_message;
  }
  if (typeof o.transcript_path === 'string' && o.transcript_path) {
    return claudeRecapFromTranscript(o.transcript_path);
  }
  return '';
}

function groupsOf(root) {
  let names;
  try { names = fs.readdirSync(root); } catch (err) { return []; }
  return names.filter(function (n) {
    return /-link$/.test(n) && GID_RE.test(n.slice(0, -5)) && isDir(path.join(root, n));
  }).sort();
}

async function cmdPush(args, argv) {
  const root = projectsRoot();
  const dirs = groupsOf(root);
  if (!dirs.length) return;
  let me = args.me;
  if (me && !isId(me)) die(2, 'unknown id "' + me + '" \u2014 expected one of ' + ID_HELP);
  if (!me) {
    if (!args.auto) { usage(); die(2, 'push needs --me <id> or --auto'); }
    const who = await whoamiId();
    if (who.err) return;
    me = who.id;
  }
  const mine = [];
  for (const n of dirs) {
    const folder = path.join(root, n);
    const ctx = readCtxSafe(folder);
    if (!ctx || !ctx.rows[me] || ctx.rows[me].state !== 'joined') continue;
    mine.push({ gid: n.slice(0, -5), folder: folder });
  }
  if (!mine.length) return;
  let recap = pushRecap(args, argv);
  if (!recap || !recap.trim()) return;
  recap = recap.trim();
  if (recap.length > RECAP_MAX) recap = recap.slice(0, RECAP_MAX - 1).trim() + '\u2026';
  for (const g of mine) {
    let prev = '';
    try { prev = fs.readFileSync(lastRecapPath(g.folder, me), 'utf8'); } catch (err) { prev = ''; }
    if (prev === recap) continue;
    const ctx = readCtx(g.folder);
    let packet = null;
    withLock(g.folder, function () {
      packet = writePacket(g.folder, g.gid, me, 'recap', 'all', recap);
      try {
        fs.writeFileSync(lastRecapPath(g.folder, me) + '.tmp-' + process.pid, recap);
        fs.renameSync(lastRecapPath(g.folder, me) + '.tmp-' + process.pid, lastRecapPath(g.folder, me));
      } catch (err) { }
    });
    refreshLinkFeed(g.gid, g.folder, {
      at: packet.at, from: me.toUpperCase(), kind: 'recap', summary: packet.summary, full: packet.file,
    });
    const members = orderIds(ctx.rows).filter(function (id) { return ctx.rows[id].state !== 'left'; });
    const d = await deliver(g.gid, g.folder, packet, members, null);
    console.log('recap ' + packet.file);
    for (const l of d.lines) console.log(l);
  }
}

async function cmdWhoami() {
  const who = await whoamiId();
  if (who.err === 3) die(3, who.msg + ' \u2014 cannot tell which tile this is');
  if (who.err) {
    die(2, who.msg + ' (walked pids ' + (who.chain || []).join(' -> ') + ')');
  }
  console.log(who.id);
}

function cmdList() {
  const root = projectsRoot();
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    die(3, 'cannot read ' + root + ' (' + err.message + ')');
  }
  const groups = names.filter(function (n) {
    return /-link$/.test(n) && GID_RE.test(n.slice(0, -5)) && isDir(path.join(root, n));
  }).sort();
  if (!groups.length) {
    console.log('no terminal link groups');
    return;
  }
  for (const n of groups) {
    const gid = n.slice(0, -5);
    const folder = path.join(root, n);
    const ctx = readCtx(folder);
    let created = NONE;
    for (const line of ctx.lines) {
      const m = /^\*\*Created:\*\* (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) ET/.exec(line);
      if (m) { created = m[1]; break; }
    }
    console.log(gid + '   created ' + created + '   ' + folder + path.sep);
    for (const id of orderIds(ctx.rows)) {
      const r = ctx.rows[id];
      const state = r.state === 'joined' ? 'joined ' + r.at
        : (r.state === 'left' ? 'left ' + r.at : 'not joined yet');
      console.log('  ' + id.toUpperCase().padEnd(6) + ' ' + state);
    }
  }
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
  usage();
  process.exit(argv.length ? 0 : 2);
}

const cmd = argv[0];
const args = parseArgs(argv.slice(1));

async function main() {
  if (cmd === 'list') return cmdList();
  if (cmd === 'join') return cmdJoin(needGid(args.positional[0]), needMe(args.me), args.members);
  if (cmd === 'now') return cmdNow(needGid(args.positional[0]), needMe(args.me), args.positional.slice(1));
  if (cmd === 'leave') return cmdLeave(needGid(args.positional[0]), needMe(args.me));
  if (cmd === 'show') return cmdShow(needGid(args.positional[0]), args.me ? needMe(args.me) : null);
  if (cmd === 'handoff' || cmd === 'send') {
    return cmdPacket(cmd === 'handoff' ? 'handoff' : 'message',
      needGid(args.positional[0]), needMe(args.me), args);
  }
  if (cmd === 'feed') {
    return cmdFeed(needGid(args.positional[0]), args.me ? needMe(args.me) : null, args.since);
  }
  if (cmd === 'push') return cmdPush(args, argv);
  if (cmd === 'whoami') return cmdWhoami();
  usage();
  die(2, 'unknown command "' + cmd + '"');
}

main().then(function () {
  process.exit(0);
}, function (err) {
  die(3, 'unexpected failure in ' + cmd + ': ' + (err && err.stack ? err.stack : err));
});
