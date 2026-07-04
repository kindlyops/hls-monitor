import {
  fmtBytes,
  fmtMbps,
  fmtMs,
  fmtAgo,
  fmtClock,
  throughputBps,
  computeStats,
  deriveStatus,
  sendMessage,
  medianRefreshMs,
} from "./common.js";
import { LineChart } from "./charts.js";

const params = new URLSearchParams(location.search);
const tabId = params.has("tab") ? Number(params.get("tab")) : null;

const $ = (id) => document.getElementById(id);

if (tabId === null) {
  $("picker").style.display = "";
  refreshPicker();
  setInterval(refreshPicker, 2000);
} else {
  $("dash").style.display = "";
  initDashboard();
}

async function refreshPicker() {
  const streams = await sendMessage({ type: "listStreams" });
  const list = $("streamList");
  list.innerHTML = "";
  $("noStreams").style.display = streams.length ? "none" : "";
  for (const s of streams) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "panel.html?tab=" + s.tabId;
    a.textContent = s.pageUrl || s.playlists[0] || "tab " + s.tabId;
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = ` — ${s.segments} segments, ${s.errors} errors`;
    li.appendChild(a);
    li.appendChild(meta);
    list.appendChild(li);
  }
}

function initDashboard() {
  const ttfbChart = new LineChart($("ttfbChart"), {
    color: "--series-1",
    fmtAxis: (v) => Math.round(v),
    fmtValue: (v) => Math.round(v) + " ms",
  });
  const bpsChart = new LineChart($("bpsChart"), {
    color: "--series-2",
    fmtAxis: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)),
    fmtValue: (v) => v.toFixed(1) + " Mbps",
  });

  chrome.storage.local.get("settings").then((r) => {
    $("parseToggle").checked = r.settings ? r.settings.parsePlaylists !== false : true;
  });
  $("parseToggle").addEventListener("change", (e) => {
    chrome.storage.local.set({ settings: { parsePlaylists: e.target.checked } });
  });

  let latest = null;
  $("exportBtn").addEventListener("click", () => {
    if (!latest) return;
    const blob = new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hls-monitor-tab" + tabId + "-" + Date.now() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("clearBtn").addEventListener("click", async () => {
    await sendMessage({ type: "clear", tabId });
    refresh();
  });

  async function refresh() {
    const st = await sendMessage({ type: "getState", tabId });
    latest = st;
    const now = st && st.active ? st.now : Date.now();
    const stats = st && st.active ? computeStats(st.segments, now) : computeStats([], now);
    const status = deriveStatus(st, stats);

    $("status").className = "pill " + status.level;
    $("statusLabel").textContent = status.label;
    $("detail").textContent = status.detail;
    $("pageUrl").textContent = st && st.active ? st.pageUrl || "" : "tab closed or no data";
    document.title = "HLS Monitor — " + status.label;

    if (!st || !st.active) {
      ttfbChart.setData([]);
      bpsChart.setData([]);
      return;
    }

    $("segCount").textContent = st.totals.segments;
    $("segBytes").textContent = fmtBytes(st.totals.bytes) + " total";
    $("errCount").textContent = st.totals.errors;
    $("errCount").className = "value" + (st.totals.errors > 0 ? " bad" : "");
    $("ttfb").textContent =
      stats.ttfbAvg !== null
        ? Math.round(stats.ttfbAvg) + " / " + Math.round(stats.ttfbP95) + " ms"
        : "–";
    $("bps").textContent =
      stats.bpsAvg !== null
        ? (stats.bpsAvg / 1e6).toFixed(1) + " / " + (stats.bpsMin / 1e6).toFixed(1) + " Mbps"
        : "–";
    $("speed").textContent =
      stats.speedAvg !== null
        ? stats.speedAvg.toFixed(1) + "× / " + stats.speedMin.toFixed(1) + "×"
        : "–";
    $("lastSeg").textContent = stats.lastSegAge !== null ? fmtAgo(stats.lastSegAge) : "–";

    // playlist tiles: use the media playlist with the most fetches
    const media = Object.values(st.playlists).filter((p) => p.isMaster !== true);
    media.sort((a, b) => b.fetchCount - a.fetchCount);
    const main = media[0] || null;
    $("refresh").textContent = main ? fmtMs(medianRefreshMs(main)) : "–";
    $("targetDur").textContent =
      main && main.targetDuration ? "target duration " + main.targetDuration + "s" : "";
    $("mediaSeq").textContent = main && main.mediaSequence !== null ? main.mediaSequence : "–";
    $("seqAge").textContent =
      main && main.lastSeqChangeAt
        ? "advanced " + fmtAgo(now - main.lastSeqChangeAt)
        : "";

    // charts: successful segments only
    const okSegs = st.segments.filter(
      (r) => r.kind === "segment" && !r.error && r.status && r.status < 400
    );
    ttfbChart.setData(
      okSegs
        .filter((r) => r.ttfbMs !== null)
        .map((r) => ({ t: r.end, v: r.ttfbMs, label: r.name }))
    );
    bpsChart.setData(
      okSegs
        .map((r) => ({ t: r.end, v: (throughputBps(r) || 0) / 1e6, label: r.name }))
        .filter((p) => p.v > 0)
    );

    renderPlaylists(st, now);
    renderRequests(st);
  }

  function renderPlaylists(st, now) {
    const tbody = $("playlists").querySelector("tbody");
    tbody.innerHTML = "";
    for (const pl of Object.values(st.playlists)) {
      const tr = document.createElement("tr");
      const type =
        pl.isMaster === true ? "master" : pl.isMaster === false ? (pl.live ? "media (live)" : "media (vod)") : "?";
      const advancing =
        pl.isMaster === false && pl.live
          ? pl.lastSeqChangeAt
            ? fmtAgo(now - pl.lastSeqChangeAt)
            : "?"
          : "—";
      const cells = [
        pl.url,
        type,
        pl.fetchCount,
        pl.errorCount,
        fmtMs(medianRefreshMs(pl)),
        pl.targetDuration !== null ? pl.targetDuration + "s" : "–",
        pl.mediaSequence !== null ? pl.mediaSequence : "–",
        advancing,
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i >= 2 && i <= 6) td.className = "num";
        if (i === 0) td.title = pl.url;
        tr.appendChild(td);
      });
      if (pl.errorCount > 0) tr.className = "err";
      tbody.appendChild(tr);
    }
  }

  function renderRequests(st) {
    const tbody = $("requests").querySelector("tbody");
    tbody.innerHTML = "";
    const rows = st.segments.slice(-60).reverse();
    $("reqNote").textContent = "(last " + rows.length + ")";
    for (const r of rows) {
      const tr = document.createElement("tr");
      const failed = r.error || (r.status && r.status >= 400);
      if (failed) tr.className = "err";
      const bps = throughputBps(r);
      const cells = [
        fmtClock(r.start),
        r.kind === "playlist" ? "PL" : "SEG",
        r.name,
        r.status !== null ? r.status : "–",
        fmtBytes(r.bytes),
        fmtMs(r.ttfbMs),
        fmtMs(r.downloadMs),
        fmtMs(r.totalMs),
        bps !== null ? fmtMbps(bps) : "–",
        r.fromCache ? "hit" : "",
        r.error || "",
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i >= 3 && i <= 8) td.className = "num";
        if (i === 2) td.title = r.url;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  refresh();
  setInterval(refresh, 1000);
}
