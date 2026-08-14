// Extension connection: hello handshake, request/response plumbing, event
// fan-out, reconnect waiting, and optional identity pinning (OB_EXT_ID).

import { state, nextId } from "./state.mjs";
import fs from "node:fs";
import path from "node:path";
import { constants } from "node:fs";
import { sendBrowserMessage } from "./browser-ws.mjs";

const EXT_ID_PIN = process.env.OB_EXT_ID || "";
const DOWNLOAD_ROOT = process.env.OB_DOWNLOAD_ROOT ? path.resolve(process.env.OB_DOWNLOAD_ROOT) : null;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const CANCEL_ATTEMPTS = 5;
const CANCEL_RETRY_MS = 50;
const CANCEL_REQUEST_TIMEOUT_MS = 200;
const STAGING_CLEANUP_ATTEMPTS = 250;
const STAGING_CLEANUP_RETRY_MS = 20;
export const MAX_EXT_WAITERS = 64;
export const MAX_EXT_PENDING = 256;
export const MAX_DOWNLOAD_TRANSFERS = 256;
export const MAX_OVERSIZED_ABORTS = 32;
const oversizedAborts = new Map();

function rejectPendingForExtension(socket, generation, reason) {
  for (const [id, pending] of state.pending) {
    if (pending.socket !== socket || pending.generation !== generation) continue;
    state.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
}

export function handleExt(ws) {
  let helloComplete = false;
  let helloIdentity = null;
  let socketGeneration = 0;
  const revokeSocket = () => {
    helloComplete = false;
    helloIdentity = null;
    rejectPendingForExtension(ws, socketGeneration, "extension connection revoked");
    discardTransfersForExtension(ws, socketGeneration);
    if (state.ext === ws && state.extGeneration === socketGeneration) {
      state.ext = null;
      state.extInfo = null;
    }
    try {
      if (typeof ws.terminate === "function") ws.terminate();
      else ws.close();
    } catch {}
  };
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === "hello") {
      const runtimeId = m.runtimeId || "";
      const extensionVersion = m.extensionVersion || "?";
      if (helloComplete) {
        if (
          state.ext !== ws
          || helloIdentity.runtimeId !== runtimeId
          || helloIdentity.extensionVersion !== extensionVersion
        ) {
          revokeSocket();
        }
        return;
      }
      if (EXT_ID_PIN && runtimeId !== EXT_ID_PIN) {
        console.log(`[awb-cli] REJECTED extension hello: runtimeId ${runtimeId || "?"} != OB_EXT_ID pin`);
        revokeSocket();
        return;
      }
      const previous = state.ext;
      const previousGeneration = state.extGeneration;
      helloComplete = true;
      helloIdentity = { extensionVersion, runtimeId };
      socketGeneration = previousGeneration + 1;
      state.ext = ws;
      state.extInfo = helloIdentity;
      state.extGeneration = socketGeneration;
      if (previous && previous !== ws) {
        rejectPendingForExtension(previous, previousGeneration, "extension connection replaced");
        discardTransfersForExtension(previous, previousGeneration);
        try {
          if (typeof previous.terminate === "function") previous.terminate();
          else previous.close();
        } catch {}
      }
      console.log(`[awb-cli] extension connected (v${state.extInfo.extensionVersion}${runtimeId ? ", id=" + runtimeId : ""})`);
      for (const w of state.extWaiters.splice(0)) w();
      return;
    }
    // Only the socket that most recently passed hello owns extension traffic.
    // This also makes ping frames from pre-auth or superseded sockets inert.
    if (!helloComplete || state.ext !== ws) return;
    if (m.type === "res") {
      const p = state.pending.get(m.id);
      if (!p || p.socket !== ws || p.generation !== socketGeneration) return;
      state.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || "extension error"));
      else p.resolve(m.result);
    } else if (m.type === "evt") {
      observeDownloadEvent(m, ws, socketGeneration);
      // Tag with every session bound to the tab that emitted the event.
      for (const [sid, session] of state.sessions) {
        if (session.tabId !== m.tabId) continue;
        const c = session.client;
        sendBrowserMessage(c, { method: m.method, params: m.params, sessionId: sid });
      }
    }
    // "ping" heartbeats are intentionally ignored — they only reset the SW timer.
  });
  ws.on("close", () => {
    rejectPendingForExtension(ws, socketGeneration, "extension disconnected");
    discardTransfersForExtension(ws, socketGeneration);
    if (state.ext === ws && state.extGeneration === socketGeneration) {
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

function observeDownloadEvent(message, socket, generation) {
  if (!DOWNLOAD_ROOT || !message.params || typeof message.params.guid !== "string") return;
  const guid = safeFilename(message.params.guid, null);
  if (!guid) return;
  if (message.method === "Page.downloadWillBegin") {
    const policy = state.downloadPolicies.get(message.tabId);
    if (!policy) return;
    if (!state.downloadTransfers.has(guid) && state.downloadTransfers.size >= MAX_DOWNLOAD_TRANSFERS) {
      revokeExtensionGeneration(socket, generation, "download transfer capacity exceeded");
      return;
    }
    state.downloadTransfers.set(guid, {
      tabId: message.tabId,
      filename: safeFilename(message.params.suggestedFilename, guid),
      client: policy.client,
      destination: policy.destination,
      socket,
      generation,
    });
    return;
  }
  if (message.method !== "Page.downloadProgress") return;
  const transfer = state.downloadTransfers.get(guid);
  if (transfer && (transfer.socket !== socket || transfer.generation !== generation)) return;
  const receivedBytes = Number(message.params.receivedBytes);
  const totalBytes = Number(message.params.totalBytes);
  if (receivedBytes > MAX_DOWNLOAD_BYTES || totalBytes > MAX_DOWNLOAD_BYTES) {
    if (!transfer) return;
    state.downloadTransfers.delete(guid);
    if (!oversizedAborts.has(guid)) {
      if (oversizedAborts.size >= MAX_OVERSIZED_ABORTS) {
        void removeStagingFile(guid).catch(() => {
          console.error("[awb-cli] oversized download overflow cleanup failed");
        });
        revokeExtensionGeneration(socket, generation, "oversized download capacity exceeded");
        return;
      }
      const abort = abortOversizedDownload(message.tabId, guid, transfer.socket, transfer.generation)
        .catch(() => revokeExtensionGeneration(transfer.socket, transfer.generation, "oversized download abort failed"))
        .finally(() => oversizedAborts.delete(guid));
      oversizedAborts.set(guid, abort);
    }
    return;
  }
  if (message.params.state === "canceled" || message.params.state === "interrupted") {
    state.downloadTransfers.delete(guid);
    void removeStagingFile(guid).catch(() => {
      console.error("[awb-cli] terminal download staging cleanup failed");
    });
    return;
  }
  if (message.params.state !== "completed") return;
  state.downloadTransfers.delete(guid);
  if (!transfer) return;
  void brokerCompletedDownload(guid, transfer).catch(() => {});
}

async function removeStagingFile(guid) {
  if (!DOWNLOAD_ROOT || safeFilename(guid, null) === null) return;
  try {
    await fs.promises.unlink(path.join(DOWNLOAD_ROOT, guid));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function discardTransfersForExtension(socket, generation) {
  for (const [guid, transfer] of state.downloadTransfers) {
    if (transfer.socket !== socket || transfer.generation !== generation) continue;
    state.downloadTransfers.delete(guid);
    void removeStagingFile(guid).catch(() => {
      console.error("[awb-cli] disconnected download staging cleanup failed");
    });
  }
}

async function abortOversizedDownload(tabId, guid, socket, generation) {
  let cancelled = false;
  for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
    try {
      await requestOnExtension(
        socket,
        generation,
        { type: "cmd", tabId, method: "Browser.cancelDownload", params: { guid } },
        CANCEL_REQUEST_TIMEOUT_MS,
      );
      cancelled = true;
      break;
    } catch {
      if (attempt + 1 < CANCEL_ATTEMPTS) await delay(CANCEL_RETRY_MS);
    }
  }
  if (!cancelled) revokeExtensionGeneration(socket, generation, "oversized download cancellation failed");

  const source = path.join(DOWNLOAD_ROOT, guid);
  for (let attempt = 0; attempt < STAGING_CLEANUP_ATTEMPTS; attempt++) {
    await fs.promises.unlink(source).catch(() => {});
    await delay(STAGING_CLEANUP_RETRY_MS);
  }
  try {
    await fs.promises.unlink(source);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("[awb-cli] oversized download staging cleanup failed");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function revokeExtensionGeneration(socket, generation, reason) {
  rejectPendingForExtension(socket, generation, reason);
  discardTransfersForExtension(socket, generation);
  if (state.ext === socket && state.extGeneration === generation) {
    state.ext = null;
    state.extInfo = null;
  }
  try {
    if (typeof socket?.terminate === "function") socket.terminate();
    else socket?.close();
  } catch {}
}

async function brokerCompletedDownload(guid, transfer) {
  const source = path.join(DOWNLOAD_ROOT, guid);
  let sourceHandle = null;
  let destinationHandle = null;
  const destination = path.join(transfer.destination, transfer.filename);
  try {
    const policy = state.downloadPolicies.get(transfer.tabId);
    if (!policy || policy.client !== transfer.client || policy.destination !== transfer.destination) return;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        sourceHandle = await fs.promises.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!sourceHandle) return;
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
    await copyFileHandles(sourceHandle, destinationHandle);
  } catch {
    if (destinationHandle) await fs.promises.unlink(destination).catch(() => {});
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
    await removeStagingFile(guid).catch(() => {
      console.error("[awb-cli] completed download staging cleanup failed");
    });
  }
}

async function copyFileHandles(sourceHandle, destinationHandle) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      const { bytesWritten } = await destinationHandle.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (bytesWritten === 0) throw new Error("download copy made no progress");
      written += bytesWritten;
    }
    position += bytesRead;
  }
}

export function waitForExt(timeoutMs) {
  if (state.ext) return Promise.resolve();
  if (state.extWaiters.length >= MAX_EXT_WAITERS) {
    return Promise.reject(new Error("too many extension reconnect waiters"));
  }
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      const index = state.extWaiters.indexOf(finish);
      if (index >= 0) state.extWaiters.splice(index, 1);
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    state.extWaiters.push(finish);
  });
}

