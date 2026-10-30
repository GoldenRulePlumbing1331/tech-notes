/* Golden Rule voice tools — service worker (registered by gr-common.js).
 * Lets every page open with no signal once it has been opened once.
 *  • Pages (.html), config.js, gr-common.js and gr.css: network first, so an update shows up the first time a page
 *    is opened after it ships; the saved copy is used when there's no signal or the network takes over 3 seconds.
 *  • Icon/manifest: cache first, refreshed in the background.
 * Nothing from script.google.com is ever cached — those are the live calls.
 * Bump CACHE when a file is removed or renamed; ordinary edits don't need it. */
var CACHE = "gr-tools-v4";
var ASSETS = ["./", "home.html", "index.html", "new-job.html", "dispatch.html", "estimate.html", "order.html", "clock.html", "job-inputs.html", "board.html",
              "config.js", "gr-common.js", "gr.css", "manifest.webmanifest", "icon.svg", "icon-192.png"];
var NETWORK_TIMEOUT_MS = 3000;

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
    // Network first; saved copy when offline or slow.
    e.respondWith(caches.open(CACHE).then(function (c) {
      return new Promise(function (resolve) {
        var done = false;
        var fallback = function () {
          if (done) return; done = true;
          c.match(req, { ignoreSearch: true }).then(function (hit) {
            if (hit) return resolve(hit);
            // A navigation we never cached (e.g. the bare folder URL): fall back to the home page.
            if (req.mode === "navigate") return c.match("home.html").then(function (h) { resolve(h || Response.error()); });
            resolve(Response.error());
          });
        };
        var timer = setTimeout(fallback, NETWORK_TIMEOUT_MS);
        fetch(req, { cache: "no-store" }).then(function (res) {
          if (res && res.ok) c.put(req, res.clone());
          if (!done) { done = true; clearTimeout(timer); resolve(res); }
        }).catch(function () { clearTimeout(timer); fallback(); });
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
