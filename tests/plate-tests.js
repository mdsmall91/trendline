'use strict';

/* Tests for the plate reader's pure half — what comes back from the
   model, turned into rows the app can show without checking every
   field at every use site.

   The interesting assertions are the drops. A model asked for
   structured output nearly always obliges, and the one time it does
   not, an app that trusts it renders "undefined g of undefined" into
   somebody's calorie history. */

(function (root) {
  var Plate = root.Plate || require('../js/plate.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) {
    check(name, got === want, JSON.stringify(got) + ' vs ' + JSON.stringify(want));
  }

  /* ---------- one item ---------- */

  var good = Plate.normalizeItem({
    name: '  Grilled chicken thigh  ', grams: 142.6, household: 'a palm-sized piece',
    confidence: 'medium', kcal: 310, protein: 26, carbs: 0, fat: 22
  });
  eq('the name is trimmed', good.name, 'Grilled chicken thigh');
  eq('grams are rounded', good.grams, 143);
  eq('the household description survives', good.household, 'a palm-sized piece');
  eq('confidence passes through', good.confidence, 'medium');
  eq('and it is marked as an estimate', good.source, 'estimate');
  eq('with no micronutrients until something looks it up', good.micros, null);

  /* Numbers arriving as strings is the commonest shape drift. */
  var stringy = Plate.normalizeItem({ name: 'Rice', grams: '180', kcal: '234',
    protein: '4.3', carbs: '50', fat: '0.4', confidence: 'low' });
  eq('numeric strings are read', stringy.grams, 180);
  eq('and so are the macros', stringy.kcal, 234);

  /* ---------- what gets dropped ---------- */

  eq('no name, no row', Plate.normalizeItem({ grams: 100, kcal: 200 }), null);
  eq('an empty name, no row', Plate.normalizeItem({ name: '   ', grams: 100 }), null);
  /* A food with no weight cannot be scaled, looked up, or corrected
     against anything. It is not a row, it is a rumour. */
  eq('no weight, no row', Plate.normalizeItem({ name: 'Something', kcal: 200 }), null);
  eq('zero weight, no row', Plate.normalizeItem({ name: 'Something', grams: 0 }), null);
  eq('negative weight, no row', Plate.normalizeItem({ name: 'X', grams: -50 }), null);
  eq('not an object', Plate.normalizeItem('chicken'), null);
  eq('null', Plate.normalizeItem(null), null);

  /* An unknown confidence becomes the cautious one, never the
     flattering one. */
  eq('a confidence nobody defined', Plate.normalizeItem({ name: 'X', grams: 10, confidence: 'certain' }).confidence, 'low');
  eq('a missing confidence', Plate.normalizeItem({ name: 'X', grams: 10 }).confidence, 'low');

  /* Missing macros stay missing rather than becoming zero. Zero
     calories is a claim; silence is not. */
  var thin = Plate.normalizeItem({ name: 'Mystery sauce', grams: 20, confidence: 'low' });
  eq('a missing calorie figure is null', thin.kcal, null);
  eq('a missing protein figure is null', thin.protein, null);

  /* ---------- a whole response ---------- */

  var result = Plate.normalize({
    items: [
      { name: 'Chicken thigh', grams: 140, kcal: 300, protein: 25, carbs: 0, fat: 21, confidence: 'medium' },
      { name: 'White rice', grams: 180, kcal: 234, protein: 4, carbs: 50, fat: 0, confidence: 'low' },
      { name: 'Nothing weighable' },
      null
    ],
    note: 'No cutlery in the frame to judge scale against.'
  });
  eq('the usable rows survive', result.items.length, 2);
  eq('and the unusable ones do not', result.items[1].name, 'White rice');
  eq('the note is kept', result.note, 'No cutlery in the frame to judge scale against.');

  eq('an empty response', Plate.normalize({}).items.length, 0);
  eq('a null response', Plate.normalize(null).items.length, 0);
  eq('and its note is empty rather than undefined', Plate.normalize(null).note, '');

  /* ---------- totals ---------- */

  var t = Plate.totals(result.items);
  eq('calories add up', t.kcal, 534);
  eq('protein adds up', t.protein, 29);
  eq('a missing macro counts as nothing, not NaN', Plate.totals([{ kcal: 100 }]).protein, 0);
  eq('no items', Plate.totals([]).kcal, 0);
  eq('null', Plate.totals(null).kcal, 0);

  /* ---------- correcting a weight ---------- */

  var half = Plate.atGrams(result.items[0], 70);
  eq('the weight is what was asked for', half.grams, 70);
  eq('calories halve with it', half.kcal, 150);
  eq('protein halves too', half.protein, 12.5);
  eq('the confidence is unchanged by a correction', half.confidence, 'medium');
  /* Correcting the weight invalidates a phrase like "a palm-sized
     piece", which described the old one. */
  eq('the household description is dropped', half.household, '');

  var doubled = Plate.atGrams(result.items[1], 360);
  eq('doubling doubles', doubled.kcal, 468);

  eq('a nonsense weight leaves the row alone', Plate.atGrams(result.items[0], 0).grams, 140);
  eq('so does a negative one', Plate.atGrams(result.items[0], -5).grams, 140);

  /* ---------- the sentence under the list ---------- */

  check('the summary counts the items', /2 items/.test(Plate.summary(result)), Plate.summary(result));
  check('and flags the shaky portions', /1 with a shaky portion/.test(Plate.summary(result)));
  check('and says to check before logging', /check the amounts/.test(Plate.summary(result)));
  check('and passes the note through', /No cutlery/.test(Plate.summary(result)));
  check('an empty plate says so',
    /Nothing recognisable/.test(Plate.summary({ items: [], note: '' })));
  /* When the model explains why it found nothing, that explanation is
     more useful than the generic line. */
  eq('unless there is a reason to give instead',
    Plate.summary({ items: [], note: 'That is a photograph of a dog.' }),
    'That is a photograph of a dog.');

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
