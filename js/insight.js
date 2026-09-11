'use strict';

/* =============================================================
   TRENDLINE — WHAT IS ACTUALLY WORKING

   One question: of the things this person does, which ones travel
   with progress?

   ---------------------------------------------------------------
   THE METHOD, AND WHAT IT REFUSES TO CLAIM

   For every day that has a trend weight, measure how the trend moved
   over the week CENTRED on that day — three days either side. That is
   the outcome. Split the days by whether some behaviour was true —
   water goal met, trained, protein floor hit, weighed in, a habit
   ticked — and compare the two groups.

   Centred rather than forward-looking, and the reason is not
   philosophical. A strictly forward window inverts on any behaviour
   with a weekly rhythm: do a thing every other week, and the seven
   days after each of those days are mostly the week you did not do it.
   The measure then reports the opposite of the truth with perfect
   confidence. A centred window attributes the movement to the days
   around it, which is also the honest claim — what you eat and do on
   Tuesday shows up either side of Tuesday, not neatly after it.

   That is an association and it is never called anything else. The
   sentence this produces is "on the days you did X, the following week
   moved faster", not "X works". Three reasons, all of them permanent:

     - Nobody is randomising anything. The weeks you trained are also
       the weeks you slept, ate and felt differently.
     - The forward windows overlap, so consecutive days are not
       independent observations. The counts here are days, not
       experiments, and no p-value is computed because one would be
       wrong.
     - Reverse causation is live. Weighing yourself more often on the
       weeks that are going well is at least as plausible as the weighing
       causing it.

   What stops this being astrology is the refusals. A behaviour has to
   have happened, and not happened, on enough days AND across enough
   separate weeks before it can be compared at all — one good fortnight
   cannot manufacture a finding. The effect has to clear a floor that
   is well above the noise in a bodyweight trend. Everything else
   returns nothing, and nothing is the correct answer far more often
   than it is a disappointing one.

   Pure: it takes the days rather than reading storage, so every rule
   above is testable without a browser. js/ui.js assembles the input.
   ============================================================= */

