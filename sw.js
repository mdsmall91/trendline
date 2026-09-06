'use strict';

/* =============================================================
   TRENDLINE — OFFLINE SHELL

   Network-first for the app's own code, cache-first for everything
   else, and never anything cross-origin.

   The earlier version was stale-while-revalidate throughout: it
   served the cached copy and refreshed in the background, so a
   deploy only appeared on the SECOND launch. That is a reasonable
   trade for a page you read and a bad one for an app you are still
   changing — "I updated it and my phone shows the old one" is not a
   caching subtlety to the person holding the phone.

   So the app's own HTML, CSS and JS now go to the network first and
   fall back to the cache only when the network actually fails. Those
   files total about 60KB, which is nothing against the round trip
   already being made to Supabase on every launch, and offline still
   works because the fallback is the same cache it always was.

   Large static assets — the 370KB scanner bundle, the icons — stay
   cache-first. They are versioned by name in practice and there is
   no reason to re-fetch them on every launch.
   ============================================================= */

var CACHE = 'trendline-v21';

var SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './icons/apple-touch-icon.png', './config.js', './styles/app.css',
  './js/core.js', './js/store.js', './js/sync.js', './js/units.js', './js/micros.js', './js/plate.js',
  './js/foodapi.js', './js/recipe.js',
  './js/scanner.js', './js/gym.js', './js/progress.js', './js/chart.js', './js/ui.js',
  './data/exercises.json', './data/workouts.json', './data/equipment.json'
];

/* vendor/html5-qrcode.min.js is deliberately NOT in the shell. It is
   370KB and only the barcode scanner needs it, so it is fetched the
   first time that button is pressed and cached from then on. First
   install stays small; the second scan works on a plane. */

/* Code, as opposed to assets. These are the files a deploy changes. */
function isAppCode(url) {
  return /\.(?:html|css|js|webmanifest)$/i.test(url.pathname) ||
    url.pathname.endsWith('/') ||
    /\/(?:js|styles)\//.test(url.pathname);
}

/* The vendored library is code by extension but an asset in every way
   that matters: big, and it does not change between deploys. */
function isBigStatic(url) {
  return /\/vendor\//.test(url.pathname) || /\.(?:png|jpg|jpeg|svg|woff2?)$/i.test(url.pathname);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      /* addAll is all-or-nothing: one 404 and the whole install fails,
         leaving no offline copy at all. Each file is added on its own
         so a single missing asset cannot take the shell down with it. */
      .then(function (c) {
        return Promise.all(SHELL.map(function (u) {
          return c.add(u).catch(function () { /* skip, not fatal */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* Let the page ask a waiting worker to take over immediately. */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function putInCache(req, res) {
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  /* Cross-origin is left alone entirely, so Supabase and the food
     APIs are never served from a stale cache — a cached sync response
     would be worse than no sync at all. */
  if (url.origin !== self.location.origin) return;

  if (isAppCode(url) && !isBigStatic(url)) {
    /* Network first, and past the HTTP cache.

       Going to the network is not enough on its own: a plain fetch()
       is still served by the browser's own cache, and GitHub Pages
       sends max-age=600 on everything. So "network-first" quietly
       meant "up to ten minutes late" — better than the launch-late
       behaviour it replaced, but not what the app claims.

       cache:'no-cache' forces a conditional request instead. The
       server answers 304 with no body whenever nothing changed, so
       this costs a round trip of headers, not a re-download, and the
       app is genuinely current on every launch. */
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) putInCache(req, res);
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          /* A navigation that misses still has to render something,
             and index.html is the only page there is. */
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  /* Everything else: cache first, refreshed quietly in the background. */
  e.respondWith(caches.match(req).then(function (hit) {
    var live = fetch(req).then(function (res) {
      if (res && res.ok) putInCache(req, res);
      return res;
    }).catch(function () { return hit; });
    return hit || live;
  }));
});
