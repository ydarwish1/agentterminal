import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PAGE = process.env.AGENT_CONSOLE_PAGE || path.join(HERE, '..', 'index.html');
const LINE_RE = /^ {2}var PROJECTS = (\{.*\}); \/\/ AGENT-PROJECTS$/;

function consoleAgents() {
  const read = function (f) {
    try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', f), 'utf8')); } catch (e) { return {}; }
  };
  const d = read('config.default.json');
  const u = read('config.json');
  return (u.agents !== undefined ? u.agents : d.agents) || [];
}

function transcriptDirName(id) {
  const agent = consoleAgents().find(function (a) { return a.id === id; });
  const cwd = (agent && agent.cwd) || '';
  return cwd.replace(/[\\/]/g, '-');
}

const IDS = consoleAgents().map(function (a) { return a.id; });
const STATES = ['working', 'needs-input', 'done', 'clear'];
const MAX_CHARS = 24;
const MAX_WORDS = 4;
const OK_CHARS = /^[A-Za-z0-9 ._/&+-]+$/;

let SOFT = false;

const TRANSCRIPTS = process.env.AGENT_PROJECT_TRANSCRIPTS ||
  path.join(os.homedir(), '.claude', 'projects');
const SUB_FRESH_MS = 12 * 3600 * 1000;
const SUB_MAX = 4;
const SUB_DESC_MAX = 40;
const SUB_OK = /[^A-Za-z0-9 ._/&+:,()[\]#-]+/g;

function scrubDesc(s) {
  return String(s == null ? '' : s).replace(SUB_OK, ' ').replace(/\s+/g, ' ').trim().slice(0, SUB_DESC_MAX);
}

function runningSubs(id) {
  const dir = path.join(TRANSCRIPTS, transcriptDirName(id));
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return []; }
  const now = Date.now();
  const out = [];
  for (const n of names) {
    const subsDir = path.join(dir, n, 'subagents');
    const parent = path.join(dir, n + '.jsonl');
    let metas;
    try { metas = fs.readdirSync(subsDir).filter((f) => f.endsWith('.meta.json')); } catch (err) { continue; }
    const recent = metas.filter((f) => {
      try { return now - fs.statSync(path.join(subsDir, f)).mtimeMs < SUB_FRESH_MS; } catch (err) { return false; }
    });
    if (!recent.length) continue;
    let lines;
    try { lines = fs.readFileSync(parent, 'utf8').split('\n'); } catch (err) { continue; }
    for (const f of recent) {
      const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      if (!/^[a-z0-9]{6,32}$/.test(agentId)) continue;
      let done = false;
      for (const line of lines) {
        if (line.includes(agentId) && line.includes('"type":"queue-operation"')) { done = true; break; }
      }
      if (done) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(subsDir, f), 'utf8')); } catch (err) { continue; }
      const desc = scrubDesc(meta.description) || scrubDesc(meta.agentType) || 'subagent';
      let at = 0;
      try { at = fs.statSync(path.join(subsDir, 'agent-' + agentId + '.jsonl')).mtimeMs; } catch (err) { at = 0; }
      out.push({ desc, at });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, SUB_MAX).map((s) => s.desc);
}

function die(code, msg) {
  console.error('agent-project: ' + msg);
  process.exit(SOFT ? 0 : code);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn) {
  const lock = PAGE + '.lock';
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
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (e) { }
    try { fs.unlinkSync(lock); } catch (e) { }
  }
}

function usage() {
  console.error([
    'usage:',
    '  agent-project.mjs <id> working     "<project>"',
    '  agent-project.mjs <id> needs-input ["<project>"]',
    '  agent-project.mjs <id> done        "<project>"',
    '  agent-project.mjs <id> clear',
    '  agent-project.mjs list',
    '',
    'called by a session hook, not by hand:',
    '  agent-project.mjs <id> auto-working   needs-input -> working, + subs (UserPromptSubmit)',
    '  agent-project.mjs <id> auto-subs      refresh running subagents  (Stop)',
    '',
    'nothing derives `done` — only the agent saying the project shipped does.',
    '',
    '  id:      ' + IDS.join(' '),
    '  project: <= ' + MAX_CHARS + ' chars, <= ' + MAX_WORDS + ' words, [A-Za-z0-9 ._/&+-]',
  ].join('\n'));
}

