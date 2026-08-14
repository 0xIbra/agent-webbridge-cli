// Shared daemon state — single object so modules don't import each other.

export const state = {
  ext: null,            // extension WebSocket (single)
  extInfo: null,        // { extensionVersion, runtimeId } from hello
  clients: new Set(),   // browser-level CDP clients (harness daemons)
  pending: new Map(),   // request id -> { resolve, reject, timer }
  extWaiters: [],       // resolvers waiting for the extension to (re)connect
  sessions: new Map(),  // sessionId -> tabId (flatten attach sessions)
  tabTargets: new Map(),// tabId -> targetId
  perTabQueues: new Map(), // tabId -> tail Promise (serialize CDP per tab)
  seq: 1,
};

export function nextId() {
  return state.seq++;
}
