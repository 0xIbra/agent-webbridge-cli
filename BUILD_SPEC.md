# BUILD_SPEC — Agent WebBridge CLI

The executable contract of the project. If a change contradicts this file,
the change is wrong or this file needs an explicit amendment.

## 1. Architecture

```
browser-harness (Browser Use CLI 3.0)     the agent's script runner
        │  BU_CDP_WS=ws://127.0.0.1:9377/devtools/browser/awb
        ▼
daemon (src/daemon, Node, one dep: ws)    CDP emulation + session routing
        │  WS /ext  (ext <- daemon)
        ▼
MV3 extension (extension/)                chrome.debugger per-tab attach Map
        │
        ▼
user's real Chrome (real sessions, real logins)
```

The extension is deliberately dumb: transport only. No tool layer, no snapshot
builder — Browser Harness owns all agent semantics. The daemon emulates the
one CDP domain chrome.debugger excludes (Target) and passes everything else
through verbatim.

## 2. CDP contract the daemon must satisfy (enumerated from browser-harness source)

HTTP:
- `GET /json/version` → `{ webSocketDebuggerUrl }` (all BU_CDP_URL mode probes)

Browser-level WS (no sessionId), Target.* emulation:
- `Target.getTargets` → targetInfos[] with `{targetId, type:"page", title, url, attached}`
- `Target.getTargetInfo {targetId}`
- `Target.createTarget {url}` → `{targetId}` (chrome.tabs.create)
- `Target.attachToTarget {targetId, flatten:true}` → `{sessionId}`
- `Target.activateTarget {targetId}` (chrome.tabs.update active)
- `Target.closeTarget {targetId}` (chrome.tabs.remove)
- `Target.detachFromTarget {sessionId}`
- `Target.setDiscoverTargets/setAutoAttach/setAttachToOtherTargets/setRemoteLocations` → ack `{}`

Session-scoped (routed per tab to chrome.debugger):
- Page.* (navigate, captureScreenshot, enable, events: loadEventFired,
  domContentEventFired, javascriptDialogOpening/Closed)
- Runtime.* (evaluate)
- DOM.* (getDocument, querySelector, setFileInputFiles)
- Input.* (dispatchMouseEvent — trusted clicks, dispatchKeyEvent, insertText)
- Network.* (enable + events: requestWillBeSent, loadingFinished, loadingFailed)

Events are fanned out with the sessionId of every session bound to the tab.

## 3. Extension <-> daemon protocol

```
ext -> daemon: {type:"hello", extensionVersion, runtimeId}
               {type:"res", id, result|error}
               {type:"evt", tabId, method, params}
               {type:"ping"}                          // heartbeat, ignored by daemon
daemon -> ext: {type:"cmd", id, tabId, method, params}
               {type:"tabop", id, op, params}         // create|remove|activate|list|get
               {type:"detach", tabId}
```

- `hello` carries chrome.runtime.id. If `OB_EXT_ID` is set and mismatches,
  the socket is closed (identity pinning).
- Request ids are daemon-issued, monotonically increasing.
- The daemon waits up to 30s for the extension to (re)connect before failing
  a command with "extension not connected".

## 4. Concurrency rules

- chrome.debugger allows exactly ONE debugger client per tab (this includes
  other extensions, e.g. Kimi WebBridge). Attach is idempotent; "Another
  debugger is already attached" is returned as an error, not adopted.
- Session-scoped commands are serialized per tab (per-tab promise queue),
  because chrome.debugger is per-tab flat and different sessions may be bound
  to the same tab (switch_tab creates a new session while the old one lives).
- Browser-level Target.* commands run directly (tabops are atomic).
- Attach happens lazily on the first command to a tab; detach only via
  Target.closeTarget or explicit `detach` message. The extension prunes its
  attach map on chrome.debugger.onDetach and chrome.tabs.onRemoved.

## 5. MV3 service-worker keepalive (do not regress this)

The service worker gets suspended and its WebSocket dies silently. Two
mechanisms are REQUIRED in the extension:

1. Heartbeat: a `ping` over the WS every 20s — WS activity resets the SW idle
   timer (Chrome 116+), preventing suspension while connected.
2. chrome.alarms every 1 minute that calls connect() — the fallback that wakes
   a suspended worker.

The daemon additionally waits for reconnection (see §3) instead of failing
instantly.

## 6. Security model

- Daemon binds 127.0.0.1 only. Never bind 0.0.0.0.
- All state, logs, and pid files live under ~/.agent-webbridge-cli/.
- The extension popup warns that the daemon gains full browser control and
  only permits ws:// on localhost by default (any ws:// URL is technically
  settable — that is the user's explicit choice, mirroring Kimi's dev-mode).
- OB_EXT_ID pins the daemon to one extension runtimeId.
- No telemetry, no accounts, no outbound network calls from the daemon.

## 7. Testing policy

- `npm test` (test/contract.mjs) is browser-free: real daemon + stub extension.
- Protocol or emulation changes MUST add or update a contract case.
- Live verification (real extension + real Chrome + real browser-harness) is
  the only proof of chrome.debugger fidelity; it is a manual run, not CI.
