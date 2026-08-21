// CDP emulation: browser-level Target.* (chrome.debugger excludes the Target
// domain) + session-scoped passthrough, serialized per tab.
//
// The emulation surface matches what Browser Harness (browser-use CLI 3.0)
// actually calls — see BUILD_SPEC.md §2 for the enumerated contract.

import { state, nextId } from "./state.mjs";
import { extCmd, extDetach, extSetDownloadBehavior, extTabOp } from "./ext.mjs";
import fs from "node:fs";
import path from "node:path";
import { registerBrowserClient, sendBrowserMessage, unregisterBrowserClient } from "./browser-ws.mjs";

const DOWNLOAD_ROOT = process.env.OB_DOWNLOAD_ROOT ? path.resolve(process.env.OB_DOWNLOAD_ROOT) : null;
const UPLOAD_ROOT = process.env.OB_UPLOAD_ROOT ? path.resolve(process.env.OB_UPLOAD_ROOT) : null;
const MAX_UPLOAD_FILES = 8;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_TAB_QUEUE_DEPTH = 64;
export const MAX_BROWSER_CLIENTS = 32;
export const MAX_CLIENT_INFLIGHT = 64;
export const MAX_BROWSER_TAB_SESSIONS = 128;
const browserInflight = new WeakMap();
const browserScopes = new WeakMap();
const browserBootstrapTargets = new WeakMap();

export function safeUploadFiles(params, root = UPLOAD_ROOT) {
  if (!root || !params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("file input staging is unavailable");
  }
  const files = params.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) {
    throw new Error("file input requires bounded staged files");
  }
  const resolvedRoot = fs.realpathSync(root);
  const rootInfo = fs.lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("file input staging is unavailable");
  const safeFiles = files.map((file) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("file input path is invalid");
    const info = fs.lstatSync(file);
    const resolved = fs.realpathSync(file);
    if (
      info.isSymbolicLink()
      || !info.isFile()
      || info.size > MAX_UPLOAD_BYTES
      || !resolved.startsWith(resolvedRoot + path.sep)
    ) {
      throw new Error("file input path is outside the staging root");
    }
    return resolved;
  });
  return { ...params, files: safeFiles };
}

function safeDownloadDestination(requested) {
  const destination = path.resolve(String(requested || ""));
  const relative = path.relative(DOWNLOAD_ROOT, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("download path is outside the configured root");
  }
  const rootInfo = fs.lstatSync(DOWNLOAD_ROOT);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("download path contains an unsafe filesystem component");
  }
  let current = DOWNLOAD_ROOT;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      info = fs.lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("download path contains an unsafe filesystem component");
    }
  }
  const rootReal = fs.realpathSync(DOWNLOAD_ROOT);
  const destinationReal = fs.realpathSync(destination);
  const realRelative = path.relative(rootReal, destinationReal);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("download path is outside the configured root");
  }
  return destinationReal;
}

function targetIdFor(tabId) {
  let tid = state.tabTargets.get(tabId);
  if (!tid) { tid = "awb-" + tabId; state.tabTargets.set(tabId, tid); }
  return tid;
}

function targetInfo(tab) {
  return {
    targetId: targetIdFor(tab.id),
    type: "page",
    title: tab.title || "",
    url: tab.url || "",
    attached: true,
  };
}

async function listTargetInfos(client) {
  const tabs = await extTabOp("list", {});
  const scope = browserScopes.get(client);
  if (!scope) return tabs.map(targetInfo);
  const owned = state.browserTabSessions.get(scope.session);
  if (!owned) return [];
  const liveTabs = tabs.filter((tab) => owned.tabIds.has(tab.id));
  const liveIds = new Set(liveTabs.map((tab) => tab.id));
  for (const tabId of owned.tabIds) if (!liveIds.has(tabId)) owned.tabIds.delete(tabId);
  if (owned.tabIds.size === 0) {
    state.browserTabSessions.delete(scope.session);
  } else if (![...state.sessions.values()].some((session) => session.client === client)) {
    const bootstrap = liveIds.has(owned.lastTargetId) ? owned.lastTargetId : liveTabs[0].id;
    browserBootstrapTargets.set(client, bootstrap);
  }
  return liveTabs.map(targetInfo);
}

function ownedTabSession(client, create = false) {
  const scope = browserScopes.get(client);
  if (!scope) return null;
  let owned = state.browserTabSessions.get(scope.session);
  if (!owned && create) {
    if (state.browserTabSessions.size >= MAX_BROWSER_TAB_SESSIONS) {
      throw new Error("too many browser tab sessions");
    }
    owned = {
      groupId: null,
      title: scope.groupTitle,
      tabIds: new Set(),
      lastTargetId: null,
      tail: Promise.resolve(),
    };
    state.browserTabSessions.set(scope.session, owned);
  }
  return owned;
}

