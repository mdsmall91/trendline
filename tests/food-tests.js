'use strict';

/* Tests for the food-lookup normalizers. Pure functions only — no
   network is touched, so this suite is deterministic and runs offline.
   The fixtures below are trimmed copies of real API responses. */

(function (root) {
  var FoodAPI = root.FoodAPI || require('../js/foodapi.js');
  var Store = root.Store || require('../js/store.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function near(name, got, want, tol) {
    check(name, got !== null && Math.abs(got - want) <= (tol || 0.05), got + ' vs ' + want);
  }

  /* ---------- barcodes ---------- */

  check('EAN-13 passes through', FoodAPI.normalizeBarcode('0038000138416') === '0038000138416');
  check('UPC-A is padded to 13', FoodAPI.normalizeBarcode('038000138416') === '0038000138416');
  check('EAN-8 kept at 8', FoodAPI.normalizeBarcode('20601901') === '20601901');
  check('GTIN-14 kept at 14', FoodAPI.normalizeBarcode('10038000138416') === '10038000138416');
  check('spaces and dashes stripped', FoodAPI.normalizeBarcode('038-000 138416') === '0038000138416');
  check('short code rejected', FoodAPI.normalizeBarcode('12345') === null);
  check('letters rejected', FoodAPI.normalizeBarcode('abcdefghijklm') === null);
  check('empty rejected', FoodAPI.normalizeBarcode('') === null);
  check('null rejected', FoodAPI.normalizeBarcode(null) === null);
  check('number input accepted', FoodAPI.normalizeBarcode(38000138416) === null);   /* 11 digits */

  /* ---------- barcode spellings ----------
     The same product is filed under different digit counts by different
     databases. USDA had one of the test products only under its
     13-digit form, so a miss has to be retried as the alternatives
     before it counts as "not in the database". */

  var v13 = FoodAPI.barcodeVariants('0021000658862');
  check('13-digit variants include the bare 12', v13.indexOf('021000658862') >= 0, v13.join(','));
  check('13-digit variants include itself first', v13[0] === '0021000658862');
  check('13-digit variants include the GTIN-14', v13.indexOf('00021000658862') >= 0, v13.join(','));

  var v12 = FoodAPI.barcodeVariants('038000138416');
  check('12-digit variants include the padded 13', v12.indexOf('0038000138416') >= 0, v12.join(','));

  check('variants never repeat a spelling', (function () {
    var all = FoodAPI.barcodeVariants('0038000138416');
    var seen = {};
    for (var i = 0; i < all.length; i++) {
      if (seen[all[i]]) return false;
      seen[all[i]] = 1;
    }
    return true;
  })());

  check('an 8-digit code is left alone', FoodAPI.barcodeVariants('20601901').length === 1);

  /* ---------- Open Food Facts ---------- */

  /* Real shape: per-serving AND per-100g present, plus a `-total`
     duplicate of carbohydrates written by a second importer. */
  var pringles = {
    code: '0038000138416',
    product_name: 'Original Potato Crisps',
    brands: 'Pringles',
    serving_size: '1 serving (28 g)',
    serving_quantity: 28,
    nutriments: {
      'energy-kcal': 536, 'energy-kcal_100g': 536, 'energy-kcal_serving': 150,
      proteins: 3.5, proteins_100g: 3.5, proteins_serving: 0.98,
      carbohydrates: 57, carbohydrates_100g: 57, carbohydrates_serving: 16,
      'carbohydrates-total_serving': 16,
      fat: 32, fat_100g: 32, fat_serving: 8.96
    }
  };

  var p = FoodAPI.fromOFF(pringles);
  check('OFF name gets the brand in front', p.name === 'Pringles — Original Potato Crisps', p.name);
  check('OFF prefers the stated serving', p.serving === '1 serving (28 g)', p.serving);
  near('OFF serving kcal', p.kcal, 150);
  near('OFF serving protein', p.protein, 1.0);
  near('OFF serving carbs', p.carbs, 16);
  near('OFF serving fat', p.fat, 9.0);
  near('OFF keeps per-100g alongside', p.per100g.kcal, 536);
  check('OFF carries serving grams', p.servingGrams === 28, p.servingGrams);
  check('OFF records its source', p.source === 'openfoodfacts' && p.sourceId === '0038000138416');

  /* A product with no per-serving data at all must fall back to 100g
     and SAY so, rather than silently logging a 100g portion as "1". */
  var only100 = {
    code: '5000000000000', product_name: 'Plain Oats', brands: '',
    nutriments: { 'energy-kcal_100g': 379, proteins_100g: 13.2, carbohydrates_100g: 67.7, fat_100g: 6.5 }
  };
  var o = FoodAPI.fromOFF(only100);
  check('OFF falls back to 100 g', o.serving === '100 g', o.serving);
  near('OFF 100g kcal', o.kcal, 379);
  near('OFF 100g protein', o.protein, 13.2);

  /* Brand already inside the name must not be doubled up. */
  var dbl = FoodAPI.fromOFF({
    code: '1', product_name: 'Chobani Greek Yogurt', brands: 'Chobani',
    nutriments: { 'energy-kcal_100g': 59, proteins_100g: 10 }
  });
  check('OFF does not repeat the brand', dbl.name === 'Chobani Greek Yogurt', dbl.name);

  check('OFF rejects a nameless product',
    FoodAPI.fromOFF({ code: '1', nutriments: { 'energy-kcal_100g': 100 } }) === null);
  check('OFF rejects a product with no nutrients',
    FoodAPI.fromOFF({ code: '1', product_name: 'Mystery', nutriments: {} }) === null);
  check('OFF rejects junk', FoodAPI.fromOFF(null) === null);

  /* ---------- USDA ---------- */

  /* Foundation and SR Legacy state everything per 100g and carry no
     serving size, so 100g is the honest serving. */
  var usdaFoundation = {
    fdcId: 330137,
    description: 'Yogurt, Greek, plain, nonfat',
    dataType: 'Foundation',
    foodNutrients: [
      { nutrientId: 1003, value: 10.3 },
      { nutrientId: 1004, value: 0.37 },
      { nutrientId: 1005, value: 3.64 },
      { nutrientId: 1008, value: 61.0 }
    ]
  };
  var u = FoodAPI.fromUSDA(usdaFoundation);
  check('USDA foundation serving is 100 g', u.serving === '100 g', u.serving);
  near('USDA kcal', u.kcal, 61);
  near('USDA protein', u.protein, 10.3);
  near('USDA carbs', u.carbs, 3.6);
  near('USDA fat', u.fat, 0.4);
  check('USDA records its source', u.source === 'usda' && u.sourceId === '330137');

  /* Branded rows carry a gram serving, and only then is scaling safe. */
  var branded = {
    fdcId: 999, description: 'Greek Yogurt', brandName: 'Fage',
    dataType: 'Branded', servingSize: 170, servingSizeUnit: 'g',
    householdServingFullText: '1 container',
    foodNutrients: [
      { nutrientId: 1008, value: 59 }, { nutrientId: 1003, value: 10 },
      { nutrientId: 1005, value: 3.5 }, { nutrientId: 1004, value: 0 }
    ]
  };
  var b = FoodAPI.fromUSDA(branded);
  check('USDA branded names the household portion', b.serving === '1 container (170 g)', b.serving);
  near('USDA branded scales kcal to the serving', b.kcal, 100, 1);
  near('USDA branded scales protein', b.protein, 17, 0.1);
  check('USDA branded keeps per-100g unscaled', b.per100g.kcal === 59, b.per100g.kcal);

  /* A household serving with no gram weight cannot be converted, so it
     must NOT be treated as one. This is the bug that silently triples a
     calorie count, so it gets its own test. */
  var unscalable = {
    fdcId: 998, description: 'Soup', dataType: 'Branded',
    servingSizeUnit: 'cup', householdServingFullText: '1 cup',
    foodNutrients: [{ nutrientId: 1008, value: 40 }]
  };
  var un = FoodAPI.fromUSDA(unscalable);
  check('USDA refuses to scale a non-gram serving', un.serving === '100 g', un.serving);
  near('USDA unscalable keeps the 100g value', un.kcal, 40);

  /* ---------- energy that is not there ----------
     USDA Foundation foods are laboratory component analyses: they carry
     protein, fat and carbohydrate and NO energy field of any kind. Both
     of these are copied from live responses. */

  var noEnergy = FoodAPI.fromUSDA({
    fdcId: 2646170, description: 'Chicken, breast, boneless, skinless, raw',
    dataType: 'Foundation',
    foodNutrients: [
      { nutrientId: 1004, value: 1.93 },
      { nutrientId: 1003, value: 22.5 },
      { nutrientId: 1005, value: 0.0 }
    ]
  });
  check('USDA derives kcal when there is no energy field', noEnergy.kcal !== null, noEnergy.kcal);
  near('derived kcal uses Atwater 4/4/9', noEnergy.kcal, 22.5 * 4 + 0 * 4 + 1.93 * 9, 1);
  check('derived kcal is flagged as derived', noEnergy.kcalDerived === true);
  check('a stated kcal is not flagged', u.kcalDerived === false, u.kcalDerived);

  /* "Carbohydrate, by difference" is total mass minus everything else,
     so a lean food measures slightly below zero. That is zero carbs,
     not unknown carbs, and it must not poison the derived calories. */
  var negCarb = FoodAPI.fromUSDA({
    fdcId: 2646171, description: 'Chicken, breast, meat and skin, raw',
    dataType: 'Foundation',
    foodNutrients: [
      { nutrientId: 1004, value: 4.78 },
      { nutrientId: 1003, value: 21.4 },
      { nutrientId: 1005, value: -0.428 }
    ]
  });
  check('negative carbs become zero, not null', negCarb.carbs === 0, negCarb.carbs);
  near('negative carbs do not distort derived kcal', negCarb.kcal, 21.4 * 4 + 4.78 * 9, 1);

  /* Some datasets state kilojoules instead. */
  var kjOnly = FoodAPI.fromUSDA({
    fdcId: 5, description: 'Something metric',
    foodNutrients: [{ nutrientId: 1062, value: 418.4 }, { nutrientId: 1003, value: 5 }]
  });
  near('kilojoules convert to kcal', kjOnly.kcal, 100, 1);
  check('a converted kJ value is not "derived from macros"', kjOnly.kcalDerived === false);

  /* Same fallback on the Open Food Facts side. */
  var offNoEnergy = FoodAPI.fromOFF({
    code: '2', product_name: 'Unlabelled Thing',
    nutriments: { proteins_100g: 10, carbohydrates_100g: 20, fat_100g: 5 }
  });
  near('OFF derives kcal from macros too', offNoEnergy.kcal, 165, 1);
  check('OFF flags the derivation', offNoEnergy.kcalDerived === true);

  check('USDA reads the nested nutrient shape too', FoodAPI.fromUSDA({
    fdcId: 1, description: 'X',
    foodNutrients: [{ nutrient: { id: 1008 }, amount: 250 }]
  }).kcal === 250);

  check('USDA rejects a nameless food',
    FoodAPI.fromUSDA({ fdcId: 1, foodNutrients: [{ nutrientId: 1008, value: 10 }] }) === null);
  check('USDA rejects a food with no nutrients',
    FoodAPI.fromUSDA({ fdcId: 1, description: 'Mystery', foodNutrients: [] }) === null);

  /* ---------- re-basing by weight ---------- */

  var reb = FoodAPI.atGrams(p, 56);           /* two servings' worth of crisps */
  near('atGrams scales kcal from per-100g', reb.kcal, 300, 1);
  near('atGrams scales fat', reb.fat, 17.9, 0.1);
  check('atGrams labels the new serving', reb.serving === '56 g', reb.serving);
  check('atGrams keeps the name', reb.name === p.name);
  check('atGrams refuses zero', FoodAPI.atGrams(p, 0) === null);
  check('atGrams refuses a food with no per-100g basis',
    FoodAPI.atGrams({ name: 'x', per100g: null }, 50) === null);

  /* ---------- the round trip that matters ----------
     A scanned barcode has to arrive as something Store.addFood accepts:
     a name, and four numbers that are either a number or null. */
  ['name', 'serving', 'kcal', 'protein', 'carbs', 'fat'].forEach(function (k) {
    check('OFF result has ' + k, p[k] !== undefined);
    check('USDA result has ' + k, u[k] !== undefined);
  });
  check('OFF kcal is a number', typeof p.kcal === 'number');
  check('USDA kcal is a number', typeof u.kcal === 'number');

  /* ---------- what comes first in a lookup ----------

     Ordering the library ahead of a public database is not a
     preference, it is the whole point: a recipe you cooked and logged
     is a better answer to "chicken" than the USDA's forty-first entry
     for raw poultry. rankLibrary is pure so the order can be pinned
     down here rather than argued about in a browser. */

  var LIB = [
    { id: 'a', name: 'Slow Cooker Chicken Tikka Masala', kind: 'recipe', tags: ['dinner'] },
    { id: 'b', name: 'Chicken breast', kind: 'food', tags: ['high protein'] },
    { id: 'c', name: 'Chicken thigh', kind: 'food', tags: [] },
    { id: 'd', name: 'Best Hummus', kind: 'recipe', tags: ['snack'] },
    { id: 'e', name: 'Greek yoghurt', tags: ['breakfast'] },
    { id: 'f', name: 'Roast chicken', kind: 'food', tags: [] }
  ];
  function ids(q) { return Store.rankLibrary(LIB, q).map(function (f) { return f.id; }).join(''); }

  /* The recipe first, then the two foods whose names START with the
     query, alphabetically, then the one that merely contains it. */
  check('a recipe outranks foods, and starts-with outranks contains',
    ids('chicken') === 'abcf', ids('chicken'));
  check('a mid-name match is found at all', ids('tikka') === 'a', ids('tikka'));
  check('case is ignored', ids('CHICKEN') === 'abcf', ids('CHICKEN'));

  /* The one case where the recipe preference must yield. If you typed
     the entire name of a thing, you meant that thing. */
  check('an exact name beats the recipe preference', ids('chicken breast') === 'b', ids('chicken breast'));
  check('an exact recipe name still comes first', ids('best hummus') === 'd', ids('best hummus'));

  /* "chicken t" is inside both "Chicken Tikka" and "Chicken thigh", so
     both match on contains and the recipe leads. Narrowing it to
     "chicken th" leaves only the one. */
  check('a partial phrase matches both, recipe first', ids('chicken t') === 'ac', ids('chicken t'));
  check('a narrower phrase leaves one', ids('chicken th') === 'c', ids('chicken th'));
  check('a tag matches when the name does not', ids('breakfast') === 'e', ids('breakfast'));
  check('a name match outranks a tag match',
    Store.rankLibrary(LIB, 'snack').length === 1, ids('snack'));
  check('a food with no kind is treated as a food', ids('greek') === 'e', ids('greek'));

  check('nothing matching returns nothing', ids('sardines') === '');
  check('an empty query returns nothing, not everything', ids('') === '');
  check('a whitespace query returns nothing', ids('   ') === '');
  check('a null query is safe', Store.rankLibrary(LIB, null).length === 0);
  check('a null list is safe', Store.rankLibrary(null, 'chicken').length === 0);
  check('a food with no name does not throw',
    Store.rankLibrary([{ id: 'x' }, { id: 'y', name: 'Chicken' }], 'chicken').length === 1);

  /* ---------- what you actually eat ----------

     rankRecent is pure — it takes the entries and the library rather
     than reading storage — so the ordering that drives the Quick add
     strip can be checked without a browser.

     The rule it implements: frequency, discounted by age. Each log is
     worth a full point on the day it happened and half a point every
     fourteen days after. */

  var RFOODS = [
    { id: 'coffee', name: 'Black coffee', kcal: 5 },
    { id: 'bagel', name: 'Everything bagel', kcal: 290 },
    { id: 'chicken', name: 'Chicken breast', kcal: 120 },
    { id: 'oil', name: 'Olive oil', kcal: 119 }
  ];

  function ent(foodId, date, amount, unit, qty) {
    return {
      id: 'e_' + foodId + '_' + date + '_' + (amount || 1), foodId: foodId, date: date,
      amount: amount, unit: unit, qty: qty, kcal: 1
    };
  }
  function names(rows) { return rows.map(function (r) { return r.foodId; }).join(','); }

  /* Recency beats a bigger but older count. Six logs a fortnight ago
     are worth the same as three today, so four today wins. */
  var recency = Store.rankRecent(
    [ent('oil', '2026-08-26', 1, 'tbsp', 1), ent('oil', '2026-08-26', 1, 'tbsp', 1),
     ent('oil', '2026-08-26', 1, 'tbsp', 1), ent('oil', '2026-08-26', 1, 'tbsp', 1),
     ent('oil', '2026-08-26', 1, 'tbsp', 1), ent('oil', '2026-08-26', 1, 'tbsp', 1),
     ent('coffee', '2026-09-09', 12, 'oz', 1), ent('coffee', '2026-09-09', 12, 'oz', 1),
     ent('coffee', '2026-09-09', 12, 'oz', 1), ent('coffee', '2026-09-09', 12, 'oz', 1)],
    RFOODS, { on: '2026-09-09' });
  check('today outranks a fortnight ago at similar counts',
    names(recency) === 'coffee,oil', names(recency));

  /* But frequency still counts: one thing eaten today does not
     displace a thing eaten every day this week. */
  var freq = Store.rankRecent(
    [ent('bagel', '2026-09-09', 1, 'serving', 1),
     ent('coffee', '2026-09-09', 12, 'oz', 1), ent('coffee', '2026-09-08', 12, 'oz', 1),
     ent('coffee', '2026-09-07', 12, 'oz', 1), ent('coffee', '2026-09-06', 12, 'oz', 1),
     ent('coffee', '2026-09-05', 12, 'oz', 1)],
    RFOODS, { on: '2026-09-09' });
  check('a daily habit outranks one thing eaten once today',
    names(freq) === 'coffee,bagel', names(freq));

  /* The amount comes back with the food, and it is the usual one
     rather than the last one. */
  var usual = Store.rankRecent(
    [ent('chicken', '2026-09-09', 170, 'g', 1.7), ent('chicken', '2026-09-08', 170, 'g', 1.7),
     ent('chicken', '2026-09-07', 170, 'g', 1.7), ent('chicken', '2026-09-09', 400, 'g', 4)],
    RFOODS, { on: '2026-09-09' });
  check('the usual amount wins over an odd one on the same day',
    usual[0].amount === 170 && usual[0].unit === 'g', usual[0].amount + usual[0].unit);
  near('the servings come back with it', usual[0].qty, 1.7);
  check('the count is every log, not the winning amount only',
    usual[0].count === 4, usual[0].count);

  /* A newer amount breaks a tie, because a change of portion is worth
     following. */
  var tie = Store.rankRecent(
    [ent('chicken', '2026-09-01', 170, 'g', 1.7), ent('chicken', '2026-09-09', 220, 'g', 2.2)],
    RFOODS, { on: '2026-09-09' });
  check('a more recent amount outweighs an older one', tie[0].amount === 220, tie[0].amount);

  /* Lines with nothing behind them cannot be re-logged: no serving, no
     macros to refresh, nothing the library can carry forward. */
  var orphan = Store.rankRecent(
    [{ id: 'x', date: '2026-09-09', name: 'Birthday cake', qty: 1, kcal: 600 },
     ent('coffee', '2026-09-09', 12, 'oz', 1)],
    RFOODS, { on: '2026-09-09' });
  check('a quick add with no food behind it is not offered',
    names(orphan) === 'coffee', names(orphan));

  var deleted = Store.rankRecent(
    [ent('gone', '2026-09-09', 1, 'serving', 1), ent('coffee', '2026-09-09', 12, 'oz', 1)],
    RFOODS, { on: '2026-09-09' });
  check('a food deleted from the library is not offered',
    names(deleted) === 'coffee', names(deleted));

  /* Backfilling Saturday is ranked by the week up to Saturday. What
     got eaten on the Monday after has not happened yet. */
  var future = Store.rankRecent(
    [ent('bagel', '2026-09-09', 1, 'serving', 1), ent('coffee', '2026-09-05', 12, 'oz', 1)],
    RFOODS, { on: '2026-09-05' });
  check('days after the one being logged are ignored',
    names(future) === 'coffee', names(future));

  var stale = Store.rankRecent(
    [ent('oil', '2026-01-01', 1, 'tbsp', 1), ent('coffee', '2026-09-09', 12, 'oz', 1)],
    RFOODS, { on: '2026-09-09' });
  check('anything past the window drops off entirely',
    names(stale) === 'coffee', names(stale));

  /* Older entries predate amount and unit being stored at all. They
     still rank, and they still come back with something loggable. */
  var legacy = Store.rankRecent(
    [{ id: 'l1', foodId: 'bagel', date: '2026-09-09', qty: 2, kcal: 290 }],
    RFOODS, { on: '2026-09-09' });
  check('an entry with no unit falls back to servings',
    legacy[0].unit === 'serving' && legacy[0].amount === 2, legacy[0].unit + legacy[0].amount);

  check('a malformed date is skipped, not thrown on',
    Store.rankRecent([ent('coffee', 'not-a-date', 1, 'oz', 1)], RFOODS, { on: '2026-09-09' }).length === 0);
  check('a malformed "on" returns nothing rather than everything',
    Store.rankRecent([ent('coffee', '2026-09-09', 1, 'oz', 1)], RFOODS, { on: 'today' }).length === 0);
  check('null entries are safe', Store.rankRecent(null, RFOODS, { on: '2026-09-09' }).length === 0);
  check('null foods are safe', Store.rankRecent([ent('coffee', '2026-09-09', 1, 'oz', 1)], null,
    { on: '2026-09-09' }).length === 0);
  check('no options is safe', Store.rankRecent([], RFOODS).length === 0);

  check('day numbers are days apart, not milliseconds',
    Store.dayNumber('2026-09-09') - Store.dayNumber('2026-09-02') === 7,
    Store.dayNumber('2026-09-09') - Store.dayNumber('2026-09-02'));
  check('a day number survives a daylight-saving boundary',
    Store.dayNumber('2026-11-02') - Store.dayNumber('2026-11-01') === 1);
  check('a bad key has no day number', Store.dayNumber('2026-9-9') === null);

  /* ---------- ranking what USDA sends back ----------

     The rows below are real. The eight herbs are what
     query="fresh strawberries" actually returned on 2026-09-09 with
     the parameters the app used to send; the eight branded products
     are what the same query returned once every word was required.
     Neither list contains a strawberry anybody would eat, which is the
     bug in two halves.

     rankUSDA is pure — it takes the rows rather than fetching them —
     so the ordering is tested without a key or a network. */

  function row(dataType, description, brandName, fdcId) {
    return { dataType: dataType, description: description,
             brandName: brandName || undefined, fdcId: fdcId || (Math.random() * 1e9 | 0) };
  }

  /* Verbatim from the OR pass. */
  var HERBS = [
    row('SR Legacy', 'Basil, fresh'),
    row('SR Legacy', 'Parsley, fresh'),
    row('SR Legacy', 'Peppermint, fresh'),
    row('SR Legacy', 'Rosemary, fresh'),
    row('SR Legacy', 'Spearmint, fresh'),
    row('SR Legacy', 'Thyme, fresh'),
    row('SR Legacy', 'Dill weed, fresh'),
    row('SR Legacy', 'Cheese, fresh, queso fresco')
  ];

  /* Verbatim from the requireAllWords pass. */
  var BRANDED_STRAWBERRY = [
    row('Branded', 'YOGURT PARFAIT WITH FRESH STRAWBERRIES, FRESH STRAWBERRIES', 'TAYLOR FARMS'),
    row('Branded', 'FRESH STRAWBERRY CRUSHED FRUIT BARS, FRESH STRAWBERRY', 'SOLERO'),
    row('Branded', 'FRESH STRAWBERRY PREMIUM ICE CREAM, FRESH STRAWBERRY', 'FAT BOY'),
    row('Branded', 'FRESH STRAWBERRY PRESERVES', 'HANDSOME BROOK FARM'),
    row('Branded', 'FRESH CHOICES, STRAWBERRY SODA, STRAWBERRY, STRAWBERRY', 'FRESH CHOICES'),
    row('Branded', 'STRAWBERRY FRESH DOUGHNUTS SHORTCAKE, STRAWBERRY', 'THE BAKERY AT FOOD CITY'),
    row('Branded', 'LUCKY COUNTRY, SOFT LICORICE CANDY, FRESH STRAWBERRY, FRESH STRAWBERRY', 'LUCKY COUNTRY'),
    row('Branded', 'STRAWBERRY CHEESECAKE PARFAIT WITH FRESH STRAWBERRIES, STRAWBERRY CHEESECAKE', 'N/A')
  ];

  /* The row a person typing "fresh strawberries" wants. It is in the
     curated pass and in neither of the two above, which is why the
     search runs both. */
  var RAW_STRAWBERRIES = row('SR Legacy', 'Strawberries, raw');

  function top(rows, q) {
    var r = FoodAPI.rankUSDA(rows, q);
    return r.length ? r[0].description : '';
  }

  var mixed = HERBS.concat(BRANDED_STRAWBERRY).concat([RAW_STRAWBERRIES]);

  check('the fruit beats the herbs and the ice cream',
    top(mixed, 'fresh strawberries') === 'Strawberries, raw', top(mixed, 'fresh strawberries'));
  check('and beats them on the single word too',
    top(mixed, 'strawberries') === 'Strawberries, raw', top(mixed, 'strawberries'));

  /* The specific failure that was reported: matching on the first word
     alone and answering with herbs. */
  var firstFive = FoodAPI.rankUSDA(mixed, 'fresh strawberries').slice(0, 5)
    .map(function (r) { return r.description; });
  check('no herb survives into the top five',
    firstFive.filter(function (d) { return /Basil|Parsley|Thyme|Rosemary|Spearmint|Peppermint|Dill/.test(d); }).length === 0,
    firstFive.join(' | '));

  /* Whole foods over the product catalogue, but not blindly: name a
     brand and the brand is what you meant. */
  var yog = [
    row('SR Legacy', 'Yogurt, Greek, plain, nonfat'),
    row('Branded', 'CHOBANI, GREEK YOGURT, PLAIN', 'CHOBANI')
  ];
  check('a generic query prefers the curated food',
    top(yog, 'greek yogurt') === 'Yogurt, Greek, plain, nonfat', top(yog, 'greek yogurt'));
  check('naming the brand gets the brand',
    top(yog, 'chobani greek yogurt') === 'CHOBANI, GREEK YOGURT, PLAIN',
    top(yog, 'chobani greek yogurt'));

  /* Oatmeal. Foundation and SR Legacy file the ingredient under oats
     and have no row that says "oatmeal" at all, which is why plain
     oatmeal could not be found until Survey (FNDDS) was asked. */
  var oats = [
    /* USDA's own order, which put multigrain first. */
    row('Survey (FNDDS)', 'Oatmeal, multigrain'),
    row('Survey (FNDDS)', 'Oatmeal, NFS'),
    row('SR Legacy', 'Bread, oatmeal'),
    row('Survey (FNDDS)', 'Cookie, oatmeal'),
    row('Survey (FNDDS)', 'Crackers, oatmeal'),
    row('Branded', 'OATMEAL RAISIN COOKIES, OATMEAL RAISIN', 'A BAKERY')
  ];
  check('plain oatmeal comes first', top(oats, 'oatmeal') === 'Oatmeal, NFS', top(oats, 'oatmeal'));
  check('the biscuit does not',
    FoodAPI.rankUSDA(oats, 'oatmeal')[0].description.indexOf('Cookie') < 0);

  /* The head noun carries the row. "Bread, oatmeal" is bread. */
  check('a food named after the query beats a food containing it',
    FoodAPI.rankUSDA(oats, 'oatmeal').slice(0, 2)
      .every(function (r) { return r.description.indexOf('Oatmeal') === 0; }),
    FoodAPI.rankUSDA(oats, 'oatmeal').slice(0, 2).map(function (r) { return r.description; }).join(' | '));

  /* Exactly what was typed wins outright, whatever else is going on. */
  var exact = [
    row('Branded', 'BANANA BREAD, BANANA', 'SOMEONE'),
    row('SR Legacy', 'Bananas, raw'),
    row('Foundation', 'Banana')
  ];
  check('an exact name match wins', top(exact, 'banana') === 'Banana', top(exact, 'banana'));

  /* Plurals and singulars are the same word to a person. */
  check('a plural query finds a singular name',
    top([row('Foundation', 'Strawberry'), row('Branded', 'STRAWBERRY SODA', 'X')], 'strawberries')
      === 'Strawberry');

  check('ranking is stable when nothing separates two rows',
    FoodAPI.rankUSDA([row('SR Legacy', 'Milk, whole', null, 1),
                      row('SR Legacy', 'Milk, whole', null, 2)], 'milk whole')
      .map(function (r) { return r.fdcId; }).join(',') === '1,2');

  check('an empty query keeps USDA order rather than inventing one',
    FoodAPI.rankUSDA(HERBS, '').length === HERBS.length);
  check('no rows is no rows', FoodAPI.rankUSDA([], 'anything').length === 0);
  check('null rows are safe', FoodAPI.rankUSDA(null, 'anything').length === 0);
  check('a row with no description is dropped rather than rendered',
    FoodAPI.rankUSDA([{ dataType: 'Branded' }, row('Foundation', 'Egg')], 'egg').length === 1);
  check('punctuation in the query does not break the match',
    top([row('Foundation', 'Egg, whole, raw')], "egg's!") === 'Egg, whole, raw');

  /* The stemmer, which exists for one reason: "strawberries" and
     "strawberry" share no prefix, and a person types the plural. */
  check('an -ies plural becomes its singular', FoodAPI.usdaStem('strawberries') === 'strawberry');
  check('so does berries', FoodAPI.usdaStem('berries') === 'berry');
  check('a plain -s plural loses it', FoodAPI.usdaStem('oats') === 'oat');
  check('an -es plural loses its s', FoodAPI.usdaStem('cheeses') === 'cheese',
    FoodAPI.usdaStem('cheeses'));
  check('an -oes plural stems close enough to match its singular',
    FoodAPI.usdaStem('tomatoes').indexOf(FoodAPI.usdaStem('tomato')) === 0,
    FoodAPI.usdaStem('tomatoes'));
  check('a word ending in ss keeps both', FoodAPI.usdaStem('cress') === 'cress');
  check('a three-letter word is left alone', FoodAPI.usdaStem('gas') === 'gas');
  check('a singular is unchanged', FoodAPI.usdaStem('strawberry') === 'strawberry');

  /* Prefix matching after stemming is what lets "tomatoes" find
     "tomato", and it also makes "oats" match "oatmeal" — those two
     score identically and USDA's own order decides, which is the
     honest outcome rather than a preference this app invented. */
  var oatish = [row('SR Legacy', 'Oats, rolled'), row('Foundation', 'Oatmeal, NFS')];
  check('a tie between related foods keeps USDA order',
    top(oatish, 'oats') === 'Oats, rolled', top(oatish, 'oats'));
  check('and the other way round',
    top([oatish[1], oatish[0]], 'oats') === 'Oatmeal, NFS');

  var summary = { passes: passes, failures: failures.length, detail: failures };
  root.__results = summary;
  if (typeof document !== 'undefined') {
    var el = document.getElementById('out');
    if (el) {
      el.textContent = JSON.stringify(summary, null, 2);
      el.className = failures.length ? 'fail' : 'pass';
    }
  } else {
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 1;
  }
})(typeof window !== 'undefined' ? window : globalThis);
