# BUILD_SPEC — Agent WebBridge CLI

The executable contract of the project. If a change contradicts this file,
the change is wrong or this file needs an explicit amendment.

## 1. Architecture

```
browser-harness (Browser Use CLI 3.0)     the agent's script runner
        │  BU_CDP_WS=ws://127.0.0.1:9377/devtools/browser/awb[?token=capability]
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

Events are fanned out with the sessionId of every session bound to the tab, but
only to the Browser Harness WebSocket that owns that session. A client cannot
issue commands with another client's sessionId.

## 3. Extension <-> daemon protocol

```
ext -> daemon: {type:"hello", extensionVersion, runtimeId}
               {type:"res", id, result|error}
               {type:"evt", tabId, method, params}
               {type:"ping"}                          // heartbeat, ignored by daemon
daemon -> ext: {type:"cmd", id, tabId, method, params}
               {type:"tabop", id, op, params}         // create|remove|activate|list|get
               {type:"detach", tabId}
               {type:"setDownloadBehavior", id, tabId, behavior}
```

- `hello` carries chrome.runtime.id. If `OB_EXT_ID` is set and mismatches,
  the socket is closed (identity pinning).
- `res`, `evt`, and `ping` frames are inert until that exact socket has passed
  `hello` and remains the active `state.ext`; pre-auth and superseded sockets
  cannot settle daemon requests or publish events.
- The unpacked extension carries a stable public manifest key. Its derived
  Chrome extension ID is pinned in `extension/id.txt`; packaging and production
  launch must reject a derived-ID mismatch.
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
- `Page.setDownloadBehavior` and `Browser.setDownloadBehavior` are emulated
  because `chrome.debugger` rejects that behavior. The daemon accepts only
  `behavior: "allow"`, validates and creates destination directories one
  component at a time without following symlink parents or mutating outside the
  root, confines the destination beneath `OB_DOWNLOAD_ROOT`, and copies
  extension-observed completed downloads with no-follow/exclusive file creation.
  The embedding
  browser runtime must launch Chromium with automatic downloads accepted and
  a worker-owned download directory beneath the same filesystem boundary.
  Clicks remain native trusted browser input; the extension reports completed
  downloads through `Page.downloadWillBegin` and `Page.downloadProgress`; the
  daemon resolves the browser-issued GUID beneath `OB_DOWNLOAD_ROOT` and copies
  it under the suggested filename. Progress above 256 MiB by either total or
  received bytes is cancelled immediately through `Browser.cancelDownload`,
  deduplicated, and its GUID staging file is removed when supported. Completed,
  cancelled, interrupted, disconnected, and completion-time oversized transfers
  remove their private staging files. Transfer tracking is capped at 256 and
  concurrent oversized-abort jobs at 32; overflow revokes the extension rather
  than creating unbounded state. With no configured root, the CDP operation fails
  closed.
- Browser-client responses and events have a 1 MiB cumulative WebSocket send
  budget. A frame that would exceed it closes the slow consumer instead of
  growing the transport queue.
- Attach happens lazily on the first command to a tab. Flatten sessions are
  owned by the Browser Harness WebSocket that created them. Closing that socket
  deletes its sessions and sends `detach` for each tab no remaining client uses;
  this is the secure human-takeover boundary. `Target.detachFromTarget` does the
  same for one session. The extension acknowledges `detach` only after calling
  `chrome.debugger.detach`, and prunes its attach map on
  chrome.debugger.onDetach and chrome.tabs.onRemoved.

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
- When `OB_EXT_ID` is set, `/ext` accepts only the matching
  `chrome-extension://<id>` WebSocket Origin before the runtime hello check.
- Optional `OB_CONTROL_TOKEN` enables hosted mode: daemon HTTP discovery/status
  requires a Bearer token and the Browser Harness WebSocket requires the same
  opaque token in its query capability. Normal owner-local mode remains
  backward-compatible when the variable is absent. The token must never appear
  in status payloads or product-client output.
- OB_DOWNLOAD_ROOT bounds every Browser Harness-requested download directory;
  cross-root paths, symlink components, existing destination files, oversized
  transfers, and cross-client policy replacement are rejected.
- No telemetry, no accounts, no outbound network calls from the daemon.

## 7. Testing policy

- `npm test` (test/contract.mjs) is browser-free: real daemon + stub extension.
  It covers per-client session/event isolation and debugger detach on harness
  disconnect in addition to the Browser Harness command surface.
- Protocol or emulation changes MUST add or update a contract case.
- Live verification (real extension + real Chrome + real browser-harness) is
  the only proof of chrome.debugger fidelity; it is a manual run, not CI.
