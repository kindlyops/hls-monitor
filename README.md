# hls-monitor

A Chrome extension for monitoring the performance and availability of HLS
video livestreams playing in the browser. It watches the network traffic a
player (hls.js, video.js, Shaka, etc.) produces and records, for every
playlist and media-segment request:

- **TTFB** (time to first byte) and **download time**
- **size** (from `Content-Length`) and **throughput**
- **HTTP status**, **cache hits**, **server IP**, and **network errors**
- **download speed vs realtime** — how much faster than its media duration
  each segment downloads (below ~1× means imminent rebuffering)

It also re-fetches and parses the playlists themselves to track **playlist
refresh cadence**, **target duration**, and **media sequence advancement**,
so it can tell you when a live stream has *stalled at the origin* (playlist
stops advancing) versus *failing to download* (segment errors) versus
*slowing down* (shrinking download headroom).

## Install

### Chrome on desktop (Windows, Mac, Linux, ChromeOS)

1. Download the extension ZIP from the
   [latest release](https://github.com/kindlyops/hls-monitor/releases/latest)
   and unzip it. (Or clone this repo and use its `extension/` folder —
   same thing.)
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the unzipped folder.
5. Done. Open any page playing an HLS stream — the toolbar badge turns
   green with `HLS` when a stream is detected, or shows a red error count
   if segment requests are failing. Click the icon for details.

The same steps work in other desktop Chromium browsers (Edge, Brave, Opera,
Vivaldi) via their own extensions page.

### Chrome on mobile

Chrome for Android and iOS **does not support extensions**, so HLS Monitor
cannot be installed in mobile Chrome itself.

- **Android**: use a Chromium-based browser that supports extensions — for
  example **Microsoft Edge Canary** or **Lemur Browser**. Enable developer
  mode on its extensions page and load the same release ZIP.
- **iOS/iPadOS**: there is currently no way to run Chrome extensions on
  iOS. Monitor a stream from a desktop browser instead.

### Releases

Every merge to `main` that changes `extension/` automatically publishes a
new GitHub Release: the workflow patch-bumps the latest version tag (e.g.
`v0.1.3` → `v0.1.4`, starting at `v0.1.0`), stamps the version into
`manifest.json`, and attaches the installable ZIP.

For a minor or major bump, run the **Release extension** workflow manually
from the Actions tab and enter the version (e.g. `0.3.0`).

## Use

- **Popup** (click the toolbar icon): at-a-glance health of the stream in the
  active tab — status, segment count, errors, average TTFB/throughput,
  download speed, and last-segment age.
- **Side panel** (popup → *Open side panel*): the dashboard docked next to
  the player page, so you can watch the livestream and its metrics at the
  same time. It follows the active tab, and its header has a live segment
  counter with a pulse animation that fires each time a new video segment
  arrives.
- **Full dashboard** (popup → *Full dashboard*): the same view as a full
  page — live charts of per-segment TTFB and throughput, playlist health
  (refresh cadence, media sequence, advancement), a table of recent
  requests, the segment-arrival pulse, and **Export JSON** for offline
  analysis. Opening `panel.html` without a `?tab=` parameter lists all tabs
  with detected streams.

Status levels: **Live, healthy** → **Slow** (average download speed under
1.2× realtime) → **Errors** → **No segments** / **Stalled** / **Failing**.

The *parse playlists* toggle controls whether the extension re-fetches
playlists to read their bodies (needed for target duration, media sequence,
and per-segment durations). It is throttled to the player's own refresh
cadence; turn it off if you don't want the extra origin requests.

## Website

The landing page is served with GitHub Pages at
**<https://kindlyops.github.io/hls-monitor/>** (deployed automatically from
`site/` on every push to `main` by `.github/workflows/pages.yml`).

`site/` is a three.js landing page for the extension: a broadcast tower
streams video frames along a glowing pipeline while the Inspector — a
certain consulting detective — examines each one with his magnifying glass.
Good segments earn a `✓ 200 OK` and land in a floating browser window; bad
ones are flagged `✗ 404` and ejected. The stream continues on to a retro TV
watched by an old man on his couch, and a live HUD tallies segments
inspected, delivered, and flagged.

The page is fully self-contained (three.js is vendored), so any static file
server works:

```sh
python3 -m http.server 8899 -d site
# then open http://127.0.0.1:8899/
```

## Test drive locally

`test/server.py` is a fake live HLS origin (sliding-window playlist like
`example/master_720p.m3u8`, advancing every 2s) plus a synthetic player page
that fetches playlists and segments exactly like a real player:

```sh
python3 test/server.py                    # healthy stream
python3 test/server.py --fail-every 5     # every 5th segment 404s
python3 test/server.py --slow-every 4 --slow-ms 1500   # inject latency
```

Then open <http://127.0.0.1:8765/> in Chrome with the extension loaded.

## Automated end-to-end check

```sh
node test/verify.mjs
```

Starts the fake origin, loads the extension into headless Chromium via
Playwright, streams for ~14s, asserts the recorded metrics (TTFB, sizes,
parsed durations, media-sequence tracking, injected 404s), and screenshots
the dashboard to `dashboard.png`.
