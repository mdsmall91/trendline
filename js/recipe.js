'use strict';

/* =============================================================
   TRENDLINE — RECIPES FROM A LINK

   Paste the URL of a recipe you found and get its nutrition into
   your library without typing it.

   ---------------------------------------------------------------
   THIS IS NOT SCRAPING

   Recipe sites publish their nutrition as structured data — a
   schema.org Recipe object in a <script type="application/ld+json">
   tag — because that is what puts the calorie count into a Google
   result. It is a published, versioned, machine-readable field, not
   something prised out of the page's appearance. Four of the four
   sites tested carried a complete set.

   So this module reads declared fields. It never guesses from prose,
   never reads the ingredient list, and never computes what the site
   did not state. When a site publishes nothing, the answer is "this
   page doesn't publish nutrition" — not a number invented to fill
   the box.

   ---------------------------------------------------------------
   SCHEMA.ORG NUTRITION IS PER SERVING

   That is the spec, and every site tested honours it: calories 415.88
   on a recipe yielding 6 means 415.88 per portion. So the numbers
   land straight in a food record with no arithmetic at all.

   The servings count is only needed to state the total, and it is the
   one field sites get loose with — recipeYield is sometimes portions
   ("6"), sometimes volume ("2 cups"), sometimes both. See
   servingsFrom() for how that is resolved, and note that the result
   carries whether it was resolved confidently. A serving count that
   is really a cup count would be wrong by a factor of four, so the
   app says which one it has rather than quietly picking.

   The fetch itself lives in a Supabase Edge Function, because a
   browser cannot read another site's page. Everything above it is
   pure and unit tested against saved fixtures from real pages.
   ============================================================= */

