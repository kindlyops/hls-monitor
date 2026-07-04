// HLS Monitor - background service worker.
//
// Observes network traffic via chrome.webRequest, classifies HLS playlist and
// media-segment requests per tab, and records timing (TTFB, download time),
// size, throughput, status, cache state, and errors for each one. Playlists
// are additionally re-fetched (throttled) and parsed so we know the target
// duration, media sequence, and each segment's media duration - which lets
// the UI compute "download speed vs realtime" and detect origin stalls.

const MAX_SEGMENTS = 600; // rolling window of request records kept per tab
const MAX_PLAYLIST_FETCHES = 120; // refresh history kept per playlist URL
const PARSE_THROTTLE_MS = 1500; // min gap between our own playlist re-fetches
const SAVE_DEBOUNCE_MS = 1000;

const PLAYLIST_RE = /\.m3u8($|[?#])/i;
const SEGMENT_RE = /\.(ts|m4s|mp4|m4a|m4v|aac|ac3|ec3|vtt|webvtt|cmfv|cmfa|cmft)($|[?#])/i;
const REQUEST_TYPES = ["xmlhttprequest", "media", "other", "object"];

// tabId -> tab state. Rebuilt from chrome.storage.session when the worker
// restarts, since MV3 workers are torn down when idle.
const state = { tabs: {} };
// requestId -> in-flight request record (transient, not persisted).
const pending = new Map();

let settings = { parsePlaylists: true };
chrome.storage.local.get("settings").then((r) => {
  if (r.settings) settings = Object.assign(settings, r.settings);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settings = Object.assign(settings, changes.settings.newValue);
  }
});

const restored = chrome.storage.session.get("hlsState").then((r) => {
  const old = r.hlsState;
  if (!old || !old.tabs) return;
  for (const [tabId, oldTab] of Object.entries(old.tabs)) {
    const cur = state.tabs[tabId];
    if (!cur) {
      state.tabs[tabId] = oldTab;
    } else {
      // Events arrived before restore finished: keep the fresh records and
      // prepend the persisted history.
      cur.segments = oldTab.segments
        .concat(cur.segments)
        .slice(-MAX_SEGMENTS);
      for (const [url, pl] of Object.entries(oldTab.playlists)) {
        if (!cur.playlists[url]) cur.playlists[url] = pl;
      }
      cur.totals.segments += oldTab.totals.segments;
      cur.totals.bytes += oldTab.totals.bytes;
      cur.totals.errors += oldTab.totals.errors;
      cur.detectedAt = oldTab.detectedAt || cur.detectedAt;
    }
  }
}).catch(() => {});

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ hlsState: state }).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

function getTab(tabId) {
  let t = state.tabs[tabId];
  if (!t) {
    t = state.tabs[tabId] = {
      tabId,
      detectedAt: null,
      pageUrl: null,
      // playlist URL -> health record (refresh cadence, media sequence, ...)
      playlists: {},
      // rolling list of completed request records (segments + playlists)
      segments: [],
      // resolved segment URL -> media duration in seconds (from EXTINF)
      segMeta: {},
      totals: { segments: 0, bytes: 0, errors: 0 },
    };
  }
  return t;
}

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

function classify(details) {
  if (PLAYLIST_RE.test(details.url)) return "playlist";
  const tab = state.tabs[details.tabId];
  if (!tab || !tab.detectedAt) return null; // only track segments once a playlist was seen
  if (tab.segMeta[stripFragment(details.url)] !== undefined) return "segment";
  if (SEGMENT_RE.test(details.url)) return "segment";
  return null;
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return; // ignore our own fetches and other non-tab traffic
    const kind = classify(d);
    if (!kind) return;
    pending.set(d.requestId, {
      kind,
      tabId: d.tabId,
      url: d.url,
      start: d.timeStamp,
      ttfbMs: null,
      status: null,
      fromCache: false,
      ip: null,
    });
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES }
);

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    const rec = pending.get(d.requestId);
    if (!rec) return;
    rec.ttfbMs = Math.max(0, d.timeStamp - rec.start);
    rec.status = d.statusCode;
    rec.fromCache = !!d.fromCache;
    rec.ip = d.ip || null;
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES }
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    const rec = pending.get(d.requestId);
    if (!rec) return;
    pending.delete(d.requestId);
    rec.status = d.statusCode;
    rec.fromCache = !!d.fromCache;
    let bytes = null;
    for (const h of d.responseHeaders || []) {
      if (h.name.toLowerCase() === "content-length") {
        const n = parseInt(h.value, 10);
        if (!Number.isNaN(n)) bytes = n;
        break;
      }
    }
    finalize(rec, { end: d.timeStamp, bytes, error: null });
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    const rec = pending.get(d.requestId);
    if (!rec) return;
    pending.delete(d.requestId);
    finalize(rec, { end: d.timeStamp, bytes: null, error: d.error });
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES }
);

