import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND = fs.readFileSync(path.join(HERE, "..", "extension", "background.js"), "utf8");

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

    send() {}
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
        query: async () => [],
        remove: async () => {},
        update: async () => ({}),
        onRemoved: listener,
      },
    },
  });

  vm.runInContext(BACKGROUND, context, { filename: "extension/background.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { probes, sockets };
}

const unavailable = await bootExtension({ daemonAvailable: false });
check("an unavailable daemon is probed without opening a noisy WebSocket", unavailable.probes.length === 1 && unavailable.sockets.length === 0);

const available = await bootExtension({ daemonAvailable: true });
check("an available daemon proceeds from the probe to one extension WebSocket", available.probes.length === 1 && available.sockets.length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