var Recipe = (function () {

  /* ---------------------------------------------------------------
     READING NUMBERS OUT OF STRINGS

     Nutrition values arrive as text with a unit stuck to them:
     "415.88 kcal", "37.03 g", "978.77 mg", "151 calories", and
     occasionally "1,020 mg". A bare number is legal too.
     --------------------------------------------------------------- */

  function qty(v) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? v : null;
    if (typeof v !== 'string') return null;
    var m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    var n = Number(m[0]);
    return (isFinite(n) && n >= 0) ? n : null;
  }

  /* Sodium and cholesterol are stated in milligrams by convention,
     but a few sites write "0.9 g". Reading the unit costs one regex
     and avoids being wrong by a thousand. */
  function mg(v) {
    var n = qty(v);
    if (n === null) return null;
    if (typeof v === 'string' && /\d\s*(?:g|gram)/i.test(v) && !/\d\s*mg/i.test(v)) return n * 1000;
    return n;
  }

  function round(v, dp) {
    if (v === null || v === undefined) return null;
    var f = Math.pow(10, dp || 0);
    return Math.round(v * f) / f;
  }

  /* ---------------------------------------------------------------
     FINDING THE RECIPE

     A page's JSON-LD is rarely a bare Recipe. It is usually an array,
     or a @graph of a dozen nodes — WebSite, Organization, BreadcrumbList,
     Article, and somewhere in there the Recipe. So: walk everything and
     take the first node whose @type includes Recipe.

     @type comparison is case-insensitive because one tested site
     writes "nutritionInformation" with a small n, and a parser that
     insists on the spelling in the spec finds nothing on a page that
     plainly has the data.
     --------------------------------------------------------------- */

  function typeIs(node, want) {
    if (!node || typeof node !== 'object') return false;
    var t = node['@type'];
    var list = Array.isArray(t) ? t : [t];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toLowerCase() === want.toLowerCase()) return true;
    }
    return false;
  }

  function findRecipe(node, depth) {
    depth = depth || 0;
    if (depth > 8 || !node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var r = findRecipe(node[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeIs(node, 'Recipe')) return node;
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      var v = node[keys[k]];
      if (v && typeof v === 'object') {
        var found = findRecipe(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /* One block of page text to a parsed object, or null. Invalid JSON is
     common enough in the wild — a trailing comma, an unescaped newline —
     that a bad block must not take the good one down with it. */
  function parseBlock(text) {
    if (typeof text !== 'string') return null;
    var s = text.replace(/^\s*\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>\s*$/, '');
    s = s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function recipeFromBlocks(blocks) {
    var list = Array.isArray(blocks) ? blocks : [blocks];
    for (var i = 0; i < list.length; i++) {
      var parsed = typeof list[i] === 'string' ? parseBlock(list[i]) : list[i];
      if (!parsed) continue;
      var r = findRecipe(parsed, 0);
      if (r) return r;
    }
    return null;
  }

  /* ---------------------------------------------------------------
     HOW MANY SERVINGS

     recipeYield is the loosest field in the whole object. Observed, in
     one afternoon, across four sites:

       "4"                          portions, plainly
       ["6"]                        portions, in an array for no reason
       ["2", "2 cups (8 servings)"] TWO cups, EIGHT servings

     That last one is the case that matters. Taking the first value
     gives 2, and a recipe of 8 portions reported as 2 is wrong by 4x
     on anything derived from it.

     So: a candidate that says "servings" wins, wherever it sits in the
     list, because a site that spells the word is telling you the thing
     you actually asked. Only when nothing says it does a bare number
     get used, and then the result is marked unconfident — the app can
     show the yield text and let a person settle it, which is far
     better than a confident wrong four.
     --------------------------------------------------------------- */

  function yieldCandidates(y) {
    var out = [];
    (Array.isArray(y) ? y : [y]).forEach(function (v) {
      if (typeof v === 'number' && isFinite(v)) out.push(String(v));
      else if (typeof v === 'string' && v.trim()) out.push(v.trim());
      else if (v && typeof v === 'object' && v.value !== undefined) out.push(String(v.value));
    });
    return out;
  }

  function servingsFrom(y, servingSize) {
    var cands = yieldCandidates(y);
    var i, m;

    /* 1. Anything that names servings, portions or pieces. */
    for (i = 0; i < cands.length; i++) {
      m = cands[i].match(/(\d+(?:\.\d+)?)\s*(?:servings?|portions?|people|serves)/i);
      if (m) return { servings: Number(m[1]), confident: true, text: cands[i] };
    }
    /* "Serves 4" puts the number the other way round. */
    for (i = 0; i < cands.length; i++) {
      m = cands[i].match(/(?:serves|makes)\s+(?:about\s+)?(\d+(?:\.\d+)?)/i);
      if (m) return { servings: Number(m[1]), confident: true, text: cands[i] };
    }
    /* servingSize sometimes carries it instead: "Serves at least 2". */
    if (typeof servingSize === 'string') {
      m = servingSize.match(/(?:serves|servings?:?)\s+(?:at least\s+|about\s+)?(\d+(?:\.\d+)?)/i);
      if (m) return { servings: Number(m[1]), confident: true, text: servingSize };
    }

    /* 2. A candidate that is nothing but a number is a portion count;
          there is no other thing a lone integer on recipeYield means. */
    for (i = 0; i < cands.length; i++) {
      if (/^\d+(?:\.\d+)?$/.test(cands[i])) {
        return { servings: Number(cands[i]), confident: true, text: cands[i] };
      }
    }

    /* 3. A number with a unit — "2 cups", "1 loaf". Usable, but it is
          as likely to be volume as portions, so say so. */
    for (i = 0; i < cands.length; i++) {
      m = cands[i].match(/(\d+(?:\.\d+)?)/);
      if (m) return { servings: Number(m[1]), confident: false, text: cands[i] };
    }
    return { servings: null, confident: false, text: cands[0] || '' };
  }

  /* ---------------------------------------------------------------
     THE NUTRITION BLOCK
     --------------------------------------------------------------- */

  var ATWATER = { protein: 4, carbs: 4, fat: 9 };

  function nutritionOf(recipe) {
    var n = recipe && recipe.nutrition;
    if (!n || typeof n !== 'object') return null;
    if (Array.isArray(n)) n = n[0];
    return (n && typeof n === 'object') ? n : null;
  }

  function normalize(recipe, url) {
    if (!recipe) return { ok: false, reason: 'no-recipe' };

    var name = typeof recipe.name === 'string' ? recipe.name.trim() : '';
    if (!name && typeof recipe.headline === 'string') name = recipe.headline.trim();

    var image = recipe.image;
    if (Array.isArray(image)) image = image[0];
    if (image && typeof image === 'object') image = image.url;
    if (typeof image !== 'string') image = null;

    var n = nutritionOf(recipe);
    var y = servingsFrom(recipe.recipeYield, n && n.servingSize);

    if (!n) {
      /* The page has a recipe but publishes no nutrition. That is a
         real, common answer and it is worth returning properly: the
         name and the servings still save typing, and the person can
         fill in four numbers from the packet or the calculator of
         their choosing. */
      return {
        ok: false, reason: 'no-nutrition', name: name, url: url || null, image: image,
        servings: y.servings, servingsConfident: y.confident, yieldText: y.text
      };
    }

    var protein = qty(n.proteinContent);
    var carbs = qty(n.carbohydrateContent);
    var fat = qty(n.fatContent);
    var kcal = qty(n.calories);

    /* Calories from macros when the site omitted them, flagged so the
       UI can say where the number came from. Atwater is an
       approximation and the app has never pretended otherwise. */
    var derived = false;
    if (kcal === null && protein !== null && carbs !== null && fat !== null) {
      kcal = protein * ATWATER.protein + carbs * ATWATER.carbs + fat * ATWATER.fat;
      derived = true;
    }

    var missing = [];
    if (kcal === null) missing.push('calories');
    if (protein === null) missing.push('protein');
    if (carbs === null) missing.push('carbs');
    if (fat === null) missing.push('fat');

    return {
      ok: missing.length === 0,
      reason: missing.length ? 'incomplete' : null,
      name: name,
      url: url || null,
      image: image,
      /* Per serving, which is what schema.org means and what gets
         logged. Nothing here is multiplied by anything. */
      per: {
        kcal: round(kcal, 0),
        protein: round(protein, 1),
        carbs: round(carbs, 1),
        fat: round(fat, 1)
      },
      kcalDerived: derived,
      servings: y.servings,
      servingsConfident: y.confident,
      yieldText: y.text,
      servingLabel: typeof n.servingSize === 'string' && n.servingSize.trim()
        ? n.servingSize.trim() : '1 serving',
      /* Kept for the micronutrient work, and because a recipe that
         states 978 mg of sodium is telling you something a calorie
         count cannot. */
      extras: {
        fiber: round(qty(n.fiberContent), 1),
        sugar: round(qty(n.sugarContent), 1),
        satFat: round(qty(n.saturatedFatContent), 1),
        sodium: round(mg(n.sodiumContent), 0),
        cholesterol: round(mg(n.cholesterolContent), 0)
      },
      missing: missing
    };
  }

  /* The whole pure path: blocks of page text to a usable result. */
  function fromBlocks(blocks, url) {
    return normalize(recipeFromBlocks(blocks), url);
  }

  /* A one-line account of what came back, for the card. It says what
     is known and what is not, and never rounds a gap up to a fact. */
  function summary(r) {
    if (!r) return '';
    if (r.reason === 'no-recipe') return 'That page has no recipe data in it.';
    if (r.reason === 'no-nutrition') return 'That recipe does not publish nutrition. Name and servings filled in; the numbers are yours to add.';
    var bits = [];
    bits.push('Per serving' + (r.kcalDerived ? ', calories from the macros' : ''));
    if (r.servings) {
      bits.push(r.servingsConfident
        ? 'makes ' + r.servings
        : 'yield reads "' + r.yieldText + '", so check the serving count');
    }
    if (r.missing && r.missing.length) bits.push('missing ' + r.missing.join(' and '));
    return bits.join('  ·  ') + '.';
  }

  /* ---------------------------------------------------------------
     THE NETWORK HALF

     A browser cannot fetch another origin's page — that is the same
     rule that keeps a random site from reading your webmail, and it
     applies here even though the intent is innocent. So the fetch runs
     in a Supabase Edge Function that returns the page's structured
     data blocks and nothing else.

     The function is deliberately thin. It fetches and it extracts
     script tags. Every decision about what the data means happens
     above, in this file, where it can be tested without a network.
     --------------------------------------------------------------- */

  function looksLikeUrl(s) {
    return /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(String(s || '').trim());
  }

  /* People paste with the protocol missing more often than not. */
  function tidyUrl(s) {
    var u = String(s || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    return u;
  }

  function endpoint() {
    var c = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    if (!c.SUPABASE_URL) return null;
    return c.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/recipe';
  }

  function lookup(rawUrl) {
    var url = tidyUrl(rawUrl);
    if (!looksLikeUrl(url)) return Promise.reject(new Error('That does not look like a link.'));

    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('Sync is not set up, and the lookup runs through it.'));
    if (typeof Sync === 'undefined' || !Sync.signedIn()) {
      return Promise.reject(new Error('Sign in first — the lookup runs on your own account.'));
    }

    return Sync.accessToken().then(function (token) {
      return fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'apikey': CONFIG.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ url: url })
      });
    }).then(function (res) {
      if (res.status === 404) {
        throw new Error('The recipe reader is not installed on your Supabase project yet. See supabase/functions/README.md.');
      }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || ('The page could not be read (' + res.status + ').'));
        return body;
      });
    }).then(function (body) {
      return fromBlocks(body.blocks || [], body.url || url);
    });
  }

  return {
    /* pure — unit tested in tests/recipe-tests.html */
    qty: qty, mg: mg, parseBlock: parseBlock, findRecipe: findRecipe,
    servingsFrom: servingsFrom, recipeFromBlocks: recipeFromBlocks,
    normalize: normalize, fromBlocks: fromBlocks, summary: summary,
    looksLikeUrl: looksLikeUrl, tidyUrl: tidyUrl,
    /* network */
    endpoint: endpoint, lookup: lookup
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Recipe;
