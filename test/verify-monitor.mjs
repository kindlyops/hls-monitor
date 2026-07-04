// End-to-end check for the standalone monitor page and the launcher snippet.
//
// Starts the fake live HLS origin (server.py) and a static server for site/,
// opens monitor.html pointed at the local live playlist, lets it monitor for
// ~14s, then asserts the recorded metrics and the rendered dashboard. Also
// runs the launcher discovery snippet (launcher.js) inside the synthetic
// player page and asserts it finds the playlist and opens the monitor.
//
//   node test/verify-monitor.mjs
//
// Requires the playwright npm package (a global install is picked up too).

import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// ---------------------------------------------------------- launcher snippet

// Build both variants exactly like ipad.html does.
const launcherSrc = readFileSync(path.join(siteDir, "launcher.js"), "utf8");
const body = launcherSrc.slice(launcherSrc.indexOf("\n(function") + 1);
const fill = (mode) => body.replace("__MONITOR_URL__", MONITOR).replace("__MODE__", mode);

const player = await context.newPage();
await player.goto(`http://127.0.0.1:${ORIGIN_PORT}/`);
await player.waitForTimeout(2500); // let the synthetic player fetch the playlist

console.log("\nlauncher checks:");
const opened = await player.evaluate((code) => {
  const calls = [];
  window.open = (u) => calls.push(u);
  new Function(code)();
  return calls;
}, fill("bookmarklet"));
check(opened.length === 1, "bookmarklet variant opens one tab");
check(
  (opened[0] || "").startsWith(`${MONITOR}#src=`) &&
    decodeURIComponent((opened[0] || "").split("#src=")[1] || "").includes("live.m3u8"),
  `bookmarklet found the playlist (got "${opened[0]}")`
);

const completed = await player.evaluate((code) => {
  let result = null;
  // Shortcuts defines completion() in scope for Run JavaScript on Web Page.
  new Function("completion", code)((v) => (result = v));
  return result;
}, fill("shortcut"));
check(
  (completed || "").startsWith(`${MONITOR}#src=`),
  `shortcut variant hands the monitor URL to completion() (got "${completed}")`
);

// The bookmarklet-encoded form must survive URL-encoding + whitespace collapse.
const encoded = "javascript:" + encodeURIComponent(fill("bookmarklet").replace(/\s+/g, " "));
const decodedRuns = await player.evaluate((href) => {
  const calls = [];
  window.open = (u) => calls.push(u);
  new Function(decodeURIComponent(href.slice("javascript:".length)))();
  return calls.length === 1;
}, encoded);
check(decodedRuns, "whitespace-collapsed javascript: URL still runs");

// End-to-end: the URL the bookmarklet opened renders a working dashboard.
const opened2 = await context.newPage();
await opened2.goto(opened[0]);
await opened2.waitForTimeout(6000);
const segCount2 = await opened2.locator("#segCount").textContent();
check(Number(segCount2) >= 1, `bookmarklet-opened monitor records segments (got "${segCount2}")`);

await browser.close();
origin.kill();
site.kill();

if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
