# Agent WebBridge CLI

**Browser Use CLI 3.0 for your real Chrome.** A clean-room local CDP relay —
one thin MV3 extension plus one local Node daemon — that lets the script-based
Browser Harness drive your actual browser with your real login sessions.

Why this is different from per-click browser tools (MCP servers, tool-call
browsers, Kimi WebBridge): the agent writes **one Python script** instead of
emitting a tool call per click. Browser Harness measures ~6x less output, and
Hermes's tests measured **48-66% fewer tokens with no accuracy drop**. This
project keeps that efficiency and adds what a raw CDP attach can't give you:
zero browser flags, no "Allow remote debugging" prompt, a green status badge,
and everything staying on 127.0.0.1.

```
browser-harness ──CDP over WS──▶ daemon ──WS──▶ MV3 extension ──chrome.debugger──▶ your Chrome
```

- **Real sessions** — your cookies, your logins, your extensions. Nothing re-logged-in headless.
- **Trusted clicks** — CDP Input domain passes through to chrome.debugger, so clicks are real compositor-level events, not `el.click()`.
- **Clean room** — our own extension, our own daemon. No closed code, no account, no telemetry. MIT.
- **One dep** — the daemon uses only `ws`. The extension uses zero libraries.

## Install

```bash
# 1. daemon + CLI
npm i -g agent-webbridge-cli

# 2. load the extension (one time)
#    chrome://extensions → Developer mode → Load unpacked → <repo>/extension
#    (or: awb-cli pack → dist/agent-webbridge-cli-extension-v*.zip → extract → Load unpacked)

# 3. start the daemon
awb-cli up          # default ws://127.0.0.1:9377, logs ~/.agent-webbridge-cli/daemon.log
awb-cli status      # expect: extension CONNECTED
```

The extension popup shows a green **Up and running** badge when connected.

## Use with Browser Harness (Browser Use CLI 3.0)

```bash
uv tool install browser-harness   # once

BU_CDP_WS=ws://127.0.0.1:9377/devtools/browser/awb browser-harness <<'PY'
print("TABS:", list_tabs())
t = new_tab("https://news.ycombinator.com/")
wait_for_load()
print("TITLE:", js("document.title"))
capture_screenshot("/tmp/hn.png")
PY
```

## CLI

| Command | Does |
|---|---|
| `awb-cli up [--port N]` | Start the daemon (background, pid + log under ~/.agent-webbridge-cli/) |
| `awb-cli down` | Stop the daemon |
| `awb-cli status` | Daemon + extension connection state, BU_CDP_WS hint |
| `awb-cli doctor` | Node/daemon/extension/browser-harness checks with hints |
| `awb-cli test` | Browser-free contract suite (daemon + stub extension) |
| `awb-cli pack` | Zip the extension into dist/ |

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `OB_PORT` | `9377` | Daemon port |
| `OB_EXT_ID` | — | Pin the daemon to one extension `runtimeId` (see chrome://extensions) |

## Security model

The daemon binds **127.0.0.1 only**. Any local process can drive your browser
through it — that is the same trust boundary as Kimi WebBridge's local service
and is inherent to any local bridge. Pin the extension id with `OB_EXT_ID` to
narrow it. Never run the daemon on a shared machine without that pin.

## Limitations

- One Chrome profile (the one the extension is loaded in). Multi-profile is a roadmap item.
- One debugger holder per tab: if another debugger extension (e.g. Kimi
  WebBridge) is attached to a tab, commands on that tab fail until it detaches.
- macOS/Chrome first; the daemon is platform-neutral, the extension is Chrome/Edge MV3.

## Layout

```
bin/awb-cli.mjs       CLI
src/daemon/           index (HTTP+WS wiring) · cdp (Target emulation + routing) · ext (extension link) · state
extension/            MV3 extension (background relay, popup badge)
scripts/              pack-extension
test/                 contract.mjs + stub.mjs (browser-free, npm test)
BUILD_SPEC.md         the executable contract — read before changing protocol/emulation
```

## License

MIT © 0xIbra
