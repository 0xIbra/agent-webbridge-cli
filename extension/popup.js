// Agent WebBridge CLI popup — status badge + daemon URL pairing.

const $ = (id) => document.getElementById(id);

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
    if (chrome.runtime.lastError || !r) {
      $("status").textContent = "Not ready";
      $("badge").className = "badge";
      return;
    }
    $("status").textContent = r.connected ? "Up and running" : "Not connected";
    $("badge").className = r.connected ? "badge up" : "badge";
    if (r.url && r.url !== $("url").value) $("url").value = r.url;
  });
}

$("save").addEventListener("click", () => {
  const url = $("url").value.trim();
  if (!/^wss?:\/\//.test(url)) return;
  const btn = $("save");
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: "SET_URL", url }, () => {
    btn.disabled = false;
    setTimeout(refresh, 500);
  });
});

$("version").textContent = "Agent WebBridge CLI " + chrome.runtime.getManifest().version;
refresh();
setInterval(refresh, 3000);
