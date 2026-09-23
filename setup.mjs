
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = path.join(HERE, 'config.default.json');
const CONFIG_FILE = path.join(HERE, 'config.json');
const ENV_FILE = path.join(HERE, '.env');

const defaults = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
const current = fs.existsSync(CONFIG_FILE)
  ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  : {};

const INTERACTIVE = Boolean(process.stdin.isTTY);
const rl = INTERACTIVE
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;

let piped = [];
if (!INTERACTIVE) {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (err) { raw = ''; }
  piped = raw.length ? raw.split('\n') : [];
}

function ask(q) {
  if (INTERACTIVE) return new Promise((res) => rl.question(q, (a) => res(a.trim())));
  const a = piped.length ? piped.shift() : '';
  process.stdout.write(q + a + '\n');
  return Promise.resolve(a.trim());
}

const B = (s) => '\x1b[1m' + s + '\x1b[0m';
const DIM = (s) => '\x1b[2m' + s + '\x1b[0m';
const OK = (s) => '\x1b[32m' + s + '\x1b[0m';
const NO = (s) => '\x1b[31m' + s + '\x1b[0m';

function say(s = '') { console.log(s); }

async function askText(question, fallback) {
  const shown = fallback === '' || fallback == null ? '' : DIM(' [' + fallback + ']');
  const a = await ask(question + shown + ' ');
  return a === '' ? (fallback ?? '') : a;
}

async function askYesNo(question, fallbackYes) {
  const hint = fallbackYes ? ' [Y/n] ' : ' [y/N] ';
  for (;;) {
    const a = (await ask(question + DIM(hint))).toLowerCase();
    if (a === '') return !!fallbackYes;
    if (a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
    say('  please answer y or n');
  }
}

async function askPick(question, items) {
  for (;;) {
    const a = (await askText(question + DIM(' (numbers, all, none)'), '')).toLowerCase();
    if (a === '' || a === 'none' || a === 'no' || a === 'n') return [];
    if (a === 'all' || a === 'a') return items.slice();
    const parts = a.split(/[\s,]+/).filter(Boolean);
    const nums = parts.map(Number);
    if (parts.length && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= items.length)) {
      return [...new Set(nums)].map((n) => items[n - 1]);
    }
    say('  ' + DIM('  numbers from the list (1, or 1,3, or 1 3), or all, or none'));
  }
}

function detectHarnesses(harnesses) {
  const found = {};
  for (const [id, h] of Object.entries(harnesses)) {
    let where = '';
    try {
      where = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', h.bin], { encoding: 'utf8' }).trim();
    } catch { where = ''; }
    found[id] = where;
  }
  return found;
}

const PATH_PREFIX = current.pathPrefix || path.join(os.homedir(), '.local', 'bin');

function executableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (err) { return false; }
}

function runInstalls(ids) {
  for (const id of ids) {
    const h = defaults.harnesses[id];
    say();
    say('  ' + DIM('$ ') + h.install);
    let code = 0;
    try {
      execFileSync('/bin/sh', ['-c', h.install], { stdio: 'inherit' });
    } catch (err) {
      code = typeof (err && err.status) === 'number' ? err.status : 1;
    }
    say('  ' + (code === 0 ? OK('✓') : NO('✗')) + ' ' + h.label + DIM(' — exit ' + code));
  }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch { return false; }
}

function checkPty() {
  try { require('node-pty'); return { ok: true }; }
  catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
}

say();
say(B('  Agent Console — setup'));
say(DIM('  Enter accepts the value in brackets. Ctrl-C to bail; nothing is written until the end.'));
say();

const pty = checkPty();
if (pty.ok) {
  say('  ' + OK('✓') + ' terminal backend (node-pty) loaded');
} else {
  say('  ' + NO('✗') + ' terminal backend (node-pty) will not load');
  say(DIM('     ' + pty.why));
  say();
  say('     node-pty is a native module, so it compiles on install. Install the');
  say('     build tools for your OS, then run ' + B('npm install') + ' again:');
  say();
  say('       Debian/Ubuntu   sudo apt-get install -y build-essential python3');
  say('       macOS           xcode-select --install');
  say('       Fedora/RHEL     sudo dnf install -y gcc-c++ make python3');
  say();
  say('     Setup will carry on — the console will serve the page and tell you');
  say('     the same thing, but no terminal will start until this is fixed.');
  say();
}

say(B('  1. Where should the console listen?'));
say();
const port = Number(await askText('  Port', String(current.port ?? defaults.port))) || defaults.port;

