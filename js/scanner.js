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
  /* ---------------------------------------------------------------
     READING A BARCODE OUT OF A PHOTO

     One attempt is not enough, and the reason is worth writing down
     because it is not obvious.

     ZXing does not examine every pixel. It samples a set of horizontal
     lines across the image and looks for a bar pattern along them. On a
     12-megapixel phone photo where the barcode occupies a quarter of
     the width, those sample lines either miss the bars or cross them at
     a few pixels per module — and the moment there is any softness in
     the shot, which there always is when a hand is holding the phone,
     it finds nothing.

     Measured, on a synthetic 4032x3024 frame with the barcode at 25% of
     the width:

       sharp, whole image          decodes
       1.5px blur, whole image     fails
       1.5px blur, scaled to 1600  fails      (scaling keeps the ratio)
       1.5px blur, scaled to 1024  fails
       1.5px blur, centre 50% crop decodes
       1.5px blur, centre 35% crop decodes

     Scaling cannot help: shrinking the image shrinks the blur with it.
     Cropping does, because it puts the bars across the full width of
     what gets analysed, so the sample lines land on them and each
     module gets more pixels.

     So: try the photo as taken, then tighter and tighter centre crops.
     People centre the thing they are photographing, which is the whole
     reason this works. Each attempt costs about a tenth of a second,
     and they stop at the first success.
     --------------------------------------------------------------- */

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file could not be opened as an image.'));
      };
      img.src = url;
    });
  }

  /* A centred crop, scaled so the bars are wide in the result. boost
     flattens the image to grey and pushes contrast, which helps a photo
     taken under a warm kitchen light. */
  function cropToFile(img, frac, outWidth, boost) {
    var w = img.naturalWidth * frac;
    var h = img.naturalHeight * frac;
    var scale = outWidth / w;
    var cv = document.createElement('canvas');
    cv.width = Math.round(w * scale);
    cv.height = Math.round(h * scale);
    var g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (boost) g.filter = 'grayscale(100%) contrast(180%)';
    g.drawImage(img, (img.naturalWidth - w) / 2, (img.naturalHeight - h) / 2, w, h,
      0, 0, cv.width, cv.height);
    return new Promise(function (resolve) {
      cv.toBlob(function (blob) {
        resolve(new File([blob], 'crop.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.95);
    });
  }

  /* One decode attempt. Resolves with the text, or null for "not in
     this image" — a miss is an expected outcome here, not an error,
     because most attempts are expected to miss. */
  function decodeOnce(L, file, elementId) {
    var reader = new L.Html5Qrcode(elementId, {
      formatsToSupport: formats(L),
      /* Where the browser has a native barcode reader — Android Chrome,
         and Safari when it eventually ships one — it is far better at
         real photographs than anything in JavaScript. */
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false
    });
    /* showImage:false — the overlay is staying put for another attempt,
       and painting each crop into it would be a flicker show. */
    return reader.scanFile(file, false).then(function (text) {
      try { reader.clear(); } catch (e) {}
      return text;
    }).catch(function (e) {
      try { reader.clear(); } catch (e2) {}
      var msg = String((e && e.message) || e);
      if (/No MultiFormat Readers|NotFoundException|No barcode or QR/i.test(msg)) return null;
      throw e;
    });
  }

  function scanImage(file, elementId, onProgress) {
    if (!file) return Promise.reject(new Error('No photo to read.'));

    return stop().then(function () {
      return loadLib();
    }).then(function (L) {
      return loadImage(file).then(function (img) {
        var attempts = [
          { label: 'the photo as taken', make: function () { return Promise.resolve(file); } },
          { label: 'the middle of it', make: function () { return cropToFile(img, 0.6, 1600, false); } },
          { label: 'closer in', make: function () { return cropToFile(img, 0.38, 1600, false); } },
          { label: 'closer still, with the contrast up', make: function () { return cropToFile(img, 0.28, 1600, true); } },
          { label: 'the whole frame, contrast up', make: function () { return cropToFile(img, 1, 2000, true); } }
        ];

        function attempt(i) {
          if (i >= attempts.length) {
            throw new Error('No barcode found in that photo, and it was tried five ways. ' +
              'Fill more of the frame with the bars, hold steady, and keep the bars level. ' +
              'Or type the digits underneath them — that always works.');
          }
          if (onProgress) onProgress('Reading ' + attempts[i].label + '…');
          return attempts[i].make().then(function (f) {
            return decodeOnce(L, f, elementId);
          }).then(function (text) {
            return text || attempt(i + 1);
          });
        }
        return attempt(0);
      });
    });
  }

  return {
    supported: supported, unavailableReason: unavailableReason,
    start: start, stop: stop, running: running, scanImage: scanImage
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;
