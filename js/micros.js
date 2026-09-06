'use strict';

/* =============================================================
   TRENDLINE — MICRONUTRIENTS

   Percentage of recommended against actual, for the nutrients worth
   watching. And, inseparably, how much of the day the number is based
   on — because those two things mean nothing apart.

   ---------------------------------------------------------------
   COVERAGE IS HALF THE ANSWER

   "You got 38% of your iron" reads as a deficiency. It is not a
   finding at all if 70% of the day came from foods that never stated
   their iron content. The honest sentence is:

     38% of the iron target, from the 30% of today's calories that
     report iron at all.

   Every total here therefore travels with its coverage, and the UI is
   expected to show both. A percentage with the denominator hidden is
   the kind of number that makes people change their diet for no
   reason.

   ---------------------------------------------------------------
   TARGETS AND CEILINGS ARE NOT THE SAME SHAPE

   Iron at 40% is a shortfall to fix. Sodium at 40% is a good day with
   room to spare. Treating both as "progress towards 100%" would
   congratulate you for eating salt, so each nutrient declares which
   direction it runs in and the UI colours them differently.

   The reference amounts are the FDA Daily Values used on nutrition
   labels for adults — the same numbers as the "%DV" column on a
   packet. They are a general adult reference, not a personal
   prescription, and the app says so rather than implying a doctor
   set them.
   ============================================================= */

