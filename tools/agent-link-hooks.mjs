import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'agent-link.mjs');
const ROOT = process.env.AGENT_LINK_HOOKS_ROOT || os.homedir();

const CLAUDE_CMD = 'node ' + TOOL + ' push --auto --payload - 2>/dev/null || true';
const GEMINI_CMD = 'node ' + TOOL + ' push --auto --gemini 2>/dev/null || true';
const CODEX_NOTIFY = ['node', TOOL, 'push', '--auto', '--codex'];
const MARK = 'agent-link.mjs';
const CLAUDE_TIMEOUT = 10;
const GEMINI_TIMEOUT = 10000;

const CLAUDE_FILE = path.join(ROOT, '.claude', 'settings.json');
const CODEX_FILE = path.join(ROOT, '.codex', 'config.toml');
const GEMINI_FILE = path.join(ROOT, '.gemini', 'settings.json');

function die(code, msg) {
  console.error('agent-link-hooks: ' + msg);
  process.exit(code);
}

function stampNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = [];
  for (let i = 0; i <= n; i++) lcs.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let k = m - 1; k >= 0; k--) {
      lcs[i][k] = a[i] === b[k] ? lcs[i + 1][k + 1] + 1 : Math.max(lcs[i + 1][k], lcs[i][k + 1]);
    }
  }
  const out = [];
  let i = 0;
  let k = 0;
  while (i < n && k < m) {
    if (a[i] === b[k]) { out.push([' ', a[i]]); i++; k++; }
    else if (lcs[i + 1][k] >= lcs[i][k + 1]) { out.push(['-', a[i]]); i++; }
    else { out.push(['+', b[k]]); k++; }
  }
  while (i < n) { out.push(['-', a[i]]); i++; }
  while (k < m) { out.push(['+', b[k]]); k++; }
  return out;
}

function printDiff(file, before, after) {
  if (before === after) { console.log('  (no change)'); return false; }
  const rows = diffLines(before.split('\n'), after.split('\n'));
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === ' ') continue;
    for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) keep[k] = true;
  }
  console.log('--- ' + file);
  console.log('+++ ' + file + '  (after)');
  let gap = false;
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) { if (!gap) { console.log('  @@'); gap = true; } continue; }
    gap = false;
    console.log('  ' + rows[i][0] + rows[i][1]);
  }
  return true;
}

function loadJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, text: '', data: {}, nl: true };
    die(3, 'cannot read ' + file + ' (' + err.message + ')');
  }
  let data;
  try { data = JSON.parse(text); } catch (err) {
    die(2, file + ' is not valid JSON (' + err.message + ') — fix it before installing hooks');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    die(2, file + ' is not a JSON object');
  }
  const nl = text.endsWith('\n');
  const round = JSON.stringify(data, null, 2) + (nl ? '\n' : '');
  if (round !== text) {
    die(2, file + ' does not round-trip through a 2-space JSON dump, so this script cannot ' +
      'prove it would change only the hook — normalise the file by hand first');
  }
  return { missing: false, text: text, data: data, nl: nl };
}

function dumpJson(data, nl) {
  return JSON.stringify(data, null, 2) + (nl ? '\n' : '');
}

function hookGroups(data, event) {
  if (!data.hooks || typeof data.hooks !== 'object') return null;
  const g = data.hooks[event];
  return Array.isArray(g) ? g : null;
}

function findOurs(groups) {
  const hits = [];
  if (!groups) return hits;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const hooks = g && Array.isArray(g.hooks) ? g.hooks : [];
    for (let hi = 0; hi < hooks.length; hi++) {
      const h = hooks[hi];
      if (h && typeof h.command === 'string' && h.command.indexOf(MARK) !== -1) hits.push({ gi, hi });
    }
  }
  return hits;
}

function addHook(data, event, command, timeout) {
  const next = JSON.parse(JSON.stringify(data));
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
  next.hooks[event].push({ hooks: [{ type: 'command', command: command, timeout: timeout }] });
  return next;
}

function removeHook(data, event) {
  const next = JSON.parse(JSON.stringify(data));
  const groups = hookGroups(next, event);
  if (!groups) return next;
  const kept = [];
  for (const g of groups) {
    const hooks = (g && Array.isArray(g.hooks)) ? g.hooks : [];
    const left = hooks.filter(function (h) {
      return !(h && typeof h.command === 'string' && h.command.indexOf(MARK) !== -1);
    });
    if (!hooks.length || left.length) {
      const copy = Object.assign({}, g);
      copy.hooks = left;
      kept.push(copy);
    }
  }
  if (kept.length) next.hooks[event] = kept;
  else delete next.hooks[event];
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

function loadToml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, text: '' };
    die(3, 'cannot read ' + file + ' (' + err.message + ')');
  }
  return { missing: false, text: text };
}

function notifyLine() {
  return 'notify = [' + CODEX_NOTIFY.map(function (s) { return JSON.stringify(s); }).join(', ') + ']';
}

function tomlHasOurs(text) {
  return text.split('\n').some(function (l) {
    return /^\s*notify\s*=/.test(l) && l.indexOf(MARK) !== -1;
  });
}

function tomlHasForeignNotify(text) {
  return text.split('\n').some(function (l) {
    return /^\s*notify\s*=/.test(l) && l.indexOf(MARK) === -1;
  });
}

function tomlAdd(text) {
  const lines = text.split('\n');
  let at = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { at = i; break; }
  }
  const block = at === lines.length ? [notifyLine(), ''] : [notifyLine(), ''];
  const next = lines.slice(0, at).concat(block).concat(lines.slice(at));
  return next.join('\n');
}

