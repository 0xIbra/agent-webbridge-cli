---
name: agent-webbridge-cli
description: "Browser Use CLI 3.0 on your real Chrome via local CDP relay."
version: 0.1.1
author: 0xIbra
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [browser, automation, cdp, browser-harness, chrome, real-browser]
---

# Agent WebBridge CLI Skill

Drives the user's REAL Chrome — real sessions, real logins, nothing re-logged-in
headless — with Browser Use CLI 3.0 (Browser Harness) through the
agent-webbridge-cli local CDP relay: one MV3 extension + one local daemon we
own. The agent writes Python scripts instead of emitting a tool call per click,
so runs cost ~6x fewer tokens (48-66% measured by Hermes) and clicks are real
trusted CDP events, not synthetic `el.click()`.

## When to Use

- Any web interaction: navigate, click, type, scrape, form filling, screenshots.
- When the user's logged-in session matters (their accounts, their cookies).
- Sites that check `event.isTrusted` — trusted clicks pass through chrome.debugger.
- Multi-tab or batch browsing tasks.

Don't use for a plain public fetch — use `web_extract` or `terminal` curl first;
escalate to the browser only when the task needs interaction, login state, JS
rendering, or bot-protected pages.

## Prerequisites

- `npm i -g agent-webbridge-cli` (daemon + `awb-cli`)
- Extension loaded: chrome://extensions → Developer mode → Load unpacked →
  the repo's `extension/` directory. The popup shows a green **Up and running**
  badge when connected.
- `uv tool install browser-harness` (the CLI 3.0 script runner)
- Daemon: `awb-cli up` (default `ws://127.0.0.1:9377`)

## How to Run

Check readiness, then run a script via heredoc:

Choose whether to continue in an existing tab or open a separate one from the
task and current browser state; there is no fixed first-navigation rule.

```bash
awb-cli status   # expect: extension: CONNECTED

BU_CDP_WS=ws://127.0.0.1:9377/devtools/browser/awb browser-harness <<'PY'
print("TABS:", list_tabs())
print("PAGE:", page_info())
print("TITLE:", js("document.title"))
capture_screenshot("/tmp/page.png")
PY
```

## Quick Reference

Helpers are pre-imported: `page_info()`, `js(expr)`, `new_tab(url)`,
`goto_url(url)`, `list_tabs()`, `switch_tab(target)`, `close_tab()`,
`wait_for_load()`, `click_at_xy(x, y)`, `fill_input(selector, text)`,
`capture_screenshot(path)`, `cdp("Domain.method", **kwargs)`,
`ensure_real_tab()`. Task-specific helper additions go in
`$BH_AGENT_WORKSPACE/agent_helpers.py`.

## Procedure

1. `awb-cli status` — daemon up and extension CONNECTED. If not: `awb-cli up`;
   if the extension is not connected, the user reloads it and watches the badge.
2. Run the script via the heredoc pattern above. Keep it one script — loops and
   error recovery run inside Python without model round-trips.
3. Work text-first: `page_info()` and `js()` for state; screenshots only when
   visual proof is needed (then view the file with `vision_analyze`).
4. Tabs you create are visible to the user — name your intent in the output,
   and `close_tab()` your tabs when done unless the user wants them kept.

## Pitfalls

- **MV3 suspension:** if a command fails with "extension not connected", wait a
  few seconds and retry — the heartbeat/alarm reconnect within a minute.
  Persistent? Clicking the extension popup wakes the service worker.
- **One debugger holder per tab:** if Kimi WebBridge or devtools holds a tab,
  attach fails with "Another debugger is already attached". Move to a different
  tab — this is per-tab, not global.
- `new_tab()` reuses the current tab when it is blank (about:blank/newtab).
- Chrome shows an "Agent WebBridge CLI is debugging this browser" infobar while
  sessions hold attachments — normal, disappears on detach.
- The daemon binds 127.0.0.1 only. On a shared machine, pin the extension id
  with `OB_EXT_ID` (see chrome://extensions for the runtime id).

## Verification

- Smoke: `new_tab("https://example.com/")` → `wait_for_load()` →
  `js("document.title")` returns "🐴 Example Domain" → `close_tab()`.
- `awb-cli test` — 13 browser-free contract cases must pass.
- Live evidence beats logs: screenshot to a path and read the pixels.