var Micros = (function () {

  /* usda: FoodData Central nutrient id. unit: what the DV is stated in,
     and what USDA reports it in — they agree for every row here, which
     is why no conversion table is needed.

     direction 'target' — more is the goal, up to the DV
     direction 'limit'  — the DV is a ceiling
     direction 'none'   — reported, but with no honest target to compare
                          against (see sugar) */
  var NUTRIENTS = [
    /* the ones that move day to day */
    { key: 'fiber',   label: 'Fibre',       unit: 'g',  dv: 28,   direction: 'target', usda: 1079, group: 'daily' },
    { key: 'sodium',  label: 'Sodium',      unit: 'mg', dv: 2300, direction: 'limit',  usda: 1093, group: 'daily' },
    { key: 'satFat',  label: 'Saturated fat', unit: 'g', dv: 20,  direction: 'limit',  usda: 1258, group: 'daily' },
    { key: 'sugar',   label: 'Total sugars', unit: 'g', dv: null, direction: 'none',   usda: 2000, group: 'daily' },
    { key: 'addedSugar', label: 'Added sugar', unit: 'g', dv: 50, direction: 'limit',  usda: 1235, group: 'daily' },
    { key: 'chol',    label: 'Cholesterol', unit: 'mg', dv: 300,  direction: 'limit',  usda: 1253, group: 'daily' },
    { key: 'potassium', label: 'Potassium', unit: 'mg', dv: 4700, direction: 'target', usda: 1092, group: 'daily' },

    /* the ones worth watching over weeks rather than days */
    { key: 'calcium', label: 'Calcium',     unit: 'mg', dv: 1300, direction: 'target', usda: 1087, group: 'watch' },
    { key: 'iron',    label: 'Iron',        unit: 'mg', dv: 18,   direction: 'target', usda: 1089, group: 'watch' },
    { key: 'magnesium', label: 'Magnesium', unit: 'mg', dv: 420,  direction: 'target', usda: 1090, group: 'watch' },
    { key: 'zinc',    label: 'Zinc',        unit: 'mg', dv: 11,   direction: 'target', usda: 1095, group: 'watch' },
    { key: 'vitC',    label: 'Vitamin C',   unit: 'mg', dv: 90,   direction: 'target', usda: 1162, group: 'watch' },
    { key: 'vitD',    label: 'Vitamin D',   unit: 'ug', dv: 20,   direction: 'target', usda: 1114, group: 'watch' },
    { key: 'vitB12',  label: 'Vitamin B12', unit: 'ug', dv: 2.4,  direction: 'target', usda: 1178, group: 'watch' },
    { key: 'folate',  label: 'Folate',      unit: 'ug', dv: 400,  direction: 'target', usda: 1177, group: 'watch' },
    { key: 'vitA',    label: 'Vitamin A',   unit: 'ug', dv: 900,  direction: 'target', usda: 1106, group: 'watch' },
    { key: 'vitE',    label: 'Vitamin E',   unit: 'mg', dv: 15,   direction: 'target', usda: 1109, group: 'watch' },
    { key: 'vitK',    label: 'Vitamin K',   unit: 'ug', dv: 120,  direction: 'target', usda: 1185, group: 'watch' }
  ];

  /* Two sugar rows, because they are two different facts.

     The FDA's 50 g Daily Value is for ADDED sugar. Total sugars
     includes the sugar in an apple, so scoring total against that
     ceiling marks a bowl of fruit as a failure. Added sugar is
     reported separately by both sources and gets the percentage;
     total sugars is shown in grams with no comparison, because there
     is no honest one to make. */

  var BY_KEY = {};
  NUTRIENTS.forEach(function (n) { BY_KEY[n.key] = n; });

  function get(key) { return BY_KEY[key] || null; }
  function all() { return NUTRIENTS.slice(); }
  function group(g) {
    return NUTRIENTS.filter(function (n) { return n.group === g; });
  }

  /* ---------------------------------------------------------------
     READING A USDA FOOD

     Returns amounts per whatever basis the caller's list is in — USDA
     states everything per 100 g, so this is per 100 g, and the caller
     scales it the same way it scales the macros.

     A nutrient the food does not list is ABSENT from the result, not
     zero. "This food contains no iron" and "nobody measured the iron"
     are different claims, and only one of them is usually true.
     --------------------------------------------------------------- */

  function fromUSDA(list) {
    var out = {}, found = 0;
    var rows = list || [];
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i];
      var id = n.nutrientId || (n.nutrient && n.nutrient.id);
      var v = n.value !== undefined ? n.value : n.amount;
      if (typeof v === 'string') v = Number(v);
      if (typeof v !== 'number' || !isFinite(v) || v < 0) continue;
      for (var j = 0; j < NUTRIENTS.length; j++) {
        if (NUTRIENTS[j].usda === id) { out[NUTRIENTS[j].key] = v; found++; break; }
      }
    }
    return found ? out : null;
  }

  /* Open Food Facts states its nutriments per 100 g with its own names,
     and carries far fewer of them — sodium and fibre nearly always, the
     vitamins rarely. Partial data is still data; it just has to be
     counted as partial, which coverage does. */
  var OFF_KEYS = {
    fiber: ['fiber_100g'],
    sodium: ['sodium_100g'],
    satFat: ['saturated-fat_100g'],
    sugar: ['sugars_100g'],
    addedSugar: ['added-sugars_100g'],
    chol: ['cholesterol_100g'],
    potassium: ['potassium_100g'],
    calcium: ['calcium_100g'],
    iron: ['iron_100g'],
    magnesium: ['magnesium_100g'],
    zinc: ['zinc_100g'],
    vitC: ['vitamin-c_100g'],
    vitD: ['vitamin-d_100g'],
    vitB12: ['vitamin-b12_100g'],
    folate: ['folates_100g', 'vitamin-b9_100g'],
    vitA: ['vitamin-a_100g'],
    vitE: ['vitamin-e_100g'],
    vitK: ['vitamin-k_100g']
  };

  /* Open Food Facts normalises every _100g figure to GRAMS, whatever
     the packet said. A real response: iron_100g 0.00242 with
     iron_unit "g" — that is 2.42 mg, and taken at face value it reads
     as a deficiency two thousand times over.

     The stated _unit is used where present and grams assumed where it
     is not, which is what their normalisation promises. Guessing the
     other way round would be catastrophic in exactly one direction. */
  var PER_GRAM = { g: 1, mg: 1e-3, ug: 1e-6, 'µg': 1e-6, mcg: 1e-6 };

  function toUnit(value, fromUnit, wantUnit) {
    var f = PER_GRAM[String(fromUnit || 'g').toLowerCase()];
    var t = PER_GRAM[String(wantUnit || 'g').toLowerCase()];
    if (!f || !t) return null;
    return value * f / t;
  }

  function fromOFF(nutriments) {
    var n = nutriments || {}, out = {}, found = 0;
    NUTRIENTS.forEach(function (nut) {
      var names = OFF_KEYS[nut.key] || [];
      for (var i = 0; i < names.length; i++) {
        var v = n[names[i]];
        if (typeof v === 'string' && v !== '') v = Number(v);
        if (typeof v !== 'number' || !isFinite(v) || v < 0) continue;
        var stated = n[names[i].replace(/_100g$/, '_unit')];
        var converted = toUnit(v, stated || 'g', nut.unit);
        if (converted === null) continue;
        out[nut.key] = converted;
        found++;
        return;
      }
    });
    return found ? out : null;
  }

  /* Multiply every stated amount, leaving absences absent. */
  function scale(micros, factor) {
    if (!micros || typeof factor !== 'number' || !isFinite(factor)) return null;
    var out = {};
    Object.keys(micros).forEach(function (k) {
      if (typeof micros[k] === 'number' && isFinite(micros[k])) out[k] = micros[k] * factor;
    });
    return out;
  }

  /* ---------------------------------------------------------------
     A DAY, OR A RUN OF DAYS

     lines: [{ kcal, qty, micros }] where micros is per serving.

     Returns, per nutrient: the total, and the share of the logged
     calories that came from foods stating that nutrient at all.
     --------------------------------------------------------------- */

  function totals(lines) {
    var sum = {}, withData = {}, kcalTotal = 0, kcalAny = 0;
    (lines || []).forEach(function (line) {
      var qty = typeof line.qty === 'number' && isFinite(line.qty) ? line.qty : 1;
      var kcal = typeof line.kcal === 'number' && isFinite(line.kcal) ? line.kcal * qty : 0;
      kcalTotal += kcal;
      var m = line.micros;
      if (!m) return;
      var any = false;
      NUTRIENTS.forEach(function (n) {
        var v = m[n.key];
        if (typeof v !== 'number' || !isFinite(v)) return;
        sum[n.key] = (sum[n.key] || 0) + v * qty;
        withData[n.key] = (withData[n.key] || 0) + kcal;
        any = true;
      });
      if (any) kcalAny += kcal;
    });

    var rows = NUTRIENTS.map(function (n) {
      var amount = sum[n.key];
      var covered = withData[n.key] || 0;
      return {
        key: n.key, label: n.label, unit: n.unit, dv: n.dv,
        direction: n.direction, group: n.group,
        amount: amount === undefined ? null : amount,
        percent: (amount === undefined || !n.dv) ? null : (amount / n.dv) * 100,
        /* The share of the day this figure actually saw. Null when
           nothing was logged at all, because 0/0 is not 0%. */
        coverage: kcalTotal > 0 ? (covered / kcalTotal) * 100 : null
      };
    });

    return {
      rows: rows,
      byKey: rows.reduce(function (acc, r) { acc[r.key] = r; return acc; }, {}),
      kcalTotal: kcalTotal,
      kcalWithData: kcalAny,
      coverage: kcalTotal > 0 ? (kcalAny / kcalTotal) * 100 : null
    };
  }

  /* Average per day across a set of days, for the watch list. A single
     day's vitamin D says almost nothing; a fortnight's average says
     something. Days with nothing logged are excluded rather than
     counted as zeroes — the same rule the TDEE estimate uses, and for
     the same reason. */
  function average(days) {
    var used = (days || []).filter(function (d) { return d && d.kcalTotal > 0; });
    if (!used.length) return { rows: [], days: 0, coverage: null };

    var rows = NUTRIENTS.map(function (n) {
      var amounts = [], cov = [];
      used.forEach(function (d) {
        var r = d.byKey && d.byKey[n.key];
        if (!r) return;
        if (r.amount !== null) amounts.push(r.amount);
        if (r.coverage !== null) cov.push(r.coverage);
      });
      var mean = amounts.length
        ? amounts.reduce(function (a, b) { return a + b; }, 0) / used.length
        : null;
      return {
        key: n.key, label: n.label, unit: n.unit, dv: n.dv,
        direction: n.direction, group: n.group,
        amount: mean,
        percent: (mean === null || !n.dv) ? null : (mean / n.dv) * 100,
        coverage: cov.length ? cov.reduce(function (a, b) { return a + b; }, 0) / cov.length : null,
        /* How many of the days contributed anything at all. Two good
           days out of fourteen is not a fortnightly average. */
        daysWithData: amounts.length
      };
    });

    return {
      rows: rows,
      byKey: rows.reduce(function (acc, r) { acc[r.key] = r; return acc; }, {}),
      days: used.length,
      coverage: used.reduce(function (a, d) { return a + (d.coverage || 0); }, 0) / used.length
    };
  }

  /* How a row should read. Deliberately refuses to call anything good
     or bad when the coverage is too thin to support the claim. */
  function verdict(row) {
    if (row.amount === null) return 'unknown';
    if (row.coverage !== null && row.coverage < 50) return 'thin';
    if (row.direction === 'none') return 'reported';
    if (row.direction === 'limit') return row.percent > 100 ? 'over' : 'ok';
    if (row.percent >= 100) return 'met';
    if (row.percent >= 70) return 'close';
    return 'short';
  }

  return {
    NUTRIENTS: NUTRIENTS,
    all: all, group: group, get: get,
    fromUSDA: fromUSDA, fromOFF: fromOFF, scale: scale, toUnit: toUnit,
    totals: totals, average: average, verdict: verdict
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Micros;
