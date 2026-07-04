// HLS stream discovery snippet. This file is the single source for both
// launchers: ipad.html fetches this text, substitutes __MONITOR_URL__, and
// renders it as a bookmarklet and as the code to paste into an Apple
// Shortcuts "Run JavaScript on Web Page" action.
//
// It runs inside the page currently playing the stream. Two lookups:
// Resource Timing catches everything MSE players fetch (even behind blob:
// video srcs), and video/source elements catch native HLS playback, which
// Resource Timing does not record. __MODE__ becomes "shortcut" (hand the
// monitor URL to the Shortcut's completion() for its Open URLs action) or
// "bookmarklet" (open the tab directly).
//
// No line comments or template literals below this header: the IIFE (from
// the first line starting with "(function") is whitespace-collapsed into a
// javascript: URL.
(function () {
  var monitor = "__MONITOR_URL__";
  var mode = "__MODE__";
  var found = {};
  function add(u) {
    if (!u) return;
    try {
      u = new URL(u, location.href).href;
    } catch (e) {
      return;
    }
    if (/\.m3u8($|[?#])/i.test(u)) found[u] = 1;
  }
  performance.getEntriesByType("resource").forEach(function (e) {
    add(e.name);
  });
  document.querySelectorAll("video,source").forEach(function (el) {
    add(el.currentSrc || el.src);
  });
  var list = Object.keys(found);
  var target = list.length
    ? monitor + "#src=" + list.map(encodeURIComponent).join(",")
    : monitor;
  if (mode === "shortcut") {
    completion(target);
    return;
  }
  if (!list.length) {
    alert("HLS Monitor: no .m3u8 URL seen on this page yet. Start playback, then try again.");
    return;
  }
  window.open(target);
})();
