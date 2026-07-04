// Dashboard UI, shared by two shells:
//  - panel.html     (data-mode="page"): full-page dashboard; the tab to
//    monitor comes from the ?tab= query param, with a stream picker when
//    absent.
//  - sidepanel.html (data-mode="side"): compact layout for Chrome's side
//    panel, docked next to the player page; it follows the active tab.

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

const MODE = document.body.dataset.mode === "side" ? "side" : "page";
const $ = (id) => document.getElementById(id);

document.getElementById("app").innerHTML = `
  <div id="picker" hidden>
    <h1>HLS Monitor</h1>
    <p class="muted">Select a tab with a detected HLS stream:</p>
    <ul id="streamList"></ul>
    <p id="noStreams" class="muted" hidden>
      No HLS streams detected yet. Open a page that plays an HLS stream (a
      <code>.m3u8</code> playlist), then come back here.
    </p>
  </div>

  <div id="dash" hidden>
    <header>
      <h1>HLS Monitor</h1>
      <span id="status" class="pill idle"><span class="dot"></span><span id="statusLabel">–</span></span>
      <span class="seg-live" title="Pulses each time a new video segment arrives">
        <span class="seg-pulse" id="segPulse"><span class="ring"></span><span class="core"></span></span>
        <b id="segLive">0</b><span>segments</span>
      </span>
      <span id="pageUrl"></span>
      <span class="spacer"></span>
      <div class="controls">
        <label><input type="checkbox" id="parseToggle" checked /> parse playlists</label>
        <button id="exportBtn">Export JSON</button>
        <button id="clearBtn">Clear</button>
      </div>
    </header>
    <p id="detail"></p>

    <div class="tiles">
      <div class="tile"><div class="label">Segments loaded</div><div class="value" id="segCount">–</div><div class="sub" id="segBytes"></div></div>
      <div class="tile"><div class="label">Errors</div><div class="value" id="errCount">–</div></div>
      <div class="tile"><div class="label">TTFB avg / p95</div><div class="value" id="ttfb">–</div></div>
      <div class="tile"><div class="label">Throughput avg / min</div><div class="value" id="bps">–</div></div>
      <div class="tile"><div class="label">Download speed</div><div class="value" id="speed">–</div><div class="sub">× realtime (avg / min)</div></div>
      <div class="tile"><div class="label">Last segment</div><div class="value" id="lastSeg">–</div></div>
      <div class="tile"><div class="label">Playlist refresh</div><div class="value" id="refresh">–</div><div class="sub" id="targetDur"></div></div>
      <div class="tile"><div class="label">Media sequence</div><div class="value" id="mediaSeq">–</div><div class="sub" id="seqAge"></div></div>
    </div>

    <div class="charts">
      <div class="card">
        <h2>Segment TTFB (ms)</h2>
        <div><canvas id="ttfbChart"></canvas></div>
      </div>
      <div class="card">
        <h2>Segment throughput (Mbps)</h2>
        <div><canvas id="bpsChart"></canvas></div>
      </div>
    </div>

    <section class="card">
      <h2>Playlists</h2>
      <div class="table-wrap">
        <table id="playlists">
          <thead>
            <tr>
              <th>Playlist</th><th>Type</th><th class="num">Fetches</th>
              <th class="num">Errors</th><th class="num">Refresh (median)</th>
              <th class="num">Target dur</th><th class="num">Media seq</th><th>Advancing</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Recent requests <span class="muted" id="reqNote"></span></h2>
      <div class="table-wrap">
        <table id="requests">
          <thead>
            <tr>
              <th>Time</th><th>Type</th><th>Name</th><th class="num">Status</th>
              <th class="num">Size</th><th class="num">TTFB</th><th class="num">Download</th>
              <th class="num">Total</th><th class="num">Throughput</th><th>Cache</th><th>Error</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </div>`;

let tabId = null;

// ------------------------------------------------------------ stream picker

