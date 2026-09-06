'use strict';

/* Tests for unit conversion. Pure — no storage, no network.

   The thing being pinned down here is not the arithmetic, which is
   easy, but the refusals: which conversions the app declines to make
   because the food never stated enough to justify them. A dropdown
   that always offers cups is a dropdown that is sometimes lying. */

(function (root) {
  var Units = root.Units || require('../js/units.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) {
    check(name, got === want, JSON.stringify(got) + ' vs ' + JSON.stringify(want));
  }
  function near(name, got, want, tol) {
    check(name, got !== null && Math.abs(got - want) <= (tol || 0.01),
      got + ' vs ' + want);
  }

  /* ---------- numbers as they appear on packets ---------- */

  eq('a whole number', Units.parseAmount('2'), 2);
  eq('a decimal', Units.parseAmount('0.5'), 0.5);
  eq('a plain fraction', Units.parseAmount('1/4'), 0.25);
  eq('a mixed number', Units.parseAmount('1 1/2'), 1.5);
  eq('a fraction with spaces', Units.parseAmount('1 / 2'), 0.5);
  eq('a vulgar fraction', Units.parseAmount('½'), 0.5);
  eq('a whole number and a vulgar fraction', Units.parseAmount('1½'), 1.5);
  eq('a spaced vulgar fraction', Units.parseAmount('2 ¼'), 2.25);
  near('a third', Units.parseAmount('⅓'), 0.3333);
  eq('a number already a number', Units.parseAmount(3), 3);
  eq('prose', Units.parseAmount('some'), null);
  eq('empty', Units.parseAmount(''), null);
  eq('null', Units.parseAmount(null), null);
  eq('a zero denominator does not divide by zero', Units.parseAmount('1/0'), null);

  /* ---------- reading a serving description ---------- */

  eq('grams', Units.parseServing('100 g').mass, 100);
  eq('grams with no space', Units.parseServing('30g').mass, 30);
  eq('grams spelled out', Units.parseServing('45 grams').mass, 45);
  near('ounces are weight', Units.parseServing('3 oz').mass, 85.05);
  near('pounds', Units.parseServing('1 lb').mass, 453.59);
  near('kilograms', Units.parseServing('0.5 kg').mass, 500);

  near('a cup', Units.parseServing('1 cup').volumeMl, 236.59);
  near('a quarter cup', Units.parseServing('1/4 cup').volumeMl, 59.15);
  near('two tablespoons', Units.parseServing('2 tbsp').volumeMl, 29.57);
  near('a teaspoon', Units.parseServing('1 tsp').volumeMl, 4.93);
  near('millilitres', Units.parseServing('250 ml').volumeMl, 250);

  /* A serving stating both is the best case: everything converts. */
  var both = Units.parseServing('1 cup (240 g)');
  near('both, the volume', both.volumeMl, 236.59);
  eq('both, the mass', both.mass, 240);

  /* The refusals. */
  eq('"1 Serving" states no mass', Units.parseServing('1 Serving').mass, null);
  eq('"1 Serving" states no volume', Units.parseServing('1 Serving').volumeMl, null);
  eq('"1 bar" states nothing', Units.parseServing('1 bar').mass, null);
  eq('an empty serving states nothing', Units.parseServing('').mass, null);
  eq('an undefined serving is safe', Units.parseServing(undefined).mass, null);

  /* A fluid ounce is a volume, and must never be read as a weight.
     The two differ by about 4% for water, which is small enough that
     nothing about a wrong answer would look wrong. */
  var floz = Units.parseServing('1 fl oz');
  near('a fluid ounce is a volume', floz.volumeMl, 29.57);
  eq('and is not counted as a weight', floz.mass, null);

  /* ---------- which units get offered ---------- */

  function units(serving) { return Units.unitsFor({ serving: serving }).join(','); }

  eq('a food stating grams offers weight but not volume',
    units('100 g'), 'serving,g,oz');
  eq('a food stating a volume offers volume but not weight',
    units('1/4 cup'), 'serving,cup,tbsp,tsp');
  eq('a food stating both offers everything',
    units('1 cup (240 g)'), 'serving,g,oz,cup,tbsp,tsp');
  eq('a food stating neither offers only servings',
    units('1 Serving'), 'serving');
  eq('a food with no serving text offers only servings',
    units(''), 'serving');

  /* Looked-up foods carry grams as a number rather than in prose. */
  eq('servingGrams counts as stating a mass',
    Units.unitsFor({ serving: '1 bar', servingGrams: 40 }).join(','), 'serving,g,oz');

  /* ---------- converting ---------- */

  var per100g = { serving: '100 g' };
  eq('a serving is a serving', Units.toServings(2, 'serving', per100g), 2);
  near('50 g of a 100 g serving', Units.toServings(50, 'g', per100g), 0.5);
  near('an ounce of a 100 g serving', Units.toServings(1, 'oz', per100g), 0.2835);
  near('four ounces', Units.toServings(4, 'oz', per100g), 1.134);

  var quarterCup = { serving: '1/4 cup' };
  near('a whole cup is four quarter-cups', Units.toServings(1, 'cup', quarterCup), 4);
  near('a tablespoon of a quarter-cup serving', Units.toServings(1, 'tbsp', quarterCup), 0.25);
  near('a teaspoon of a quarter-cup serving', Units.toServings(1, 'tsp', quarterCup), 0.0833);

  /* The refusals again, where they matter most. A cup of an unknown
     food cannot become grams, because that would be a density and the
     app was never told one. */
  eq('grams of a food that states only a volume', Units.toServings(50, 'g', quarterCup), null);
  eq('cups of a food that states only a weight', Units.toServings(1, 'cup', per100g), null);
  eq('cups of a food that states nothing',
    Units.toServings(1, 'cup', { serving: '1 Serving' }), null);
  eq('an unknown unit', Units.toServings(1, 'furlong', per100g), null);

  eq('zero is not an amount', Units.toServings(0, 'g', per100g), null);
  eq('a negative amount', Units.toServings(-5, 'g', per100g), null);
  eq('prose is not an amount', Units.toServings('lots', 'g', per100g), null);
  near('a typed fraction converts', Units.toServings('1/2', 'cup', quarterCup), 2);

  /* ---------- and back again ---------- */

  near('servings to grams', Units.fromServings(0.5, 'g', per100g), 50);
  near('servings to ounces', Units.fromServings(1, 'oz', per100g), 3.527);
  near('servings to cups', Units.fromServings(4, 'cup', quarterCup), 1);
  eq('back again refuses what forwards refused',
    Units.fromServings(1, 'cup', per100g), null);

  /* A round trip must not drift. */
  var there = Units.toServings(3.5, 'oz', per100g);
  near('a round trip through ounces', Units.fromServings(there, 'oz', per100g), 3.5);

  /* ---------- labels ---------- */

  eq('grams read as grams', Units.label('g'), 'grams');
  eq('servings read as servings', Units.label('serving'), 'servings');
  eq('an unknown unit falls back to itself', Units.label('furlong'), 'furlong');

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
