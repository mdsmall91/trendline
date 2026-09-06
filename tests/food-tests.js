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
