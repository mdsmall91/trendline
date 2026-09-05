'use strict';

/* =============================================================
   TRENDLINE — BARCODE SCANNER

   Wraps html5-qrcode, which is vendored into the repo rather than
   pulled from a CDN. Two reasons: the service worker only caches
   same-origin requests, so a CDN copy would leave scanning broken
   in a kitchen with bad signal; and a scanner that silently starts
   depending on someone else's uptime is not offline-first.

   It is 370KB, so it is loaded the first time the scan button is
   pressed and never on startup. After that the service worker has
   it and the load is instant.

   iOS notes, because that is where this is used:
     * getUserMedia needs a secure context. GitHub Pages is HTTPS,
       so the installed app is fine; a plain http:// dev server is
       not, and the error says so rather than failing blankly.
     * The camera must be released on close or the next open gets a
       black frame and no error.
   ============================================================= */

var Scanner = (function () {

  var LIB = 'vendor/html5-qrcode.min.js';

  var loading = null;      /* in-flight script load, shared by callers */
  var instance = null;     /* live Html5Qrcode, null when stopped */
  var onDone = null;

  function lib() {
    return (typeof window !== 'undefined' && window.__Html5QrcodeLibrary__) ||
      (typeof window !== 'undefined' && window.Html5Qrcode ? window : null);
  }

  function loadLib() {
    if (lib()) return Promise.resolve(lib());
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIB;
      s.async = true;
      s.onload = function () {
        var l = lib();
        if (l) resolve(l);
        else reject(new Error('Scanner library loaded but did not start.'));
      };
      s.onerror = function () {
        loading = null;
        reject(new Error('Could not load the scanner. Reload once while online and it will be cached.'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  /* Secure context and a camera API are both hard requirements, and
     both fail in ways that look like "the button does nothing" unless
     they are named. */
  function unavailableReason() {
    if (typeof window === 'undefined') return 'No browser.';
    if (!window.isSecureContext) {
      return 'The camera needs a secure connection (https). Open the installed app or the GitHub Pages URL.';
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return 'This browser will not give a web app camera access.';
    }
    return null;
  }

  function supported() { return unavailableReason() === null; }

  /* Only the retail formats. Narrowing the set makes each frame
     cheaper to decode and stops a QR code on the same package from
     winning the race against the barcode you meant to scan. */
  function formats(L) {
    var F = L.Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.UPC_EAN_EXTENSION].filter(function (x) {
      return x !== undefined;
    });
  }

  /* Start the camera into `elementId`. `cb(err, code)` fires once:
     either a decode or a failure to get going. Per-frame decode misses
     are not errors — most frames miss — so they are swallowed. */
  function start(elementId, cb) {
    var why = unavailableReason();
    if (why) { cb(new Error(why)); return Promise.resolve(); }
    onDone = cb;

    return loadLib().then(function (L) {
      var Html5Qrcode = L.Html5Qrcode;
      instance = new Html5Qrcode(elementId, {
        formatsToSupport: formats(L),
        /* Chrome on Android has a native decoder that is markedly
           faster than the bundled WASM one. Safari does not, and
           falls through to the bundle. */
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });

      return instance.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          /* A wide, short box: retail barcodes are wide and short, and
             a square reticle invites people to frame it wrongly. */
          qrbox: function (w, h) {
            var width = Math.max(160, Math.min(w * 0.85, 380));
            return { width: width, height: Math.max(110, Math.min(h * 0.45, 180)) };
          },
          aspectRatio: 1.777
        },
        function (text) {
          var fire = onDone;
          onDone = null;
          stop().then(function () { if (fire) fire(null, text); });
        },
        function () { /* per-frame miss — expected, not an error */ }
      );
    }).catch(function (e) {
      instance = null;
      var fire = onDone;
      onDone = null;
      var msg = String((e && e.message) || e);
      /* The browser's own permission errors are unreadable. */
      if (/NotAllowedError|Permission/i.test(msg)) {
        msg = 'Camera permission was refused. Allow it for this site and try again.';
      } else if (/NotFoundError|no camera/i.test(msg)) {
        msg = 'No camera found on this device.';
      } else if (/NotReadableError|in use/i.test(msg)) {
        msg = 'The camera is being used by another app.';
      }
      if (fire) fire(new Error(msg));
    });
  }

  /* Always resolves. A failure to stop cleanly must not block the UI
     from closing — the overlay coming down is what the user asked for. */
  function stop() {
    var inst = instance;
    instance = null;
    onDone = null;
    if (!inst) return Promise.resolve();
    return Promise.resolve()
      .then(function () { return inst.stop(); })
      .then(function () { return inst.clear(); })
      .catch(function () { /* already stopped, or the tab was hidden */ });
  }

  function running() { return !!instance; }

  return {
    supported: supported, unavailableReason: unavailableReason,
    start: start, stop: stop, running: running
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;