var Insight = (function () {

  /* A week is the shortest window over which a bodyweight trend says
     anything at all — shorter and you are reading water. Three days
     either side of the day in question. */
  var HALF_WINDOW = 3;
  var WINDOW_DAYS = HALF_WINDOW * 2;

  /* Both sides of every comparison have to clear these. Days alone are
     not enough: eight consecutive days of a behaviour is one week of
     your life, and one week is an anecdote. Requiring three separate
     calendar weeks is what stops a single good stretch — a holiday, an
     illness, a fortnight of unusual discipline — from being read as a
     habit that works. */
  var MIN_DAYS_PER_SIDE = 8;
  var MIN_WEEKS_PER_SIDE = 3;

  /* Below this the difference is indistinguishable from the ordinary
     wobble of an EWMA trend, and reporting it would be reporting
     noise. A fifth of a pound a week is already generous. */
  var MIN_EFFECT_LB_WK = 0.2;

  /* A trend value is interpolated between weigh-ins. Seven days either
     side of a real reading is a reading; three weeks either side is a
     straight line drawn through a hole. */
  var MAX_DAYS_FROM_WEIGH_IN = 4;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* Day keys are YYYY-MM-DD. Built at UTC noon so no daylight-saving
     boundary can shift a day into the one before it. */
  function dayNumber(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], 12) / 86400000);
  }

  /* Which week a day falls in, as an integer. Only used to count how
     many DISTINCT weeks a group spans, so the epoch it counts from
     does not matter. */
  function weekNumber(key) {
    var d = dayNumber(key);
    return d === null ? null : Math.floor(d / 7);
  }

  /* ---------------------------------------------------------------
     THE BEHAVIOURS

     Each answers true, false, or null for a day. Null means the day
     cannot speak to it — no water goal set, no protein target, nothing
     logged — and those days are dropped from that comparison rather
     than counted as a no. "Did not do it" and "did not record it" are
     different facts and this app has never let them look alike.
     --------------------------------------------------------------- */

  function behaviours(days, habitNames) {
    var list = [
      {
        id: 'weighed',
        label: 'weighed yourself',
        of: function (d) { return !!d.weighed; }
      },
      {
        id: 'logged',
        label: 'logged your food',
        of: function (d) { return !!d.logged; }
      },
      {
        id: 'under-target',
        label: 'came in under your calorie target',
        of: function (d) {
          if (!d.logged || !isNum(d.kcal) || !isNum(d.target)) return null;
          return d.kcal <= d.target;
        }
      },
      {
        id: 'protein',
        label: 'hit your protein target',
        of: function (d) {
          if (!d.logged || !isNum(d.protein) || !isNum(d.proteinTarget) || d.proteinTarget <= 0) return null;
          return d.protein >= d.proteinTarget;
        }
      },
      {
        id: 'water',
        label: 'hit your water goal',
        of: function (d) {
          if (!isNum(d.water) || !isNum(d.waterGoal) || d.waterGoal <= 0) return null;
          return d.water >= d.waterGoal;
        }
      },
      {
        id: 'trained',
        label: 'trained',
        of: function (d) { return !!d.trained; }
      }
    ];

    /* Steps get a threshold read off the person rather than off the
       internet. Ten thousand is a 1960s Japanese pedometer slogan, and
       comparing somebody against it says more about the slogan than
       about them; comparing their busier days against their quieter
       ones is a question their own data can answer. */
    var counts = days.map(function (d) { return d.steps; })
      .filter(function (v) { return isNum(v) && v > 0; })
      .sort(function (a, b) { return a - b; });
    if (counts.length >= MIN_DAYS_PER_SIDE * 2) {
      var median = counts[Math.floor(counts.length / 2)];
      list.push({
        id: 'steps',
        label: 'walked more than usual',
        note: 'more than ' + Math.round(median / 100) * 100 + ' steps, your own middle',
        of: function (d) { return isNum(d.steps) && d.steps > 0 ? d.steps >= median : null; }
      });
    }

    Object.keys(habitNames || {}).forEach(function (id) {
      list.push({
        id: 'habit:' + id,
        label: 'ticked "' + habitNames[id] + '"',
        of: function (d) { return !!(d.habits && d.habits[id]); }
      });
    });

    return list;
  }

  /* ---------------------------------------------------------------
     THE OUTCOME

     How the trend moved over the week centred on a given day. Only
     computed where both ends sit near a real weigh-in, because an
     interpolated value is a guess between two readings and a rate
     built from two guesses is a guess about a guess.
     --------------------------------------------------------------- */

  function windowRates(days) {
    var trendAt = {}, weighDays = [];
    days.forEach(function (d) {
      var n = dayNumber(d.date);
      if (n === null) return;
      if (isNum(d.trend)) trendAt[n] = d.trend;
      if (d.weighed && isNum(d.trend)) weighDays.push(n);
    });
    if (weighDays.length < 2) return {};

    function nearWeighIn(n) {
      for (var i = 0; i < weighDays.length; i++) {
        if (Math.abs(weighDays[i] - n) <= MAX_DAYS_FROM_WEIGH_IN) return true;
      }
      return false;
    }

    var first = weighDays[0], last = weighDays[weighDays.length - 1];
    var out = {};
    days.forEach(function (d) {
      var n = dayNumber(d.date);
      if (n === null || !isNum(d.trend)) return;
      var a = n - HALF_WINDOW, b = n + HALF_WINDOW;
      /* Outside the weigh-ins the trend is held flat, so a change
         measured there is zero by construction rather than by fact. */
      if (a < first || b > last) return;
      if (!nearWeighIn(a) || !nearWeighIn(b)) return;
      if (!isNum(trendAt[a]) || !isNum(trendAt[b])) return;
      /* Scaled from six days to seven so the number reads as lb/week,
         which is the unit every other rate in this app is in. */
      out[d.date] = (trendAt[b] - trendAt[a]) * (7 / WINDOW_DAYS);
    });
    return out;
  }

  function mean(xs) {
    if (!xs.length) return null;
    var s = 0;
    for (var i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }

  function distinctWeeks(keys) {
    var seen = {}, n = 0;
    keys.forEach(function (k) {
      var w = weekNumber(k);
      if (w !== null && !seen[w]) { seen[w] = 1; n++; }
    });
    return n;
  }

  /* ---------------------------------------------------------------
     THE COMPARISON
     --------------------------------------------------------------- */

  function compare(behaviour, days, rates) {
    var withKeys = [], withoutKeys = [], withRates = [], withoutRates = [];

    days.forEach(function (d) {
      if (!(d.date in rates)) return;
      var v = behaviour.of(d);
      if (v === null || v === undefined) return;      /* the day cannot say */
      if (v) { withKeys.push(d.date); withRates.push(rates[d.date]); }
      else { withoutKeys.push(d.date); withoutRates.push(rates[d.date]); }
    });

    var out = {
      id: behaviour.id, label: behaviour.label, note: behaviour.note || '',
      n: { on: withRates.length, off: withoutRates.length },
      weeks: { on: distinctWeeks(withKeys), off: distinctWeeks(withoutKeys) }
    };

    if (out.n.on < MIN_DAYS_PER_SIDE || out.n.off < MIN_DAYS_PER_SIDE) {
      out.reason = 'too few days'; return out;
    }
    if (out.weeks.on < MIN_WEEKS_PER_SIDE || out.weeks.off < MIN_WEEKS_PER_SIDE) {
      /* Enough days, but they are bunched. One fortnight of doing a
         thing is not evidence that the thing does anything. */
      out.reason = 'not spread over enough weeks'; return out;
    }

    out.onRate = mean(withRates);
    out.offRate = mean(withoutRates);
    out.effect = out.onRate - out.offRate;   /* lb per week, signed */

    if (Math.abs(out.effect) < MIN_EFFECT_LB_WK) {
      out.reason = 'no difference worth reporting'; return out;
    }

    out.usable = true;
    return out;
  }

  /* ---------------------------------------------------------------
     WHAT COMES BACK

     Ranked by size of effect, damped by how thin the smaller side is —
     a big difference across nine days is a smaller claim than a
     moderate one across forty.
     --------------------------------------------------------------- */

  function observe(input) {
    input = input || {};
    var days = (input.days || []).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    var goalRate = isNum(input.goalRateLbPerWk) ? input.goalRateLbPerWk : 1;
    /* Which direction counts as progress. A negative forward rate is
       weight coming off; that is progress only if coming off is what
       was asked for. */
    var wantLoss = goalRate > 0;

    var rates = windowRates(days);
    var observations = Object.keys(rates).length;
    var all = behaviours(days, input.habitNames).map(function (b) {
      return compare(b, days, rates);
    });

    var usable = all.filter(function (r) { return r.usable; });
    usable.forEach(function (r) {
      /* "Helps" means the days it was true moved further toward the
         goal than the days it was not. */
      r.helps = wantLoss ? (r.effect < 0) : (r.effect > 0);
      r.magnitude = Math.abs(r.effect);
      var thinner = Math.min(r.n.on, r.n.off);
      r.weight = r.magnitude * Math.min(1, thinner / 20);
    });
    usable.sort(function (a, b) { return b.weight - a.weight; });

    return {
      findings: usable,
      /* Everything considered and why it was set aside, so the card can
         explain a quiet day rather than just being blank. */
      considered: all,
      observations: observations,
      ready: usable.length > 0,
      shortfall: shortfall(all, observations)
    };
  }

  /* What is missing, in the terms a person can act on. Named rather
     than counted: "keep logging" is not an instruction, "there are
     four days in the last fortnight with no food on them" is. */
  function shortfall(all, observations) {
    if (observations < MIN_DAYS_PER_SIDE * 2) {
      return {
        kind: 'span',
        need: 'weigh-ins spread over a few more weeks',
        detail: observations + ' of the days so far can be compared; this needs about ' +
          (MIN_DAYS_PER_SIDE * 2) + '.'
      };
    }
    var bunched = all.filter(function (r) { return r.reason === 'not spread over enough weeks'; });
    if (bunched.length) {
      return {
        kind: 'bunched',
        need: 'more weeks, not more days',
        detail: 'Some of what you do has enough days behind it but they all fall in the same ' +
          'stretch, which cannot separate the habit from the fortnight.'
      };
    }
    return {
      kind: 'flat',
      need: 'nothing — there is simply no difference yet',
      detail: 'Everything with enough data behind it moved the trend by about the same amount.'
    };
  }

  return {
    /* pure — unit tested in tests/insight-tests.html */
    observe: observe, behaviours: behaviours, windowRates: windowRates,
    compare: compare, dayNumber: dayNumber, weekNumber: weekNumber,
    WINDOW_DAYS: WINDOW_DAYS, MIN_DAYS_PER_SIDE: MIN_DAYS_PER_SIDE,
    MIN_WEEKS_PER_SIDE: MIN_WEEKS_PER_SIDE, MIN_EFFECT_LB_WK: MIN_EFFECT_LB_WK
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Insight;
