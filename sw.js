'use strict';

/* Offline shell. Stale-while-revalidate rather than cache-first: the app
   keeps working on a plane, but a deploy is picked up on the next load
   instead of needing the cache name bumped by hand. */

var CACHE = 'trendline-v2';
var SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './icons/apple-touch-icon.png', './config.js', './styles/app.css',
  './js/core.js', './js/store.js', './js/sync.js', './js/foodapi.js',
  './js/scanner.js', './js/chart.js', './js/ui.js'
];

/* vendor/html5-qrcode.min.js is deliberately NOT in the shell. It is
   370KB and only the barcode scanner needs it, so it is fetched the
   first time that button is pressed and cached by the fetch handler
   below like any other same-origin file. First install stays small;
   the second scan works on a plane. */

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  /* Only the app shell is cached. Cross-origin requests are left alone
     entirely, so Supabase traffic is never served from a stale cache —
     a cached sync response would be worse than no sync at all. */
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(req).then(function (hit) {
    var live = fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
    return hit || live;
  }));
});
