// Standalone HLS monitor page. Where the extension passively observes a
// player's network traffic, this page IS the player (minus decoding): it
// fetches the playlist on the HLS refresh cadence and downloads each new
// segment, timing everything, then renders the same dashboard as the
// extension panel. Requires CORS on the stream origin.
//
// Input: monitor.html#src=<url>[,<url>...] (each URL-encoded). Several
// candidates render a picker; none renders a paste box.

import {
  fmtBytes,
  fmtMbps,
  fmtMs,
  fmtAgo,
  fmtClock,
  throughputBps,
  computeStats,
  deriveStatus,
  medianRefreshMs,
} from "./common.js";
import { LineChart } from "./charts.js";

const MAX_SEGMENTS = 600; // rolling window of request records
const MAX_PLAYLIST_FETCHES = 120; // refresh history kept per playlist URL
const LIVE_EDGE_SEGMENTS = 2; // segments fetched from the first live window

const $ = (id) => document.getElementById(id);

document.getElementById("app").innerHTML = `
  <div id="picker" hidden>
    <h1>HLS Monitor</h1>
    <div id="candidatesWrap" hidden>
      <p class="muted">Several playlists were found on the page — pick one to monitor:</p>
      <ul id="candidates"></ul>
    </div>
    <p class="muted">Paste the URL of an HLS playlist (<code>.m3u8</code>) to monitor:</p>
    <form id="srcForm">
      <input id="srcInput" type="url" required placeholder="https://example.com/stream/live.m3u8" />
      <button class="primary">Monitor</button>
    </form>
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
        <span id="variantWrap" hidden><select id="variantSel"></select></span>
        <button id="pauseBtn">Pause</button>
        <button id="exportBtn">Export JSON</button>
        <a href="monitor.html"><button type="button">Change stream</button></a>
      </div>
    </header>
    <p id="detail"></p>
    <div id="banner" hidden></div>

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
              <th class="num">Total</th><th class="num">Throughput</th><th>Error</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </div>`;

// ------------------------------------------------------------ shared helpers

function shortName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || u.hostname;
  } catch {
    return url;
  }
}

