/* Golden Rule voice tools — service worker.
 * Lets every page open with no signal once it has been opened once. Pages and assets are served from the
 * phone's cache first and refreshed in the background, so a tech sees an update the second time they open
 * a page after it ships. Nothing from script.google.com is ever cached — those are the live calls.
 * Bump CACHE when a file is removed or renamed; ordinary edits don't need it. */
var CACHE = "gr-tools-v1";
var ASSETS = ["home.html", "index.html", "new-job.html", "dispatch.html", "estimate.html", "order.html",
              "config.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // Fetch each one individually so a single missing file doesn't block the install.
    return Promise.all(ASSETS.map(function (a) { return c.add(a).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Apps Script, fonts, anything else: straight through
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (cached) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || fresh;
    });
  }));
});
