'use strict';

/* =============================================================
   TRENDLINE — FOOD LOOKUP

   Two public databases, chosen so the app keeps its shape: no
   backend, no paid tier, no key that has to stay secret.

     Open Food Facts   packaged goods by barcode. No key at all.
     USDA FoodData     whole foods by name. Free key, rate limited.

   Both are called straight from the browser (both send
   Access-Control-Allow-Origin: *), and neither is required — a
   lookup that fails leaves manual entry exactly as it was.

   Anything looked up gets saved into the local food library, so the
   second time you eat it there is no network call at all. The
   library is the cache; there is no separate one.

   ---------------------------------------------------------------
   THE HARD PART IS SERVINGS, NOT NUTRIENTS

   Every source states nutrients per 100g. Only some also state them
   per serving, and "serving" means whatever the manufacturer says it
   means. So each normalizer returns BOTH:

     per serving   what gets logged, with a human label
     per100g       kept so a food can be re-based by weight later

   When a source gives no serving at all, 100g becomes the serving
   and the label says so. A wrong-but-labelled serving is recoverable;
   a silent one is not.
   ============================================================= */

var FoodAPI = (function () {

  var OFF_BASE = 'https://world.openfoodfacts.org';
  var USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';

  /* Open Food Facts asks that apps identify themselves so they can
     tell real traffic from scrapers. */
  var UA = 'Trendline/1.0 (https://github.com/mdsmall91/trendline)';

  function num(v) {
    if (typeof v === 'string' && v !== '') v = Number(v);
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
  }

  /* Nutrient amounts get their own reader because of one USDA quirk:
     carbohydrate is measured "by difference" — total mass minus the
     other components — so a lean food can come back at -0.428 g. That
     is a measurement artefact meaning zero, not missing data, and
     treating it as null makes a complete food look incomplete. */
  function grams(v) {
    if (typeof v === 'string' && v !== '') v = Number(v);
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return v < 0 ? 0 : v;
  }

  function round(v, dp) {
    if (v === null) return null;
    var m = Math.pow(10, dp === undefined ? 1 : dp);
    return Math.round(v * m) / m;
  }

  /* Atwater factors. Used only when a source states macros but no
     energy at all, which is the normal case for USDA Foundation foods:
     they are laboratory analyses of components, and the calorie figure
     is a derived convenience the dataset does not bother to carry.

     Deriving it here rather than leaving it null matters because the
     number shown on the row has to be the number that gets logged. */
  function deriveKcal(p, c, f) {
    if (p === null && c === null && f === null) return null;
    return (p || 0) * 4 + (c || 0) * 4 + (f || 0) * 9;
  }

  /* ---------------------------------------------------------------
     BARCODES

     EAN-8, UPC-A (12), EAN-13 and GTIN-14. A UPC-A read off a US
     package is the same number as the EAN-13 with a leading zero,
     and Open Food Facts stores the 13-digit form, so 12-digit codes
     are padded rather than looked up as-is and missed.
     --------------------------------------------------------------- */

  function normalizeBarcode(raw) {
    var s = String(raw === null || raw === undefined ? '' : raw).replace(/[^0-9]/g, '');
    if (s.length === 12) s = '0' + s;
    if (s.length !== 8 && s.length !== 13 && s.length !== 14) return null;
    return s;
  }

  /* ---------------------------------------------------------------
     OPEN FOOD FACTS
     --------------------------------------------------------------- */

  /* OFF nutriment keys come in families: `proteins`, `proteins_100g`,
     `proteins_serving`. Some products also carry a `-total` variant
     (`carbohydrates-total_serving`) written by a different importer.
     Preferred key first, fallbacks after. */
  function offNutrient(nutriments, names, suffix) {
    for (var i = 0; i < names.length; i++) {
      var v = grams(nutriments[names[i] + suffix]);
      if (v !== null) return v;
    }
    return null;
  }

  var OFF_KCAL = ['energy-kcal'];
  var OFF_PROTEIN = ['proteins'];
  var OFF_CARBS = ['carbohydrates', 'carbohydrates-total'];
  var OFF_FAT = ['fat'];

  function offName(p) {
    var name = String(p.product_name || p.generic_name || '').trim();
    var brand = String(p.brands || '').split(',')[0].trim();
    if (!name) return brand || '';
    /* "Pringles — Original Potato Crisps" reads better in a log than
       either half alone, but not when the brand is already in the name. */
    if (brand && name.toLowerCase().indexOf(brand.toLowerCase()) < 0) {
      return brand + ' — ' + name;
    }
    return name;
  }

  /* An Open Food Facts product record -> the shape Store.addFood takes. */
  function fromOFF(product) {
    if (!product || typeof product !== 'object') return null;
    var n = product.nutriments || {};

    var per100 = {
      kcal: offNutrient(n, OFF_KCAL, '_100g'),
      protein: offNutrient(n, OFF_PROTEIN, '_100g'),
      carbs: offNutrient(n, OFF_CARBS, '_100g'),
      fat: offNutrient(n, OFF_FAT, '_100g')
    };
    var perServing = {
      kcal: offNutrient(n, OFF_KCAL, '_serving'),
      protein: offNutrient(n, OFF_PROTEIN, '_serving'),
      carbs: offNutrient(n, OFF_CARBS, '_serving'),
      fat: offNutrient(n, OFF_FAT, '_serving')
    };

    var name = offName(product);
    if (!name) return null;

    var hasServing = perServing.kcal !== null || perServing.protein !== null ||
      perServing.carbs !== null || perServing.fat !== null;
    var has100 = per100.kcal !== null || per100.protein !== null ||
      per100.carbs !== null || per100.fat !== null;
    if (!hasServing && !has100) return null;

    var out, label;
    if (hasServing) {
      out = perServing;
      label = String(product.serving_size || '1 serving').trim();
    } else {
      out = per100;
      label = '100 g';
    }

    var kcal = out.kcal, derived = false;
    if (kcal === null) {
      kcal = deriveKcal(out.protein, out.carbs, out.fat);
      derived = kcal !== null;
    }

    return {
      name: name,
      serving: label,
      kcal: round(kcal, 0),
      kcalDerived: derived,
      protein: round(out.protein, 1),
      carbs: round(out.carbs, 1),
      fat: round(out.fat, 1),
      per100g: has100 ? {
        kcal: round(per100.kcal, 0), protein: round(per100.protein, 1),
        carbs: round(per100.carbs, 1), fat: round(per100.fat, 1)
      } : null,
      servingGrams: num(product.serving_quantity),
      source: 'openfoodfacts',
      sourceId: String(product.code || product._id || '')
    };
  }

  /* ---------------------------------------------------------------
     USDA FOODDATA CENTRAL
     --------------------------------------------------------------- */

  /* Nutrients arrive as a list keyed by number, not by name. These four
     are stable across every dataType. */
  var USDA_IDS = { kcal: 1008, kj: 1062, protein: 1003, carbs: 1005, fat: 1004 };

  function usdaNutrient(list, id) {
    for (var i = 0; i < (list || []).length; i++) {
      var n = list[i];
      var nid = n.nutrientId || (n.nutrient && n.nutrient.id);
      if (nid === id) return grams(n.value !== undefined ? n.value : n.amount);
    }
    return null;
  }

  function usdaName(f) {
    var d = String(f.description || '').trim();
    var brand = String(f.brandName || f.brandOwner || '').trim();
    if (brand && d.toLowerCase().indexOf(brand.toLowerCase()) < 0) return brand + ' — ' + d;
    return d;
  }

  /* A USDA search hit -> the shape Store.addFood takes.

     Values are per 100g for every dataType. Branded rows additionally
     carry a serving size, and only then is it safe to scale: a
     householdServingFullText like "1 cup" with no gram weight cannot
     be converted to anything. */
  function fromUSDA(food) {
    if (!food || typeof food !== 'object') return null;
    var list = food.foodNutrients || [];
    var per100 = {
      kcal: usdaNutrient(list, USDA_IDS.kcal),
      protein: usdaNutrient(list, USDA_IDS.protein),
      carbs: usdaNutrient(list, USDA_IDS.carbs),
      fat: usdaNutrient(list, USDA_IDS.fat)
    };
    var name = usdaName(food);
    if (!name) return null;
    if (per100.kcal === null && per100.protein === null &&
        per100.carbs === null && per100.fat === null) return null;

    /* Foundation foods carry macros and no energy whatsoever — not
       kcal, not kJ. Some sets state energy in kilojoules instead. */
    var derived = false;
    if (per100.kcal === null) {
      var kj = usdaNutrient(list, USDA_IDS.kj);
      if (kj !== null) {
        per100.kcal = kj / 4.184;
      } else {
        per100.kcal = deriveKcal(per100.protein, per100.carbs, per100.fat);
        derived = per100.kcal !== null;
      }
    }

    var grams = num(food.servingSize);
    var unit = String(food.servingSizeUnit || '').toLowerCase();
    var scalable = grams !== null && grams > 0 && (unit === 'g' || unit === 'ml' || unit === 'gram');

    var serving, vals;
    if (scalable) {
      var k = grams / 100;
      vals = {
        kcal: per100.kcal === null ? null : per100.kcal * k,
        protein: per100.protein === null ? null : per100.protein * k,
        carbs: per100.carbs === null ? null : per100.carbs * k,
        fat: per100.fat === null ? null : per100.fat * k
      };
      var household = String(food.householdServingFullText || '').trim();
      serving = household ? household + ' (' + grams + ' g)' : grams + ' g';
    } else {
      vals = per100;
      serving = '100 g';
    }

    return {
      name: name,
      serving: serving,
      kcal: round(vals.kcal, 0),
      kcalDerived: derived,
      protein: round(vals.protein, 1),
      carbs: round(vals.carbs, 1),
      fat: round(vals.fat, 1),
      per100g: {
        kcal: round(per100.kcal, 0), protein: round(per100.protein, 1),
        carbs: round(per100.carbs, 1), fat: round(per100.fat, 1)
      },
      servingGrams: scalable ? grams : 100,
      source: 'usda',
      sourceId: String(food.fdcId || '')
    };
  }

  /* Re-base a looked-up food onto a different weight. Used when the
     stated serving is not the amount actually eaten. */
  function atGrams(food, grams) {
    var g = num(grams);
    if (!food || !food.per100g || g === null || g <= 0) return null;
    var k = g / 100;
    function s(v) { return v === null || v === undefined ? null : v * k; }
    return Object.assign({}, food, {
      serving: g + ' g',
      servingGrams: g,
      kcal: round(s(food.per100g.kcal), 0),
      protein: round(s(food.per100g.protein), 1),
      carbs: round(s(food.per100g.carbs), 1),
      fat: round(s(food.per100g.fat), 1)
    });
  }

  /* ---------------------------------------------------------------
     NETWORK

     Every call is time-boxed. A lookup that hangs is worse than one
     that fails: the failure falls back to typing the numbers in,
     which is what the app did before this file existed.
     --------------------------------------------------------------- */

  var TIMEOUT = 12000;

  function timed(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; reject(new Error('Lookup timed out. Check your connection.')); }
      }, ms || TIMEOUT);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(t); reject(e);
      });
    });
  }

  function getJSON(url, headers) {
    return timed(fetch(url, { headers: headers || {} }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('Lookup failed (' + r.status + ')');
      return r.json();
    }));
  }

  /* Barcode -> one food, or null if the product is not in the database.
     Open Food Facts is crowd-sourced, so a miss is normal and must read
     as "not found", never as an error. */
  function lookupBarcode(raw) {
    var code = normalizeBarcode(raw);
    if (!code) return Promise.reject(new Error('That is not a barcode I recognise.'));
    var fields = 'code,product_name,generic_name,brands,serving_size,serving_quantity,nutriments';
    var url = OFF_BASE + '/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + fields;
    return getJSON(url, { 'User-Agent': UA }).then(function (j) {
      if (!j || j.status === 0 || !j.product) return null;
      return fromOFF(j.product);
    });
  }

  function usdaKey() {
    var c = (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
    var k = c.USDA_API_KEY;
    if (k) return String(k).trim();
    try {
      var local = JSON.parse(localStorage.getItem('tl.usda') || 'null');
      if (local && local.key) return String(local.key).trim();
    } catch (e) {}
    return '';
  }

  function setUsdaKey(k) {
    try {
      if (k) localStorage.setItem('tl.usda', JSON.stringify({ key: String(k).trim() }));
      else localStorage.removeItem('tl.usda');
    } catch (e) {}
  }

  function hasUsdaKey() { return !!usdaKey(); }

  /* Name -> a short list of candidates.

     Foundation and SR Legacy first: those are laboratory-analysed
     whole foods, and for "chicken breast" they are the right answer.
     Branded is included because a lot of what people actually eat has
     a label on it, but it is noisier and sits lower in the results. */
  function searchFoods(query, opts) {
    var q = String(query || '').trim();
    if (!q) return Promise.resolve([]);
    var key = usdaKey();
    if (!key) {
      return Promise.reject(new Error(
        'Search needs a free USDA key. Setup → Food lookup, or fdc.nal.usda.gov/api-key-signup.html'));
    }
    var limit = (opts && opts.limit) || 12;
    var url = USDA_BASE + '/foods/search?query=' + encodeURIComponent(q) +
      '&pageSize=' + limit +
      '&dataType=' + encodeURIComponent('Foundation,SR Legacy,Branded') +
      '&api_key=' + encodeURIComponent(key);
    return getJSON(url).then(function (j) {
      var foods = (j && j.foods) || [];
      var out = [];
      for (var i = 0; i < foods.length; i++) {
        var f = fromUSDA(foods[i]);
        if (f) out.push(f);
      }
      return out;
    }).catch(function (e) {
      /* A bad key comes back as 403 and is worth naming, because the
         fix is a different one-off action than "try again later". */
      if (/403/.test(String(e.message))) {
        throw new Error('USDA rejected the API key. Check it in Setup → Food lookup.');
      }
      throw e;
    });
  }

  return {
    /* pure — unit tested in tests/food-tests.html */
    normalizeBarcode: normalizeBarcode,
    fromOFF: fromOFF, fromUSDA: fromUSDA, atGrams: atGrams,
    offName: offName, usdaName: usdaName,
    /* network */
    lookupBarcode: lookupBarcode, searchFoods: searchFoods,
    usdaKey: usdaKey, setUsdaKey: setUsdaKey, hasUsdaKey: hasUsdaKey
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FoodAPI;
