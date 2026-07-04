import {
  fmtMs,
  fmtMbps,
  fmtAgo,
  computeStats,
  deriveStatus,
  sendMessage,
} from "./common.js";

let tabId = null;

const $ = (id) => document.getElementById(id);

async function refresh() {
  if (tabId === null) return;
  const st = await sendMessage({ type: "getState", tabId });
  const stats = st && st.active ? computeStats(st.segments, st.now) : computeStats([], Date.now());
  const status = deriveStatus(st, stats);

  const pill = $("status");
  pill.className = "pill " + status.level;
  $("statusLabel").textContent = status.label;
  $("detail").textContent = status.detail;

  $("segCount").textContent = st && st.active ? st.totals.segments : "0";
  const errs = st && st.active ? st.totals.errors : 0;
  $("errCount").textContent = errs;
  $("errCount").className = "value" + (errs > 0 ? " bad" : "");
  $("ttfb").textContent = fmtMs(stats.ttfbAvg);
  $("bps").textContent = fmtMbps(stats.bpsAvg);
  $("speed").textContent = stats.speedAvg !== null ? stats.speedAvg.toFixed(1) + "×" : "–";
  $("lastSeg").textContent = stats.lastSegAge !== null ? fmtAgo(stats.lastSegAge) : "–";
}

$("openPanel").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("panel.html?tab=" + tabId) });
});

chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  if (tabs[0]) tabId = tabs[0].id;
  refresh();
  setInterval(refresh, 1000);
});
