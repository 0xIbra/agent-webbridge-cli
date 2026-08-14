// Browser-free contract test for the agent-webbridge-cli daemon.
//
// Boots the real daemon on a free port, connects the stub extension, and
// drives the CDP surface exactly like Browser Harness does (browser-level
// Target.* + flatten attachToTarget + session-scoped commands). Also covers
// /json/version, /status, error paths, and OB_EXT_ID identity pinning.
//
// Run: node test/contract.mjs  (or `awb-cli test`)

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { MAX_BROWSER_BUFFER_BYTES, sendBrowserMessage } from "../src/daemon/browser-ws.mjs";
import { handleBrowser, safeUploadFiles } from "../src/daemon/cdp.mjs";
import { extRequest, handleExt, waitForExt } from "../src/daemon/ext.mjs";
import { state } from "../src/daemon/state.mjs";

const HOST = "127.0.0.1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DAEMON = path.join(ROOT, "src", "daemon", "index.mjs");
const STUB = path.join(HERE, "stub.mjs");

let passed = 0, failed = 0;
const ownedChildren = new Set();
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent = [];
  closed = [];

  send(data) { this.sent.push(JSON.parse(data)); }
  close(...args) {
    this.closed.push(args);
    this.readyState = 3;
    this.emit("close");
  }
}

class DelayedCloseSocket extends FakeSocket {
  terminated = 0;

  close(...args) {
    this.closed.push(args);
    this.readyState = 2;
  }
  terminate() {
    this.terminated++;
    this.readyState = 3;
    this.emit("close");
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-upload-root-${process.pid}-`));
const uploadFile = path.join(uploadRoot, "input.txt");
const outsideUpload = path.join(os.tmpdir(), `awb-upload-outside-${process.pid}.txt`);
const uploadSymlink = path.join(uploadRoot, "leak.txt");
fs.writeFileSync(uploadFile, "uploaded");
fs.writeFileSync(outsideUpload, "outside");
fs.symlinkSync(outsideUpload, uploadSymlink);
check("file input accepts a regular file under OB_UPLOAD_ROOT",
  safeUploadFiles({ files: [uploadFile], nodeId: 1 }, uploadRoot).files[0] === fs.realpathSync(uploadFile));
for (const candidate of [outsideUpload, uploadSymlink, "/etc/passwd"]) {
  let rejected = false;
  try { safeUploadFiles({ files: [candidate], nodeId: 1 }, uploadRoot); } catch { rejected = true; }
  check(`file input rejects unstaged path ${path.basename(candidate)}`, rejected);
}
fs.rmSync(uploadRoot, { recursive: true, force: true });
fs.rmSync(outsideUpload, { force: true });

function httpResponse(port, urlPath, token = "") {
  return new Promise((resolve, reject) => {
    http.get({
      host: HOST,
      port,
      path: urlPath,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); } catch { reject(new Error("bad json from " + urlPath + ": " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function httpJson(port, urlPath, token = "") {
  const response = await httpResponse(port, urlPath, token);
  if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode} from ${urlPath}`);
  return response.body;
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  throw new Error("waitFor timeout");
}

function startDaemon(port, extraEnv = {}) {
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OB_PORT: String(port), ...extraEnv },
  });
  ownedChildren.add(child);
  child.once("exit", () => ownedChildren.delete(child));
  child.unref();
  return child;
}

function startStub(port, extraEnv = {}) {
  const child = spawn(process.execPath, [STUB], {
    stdio: "ignore",
    env: { ...process.env, STUB_EXT_PORT: String(port), ...extraEnv },
  });
  ownedChildren.add(child);
  child.once("exit", () => ownedChildren.delete(child));
  return child;
}

async function stopOwnedChildren() {
  const children = [...ownedChildren];
  for (const child of children) signalOwnedChild(child, "SIGTERM");
  await Promise.all(children.map((child) => waitForChildExit(child, 1_000)));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) signalOwnedChild(child, "SIGKILL");
  }
  await Promise.all(children.map((child) => waitForChildExit(child, 1_000)));
}

function signalOwnedChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.spawnargs.includes(DAEMON)) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once("exit", finish);
  });
}

function cdpClient(port, token = "") {
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`ws://${HOST}:${port}/devtools/browser/awb${suffix}`);
  const inflight = new Map();
  let idSeq = 1;
  const events = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id !== undefined && inflight.has(m.id)) {
      const { resolve, reject } = inflight.get(m.id);
      inflight.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = idSeq++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    inflight.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
  return { ws, cdp, events };
}

async function waitOpen(ws, timeoutMs = 5000) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", () => { clearTimeout(t); reject(new Error("ws error")); });
  });
}

