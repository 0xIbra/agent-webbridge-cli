// Stub extension for browser-free contract testing: pretends to be the MV3
// extension with one fake tab and realistic CDP answers for the
// browser-harness helper surface (page_info expression, 1+1, DPR, navigate).

import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

const ws = new WebSocket(
  `ws://127.0.0.1:${process.env.STUB_EXT_PORT || 9377}/ext`,
  process.env.STUB_EXT_ORIGIN ? { origin: process.env.STUB_EXT_ORIGIN } : {},
);
let tabSeq = 1;
let cancelAttempts = 0;
const tabs = [{ id: 1, title: "Stub tab", url: "https://example.com/", active: true, windowId: 1 }];
const PAGE = { url: "https://example.com/", title: "Stub tab", w: 1280, h: 800, sx: 0, sy: 0, pw: 1280, ph: 2400 };

const runtimeId = process.env.STUB_RID || "stub-ext";
const version = process.env.STUB_VER || "stub-0.0.1";

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", extensionVersion: version, runtimeId })));
ws.on("close", () => process.exit(0));
ws.on("message", (d) => {
  let m;
  try { m = JSON.parse(d); } catch { return; }
  if (m.type === "tabop") {
    if (m.op === "list") return ws.send(JSON.stringify({ type: "res", id: m.id, result: tabs }));
    if (m.op === "get") {
      const t = tabs.find((x) => x.id === m.params.tabId);
      return ws.send(JSON.stringify(t ? { type: "res", id: m.id, result: t } : { type: "res", id: m.id, error: { code: -32000, message: "no tab " + m.params.tabId } }));
    }
    if (m.op === "create") {
      const t = { id: ++tabSeq, title: "", url: (m.params && m.params.url) || "about:blank", active: true, windowId: 1 };
      tabs.push(t);
      return ws.send(JSON.stringify({ type: "res", id: m.id, result: t }));
    }
    if (m.op === "remove") {
      const i = tabs.findIndex((x) => x.id === m.params.tabId);
      if (i >= 0) tabs.splice(i, 1);
      return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
    }
    if (m.op === "activate") return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
    return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
  }
  if (m.type === "setDownloadBehavior") {
    ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
    return;
  }
  if (m.type === "cmd") {
    const ex = (m.params && m.params.expression) || "";
    if (m.method === "Browser.cancelDownload") {
      cancelAttempts++;
      if (process.env.STUB_CANCEL_ATTEMPT_FILE) {
        fs.appendFileSync(process.env.STUB_CANCEL_ATTEMPT_FILE, `${m.params.guid}\n`);
      }
      if (cancelAttempts <= Number(process.env.STUB_CANCEL_FAILS || 0)) {
        return ws.send(JSON.stringify({ type: "res", id: m.id, error: { code: -32000, message: "simulated cancellation failure" } }));
      }
      if (process.env.STUB_CANCEL_FILE) fs.appendFileSync(process.env.STUB_CANCEL_FILE, `${m.params.guid}\n`);
      return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
    }
    if (m.method === "Runtime.evaluate") {
      ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Runtime.consoleAPICalled", params: { type: "log" } }));

      if (ex === "__triggerOversizedDownload") {
        const source = process.env.STUB_OVERSIZE_SOURCE;
        const guid = process.env.STUB_OVERSIZE_GUID || "fixture-oversize-guid";
        if (source) {
          const writeSource = () => {
            fs.mkdirSync(path.dirname(source), { recursive: true });
            fs.writeFileSync(source, "partial oversized download\n");
          };
          const delay = Number(process.env.STUB_OVERSIZE_SOURCE_DELAY_MS || 0);
          if (delay > 0) setTimeout(writeSource, delay);
          else writeSource();
        }
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadWillBegin", params: { guid, suggestedFilename: "oversized.bin", url: "http://fixture.invalid/oversized.bin" } }));
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadProgress", params: { guid, receivedBytes: 256 * 1024 * 1024 + 1, totalBytes: 512 * 1024 * 1024, state: "inProgress" } }));
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadProgress", params: { guid, receivedBytes: 256 * 1024 * 1024 + 2, totalBytes: 512 * 1024 * 1024, state: "inProgress" } }));
        return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "undefined" } } }));
      }

      if (ex === "__triggerCancelledDownload") {
        const source = process.env.STUB_CANCELLED_SOURCE;
        const guid = process.env.STUB_CANCELLED_GUID || "fixture-cancelled-guid";
        if (source) {
          fs.mkdirSync(path.dirname(source), { recursive: true });
          fs.writeFileSync(source, "partial cancelled download\n");
        }
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadWillBegin", params: { guid, suggestedFilename: "cancelled.bin", url: "http://fixture.invalid/cancelled.bin" } }));
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadProgress", params: { guid, receivedBytes: 12, totalBytes: 24, state: "canceled" } }));
        return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "undefined" } } }));
      }

      if (ex === "__triggerOversizedCompletedDownload") {
        const source = process.env.STUB_COMPLETED_OVERSIZE_SOURCE;
        const guid = process.env.STUB_COMPLETED_OVERSIZE_GUID || "fixture-completed-oversize-guid";
        if (source) {
          fs.mkdirSync(path.dirname(source), { recursive: true });
          fs.writeFileSync(source, "oversized");
          fs.truncateSync(source, 256 * 1024 * 1024 + 1);
        }
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadWillBegin", params: { guid, suggestedFilename: "completed-oversized.bin", url: "http://fixture.invalid/completed-oversized.bin" } }));
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadProgress", params: { guid, receivedBytes: 12, totalBytes: 12, state: "completed" } }));
        return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "undefined" } } }));
      }

      if (ex.includes("JSON.stringify({url:location.href")) return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "string", value: JSON.stringify(PAGE) } } }));
      if (/1\+1|1 \+ 1/.test(ex)) return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "number", value: 2 } } }));
      if (ex.includes("devicePixelRatio")) return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "number", value: 1 } } }));
      return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "undefined" } } }));
    }
    if (m.method === "Input.dispatchMouseEvent" && process.env.STUB_INPUT_FILE) {
      fs.appendFileSync(process.env.STUB_INPUT_FILE, `${m.params.type}\n`);
      const source = process.env.STUB_DOWNLOAD_SOURCE;
      if (m.params.type === "mouseReleased" && source) {
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, "agent-webbridge-download\n");
        const guid = process.env.STUB_DOWNLOAD_GUID || "fixture-download-guid";
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadWillBegin", params: { guid, suggestedFilename: "fixture-download.txt", url: "http://fixture.invalid/download.txt" } }));
        ws.send(JSON.stringify({ type: "evt", tabId: m.tabId, method: "Page.downloadProgress", params: { guid, receivedBytes: 25, totalBytes: 25, state: "completed" } }));
      }
    }
    if (m.method === "Page.navigate") return ws.send(JSON.stringify({ type: "res", id: m.id, result: { frameId: "f1", loaderId: "l1" } }));
    if (m.method === "Page.captureScreenshot") return ws.send(JSON.stringify({ type: "res", id: m.id, result: { data: "" } }));
    return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
  }
  if (m.type === "detach") {
    if (process.env.STUB_DETACH_FILE) fs.appendFileSync(process.env.STUB_DETACH_FILE, `${m.tabId}\n`);
    return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
  }
});
console.log(`[stub] connected as ${runtimeId} v${version}`);
