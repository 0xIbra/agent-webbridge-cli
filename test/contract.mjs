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

  const port = await getFreePort();
  const downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), `awb-download-root-${process.pid}-`));
  const downloadGuid = "fixture-download-guid";
  const downloadSource = path.join(downloadRoot, downloadGuid);
  const downloadDestination = path.join(downloadRoot, "requested");
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
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 10, button: "left" }, sessionId);
  const downloaded = path.join(downloadDestination, "fixture-download.txt");
  await waitFor(() => Promise.resolve(fs.existsSync(downloaded) && fs.readFileSync(downloaded, "utf8") === "agent-webbridge-download\n"));
  check("downloads are brokered into the configured root", fs.readFileSync(downloaded, "utf8") === "agent-webbridge-download\n");
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
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
