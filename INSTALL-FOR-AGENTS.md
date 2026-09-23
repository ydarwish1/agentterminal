# Installing Agent Terminal — guide for coding agents

Follow these steps in order. Steps marked **ASK** need a real answer from your user, so don't guess. Don't report success until steps 4 and 6 pass.

## 1. Check the machine

```bash
node --version    # must be v20 or newer
cc --version      # Linux only; if this fails: sudo apt-get install -y build-essential python3
```

## 2. Install

```bash
npm install
```

If it fails on `node-pty`, the compiler is missing. Install it and retry.

## 3. Run setup

```bash
npm run setup
```

If there's no TTY, setup reads answers from piped stdin. An empty pipe accepts every default. Re-running setup offers the current answers as defaults, so it is always safe to run again.

| It asks | Your answer |
|---|---|
| Port | `5075`, unless that port is taken |
| Open from another machine? | **ASK.** No = localhost only. Yes = also give the hostname or IP they will type in the browser. |
| Folders terminals may open in | **ASK.** For example `~/projects`. Anything outside these folders is refused. |
| Coding CLIs to install | **ASK** which of the missing CLIs they want. Setup asks before it runs any install. |
| Agents | **ASK.** See step 5. Can be skipped. |
| Telegram | **ASK.** It's optional and off by default. Only works for `claude` agents. |

## 4. Prove it works

```bash
npm run check
```

This is the acceptance test. It boots a real server, checks that the page and the server agree, and starts a real terminal. It must end with `all checks passed` and exit 0.

`npm test` is the server's own test suite, and it should also pass.

## 5. Make an agent show up

A **named agent** is a permanent tile that always runs the same CLI in the same folder. Named agents live in `config.json` under `agents`:

```json
{ "id": "nova", "name": "NOVA", "role": "dev", "harness": "claude", "cwd": "/home/me/work/agents/nova", "icon": "dot" }
```

- `harness` is one of `claude`, `codex`, `cursor`, `grok`, `gemini` or `pi`.
- `icon` is one of `dot`, `ring`, `bar` or `grok`.
- `accent: true` paints one agent orange.
- Add named agents through `npm run setup`, or edit `config.json` and restart.

**Using Agent View too?** Give each agent the same `id` as its Agent View slot (`prime`, `nova`, `core`, `orion`, `echo`, `astra`). Set its `cwd` to a folder that ends in `agents/<id>`. The agent then appears on the Agent View map, and that map's **OPEN TERMINAL** button opens this tile (`/?agent=<id>`).

For a one-off terminal, you don't need an agent: **EDIT → ADD**, switch on a CLI, **SAVE**, **START**.

## 6. Verify visually

```bash
npm start
```

Open **http://localhost:5075**, or take a screenshot with a headless browser. Check that:
- each named agent has a tile with its name
- **START** on a tile gives a live terminal running its CLI
- a CLI that isn't installed shows **NOT INSTALLED** instead of failing silently

Also open `http://localhost:5075/?agent=<id>` and confirm it opens that agent's tile full screen.

## 7. Report back

Tell your user:
- the URL
- which CLIs are installed and which aren't
- which named agents exist

A missing CLI is not an error. Install it later and its tile turns on by itself.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pty backend missing` | `node-pty` didn't build. Install the compiler, then run `npm install` again. |
| Tile says NOT INSTALLED | That CLI isn't on the server's PATH. Install it, or set `pathPrefix` in `config.json`. |
| Blank page from another machine | Add that hostname to `allowedHostNames` in `config.json`, then restart. |
| Port in use | Change `port` in `config.json`, or start with `AGENT_CONSOLE_PORT=<n> npm start`. |

**Security:** this page hands out a real shell. Keep it on localhost, or behind a VPN or tunnel. Tokens go in `.env` only, never in `config.json`.
