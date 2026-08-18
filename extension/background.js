// Agent WebBridge CLI — MV3 service worker.
//
// Deliberately dumb by design: a WebSocket client to the local daemon, a
// per-tab chrome.debugger attach Map, raw CDP passthrough (sendCommand +
// onEvent forwarding), and tab ops. No tool layer, no snapshot logic —
// Browser Harness does all of that itself; this file is only transport.
//
// Protocol (extension <-> daemon):
//   ext -> daemon: {type:"hello", extensionVersion, runtimeId}
//                  {type:"res", id, result|error}
//                  {type:"evt", tabId, method, params}
//                  {type:"ping"}
//   daemon -> ext: {type:"cmd", id, tabId, method, params}
//                  {type:"tabop", id, op, params}
//                  {type:"detach", tabId}
//                  {type:"setDownloadBehavior", id, tabId, behavior}

const DEFAULT_WS = "ws://127.0.0.1:9377/ext";

let sock = null;
let serverUrl = DEFAULT_WS;
let connectPending = false;
let reconnectTimer = null;
const attached = new Map(); // tabId -> true

function post(msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, 2000);
}

async function daemonAvailable() {
  const probeUrl = new URL(serverUrl);
  probeUrl.protocol = probeUrl.protocol === "wss:" ? "https:" : "http:";
  probeUrl.pathname = "/status";
  probeUrl.search = "";
  probeUrl.hash = "";
  try {
    await fetch(probeUrl, { method: "GET", mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

async function connect() {
  if (connectPending || (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING))) return;
  connectPending = true;
  if (!await daemonAvailable()) {
    connectPending = false;
    scheduleReconnect();
    return;
  }
  try {
    sock = new WebSocket(serverUrl);
  } catch {
    sock = null;
    connectPending = false;
    scheduleReconnect();
    return;
  }
  connectPending = false;
  sock.addEventListener("open", () => {
    post({
      type: "hello",
      extensionVersion: chrome.runtime.getManifest().version,
      runtimeId: chrome.runtime.id,
    });
  });
  sock.addEventListener("message", (ev) => {
    try { handle(JSON.parse(ev.data)); } catch (e) { console.error("[ouro-bridge]", e); }
  });
  sock.addEventListener("close", () => { sock = null; scheduleReconnect(); });
  sock.addEventListener("error", () => { try { sock.close(); } catch {} });
}

async function ensureAttach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.set(tabId, true);
}

async function handle(m) {
  if (m.type === "cmd") {
    const { id, tabId, method, params } = m;
    try {
      await ensureAttach(tabId);
      const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
      post({ type: "res", id, result: result || {} });
    } catch (e) {
      post({ type: "res", id, error: { code: -32000, message: String((e && e.message) || e) } });
    }
  } else if (m.type === "tabop") {
    const { id, op, params } = m;
    try {
      let result;
      if (op === "create") result = await chrome.tabs.create(params || {});
      else if (op === "remove") { await chrome.tabs.remove(params.tabId); result = {}; }
      else if (op === "activate") result = await chrome.tabs.update(params.tabId, { active: true });
      else if (op === "list") result = await chrome.tabs.query(params || {});
      else if (op === "get") result = await chrome.tabs.get(params.tabId);
      else throw new Error("unknown tabop " + op);
      post({ type: "res", id, result });
    } catch (e) {
      post({ type: "res", id, error: { code: -32000, message: String((e && e.message) || e) } });
    }
  } else if (m.type === "setDownloadBehavior") {
    post({ type: "res", id: m.id, result: {} });
  } else if (m.type === "detach") {
    try { await chrome.debugger.detach({ tabId: m.tabId }); } catch {}
    attached.delete(m.tabId);

    post({ type: "res", id: m.id, result: {} });
  }
}

// --- debugger lifecycle -----------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  post({ type: "evt", tabId: source && source.tabId, method, params: params || {} });
});

chrome.debugger.onDetach.addListener((source) => {
  if (source && typeof source.tabId === "number") attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// --- keepalive (MV3 service-worker suspension is real — this is the fix) ----
// 1. Heartbeat: any WS activity resets the SW idle timer (Chrome 116+), so a
//    20s ping PREVENTS suspension while connected.
// 2. Alarm: if we still got suspended, wake every minute and reconnect.
chrome.alarms.create("ob-keep", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === "ob-keep") connect(); });
setInterval(() => post({ type: "ping" }), 20000);

// --- popup messages ----------------------------------------------------------

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m && m.type === "GET_STATUS") {
    reply({ connected: !!(sock && sock.readyState === WebSocket.OPEN), url: serverUrl });
  } else if (m && m.type === "SET_URL") {
    serverUrl = m.url || DEFAULT_WS;
    chrome.storage.local.set({ ob_url: serverUrl });
    try { sock && sock.close(); } catch {}
    sock = null;
    connect();
    reply({ ok: true, url: serverUrl });
  } else if (m && m.type === "RECONNECT") {
    try { sock && sock.close(); } catch {}
    sock = null;
    connect();
    reply({ ok: true });
  } else {
    reply({ ok: false, error: "unknown message" });
  }
  return true;
});

// --- boot --------------------------------------------------------------------

chrome.storage.local.get(["ob_url"]).then(({ ob_url }) => {
  if (typeof ob_url === "string" && ob_url) serverUrl = ob_url;
  connect();
});
