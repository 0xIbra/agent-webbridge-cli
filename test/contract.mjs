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
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HOST = "127.0.0.1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DAEMON = path.join(ROOT, "src", "daemon", "index.mjs");
const STUB = path.join(HERE, "stub.mjs");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function httpJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("bad json from " + urlPath + ": " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
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
  child.unref();
  return child;
}

function startStub(port, extraEnv = {}) {
  const child = spawn(process.execPath, [STUB], {
    stdio: "ignore",
    env: { ...process.env, STUB_EXT_PORT: String(port), ...extraEnv },
  });
  return child;
}

function cdpClient(port) {
  const ws = new WebSocket(`ws://${HOST}:${port}/devtools/browser/awb`);
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
  const port = await getFreePort();
  startDaemon(port);
  await waitFor(() => httpJson(port, "/json/version").then(() => true).catch(() => false));

  // --- HTTP surface ---
  const ver = await httpJson(port, "/json/version");
  check("json/version has webSocketDebuggerUrl", !!ver.webSocketDebuggerUrl && ver.webSocketDebuggerUrl.startsWith("ws://"));
  const status0 = await httpJson(port, "/status");
  check("status reports extension_connected:false before hello", status0.ok === true && status0.extension_connected === false);

  // --- CDP surface against the stub extension ---
  const stub = startStub(port);
  await waitFor(() => httpJson(port, "/status").then((s) => s.extension_connected));

  const { ws, cdp } = cdpClient(port);
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

  ws.close();
  stub.kill();

  // --- identity pinning: OB_EXT_ID rejects a mismatched extension ---
  const port2 = await getFreePort();
  startDaemon(port2, { OB_EXT_ID: "pinned-ext" });
  await waitFor(() => httpJson(port2, "/json/version").then(() => true).catch(() => false));

  const evil = startStub(port2, { STUB_RID: "evil-ext" });
  await sleep(1200);
  const sEvil = await httpJson(port2, "/status");
  check("mismatched extension rejected", sEvil.extension_connected === false, JSON.stringify(sEvil));
  evil.kill();

  const good = startStub(port2, { STUB_RID: "pinned-ext" });
  await waitFor(() => httpJson(port2, "/status").then((s) => s.extension_connected));
  check("pinned extension accepted", true);
  good.kill();

  console.log(`\nRESULT  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
