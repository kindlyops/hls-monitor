// Shared helpers for popup and panel UIs.

export function fmtBytes(n) {
  if (n === null || n === undefined) return "–";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

export function fmtMbps(bitsPerSec) {
  if (bitsPerSec === null || bitsPerSec === undefined) return "–";
  if (bitsPerSec < 1e6) return (bitsPerSec / 1e3).toFixed(0) + " kbps";
  return (bitsPerSec / 1e6).toFixed(1) + " Mbps";
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

export function fmtAgo(ms) {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return "just now";
  if (ms < 60000) return Math.round(ms / 1000) + "s ago";
  if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
  return Math.round(ms / 3600000) + "h ago";
}

export function fmtClock(t) {
  const d = new Date(t);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

export function throughputBps(rec) {
  if (!rec.bytes || !rec.totalMs) return null;
  return (rec.bytes * 8) / (rec.totalMs / 1000);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Aggregate stats over the completed, successful segment records.
export function computeStats(records, now) {
  const segs = records.filter((r) => r.kind === "segment");
  const ok = segs.filter((r) => !r.error && r.status && r.status < 400);
  const failed = segs.length - ok.length;
  const ttfbs = ok.map((r) => r.ttfbMs).filter((v) => v !== null).sort((a, b) => a - b);
  const bps = ok.map(throughputBps).filter((v) => v !== null).sort((a, b) => a - b);
  const speeds = ok
    .filter((r) => r.mediaDur && r.totalMs)
    .map((r) => (r.mediaDur * 1000) / r.totalMs)
    .sort((a, b) => a - b);
  const last = ok.length ? ok[ok.length - 1] : null;
  const lastSegAge = last ? now - last.end : null;
  return {
    count: segs.length,
    okCount: ok.length,
    failed,
    ttfbAvg: ttfbs.length ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length : null,
    ttfbP95: quantile(ttfbs, 0.95),
    bpsAvg: bps.length ? bps.reduce((a, b) => a + b, 0) / bps.length : null,
    bpsMin: bps.length ? bps[0] : null,
    speedAvg: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
    speedMin: speeds.length ? speeds[0] : null,
    last,
    lastSegAge,
  };
}

// Derive an overall status for the stream in a tab.
// Returns { level: good|warning|serious|critical|idle, label, detail }
export function deriveStatus(tabState, stats) {
  if (!tabState || !tabState.active || !tabState.detectedAt) {
    return { level: "idle", label: "No stream", detail: "No HLS traffic seen in this tab yet." };
  }
  const now = tabState.now;
  const media = Object.values(tabState.playlists).filter((p) => p.isMaster === false);
  const live = media.some((p) => p.live);
  const target = Math.max(0, ...media.map((p) => p.targetDuration || 0)) || null;

  const recent = tabState.segments.slice(-8);
  const recentErrors = recent.filter((r) => r.error || (r.status && r.status >= 400));
  if (recentErrors.length >= 3) {
    return {
      level: "critical",
      label: "Failing",
      detail: recentErrors.length + " of the last " + recent.length + " requests failed.",
    };
  }

  if (live && target) {
    const stalled = media.filter(
      (p) => p.live && p.lastSeqChangeAt && now - p.lastSeqChangeAt > Math.max(3 * target * 1000, 10000)
    );
    if (stalled.length) {
      return {
        level: "critical",
        label: "Stalled",
        detail:
          "Playlist not advancing for " + fmtMs(now - stalled[0].lastSeqChangeAt) +
          " (target duration " + target + "s). Origin may have stopped.",
      };
    }
    if (stats.lastSegAge !== null && stats.lastSegAge > Math.max(2.5 * target * 1000, 8000)) {
      return {
        level: "serious",
        label: "No segments",
        detail: "No segment downloaded for " + fmtMs(stats.lastSegAge) + ".",
      };
    }
  }

  if (recentErrors.length > 0) {
    return { level: "warning", label: "Errors", detail: "Recent request errors detected." };
  }
  if (stats.speedAvg !== null && stats.speedAvg < 1.2) {
    return {
      level: "warning",
      label: "Slow",
      detail:
        "Segments download at " + stats.speedAvg.toFixed(1) +
        "x realtime on average - little headroom before rebuffering.",
    };
  }
  return {
    level: "good",
    label: live ? "Live, healthy" : "Healthy",
    detail: live ? "Playlist advancing, segments downloading normally." : "Segments downloading normally.",
  };
}

export function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

export function medianRefreshMs(pl) {
  if (!pl.refreshMs || !pl.refreshMs.length) return null;
  const s = [...pl.refreshMs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
