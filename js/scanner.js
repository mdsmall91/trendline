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
     winning the race against the barcode you meant to scan.

     UPC_EAN_EXTENSION is deliberately absent: it matches the 2- and
     5-digit supplements printed beside a barcode, never the barcode
     itself, so it can only ever produce a wrong read. */
  function formats(L) {
    var F = L.Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    var want = [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E].filter(function (x) {
      return x !== undefined && x !== null;
    });
    /* An empty or partial list would silently narrow the scanner to
       nothing. Better to support everything than to support none. */
    return want.length === 4 ? want : undefined;
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
        {
          facingMode: 'environment'
        },
        {
          fps: 10,

          /* NO aspectRatio.

             Forcing 16:9 on a phone held in portrait is what broke the
             first version of this: the library lays out its scan region
             against the ratio it was told rather than the one the camera
             actually produced, so the decoded area sits somewhere other
             than the part of the frame the person is aiming. The camera
             looked alive and nothing ever read. Letting the stream
             report its own shape costs nothing and removes the whole
             class of problem.

             qrbox is a fraction of the REAL frame, clamped so it can
             never exceed it — an oversized box is the other way this
             silently stops decoding. Wide and short, because retail
             barcodes are wide and short and a square reticle invites
             people to frame it wrongly. */
          qrbox: function (w, h) {
            return {
              width: Math.max(120, Math.floor(w * 0.9)),
              height: Math.max(80, Math.floor(h * 0.55))
            };
          },

          /* Continuous autofocus. A barcode 15cm from the lens is
             exactly where a phone likes to hunt, and a hunting camera
             produces blur that no decoder recovers from. Passed as a
             plain constraint because Safari ignores what it does not
             understand rather than failing the getUserMedia call. */
          videoConstraints: {
            facingMode: 'environment',
            focusMode: 'continuous',
            advanced: [{ focusMode: 'continuous' }]
          },

          /* Some packages get printed mirrored on curved surfaces, and
             flipping costs one extra pass on a frame that already
             failed. */
          disableFlip: false
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

  /* Decode a still photo instead of the live stream.

     Live scanning asks the camera to hold focus on a small, high
     contrast pattern while a hand shakes; a photo lets the phone do
     what it is actually good at — focus once, expose properly, and
     hand over a sharp full-resolution frame. On iOS this is markedly
     more reliable than the video path, and it is the answer to "the
     camera is on but nothing happens".

     The live scanner must be stopped first: html5-qrcode refuses to
     scan a file into an element that is mid-stream, and the failure
     is an unhelpful internal error rather than a clear one. */
  function scanImage(file, elementId) {
    if (!file) return Promise.reject(new Error('No photo to read.'));
    return stop().then(function () {
      return loadLib();
    }).then(function (L) {
      var reader = new L.Html5Qrcode(elementId, {
        formatsToSupport: formats(L),
        verbose: false
      });
      /* showImage:false — the overlay is closing, and painting the
         photo into it first is a flash of the wrong thing. */
      return reader.scanFile(file, false).then(function (text) {
        try { reader.clear(); } catch (e) {}
        return text;
      }).catch(function (e) {
        try { reader.clear(); } catch (e2) {}
        var msg = String((e && e.message) || e);
        /* The library's miss message is a stack trace's worth of noise
           for what is really just "I could not see a barcode". */
        if (/No MultiFormat Readers|NotFoundException|No barcode or QR/i.test(msg)) {
          throw new Error('No barcode found in that photo. Fill the frame with the bars, ' +
            'hold steady, and keep it about a hand span away.');
        }
        throw new Error(msg);
      });
    });
  }

  return {
    supported: supported, unavailableReason: unavailableReason,
    start: start, stop: stop, running: running, scanImage: scanImage
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;
