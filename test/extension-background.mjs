import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND = fs.readFileSync(path.join(HERE, "..", "extension", "background.js"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "..", "extension", "manifest.json"), "utf8"));

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}

async function bootExtension({ daemonAvailable }) {
  const sockets = [];
  const probes = [];
  const groupCalls = [];
  const listener = { addListener() {} };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    close() {
      this.readyState = 3;
    }

    send(data) {
      this.sent ??= [];
      this.sent.push(JSON.parse(data));
    }
  }

  const context = vm.createContext({
    URL,
    WebSocket: FakeWebSocket,
    console,
    fetch: async (url, options) => {
      probes.push({ url: String(url), options });
      if (!daemonAvailable) throw new TypeError("fetch failed");
      return { ok: false, status: 401 };
    },
    setInterval() { return 1; },
    setTimeout() { return 1; },
    chrome: {
      action: {
        setBadgeBackgroundColor() {},
        setBadgeText() {},
      },
      alarms: {
        create() {},
        onAlarm: listener,
      },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        sendCommand: async () => ({}),
        onEvent: listener,
        onDetach: listener,
      },
      runtime: {
        id: "test-extension-id",
        getManifest: () => ({ version: "test" }),
        onMessage: listener,
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
      },
      tabs: {
        create: async () => ({}),
        get: async () => ({}),
        group: async (options) => {
          groupCalls.push({ method: "group", options });
          return options.groupId ?? 44;
        },
        query: async () => [],
        remove: async () => {},
        ungroup: async (tabIds) => {
          groupCalls.push({ method: "ungroup", tabIds });
        },
        update: async () => ({}),
        onRemoved: listener,
      },
      tabGroups: {
        move: async (groupId, options) => {
          groupCalls.push({ method: "move", groupId, options });
          return { id: groupId };
        },
        query: async () => [{ id: 44, title: "Research task", color: "blue", collapsed: false }],
        update: async (groupId, options) => {
          groupCalls.push({ method: "update", groupId, options });
          return { id: groupId, ...options };
        },
      },
    },
  });

  vm.runInContext(BACKGROUND, context, { filename: "extension/background.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { groupCalls, probes, sockets };
}

const unavailable = await bootExtension({ daemonAvailable: false });
check("an unavailable daemon is probed without opening a noisy WebSocket", unavailable.probes.length === 1 && unavailable.sockets.length === 0);

const available = await bootExtension({ daemonAvailable: true });
check("an available daemon proceeds from the probe to one extension WebSocket", available.probes.length === 1 && available.sockets.length === 1);

available.sockets[0].readyState = 1;
available.sockets[0].listeners.get("message")({ data: JSON.stringify({
  type: "tabop",
  id: 7,
  op: "group",
  params: { tabIds: [9, 10], title: "Research task" },
}) });
await new Promise((resolve) => setImmediate(resolve));
check("group tabops create and title a Chrome tab group",
  available.groupCalls.length === 2
    && available.groupCalls[0].method === "group"
    && available.groupCalls[0].options.tabIds.join(",") === "9,10"
    && available.groupCalls[1].method === "update"
    && available.groupCalls[1].options.title === "Research task"
    && available.sockets[0].sent.some((message) => message.id === 7 && message.result.groupId === 44));

for (const message of [
  { id: 8, op: "groups", params: {} },
  { id: 9, op: "groupupdate", params: { groupId: 44, properties: { title: "Sources", collapsed: true } } },
  { id: 10, op: "groupmove", params: { groupId: 44, properties: { index: 0 } } },
  { id: 11, op: "ungroup", params: { tabIds: [9] } },
]) {
  available.sockets[0].listeners.get("message")({ data: JSON.stringify({ type: "tabop", ...message }) });
}
await new Promise((resolve) => setImmediate(resolve));
check("tab group query, update, move, and ungroup tabops are relayed",
  available.sockets[0].sent.some((message) => message.id === 8 && Array.isArray(message.result) && message.result[0].id === 44)
    && available.groupCalls.some((call) => call.method === "update" && call.options.title === "Sources")
    && available.groupCalls.some((call) => call.method === "move" && call.options.index === 0)
    && available.groupCalls.some((call) => call.method === "ungroup" && call.tabIds[0] === 9));
check("the extension declares Chrome tab-group access", MANIFEST.permissions.includes("tabGroups"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
