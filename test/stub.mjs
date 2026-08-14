// Stub extension for browser-free contract testing: pretends to be the MV3
// extension with one fake tab and realistic CDP answers for the
// browser-harness helper surface (page_info expression, 1+1, DPR, navigate).

import { WebSocket } from "ws";

const ws = new WebSocket(`ws://127.0.0.1:${process.env.STUB_EXT_PORT || 9377}/ext`);
let tabSeq = 1;
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
  if (m.type === "cmd") {
    const ex = (m.params && m.params.expression) || "";
    if (m.method === "Runtime.evaluate") {
      if (ex.includes("JSON.stringify({url:location.href")) return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "string", value: JSON.stringify(PAGE) } } }));
      if (/1\+1|1 \+ 1/.test(ex)) return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "number", value: 2 } } }));
      if (ex.includes("devicePixelRatio")) return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "number", value: 1 } } }));
      return ws.send(JSON.stringify({ type: "res", id: m.id, result: { result: { type: "undefined" } } }));
    }
    if (m.method === "Page.navigate") return ws.send(JSON.stringify({ type: "res", id: m.id, result: { frameId: "f1", loaderId: "l1" } }));
    if (m.method === "Page.captureScreenshot") return ws.send(JSON.stringify({ type: "res", id: m.id, result: { data: "" } }));
    return ws.send(JSON.stringify({ type: "res", id: m.id, result: {} }));
  }
});
console.log(`[stub] connected as ${runtimeId} v${version}`);
