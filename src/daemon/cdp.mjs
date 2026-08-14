// CDP emulation: browser-level Target.* (chrome.debugger excludes the Target
// domain) + session-scoped passthrough, serialized per tab.
//
// The emulation surface matches what Browser Harness (browser-use CLI 3.0)
// actually calls — see BUILD_SPEC.md §2 for the enumerated contract.

import { state, nextId } from "./state.mjs";
import { extCmd, extTabOp } from "./ext.mjs";

function targetIdFor(tabId) {
  let tid = state.tabTargets.get(tabId);
  if (!tid) { tid = "awb-" + tabId; state.tabTargets.set(tabId, tid); }
  return tid;
}

function targetInfo(tab) {
  return {
    targetId: targetIdFor(tab.id),
    type: "page",
    title: tab.title || "",
    url: tab.url || "",
    attached: true,
  };
}

async function listTargetInfos() {
  const tabs = await extTabOp("list", {});
  return tabs.map(targetInfo);
}

async function routeBrowserLevel(method, params) {
  switch (method) {
    case "Target.getTargets":
      return { targetInfos: await listTargetInfos() };
    case "Target.getTargetInfo": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      const tab = await extTabOp("get", { tabId });
      return { targetInfo: targetInfo(tab) };
    }
    case "Target.createTarget": {
      const url = params && params.url ? params.url : "about:blank";
      const tab = await extTabOp("create", { url, active: true });
      return { targetId: targetIdFor(tab.id) };
    }
    case "Target.attachToTarget": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      if (!tabId) throw new Error("attachToTarget: bad targetId " + params.targetId);
      const sessionId = "awbs" + nextId();
      state.sessions.set(sessionId, tabId);
      return { sessionId };
    }
    case "Target.activateTarget": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      await extTabOp("activate", { tabId });
      return {};
    }
    case "Target.closeTarget": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      await extTabOp("remove", { tabId });
      for (const [sid, t] of state.sessions) if (t === tabId) state.sessions.delete(sid);
      state.tabTargets.delete(tabId);
      return { success: true };
    }
    case "Target.detachFromTarget": {
      state.sessions.delete(params.sessionId);
      return {};
    }
    // Auto-attach / discovery — not meaningful over chrome.debugger; ack quietly.
    case "Target.setDiscoverTargets":
    case "Target.setAutoAttach":
    case "Target.setAttachToOtherTargets":
    case "Target.setRemoteLocations":
      return {};
    default:
      throw new Error("unsupported browser-level method " + method);
  }
}

// Serialize session-scoped CDP commands per tab so concurrent sessions on the
// same tab never interleave commands (chrome.debugger is per-tab flat).
function enqueuePerTab(tabId, fn) {
  const prev = state.perTabQueues.get(tabId) || Promise.resolve();
  const run = prev.then(fn, fn);
  state.perTabQueues.set(tabId, run.catch(() => {}));
  return run;
}

export async function route(m) {
  if (m.method.startsWith("Target.") && !m.sessionId) {
    return routeBrowserLevel(m.method, m.params || {});
  }
  if (!m.sessionId) throw new Error("no sessionId and " + m.method + " is not browser-level");
  const tabId = state.sessions.get(m.sessionId);
  if (tabId === undefined) throw new Error("unknown sessionId " + m.sessionId);
  return enqueuePerTab(tabId, () => extCmd(tabId, m.method, m.params || {}));
}

export function handleBrowser(ws) {
  state.clients.add(ws);
  ws.on("message", async (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id === undefined) return; // client events/acks — ignore
    try {
      const result = await route(m);
      ws.send(JSON.stringify({ id: m.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: m.id, error: { code: -32000, message: String((e && e.message) || e) } }));
    }
  });
  ws.on("close", () => state.clients.delete(ws));
  ws.on("error", () => {});
}
