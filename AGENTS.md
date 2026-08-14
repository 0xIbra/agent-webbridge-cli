# AGENTS.md — repo guide for agents

Agent WebBridge CLI: clean-room local CDP relay that lets Browser Use CLI 3.0
(Browser Harness) drive the user's real Chrome with real sessions. Two pieces
we own: an MV3 extension (transport only) and a Node daemon (CDP emulation).

## Read first

- `BUILD_SPEC.md` — the executable contract: architecture, the enumerated CDP
  surface browser-harness calls, the ext<->daemon protocol, concurrency rules,
  the MV3 keepalive requirement, security model, testing policy. It wins over
  any other doc.

## Conventions

- **Extension stays dumb.** Never add tool logic, snapshot builders, or agent
  semantics to the extension — that is Browser Harness's job. The extension is
  transport: attach map, CDP passthrough, tab ops, keepalive.
- **One runtime dep** (ws). Adding a dependency needs a reason stronger than
  convenience.
- **Tests must never touch real Chrome or real data dirs.** `npm test` is
  browser-free (stub extension). Every protocol/emulation change adds or
  updates a contract case in test/contract.mjs.
- **Do not regress the keepalive** (heartbeat ping every 20s + 1-min alarm +
  daemon reconnect wait). MV3 suspension silently kills the extension socket;
  this is a known failure class, fixed once, do not reintroduce.
- **Daemon binds 127.0.0.1 only.** Never 0.0.0.0.
- Ports: default 9377, override with OB_PORT (daemon) / STUB_EXT_PORT (tests).

## Verification ladder

1. `npm test` — protocol contract (fast, browser-free).
2. `awb-cli pack` — extension zips clean.
3. Live run (manual, needs the user): load extension, `awb-cli up`, then
   `BU_CDP_WS=... browser-harness <<'PY' ... PY`. Live evidence beats any
   claim — especially for chrome.debugger fidelity.