function finalize(rec, { end, bytes, error }) {
  const tab = getTab(rec.tabId);
  const url = stripFragment(rec.url);
  const totalMs = Math.max(0, end - rec.start);
  const record = {
    kind: rec.kind,
    url: rec.url,
    name: shortName(rec.url),
    start: rec.start,
    end,
    ttfbMs: rec.ttfbMs,
    totalMs,
    downloadMs: rec.ttfbMs !== null ? Math.max(0, totalMs - rec.ttfbMs) : null,
    bytes,
    status: rec.status,
    fromCache: rec.fromCache,
    ip: rec.ip,
    error: error || null,
    mediaDur: rec.kind === "segment" ? tab.segMeta[url] ?? null : null,
  };
  const failed = !!error || (record.status !== null && record.status >= 400);
  tab.segments.push(record);
  if (tab.segments.length > MAX_SEGMENTS) {
    tab.segments.splice(0, tab.segments.length - MAX_SEGMENTS);
  }
  if (rec.kind === "segment") {
    tab.totals.segments += 1;
    if (bytes) tab.totals.bytes += bytes;
  }
  if (failed) tab.totals.errors += 1;

  if (rec.kind === "playlist") {
    if (!tab.detectedAt) tab.detectedAt = rec.start;
    recordPlaylistFetch(tab, url, record, failed);
  }
  updateBadge(rec.tabId, tab);
  scheduleSave();
}

function recordPlaylistFetch(tab, url, record, failed) {
  let pl = tab.playlists[url];
  if (!pl) {
    pl = tab.playlists[url] = {
      url,
      name: shortName(url),
      firstSeen: record.start,
      lastFetchStart: null,
      fetchCount: 0,
      errorCount: 0,
      refreshMs: [], // gaps between consecutive fetches by the page
      isMaster: null,
      live: null,
      targetDuration: null,
      mediaSequence: null,
      lastSeqChangeAt: null,
      lastParseAt: 0,
      lastParseError: null,
      segmentCount: null,
    };
  }
  if (pl.lastFetchStart !== null) {
    pl.refreshMs.push(record.start - pl.lastFetchStart);
    if (pl.refreshMs.length > MAX_PLAYLIST_FETCHES) {
      pl.refreshMs.splice(0, pl.refreshMs.length - MAX_PLAYLIST_FETCHES);
    }
  }
  pl.lastFetchStart = record.start;
  pl.fetchCount += 1;
  if (failed) pl.errorCount += 1;
  else maybeParsePlaylist(tab, pl);
}

