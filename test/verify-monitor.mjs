// End-to-end check for the standalone monitor page.
//
// Starts the fake live HLS origin (server.py) and a static server for site/,
// opens monitor.html pointed at the local live playlist, lets it monitor for
// ~14s, then asserts the recorded metrics and the rendered dashboard.
//
//   node test/verify-monitor.mjs
//
// Requires the playwright npm package (a global install is picked up too).

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const globalRoot = execSync("npm root -g").toString().trim();
    return await import(pathToFileURL(path.join(globalRoot, "playwright", "index.mjs")).href);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, "..", "site");
const ORIGIN_PORT = 8765;
const SITE_PORT = 8766;
const PLAYLIST = `http://127.0.0.1:${ORIGIN_PORT}/stream/live.m3u8`;
const MONITOR = `http://127.0.0.1:${SITE_PORT}/monitor.html`;

const { chromium } = await loadPlaywright();

const origin = spawn(
  "python3",
  [path.join(here, "server.py"), "--port", String(ORIGIN_PORT), "--fail-every", "5"],
  { stdio: "inherit" }
);
const site = spawn("python3", ["-m", "http.server", String(SITE_PORT), "-d", siteDir], {
  stdio: "ignore",
});
process.on("exit", () => {
  origin.kill();
  site.kill();
});
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

const failures = [];
const check = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) failures.push(msg);
};

// ---------------------------------------------------------- monitor page

const page = await context.newPage();
await page.goto(`${MONITOR}#src=${encodeURIComponent(PLAYLIST)}`);
console.log("monitor page open, monitoring for 14s...");
await page.waitForTimeout(14_000);

const state = await page.evaluate(() =>
  JSON.parse(JSON.stringify(globalThis.__hlsMonitorState))
);

console.log("\nmonitor state checks:");
const segs = state.segments.filter((r) => r.kind === "segment");
const pls = state.segments.filter((r) => r.kind === "playlist");
const okSegs = segs.filter((r) => !r.error && r.status === 200);
// the monitor polls at the HLS spec cadence (target duration = 2s here)
check(pls.length >= 6, `>=6 playlist fetches recorded (got ${pls.length})`);
check(okSegs.length >= 4, `>=4 successful segments recorded (got ${okSegs.length})`);
check(okSegs.every((r) => r.ttfbMs !== null && r.ttfbMs >= 0), "every segment has TTFB");
check(okSegs.every((r) => r.totalMs >= r.ttfbMs), "totalMs >= ttfbMs");
check(okSegs.every((r) => r.bytes >= 100_000 && r.bytes <= 300_000), "segment sizes measured from body");
check(okSegs.every((r) => r.mediaDur === 2), "segment media duration parsed from playlist (2s)");
check(segs.some((r) => r.status === 404), "injected 404 segment captured");
check(state.totals.errors >= 1, `error total counted (got ${state.totals.errors})`);

const pl = Object.values(state.playlists)[0] || {};
check(pl.isMaster === false && pl.live === true, "playlist parsed as live media playlist");
check(pl.targetDuration === 2, `target duration parsed (got ${pl.targetDuration})`);
check(Number.isInteger(pl.mediaSequence) && pl.mediaSequence > 0, `media sequence tracked (got ${pl.mediaSequence})`);
check(pl.refreshMs.length >= 4, `playlist refresh cadence tracked (${pl.refreshMs.length} intervals)`);

console.log("\ndashboard checks:");
const segCount = await page.locator("#segCount").textContent();
const statusLabel = await page.locator("#statusLabel").textContent();
const ttfbTile = await page.locator("#ttfb").textContent();
check(Number(segCount) >= 4, `dashboard shows segment count (got "${segCount}")`);
check(/ms/.test(ttfbTile), `dashboard shows TTFB (got "${ttfbTile}")`);
check(statusLabel.length > 1 && statusLabel !== "–", `dashboard status derived (got "${statusLabel}")`);

const shot = path.join(here, "..", "monitor.png");
await page.screenshot({ path: shot, fullPage: true });
console.log("\nmonitor screenshot:", shot);

await browser.close();
origin.kill();
site.kill();

if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
