// End-to-end check for the HLS Monitor extension.
//
// Starts the fake live HLS origin (server.py), loads the extension into
// Chromium, opens the synthetic player page, lets it stream for ~10s, then
// asserts that the extension's service worker recorded playlist + segment
// metrics, and screenshots the dashboard.
//
//   node test/verify.mjs
//
// Requires the playwright npm package (a global install is picked up too).

import { spawn, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
const extDir = path.resolve(here, "..", "extension");
const PORT = 8765;

const { chromium } = await loadPlaywright();

const server = spawn("python3", [path.join(here, "server.py"), "--port", String(PORT), "--fail-every", "5"], {
  stdio: "inherit",
});
process.on("exit", () => server.kill());
await new Promise((r) => setTimeout(r, 700));

const profile = mkdtempSync(path.join(tmpdir(), "hlsmon-profile-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", // new headless supports extensions
  headless: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
console.log("extension loaded:", extId);

const page = await context.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);
console.log("player page open, streaming for 14s...");
await page.waitForTimeout(14_000);

const state = await sw.evaluate(() => {
  const tabs = Object.values(globalThis.__hlsMonitorState.tabs);
  return JSON.parse(JSON.stringify(tabs));
});

const failures = [];
const check = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) failures.push(msg);
};

console.log("\nservice worker state checks:");
check(state.length === 1, "one monitored tab");
const tab = state[0] || { segments: [], playlists: {}, totals: {} };
const segs = tab.segments.filter((r) => r.kind === "segment");
const pls = tab.segments.filter((r) => r.kind === "playlist");
const okSegs = segs.filter((r) => !r.error && r.status === 200);
check(pls.length >= 8, `>=8 playlist fetches recorded (got ${pls.length})`);
check(okSegs.length >= 4, `>=4 successful segments recorded (got ${okSegs.length})`);
check(okSegs.every((r) => r.ttfbMs !== null && r.ttfbMs >= 0), "every segment has TTFB");
check(okSegs.every((r) => r.totalMs >= r.ttfbMs), "totalMs >= ttfbMs");
check(okSegs.every((r) => r.bytes >= 100_000 && r.bytes <= 300_000), "segment sizes from Content-Length");
check(okSegs.every((r) => r.mediaDur === 2), "segment media duration parsed from playlist (2s)");
check(segs.some((r) => r.status === 404), "injected 404 segment captured");
check(tab.totals.errors >= 1, `error total counted (got ${tab.totals.errors})`);

const pl = Object.values(tab.playlists)[0] || {};
check(pl.isMaster === false && pl.live === true, "playlist parsed as live media playlist");
check(pl.targetDuration === 2, `target duration parsed (got ${pl.targetDuration})`);
check(Number.isInteger(pl.mediaSequence) && pl.mediaSequence > 0, `media sequence tracked (got ${pl.mediaSequence})`);
check(pl.refreshMs.length >= 5, `playlist refresh cadence tracked (${pl.refreshMs.length} intervals)`);

// dashboard renders
const tabId = tab.tabId;
const panel = await context.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html?tab=${tabId}`);
await panel.waitForTimeout(1500);
const segCount = await panel.locator("#segCount").textContent();
const statusLabel = await panel.locator("#statusLabel").textContent();
const ttfbTile = await panel.locator("#ttfb").textContent();
console.log("\ndashboard checks:");
check(Number(segCount) >= 4, `dashboard shows segment count (got "${segCount}")`);
check(/ms/.test(ttfbTile), `dashboard shows TTFB (got "${ttfbTile}")`);
check(statusLabel.length > 1 && statusLabel !== "–", `dashboard status derived (got "${statusLabel}")`);

const shot = path.join(here, "..", "dashboard.png");
await panel.screenshot({ path: shot, fullPage: true });
console.log("\ndashboard screenshot:", shot);

// side panel (compact mode): follows the active tab, pulses on new segments
const side = await context.newPage();
await side.setViewportSize({ width: 380, height: 950 });
await side.goto(`chrome-extension://${extId}/sidepanel.html`);
await page.bringToFront(); // side panel should follow the active (player) tab
await side.waitForTimeout(5000);
const live1 = Number(await side.locator("#segLive").textContent());
await side.waitForTimeout(3000);
const live2 = Number(await side.locator("#segLive").textContent());
const pulsed = await side.evaluate(() =>
  document.getElementById("segPulse").classList.contains("pulse")
);
console.log("\nside panel checks:");
check(live1 > 0, `side panel follows active tab, shows segment counter (got ${live1})`);
check(live2 > live1, `segment counter increments live (${live1} -> ${live2})`);
check(pulsed, "segment-arrival pulse fired");
const sideShot = path.join(here, "..", "sidepanel.png");
await side.screenshot({ path: sideShot });
console.log("side panel screenshot:", sideShot);

await context.close();
server.kill();

if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