function stripFragment(url) {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

// Same parser as extension/background.js — keep in sync.
function parsePlaylist(text, baseUrl) {
  const out = {
    isMaster: false,
    targetDuration: null,
    mediaSequence: null,
    endlist: false,
    segs: [],
    variants: [],
  };
  let nextDur = null;
  let nextVariant = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      out.isMaster = true;
      const attrs = line.slice("#EXT-X-STREAM-INF:".length);
      const bw = /BANDWIDTH=(\d+)/.exec(attrs);
      const res = /RESOLUTION=(\d+x\d+)/.exec(attrs);
      nextVariant = {
        bandwidth: bw ? parseInt(bw[1], 10) : null,
        resolution: res ? res[1] : null,
      };
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      out.targetDuration = parseFloat(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      out.mediaSequence = parseInt(line.split(":")[1], 10);
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      out.endlist = true;
    } else if (line.startsWith("#EXTINF:")) {
      nextDur = parseFloat(line.slice("#EXTINF:".length));
    } else if (!line.startsWith("#")) {
      let resolvedUrl;
      try {
        resolvedUrl = new URL(line, baseUrl).href;
      } catch {
        continue;
      }
      if (nextVariant) {
        out.variants.push({ url: resolvedUrl, ...nextVariant });
        nextVariant = null;
      } else {
        out.segs.push({ url: stripFragment(resolvedUrl), duration: nextDur });
        nextDur = null;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ monitor engine

const state = {
  active: false,
  detectedAt: null,
  pageUrl: null, // the monitored stream URL
  playlists: {},
  segments: [],
  segMeta: {},
  totals: { segments: 0, bytes: 0, errors: 0 },
};
// Test/debug hook, mirroring the extension's __hlsMonitorState.
globalThis.__hlsMonitorState = state;

let generation = 0; // bumped on stop/variant switch to cancel stale loops
let paused = false;
let abortCtl = null;
let onNewSegment = () => {};

// Fetch url with timing: TTFB = headers received, bytes = body actually read.
async function fetchTimed(url, kind) {
  const start = Date.now();
  const t0 = performance.now();
  const rec = {
    kind,
    url,
    name: shortName(url),
    start,
    end: null,
    ttfbMs: null,
    downloadMs: null,
    totalMs: null,
    bytes: null,
    status: null,
    error: null,
    mediaDur: null,
  };
  let text = null;
  let finalUrl = url;
  try {
    const resp = await fetch(url, { cache: "no-store", signal: abortCtl.signal });
    rec.ttfbMs = performance.now() - t0;
    rec.status = resp.status;
    finalUrl = resp.url || url;
    const buf = await resp.arrayBuffer();
    rec.bytes = buf.byteLength;
    if (kind === "playlist" && resp.ok) text = new TextDecoder().decode(buf);
  } catch (e) {
    if (abortCtl.signal.aborted) return null;
    rec.error = String(e && e.message ? e.message : e);
  }
  rec.totalMs = performance.now() - t0;
  rec.end = start + rec.totalMs;
  rec.downloadMs = rec.ttfbMs !== null ? Math.max(0, rec.totalMs - rec.ttfbMs) : null;
  return { rec, text, finalUrl };
}

function recordRequest(rec) {
  const failed = !!rec.error || (rec.status !== null && rec.status >= 400);
  if (rec.kind === "segment") rec.mediaDur = state.segMeta[stripFragment(rec.url)] ?? null;
  state.segments.push(rec);
  if (state.segments.length > MAX_SEGMENTS) {
    state.segments.splice(0, state.segments.length - MAX_SEGMENTS);
  }
  if (rec.kind === "segment") {
    state.totals.segments += 1;
    if (rec.bytes) state.totals.bytes += rec.bytes;
    if (!failed) onNewSegment();
  }
  if (failed) state.totals.errors += 1;
  if (rec.kind === "playlist" && !state.detectedAt) state.detectedAt = rec.start;
  return failed;
}

function getPlaylistState(url) {
  let pl = state.playlists[url];
  if (!pl) {
    pl = state.playlists[url] = {
      url,
      name: shortName(url),
      firstSeen: Date.now(),
      lastFetchStart: null,
      fetchCount: 0,
      errorCount: 0,
      refreshMs: [],
      isMaster: null,
      live: null,
      targetDuration: null,
      mediaSequence: null,
      lastSeqChangeAt: null,
      lastSegmentUri: null,
      segmentCount: null,
      variants: [],
    };
  }
  return pl;
}

// Fetch + record one playlist request; returns parse result or null on failure.
async function fetchPlaylist(url) {
  const res = await fetchTimed(url, "playlist");
  if (!res) return null; // aborted
  const pl = getPlaylistState(url);
  if (pl.lastFetchStart !== null) {
    pl.refreshMs.push(res.rec.start - pl.lastFetchStart);
    if (pl.refreshMs.length > MAX_PLAYLIST_FETCHES) {
      pl.refreshMs.splice(0, pl.refreshMs.length - MAX_PLAYLIST_FETCHES);
    }
  }
  pl.lastFetchStart = res.rec.start;
  pl.fetchCount += 1;
  const failed = recordRequest(res.rec);
  if (failed) {
    pl.errorCount += 1;
    return { pl, parsed: null, rec: res.rec };
  }
  return { pl, parsed: parsePlaylist(res.text, res.finalUrl), rec: res.rec };
}

function applyParsedMedia(pl, parsed) {
  pl.isMaster = false;
  pl.live = !parsed.endlist;
  if (parsed.targetDuration !== null) pl.targetDuration = parsed.targetDuration;
  pl.segmentCount = parsed.segs.length;
  const lastUri = parsed.segs.length ? parsed.segs[parsed.segs.length - 1].url : null;
  const advanced =
    (parsed.mediaSequence !== null && parsed.mediaSequence !== pl.mediaSequence) ||
    (lastUri && lastUri !== pl.lastSegmentUri);
  if (advanced || pl.lastSeqChangeAt === null) pl.lastSeqChangeAt = Date.now();
  if (parsed.mediaSequence !== null) pl.mediaSequence = parsed.mediaSequence;
  pl.lastSegmentUri = lastUri;
  for (const seg of parsed.segs) state.segMeta[seg.url] = seg.duration;
  return advanced;
}

// Single-consumer segment queue so downloads never overlap and throughput
// measurements stay clean.
const segQueue = [];
const queuedUrls = new Set();
let workerRunning = false;

function enqueueSegments(urls) {
  for (const u of urls) {
    if (queuedUrls.has(u)) continue;
    queuedUrls.add(u);
    segQueue.push(u);
  }
  if (!workerRunning) segWorker();
}

// The worker outlives stream/variant switches: it drains whatever is queued,
// and fetchTimed picks up the current AbortController per request, so an
// aborted fetch is simply skipped (returns null) and draining continues.
async function segWorker() {
  workerRunning = true;
  while (segQueue.length) {
    while (paused) await sleep(300);
    const url = segQueue.shift();
    const res = await fetchTimed(url, "segment");
    if (res) recordRequest(res.rec);
  }
  workerRunning = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HLS-spec refresh cadence: target duration after an advancing reload, half
// after an unchanged one. Clamped so broken playlists can't spin or stall.
function refreshDelayMs(pl, advanced) {
  const target = (pl.targetDuration || 4) * 1000;
  return Math.min(10000, Math.max(500, advanced ? target : target / 2));
}

// Poll a media playlist on the spec cadence, feeding new segments to the
// queue. initialRes lets the caller pass in an already-fetched first result.
async function monitorMedia(url, gen, initialRes = null) {
  let firstParse = true;
  while (gen === generation) {
    while (paused) await sleep(300);
    const res = initialRes || (await fetchPlaylist(url));
    initialRes = null;
    if (!res) return; // aborted
    let advanced = false;
    if (res.parsed) {
      if (res.parsed.isMaster) {
        showBanner(`${shortName(url)} is a master playlist nested inside a master playlist — not monitoring it.`);
        return;
      }
      advanced = applyParsedMedia(res.pl, res.parsed);
      let fresh = res.parsed.segs.map((s) => s.url).filter((u) => !queuedUrls.has(u));
      if (firstParse && res.pl.live) {
        // join at the live edge like a real player instead of backfilling
        // the whole window
        fresh = fresh.slice(-LIVE_EDGE_SEGMENTS);
        for (const s of res.parsed.segs) if (!fresh.includes(s.url)) queuedUrls.add(s.url);
      }
      enqueueSegments(fresh);
      firstParse = false;
      if (!res.pl.live) return; // VOD: one playlist fetch, then just drain segments
    } else if (firstParse) {
      showBanner(
        `Could not load the playlist (${res.rec.error || "HTTP " + res.rec.status}). ` +
          `If the stream plays fine elsewhere, its server probably does not send CORS ` +
          `headers (Access-Control-Allow-Origin), which this page needs. The Chrome ` +
          `extension does not have this restriction.`
      );
      state.active = state.detectedAt !== null;
      return;
    }
    await sleep(refreshDelayMs(res.pl, advanced));
  }
}

async function startMonitor(url) {
  generation += 1;
  const gen = generation;
  if (abortCtl) abortCtl.abort();
  abortCtl = new AbortController();
  state.active = true;
  state.pageUrl = url;
  $("pageUrl").textContent = url;
  $("pageUrl").title = url;

  const res = await fetchPlaylist(url);
  if (!res || gen !== generation) return;
  if (!res.parsed) {
    showBanner(
      `Could not load the playlist (${res.rec.error || "HTTP " + res.rec.status}). ` +
        `If the stream plays fine elsewhere, its server probably does not send CORS ` +
        `headers (Access-Control-Allow-Origin), which this page needs. The Chrome ` +
        `extension does not have this restriction.`
    );
    return;
  }
  if (res.parsed.isMaster) {
    res.pl.isMaster = true;
    res.pl.variants = res.parsed.variants;
    if (!res.parsed.variants.length) {
      showBanner("Master playlist contains no variants.");
      return;
    }
    const best = [...res.parsed.variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    showVariantPicker(res.parsed.variants, best.url);
    monitorMedia(best.url, gen);
  } else {
    monitorMedia(url, gen, res);
  }
}

function switchVariant(url) {
  // restart cleanly so records from two variants never mix
  generation += 1;
  if (abortCtl) abortCtl.abort();
  abortCtl = new AbortController();
  segQueue.length = 0;
  queuedUrls.clear();
  const keepMaster = Object.values(state.playlists).find((p) => p.isMaster);
  state.playlists = {};
  if (keepMaster) state.playlists[keepMaster.url] = keepMaster;
  state.segments = [];
  state.segMeta = {};
  state.totals = { segments: 0, bytes: 0, errors: 0 };
  hideBanner();
  monitorMedia(url, generation);
}

// ------------------------------------------------------------ dashboard UI

function showBanner(msg) {
  $("banner").textContent = msg;
  $("banner").hidden = false;
}
function hideBanner() {
  $("banner").hidden = true;
}

function showVariantPicker(variants, selectedUrl) {
  const sel = $("variantSel");
  sel.innerHTML = "";
  for (const v of variants) {
    const opt = document.createElement("option");
    opt.value = v.url;
    opt.textContent =
      (v.resolution ? v.resolution + " · " : "") +
      (v.bandwidth ? fmtMbps(v.bandwidth) : shortName(v.url));
    opt.selected = v.url === selectedUrl;
    sel.appendChild(opt);
  }
  $("variantWrap").hidden = false;
  sel.onchange = () => switchVariant(sel.value);
}

function initDashboard() {
  const ttfbChart = new LineChart($("ttfbChart"), {
    color: "--series-1",
    height: 180,
    fmtAxis: (v) => Math.round(v),
    fmtValue: (v) => Math.round(v) + " ms",
  });
  const bpsChart = new LineChart($("bpsChart"), {
    color: "--series-2",
    height: 180,
    fmtAxis: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)),
    fmtValue: (v) => v.toFixed(1) + " Mbps",
  });

  $("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hls-monitor-" + Date.now() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("pauseBtn").addEventListener("click", () => {
    paused = !paused;
    $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  });

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
  onNewSegment = firePulse;

  function refresh() {
    const now = Date.now();
    const stats = computeStats(state.segments, now);
    const status = deriveStatus({ ...state, now }, stats);

    $("status").className = "pill " + status.level;
    $("statusLabel").textContent = status.label;
    $("detail").textContent = status.detail;
    document.title = "HLS Monitor — " + status.label;
    $("segLive").textContent = state.totals.segments;

    $("segCount").textContent = state.totals.segments;
    $("segBytes").textContent = fmtBytes(state.totals.bytes) + " total";
    $("errCount").textContent = state.totals.errors;
    $("errCount").className = "value" + (state.totals.errors > 0 ? " bad" : "");
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

    const media = Object.values(state.playlists).filter((p) => p.isMaster !== true);
    media.sort((a, b) => b.fetchCount - a.fetchCount);
    const main = media[0] || null;
    $("refresh").textContent = main ? fmtMs(medianRefreshMs(main)) : "–";
    $("targetDur").textContent =
      main && main.targetDuration ? "target duration " + main.targetDuration + "s" : "";
    $("mediaSeq").textContent = main && main.mediaSequence !== null ? main.mediaSequence : "–";
    $("seqAge").textContent =
      main && main.lastSeqChangeAt ? "advanced " + fmtAgo(now - main.lastSeqChangeAt) : "";

    const okSegs = state.segments.filter(
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

    renderPlaylists(now);
    renderRequests();
  }

  function renderPlaylists(now) {
    const tbody = $("playlists").querySelector("tbody");
    tbody.innerHTML = "";
    for (const pl of Object.values(state.playlists)) {
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

  function renderRequests() {
    const tbody = $("requests").querySelector("tbody");
    tbody.innerHTML = "";
    const rows = state.segments.slice(-60).reverse();
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

// ------------------------------------------------------------ startup

// Parse the raw hash rather than URLSearchParams: each candidate URL is
// encodeURIComponent-ed exactly once by the launchers, and URLSearchParams
// would add a second decode (and turn literal "+" into spaces).
function candidatesFromHash() {
  const h = location.hash.replace(/^#/, "");
  if (!h.startsWith("src=")) return [];
  return h
    .slice("src=".length)
    .split(",")
    .map((s) => {
      try {
        return decodeURIComponent(s.trim());
      } catch {
        return s.trim();
      }
    })
    .filter(Boolean);
}

window.addEventListener("hashchange", () => location.reload());

const candidates = candidatesFromHash();
if (candidates.length === 1) {
  $("dash").hidden = false;
  initDashboard();
  startMonitor(candidates[0]);
} else {
  $("picker").hidden = false;
  if (candidates.length > 1) {
    $("candidatesWrap").hidden = false;
    const ul = $("candidates");
    for (const c of candidates) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "monitor.html#src=" + encodeURIComponent(c);
      a.textContent = c;
      li.appendChild(a);
      ul.appendChild(li);
    }
  }
  $("srcForm").addEventListener("submit", (e) => {
    e.preventDefault();
    location.hash = "src=" + encodeURIComponent($("srcInput").value.trim());
  });
}
