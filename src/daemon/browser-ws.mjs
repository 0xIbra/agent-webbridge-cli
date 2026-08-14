// Browser-facing WebSocket writes must never grow ws' internal queue without
// bound. A single oversized frame is treated the same as an already-slow peer.

export const MAX_BROWSER_BUFFER_BYTES = 1024 * 1024;
const revokers = new WeakMap();

export function registerBrowserClient(ws, revoke) {
  revokers.set(ws, revoke);
}

export function unregisterBrowserClient(ws) {
  revokers.delete(ws);
}

function closeSlowBrowser(ws) {
  const revoke = revokers.get(ws);
  revokers.delete(ws);
  try { revoke?.(); } catch {}
  try {
    if (ws.readyState === ws.OPEN) ws.close(1013, "browser client too slow");
    else ws.terminate?.();
  } catch {
    try { ws.terminate?.(); } catch {}
  }
}

export function sendBrowserMessage(ws, message) {
  if (ws.readyState !== ws.OPEN) return false;
  const payload = JSON.stringify(message);
  const frameBytes = Buffer.byteLength(payload);
  const bufferedBytes = Number(ws.bufferedAmount) || 0;
  if (frameBytes > MAX_BROWSER_BUFFER_BYTES - bufferedBytes) {
    closeSlowBrowser(ws);
    return false;
  }
  try {
    ws.send(payload, (error) => {
      if (error) closeSlowBrowser(ws);
    });
    return true;
  } catch {
    closeSlowBrowser(ws);
    return false;
  }
}
