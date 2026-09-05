'use strict';

/* =============================================================
   WEIGHT — CORE ENGINE
   Pure functions. No DOM, no storage, no globals beyond WL.
   Everything here is unit-tested in tests/tests.html.

   Units: weight in POUNDS, energy in KCAL, height in INCHES.
   Dates are 'YYYY-MM-DD' strings (local calendar days, no timezone math).
   ============================================================= */

var WL = (function () {

  /* Classic energy density of body mass change. An approximation — it
     overstates fat loss early (glycogen + water) and understates it late.
     Good enough for a personal adaptive loop that re-estimates weekly. */
  var KCAL_PER_LB = 3500;

  /* ---------------------------------------------------------------
     DATES
     --------------------------------------------------------------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Local calendar day key. Deliberately not toISOString(), which is UTC
     and rolls the date over for anyone west of Greenwich after 5pm. */
  function toKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fromKey(k) {
    var p = String(k).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function addDays(k, n) {
    var d = fromKey(k);
    d.setDate(d.getDate() + n);
    return toKey(d);
  }

  /* Whole days from a to b (b - a). Noon anchoring dodges DST hours. */
  function daysBetween(a, b) {
    var da = fromKey(a), db = fromKey(b);
    da.setHours(12, 0, 0, 0);
    db.setHours(12, 0, 0, 0);
    return Math.round((db - da) / 86400000);
  }

  function todayKey() { return toKey(new Date()); }

  /* ---------------------------------------------------------------
     TREND WEIGHT (exponentially weighted moving average)

     A single weigh-in is mostly noise: water, sodium, gut contents, and
     the time of day swing a real 180lb body by 3-4lb. The trend is the
     only number worth reacting to, so it is what drives every downstream
     calculation (rate, TDEE, projection).

     Gap handling: alpha is the per-DAY smoothing constant, so a weigh-in
     after a 5-day gap gets 1-(1-a)^5 of the pull. Without this, sporadic
     logging makes the trend lag arbitrarily far behind reality.
     --------------------------------------------------------------- */

  function trendSeries(points, alpha) {
    var a = (typeof alpha === 'number' && alpha > 0 && alpha < 1) ? alpha : 0.15;
    var sorted = points.slice().sort(function (x, y) {
      return x.date < y.date ? -1 : x.date > y.date ? 1 : 0;
    });
    var out = [], prev = null, prevKey = null;
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      if (typeof p.weight !== 'number' || !isFinite(p.weight)) continue;
      if (prev === null) {
        prev = p.weight;
      } else {
        var gap = Math.max(1, daysBetween(prevKey, p.date));
        var eff = 1 - Math.pow(1 - a, gap);
        prev = prev + eff * (p.weight - prev);
      }
      prevKey = p.date;
      out.push({ date: p.date, weight: p.weight, trend: prev });
    }
    return out;
  }

  /* Trend value on an arbitrary date: linear interpolation between the
     bracketing observations, flat-held outside the observed range. */
  function trendAt(series, key) {
    if (!series.length) return null;
    if (key <= series[0].date) return series[0].trend;
    if (key >= series[series.length - 1].date) return series[series.length - 1].trend;
    for (var i = 1; i < series.length; i++) {
      if (series[i].date >= key) {
        var a = series[i - 1], b = series[i];
        var span = daysBetween(a.date, b.date);
        if (span <= 0) return b.trend;
        var f = daysBetween(a.date, key) / span;
        return a.trend + f * (b.trend - a.trend);
      }
    }
    return series[series.length - 1].trend;
  }

  /* Rate of change in lb/week: least-squares slope of the trend over a
     trailing window. Regression rather than endpoint-minus-endpoint so a
     single odd weigh-in at either edge cannot swing the answer. */
  function trendRate(series, windowDays) {
    if (!series || series.length < 2) return null;
    var last = series[series.length - 1].date;
    var from = addDays(last, -(windowDays || 21));
    var pts = series.filter(function (p) { return p.date >= from; });
    if (pts.length < 2) return null;
    var span = daysBetween(pts[0].date, pts[pts.length - 1].date);
    if (span < 4) return null;   /* too short to mean anything */

    var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      var x = daysBetween(pts[0].date, pts[i].date), y = pts[i].trend;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return ((n * sxy - sx * sy) / denom) * 7;   /* lb/day -> lb/week */
  }

  /* ---------------------------------------------------------------
     BASELINE METABOLISM (only used until real data exists)
     --------------------------------------------------------------- */

  var ACTIVITY = {
    sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9
  };

  /* Mifflin-St Jeor. 'unspecified' sits midway between the two published
     constants rather than forcing a guess. */
  function bmr(profile) {
    var kg = (profile.weightLb || 0) * 0.45359237;
    var cm = (profile.heightIn || 0) * 2.54;
    var base = 10 * kg + 6.25 * cm - 5 * (profile.age || 30);
    if (profile.sex === 'male') return base + 5;
    if (profile.sex === 'female') return base - 161;
    return base - 78;
  }

  function baselineTDEE(profile) {
    var mult = ACTIVITY[profile.activity] || ACTIVITY.moderate;
    return bmr(profile) * mult;
  }

  /* ---------------------------------------------------------------
     ADAPTIVE TDEE

     Energy balance, run backwards. Over a window we know what went in
     (logged intake) and what the body did with it (trend weight change):

         TDEE = mean intake - (trend change in lb x 3500) / days

     Losing weight makes the change negative, which ADDS to the estimate.
     This is the one genuinely smart number in the app: it measures your
     actual metabolism instead of predicting it from a formula, and it
     silently absorbs everything a formula misses (NEAT, adaptation,
     chronic under-logging of intake).

     Two windows are blended so the estimate is responsive without being
     jumpy. Coverage gating means partial logging cannot quietly bias the
     answer downward.
     --------------------------------------------------------------- */

  function estimateTDEE(opts) {
    var series = opts.trend || [];
    var intake = opts.intake || {};          /* { 'YYYY-MM-DD': kcal } */
    var profile = opts.profile || {};
    var minCoverage = typeof opts.minCoverage === 'number' ? opts.minCoverage : 0.75;
    var end = opts.end || (series.length ? series[series.length - 1].date : null);
    var base = baselineTDEE(profile);

    if (!end || series.length < 2) {
      return { tdee: base, method: 'baseline', confidence: 'none', windows: [] };
    }

    function windowEstimate(days) {
      var start = addDays(end, -days);
      if (series[0].date > start) return null;          /* not enough history */

      var logged = 0, total = 0;
      for (var i = 1; i <= days; i++) {
        var k = addDays(start, i);
        var v = intake[k];
        if (typeof v === 'number' && v > 0) { logged++; total += v; }
      }
      var coverage = logged / days;
      if (coverage < minCoverage) return null;

      var w0 = trendAt(series, start), w1 = trendAt(series, end);
      if (w0 === null || w1 === null) return null;

      var meanIntake = total / logged;
      var est = meanIntake - ((w1 - w0) * KCAL_PER_LB) / days;
      return { days: days, tdee: est, coverage: coverage, meanIntake: meanIntake, deltaLb: w1 - w0 };
    }

    var short = windowEstimate(14), long = windowEstimate(28);
    var windows = [];
    if (short) windows.push(short);
    if (long) windows.push(long);

    var tdee, confidence;
    if (short && long) {
      tdee = 0.55 * short.tdee + 0.45 * long.tdee;
      confidence = 'high';
    } else if (long) {
      tdee = long.tdee; confidence = 'medium';
    } else if (short) {
      tdee = short.tdee; confidence = 'medium';
    } else {
      return { tdee: base, method: 'baseline', confidence: 'none', windows: [] };
    }

    /* Guard rail. A physiologically absurd estimate means the inputs are
       wrong (a mis-typed weight, a week of unlogged food), not that the
       metabolism is. Fall back rather than prescribe from bad data. */
    var b = bmr(profile);
    var lo = b * 0.9, hi = b * 2.6;
    var clamped = false;
    if (b > 0 && (tdee < lo || tdee > hi)) {
      tdee = Math.min(hi, Math.max(lo, tdee));
      clamped = true;
      confidence = 'low';
    }

    return {
      tdee: tdee, method: 'adaptive', confidence: confidence,
      clamped: clamped, windows: windows, baseline: base
    };
  }

  /* ---------------------------------------------------------------
     TARGETS
     --------------------------------------------------------------- */

  /* goalRateLbPerWk is positive for loss. The floor is the real safety
     rail: an aggressive goal on a small body otherwise prescribes a
     number nobody should eat, so the target is clamped and the achievable
     rate is reported back honestly instead of the requested one. */
  function dailyTarget(opts) {
    var tdee = opts.tdee;
    var rate = opts.goalRateLbPerWk || 0;
    var profile = opts.profile || {};
    var b = bmr(profile);
    var hardFloor = typeof opts.floorKcal === 'number' ? opts.floorKcal : 1200;
    var floor = Math.max(hardFloor, b);

    var raw = tdee - (rate * KCAL_PER_LB) / 7;
    var target = raw, clamped = false;
    if (raw < floor) { target = floor; clamped = true; }

    var actualRate = ((tdee - target) * 7) / KCAL_PER_LB;
    return {
      target: Math.round(target),
      requestedRate: rate,
      actualRate: actualRate,
      clamped: clamped,
      floor: Math.round(floor)
    };
  }

  /* Protein and fat are set per pound of bodyweight and carbs take the
     remainder — the standard approach, and the one that survives a
     changing calorie target. When protein + fat alone overshoot a very
     low target, fat gives way first: protein is the macro worth
     protecting on a deficit. */
  function macroTargets(opts) {
    var kcal = opts.targetKcal;
    var lb = opts.weightLb || 0;
    var pPerLb = typeof opts.proteinPerLb === 'number' ? opts.proteinPerLb : 0.8;
    var fPerLb = typeof opts.fatPerLb === 'number' ? opts.fatPerLb : 0.35;

    var p = lb * pPerLb, f = lb * fPerLb;
    if (p * 4 + f * 9 > kcal) {
      var room = kcal - p * 4;
      f = Math.max(lb * 0.2, room / 9);
      if (p * 4 + f * 9 > kcal) {
        f = Math.max(0, (kcal - p * 4) / 9);
        if (p * 4 > kcal) { p = kcal / 4; f = 0; }
      }
    }
    var c = Math.max(0, (kcal - p * 4 - f * 9) / 4);
    return { protein: Math.round(p), fat: Math.round(f), carbs: Math.round(c) };
  }

  /* ---------------------------------------------------------------
     FOOD MATH
     --------------------------------------------------------------- */

  function kcalFromMacros(p, c, f) {
    return (p || 0) * 4 + (c || 0) * 4 + (f || 0) * 9;
  }

  /* One logged line. kcal is stored per serving where known; where it is
     blank (a food entered as macros only) it is derived. */
  function lineTotals(line) {
    var q = typeof line.qty === 'number' ? line.qty : 1;
    var p = (line.protein || 0) * q, c = (line.carbs || 0) * q, f = (line.fat || 0) * q;
    var kcal = (typeof line.kcal === 'number' && line.kcal > 0)
      ? line.kcal * q
      : kcalFromMacros(p, c, f);
    return { kcal: kcal, protein: p, carbs: c, fat: f };
  }

  function entryTotals(entry) {
    var t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    var lines = (entry && entry.food) || [];
    for (var i = 0; i < lines.length; i++) {
      var x = lineTotals(lines[i]);
      t.kcal += x.kcal; t.protein += x.protein; t.carbs += x.carbs; t.fat += x.fat;
    }
    return t;
  }

  /* ---------------------------------------------------------------
     HABITS

     Streaks intentionally tolerate "today not logged yet" — a streak that
     breaks at 00:01 every morning trains you to stop looking at it.
     --------------------------------------------------------------- */

  function habitStreak(entries, habitId, today) {
    var k = today || todayKey();
    var e = entries[k];
    var done = e && e.habits && e.habits[habitId];
    if (!done) {
      k = addDays(k, -1);
      e = entries[k];
      if (!(e && e.habits && e.habits[habitId])) return 0;
    }
    var n = 0;
    while (true) {
      var en = entries[k];
      if (en && en.habits && en.habits[habitId]) { n++; k = addDays(k, -1); }
      else break;
    }
    return n;
  }

  function habitRate(entries, habitId, days, today) {
    var end = today || todayKey();
    var hit = 0;
    for (var i = 0; i < days; i++) {
      var k = addDays(end, -i);
      var e = entries[k];
      if (e && e.habits && e.habits[habitId]) hit++;
    }
    return hit / days;
  }

  /* ---------------------------------------------------------------
     PROJECTION
     --------------------------------------------------------------- */

  /* Null rather than a fantasy date when the rate points the wrong way or
     has not been established yet. */
  function projectGoal(currentTrend, goalWeight, rateLbPerWk, fromKeyStr) {
    if (typeof currentTrend !== 'number' || typeof goalWeight !== 'number') return null;
    if (typeof rateLbPerWk !== 'number' || !isFinite(rateLbPerWk)) return null;
    var need = currentTrend - goalWeight;
    if (Math.abs(need) < 0.1) return { date: fromKeyStr || todayKey(), weeks: 0 };
    /* Rate is negative while losing, so flip it into "pounds shed per
       week" and require it to point at the goal before promising a date. */
    var lossPerWeek = -rateLbPerWk;
    if (need > 0 && lossPerWeek <= 0.01) return null;
    if (need < 0 && lossPerWeek >= -0.01) return null;
    var weeks = need / lossPerWeek;
    if (!isFinite(weeks) || weeks < 0 || weeks > 520) return null;
    return { date: addDays(fromKeyStr || todayKey(), Math.round(weeks * 7)), weeks: weeks };
  }

  return {
    KCAL_PER_LB: KCAL_PER_LB,
    ACTIVITY: ACTIVITY,
    toKey: toKey, fromKey: fromKey, addDays: addDays,
    daysBetween: daysBetween, todayKey: todayKey,
    trendSeries: trendSeries, trendAt: trendAt, trendRate: trendRate,
    bmr: bmr, baselineTDEE: baselineTDEE, estimateTDEE: estimateTDEE,
    dailyTarget: dailyTarget, macroTargets: macroTargets,
    kcalFromMacros: kcalFromMacros, lineTotals: lineTotals, entryTotals: entryTotals,
    habitStreak: habitStreak, habitRate: habitRate, projectGoal: projectGoal
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WL;