function requestOnExtension(socket, generation, msg, timeout) {
  if (state.ext !== socket || state.extGeneration !== generation || socket.readyState !== socket.OPEN) {
    return Promise.reject(new Error("extension connection changed"));
  }
  if (state.pending.size >= MAX_EXT_PENDING) throw new Error("too many pending extension requests");
  return new Promise((resolve, reject) => {
    const id = nextId();
    const fail = (message) => {
      const pending = state.pending.get(id);
      if (!pending || pending.socket !== socket || pending.generation !== generation) return;
      state.pending.delete(id);
      clearTimeout(pending.timer);
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("extension request timeout"), timeout);
    state.pending.set(id, { resolve, reject, timer, socket, generation });
    try {
      socket.send(JSON.stringify({ ...msg, id }), (error) => {
        if (error) fail("extension request failed");
      });
    } catch {
      fail("extension request failed");
    }
  });
}

export async function extRequest(msg, timeout = 15000) {
  if (!state.ext) await waitForExt(30000);
  if (!state.ext) throw new Error("extension not connected");
  return requestOnExtension(state.ext, state.extGeneration, msg, timeout);
}

export const extCmd = (tabId, method, params) => extRequest({ type: "cmd", tabId, method, params });
export const extTabOp = (op, params) => extRequest({ type: "tabop", op, params });
export const extDetach = (tabId) => extRequest({ type: "detach", tabId }, 5000).catch(() => {});
export const extSetDownloadBehavior = (tabId, behavior) => extRequest({ type: "setDownloadBehavior", tabId, behavior });
