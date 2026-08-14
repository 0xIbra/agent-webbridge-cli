#!/usr/bin/env node
// Agent WebBridge CLI — daemon lifecycle + diagnostics.
//
//   awb-cli up [--port N]   start the daemon (background, logs + pid file)
//   awb-cli down            stop the daemon
//   awb-cli status          daemon + extension connection state
//   awb-cli doctor          environment checks with actionable hints
//   awb-cli test            run the browser-free contract test suite
//   awb-cli pack            zip the extension for Load unpacked / Web Store

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const STATE_DIR = path.join(os.homedir(), ".agent-webbridge-cli");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const DAEMON = path.join(ROOT, "src", "daemon", "index.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPortFromArg(argv) {
  const i = argv.indexOf("--port");
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 0;
}

async function getStatus(port = 9377) {
  try {
    const token = process.env.OB_CONTROL_TOKEN || "";
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(1500),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function daemonPort() {
  try { return Number(fs.readFileSync(PID_FILE, "utf8").trim().split(" ")[1] || 9377); } catch { return 9377; }
}

async function cmdUp(argv) {
  const port = readPortFromArg(argv) || Number(process.env.OB_PORT) || 9377;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const existing = await getStatus(port);
  if (existing) {
    console.log(`[awb-cli] daemon already running on :${port} (v${existing.version})`);
    console.log(`[awb-cli] extension: ${existing.extension_connected ? "connected (v" + existing.extension_version + ")" : "NOT connected"}`);
    return;
  }
  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, OB_PORT: String(port) },
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(PID_FILE, `${child.pid} ${port}\n`);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const s = await getStatus(port);
    if (s) {
      console.log(`[awb-cli] daemon v${s.version} up on http://127.0.0.1:${port} (pid ${child.pid}, log ${LOG_FILE})`);
      console.log(`[awb-cli] extension: ${s.extension_connected ? "connected" : "waiting — Load unpacked: chrome://extensions → <repo>/extension"}`);
      return;
    }
  }
  console.error(`[awb-cli] daemon did not come up — see ${LOG_FILE}`);
  process.exit(1);
}

async function cmdDown() {
  let pid = null;
  try { pid = Number(fs.readFileSync(PID_FILE, "utf8").trim().split(" ")[0]); } catch {}
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(100);
      try { process.kill(pid, 0); } catch { pid = null; break; }
    }
  }
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  const still = pid !== null || await getStatus(daemonPort());
  if (still) {
    console.error("[awb-cli] daemon shutdown could not be confirmed");
    process.exitCode = 1;
    return;
  }
  console.log("[awb-cli] daemon stopped");
}

async function cmdStatus() {
  const port = daemonPort();
  const s = await getStatus(port);
  if (!s) {
    console.log(`[awb-cli] daemon NOT running on :${port} — start it with: awb-cli up`);
    process.exit(1);
  }
  console.log(`daemon:            v${s.version} on http://127.0.0.1:${s.port}  (pid file ${PID_FILE})`);
  console.log(`extension:         ${s.extension_connected ? "CONNECTED  v" + s.extension_version + (s.extension_id ? "  id=" + s.extension_id : "") : "not connected"}`);
  if (s.id_pin) console.log(`id pin:            ${s.id_pin} (OB_EXT_ID)`);
  console.log(`active sessions:   ${s.sessions}`);
  console.log(`known targets:     ${s.targets}`);
  console.log(`browser-harness:   BU_CDP_WS=ws://127.0.0.1:${s.port}/devtools/browser/awb`);
}

async function cmdDoctor() {
  const [maj] = process.versions.node.split(".").map(Number);
  console.log(`node:              v${process.versions.node} ${maj >= 18 ? "OK" : "FAIL — need >=18"}`);
  const port = daemonPort();
  const s = await getStatus(port);
  console.log(`daemon on :${port}:   ${s ? "OK (v" + s.version + ")" : "not running — run: awb-cli up"}`);
  if (s) {
    console.log(`extension:         ${s.extension_connected ? "OK (v" + s.extension_version + ")" : "NOT connected — chrome://extensions → Developer mode → Load unpacked → " + path.join(ROOT, "extension")}`);
  }
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    console.log("browser-harness:   uv present — install with: uv tool install browser-harness");
  } catch {
    console.log("browser-harness:   uv not found — install uv or use pipx for browser-harness");
  }
}

function cmdTest() {
  const t = spawn(process.execPath, [path.join(ROOT, "test", "contract.mjs")], { stdio: "inherit" });
  t.on("exit", (code) => process.exit(code ?? 1));
}

function cmdPack() {
  const script = path.join(ROOT, "scripts", "pack-extension.mjs");
  execFileSync(process.execPath, [script], { stdio: "inherit" });
}

const HELP = `Agent WebBridge CLI v${PKG.version} — ${PKG.description}

Usage: awb-cli <command> [options]

  up [--port N]   start the local daemon (default :9377, env OB_PORT)
  down            stop the local daemon
  status          daemon + extension connection state
  doctor          environment checks with hints
  test            browser-free contract test suite
  pack            zip the extension (dist/agent-webbridge-cli-extension-v${PKG.version}.zip)

Point Browser Harness at the daemon:
  BU_CDP_WS=ws://127.0.0.1:9377/devtools/browser/awb browser-harness <<'PY'
  print(page_info())
  PY

Env: OB_PORT (daemon port) · OB_EXT_ID (pin daemon to one extension runtimeId)
`;

async function main() {
  const cmd = process.argv[2] || "help";
  switch (cmd) {
    case "up": return cmdUp(process.argv.slice(3));
    case "down": return cmdDown();
    case "status": return cmdStatus();
    case "doctor": return cmdDoctor();
    case "test": return cmdTest();
    case "pack": return cmdPack();
    case "-h": case "--help": case "help": console.log(HELP); return;
    default: console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(1);
  }
}

main().catch((e) => { console.error("[awb-cli]", e.message); process.exit(1); });