// Re-fetch the playlist ourselves to read its body (webRequest cannot see
// response bodies). Throttled, and follows the page's own refresh cadence.
async function maybeParsePlaylist(tab, pl) {
  if (!settings.parsePlaylists) return;
  const t = Date.now();
  if (t - pl.lastParseAt < PARSE_THROTTLE_MS) return;
  pl.lastParseAt = t;
  let text;
  try {
    const resp = await fetch(pl.url, { cache: "no-store", credentials: "omit" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    text = await resp.text();
  } catch (e) {
    pl.lastParseError = String(e && e.message ? e.message : e);
    return;
  }
  pl.lastParseError = null;
  applyParsedPlaylist(tab, pl, parsePlaylist(text, pl.url));
  scheduleSave();
}

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

function applyParsedPlaylist(tab, pl, parsed) {
  pl.isMaster = parsed.isMaster;
  if (parsed.isMaster) {
    pl.variants = parsed.variants;
    return;
  }
  pl.live = !parsed.endlist;
  if (parsed.targetDuration !== null) pl.targetDuration = parsed.targetDuration;
  pl.segmentCount = parsed.segs.length;
  const lastUri = parsed.segs.length
    ? parsed.segs[parsed.segs.length - 1].url
    : null;
  const advanced =
    (parsed.mediaSequence !== null && parsed.mediaSequence !== pl.mediaSequence) ||
    (lastUri && lastUri !== pl.lastSegmentUri);
  if (advanced || pl.lastSeqChangeAt === null) {
    pl.lastSeqChangeAt = Date.now();
  }
  if (parsed.mediaSequence !== null) pl.mediaSequence = parsed.mediaSequence;
  pl.lastSegmentUri = lastUri;

  // Rebuild segment metadata from the live windows of all known media
  // playlists so segMeta tracks the sliding window instead of growing forever.
  for (const seg of parsed.segs) {
    tab.segMeta[seg.url] = seg.duration;
  }
  const keys = Object.keys(tab.segMeta);
  if (keys.length > 2000) {
    for (const k of keys.slice(0, keys.length - 2000)) delete tab.segMeta[k];
  }

  // Backfill durations onto records that completed before the first parse
  // (the player fetches its first segments in parallel with our re-fetch).
  for (const r of tab.segments) {
    if (r.kind === "segment" && r.mediaDur === null) {
      const d = tab.segMeta[stripFragment(r.url)];
      if (d !== undefined) r.mediaDur = d;
    }
  }
}

function updateBadge(tabId, tab) {
  const errors = tab.totals.errors;
  const text = errors > 0 ? String(Math.min(errors, 999)) : tab.detectedAt ? "HLS" : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ tabId, color: errors > 0 ? "#d03b3b" : "#0ca30c" })
    .catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.tabs[tabId];
  scheduleSave();
});

// Reset a tab's data when it navigates to a different page, so stats never
// mix two different streams.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const tab = state.tabs[tabId];
  if (!tab) return;
  if (changeInfo.url && tab.pageUrl && changeInfo.url !== tab.pageUrl) {
    delete state.tabs[tabId];
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    scheduleSave();
  } else if (changeInfo.url) {
    tab.pageUrl = changeInfo.url;
  }
});

function summarize(tabId) {
  const tab = state.tabs[tabId];
  if (!tab) return { tabId, active: false };
  return { active: true, now: Date.now(), ...tab };
}

function listStreams() {
  const out = [];
  for (const [tabId, tab] of Object.entries(state.tabs)) {
    if (!tab.detectedAt) continue;
    out.push({
      tabId: Number(tabId),
      pageUrl: tab.pageUrl,
      playlists: Object.keys(tab.playlists),
      segments: tab.totals.segments,
      errors: tab.totals.errors,
    });
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  restored.then(async () => {
    switch (msg && msg.type) {
      case "getState": {
        const tab = state.tabs[msg.tabId];
        if (tab && !tab.pageUrl) {
          try {
            const t = await chrome.tabs.get(msg.tabId);
            tab.pageUrl = t.url || null;
          } catch {}
        }
        sendResponse(summarize(msg.tabId));
        break;
      }
      case "listStreams":
        sendResponse(listStreams());
        break;
      case "clear":
        delete state.tabs[msg.tabId];
        chrome.action.setBadgeText({ tabId: msg.tabId, text: "" }).catch(() => {});
        scheduleSave();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse(null);
    }
  });
  return true; // async sendResponse
});

// Test/debug hook: lets automated checks read the raw state.
globalThis.__hlsMonitorState = state;
