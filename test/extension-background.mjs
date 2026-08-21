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
        update: async () => ({}),
        onRemoved: listener,
      },
      tabGroups: {
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
  params: { tabId: 9, title: "Research task" },
}) });
await new Promise((resolve) => setImmediate(resolve));
check("group tabops create and title a Chrome tab group",
  available.groupCalls.length === 2
    && available.groupCalls[0].method === "group"
    && available.groupCalls[0].options.tabIds[0] === 9
    && available.groupCalls[1].method === "update"
    && available.groupCalls[1].options.title === "Research task"
    && available.sockets[0].sent.some((message) => message.id === 7 && message.result.groupId === 44));
check("the extension declares Chrome tab-group access", MANIFEST.permissions.includes("tabGroups"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
