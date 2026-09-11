'use strict';

/* Tests for the behaviour/outcome analysis. Pure functions only — the
   days are built here rather than read from storage, so every refusal
   this module makes is checked without a browser.

   Most of these test what it DECLINES to say. That is the point of it:
   the analysis is a correlation over a few dozen overlapping windows,
   and the only thing keeping it honest is the list of cases where it
   returns nothing. */

(function (root) {
  var Insight = root.Insight || require('../js/insight.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function near(name, got, want, tol) {
    check(name, got !== null && got !== undefined && Math.abs(got - want) <= (tol || 0.001),
      got + ' vs ' + want);
  }

  function key(i) {
    var d = new Date(Date.UTC(2026, 0, 5, 12));   /* a Monday */
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  }

  /* days(n, fn) where fn(i) returns { delta, on } — delta is how much
     the trend moved that day, on is whether the behaviour happened. */
  function build(n, fn, extra) {
    var out = [], trend = 200;
    for (var i = 0; i < n; i++) {
      var spec = fn(i) || {};
      trend += (spec.delta || 0);
      var d = {
        date: key(i), trend: trend, weighed: spec.weighed !== false,
        logged: true, kcal: 2000, target: 2200,
        protein: 150, proteinTarget: 150,
        water: 64, waterGoal: 64, steps: 8000,
        trained: false, habits: {}
      };
      if (spec.on) d.habits.h1 = true;
      if (extra) extra(d, i, spec);
      out.push(d);
    }
    return out;
  }

  var HABITS = { h1: 'Walk after dinner' };

  function find(res, id) {
    for (var i = 0; i < res.considered.length; i++) {
      if (res.considered[i].id === id) return res.considered[i];
    }
    return null;
  }

  /* ---------- a real difference, properly spread ---------- */

  /* Alternating weeks: the behaviour happens for seven days, then not
     for seven, over twelve weeks. On-weeks lose three tenths of a pound
     a day, off-weeks hold. */
  var alternating = build(84, function (i) {
    var onWeek = Math.floor(i / 7) % 2 === 0;
    return { on: onWeek, delta: onWeek ? -0.3 : 0 };
  });
  var alt = Insight.observe({ days: alternating, habitNames: HABITS, goalRateLbPerWk: 1 });

  check('a spread-out difference is reported', alt.ready === true,
    JSON.stringify(alt.shortfall));
  var habit = find(alt, 'habit:h1');
  check('the habit is the finding', habit && habit.usable === true,
    habit && habit.reason);
  check('it is named in words a person recognises',
    habit.label === 'ticked "Walk after dinner"', habit.label);
  check('the days it happened lost faster', habit.effect < 0, habit.effect);
  check('and that counts as helping, given a loss goal', habit.helps === true);
  check('both sides carry enough days',
    habit.n.on >= Insight.MIN_DAYS_PER_SIDE && habit.n.off >= Insight.MIN_DAYS_PER_SIDE,
    JSON.stringify(habit.n));
  check('and span enough separate weeks',
    habit.weeks.on >= Insight.MIN_WEEKS_PER_SIDE && habit.weeks.off >= Insight.MIN_WEEKS_PER_SIDE,
    JSON.stringify(habit.weeks));

  /* The same data read by somebody trying to gain: the direction of
     "good" is the goal's, not the analysis's. */
  var gaining = Insight.observe({ days: alternating, habitNames: HABITS, goalRateLbPerWk: -1 });
  check('losing faster is not help when the goal is to gain',
    find(gaining, 'habit:h1').helps === false);

  /* ---------- the refusals ---------- */

  /* Enough days, all in one stretch. This is the guard that matters
     most: a fortnight of unusual discipline is not a habit. */
  /* Ten consecutive days STARTING on a week boundary, so they fall in
     two buckets rather than three. Found rather than hardcoded: which
     index is a boundary depends on the epoch, and a test that silently
     stops testing its own guard is worse than no test. */
  var boundary = 0;
  for (var bi = 1; bi < 14; bi++) {
    if (Insight.weekNumber(key(bi)) !== Insight.weekNumber(key(bi - 1))) { boundary = bi; break; }
  }
  var runStart = boundary + 14;
  var bunched = build(84, function (i) {
    var on = i >= runStart && i < runStart + 10;   /* ten days, two buckets */
    return { on: on, delta: on ? -0.3 : 0 };
  });
  var bun = find(Insight.observe({ days: bunched, habitNames: HABITS, goalRateLbPerWk: 1 }), 'habit:h1');
  check('ten days in one stretch is not enough weeks',
    bun.usable !== true && bun.reason === 'not spread over enough weeks', bun.reason);
  check('and it says so with the week counts', bun.weeks.on < Insight.MIN_WEEKS_PER_SIDE,
    JSON.stringify(bun.weeks));

  var rare = build(84, function (i) {
    var on = (i % 21) === 0;                       /* four days, well spread */
    return { on: on, delta: on ? -0.3 : 0 };
  });
  var rr = find(Insight.observe({ days: rare, habitNames: HABITS, goalRateLbPerWk: 1 }), 'habit:h1');
  check('four days is too few however well spread',
    rr.usable !== true && rr.reason === 'too few days', rr.reason);

  /* Spread, plentiful, and making no difference. */
  var flat = build(84, function (i) {
    return { on: Math.floor(i / 7) % 2 === 0, delta: -0.15 };
  });
  var fl = Insight.observe({ days: flat, habitNames: HABITS, goalRateLbPerWk: 1 });
  check('an even trend produces no finding', fl.ready === false);
  check('and says the reason is that nothing differs',
    find(fl, 'habit:h1').reason === 'no difference worth reporting',
    find(fl, 'habit:h1').reason);
  check('the shortfall names it as flat rather than thin',
    fl.shortfall.kind === 'flat', JSON.stringify(fl.shortfall));

  /* A behaviour that never varies has nothing to compare. */
  var always = build(84, function () { return { on: true, delta: -0.15 }; });
  check('a behaviour with no off-days is not compared',
    find(Insight.observe({ days: always, habitNames: HABITS, goalRateLbPerWk: 1 }), 'habit:h1')
      .usable !== true);

  /* ---------- "did not do it" versus "did not record it" ---------- */

  var noWater = build(84, function (i) {
    return { on: Math.floor(i / 7) % 2 === 0, delta: -0.15 };
  }, function (d, i) {
    /* No goal set at all: the day cannot answer the water question. */
    d.waterGoal = null;
    d.water = null;
  });
  var w = find(Insight.observe({ days: noWater, habitNames: {}, goalRateLbPerWk: 1 }), 'water');
  check('a day with no water goal is dropped, not counted as a miss',
    w.n.on === 0 && w.n.off === 0, JSON.stringify(w.n));

  var someLogged = build(84, function (i) {
    return { on: false, delta: -0.15 };
  }, function (d, i) {
    if (i % 2) { d.logged = false; d.kcal = null; d.protein = null; }
  });
  var ut = find(Insight.observe({ days: someLogged, habitNames: {}, goalRateLbPerWk: 1 }), 'under-target');
  check('an unlogged day cannot say whether you came in under target',
    ut.n.on + ut.n.off <= 42, JSON.stringify(ut.n));

  /* ---------- the outcome measure ---------- */

  var short = build(10, function () { return { delta: -0.1 }; });
  var rates = Insight.windowRates(short);
  check('no rate is computed where the window runs past the weigh-ins',
    Object.keys(rates).join(',') === [key(3), key(4), key(5), key(6)].join(','),
    Object.keys(rates).join(','));
  near('a rate is the trend across the week centred on the day',
    rates[key(3)], -0.7, 0.0001);

  var gappy = build(40, function (i) {
    /* Weighed only on the first and last day: everything between is
       interpolation across five weeks. */
    return { delta: -0.1, weighed: (i === 0 || i === 39) };
  });
  check('a long gap between weigh-ins produces no rates at all',
    Object.keys(Insight.windowRates(gappy)).length === 0,
    Object.keys(Insight.windowRates(gappy)).length);

  /* ---------- ranking ---------- */

  var two = build(84, function (i) {
    var onWeek = Math.floor(i / 7) % 2 === 0;
    return { on: onWeek, delta: onWeek ? -0.4 : 0 };
  }, function (d, i) {
    /* A second behaviour that tracks the first but is recorded on far
       fewer days, so it carries the same effect on thinner evidence. */
    d.trained = (Math.floor(i / 7) % 2 === 0) && (i % 7) < 3;
  });
  var ranked = Insight.observe({ days: two, habitNames: HABITS, goalRateLbPerWk: 1 });
  check('more than one finding can come back', ranked.findings.length >= 1);
  check('findings are ordered by how much they are worth',
    ranked.findings.every(function (f, i, a) { return i === 0 || a[i - 1].weight >= f.weight; }),
    ranked.findings.map(function (f) { return f.id + ':' + f.weight.toFixed(2); }).join(' '));

  /* ---------- nothing at all ---------- */

  var empty = Insight.observe({ days: [], habitNames: {}, goalRateLbPerWk: 1 });
  check('no days is not ready', empty.ready === false);
  check('and asks for weigh-ins over more weeks', empty.shortfall.kind === 'span',
    JSON.stringify(empty.shortfall));
  check('no input at all is safe', Insight.observe().ready === false);
  check('a day with no trend is skipped rather than thrown on',
    Insight.observe({ days: [{ date: key(0) }, { date: key(1), trend: 200 }] }).ready === false);
  check('a malformed date has no day number', Insight.dayNumber('2026-1-5') === null);
  check('days a week apart are one week apart',
    Insight.weekNumber(key(7)) - Insight.weekNumber(key(0)) === 1);

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
