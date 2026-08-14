// Agent WebBridge CLI — daemon entrypoint.
// HTTP (json/version, json/list, status) + two WebSocket surfaces:
//   /ext              <- the MV3 extension connects here as a client
//   /devtools/browser/<id> <- browser-harness (CLI 3.0) connects here via BU_CDP_WS

import http from "node:http";
import { WebSocketServer } from "ws";
import { state } from "./state.mjs";
import { handleExt } from "./ext.mjs";
import { handleBrowser } from "./cdp.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8"));

const PORT = Number(process.env.OB_PORT || 9377);
const HOST = "127.0.0.1";

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
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
  if (u.pathname === "/ext") return wss.handleUpgrade(req, socket, head, (ws) => handleExt(ws));
  if (u.pathname.startsWith("/devtools/browser/")) return wss.handleUpgrade(req, socket, head, (ws) => handleBrowser(ws));
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`[awb-cli] v${PKG.version} listening on http://${HOST}:${PORT} (ext /ext, CDP /devtools/browser/awb)`);
});
