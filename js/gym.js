'use strict';

/* =============================================================
   TRENDLINE — GYM CATALOG

   Reads the curated exercise catalog, session templates and this
   gym's real equipment, and answers the questions the UI asks:
   what can I train for this muscle, what can I swap this for, and
   what loads can I actually select.

   Everything below the loader is a pure function over data already
   in memory, so it is all unit-testable without a network.

   The catalog is lazy-loaded — 59KB that only matters once the
   Train tab is opened, and there is no reason to spend it on a
   launch that goes straight to logging breakfast.
   ============================================================= */

var Gym = (function () {

  var cat = null, tpl = null, kit = null;
  var loading = null;

  /* ---------------------------------------------------------------
     LOADING
     --------------------------------------------------------------- */

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ')');
      return r.json();
    });
  }

  function load() {
    if (cat && tpl && kit) return Promise.resolve(true);
    if (loading) return loading;
    loading = Promise.all([
      getJSON('data/exercises.json'),
      getJSON('data/workouts.json'),
      getJSON('data/equipment.json')
    ]).then(function (r) {
      cat = r[0]; tpl = r[1]; kit = r[2];
      return true;
    }).catch(function (e) {
      loading = null;
      throw e;
    });
    return loading;
  }

  function ready() { return !!(cat && tpl && kit); }
  function catalog() { return cat; }
  function equipment() { return kit; }

  function exercises() { return (cat && cat.exercises) || []; }
  function sessions() { return (tpl && tpl.sessions) || []; }
  function programs() { return (tpl && tpl.programs) || []; }

  function byId(id) {
    var list = exercises();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function name(id) {
    var e = byId(id);
    return e ? e.name : id;
  }

  /* ---------------------------------------------------------------
     SEARCH

     One box. Typing a body part browses that shelf; typing anything
     else searches names and aliases. That is the whole interaction —
     a filter panel with six dropdowns is a filter panel nobody opens
     standing between sets.
     --------------------------------------------------------------- */

  function norm(s) { return String(s || '').trim().toLowerCase(); }

  /* Cardio machines list quadriceps and gluteus maximus as primary,
     which is true and unhelpful: nobody searching "glutes" wants the
     elliptical. Excluding them reproduces the catalog's own published
     coverage table exactly, so this is the documented intent rather
     than a convenient fudge. */
  function isCardio(e) { return e.body_part === 'cardio'; }

  /* A body part, or an alias for one ("arms", "abs", "butt"). */
  function bodyPartTerm(q) {
    var t = norm(q);
    var tax = (cat && cat.taxonomy) || {};
    var parts = tax.body_parts || [];
    var aliases = tax.body_part_aliases || {};
    if (parts.indexOf(t) >= 0) return [t];
    if (aliases[t]) return aliases[t];
    return null;
  }

  function musclesFor(parts) {
    var map = (cat && cat.taxonomy && cat.taxonomy.body_part_muscles) || {};
    var out = {};
    (parts || []).forEach(function (p) {
      (map[p] || []).forEach(function (m) { out[m] = 1; });
    });
    return out;
  }

  function hits(list, muscles) {
    for (var i = 0; i < list.length; i++) if (muscles[list[i]]) return true;
    return false;
  }

  /* Returns { mode, primary, secondary }.

     mode 'muscle'  a body part was recognised; secondary is the
                    "also involved" shelf, kept separate because an
                    exercise that merely assists is not an answer to
                    "what should I do for biceps".
     mode 'text'    free text over names and aliases.
     mode 'all'     empty query. */
  function search(query, opts) {
    opts = opts || {};
    var q = norm(query);
    var pool = exercises().filter(function (e) {
      if (opts.equipmentOnly && !available(e)) return false;
      return true;
    });

    if (!q) {
      return { mode: 'all', query: q, primary: pool.slice(), secondary: [] };
    }

    var parts = bodyPartTerm(q);
    if (parts) {
      /* "cardio" is a real shelf, so asking for it by name should
         still return the machines — the exclusion is only about them
         leaking into muscle searches for legs. */
      if (parts.length === 1 && parts[0] === 'cardio') {
        return {
          mode: 'muscle', query: q,
          primary: pool.filter(isCardio), secondary: []
        };
      }
      var muscles = musclesFor(parts);
      var body = pool.filter(function (e) { return !isCardio(e); });
      return {
        mode: 'muscle', query: q,
        primary: body.filter(function (e) { return hits(e.primary_muscles || [], muscles); }),
        secondary: body.filter(function (e) {
          return !hits(e.primary_muscles || [], muscles) &&
            hits(e.secondary_muscles || [], muscles);
        })
      };
    }

    var text = pool.filter(function (e) {
      if (norm(e.name).indexOf(q) >= 0) return true;
      var al = e.aliases || [];
      for (var i = 0; i < al.length; i++) if (norm(al[i]).indexOf(q) >= 0) return true;
      /* Movement pattern and equipment are searchable too: "hinge",
         "dumbbell" and "cable" are all things people actually type. */
      if (norm(e.movement_pattern).replace(/_/g, ' ').indexOf(q) >= 0) return true;
      var eq = e.equipment || [];
      for (var j = 0; j < eq.length; j++) {
        if (norm(eq[j]).replace(/_/g, ' ').indexOf(q) >= 0) return true;
      }
      return false;
    });
    return { mode: 'text', query: q, primary: text, secondary: [] };
  }

  /* ---------------------------------------------------------------
     AVAILABILITY AND SUBSTITUTION
     --------------------------------------------------------------- */

  function owned() {
    var list = (cat && cat.home_gym && cat.home_gym.equipment) || [];
    var out = {};
    list.forEach(function (k) { out[k] = 1; });
    return out;
  }

  function available(e) {
    var have = owned();
    var need = (e && e.equipment) || [];
    for (var i = 0; i < need.length; i++) if (!have[need[i]]) return false;
    return true;
  }

  /* Substitutions, resolved and labelled.

     `partial_alternative` is deliberately NOT presented as an equal
     swap. A bridge does not replace all the hamstring work in an RDL
     and a row does not replace rear-delt isolation; offering them
     silently is how a program quietly loses a movement. */
  function substitutes(id) {
    var e = byId(id);
    if (!e) return [];
    return (e.substitutions || []).map(function (s) {
      var t = byId(s.exercise_id);
      if (!t) return null;
      return {
        exercise: t,
        samePattern: s.relationship === 'same_pattern',
        reason: s.reason,
        available: available(t)
      };
    }).filter(Boolean);
  }

  /* ---------------------------------------------------------------
     LOADS

     What can actually be put on the bar in THIS room. A progression
     model that recommends 47.5 lb is a progression model nobody can
     follow, and the gap from a 15 to a 25 lb dumbbell is a 67% jump
     that has to be crossed with reps instead.
     --------------------------------------------------------------- */

  function uniqSorted(nums) {
    var seen = {}, out = [];
    nums.forEach(function (n) {
      if (n > 0 && !seen[n]) { seen[n] = 1; out.push(n); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function usesAny(e, list) {
    var eq = (e && e.equipment) || [];
    for (var i = 0; i < eq.length; i++) if (list.indexOf(eq[i]) >= 0) return true;
    return false;
  }

  /* The loads worth offering as one-tap choices for an exercise.

     Dumbbells return singles AND pairs, because the catalog says what
     equipment a movement needs but not how many hands are on it — a
     goblet squat is bilateral with one dumbbell, a press is bilateral
     with two. Offering both and letting the person tap the real one
     beats guessing wrong half the time. */
  function selectableLoads(e) {
    if (!e || !kit) return [];
    var out = [];

    if (usesAny(e, ['dumbbell'])) {
      var each = (kit.dumbbell && kit.dumbbell.each_lb) || [];
      out = out.concat(each);
      if (e.laterality !== 'unilateral') {
        out = out.concat(each.map(function (n) { return n * 2; }));
      }
    }
    if (usesAny(e, ['medicine_ball'])) {
      out = out.concat((kit.medicine_ball && kit.medicine_ball.each_lb) || []);
    }
    if (usesAny(e, ['hoist_weight_stack'])) {
      var max = (kit.hoist_weight_stack && kit.hoist_weight_stack.max_lb) || 200;
      for (var s = 10; s <= max; s += 10) out.push(s);
    }
    if (usesAny(e, ['weight_plates', 'curl_bar'])) {
      var cap = (kit.weight_plates && kit.weight_plates.total_available_lb) || 225;
      for (var p = 10; p <= Math.min(cap, 150); p += 10) out.push(p);
    }
    return uniqSorted(out);
  }

  /* How the number you set on the machine relates to what you lift.

     The bottom pulley splits the load, so 100 on the stack is about
     50 lb at a low-cable handle. Logs keep the DISPLAYED number
     because that is what gets dialled in next session; this exists so
     the effective figure can be shown beside it, and so a low-cable
     row is never compared against a high-cable pulldown as though the
     numbers meant the same thing. */
  function loadRatio(e) {
    if (!e || !kit || !kit.hoist_weight_stack) return 1;
    var ratios = kit.hoist_weight_stack.mechanical_ratio || {};
    var eq = e.equipment || [];
    for (var i = 0; i < eq.length; i++) {
      if (ratios[eq[i]] !== undefined) return ratios[eq[i]];
    }
    return 1;
  }

  /* Bars are not weightless, and there are two of them at different
     weights — the Hoist bar at 30 and the curl bar at 25. Recorded
     separately from the logged number so a corrected measurement never
     rewrites history, and never shared between the two: a curl-bar
     curl and a free-bar curl are different exercises with different
     strength histories despite both being "a bar". */
  function barWeight(e) {
    if (!e || !kit) return 0;
    if (usesAny(e, ['hoist_free_bar']) && kit.hoist_free_bar) {
      return kit.hoist_free_bar.bar_weight_lb || 0;
    }
    if (usesAny(e, ['curl_bar']) && kit.curl_bar) {
      return kit.curl_bar.bar_weight_lb || 0;
    }
    return 0;
  }

  /* What a logged number actually worked out to, for comparison over
     time. Never shown in place of the displayed load. */
  function effectiveLoad(e, displayed) {
    var d = Number(displayed);
    if (!isFinite(d) || d < 0) return null;
    return Math.round((d * loadRatio(e) + barWeight(e)) * 10) / 10;
  }

  function loadNote(e) {
    if (!e) return '';
    var r = loadRatio(e), b = barWeight(e);
    if (r !== 1 && b) return 'Low cable halves the load; the bar adds about ' + b + ' lb.';
    if (r !== 1) return 'The bottom pulley halves this — 100 on the stack is about 50 lb at the handle.';
    if (b) return 'The bar is about ' + b + ' lb on its own, on top of the stack setting.';
    return '';
  }

  return {
    load: load, ready: ready, catalog: catalog, equipment: equipment,
    exercises: exercises, sessions: sessions, programs: programs,
    byId: byId, name: name,
    search: search, available: available, substitutes: substitutes,
    selectableLoads: selectableLoads, loadRatio: loadRatio, barWeight: barWeight,
    effectiveLoad: effectiveLoad, loadNote: loadNote,
    /* exposed for tests, which inject fixtures rather than fetching */
    _inject: function (c, t, k) { cat = c; tpl = t; kit = k; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Gym;
