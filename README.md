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

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` directory of this repo.
3. Open a page playing an HLS stream. The toolbar badge shows `HLS` (green)
   once a stream is detected, or a red error count if requests are failing.

## Use

- **Popup** (click the toolbar icon): at-a-glance health of the stream in the
  active tab — status, segment count, errors, average TTFB/throughput,
  download speed, and last-segment age.
- **Dashboard** (popup → *Open dashboard*): live charts of per-segment TTFB
  and throughput, playlist health (refresh cadence, media sequence,
  advancement), a table of recent requests, and **Export JSON** for offline
  analysis. Opening `panel.html` without a `?tab=` parameter lists all tabs
  with detected streams.

Status levels: **Live, healthy** → **Slow** (average download speed under
1.2× realtime) → **Errors** → **No segments** / **Stalled** / **Failing**.

The *parse playlists* toggle controls whether the extension re-fetches
playlists to read their bodies (needed for target duration, media sequence,
and per-segment durations). It is throttled to the player's own refresh
cadence; turn it off if you don't want the extra origin requests.

## Website

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
