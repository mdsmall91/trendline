'use strict';

/* =============================================================
   TRENDLINE — SCAN A PLATE

   Photograph a meal, get a list of what is probably on it, correct
   anything wrong, log it.

   ---------------------------------------------------------------
   AN ESTIMATE THAT KNOWS IT IS ONE

   A model reading a photograph identifies foods well and weighs them
   badly. There is no scale in the picture and no second viewpoint, so
   the difference between 120 g and 200 g of rice is a centimetre of
   mound height that a photograph does not resolve.

   Everything here follows from that:

     nothing logs itself      results open as an editable list
     portions are ranked      every row carries a confidence, and low
                              is expected rather than embarrassing
     nutrition can be swapped a row can be looked up in USDA at its
                              estimated weight, which replaces a guess
                              with a measurement and brings the
                              micronutrients with it

   That last one is the point of the whole design. The model is good
   at "that is a chicken thigh, about 140 g". A database is good at
   "140 g of chicken thigh contains this". Using each for the half it
   is good at beats either alone.

   ---------------------------------------------------------------
   THE PHOTO IS SHRUNK BEFORE IT LEAVES

   A phone photo is 3-5 MB and base64 adds a third again. Nothing in
   this task needs that: a plate is recognisable at 1024px, and the
   upload is the slowest part of the whole round trip on a phone.
   ============================================================= */

var Plate = (function () {

  var MAX_EDGE = 1024;
  var QUALITY = 0.82;

  /* ---------------------------------------------------------------
     PREPARING THE IMAGE
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

  /* Returns base64 without the data: prefix, which is what the API
     wants and what keeps the payload honest about its own size. */
  function shrink(file) {
    return loadImage(file).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * scale));
      cv.height = Math.max(1, Math.round(h * scale));
      var g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, cv.width, cv.height);
      var url = cv.toDataURL('image/jpeg', QUALITY);
      return {
        data: url.slice(url.indexOf(',') + 1),
        mediaType: 'image/jpeg',
        width: cv.width, height: cv.height
      };
    });
  }

  /* ---------------------------------------------------------------
     READING THE ANSWER

     The function returns whatever the model produced. This is where
     it becomes something the app can show without checking every
     field at every use site: numbers are numbers or null, names are
     trimmed, confidence is one of three known words, and anything
     unusable is dropped rather than rendered as "undefined g".
     --------------------------------------------------------------- */

  function num(v) {
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
  }

  var CONFIDENCE = { high: 1, medium: 1, low: 1 };

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return null;
    var grams = num(raw.grams);
    /* A food with no weight cannot be scaled, looked up, or corrected
       against anything. It is not a row, it is a rumour. */
    if (grams === null || grams <= 0) return null;

    return {
      name: name,
      grams: Math.round(grams),
      household: typeof raw.household === 'string' ? raw.household.trim() : '',
      confidence: CONFIDENCE[raw.confidence] ? raw.confidence : 'low',
      kcal: num(raw.kcal),
      protein: num(raw.protein),
      carbs: num(raw.carbs),
      fat: num(raw.fat),
      /* Where these numbers came from. Swapped to 'usda' when a row is
         looked up, and shown, because "a model guessed this" and "a
         database measured this" should never look alike. */
      source: 'estimate',
      micros: null
    };
  }

  function normalize(body) {
    var items = ((body && body.items) || []).map(normalizeItem).filter(Boolean);
    return {
      items: items,
      note: (body && typeof body.note === 'string') ? body.note.trim() : '',
      usage: (body && body.usage) || null
    };
  }

  /* The sentence under the list. Leads with the weakest part, because
     that is the part a person should be checking. */
  function summary(result) {
    if (!result || !result.items.length) {
      return result && result.note
        ? result.note
        : 'Nothing recognisable as food in that photo.';
    }
    var low = result.items.filter(function (i) { return i.confidence === 'low'; }).length;
    var bits = [result.items.length + (result.items.length === 1 ? ' item' : ' items')];
    if (low) bits.push(low + ' with a shaky portion estimate');
    bits.push('check the amounts before logging');
    return bits.join(' · ') + '.' + (result.note ? ' ' + result.note : '');
  }

  /* Total calories as the list currently stands, so the header can
     show what is about to be logged. */
  function totals(items) {
    var out = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    (items || []).forEach(function (i) {
      out.kcal += i.kcal || 0;
      out.protein += i.protein || 0;
      out.carbs += i.carbs || 0;
      out.fat += i.fat || 0;
    });
    return out;
  }

  /* Re-scale a row when its weight is corrected. The macros move with
     it; so does the micro panel, if a lookup has attached one. */
  function atGrams(item, grams) {
    var g = num(grams);
    if (!item || g === null || g <= 0 || !item.grams) return item;
    var k = g / item.grams;
    function s(v) { return v === null ? null : v * k; }
    var out = {
      name: item.name, grams: Math.round(g), household: '',
      confidence: item.confidence, source: item.source,
      kcal: s(item.kcal) === null ? null : Math.round(s(item.kcal)),
      protein: round1(s(item.protein)), carbs: round1(s(item.carbs)), fat: round1(s(item.fat)),
      micros: (item.micros && typeof Micros !== 'undefined') ? Micros.scale(item.micros, k) : null
    };
    return out;
  }

  function round1(v) { return v === null ? null : Math.round(v * 10) / 10; }

  /* ---------------------------------------------------------------
     THE NETWORK HALF
     --------------------------------------------------------------- */

  function endpoint() {
    var c = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    if (!c.SUPABASE_URL) return null;
    return c.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/plate';
  }

  function read(file) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('Sync is not set up, and the reader runs through it.'));
    if (typeof Sync === 'undefined' || !Sync.signedIn()) {
      return Promise.reject(new Error('Sign in first — the reader runs on your own account.'));
    }

    return shrink(file).then(function (img) {
      return Sync.accessToken().then(function (token) {
        return fetch(ep, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'apikey': CONFIG.SUPABASE_ANON_KEY
          },
          body: JSON.stringify({ image: img.data, mediaType: img.mediaType })
        });
      });
    }).then(function (res) {
      if (res.status === 404) {
        throw new Error('The plate reader is not installed on your Supabase project yet. ' +
          'See supabase/functions/README.md.');
      }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || ('The photo could not be read (' + res.status + ').'));
        return normalize(body);
      });
    });
  }

  return {
    /* pure — unit tested in tests/plate-tests.html */
    normalize: normalize, normalizeItem: normalizeItem,
    summary: summary, totals: totals, atGrams: atGrams,
    /* browser */
    shrink: shrink, endpoint: endpoint, read: read,
    MAX_EDGE: MAX_EDGE
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Plate;