function requireOwnedTab(client, tabId) {
  const scope = browserScopes.get(client);
  if (!scope) return;
  if (!state.browserTabSessions.get(scope.session)?.tabIds.has(tabId)) {
    throw new Error("target is outside this browser session");
  }
}

function forgetTab(tabId) {
  for (const [session, owned] of state.browserTabSessions) {
    owned.tabIds.delete(tabId);
    if (owned.lastTargetId === tabId) owned.lastTargetId = [...owned.tabIds].at(-1) ?? null;
    if (owned.tabIds.size === 0) state.browserTabSessions.delete(session);
  }
}

function enqueueTabCreation(owned, fn) {
  const run = owned.tail.then(fn, fn);
  owned.tail = run.catch(() => {});
  return run;
}

async function detachIfUnused(tabId) {
  for (const session of state.sessions.values()) {
    if (session.tabId === tabId) return;
  }
  await extDetach(tabId);
}

async function routeBrowserLevel(method, params, client) {
  switch (method) {
    case "Target.getTargets":
      return { targetInfos: await listTargetInfos(client) };
    case "Target.getTargetInfo": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      requireOwnedTab(client, tabId);
      const tab = await extTabOp("get", { tabId });
      return { targetInfo: targetInfo(tab) };
    }
    case "Target.createTarget": {
      const url = params && params.url ? params.url : "about:blank";
      const scope = browserScopes.get(client);
      if (!scope) {
        const tab = await extTabOp("create", { url, active: params.background !== true });
        return { targetId: targetIdFor(tab.id) };
      }
      const owned = ownedTabSession(client, true);
      const bootstrapTabId = browserBootstrapTargets.get(client);
      if (
        bootstrapTabId
        && owned.tabIds.has(bootstrapTabId)
        && ![...state.sessions.values()].some((session) => session.client === client)
      ) {
        browserBootstrapTargets.delete(client);
        return { targetId: targetIdFor(bootstrapTabId) };
      }
      return enqueueTabCreation(owned, async () => {
        const tab = await extTabOp("create", { url, active: params.background !== true });
        try {
          const grouped = await extTabOp("group", {
            tabId: tab.id,
            groupId: owned.groupId,
            title: owned.title,
          });
          owned.groupId = grouped.groupId;
          owned.tabIds.add(tab.id);
          return { targetId: targetIdFor(tab.id) };
        } catch (error) {
          await extTabOp("remove", { tabId: tab.id }).catch(() => {});
          if (owned.tabIds.size === 0) state.browserTabSessions.delete(scope.session);
          throw error;
        }
      });
    }
    case "Target.attachToTarget": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      if (!tabId) throw new Error("attachToTarget: bad targetId " + params.targetId);
      requireOwnedTab(client, tabId);
      const sessionId = "awbs" + nextId();
      state.sessions.set(sessionId, { tabId, client });
      const owned = ownedTabSession(client);
      if (owned) owned.lastTargetId = tabId;
      browserBootstrapTargets.delete(client);
      return { sessionId };
    }
    case "Target.activateTarget": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      requireOwnedTab(client, tabId);
      await extTabOp("activate", { tabId });
      return {};
    }
    case "Target.closeTarget": {
      const tabId = Number(String(params.targetId).replace(/^awb-/, ""));
      requireOwnedTab(client, tabId);
      await extTabOp("remove", { tabId });
      for (const [sid, session] of state.sessions) if (session.tabId === tabId) state.sessions.delete(sid);
      state.downloadPolicies.delete(tabId);
      state.tabTargets.delete(tabId);
      forgetTab(tabId);
      return { success: true };
    }
    case "Target.detachFromTarget": {
      const session = state.sessions.get(params.sessionId);
      if (session && session.client === client) {
        state.sessions.delete(params.sessionId);
        await detachIfUnused(session.tabId);
      }
      return {};
    }
    // Auto-attach / discovery — not meaningful over chrome.debugger; ack quietly.
    case "Target.setDiscoverTargets":
    case "Target.setAutoAttach":
    case "Target.setAttachToOtherTargets":
    case "Target.setRemoteLocations":
      return {};
    default:
      throw new Error("unsupported browser-level method " + method);
  }
}

// Serialize session-scoped CDP commands per tab so concurrent sessions on the
// same tab never interleave commands (chrome.debugger is per-tab flat).
function enqueuePerTab(tabId, fn) {
  let queue = state.perTabQueues.get(tabId);
  if (!queue) {
    queue = { tail: Promise.resolve(), depth: 0 };
    state.perTabQueues.set(tabId, queue);
  }
  if (queue.depth >= MAX_TAB_QUEUE_DEPTH) throw new Error("tab command queue is full");
  queue.depth++;
  const run = queue.tail.then(fn, fn);
  queue.tail = run.catch(() => {});
  void queue.tail.then(() => {
    queue.depth--;
    if (queue.depth === 0 && state.perTabQueues.get(tabId) === queue) {
      state.perTabQueues.delete(tabId);
    }
  });
  return run;
}