function tomlRemove(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*notify\s*=/.test(lines[i]) && lines[i].indexOf(MARK) !== -1) {
      if (i + 1 < lines.length && lines[i + 1] === '') i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

function plan(mode) {
  const items = [];

  const claude = loadJson(CLAUDE_FILE);
  const claudeHits = findOurs(hookGroups(claude.data, 'Stop'));
  items.push({
    name: 'Claude Code Stop hook',
    file: CLAUDE_FILE,
    missing: claude.missing,
    installed: claudeHits.length > 0,
    before: claude.text,
    after: claude.missing ? claude.text
      : dumpJson(mode === 'install'
        ? (claudeHits.length ? claude.data : addHook(claude.data, 'Stop', CLAUDE_CMD, CLAUDE_TIMEOUT))
        : removeHook(claude.data, 'Stop'), claude.nl),
    detail: 'hooks.Stop -> ' + CLAUDE_CMD,
  });

  const codex = loadToml(CODEX_FILE);
  const codexOurs = tomlHasOurs(codex.text);
  items.push({
    name: 'Codex notify',
    file: CODEX_FILE,
    missing: codex.missing,
    installed: codexOurs,
    foreign: tomlHasForeignNotify(codex.text),
    before: codex.text,
    after: codex.missing ? codex.text
      : (mode === 'install' ? (codexOurs ? codex.text : tomlAdd(codex.text)) : tomlRemove(codex.text)),
    detail: notifyLine(),
  });

  const gem = loadJson(GEMINI_FILE);
  const gemHits = findOurs(hookGroups(gem.data, 'AfterAgent'));
  items.push({
    name: 'Gemini CLI AfterAgent hook',
    file: GEMINI_FILE,
    missing: gem.missing,
    installed: gemHits.length > 0,
    before: gem.text,
    after: gem.missing ? gem.text
      : dumpJson(mode === 'install'
        ? (gemHits.length ? gem.data : addHook(gem.data, 'AfterAgent', GEMINI_CMD, GEMINI_TIMEOUT))
        : removeHook(gem.data, 'AfterAgent'), gem.nl),
    detail: 'hooks.AfterAgent -> ' + GEMINI_CMD,
  });

  return items;
}

function writeItem(item) {
  const base = item.file + '.bak-pre-links-hooks-' + stampNow();
  let bak = null;
  for (let n = 0; n < 20; n++) {
    const cand = base + (n ? '-' + (n + 1) : '');
    try {
      fs.copyFileSync(item.file, cand, fs.constants.COPYFILE_EXCL);
      bak = cand;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') die(3, 'cannot back up ' + item.file + ' (' + err.message + ')');
    }
  }
  if (!bak) die(3, 'cannot find a free backup name beside ' + item.file);
  const tmp = item.file + '.tmp-agent-link-hooks-' + process.pid;
  try {
    fs.writeFileSync(tmp, item.after);
    fs.renameSync(tmp, item.file);
  } catch (err) {
    die(3, 'cannot write ' + item.file + ' (' + err.message + ')');
  }
  let back;
  try { back = fs.readFileSync(item.file, 'utf8'); } catch (err) { back = ''; }
  if (back !== item.after) die(3, 'wrote ' + item.file + ' but read back something else');
  console.log('  wrote ' + item.file);
  console.log('  backup ' + bak);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const GO = argv.indexOf('--go') !== -1;

if (!cmd || cmd === '-h' || cmd === '--help') {
  console.error([
    'usage:',
    '  agent-link-hooks.mjs status',
    '  agent-link-hooks.mjs install [--go]      (dry run without --go)',
    '  agent-link-hooks.mjs uninstall [--go]    (dry run without --go)',
    '',
    'root: ' + ROOT + '   (AGENT_LINK_HOOKS_ROOT)',
    'tool: ' + TOOL,
  ].join('\n'));
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'status') {
  const items = plan('install');
  for (const it of items) {
    const state = it.missing ? 'file missing' : (it.installed ? 'INSTALLED' : 'not installed');
    console.log(it.name + ': ' + state);
    console.log('  file: ' + it.file);
    console.log('  would be: ' + it.detail);
    if (it.foreign) console.log('  NOTE: this file already has a notify = line that is not ours; install would leave it and add nothing');
    if (!it.missing && !it.installed) {
      const changed = it.before !== it.after;
      console.log('  install would change the file: ' + (changed ? 'yes' : 'no'));
    }
  }
  process.exit(0);
}

if (cmd !== 'install' && cmd !== 'uninstall') {
  die(2, 'unknown command "' + cmd + '" — status, install or uninstall');
}

const items = plan(cmd);
let changes = 0;
for (const it of items) {
  console.log('');
  console.log('== ' + it.name + ' (' + it.file + ')');
  if (it.missing) { console.log('  file does not exist — skipped'); continue; }
  if (cmd === 'install' && it.foreign && !it.installed) {
    console.log('  a foreign notify = line is already there — refusing to add a second one');
    continue;
  }
  const changed = printDiff(it.file, it.before, it.after);
  if (!changed) continue;
  changes++;
  if (GO) writeItem(it);
}

console.log('');
if (!changes) {
  console.log(cmd === 'install' ? 'nothing to install — every hook is already in place'
    : 'nothing to remove — no hook of ours is installed');
} else if (GO) {
  console.log(changes + ' file(s) written. Re-run with no --go to see that nothing is left to do.');
} else {
  console.log('DRY RUN — ' + changes + ' file(s) would change. Re-run with --go to write them.');
}
process.exit(0);
