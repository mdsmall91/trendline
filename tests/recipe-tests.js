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

  /* ---------- what people actually paste ---------- */

  eq('a bare domain gets a protocol', Recipe.tidyUrl('budgetbytes.com/x'), 'https://budgetbytes.com/x');
  eq('http is left alone', Recipe.tidyUrl('http://a.com/b'), 'http://a.com/b');
  eq('surrounding space is trimmed', Recipe.tidyUrl('  https://a.com/b  '), 'https://a.com/b');
  check('a real link passes', Recipe.looksLikeUrl('https://www.budgetbytes.com/x/'));
  check('a search phrase does not', !Recipe.looksLikeUrl('chicken tikka masala'));
  check('a bare word does not', !Recipe.looksLikeUrl('https://localhost'));
  check('an empty string does not', !Recipe.looksLikeUrl(''));

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