async function refreshPicker() {
  const streams = await sendMessage({ type: "listStreams" });
  const list = $("streamList");
  list.innerHTML = "";
  $("noStreams").hidden = streams.length > 0;
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

// ------------------------------------------------------------ dashboard

let refreshNow = () => {};

function initDashboard() {
  const chartHeight = MODE === "side" ? 140 : 180;
  const ttfbChart = new LineChart($("ttfbChart"), {
    color: "--series-1",
    height: chartHeight,
    fmtAxis: (v) => Math.round(v),
    fmtValue: (v) => Math.round(v) + " ms",
  });
  const bpsChart = new LineChart($("bpsChart"), {
    color: "--series-2",
    height: chartHeight,
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
    if (tabId === null) return;
    await sendMessage({ type: "clear", tabId });
    refresh();
  });

  // segment-arrival pulse: an expanding ring next to a live counter, plus a
  // bump on the "Segments loaded" tile, whenever the segment total grows.
  let pulseTab = null;
  let lastSegTotal = null;
  function firePulse() {
    for (const [el, cls] of [
      [$("segPulse"), "pulse"],
      [$("segCount"), "bump"],
      [$("segLive"), "bump"],
    ]) {
      el.classList.remove(cls);
      void el.offsetWidth; // restart the CSS animation
      el.classList.add(cls);
    }
  }

  async function refresh() {
    const st = tabId === null ? null : await sendMessage({ type: "getState", tabId });
    latest = st;
    const now = st && st.active ? st.now : Date.now();
    const stats = st && st.active ? computeStats(st.segments, now) : computeStats([], now);
    const status = deriveStatus(st, stats);

    $("status").className = "pill " + status.level;
    $("statusLabel").textContent = status.label;
    $("detail").textContent = status.detail;
    document.title = "HLS Monitor — " + status.label;

    const segTotal = st && st.active ? st.totals.segments : 0;
    $("segLive").textContent = segTotal;
    if (pulseTab === tabId && lastSegTotal !== null && segTotal > lastSegTotal) {
      firePulse();
    }
    pulseTab = tabId;
    lastSegTotal = segTotal;

    if (!st || !st.active) {
      $("pageUrl").textContent = MODE === "side" ? "" : "tab closed or no data";
      ttfbChart.setData([]);
      bpsChart.setData([]);
      $("playlists").querySelector("tbody").innerHTML = "";
      $("requests").querySelector("tbody").innerHTML = "";
      for (const id of ["segCount", "errCount", "ttfb", "bps", "speed", "lastSeg", "refresh", "mediaSeq"]) {
        $(id).textContent = "–";
      }
      $("segBytes").textContent = "";
      $("targetDur").textContent = "";
      $("seqAge").textContent = "";
      return;
    }
    $("pageUrl").textContent = st.pageUrl || "";

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
      main && main.lastSeqChangeAt ? "advanced " + fmtAgo(now - main.lastSeqChangeAt) : "";

    // charts: successful segments only
    const okSegs = st.segments.filter(
      (r) => r.kind === "segment" && !r.error && r.status && r.status < 400
    );
    ttfbChart.setData(
      okSegs.filter((r) => r.ttfbMs !== null).map((r) => ({ t: r.end, v: r.ttfbMs, label: r.name }))
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
    const rows = st.segments.slice(MODE === "side" ? -30 : -60).reverse();
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

  refreshNow = refresh;
  refresh();
  setInterval(refresh, 1000);
}

// ------------------------------------------------------------ mode startup

if (MODE === "side") {
  // The side panel is docked next to the page, so it always monitors the
  // active tab of its window and follows tab switches.
  $("dash").hidden = false;
  const trackActiveTab = async () => {
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t && t.id !== tabId) {
        tabId = t.id;
        refreshNow();
      }
    } catch {}
  };
  initDashboard();
  trackActiveTab();
  chrome.tabs.onActivated.addListener(trackActiveTab);
} else {
  const params = new URLSearchParams(location.search);
  if (params.has("tab")) {
    tabId = Number(params.get("tab"));
    $("dash").hidden = false;
    initDashboard();
  } else {
    $("picker").hidden = false;
    refreshPicker();
    setInterval(refreshPicker, 2000);
  }
}