function load() {
  let text;
  try {
    text = fs.readFileSync(PAGE, 'utf8');
  } catch (err) {
    die(3, 'cannot read ' + PAGE + ' (' + err.message + ')');
  }
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (LINE_RE.test(lines[i])) hits.push(i);
  if (hits.length !== 1) {
    die(3, 'expected exactly 1 line matching the AGENT-PROJECTS marker in ' + PAGE +
      ', found ' + hits.length + ' — the page was edited; restore the marker line first');
  }
  const idx = hits[0];
  let data;
  try {
    data = JSON.parse(LINE_RE.exec(lines[idx])[1]);
  } catch (err) {
    die(3, 'the AGENT-PROJECTS line is not valid JSON (' + err.message + ')');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    die(3, 'the AGENT-PROJECTS line is not a JSON object');
  }
  return { lines, idx, data };
}

function save(state, data) {
  const line = '  var PROJECTS = ' + JSON.stringify(data) + '; // AGENT-PROJECTS';
  if (!LINE_RE.test(line)) die(3, 'refusing to write: the new line does not match its own marker');
  const next = state.lines.slice();
  next[state.idx] = line;
  for (let i = 0; i < next.length; i++) {
    if (i !== state.idx && next[i] !== state.lines[i]) die(3, 'refusing to write: line ' + i + ' would change');
  }
  const tmp = PAGE + '.tmp-agent-project-' + process.pid;
  fs.writeFileSync(tmp, next.join('\n'));
  fs.renameSync(tmp, PAGE);

  const back = load();
  if (JSON.stringify(back.data) !== JSON.stringify(data)) {
    die(3, 'wrote the line but read back something else — check ' + PAGE);
  }
}

function show(data) {
  const ids = IDS.filter((id) => data[id]);
  if (!ids.length) {
    console.log('no project records set (every agent tile still shows its session state)');
    return;
  }
  for (const id of ids) {
    const r = data[id];
    console.log(id.padEnd(6) + ' ' + String(r.state).padEnd(12) + ' ' +
      (r.project || '') + (r.at ? '   (' + r.at + ')' : ''));
    for (const d of (r.subs || [])) console.log('       subagent: ' + d);
  }
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
  usage();
  process.exit(argv.length ? 0 : 2);
}

if (argv[0] === 'list') {
  show(load().data);
  process.exit(0);
}

const [id, state, ...rest] = argv;
if (IDS.indexOf(id) === -1) {
  usage();
  die(2, 'unknown id "' + id + '"');
}

if (state === 'auto-working' || state === 'auto-subs') {
  SOFT = true;
  withLock(function () {
    const st = load();
    const rec = st.data[id];
    if (!rec) {
      console.log(id + ': ' + state + ' no-op (no record)');
      return;
    }
    const before = JSON.stringify(rec);
    if (state === 'auto-working' && rec.state === 'needs-input') rec.state = 'working';
    if (state === 'auto-subs') rec.idle = true;
    else delete rec.idle;
    const subs = runningSubs(id);
    if (subs.length) rec.subs = subs;
    else delete rec.subs;
    if (JSON.stringify(rec) === before) {
      console.log(id + ': ' + state + ' no-op (' + rec.state +
        ', ' + subs.length + ' subagents)');
      return;
    }
    rec.at = new Date().toISOString();
    save(st, st.data);
    console.log(id + ': ' + state + ' -> ' + rec.state + ', ' + subs.length +
      ' subagents' + (subs.length ? ': ' + subs.join(' | ') : ''));
  });
  process.exit(0);
}

if (STATES.indexOf(state) === -1) {
  usage();
  die(2, 'unknown state "' + (state === undefined ? '' : state) + '"');
}

const project = rest.join(' ').trim();
if (state === 'working' || state === 'done') {
  if (!project) die(2, state + ' needs a project name — "' + state + '" alone says nothing on the bar');
}
if (project) {
  if (project.length > MAX_CHARS) {
    die(2, 'project is ' + project.length + ' chars, the bar holds ' + MAX_CHARS +
      ' — name the project, do not describe the task');
  }
  if (project.split(/\s+/).length > MAX_WORDS) {
    die(2, 'project is ' + project.split(/\s+/).length + ' words, the bar holds ' + MAX_WORDS +
      ' — name the project, do not describe the task');
  }
  if (!OK_CHARS.test(project)) {
    die(2, 'project has characters the bar does not take; allowed: letters, digits, space . _ / & + -');
  }
}

withLock(function () {
  const st = load();
  if (state === 'clear') {
    if (!st.data[id]) {
      console.log(id + ': nothing to clear');
      return;
    }
    delete st.data[id];
    save(st, st.data);
    console.log(id + ': record cleared — the bar now shows session state only (WORKING / STOPPED)');
    return;
  }

  st.data[id] = { state, project, at: new Date().toISOString() };
  save(st, st.data);
  const label = state === 'working' ? 'WORKING ON' : state === 'done' ? 'DONE WITH' : 'NEEDS INPUT';
  console.log(id + ': ' + (label + ' ' + project).trim().toUpperCase() +
    '   (open tabs pick it up within 60s)');
});
