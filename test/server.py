#!/usr/bin/env python3
"""Fake live HLS origin for testing the HLS Monitor extension.

Serves:
  /                     - a test page with a synthetic HLS player (fetches the
                          playlist on an interval and downloads new segments,
                          the same network pattern hls.js produces)
  /stream/live.m3u8     - a live playlist with a sliding window (like
                          example/master_720p.m3u8, but advancing)
  /stream/seg_N.ts      - dummy segment payloads (~100-300 KB)

Options let you inject failures and latency so the monitor has something to
report:
  --fail-every N    every Nth segment returns HTTP 404
  --slow-every N    every Nth segment is delayed by --slow-ms
"""
import argparse
import random
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SEG_DURATION = 2.0  # seconds per segment (fast, for testing)
WINDOW = 5          # segments per playlist

HERE = Path(__file__).parent
START = time.time()
ARGS = None
SEG_RE = re.compile(r"^/stream/seg_(\d+)\.ts$")


def playlist():
    latest = int((time.time() - START) / SEG_DURATION)
    first = max(0, latest - WINDOW + 1)
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{int(SEG_DURATION)}",
        f"#EXT-X-MEDIA-SEQUENCE:{first}",
    ]
    for n in range(first, latest + 1):
        lines.append(f"#EXTINF:{SEG_DURATION:.5f},")
        lines.append(f"seg_{n}.ts")
    return "\n".join(lines) + "\n"


def segment_bytes(n):
    rnd = random.Random(n)
    size = rnd.randint(100_000, 300_000)
    return rnd.randbytes(size)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("%s %s" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            body = (HERE / "player.html").read_bytes()
            self._send(200, body, "text/html; charset=utf-8")
            return
        if path == "/stream/live.m3u8":
            self._send(200, playlist().encode(), "application/vnd.apple.mpegurl")
            return
        m = SEG_RE.match(path)
        if m:
            n = int(m.group(1))
            if ARGS.fail_every and n > 0 and n % ARGS.fail_every == 0:
                self._send(404, b"segment gone", "text/plain")
                return
            if ARGS.slow_every and n > 0 and n % ARGS.slow_every == 0:
                time.sleep(ARGS.slow_ms / 1000)
            self._send(200, segment_bytes(n), "video/mp2t")
            return
        self._send(404, b"not found", "text/plain")


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--fail-every", type=int, default=0, metavar="N")
    ap.add_argument("--slow-every", type=int, default=0, metavar="N")
    ap.add_argument("--slow-ms", type=int, default=1500)
    ARGS = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"fake HLS origin on http://127.0.0.1:{ARGS.port}/  "
          f"(playlist: /stream/live.m3u8, fail_every={ARGS.fail_every}, "
          f"slow_every={ARGS.slow_every})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
