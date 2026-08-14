// Extension connection: hello handshake, request/response plumbing, event
// fan-out, reconnect waiting, and optional identity pinning (OB_EXT_ID).

import { state, nextId } from "./state.mjs";
import fs from "node:fs";
import path from "node:path";
import { constants } from "node:fs";
import { pipeline } from "node:stream/promises";

const EXT_ID_PIN = process.env.OB_EXT_ID || "";
const DOWNLOAD_ROOT = process.env.OB_DOWNLOAD_ROOT ? path.resolve(process.env.OB_DOWNLOAD_ROOT) : null;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

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
      observeDownloadEvent(m);
      // Tag with every session bound to the tab that emitted the event.
      for (const [sid, session] of state.sessions) {
        if (session.tabId !== m.tabId) continue;
        const c = session.client;
        if (c.readyState === c.OPEN) c.send(JSON.stringify({ method: m.method, params: m.params, sessionId: sid }));
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

function safeFilename(value, fallback) {
  if (typeof value !== "string" || !value || path.basename(value) !== value) return fallback;
  return value;
}

function observeDownloadEvent(message) {
  if (!DOWNLOAD_ROOT || !message.params || typeof message.params.guid !== "string") return;
  const guid = safeFilename(message.params.guid, null);
  if (!guid) return;
  if (message.method === "Page.downloadWillBegin") {
    const policy = state.downloadPolicies.get(message.tabId);
    if (!policy) return;
    state.downloadTransfers.set(guid, {
      tabId: message.tabId,
      filename: safeFilename(message.params.suggestedFilename, guid),
      client: policy.client,
      destination: policy.destination,
    });
    return;
  }
  if (message.method !== "Page.downloadProgress" || message.params.state !== "completed") return;
  const transfer = state.downloadTransfers.get(guid);
  state.downloadTransfers.delete(guid);
  if (!transfer) return;
  void brokerCompletedDownload(guid, transfer).catch(() => {});
}

async function brokerCompletedDownload(guid, transfer) {
  const policy = state.downloadPolicies.get(transfer.tabId);
  if (!policy || policy.client !== transfer.client || policy.destination !== transfer.destination) return;
  const source = path.join(DOWNLOAD_ROOT, guid);
  let sourceHandle = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      sourceHandle = await fs.promises.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!sourceHandle) return;
  let destinationHandle = null;
  const destination = path.join(transfer.destination, transfer.filename);
  try {
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile() || sourceStat.size > MAX_DOWNLOAD_BYTES) return;
    const rootReal = await fs.promises.realpath(DOWNLOAD_ROOT);
    const parentReal = await fs.promises.realpath(transfer.destination);
    const relative = path.relative(rootReal, parentReal);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    destinationHandle = await fs.promises.open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      destinationHandle.createWriteStream({ autoClose: false }),
    );
  } catch {
    if (destinationHandle) await fs.promises.unlink(destination).catch(() => {});
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
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
export const extSetDownloadBehavior = (tabId, behavior) => extRequest({ type: "setDownloadBehavior", tabId, behavior });
