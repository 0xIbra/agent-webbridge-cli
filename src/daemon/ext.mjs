// Extension connection: hello handshake, request/response plumbing, event
// fan-out, reconnect waiting, and optional identity pinning (OB_EXT_ID).

import { state, nextId } from "./state.mjs";

const EXT_ID_PIN = process.env.OB_EXT_ID || "";

export function handleExt(ws) {
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === "hello") {
      const runtimeId = m.runtimeId || "";
      if (EXT_ID_PIN && runtimeId !== EXT_ID_PIN) {
        console.log(`[awb-cli] REJECTED extension hello: runtimeId ${runtimeId || "?"} != OB_EXT_ID pin`);
        try { ws.close(); } catch {}
        return;
      }
      state.ext = ws;
      state.extInfo = { extensionVersion: m.extensionVersion || "?", runtimeId };
      console.log(`[awb-cli] extension connected (v${state.extInfo.extensionVersion}${runtimeId ? ", id=" + runtimeId : ""})`);
      for (const w of state.extWaiters.splice(0)) w();
    } else if (m.type === "res") {
      const p = state.pending.get(m.id);
      if (!p) return;
      state.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || "extension error"));
      else p.resolve(m.result);
    } else if (m.type === "evt") {
      // Tag with every session bound to the tab that emitted the event.
      for (const [sid, tabId] of state.sessions) {
        if (tabId !== m.tabId) continue;
        for (const c of state.clients) {
          if (c.readyState === c.OPEN) c.send(JSON.stringify({ method: m.method, params: m.params, sessionId: sid }));
        }
      }
    }
    // "ping" heartbeats are intentionally ignored — they only reset the SW timer.
  });
  ws.on("close", () => {
    if (state.ext === ws) {
      state.ext = null;
      state.extInfo = null;
      console.log("[awb-cli] extension disconnected");
    }
  });
  ws.on("error", () => {});
}

export function waitForExt(timeoutMs) {
  if (state.ext) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), timeoutMs);
    state.extWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

export async function extRequest(msg, timeout = 15000) {
  if (!state.ext) await waitForExt(30000);
  if (!state.ext) throw new Error("extension not connected");
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("extension request timeout")); }, timeout);
    state.pending.set(id, { resolve, reject, timer });
    state.ext.send(JSON.stringify({ ...msg, id }));
  });
}

export const extCmd = (tabId, method, params) => extRequest({ type: "cmd", tabId, method, params });
export const extTabOp = (op, params) => extRequest({ type: "tabop", op, params });
export const extDetach = (tabId) => extRequest({ type: "detach", tabId }, 5000).catch(() => {});
