'use strict';

/* Tests for the micronutrient model. Pure — no storage, no network.

   Most of these pin down refusals rather than arithmetic. The easy
   mistake in this feature is a confident percentage computed from a
   quarter of a day, so coverage is asserted as hard as the totals
   are. */

(function (root) {
  var Micros = root.Micros || require('../js/micros.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) {
    check(name, got === want, JSON.stringify(got) + ' vs ' + JSON.stringify(want));
  }
  function near(name, got, want, tol) {
    check(name, got !== null && got !== undefined && Math.abs(got - want) <= (tol || 0.01),
      got + ' vs ' + want);
  }

  /* ---------- the nutrient table ---------- */

  check('there are nutrients', Micros.all().length >= 15, Micros.all().length);
  check('every nutrient has a key, label and unit', Micros.all().every(function (n) {
    return n.key && n.label && n.unit;
  }));
  check('every nutrient is in a group', Micros.all().every(function (n) {
    return n.group === 'daily' || n.group === 'watch';
  }));
  check('every target has a Daily Value to aim at', Micros.all().every(function (n) {
    return n.direction !== 'target' || (typeof n.dv === 'number' && n.dv > 0);
  }));
  eq('iron is a target', Micros.get('iron').direction, 'target');
  eq('sodium is a ceiling', Micros.get('sodium').direction, 'limit');
  eq('an unknown key is null', Micros.get('unobtainium'), null);

  /* Total sugars deliberately has no Daily Value: the FDA's 50 g is for
     ADDED sugar, and scoring total against it marks fruit as a failure. */
  eq('total sugars makes no comparison', Micros.get('sugar').dv, null);
  eq('and says so in its direction', Micros.get('sugar').direction, 'none');
  eq('added sugar is the one with the ceiling', Micros.get('addedSugar').dv, 50);

  /* ---------- reading USDA ---------- */

  var usdaRows = [
    { nutrientId: 1079, value: 2.1 },      /* fibre */
    { nutrientId: 1093, value: 364 },      /* sodium */
    { nutrientId: 1089, value: 0.07 },     /* iron */
    { nutrientId: 1087, value: 83 },       /* calcium */
    { nutrient: { id: 1178 }, amount: 0.7 },  /* B12, the other shape */
    { nutrientId: 9999, value: 5 },        /* not tracked */
    { nutrientId: 1090, value: -3 }        /* impossible, dropped */
  ];
  var u = Micros.fromUSDA(usdaRows);
  eq('fibre', u.fiber, 2.1);
  eq('sodium', u.sodium, 364);
  eq('iron', u.iron, 0.07);
  eq('the nested nutrient shape is read too', u.vitB12, 0.7);
  eq('an untracked nutrient is ignored', u['9999'], undefined);
  eq('a negative amount is dropped, not stored as zero', u.magnesium, undefined);
  eq('a food with nothing recognisable yields null', Micros.fromUSDA([{ nutrientId: 9999, value: 1 }]), null);
  eq('an empty list yields null', Micros.fromUSDA([]), null);
  eq('null is safe', Micros.fromUSDA(null), null);

  /* ---------- reading Open Food Facts ----------

     Their _100g figures are normalised to GRAMS whatever the packet
     said. Real response: iron_100g 0.00242 with iron_unit "g" — that is
     2.42 mg. Read at face value it is a deficiency a thousandfold. */

  var off = Micros.fromOFF({
    fiber_100g: 4,
    sodium_100g: 0.536, sodium_unit: 'g',
    iron_100g: 0.00242424242424242, iron_unit: 'g',
    potassium_100g: 0.110714285714286,
    'saturated-fat_100g': 9,
    'added-sugars_100g': 0
  });
  eq('fibre is already grams', off.fiber, 4);
  near('sodium becomes milligrams', off.sodium, 536);
  near('iron becomes milligrams', off.iron, 2.4242, 0.001);
  near('potassium becomes milligrams', off.potassium, 110.71, 0.01);
  eq('saturated fat stays grams', off.satFat, 9);
  eq('a genuine zero is kept', off.addedSugar, 0);

  /* A source that states its own unit is believed over the assumption. */
  var mgStated = Micros.fromOFF({ iron_100g: 2.4, iron_unit: 'mg' });
  near('milligrams stated as milligrams are not multiplied', mgStated.iron, 2.4);
  var ugStated = Micros.fromOFF({ 'vitamin-d_100g': 5, 'vitamin-d_unit': 'ug' });
  near('micrograms stated as micrograms are left alone', ugStated.vitD, 5);
  near('grams of vitamin D become micrograms',
    Micros.fromOFF({ 'vitamin-d_100g': 0.000005 }).vitD, 5, 0.001);

  eq('nothing recognisable yields null', Micros.fromOFF({ energy_100g: 400 }), null);
  eq('null is safe', Micros.fromOFF(null), null);

  near('the conversion helper, grams to milligrams', Micros.toUnit(1, 'g', 'mg'), 1000);
  near('milligrams to micrograms', Micros.toUnit(1, 'mg', 'ug'), 1000);
  eq('an unknown unit refuses', Micros.toUnit(1, 'furlongs', 'g'), null);

  /* ---------- scaling ---------- */

  var scaled = Micros.scale({ iron: 2, sodium: 100 }, 0.5);
  eq('scaling halves', scaled.iron, 1);
  eq('and does it to everything', scaled.sodium, 50);
  eq('scaling nothing is null', Micros.scale(null, 2), null);
  eq('scaling by nonsense is null', Micros.scale({ iron: 1 }, 'half'), null);

  /* ---------- a day ---------- */

  var day = Micros.totals([
    { kcal: 400, qty: 1, micros: { iron: 9, sodium: 500, fiber: 7 } },
    { kcal: 200, qty: 2, micros: { iron: 1, sodium: 100 } },      /* 400 kcal */
    { kcal: 200, qty: 1, micros: null }                            /* no data */
  ]);
  eq('calories are the whole day', day.kcalTotal, 1000);
  eq('iron sums, with quantity applied', day.byKey.iron.amount, 11);
  eq('sodium sums too', day.byKey.sodium.amount, 700);
  near('iron against an 18 mg Daily Value', day.byKey.iron.percent, 61.11, 0.01);
  near('sodium against a 2300 mg ceiling', day.byKey.sodium.percent, 30.43, 0.01);

  /* Coverage is per nutrient, not per day: fibre came from one line
     only, so its figure rests on 400 of the 1000 calories even though
     iron rests on 800. */
  near('iron coverage', day.byKey.iron.coverage, 80);
  near('fibre coverage is lower, because fewer foods stated it', day.byKey.fiber.coverage, 40);
  near('overall coverage counts any-data foods', day.coverage, 80);

  /* A nutrient nothing reported is unknown, not zero. */
  eq('an unreported nutrient has no amount', day.byKey.vitD.amount, null);
  eq('and no percentage', day.byKey.vitD.percent, null);
  eq('total sugars never gets a percentage', day.byKey.sugar.percent, null);

  var empty = Micros.totals([]);
  eq('an empty day has no calories', empty.kcalTotal, 0);
  eq('and no coverage, rather than 0%', empty.coverage, null);
  eq('nothing at all is safe', Micros.totals(null).kcalTotal, 0);

  /* ---------- verdicts ---------- */

  function verdict(row) { return Micros.verdict(row); }
  eq('a met target', verdict({ amount: 20, percent: 110, direction: 'target', coverage: 90 }), 'met');
  eq('a near miss', verdict({ amount: 15, percent: 80, direction: 'target', coverage: 90 }), 'close');
  eq('a shortfall', verdict({ amount: 5, percent: 30, direction: 'target', coverage: 90 }), 'short');
  eq('under a ceiling', verdict({ amount: 800, percent: 35, direction: 'limit', coverage: 90 }), 'ok');
  eq('over a ceiling', verdict({ amount: 3000, percent: 130, direction: 'limit', coverage: 90 }), 'over');
  eq('nothing reported', verdict({ amount: null, percent: null, direction: 'target', coverage: 90 }), 'unknown');
  eq('reported without a target', verdict({ amount: 30, percent: null, direction: 'none', coverage: 90 }), 'reported');

  /* The one that matters. A shortfall computed from a quarter of the
     day is not a shortfall; it is a gap in the data wearing a
     shortfall's clothes, and it must not be coloured like one. */
  eq('a verdict is withheld when coverage is thin',
    verdict({ amount: 5, percent: 30, direction: 'target', coverage: 25 }), 'thin');
  eq('even a flattering one',
    verdict({ amount: 25, percent: 140, direction: 'target', coverage: 20 }), 'thin');

  /* ---------- an average across days ---------- */

  var d1 = Micros.totals([{ kcal: 1000, qty: 1, micros: { iron: 10 } }]);
  var d2 = Micros.totals([{ kcal: 1000, qty: 1, micros: { iron: 20 } }]);
  var blank = Micros.totals([]);
  var avg = Micros.average([d1, d2, blank]);
  eq('days with nothing logged are excluded', avg.days, 2);
  eq('the mean is over logged days only', avg.byKey.iron.amount, 15);
  near('and its percentage follows', avg.byKey.iron.percent, 83.33, 0.01);
  eq('how many days actually contributed is reported', avg.byKey.iron.daysWithData, 2);
  eq('averaging nothing is safe', Micros.average([]).days, 0);
  eq('averaging null is safe', Micros.average(null).days, 0);

  /* A day that logged food but never that nutrient still counts as a
     day, and drags the average down honestly rather than being quietly
     skipped. */
  var d3 = Micros.totals([{ kcal: 1000, qty: 1, micros: { sodium: 100 } }]);
  var avg2 = Micros.average([d1, d3]);
  eq('both days count', avg2.days, 2);
  eq('iron averages over both, not just the one that had it', avg2.byKey.iron.amount, 5);
  eq('and says only one day contributed', avg2.byKey.iron.daysWithData, 1);

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
