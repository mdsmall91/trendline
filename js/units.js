'use strict';

/* =============================================================
   TRENDLINE — UNITS

   Logging "two ounces" of something means nothing unless the app
   knows what one serving of it weighs. This module works out which
   units a given food can honestly be measured in, and converts.

   ---------------------------------------------------------------
   THE RULE: CONVERT FROM WHAT THE FOOD ACTUALLY STATES

   Every food carries a serving description — "100 g", "1/4 cup",
   "1 cup (240 g)", "1 Serving" — and that text is the only bridge
   between a unit and the macros.

     states a mass    ("100 g", "3 oz")      grams and ounces work
     states a volume  ("1/4 cup", "2 tbsp")  cups, tablespoons,
                                             teaspoons work
     states both      ("1 cup (240 g)")      all of them work
     states neither   ("1 Serving", "1 bar") servings only

   Cups do not convert to grams and never will: a cup of flour and a
   cup of honey differ by a factor of two and a half. Anything that
   offered the conversion anyway would be inventing a density. So the
   unit list is built per food, and a unit that cannot be justified is
   not offered — which is a better answer than a dropdown that is
   always full and sometimes lying.
   ============================================================= */

var Units = (function () {

  var G_PER_OZ = 28.349523125;
  var G_PER_LB = 453.59237;
  var ML_PER_CUP = 236.5882365;
  var ML_PER_TBSP = ML_PER_CUP / 16;      /* 14.7868 */
  var ML_PER_TSP = ML_PER_CUP / 48;       /* 4.9289  */
  var ML_PER_FLOZ = ML_PER_CUP / 8;       /* 29.5735 */

  var LABELS = {
    serving: 'servings',
    g: 'grams',
    oz: 'oz',
    cup: 'cups',
    tbsp: 'tbsp',
    tsp: 'tsp'
  };

  /* ---------------------------------------------------------------
     NUMBERS AS PEOPLE WRITE THEM ON PACKETS

     "1/4", "1 1/2", "0.5", "½". Recipe sites and nutrition labels use
     all four, and a parser that only reads decimals gets a quarter cup
     wrong by a factor of four rather than failing loudly.
     --------------------------------------------------------------- */

  var VULGAR = {
    '¼': 0.25, '½': 0.5, '¾': 0.75,
    '⅓': 1 / 3, '⅔': 2 / 3,
    '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875
  };

  function parseAmount(text) {
    if (typeof text === 'number') return isFinite(text) ? text : null;
    if (typeof text !== 'string') return null;
    var s = text.trim();
    if (!s) return null;

    /* Order matters, and getting it wrong is quiet. Read the leading
       number first and "1/4" becomes 1 — a quarter cup logged as a
       whole one, four times the food, with nothing on screen looking
       unusual. So the fraction forms are tested before the plain
       number, longest first. */

    /* "1 1/2" */
    var mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
    if (mixed) {
      var md = Number(mixed[3]);
      return md ? Number(mixed[1]) + Number(mixed[2]) / md : null;
    }

    /* "1/4" */
    var frac = s.match(/^(\d+)\s*\/\s*(\d+)/);
    if (frac) {
      var fd = Number(frac[2]);
      return fd ? Number(frac[1]) / fd : null;
    }

    /* "½", "1½", "2 ¼" */
    var vf = s.match(/^(\d+)?\s*([¼-¾⅐-⅞])/);
    if (vf && VULGAR[vf[2]] !== undefined) {
      return (vf[1] ? Number(vf[1]) : 0) + VULGAR[vf[2]];
    }

    /* "2", "0.5" */
    var plain = s.match(/^\d+(?:\.\d+)?/);
    return plain ? Number(plain[0]) : null;
  }

  /* ---------------------------------------------------------------
     READING A SERVING DESCRIPTION

     Returns what is knowable and says nothing about what is not:

       { mass: grams or null, volumeMl: millilitres or null }

     Both can be present — "1 cup (240 g)" states each — and both can
     be absent, which is the honest answer for "1 bar".
     --------------------------------------------------------------- */

  var MASS_UNITS = [
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:kg|kilograms?)\b/i, factor: 1000 },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:g|gr|grams?|gramme?s?)\b/i, factor: 1 },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:lbs?|pounds?)\b/i, factor: G_PER_LB },
    /* Weight ounces. "fl oz" cannot match this: the number has to sit
       immediately before the unit, and "fl" is in the way. */
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:oz|ounces?)\b/i, factor: G_PER_OZ }
  ];

  var VOLUME_UNITS = [
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:fl\.?\s*oz|fluid ounces?)\b/i, factor: ML_PER_FLOZ },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:cups?)\b/i, factor: ML_PER_CUP },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:tbsps?|tablespoons?|tbs)\b/i, factor: ML_PER_TBSP },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:tsps?|teaspoons?)\b/i, factor: ML_PER_TSP },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:ml|millilitres?|milliliters?)\b/i, factor: 1 },
    { re: /(\d[\d.\/\s\u00BC-\u00BE\u2150-\u215E]*)\s*(?:l|litres?|liters?)\b/i, factor: 1000 }
  ];

  function firstMatch(text, list) {
    for (var i = 0; i < list.length; i++) {
      var m = text.match(list[i].re);
      if (m) {
        var n = parseAmount(m[1]);
        if (n !== null && n > 0) return n * list[i].factor;
      }
    }
    return null;
  }

  function parseServing(text) {
    var s = String(text || '');
    if (!s.trim()) return { mass: null, volumeMl: null };
    /* Mass and volume are read independently, so "1 cup (240 g)" yields
       both. "1 fl oz" yields only a volume: every pattern requires the
       number to sit immediately before its unit, so the weight-ounce
       pattern cannot reach across the "fl". That matters more than it
       looks — a fluid ounce read as a weight ounce is wrong by a factor
       of about 1.04, which is the most dangerous kind of wrong, because
       nothing about the result looks odd. */
    return { mass: firstMatch(s, MASS_UNITS), volumeMl: firstMatch(s, VOLUME_UNITS) };
  }

  /* ---------------------------------------------------------------
     WHICH UNITS A FOOD CAN BE MEASURED IN

     Servings always, because a serving is defined by definition. The
     rest only where the serving text supports them.

     A food may also carry servingGrams directly — lookups from Open
     Food Facts and USDA state it as a number rather than in prose —
     and that counts as stating a mass.
     --------------------------------------------------------------- */

  function basisFor(food) {
    var f = food || {};
    var parsed = parseServing(f.serving);
    var mass = parsed.mass;
    if (mass === null && typeof f.servingGrams === 'number' && f.servingGrams > 0) {
      mass = f.servingGrams;
    }
    return { mass: mass, volumeMl: parsed.volumeMl };
  }

  function unitsFor(food) {
    var b = basisFor(food);
    var out = ['serving'];
    if (b.mass) out.push('g', 'oz');
    if (b.volumeMl) out.push('cup', 'tbsp', 'tsp');
    return out;
  }

  function label(unit) { return LABELS[unit] || unit; }

  /* How much of a serving one unit of `unit` is. Null when the food
     does not state enough to answer — the caller must not guess. */
  function servingsPerUnit(food, unit) {
    if (unit === 'serving') return 1;
    var b = basisFor(food);
    if (unit === 'g') return b.mass ? 1 / b.mass : null;
    if (unit === 'oz') return b.mass ? G_PER_OZ / b.mass : null;
    if (!b.volumeMl) return null;
    if (unit === 'cup') return ML_PER_CUP / b.volumeMl;
    if (unit === 'tbsp') return ML_PER_TBSP / b.volumeMl;
    if (unit === 'tsp') return ML_PER_TSP / b.volumeMl;
    return null;
  }

  /* amount + unit -> servings. Null rather than a guess. */
  function toServings(amount, unit, food) {
    var n = typeof amount === 'number' ? amount : parseAmount(amount);
    if (n === null || !(n > 0)) return null;
    var per = servingsPerUnit(food, unit);
    return per === null ? null : n * per;
  }

  /* The reverse, for showing an existing amount in a chosen unit. */
  function fromServings(servings, unit, food) {
    var per = servingsPerUnit(food, unit);
    if (per === null || !per) return null;
    return servings / per;
  }

  /* A short description of the amount actually logged, for the row in
     the day's list. "2 oz (0.7 servings)" says more than either half. */
  function describe(amount, unit, food) {
    var n = typeof amount === 'number' ? amount : parseAmount(amount);
    if (n === null) return '';
    if (unit === 'serving') {
      return n + ' ' + (n === 1 ? 'serving' : 'servings');
    }
    return n + ' ' + (unit === 'g' ? 'g' : unit);
  }

  return {
    parseAmount: parseAmount, parseServing: parseServing,
    basisFor: basisFor, unitsFor: unitsFor, label: label,
    servingsPerUnit: servingsPerUnit,
    toServings: toServings, fromServings: fromServings, describe: describe,
    G_PER_OZ: G_PER_OZ, ML_PER_CUP: ML_PER_CUP
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Units;
