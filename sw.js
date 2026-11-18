/* Golden Rule voice tools — service worker (registered by gr-common.js).
 * Lets every page open with no signal once it has been opened once.
 *  • Pages (.html), config.js, gr-common.js and gr.css: the saved copy is served straight away (no waiting on the
 *    network, however weak the signal) and the latest is fetched behind it. When any of them has changed, every file
 *    is refreshed together and open pages are told ("gr-updated"): one that has only just opened reloads itself
 *    (gr-common.js), otherwise the update shows the next time a page is opened.
 *  • Icon/manifest: cache first, refreshed in the background.
 * Nothing from script.google.com is ever cached — those are the live calls.
 * Bump CACHE when a file is removed or renamed; ordinary edits don't need it. */
var CACHE = "gr-tools-v4";
var ASSETS = ["./", "home.html", "index.html", "new-job.html", "dispatch.html", "estimate.html", "history.html", "order.html", "clock.html", "job-inputs.html", "board.html",
              "config.js", "gr-common.js", "gr.css", "manifest.webmanifest", "icon.svg", "icon-192.png"];

// One file changed → fetch them all again so a page never runs with a mix of old and new files, then tell open pages.
var refreshing = null, refreshedAt = 0;
function refreshAll(c) {
  if (refreshing) return refreshing;
  if (Date.now() - refreshedAt < 30000) return Promise.resolve();   // the other files of the same update, already fetched
  refreshedAt = Date.now();
  refreshing = Promise.all(ASSETS.map(function (a) { return c.add(new Request(a, { cache: "reload" })).catch(function () {}); }))
    .then(function () { return self.clients.matchAll({ type: "window" }); })
    .then(function (list) { list.forEach(function (w) { w.postMessage({ type: "gr-updated" }); }); })
    .catch(function () {})
    .then(function () { refreshing = null; });
  return refreshing;
}

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // Fetch each one individually so a single missing file doesn't block the install.
    return Promise.all(ASSETS.map(function (a) { return c.add(new Request(a, { cache: "reload" })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isFresh(req, url) {
  return req.mode === "navigate" || /\.html$/.test(url.pathname) || /\/$/.test(url.pathname) || /\/(config\.js|gr-common\.js|gr\.css)$/.test(url.pathname);
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Apps Script, fonts, anything else: straight through

  if (isFresh(req, url)) {
    // Saved copy first; the latest is fetched behind it and stored for next time.
    var key = url.origin + url.pathname;                     // one saved copy per page, whatever the ?query
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(key, { ignoreVary: true }).then(function (hit) {
        var old = hit ? hit.clone() : null;
        var fresh = fetch(req, { cache: "no-store" }).then(function (res) {
          if (!res || !res.ok || res.redirected) return res;
          var copy = res.clone(), body = res.clone();
          var done = c.put(key, copy).then(function () {
            if (!old) return;
            return Promise.all([old.text(), body.text()]).then(function (t) { if (t[0] !== t[1]) return refreshAll(c); });
          }).catch(function () {});
          if (hit) return done.then(function () { return res; });
          e.waitUntil(done);
          return res;
        });
        if (hit) { e.waitUntil(fresh.catch(function () {})); return hit; }
        return fresh.catch(function () {
          // A navigation we never saved (e.g. the bare folder URL) with no signal: fall back to the home page.
          if (req.mode === "navigate") return c.match("home.html").then(function (h) { return h || Response.error(); });
          return Response.error();
        });
      });
    }));
    return;
  }

  // Everything else: cache first, refreshed in the background.
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (cached) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () { return cached || Response.error(); });
      return cached || fresh;
    });
  }));
});