const remote = await askYesNo(
  '  Will you open this from another machine (VPS, home server, tailnet)?',
  current.bindHost ? current.bindHost !== '127.0.0.1' : false
);

let bindHost = '127.0.0.1';
let allowedHostNames = ['localhost', '127.0.0.1'];
if (remote) {
  bindHost = '0.0.0.0';
  say();
  say(DIM('  This page gives whoever opens it a real shell. Put it behind a VPN,'));
  say(DIM('  a tailnet, or an SSH tunnel — never straight onto the public internet.'));
  const name = await askText(
    '  Hostname or IP you will type in the browser',
    (current.allowedHostNames || []).find((h) => h !== 'localhost' && h !== '127.0.0.1') || os.hostname()
  );
  allowedHostNames = ['localhost', '127.0.0.1'];
  if (name && !allowedHostNames.includes(name)) allowedHostNames.push(name);
}
say();

say(B('  2. Which folders may terminals open in?'));
say(DIM('  Anything outside these is refused, symlinks and .. included.'));
say();
const defaultRoot = (current.workRoots && current.workRoots[0]) || path.join(os.homedir(), 'projects');
const rootsAnswer = await askText('  Folder(s), comma-separated', defaultRoot);
const workRoots = rootsAnswer.split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => (s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : path.resolve(s)));
for (const r of workRoots) {
  if (fs.existsSync(r)) say('  ' + OK('✓') + ' ' + r);
  else if (ensureDir(r)) say('  ' + OK('✓') + ' ' + r + DIM(' (created)'));
  else say('  ' + NO('✗') + ' ' + r + DIM(' (could not create — fix the path and re-run)'));
}
const defaultCwd = workRoots[0] || '';
say();

say(B('  3. Coding CLIs'));
say();
const detected = detectHarnesses(defaults.harnesses);
const available = [];
const missing = [];
for (const [id, h] of Object.entries(defaults.harnesses)) {
  if (detected[id]) {
    available.push(id);
    say('  ' + OK('✓') + ' ' + h.label.padEnd(14) + DIM(detected[id]));
  } else {
    missing.push(id);
    say('  ' + DIM('·') + ' ' + h.label.padEnd(14) + DIM('not found — no `' + h.bin + '` on your PATH'));
  }
}
say();

if (missing.length === 0) {
  say(DIM('  Every CLI is installed. Nothing to decide here.'));
} else {
  say('  ' + B('Not installed') + DIM(' — pick any you want and setup will tell you how:'));
  say();
  missing.forEach((id, i) => {
    say('    ' + (i + 1) + '. ' + defaults.harnesses[id].label.padEnd(14) + DIM(defaults.harnesses[id].bin));
  });
  say();

  const picked = await askPick('  Which do you want?', missing);
  if (picked.length === 0) {
    say(DIM('  Skipped. Install any of them later and they appear on their own.'));
  } else {
    say();
    say('  ' + (picked.length === 1 ? 'Install it with:' : 'Install them with:'));
    say();
    for (const id of picked) say('    ' + B(defaults.harnesses[id].install));
    say();
    say(DIM('  The vendors\' own commands. Read one before you let it run.'));
    say();

    if (await askYesNo('  Run these now?', false)) {
      runInstalls(picked);
      say();
      say('  After installing:');
      const after = detectHarnesses(Object.fromEntries(picked.map((id) => [id, defaults.harnesses[id]])));
      for (const id of picked) {
        const h = defaults.harnesses[id];
        const local = path.join(PATH_PREFIX, h.bin);
        if (after[id]) {
          available.push(id);
          say('  ' + OK('✓') + ' ' + h.label.padEnd(14) + DIM(after[id]));
        } else if (executableFile(local)) {
          available.push(id);
          say('  ' + OK('✓') + ' ' + h.label.padEnd(14) + DIM(local));
          say('    ' + DIM('not on this shell\'s PATH yet; the console prepends ' + PATH_PREFIX + ' to'));
          say('    ' + DIM('every terminal, so the tile finds it. Open a new shell for your own.'));
        } else {
          say('  ' + NO('✗') + ' ' + h.label.padEnd(14) + DIM('still not found — install it by hand, setup carries on'));
        }
      }
    } else {
      say(DIM('  Left above to copy-paste. Setup carries on either way.'));
    }
  }
}
say();

