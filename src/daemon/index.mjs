// Agent WebBridge CLI — daemon entrypoint.
// HTTP (json/version, json/list, status) + two WebSocket surfaces:
//   /ext              <- the MV3 extension connects here as a client
//   /devtools/browser/<id> <- browser-harness (CLI 3.0) connects here via BU_CDP_WS

import http from "node:http";
import { WebSocketServer } from "ws";
import { state } from "./state.mjs";
import { handleExt } from "./ext.mjs";
import { handleBrowser, shutdownBrowserClients } from "./cdp.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8"));

const PORT = Number(process.env.OB_PORT || 9377);
const HOST = "127.0.0.1";
const CONTROL_TOKEN = process.env.OB_CONTROL_TOKEN || "";
const EXTENSION_ORIGIN = process.env.OB_EXT_ID ? `chrome-extension://${process.env.OB_EXT_ID}` : "";

function secretMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpAuthorized(req) {
  if (!CONTROL_TOKEN) return true;
  const prefix = "Bearer ";
  const authorization = req.headers.authorization || "";
  return authorization.startsWith(prefix) && secretMatches(authorization.slice(prefix.length), CONTROL_TOKEN);
}

function rejectUpgrade(socket) {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (!httpAuthorized(req)) return send(401, { error: "unauthorized" });
  if (req.url === "/json/version") {
    return send(200, {
      "Browser": "Chrome/AWB-CLI",
      "Protocol-Version": "1.3",
      "webSocketDebuggerUrl": `ws://${HOST}:${PORT}/devtools/browser/awb`,
    });
  }
  if (req.url === "/json/list") {
    return send(200, [...state.tabTargets.values()].map((t) => ({
      id: t, type: "page", title: "", url: "",
      webSocketDebuggerUrl: `ws://${HOST}:${PORT}/devtools/browser/awb`,
    })));
  }
  if (req.url === "/status") {
    return send(200, {
      ok: true,
      name: PKG.name,
      version: PKG.version,
      port: PORT,
      extension_connected: !!state.ext,
      extension_version: state.extInfo ? state.extInfo.extensionVersion : null,
      extension_id: state.extInfo ? state.extInfo.runtimeId : null,
      id_pin: process.env.OB_EXT_ID || null,
      sessions: state.sessions.size,
      targets: state.tabTargets.size,
    });
  }
  return send(404, { error: "not found", routes: ["GET /json/version", "GET /json/list", "GET /status"] });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${HOST}`);
  if (u.pathname === "/ext") {
    if (EXTENSION_ORIGIN && req.headers.origin !== EXTENSION_ORIGIN) return rejectUpgrade(socket);
    return wss.handleUpgrade(req, socket, head, (ws) => handleExt(ws));
  }
  if (u.pathname.startsWith("/devtools/browser/")) {
    if (CONTROL_TOKEN && !secretMatches(u.searchParams.get("token"), CONTROL_TOKEN)) return rejectUpgrade(socket);
    return wss.handleUpgrade(req, socket, head, (ws) => handleBrowser(ws));
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`[awb-cli] v${PKG.version} listening on http://${HOST}:${PORT} (ext /ext, CDP /devtools/browser/awb)`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  const forced = setTimeout(() => process.exit(1), 8_000);
  forced.unref?.();
  try {
    await shutdownBrowserClients();
    try { state.ext?.close(1001, "daemon shutdown"); } catch {}
    await new Promise((resolve) => wss.close(resolve));
    clearTimeout(forced);
    process.exit(0);
  } catch {
    clearTimeout(forced);
    process.exit(1);
  }
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
