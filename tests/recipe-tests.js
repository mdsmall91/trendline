'use strict';

/* Tests for the recipe reader. Pure functions only — the fixtures are
   real JSON-LD saved from four live pages, so this suite runs offline
   and stays deterministic while the sites behind it change. */

(function (root) {
  var Recipe = root.Recipe || require('../js/recipe.js');
  var FIX = root.RECIPE_FIXTURES || require('./recipe-fixtures.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) {
    check(name, got === want, JSON.stringify(got) + ' vs ' + JSON.stringify(want));
  }

  /* ---------- reading numbers out of text ----------
     Every value on a NutritionInformation block arrives as a string
     with a unit welded to it, and no two plugins agree on the unit. */

  eq('kcal with a unit', Recipe.qty('415.88 kcal'), 415.88);
  eq('calories spelled out', Recipe.qty('151 calories'), 151);
  eq('grams', Recipe.qty('37.03 g'), 37.03);
  eq('no space before the unit', Recipe.qty('20g'), 20);
  eq('thousands separator', Recipe.qty('1,020 mg'), 1020);
  eq('a bare number', Recipe.qty(471), 471);
  eq('a numeric string', Recipe.qty('471'), 471);
  eq('zero is a value, not a gap', Recipe.qty('0 g'), 0);
  eq('prose is not a number', Recipe.qty('trace'), null);
  eq('empty string', Recipe.qty(''), null);
  eq('undefined', Recipe.qty(undefined), null);
  eq('null', Recipe.qty(null), null);

  /* Sodium and cholesterol are milligrams by convention, and a site
     that writes grams instead is out by a factor of a thousand if the
     unit goes unread. */
  eq('mg stays mg', Recipe.mg('978.77 mg'), 978.77);
  eq('grams become mg', Recipe.mg('0.9 g'), 900);
  eq('zero mg', Recipe.mg('0 mg'), 0);
  eq('bare number is assumed mg', Recipe.mg('840'), 840);

  /* ---------- surviving a page's script tags ---------- */

  eq('invalid JSON yields null, not a throw', Recipe.parseBlock('{ nope, }'), null);
  eq('empty block', Recipe.parseBlock(''), null);
  eq('non-string block', Recipe.parseBlock(42), null);
  check('CDATA wrapper is stripped',
    (Recipe.parseBlock('//<![CDATA[\n{"a":1}\n//]]>') || {}).a === 1);
  check('plain JSON parses', (Recipe.parseBlock('{"a":2}') || {}).a === 2);

  /* ---------- finding the Recipe among the furniture ---------- */

  check('finds a Recipe nested in an @graph',
    Recipe.findRecipe(FIX['budgetbytes.com']).name === 'Slow Cooker Chicken Tikka Masala');
  check('finds a Recipe at the top of an array',
    Recipe.findRecipe([{ '@type': 'WebSite' }, { '@type': 'Recipe', name: 'X' }]).name === 'X');
  check('handles @type given as an array',
    Recipe.findRecipe({ '@type': ['Article', 'Recipe'], name: 'Y' }).name === 'Y');
  eq('a page with no Recipe returns null',
    Recipe.findRecipe({ '@type': 'WebPage', name: 'Z' }), null);
  eq('rubbish input returns null', Recipe.findRecipe(null), null);

  /* A bad block must not take a good one down with it — pages carry
     several, and one plugin emitting broken JSON is common. */
  var mixed = ['{ broken', JSON.stringify(FIX['allrecipes.com'])];
  check('a broken block is skipped, not fatal',
    (Recipe.recipeFromBlocks(mixed) || {}).name === 'Chicken Parmesan');

  /* ---------- servings, the field sites are loosest with ---------- */

  var s1 = Recipe.servingsFrom('4');
  eq('a bare string count', s1.servings, 4);
  eq('a bare count is confident', s1.confident, true);

  var s2 = Recipe.servingsFrom(['6']);
  eq('a count inside an array', s2.servings, 6);

  /* The case this whole function exists for. Cookie and Kate yields
     "2 cups (8 servings)": first value 2, real portions 8. Taking the
     first value is wrong by four times on anything derived from it. */
  var s3 = Recipe.servingsFrom(['2', '2 cups (8 servings)']);
  eq('the value that says "servings" wins over the first one', s3.servings, 8);
  eq('and it is confident', s3.confident, true);

  var s4 = Recipe.servingsFrom('2', 'Serves at least 2');
  eq('servingSize can carry the count', s4.servings, 2);

  var s5 = Recipe.servingsFrom('Serves 4');
  eq('"Serves 4" reads the other way round', s5.servings, 4);

  var s6 = Recipe.servingsFrom('2 cups');
  eq('a number with a unit is still used', s6.servings, 2);
  eq('but it is not claimed as confident', s6.confident, false);
  eq('and the text is kept so a person can settle it', s6.text, '2 cups');

  var s7 = Recipe.servingsFrom(undefined);
  eq('no yield at all', s7.servings, null);

  eq('a numeric yield', Recipe.servingsFrom(8).servings, 8);
  eq('a QuantitativeValue yield', Recipe.servingsFrom({ value: 12 }).servings, 12);

  /* ---------- the four real pages ---------- */

  function readFixture(domain) {
    return Recipe.fromBlocks([JSON.stringify(FIX[domain])], 'https://' + domain + '/x');
  }

  var bb = readFixture('budgetbytes.com');
  check('budgetbytes reads clean', bb.ok, JSON.stringify(bb.missing));
  eq('budgetbytes name', bb.name, 'Slow Cooker Chicken Tikka Masala');
  eq('budgetbytes kcal', bb.per.kcal, 416);
  eq('budgetbytes protein', bb.per.protein, 34.2);
  eq('budgetbytes carbs', bb.per.carbs, 37);
  eq('budgetbytes fat', bb.per.fat, 14);
  eq('budgetbytes servings', bb.servings, 6);
  eq('budgetbytes fibre', bb.extras.fiber, 2.1);
  eq('budgetbytes sodium', bb.extras.sodium, 979);
  eq('budgetbytes serving label', bb.servingLabel, '1 Serving');
  eq('budgetbytes calories were stated, not derived', bb.kcalDerived, false);
  eq('budgetbytes url is carried through', bb.url, 'https://budgetbytes.com/x');

  var ar = readFixture('allrecipes.com');
  check('allrecipes reads clean', ar.ok, JSON.stringify(ar.missing));
  eq('allrecipes kcal', ar.per.kcal, 471);
  eq('allrecipes protein', ar.per.protein, 42);
  eq('allrecipes carbs', ar.per.carbs, 25);
  eq('allrecipes fat', ar.per.fat, 25);
  eq('allrecipes servings', ar.servings, 4);
  eq('allrecipes saturated fat', ar.extras.satFat, 9);
  eq('allrecipes cholesterol', ar.extras.cholesterol, 187);
  /* No servingSize on this one, so the label falls back rather than
     inventing a portion description. */
  eq('allrecipes serving label falls back', ar.servingLabel, '1 serving');

  var ck = readFixture('cookieandkate.com');
  check('cookieandkate reads clean', ck.ok, JSON.stringify(ck.missing));
  eq('cookieandkate kcal', ck.per.kcal, 151);
  eq('cookieandkate protein', ck.per.protein, 4.9);
  eq('cookieandkate fat', ck.per.fat, 10.6);
  /* The whole point: yield says two, portions are eight. */
  eq('cookieandkate servings resolve to 8, not 2', ck.servings, 8);
  eq('cookieandkate serving label', ck.servingLabel, '1/4 cup');
  /* This site spells the type "nutritionInformation". A parser that
     insists on the capital N finds nothing on a page that has it all. */
  check('a lower-cased @type is still nutrition', ck.per.carbs === 11.1);

  var se = readFixture('seriouseats.com');
  check('seriouseats reads clean', se.ok, JSON.stringify(se.missing));
  eq('seriouseats kcal', se.per.kcal, 1149);
  eq('seriouseats protein', se.per.protein, 84);
  eq('seriouseats zero carbs is a value', se.per.carbs, 0);
  eq('seriouseats fat', se.per.fat, 91);
  eq('seriouseats servings from servingSize prose', se.servings, 2);

  /* ---------- calories the site did not state ---------- */

  var derived = Recipe.fromBlocks([JSON.stringify({
    '@type': 'Recipe', name: 'Macros only', recipeYield: '4',
    nutrition: { '@type': 'NutritionInformation', proteinContent: '20 g', carbohydrateContent: '30 g', fatContent: '10 g' }
  })], null);
  check('a recipe with macros but no calories still reads', derived.ok);
  eq('calories come from Atwater', derived.per.kcal, 290);
  eq('and the derivation is flagged', derived.kcalDerived, true);

  /* ---------- what it refuses to claim ---------- */

  var noNut = Recipe.fromBlocks([JSON.stringify({
    '@type': 'Recipe', name: 'Grandma cake', recipeYield: '8 servings'
  })], null);
  eq('a recipe with no nutrition is not ok', noNut.ok, false);
  eq('and says why', noNut.reason, 'no-nutrition');
  eq('but keeps the name', noNut.name, 'Grandma cake');
  eq('and the servings', noNut.servings, 8);

  var partial = Recipe.fromBlocks([JSON.stringify({
    '@type': 'Recipe', name: 'Half a label',
    nutrition: { '@type': 'NutritionInformation', calories: '300 kcal', proteinContent: '10 g' }
  })], null);
  eq('a half-filled label is not ok', partial.ok, false);
  eq('and names both gaps', partial.missing.join(','), 'carbs,fat');
  eq('while keeping what was there', partial.per.protein, 10);
  eq('calories are not invented from one macro', partial.kcalDerived, false);

  var none = Recipe.fromBlocks(['{"@type":"WebPage"}'], null);
  eq('a page with no recipe says so', none.reason, 'no-recipe');
  eq('an empty block list says so too', Recipe.fromBlocks([], null).reason, 'no-recipe');

  /* ---------- the sentence shown on the card ---------- */

  check('summary names the per-serving basis', /Per serving/.test(Recipe.summary(bb)));
  check('summary states the yield', /makes 6/.test(Recipe.summary(bb)));
  check('summary flags an unsure serving count',
    /check the serving count/.test(Recipe.summary(Recipe.fromBlocks([JSON.stringify({
      '@type': 'Recipe', name: 'Loaf', recipeYield: '1 loaf',
      nutrition: { calories: '200', proteinContent: '5 g', carbohydrateContent: '20 g', fatContent: '10 g' }
    })], null))));
  check('summary says when calories were computed',
    /calories from the macros/.test(Recipe.summary(derived)));
  check('summary names the missing fields', /missing carbs and fat/.test(Recipe.summary(partial)));
  check('summary handles a page with no nutrition',
    /does not publish nutrition/.test(Recipe.summary(noNut)));

  /* ---------- read off the page, rather than declared ----------

     The second pass, for the many pages that print nutrition without
     publishing it. What comes back must normalise into exactly the
     shape declared data does, so the UI has one thing to render — but
     must never claim to be the same KIND of fact. */

  var readOk = Recipe.fromRead({
    found: true, name: '  Burrito Bowl  ', serving: '1 bowl (510 g)', servings: 1,
    kcal: 625, protein: 45, carbs: 60, fat: 22.5,
    fiber: 9, sodium: 1350, satFat: 6, calcium: 220
  }, 'https://example.com/bowl');
  check('a complete reading is ok', readOk.ok);
  eq('the name is trimmed', readOk.name, 'Burrito Bowl');
  eq('calories come through', readOk.per.kcal, 625);
  eq('so does fat', readOk.per.fat, 22.5);
  eq('the stated serving is kept', readOk.servingLabel, '1 bowl (510 g)');
  eq('and it is labelled as read, not declared', readOk.source, 'read');
  eq('micronutrients come across', Object.keys(readOk.micros).length, 4);
  eq('sodium among them', readOk.micros.sodium, 1350);
  eq('url carried', readOk.url, 'https://example.com/bowl');

  var readPartial = Recipe.fromRead({ found: true, name: 'Thing', kcal: 300, protein: 10 }, 'u');
  eq('a half-read page is not ok', readPartial.ok, false);
  eq('and names the gaps', readPartial.missing.join(','), 'carbs,fat');
  eq('while keeping what it had', readPartial.per.protein, 10);
  eq('no micros means none, not an empty object', readPartial.micros, null);

  /* Atwater still applies, and is still flagged. */
  var readDerived = Recipe.fromRead({
    found: true, name: 'Macros only', protein: 20, carbs: 30, fat: 10
  }, 'u');
  check('calories are derived when absent', readDerived.ok);
  eq('to the Atwater figure', readDerived.per.kcal, 290);
  eq('and flagged as derived', readDerived.kcalDerived, true);

  /* The refusal that matters most: a page with nothing on it must not
     come back with a plausible meal on it. */
  var readNone = Recipe.fromRead({ found: false, name: 'A blog post', note: 'No nutrition here.' }, 'u');
  eq('found:false is not ok', readNone.ok, false);
  eq('and says why', readNone.reason, 'no-nutrition');
  eq('and is still marked as a reading', readNone.source, 'read');
  eq('rubbish in', Recipe.fromRead(null, 'u').ok, false);

  check('the summary says the figures were read, not published',
    /Read off the page/.test(Recipe.summary(readOk)), Recipe.summary(readOk));
  check('and tells you to check them',
    /check it against the page/.test(Recipe.summary(readOk)));
  check('a declared result says no such thing',
    !/Read off the page/.test(Recipe.summary(bb)), Recipe.summary(bb));

  /* ---------- what people actually paste ---------- */

  eq('a bare domain gets a protocol', Recipe.tidyUrl('budgetbytes.com/x'), 'https://budgetbytes.com/x');
  eq('http is left alone', Recipe.tidyUrl('http://a.com/b'), 'http://a.com/b');
  eq('surrounding space is trimmed', Recipe.tidyUrl('  https://a.com/b  '), 'https://a.com/b');
  check('a real link passes', Recipe.looksLikeUrl('https://www.budgetbytes.com/x/'));
  check('a search phrase does not', !Recipe.looksLikeUrl('chicken tikka masala'));
  check('a bare word does not', !Recipe.looksLikeUrl('https://localhost'));
  check('an empty string does not', !Recipe.looksLikeUrl(''));

  /* ---------- a photographed nutrition panel ----------

     Same tool, same response shape and the same fromRead as a page
     read; what differs is where the numbers came from, and the app
     never lets the three sources look alike. */

  var LABEL = {
    found: true,
    name: 'Chobani Greek Yogurt, Plain 0%',
    serving: '1 container (150 g)',
    servings: 1,
    kcal: 90, protein: 16, carbs: 6, fat: 0,
    fiber: 0, sugar: 4, satFat: 0, sodium: 65, chol: 10,
    potassium: 240, calcium: 190, iron: 0, vitD: 0
  };

  var lab = Recipe.fromRead(LABEL, null, 'label');
  check('a label read is complete', lab.ok === true, JSON.stringify(lab.missing));
  check('the label names the source', lab.source === 'label', lab.source);
  check('the product name comes through', lab.name === 'Chobani Greek Yogurt, Plain 0%', lab.name);
  check('the stated serving is kept verbatim',
    lab.servingLabel === '1 container (150 g)', lab.servingLabel);
  eq('calories per serving', lab.per.kcal, 90);
  eq('protein per serving', lab.per.protein, 16);
  check('the panel brings its micronutrients',
    lab.micros && lab.micros.sodium === 65 && lab.micros.calcium === 190,
    JSON.stringify(lab.micros));
  check('a zero on the panel is a zero, not a gap',
    lab.micros.fiber === 0 && lab.micros.vitD === 0, JSON.stringify(lab.micros));

  /* The whole point of the route: fields nobody types by hand. */
  check('every micronutrient the panel printed is carried',
    Object.keys(lab.micros).sort().join(',') ===
      'calcium,chol,fiber,iron,potassium,satFat,sodium,sugar,vitD',
    Object.keys(lab.micros).sort().join(','));

  /* A field the panel does not print stays absent. A US panel prints
     no vitamin C any more, and inventing one would be worse than the
     gap it fills. */
  check('an unprinted nutrient is absent rather than zero',
    !('vitC' in lab.micros), JSON.stringify(lab.micros));

  /* Source is what the summary leads with, because it is what tells
     the person how hard to look at the numbers. */
  check('the summary says it came off the label',
    Recipe.summary(lab).indexOf('Read off the label') === 0, Recipe.summary(lab));
  check('the summary asks for a glance at the panel',
    Recipe.summary(lab).indexOf('check it against the panel') > 0, Recipe.summary(lab));
  /* "makes 1" is recipe language. A one-serving tub says nothing. */
  check('a single-serving package does not announce its serving count',
    Recipe.summary(lab).indexOf('makes') < 0 && Recipe.summary(lab).indexOf('package') < 0,
    Recipe.summary(lab));
  var box = Recipe.fromRead({
    found: true, name: 'Cereal', serving: '1 cup (40 g)', servings: 12,
    kcal: 150, protein: 3, carbs: 33, fat: 1
  }, null, 'label');
  check('a multi-serving package counts them the way a package would',
    Recipe.summary(box).indexOf('12 servings in the package') > 0, Recipe.summary(box));
  check('a recipe still says makes',
    Recipe.summary(Recipe.fromRead({
      found: true, name: 'Stew', serving: '1 bowl', servings: 6,
      kcal: 400, protein: 30, carbs: 20, fat: 18
    }, 'https://x.test')).indexOf('makes 6') > 0);
  check('a page read still says page',
    Recipe.summary(Recipe.fromRead(LABEL, 'https://x.test', 'read'))
      .indexOf('Read off the page') === 0);
  check('fromRead still defaults to a page read',
    Recipe.fromRead(LABEL, 'https://x.test').source === 'read');

  /* Nothing readable in the photo. Not an error — an answer. */
  var noPanel = Recipe.fromRead({ found: false, name: '', note: 'A cat.' }, null, 'label');
  check('an unreadable photo is not ok', noPanel.ok === false);
  check('an unreadable photo keeps the label source', noPanel.source === 'label');
  check('and says what to do about it',
    Recipe.summary(noPanel).indexOf('Fill the frame with the panel') > 0,
    Recipe.summary(noPanel));
  check('a page with no nutrition still gets the page sentence',
    Recipe.summary(Recipe.fromRead({ found: false, name: 'Stew' }, 'https://x.test'))
      .indexOf('does not publish nutrition') > 0);

  /* A panel photographed at an angle can lose a line. What survives
     should still land, with the gap named rather than filled. */
  var partial = Recipe.fromRead({
    found: true, name: 'Bar', serving: '1 bar (40 g)', protein: 10, carbs: 22, fat: 7
  }, null, 'label');
  check('a missing calorie line is derived from the macros',
    partial.kcalDerived === true && partial.per.kcal === 191, partial.per.kcal);
  check('and the derivation is not hidden',
    Recipe.summary(partial).indexOf('calories from the macros') > 0, Recipe.summary(partial));

  var noMacros = Recipe.fromRead({
    found: true, name: 'Bar', serving: '1 bar', kcal: 190
  }, null, 'label');
  check('missing macros are listed rather than guessed',
    noMacros.ok === false && noMacros.missing.join(',') === 'protein,carbs,fat',
    noMacros.missing.join(','));
  check('nothing readable means no micro panel at all', noMacros.micros === null);

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