export async function route(m, client) {
  if (m.method.startsWith("Target.") && !m.sessionId) {
    return routeBrowserLevel(m.method, m.params || {}, client);
  }
  if (!m.sessionId) throw new Error("no sessionId and " + m.method + " is not browser-level");
  const session = state.sessions.get(m.sessionId);
  if (!session || session.client !== client) throw new Error("unknown sessionId " + m.sessionId);
  if (m.method === "Page.setDownloadBehavior" || m.method === "Browser.setDownloadBehavior") {
    if (!DOWNLOAD_ROOT) throw new Error("download behavior is unavailable");
    const behavior = m.params && m.params.behavior;
    if (behavior !== "allow") {
      throw new Error("download path is outside the configured root");
    }
    const destination = safeDownloadDestination(m.params && m.params.downloadPath);
    const current = state.downloadPolicies.get(session.tabId);
    if (current && current.client !== client) throw new Error("download policy is owned by another client");
    state.downloadPolicies.set(session.tabId, { client, destination });
    void extSetDownloadBehavior(session.tabId, behavior).catch(() => {});
    return {};
  }
  return enqueuePerTab(session.tabId, () => {
    if (!state.clients.has(client) || state.sessions.get(m.sessionId) !== session) {
      throw new Error("browser session revoked");
    }
    const params = m.method === "DOM.setFileInputFiles"
      ? safeUploadFiles(m.params)
      : (m.params || {});
    return extCmd(session.tabId, m.method, params);
  });
}

const clientCleanup = new WeakMap();

async function performClientCleanup(client) {
  unregisterBrowserClient(client);
  browserInflight.delete(client);
  browserScopes.delete(client);
  browserBootstrapTargets.delete(client);
  state.clients.delete(client);
  const tabs = new Set();
  for (const [sid, session] of state.sessions) {
    if (session.client !== client) continue;
    state.sessions.delete(sid);
    tabs.add(session.tabId);
  }
  for (const [tabId, policy] of state.downloadPolicies) {
    if (policy.client === client) state.downloadPolicies.delete(tabId);
  }
  for (const [guid, transfer] of state.downloadTransfers) {
    if (transfer.client === client) state.downloadTransfers.delete(guid);
  }
  await Promise.all([...tabs].map((tabId) => detachIfUnused(tabId)));
}

function cleanupClient(client) {
  const existing = clientCleanup.get(client);
  if (existing) return existing;
  const cleanup = performClientCleanup(client);
  clientCleanup.set(client, cleanup);
  return cleanup;
}

export async function shutdownBrowserClients() {
  const clients = [...state.clients];
  for (const client of clients) {
    state.clients.delete(client);
    unregisterBrowserClient(client);
    browserInflight.delete(client);
    try { client.terminate?.(); } catch {}
  }
  await Promise.all(clients.map((client) => cleanupClient(client)));

  const leftoverTabs = new Set([...state.sessions.values()].map((session) => session.tabId));
  state.sessions.clear();
  state.downloadPolicies.clear();
  state.downloadTransfers.clear();
  await Promise.all([...leftoverTabs].map((tabId) => extDetach(tabId)));
}

export function handleBrowser(ws, scope = null) {
  if (state.clients.size >= MAX_BROWSER_CLIENTS) {
    try { ws.close(1013, "too many browser clients"); } catch {}
    return;
  }
  state.clients.add(ws);
  if (scope) browserScopes.set(ws, scope);
  registerBrowserClient(ws, () => { void cleanupClient(ws); });
  ws.on("message", async (data) => {
    if (!state.clients.has(ws)) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id === undefined) return; // client events/acks — ignore
    const inflight = browserInflight.get(ws) || 0;
    if (inflight >= MAX_CLIENT_INFLIGHT) {
      sendBrowserMessage(ws, { id: m.id, error: { code: -32000, message: "too many in-flight browser commands" } });
      return;
    }
    browserInflight.set(ws, inflight + 1);
    try {
      const result = await route(m, ws);
      if (!state.clients.has(ws)) return;
      sendBrowserMessage(ws, { id: m.id, result });
    } catch (e) {
      if (!state.clients.has(ws)) return;
      sendBrowserMessage(ws, { id: m.id, error: { code: -32000, message: String((e && e.message) || e) } });
    } finally {
      const remaining = (browserInflight.get(ws) || 1) - 1;
      if (remaining > 0) browserInflight.set(ws, remaining);
      else browserInflight.delete(ws);
    }
  });
  ws.on("close", () => { void cleanupClient(ws); });
  ws.on("error", () => {});
}