say(B('  4. Agents'));
say(DIM('  An agent is a named tile: one CLI, one folder, always in the same place'));
say(DIM('  on the board. Harness tiles cover the throwaway case — you can skip this.'));
say();

const agents = [];
const keepExisting = (current.agents || []).length > 0 &&
  await askYesNo('  Keep your ' + current.agents.length + ' existing agent(s)?', true);
if (keepExisting) agents.push(...current.agents);

if (await askYesNo('  Add ' + (agents.length ? 'another' : 'an') + ' agent now?', agents.length === 0)) {
  const defaultHarness = available[0] || 'claude';
  for (;;) {
    say();
    const name = await askText('    Name (short, e.g. ATLAS)', '');
    if (!name) break;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const role = await askText('    Role (e.g. Dev, Research, Review)', '');
    const harness = await askText('    Which CLI ' + DIM('(' + (available.join('/') || 'claude') + ')'), defaultHarness);
    const cwd = await askText('    Folder it works in', defaultCwd);
    const icon = await askText('    Icon ' + DIM('(dot / ring / bar / grok)'), 'dot');
    agents.push({
      id, name: name.toUpperCase(), role, harness, cwd,
      icon: ['dot', 'ring', 'bar', 'grok'].includes(icon) ? icon : 'dot',
      accent: agents.length === 0,
    });
    say('    ' + OK('✓') + ' ' + name.toUpperCase() + ' — ' + harness + ' in ' + cwd);
    if (!(await askYesNo('    Add another?', false))) break;
  }
}
say();

say(B('  5. Text your agents from Telegram?') + DIM('  (optional)'));
say();
say('  With this on, an agent tile also answers a Telegram bot: message the bot');
say('  from your phone and the same session that is running in the browser replies.');
say(DIM('  It uses the Claude Code telegram plugin, so it applies to `claude` agents.'));
say();

let telegram = { enabled: false };
const envLines = [];

if (await askYesNo('  Set up Telegram?', !!(current.telegram && current.telegram.enabled))) {
  say();
  say('  One bot per agent. To make one:');
  say('    1. Open Telegram and message ' + B('@BotFather'));
  say('    2. Send ' + B('/newbot') + ' and follow the prompts');
  say('    3. Copy the token it gives you (looks like 12345678:AA...)');
  say();
  say(DIM('  Tokens go in .env, which is gitignored. They never enter config.json.'));
  say();

  const claudeAgents = agents.filter((a) => a.harness === 'claude');
  if (claudeAgents.length === 0) {
    say('  ' + DIM('No `claude` agents configured, so there is nothing to attach a bot to.'));
    say('  ' + DIM('Add one and re-run setup.'));
  } else {
    let any = false;
    for (const a of claudeAgents) {
      const token = await askText('  Bot token for ' + B(a.name) + DIM(' (Enter to skip)'), '');
      if (!token) continue;
      const key = 'TELEGRAM_BOT_TOKEN_' + a.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      envLines.push(key + '=' + token);
      a.telegram = { tokenEnv: key };
      any = true;
      say('    ' + OK('✓') + ' ' + a.name + ' → ' + key);
    }
    telegram.enabled = any;
    if (any) {
      say();
      say('  ' + B('One more step, and only you can do it:'));
      say('  Claude Code loads the telegram plugin from your own config, so enable it once:');
      say();
      say('    claude');
      say('    /plugin install telegram@claude-plugins-official');
      say();
      say(DIM('  Then start that agent\'s tile. The console passes it the token and its own'));
      say(DIM('  state folder, and the same session answers both the browser and your phone.'));
    }
  }
}
say();

const config = {
  title: current.title || defaults.title,
  port,
  bindHost,
  allowedHostNames,
  workRoots,
  defaultCwd,
  agents,
  telegram,
};

fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
say('  ' + OK('✓') + ' wrote ' + CONFIG_FILE);

if (envLines.length) {
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const kept = existing.split('\n').filter((l) => {
    const k = l.split('=')[0];
    return l.trim() && !envLines.some((n) => n.split('=')[0] === k);
  });
  fs.writeFileSync(ENV_FILE, [...kept, ...envLines].join('\n') + '\n', { mode: 0o600 });
  say('  ' + OK('✓') + ' wrote ' + ENV_FILE + DIM(' (mode 600, gitignored)'));
}

say();
say(B('  Done. Start it:'));
say();
say('    npm start');
say();
say('    ' + DIM('→ http://' + (remote ? allowedHostNames[2] || 'your-host' : 'localhost') + ':' + port));
say();

if (rl) rl.close();