async function main() {
  const queuedExt = new FakeSocket();
  handleExt(queuedExt);
  queuedExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "queue-test", runtimeId: "test-ext" }));
  const queuedClient = new FakeSocket();
  handleBrowser(queuedClient);
  queuedClient.emit("message", JSON.stringify({
    id: 1,
    method: "Target.attachToTarget",
    params: { targetId: "awb-901", flatten: true },
  }));
  await sleep(0);
  const queuedSessionId = queuedClient.sent.find((message) => message.id === 1)?.result?.sessionId;
  queuedClient.emit("message", JSON.stringify({ id: 2, sessionId: queuedSessionId, method: "Runtime.first", params: {} }));
  queuedClient.emit("message", JSON.stringify({ id: 3, sessionId: queuedSessionId, method: "Runtime.second", params: {} }));
  await sleep(0);
  const firstQueuedCommand = queuedExt.sent.find((message) => message.method === "Runtime.first");
  queuedClient.close();
  queuedExt.emit("message", JSON.stringify({ type: "res", id: firstQueuedCommand.id, result: {} }));
  await sleep(0);
  check("commands pre-queued before browser revocation never execute afterward",
    !queuedExt.sent.some((message) => message.method === "Runtime.second"));
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.perTabQueues.clear();
  queuedExt.close();

  const transferBoundRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-transfer-bound-${process.pid}-`));
  const previousDownloadRoot = process.env.OB_DOWNLOAD_ROOT;
  process.env.OB_DOWNLOAD_ROOT = transferBoundRoot;
  const boundedExtModule = await import(`../src/daemon/ext.mjs?download-transfer-bound=${Date.now()}`);
  const boundedTransferSocket = new FakeSocket();
  const boundedTransferClient = new FakeSocket();
  state.downloadPolicies.set(1, { client: boundedTransferClient, destination: transferBoundRoot });
  boundedExtModule.handleExt(boundedTransferSocket);
  boundedTransferSocket.emit("message", JSON.stringify({ type: "hello", extensionVersion: "transfer-bound", runtimeId: "test-ext" }));
  for (let index = 0; index < 257; index++) {
    boundedTransferSocket.emit("message", JSON.stringify({
      type: "evt",
      tabId: 1,
      method: "Page.downloadWillBegin",
      params: { guid: `bounded-download-${index}`, suggestedFilename: `bounded-${index}.bin` },
    }));
  }
  check("download transfer registry is bounded and overflow revokes the extension",
    state.downloadTransfers.size <= 256 && boundedTransferSocket.readyState !== boundedTransferSocket.OPEN);
  state.downloadPolicies.clear();
  state.downloadTransfers.clear();
  boundedTransferSocket.close();

  class AckCancelSocket extends FakeSocket {
    send(data, callback) {
      super.send(data);
      callback?.();
      const message = JSON.parse(data);
      if (message.method === "Browser.cancelDownload") {
        queueMicrotask(() => this.emit("message", JSON.stringify({ type: "res", id: message.id, result: {} })));
      }
    }
  }
  const boundedAbortSocket = new AckCancelSocket();
  state.downloadPolicies.set(1, { client: boundedTransferClient, destination: transferBoundRoot });
  boundedExtModule.handleExt(boundedAbortSocket);
  boundedAbortSocket.emit("message", JSON.stringify({ type: "hello", extensionVersion: "abort-bound", runtimeId: "test-ext" }));
  for (let index = 0; index < 33; index++) {
    const guid = `oversized-bound-${index}`;
    boundedAbortSocket.emit("message", JSON.stringify({
      type: "evt",
      tabId: 1,
      method: "Page.downloadWillBegin",
      params: { guid, suggestedFilename: `${guid}.bin` },
    }));
    boundedAbortSocket.emit("message", JSON.stringify({
      type: "evt",
      tabId: 1,
      method: "Page.downloadProgress",
      params: { guid, receivedBytes: 256 * 1024 * 1024 + 1, state: "inProgress" },
    }));
  }
  check("oversized download abort jobs are bounded and overflow revokes the extension",
    boundedAbortSocket.readyState !== boundedAbortSocket.OPEN);
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.downloadPolicies.clear();
  state.downloadTransfers.clear();
  boundedAbortSocket.close();

  const disconnectedTransferGuid = "disconnected-transfer-guid";
  const disconnectedTransferSource = path.join(transferBoundRoot, disconnectedTransferGuid);
  fs.writeFileSync(disconnectedTransferSource, "partial disconnected download\n");
  const disconnectedTransferSocket = new FakeSocket();
  state.downloadPolicies.set(1, { client: boundedTransferClient, destination: transferBoundRoot });
  boundedExtModule.handleExt(disconnectedTransferSocket);
  disconnectedTransferSocket.emit("message", JSON.stringify({ type: "hello", extensionVersion: "disconnect-cleanup", runtimeId: "test-ext" }));
  disconnectedTransferSocket.emit("message", JSON.stringify({
    type: "evt",
    tabId: 1,
    method: "Page.downloadWillBegin",
    params: { guid: disconnectedTransferGuid, suggestedFilename: "disconnected.bin" },
  }));
  disconnectedTransferSocket.close();
  await sleep(100);
  check("extension disconnect removes its tracked transfers and partial staging files",
    !state.downloadTransfers.has(disconnectedTransferGuid) && !fs.existsSync(disconnectedTransferSource));
  state.downloadPolicies.clear();
  state.downloadTransfers.clear();
  if (previousDownloadRoot === undefined) delete process.env.OB_DOWNLOAD_ROOT;
  else process.env.OB_DOWNLOAD_ROOT = previousDownloadRoot;

  const originalExt = new FakeSocket();
  handleExt(originalExt);
  originalExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "original", runtimeId: "test-ext" }));
  const originalRequest = extRequest({ type: "tabop", op: "list", params: {} })
    .then(() => "resolved", () => "rejected");
  const originalRequestId = originalExt.sent.find((message) => message.op === "list")?.id;
  const successorExt = new FakeSocket();
  handleExt(successorExt);
  successorExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "successor", runtimeId: "test-ext" }));
  successorExt.emit("message", JSON.stringify({ type: "res", id: originalRequestId, result: [] }));
  check("replacement extension cannot settle prior-generation pending work",
    await originalRequest === "rejected" && !state.pending.has(originalRequestId));
  successorExt.close();

  const boundedQueueExt = new FakeSocket();
  handleExt(boundedQueueExt);
  boundedQueueExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "queue-bound", runtimeId: "test-ext" }));
  const boundedQueueClient = new FakeSocket();
  handleBrowser(boundedQueueClient);
  boundedQueueClient.emit("message", JSON.stringify({
    id: 1,
    method: "Target.attachToTarget",
    params: { targetId: "awb-902", flatten: true },
  }));
  await sleep(0);
  const boundedSessionId = boundedQueueClient.sent.find((message) => message.id === 1)?.result?.sessionId;
  const tabQueueLimit = 64;
  for (let index = 0; index <= tabQueueLimit; index++) {
    boundedQueueClient.emit("message", JSON.stringify({
      id: 10 + index,
      sessionId: boundedSessionId,
      method: `Runtime.queued${index}`,
      params: {},
    }));
  }
  await sleep(0);
  check("per-tab CDP queues reject work beyond their fixed bound",
    boundedQueueClient.sent.some((message) => message.id === 10 + tabQueueLimit && message.error));
  boundedQueueClient.close();
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.perTabQueues.clear();
  boundedQueueExt.close();

  const settledQueueExt = new FakeSocket();
  settledQueueExt.send = function send(data, callback) {
    const message = JSON.parse(data);
    this.sent.push(message);
    queueMicrotask(() => {
      this.emit("message", JSON.stringify({ type: "res", id: message.id, result: {} }));
      callback?.();
    });
  };
  handleExt(settledQueueExt);
  settledQueueExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "queue-prune", runtimeId: "test-ext" }));
  const settledQueueClient = new FakeSocket();
  handleBrowser(settledQueueClient);
  settledQueueClient.emit("message", JSON.stringify({
    id: 1,
    method: "Target.attachToTarget",
    params: { targetId: "awb-903", flatten: true },
  }));
  await sleep(0);
  const settledSessionId = settledQueueClient.sent.find((message) => message.id === 1)?.result?.sessionId;
  settledQueueClient.emit("message", JSON.stringify({
    id: 2,
    sessionId: settledSessionId,
    method: "Runtime.evaluate",
    params: { expression: "1" },
  }));
  await waitFor(() => Promise.resolve(settledQueueClient.sent.some((message) => message.id === 2)));
  await sleep(0);
  check("settled per-tab queue tails are removed", !state.perTabQueues.has(903));
  settledQueueClient.close();
  settledQueueExt.close();
  state.perTabQueues.clear();

  await waitForExt(5);
  check("timed-out extension waiters remove themselves", state.extWaiters.length === 0);
  const waiterLimit = 64;
  const waiterResults = await Promise.allSettled(
    Array.from({ length: waiterLimit + 1 }, () => waitForExt(5)),
  );
  check("extension reconnect waiters are bounded",
    waiterResults.filter((result) => result.status === "rejected").length === 1
      && state.extWaiters.length === 0);

  const pendingBoundExt = new FakeSocket();
  handleExt(pendingBoundExt);
  pendingBoundExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "pending-bound", runtimeId: "test-ext" }));
  const pendingLimit = 256;
  let pendingOverflowRejected = false;
  const pendingRequests = Array.from({ length: pendingLimit + 1 }, () => (
    extRequest({ type: "tabop", op: "list", params: {} }, 10_000)
  ));
  pendingRequests[pendingLimit].catch(() => { pendingOverflowRejected = true; });
  await sleep(0);
  check("extension pending requests are bounded",
    state.pending.size === pendingLimit && pendingOverflowRejected);
  pendingBoundExt.close();
  await Promise.allSettled(pendingRequests);

  const clientLimit = 32;
  const boundedClients = Array.from({ length: clientLimit + 1 }, () => new FakeSocket());
  for (const client of boundedClients) handleBrowser(client);
  check("browser client registry is bounded",
    state.clients.size === clientLimit && boundedClients[clientLimit].closed.length === 1);
  for (const client of boundedClients) client.close();

  const inflightExt = new FakeSocket();
  handleExt(inflightExt);
  inflightExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "inflight-bound", runtimeId: "test-ext" }));
  const inflightClient = new FakeSocket();
  handleBrowser(inflightClient);
  const inflightLimit = 64;
  for (let index = 0; index <= inflightLimit; index++) {
    inflightClient.emit("message", JSON.stringify({
      id: 1000 + index,
      method: "Target.getTargets",
      params: {},
    }));
  }
  await sleep(0);
  check("per-client in-flight browser commands are bounded",
    inflightExt.sent.filter((message) => message.op === "list").length === inflightLimit
      && inflightClient.sent.some((message) => message.id === 1000 + inflightLimit && message.error));
  inflightClient.close();
  inflightExt.close();
  await sleep(0);

  const authenticatedExt = new FakeSocket();
  handleExt(authenticatedExt);
  authenticatedExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "test", runtimeId: "test-ext" }));
  const preAuthExt = new FakeSocket();
  handleExt(preAuthExt);
  let resolvedByPreAuthSocket = false;
  const preAuthRequestId = 900001;
  const preAuthTimer = setTimeout(() => {}, 10_000);
  state.pending.set(preAuthRequestId, {
    resolve: () => { resolvedByPreAuthSocket = true; },
    reject: () => {},
    timer: preAuthTimer,
  });
  preAuthExt.emit("message", JSON.stringify({ type: "res", id: preAuthRequestId, result: { forged: true } }));
  await sleep(0);
  check("pre-auth extension responses cannot resolve pending requests",
    !resolvedByPreAuthSocket && state.pending.has(preAuthRequestId));
  clearTimeout(preAuthTimer);
  state.pending.delete(preAuthRequestId);
  preAuthExt.close();

  const cumulativeBackpressureSocket = new DelayedCloseSocket();
  cumulativeBackpressureSocket.bufferedAmount = MAX_BROWSER_BUFFER_BYTES - 4;
  check("browser output uses a cumulative queue-byte bound",
    sendBrowserMessage(cumulativeBackpressureSocket, { id: 10, result: { ok: true } }) === false
      && cumulativeBackpressureSocket.closed.length === 1);

  const replacementExt = new FakeSocket();
  handleExt(replacementExt);
  replacementExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "test-2", runtimeId: "test-ext" }));
  let resolvedByStaleSocket = false;
  const staleRequestId = 900002;
  const staleTimer = setTimeout(() => {}, 10_000);
  state.pending.set(staleRequestId, {
    resolve: () => { resolvedByStaleSocket = true; },
    reject: () => {},
    timer: staleTimer,
  });
  authenticatedExt.emit("message", JSON.stringify({ type: "res", id: staleRequestId, result: { forged: true } }));
  await sleep(0);
  check("stale extension responses cannot resolve pending requests",
    !resolvedByStaleSocket && state.pending.has(staleRequestId));
  clearTimeout(staleTimer);
  state.pending.delete(staleRequestId);
  authenticatedExt.close();
  replacementExt.close();

  const eventExt = new FakeSocket();
  handleExt(eventExt);
  eventExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "test", runtimeId: "test-ext" }));
  const preAuthEventExt = new FakeSocket();
  handleExt(preAuthEventExt);
  const eventClient = new FakeSocket();
  state.sessions.set("pre-auth-event-session", { tabId: 91, client: eventClient });
  preAuthEventExt.emit("message", JSON.stringify({
    type: "evt",
    tabId: 91,
    method: "Runtime.consoleAPICalled",
    params: { forged: true },
  }));
  await sleep(0);
  check("pre-auth extension events cannot fan out to browser clients", eventClient.sent.length === 0);
  preAuthEventExt.close();

  const replacementEventExt = new FakeSocket();
  handleExt(replacementEventExt);
  replacementEventExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "test-2", runtimeId: "test-ext" }));
  eventExt.emit("message", JSON.stringify({
    type: "evt",
    tabId: 91,
    method: "Runtime.consoleAPICalled",
    params: { forged: true },
  }));
  await sleep(0);
  check("stale extension events cannot fan out to browser clients", eventClient.sent.length === 0);
  state.sessions.delete("pre-auth-event-session");
  eventExt.close();
  replacementEventExt.close();

  const backpressureEventExt = new FakeSocket();
  handleExt(backpressureEventExt);
  backpressureEventExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "test", runtimeId: "test-ext" }));
  const slowEventClient = new FakeSocket();
  slowEventClient.bufferedAmount = Number.MAX_SAFE_INTEGER;
  state.sessions.set("slow-event-session", { tabId: 92, client: slowEventClient });
  backpressureEventExt.emit("message", JSON.stringify({
    type: "evt",
    tabId: 92,
    method: "Runtime.consoleAPICalled",
    params: { type: "log" },
  }));
  await sleep(0);
  check("event forwarding closes backpressured browser clients",
    slowEventClient.sent.length === 0 && slowEventClient.closed.length === 1);
  state.sessions.delete("slow-event-session");
  backpressureEventExt.close();

  const rehelloExt = new DelayedCloseSocket();
  handleExt(rehelloExt);
  rehelloExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "test", runtimeId: "test-ext" }));
  rehelloExt.emit("message", JSON.stringify({ type: "hello", extensionVersion: "forged", runtimeId: "other-ext" }));
  await sleep(0);
  check("mismatched re-hello atomically revokes the active extension socket",
    state.ext !== rehelloExt && rehelloExt.terminated === 1);

  const slowResponseClient = new FakeSocket();
  slowResponseClient.bufferedAmount = Number.MAX_SAFE_INTEGER;
  handleBrowser(slowResponseClient);
  slowResponseClient.emit("message", JSON.stringify({
    id: 1,
    method: "Target.setDiscoverTargets",
    params: { discover: true },
  }));
  await sleep(0);
  check("response forwarding closes backpressured browser clients",
    slowResponseClient.sent.length === 0 && slowResponseClient.closed.length === 1);

  const closingResponseClient = new DelayedCloseSocket();
  closingResponseClient.bufferedAmount = Number.MAX_SAFE_INTEGER;
  handleBrowser(closingResponseClient);
  closingResponseClient.emit("message", JSON.stringify({
    id: 1,
    method: "Target.setDiscoverTargets",
    params: { discover: true },
  }));
  await sleep(0);
  closingResponseClient.bufferedAmount = 0;
  closingResponseClient.emit("message", JSON.stringify({
    id: 2,
    method: "Target.attachToTarget",
    params: { targetId: "awb-93", flatten: true },
  }));
  await sleep(0);
  check("backpressure closure revokes queued browser commands",
    ![...state.sessions.values()].some((session) => session.client === closingResponseClient));
  for (const [sid, session] of state.sessions) {
    if (session.client === closingResponseClient) state.sessions.delete(sid);
  }
  if (!closingResponseClient.terminated) closingResponseClient.terminate();

  let deterministicExtensionId = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
    const publicKey = Buffer.from(manifest.key, "base64");
    const derived = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32)
      .replace(/[0-9a-f]/g, (digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)));
    const pinned = fs.readFileSync(path.join(ROOT, "extension", "id.txt"), "utf8").trim();
    deterministicExtensionId = derived === pinned && /^[a-p]{32}$/.test(pinned);
  } catch {}
  check("extension identity is deterministic and pinned", deterministicExtensionId);
  let downloadInterceptionBundled = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
    const background = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
    const extensionBridge = fs.readFileSync(path.join(ROOT, "src", "daemon", "ext.mjs"), "utf8");
    downloadInterceptionBundled = !manifest.permissions.includes("downloads")
      && !background.includes("chrome.downloads")
      && extensionBridge.includes("Page.downloadWillBegin")
      && extensionBridge.includes("Page.downloadProgress");
  } catch {}
  check("download completion brokering is bundled", downloadInterceptionBundled);

  const cancelReplacementPort = await getFreePort();
  const cancelReplacementRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-cancel-replacement-${process.pid}-`));
  startDaemon(cancelReplacementPort, { OB_DOWNLOAD_ROOT: cancelReplacementRoot });
  await waitFor(() => httpJson(cancelReplacementPort, "/json/version").then(() => true).catch(() => false));
  const cancelOrigin = new WebSocket(`ws://${HOST}:${cancelReplacementPort}/ext`);
  const cancelOriginMessages = [];
  cancelOrigin.on("message", (data) => {
    const message = JSON.parse(data);
    cancelOriginMessages.push(message);
    if (message.type === "setDownloadBehavior") {
      cancelOrigin.send(JSON.stringify({ type: "res", id: message.id, result: {} }));
    }
  });
  await waitOpen(cancelOrigin);
  cancelOrigin.send(JSON.stringify({ type: "hello", extensionVersion: "cancel-origin", runtimeId: "test-ext" }));
  await waitFor(() => httpJson(cancelReplacementPort, "/status").then((status) => status.extension_connected));
  const cancelBrowser = cdpClient(cancelReplacementPort);
  await waitOpen(cancelBrowser.ws);
  const cancelAttach = await cancelBrowser.cdp("Target.attachToTarget", { targetId: "awb-1", flatten: true });
  await cancelBrowser.cdp("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: path.join(cancelReplacementRoot, "requested"),
  }, cancelAttach.sessionId);
  const cancelReplacementGuid = "cancel-replacement-guid";
  cancelOrigin.send(JSON.stringify({
    type: "evt",
    tabId: 1,
    method: "Page.downloadWillBegin",
    params: { guid: cancelReplacementGuid, suggestedFilename: "oversized.bin" },
  }));
  cancelOrigin.send(JSON.stringify({
    type: "evt",
    tabId: 1,
    method: "Page.downloadProgress",
    params: { guid: cancelReplacementGuid, receivedBytes: 256 * 1024 * 1024 + 1, state: "inProgress" },
  }));
  await waitFor(() => Promise.resolve(cancelOriginMessages.some((message) => message.method === "Browser.cancelDownload")));
  const cancelSuccessor = new WebSocket(`ws://${HOST}:${cancelReplacementPort}/ext`);
  const cancelSuccessorMessages = [];
  cancelSuccessor.on("message", (data) => cancelSuccessorMessages.push(JSON.parse(data)));
  await waitOpen(cancelSuccessor);
  cancelSuccessor.send(JSON.stringify({ type: "hello", extensionVersion: "cancel-successor", runtimeId: "test-ext" }));
  await waitFor(() => httpJson(cancelReplacementPort, "/status").then((status) => status.extension_version === "cancel-successor"));
  await sleep(300);
  const cancelReplacementStatus = await httpJson(cancelReplacementPort, "/status");
  check("oversize cancellation retries stay on their originating extension generation",
    !cancelSuccessorMessages.some((message) => message.method === "Browser.cancelDownload")
      && cancelReplacementStatus.extension_connected
      && cancelReplacementStatus.extension_version === "cancel-successor");
  cancelBrowser.ws.close();
  cancelOrigin.close();
  cancelSuccessor.close();

  const cancelTimeoutPort = await getFreePort();
  const cancelTimeoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-cancel-timeout-${process.pid}-`));
  startDaemon(cancelTimeoutPort, { OB_DOWNLOAD_ROOT: cancelTimeoutRoot });
  await waitFor(() => httpJson(cancelTimeoutPort, "/json/version").then(() => true).catch(() => false));
  const cancelTimeoutExt = new WebSocket(`ws://${HOST}:${cancelTimeoutPort}/ext`);
  cancelTimeoutExt.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.type === "setDownloadBehavior") {
      cancelTimeoutExt.send(JSON.stringify({ type: "res", id: message.id, result: {} }));
    }
  });
  await waitOpen(cancelTimeoutExt);
  cancelTimeoutExt.send(JSON.stringify({ type: "hello", extensionVersion: "cancel-timeout", runtimeId: "test-ext" }));
  await waitFor(() => httpJson(cancelTimeoutPort, "/status").then((status) => status.extension_connected));
  const cancelTimeoutBrowser = cdpClient(cancelTimeoutPort);
  await waitOpen(cancelTimeoutBrowser.ws);
  const cancelTimeoutAttach = await cancelTimeoutBrowser.cdp("Target.attachToTarget", { targetId: "awb-1", flatten: true });
  await cancelTimeoutBrowser.cdp("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: path.join(cancelTimeoutRoot, "requested"),
  }, cancelTimeoutAttach.sessionId);
  const cancelTimeoutGuid = "cancel-timeout-guid";
  cancelTimeoutExt.send(JSON.stringify({
    type: "evt",
    tabId: 1,
    method: "Page.downloadWillBegin",
    params: { guid: cancelTimeoutGuid, suggestedFilename: "oversized.bin" },
  }));
  cancelTimeoutExt.send(JSON.stringify({
    type: "evt",
    tabId: 1,
    method: "Page.downloadProgress",
    params: { guid: cancelTimeoutGuid, receivedBytes: 256 * 1024 * 1024 + 1, state: "inProgress" },
  }));
  await sleep(1800);
  const cancelTimeoutStatus = await httpJson(cancelTimeoutPort, "/status");
  check("unanswered oversize cancellation is bounded to a short fail-closed deadline",
    cancelTimeoutStatus.extension_connected === false);
  cancelTimeoutBrowser.ws.close();
  cancelTimeoutExt.close();

  const port = await getFreePort();
  const downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-download-root-${process.pid}-`));
  const downloadGuid = "fixture-download-guid";
  const downloadSource = path.join(downloadRoot, downloadGuid);
  const oversizedDownloadGuid = "fixture-oversize-guid";
  const oversizedDownloadSource = path.join(downloadRoot, oversizedDownloadGuid);
  const cancelledDownloadGuid = "fixture-cancelled-guid";
  const cancelledDownloadSource = path.join(downloadRoot, cancelledDownloadGuid);
  const completedOversizeGuid = "fixture-completed-oversize-guid";
  const completedOversizeSource = path.join(downloadRoot, completedOversizeGuid);
  const cancelFile = path.join(os.tmpdir(), `awb-cancel-${process.pid}-${port}`);
  const cancelAttemptFile = path.join(os.tmpdir(), `awb-cancel-attempt-${process.pid}-${port}`);
  const downloadDestination = path.join(downloadRoot, "requested");
  try { fs.rmSync(cancelFile, { force: true }); } catch {}
  try { fs.rmSync(cancelAttemptFile, { force: true }); } catch {}
  startDaemon(port, { OB_DOWNLOAD_ROOT: downloadRoot });
  await waitFor(() => httpJson(port, "/json/version").then(() => true).catch(() => false));

  // --- HTTP surface ---
  const ver = await httpJson(port, "/json/version");
  check("json/version has webSocketDebuggerUrl", !!ver.webSocketDebuggerUrl && ver.webSocketDebuggerUrl.startsWith("ws://"));
  const status0 = await httpJson(port, "/status");
  check("status reports extension_connected:false before hello", status0.ok === true && status0.extension_connected === false);

  // --- CDP surface against the stub extension ---
  const detachFile = path.join(os.tmpdir(), `awb-detach-${process.pid}-${port}`);
  const inputFile = path.join(os.tmpdir(), `awb-input-${process.pid}-${port}`);
  try { fs.rmSync(detachFile, { force: true }); } catch {}
  try { fs.rmSync(inputFile, { force: true }); } catch {}
  const stub = startStub(port, {
    STUB_DETACH_FILE: detachFile,
    STUB_DOWNLOAD_GUID: downloadGuid,
    STUB_DOWNLOAD_SOURCE: downloadSource,
    STUB_OVERSIZE_GUID: oversizedDownloadGuid,
    STUB_OVERSIZE_SOURCE: oversizedDownloadSource,
    STUB_OVERSIZE_SOURCE_DELAY_MS: "300",
    STUB_CANCELLED_GUID: cancelledDownloadGuid,
    STUB_CANCELLED_SOURCE: cancelledDownloadSource,
    STUB_COMPLETED_OVERSIZE_GUID: completedOversizeGuid,
    STUB_COMPLETED_OVERSIZE_SOURCE: completedOversizeSource,
    STUB_CANCEL_FILE: cancelFile,
    STUB_CANCEL_ATTEMPT_FILE: cancelAttemptFile,
    STUB_CANCEL_FAILS: "1",
    STUB_INPUT_FILE: inputFile,
  });
  await waitFor(() => httpJson(port, "/status").then((s) => s.extension_connected));

  const { ws, cdp, events } = cdpClient(port);
  await waitOpen(ws);

  const { targetInfos } = await cdp("Target.getTargets");
  check("getTargets returns page targets", Array.isArray(targetInfos) && targetInfos.length >= 1 && targetInfos[0].type === "page");
  const t0 = targetInfos[0];

  const { sessionId } = await cdp("Target.attachToTarget", { targetId: t0.targetId, flatten: true });
  check("attachToTarget returns sessionId", typeof sessionId === "string" && sessionId.length > 0);

  await cdp("Page.enable", {}, sessionId);
  await cdp("DOM.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Network.enable", {}, sessionId);
  check("domain enables routed to extension", true);

  await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDestination }, sessionId);
  await cdp("Runtime.evaluate", { expression: "__triggerOversizedDownload" }, sessionId);
  await sleep(700);
  check("oversized in-progress downloads are cancelled immediately",
    fs.existsSync(cancelFile) && fs.readFileSync(cancelFile, "utf8").trim().split("\n").includes(oversizedDownloadGuid));
  check("oversized download cancellation is issued once",
    fs.existsSync(cancelFile) && fs.readFileSync(cancelFile, "utf8").trim().split("\n").filter((guid) => guid === oversizedDownloadGuid).length === 1);
  check("oversized download cancellation failures are retried",
    fs.existsSync(cancelAttemptFile) && fs.readFileSync(cancelAttemptFile, "utf8").trim().split("\n").filter((guid) => guid === oversizedDownloadGuid).length >= 2);
  check("late oversized download staging files are cleaned", !fs.existsSync(oversizedDownloadSource));
  await cdp("Runtime.evaluate", { expression: "__triggerCancelledDownload" }, sessionId);
  await sleep(100);
  check("cancelled downloads remove their partial staging files", !fs.existsSync(cancelledDownloadSource));
  await cdp("Runtime.evaluate", { expression: "__triggerOversizedCompletedDownload" }, sessionId);
  await sleep(100);
  check("completion-time size checks remove oversized staging files", !fs.existsSync(completedOversizeSource));
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 10, button: "left" }, sessionId);
  const downloaded = path.join(downloadDestination, "fixture-download.txt");
  await waitFor(() => Promise.resolve(fs.existsSync(downloaded) && fs.readFileSync(downloaded, "utf8") === "agent-webbridge-download\n"));
  await waitFor(() => Promise.resolve(!fs.existsSync(downloadSource)));
  check("downloads are brokered into the configured root", fs.readFileSync(downloaded, "utf8") === "agent-webbridge-download\n");
  check("completed downloads remove their private staging files", !fs.existsSync(downloadSource));
  check("download clicks remain browser-originated", fs.existsSync(inputFile) && fs.readFileSync(inputFile, "utf8").includes("mouseReleased"));
  let downloadEscapeRejected = false;
  try {
    await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: path.dirname(downloadRoot) }, sessionId);
  } catch {
    downloadEscapeRejected = true;
  }
  check("download paths cannot escape the configured root", downloadEscapeRejected);

  const outsideDownloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-download-outside-${process.pid}-`));
  const symlinkDestination = path.join(downloadRoot, "symlink-destination");
  fs.symlinkSync(outsideDownloadRoot, symlinkDestination, "dir");
  let symlinkDestinationRejected = false;
  try {
    await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: symlinkDestination }, sessionId);
  } catch {
    symlinkDestinationRejected = true;
  }
  check("download destinations reject symlink components", symlinkDestinationRejected);

  const nestedSymlinkDestination = path.join(symlinkDestination, "must-not-be-created");
  let nestedSymlinkDestinationRejected = false;
  try {
    await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: nestedSymlinkDestination }, sessionId);
  } catch {
    nestedSymlinkDestinationRejected = true;
  }
  check("download destination validation never creates through a symlink parent",
    nestedSymlinkDestinationRejected && !fs.existsSync(path.join(outsideDownloadRoot, "must-not-be-created")));

  const noFollowDestination = path.join(downloadRoot, "no-follow-destination");
  await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: noFollowDestination }, sessionId);
  const outsideSentinel = path.join(outsideDownloadRoot, "outside-sentinel.txt");
  fs.writeFileSync(outsideSentinel, "unchanged\n");
  fs.symlinkSync(outsideSentinel, path.join(noFollowDestination, "fixture-download.txt"));
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 10, button: "left" }, sessionId);
  await sleep(200);
  check("completed downloads never follow a destination-file symlink", fs.readFileSync(outsideSentinel, "utf8") === "unchanged\n");

  const r = await cdp("Runtime.evaluate", { expression: "1+1", returnByValue: true }, sessionId);
  check("Runtime.evaluate passthrough", r && r.result && r.result.value === 2, JSON.stringify(r));

  const { targetId: t1 } = await cdp("Target.createTarget", { url: "about:blank" });
  check("createTarget returns targetId", typeof t1 === "string");
  await cdp("Target.activateTarget", { targetId: t1 });
  const { sessionId: s1 } = await cdp("Target.attachToTarget", { targetId: t1, flatten: true });
  const nav = await cdp("Page.navigate", { url: "https://example.com/" }, s1);
  check("Page.navigate on second tab", nav && nav.frameId === "f1");

  const { targetInfo } = await cdp("Target.getTargetInfo", { targetId: t1 });
  check("getTargetInfo shape", targetInfo && targetInfo.type === "page" && targetInfo.targetId === t1);

  await cdp("Target.closeTarget", { targetId: t1 });
  let cleaned = false;
  try { await cdp("Page.navigate", { url: "x" }, s1); } catch { cleaned = true; }
  check("session after closeTarget is dead", cleaned);

  let err = null;
  try { await cdp("Runtime.evaluate", { expression: "1" }, "nope"); } catch (e) { err = e; }
  check("unknown session rejected", !!err);

  const { ws: secondWs, cdp: secondCdp, events: secondEvents } = cdpClient(port);
  await waitOpen(secondWs);
  let stolenSession = null;
  try { await secondCdp("Runtime.evaluate", { expression: "1+1" }, sessionId); } catch (e) { stolenSession = e; }
  check("one harness client cannot use another client's session", !!stolenSession);
  const { sessionId: secondSessionId } = await secondCdp("Target.attachToTarget", { targetId: t0.targetId, flatten: true });
  events.length = 0;
  secondEvents.length = 0;
  await secondCdp("Runtime.evaluate", { expression: "1+1" }, secondSessionId);
  await waitFor(() => events.length > 0 && secondEvents.length > 0);
  check("CDP events are isolated to the client that owns each session",
    !events.some((event) => event.sessionId === secondSessionId)
      && !secondEvents.some((event) => event.sessionId === sessionId));
  secondWs.close();
  await sleep(100);

  ws.close();
  await waitFor(() => fs.existsSync(detachFile));
  check("closing harness client detaches extension debugger holders", fs.readFileSync(detachFile, "utf8").trim().split("\n").includes("1"));
  stub.kill();
  try { fs.rmSync(detachFile, { force: true }); } catch {}

  // --- identity pinning: OB_EXT_ID rejects a mismatched extension ---
  const port2 = await getFreePort();
  const pinnedExtensionId = "a".repeat(32);
  const controlToken = "control-token-" + "b".repeat(32);
  startDaemon(port2, { OB_EXT_ID: pinnedExtensionId, OB_CONTROL_TOKEN: controlToken });
  await waitFor(() => httpJson(port2, "/json/version", controlToken).then(() => true).catch(() => false));

  const deniedHttp = await httpResponse(port2, "/json/version");
  check("protected daemon rejects unauthenticated HTTP discovery", deniedHttp.statusCode === 401);
  const rogueCdp = new WebSocket(`ws://${HOST}:${port2}/devtools/browser/awb`);
  let rogueCdpRejected = false;
  try { await waitOpen(rogueCdp, 500); } catch { rogueCdpRejected = true; }
  check("protected daemon rejects unauthenticated CDP WebSockets", rogueCdpRejected);

  const wrongOrigin = startStub(port2, {
    STUB_RID: pinnedExtensionId,
    STUB_EXT_ORIGIN: "https://attacker.invalid",
  });
  await sleep(300);
  const wrongOriginStatus = await httpJson(port2, "/status", controlToken);
  check("pinned daemon rejects non-extension WebSocket origins", wrongOriginStatus.extension_connected === false);
  wrongOrigin.kill();

  const pinnedOrigin = `chrome-extension://${pinnedExtensionId}`;
  const evil = startStub(port2, { STUB_RID: "evil-ext", STUB_EXT_ORIGIN: pinnedOrigin });
  await sleep(1200);
  const sEvil = await httpJson(port2, "/status", controlToken);
  check("mismatched extension rejected", sEvil.extension_connected === false, JSON.stringify(sEvil));
  evil.kill();

  const good = startStub(port2, { STUB_RID: pinnedExtensionId, STUB_EXT_ORIGIN: pinnedOrigin });
  await waitFor(() => httpJson(port2, "/status", controlToken).then((s) => s.extension_connected));
  check("pinned extension accepted", true);
  const protectedClient = cdpClient(port2, controlToken);
  await waitOpen(protectedClient.ws);
  check("protected daemon accepts the worker control capability", true);
  protectedClient.ws.close();
  good.kill();

  console.log(`\nRESULT  ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .finally(stopOwnedChildren)
  .catch((e) => { console.error(e); process.exitCode = 1; });
