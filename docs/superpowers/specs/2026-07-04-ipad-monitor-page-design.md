# iPad monitoring: standalone monitor page + one-tap launchers

## Problem

Chrome extensions do not run on iPad (every iPadOS browser is a WebKit
wrapper). We want HLS stream health monitoring from an iPad browser, with an
easily discoverable install path on the website.

## Decision

Add a standalone **monitor page** to the GitHub Pages site that measures a
stream's delivery health itself, plus two zero-backend launchers that discover
the stream URL on whatever page is currently playing it and open the monitor:

1. an **Apple Shortcuts** share-sheet action (primary iPad path), and
2. a **bookmarklet** (fallback on iPad, zero-install on desktop).

Cross-origin iframes are explicitly out of scope (launchers only see the top
frame).

## Monitor page (`site/monitor.html` + `site/monitor.js`)

A synthetic player, not an hls.js player. Rationale: the extension measures
network delivery, never decoded video, so the monitor page does the same —
fetch the playlist on the spec cadence, fetch each new segment, and time
everything. This avoids a ~500 KB vendored dependency, works without MSE
(iPhone Safari included), and works against `test/server.py`, whose dummy
segments are not decodable media. It is the same network pattern as
`test/player.html`.

Behavior:

- Input: `#src=<url>[,<url>...]` (URL-encoded, comma-separated). Multiple
  candidates render a picker; none renders a paste box. Hash (not query)
  keeps stream URLs out of server logs.
- Master playlists: parse variants, auto-select the highest bandwidth, offer
  a variant switcher. Media playlists: monitor directly.
- Live playlists refresh per the HLS spec cadence (target duration when the
  playlist advanced, half when unchanged, clamped to 0.5–10 s). New segments
  are fetched sequentially (one at a time, so throughput numbers are clean).
  On first parse of a live playlist only the last 2 segments are fetched, to
  mimic a player joining at the live edge. VOD playlists fetch all segments
  sequentially.
- Each fetch records the same shape the extension records: kind, status,
  bytes (actual bytes streamed), TTFB (headers-received time), download and
  total time, media duration from `#EXTINF`, error string on failure.
- Dashboard identical to the extension panel: status pill from
  `deriveStatus`, tiles, TTFB/throughput charts, playlists table, recent
  requests table, segment-arrival pulse, export JSON, clear. The cache
  column is dropped (unknowable from `fetch()`).
- Requires CORS on the stream origin (same requirement hls.js has). A
  failed playlist fetch shows an actionable error that names CORS as the
  likely cause.

Code reuse: `site/common.js`, `site/charts.js`, `site/ui.css` are copies of
the extension files (marked "keep in sync"; `sendMessage` dropped from
common.js). The playlist parser is lifted from `extension/background.js`.
The site stays no-build, so copying beats introducing a bundler; revisit if
a third consumer appears.

## Launchers

Discovery code (shared verbatim between bookmarklet and Shortcut): collect
`.m3u8` URLs from `performance.getEntriesByType("resource")` (catches all
MSE players even behind `blob:` URLs) and from `video`/`source` element
`src`/`currentSrc` (catches native HLS playback, which resource timing does
not record), resolve relative URLs, dedupe, then open
`monitor.html#src=<encoded list>`. If nothing is found, alert with a hint to
start playback first.

- **Bookmarklet**: rendered on the site with the monitor URL computed from
  `location`, so a locally served site produces a locally pointing
  bookmarklet. Draggable link for desktop, copy button + edit-a-bookmark
  steps for iPad.
- **Shortcut**: three actions — Run JavaScript on Web Page (discovery code,
  `completion()` returns the encoded candidate list), URL
  (`.../monitor.html#src=` + result), Open URLs. iCloud shortcut links can
  only be minted by sharing from the Shortcuts app, so the site documents
  the 2-minute build until a shared iCloud link is dropped in.

Known limitation (documented): the resource-timing buffer holds 250 entries
by default; on long-lived pages the earliest entries win, but playlist
refreshes recur so this rarely matters, and the video-tag fallback covers
native playback.

## Website discoverability

- `site/ipad.html`: plain install page — Shortcut section first, bookmarklet
  second, "or paste a URL into the monitor" last.
- `site/index.html` hero gains two buttons: "Live monitor" → monitor.html and
  "iPad & mobile" → ipad.html.
- README: mobile section rewritten to point at the monitor page and
  ipad.html; new section describing the monitor page and bookmarklet.

## Testing

`test/verify-monitor.mjs` (Playwright, mirrors `verify.mjs`): starts
`server.py --fail-every 5` and a static server for `site/`, opens
`monitor.html#src=<local live playlist>`, waits ~14 s, asserts: segments and
playlist fetches recorded with TTFB/bytes/durations, injected 404 captured,
status pill derived, media sequence advancing, charts populated. Also loads
the synthetic player page, runs the bookmarklet discovery code in it, and
asserts it finds the playlist URL.

## Out of scope

- Cross-origin iframe discovery (needs an extension).
- Playback preview, ABR simulation, decode-level checks.
- Any backend; everything remains static files on GitHub Pages.
