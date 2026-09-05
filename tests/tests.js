'use strict';

/* Test harness for the core engine. Runs in the browser (no build step)
   and under node. Writes a JSON summary to #out and window.__results. */

(function (root) {
  var WL = root.WL || require('../js/core.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function near(name, got, want, tol) {
    check(name, Math.abs(got - want) <= (tol || 0.001), got + ' vs ' + want);
  }

  /* ---------- dates ---------- */
  check('toKey is local, not UTC', WL.toKey(new Date(2026, 0, 1, 23, 30)) === '2026-01-01');
  check('addDays crosses month', WL.addDays('2026-01-31', 1) === '2026-02-01');
  check('addDays crosses year back', WL.addDays('2026-01-01', -1) === '2025-12-31');
  check('daysBetween', WL.daysBetween('2026-03-01', '2026-03-15') === 14);
  check('daysBetween across DST spring', WL.daysBetween('2026-03-01', '2026-04-01') === 31);
  check('daysBetween negative', WL.daysBetween('2026-03-15', '2026-03-01') === -14);
  check('fromKey/toKey round trip', WL.toKey(WL.fromKey('2026-07-04')) === '2026-07-04');

  /* ---------- trend ---------- */
  var flat = [];
  for (var i = 0; i < 30; i++) flat.push({ date: WL.addDays('2026-01-01', i), weight: 200 });
  var ft = WL.trendSeries(flat, 0.15);
  check('flat weight gives flat trend', ft[29].trend === 200, ft[29].trend);

  /* Trend lags a step change but converges toward it. */
  var step = [];
  for (i = 0; i < 60; i++) step.push({ date: WL.addDays('2026-01-01', i), weight: i < 30 ? 200 : 190 });
  var st = WL.trendSeries(step, 0.15);
  check('trend lags a step change', st[30].trend > 198, st[30].trend);
  check('trend converges to new level', Math.abs(st[59].trend - 190) < 0.5, st[59].trend);

  /* Noise: trend must be far steadier than the raw readings. */
  var noisy = [], seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  for (i = 0; i < 40; i++) {
    noisy.push({ date: WL.addDays('2026-01-01', i), weight: 200 + (rnd() - 0.5) * 6 });
  }
  var nt = WL.trendSeries(noisy, 0.15);
  var rawSpread = 0, trendSpread = 0;
  for (i = 20; i < 40; i++) {
    rawSpread += Math.abs(nt[i].weight - 200);
    trendSpread += Math.abs(nt[i].trend - 200);
  }
  check('trend suppresses noise', trendSpread < rawSpread * 0.6, trendSpread + ' vs ' + rawSpread);

  /* Gap handling: a weigh-in after a long gap must pull nearly all the way. */
  var gap = WL.trendSeries([
    { date: '2026-01-01', weight: 200 },
    { date: '2026-03-01', weight: 180 }
  ], 0.15);
  check('long gap pulls trend most of the way', gap[1].trend < 182, gap[1].trend);

  /* Unsorted and dirty input must not corrupt the series. */
  var unsorted = WL.trendSeries([
    { date: '2026-01-03', weight: 199 },
    { date: '2026-01-01', weight: 200 },
    { date: '2026-01-02', weight: null }
  ], 0.15);
  check('unsorted input is sorted', unsorted[0].date === '2026-01-01' && unsorted.length === 2);
  check('empty series is safe', WL.trendSeries([], 0.15).length === 0);
  check('trendAt on empty is null', WL.trendAt([], '2026-01-01') === null);

  /* trendAt interpolation and clamping. */
  var two = WL.trendSeries([
    { date: '2026-01-01', weight: 200 }, { date: '2026-01-11', weight: 200 }
  ], 0.15);
  near('trendAt midpoint', WL.trendAt(two, '2026-01-06'), 200, 0.001);
  near('trendAt before range holds first', WL.trendAt(two, '2025-12-01'), 200, 0.001);
  near('trendAt after range holds last', WL.trendAt(two, '2026-06-01'), 200, 0.001);

  /* ---------- rate ---------- */
  var losing = [];
  for (i = 0; i < 60; i++) {
    losing.push({ date: WL.addDays('2026-01-01', i), weight: 200 - i * (1 / 7) });
  }
  var lt = WL.trendSeries(losing, 0.15);
  var rate = WL.trendRate(lt, 21);
  check('rate detects 1lb/wk loss', rate < -0.9 && rate > -1.1, rate);
  check('rate null on too-short span', WL.trendRate(lt.slice(0, 2), 21) === null);
  check('rate null on empty', WL.trendRate([], 21) === null);

  /* ---------- bmr / baseline ---------- */
  var prof = { weightLb: 200, heightIn: 71, age: 45, sex: 'male', activity: 'moderate' };
  var b = WL.bmr(prof);
  check('bmr in plausible range', b > 1700 && b < 1900, b);
  check('female bmr lower than male', WL.bmr({ weightLb: 200, heightIn: 71, age: 45, sex: 'female' }) < b);
  var un = WL.bmr({ weightLb: 200, heightIn: 71, age: 45, sex: 'unspecified' });
  check('unspecified sits between', un < b && un > WL.bmr({ weightLb: 200, heightIn: 71, age: 45, sex: 'female' }), un);
  near('baseline applies activity multiplier', WL.baselineTDEE(prof), b * 1.55, 0.01);

  /* ---------- adaptive TDEE ----------
     Synthetic body: true TDEE 2600, eats 2100, so a 500/day deficit,
     which is exactly 1 lb/week. The estimator must recover ~2600. */
  var TRUE_TDEE = 2600, EAT = 2100;
  var wts = [], intake = {}, w = 210;
  for (i = 0; i <= 40; i++) {
    var k = WL.addDays('2026-01-01', i);
    wts.push({ date: k, weight: w });
    intake[k] = EAT;
    w += (EAT - TRUE_TDEE) / WL.KCAL_PER_LB;
  }
  var ts = WL.trendSeries(wts, 0.15);
  var est = WL.estimateTDEE({ trend: ts, intake: intake, profile: prof, end: '2026-02-10' });
  check('adaptive method used', est.method === 'adaptive', est.method);
  check('adaptive recovers true TDEE', Math.abs(est.tdee - TRUE_TDEE) < 120, est.tdee);
  check('confidence high with both windows', est.confidence === 'high', est.confidence);

  /* Insufficient logging must not silently bias the estimate. */
  var sparse = {};
  Object.keys(intake).forEach(function (k, idx) { if (idx % 3 === 0) sparse[k] = intake[k]; });
  var sparseEst = WL.estimateTDEE({ trend: ts, intake: sparse, profile: prof, end: '2026-02-10' });
  check('sparse logging falls back to baseline', sparseEst.method === 'baseline', sparseEst.method);

  /* No data at all. */
  var none = WL.estimateTDEE({ trend: [], intake: {}, profile: prof });
  check('no data falls back to baseline', none.method === 'baseline' && none.confidence === 'none');

  /* Absurd input gets clamped rather than prescribed from. */
  var badIntake = {};
  Object.keys(intake).forEach(function (k) { badIntake[k] = 12000; });
  var bad = WL.estimateTDEE({ trend: ts, intake: badIntake, profile: prof, end: '2026-02-10' });
  check('absurd estimate is clamped', bad.clamped === true && bad.confidence === 'low', JSON.stringify(bad));

  /* Gaining weight must push the estimate above intake correctly. */
  var gw = [], gIntake = {}, g = 180;
  for (i = 0; i <= 40; i++) {
    var gk = WL.addDays('2026-01-01', i);
    gw.push({ date: gk, weight: g });
    gIntake[gk] = 3000;
    g += (3000 - 2700) / WL.KCAL_PER_LB;
  }
  var gEst = WL.estimateTDEE({
    trend: WL.trendSeries(gw, 0.15), intake: gIntake,
    profile: { weightLb: 180, heightIn: 71, age: 45, sex: 'male', activity: 'moderate' },
    end: '2026-02-10'
  });
  check('estimate is below intake when gaining', gEst.tdee < 3000, gEst.tdee);
  check('estimate near true TDEE when gaining', Math.abs(gEst.tdee - 2700) < 150, gEst.tdee);

  /* ---------- targets ---------- */
  var t1 = WL.dailyTarget({ tdee: 2600, goalRateLbPerWk: 1, profile: prof });
  check('1lb/wk is a 500/day deficit', t1.target === 2100, t1.target);
  check('unclamped target reports requested rate', Math.abs(t1.actualRate - 1) < 0.01, t1.actualRate);

  var small = { weightLb: 120, heightIn: 63, age: 30, sex: 'female', activity: 'sedentary' };
  var t2 = WL.dailyTarget({ tdee: 1500, goalRateLbPerWk: 2, profile: small });
  check('aggressive goal is clamped', t2.clamped === true, JSON.stringify(t2));
  check('clamped target respects bmr floor', t2.target >= Math.round(WL.bmr(small)), t2.target);
  check('clamped reports honest lower rate', t2.actualRate < t2.requestedRate, t2.actualRate);

  var t3 = WL.dailyTarget({ tdee: 2600, goalRateLbPerWk: 0, profile: prof });
  check('maintenance target equals tdee', t3.target === 2600 && Math.abs(t3.actualRate) < 0.01);

  var t4 = WL.dailyTarget({ tdee: 2600, goalRateLbPerWk: -0.5, profile: prof });
  check('bulking target exceeds tdee', t4.target > 2600, t4.target);

  /* ---------- macros ---------- */
  var m = WL.macroTargets({ targetKcal: 2100, weightLb: 200, proteinPerLb: 0.8, fatPerLb: 0.35 });
  check('protein at 0.8g/lb', m.protein === 160, m.protein);
  check('fat at 0.35g/lb', m.fat === 70, m.fat);
  check('macros sum to target', Math.abs(WL.kcalFromMacros(m.protein, m.carbs, m.fat) - 2100) < 10,
    WL.kcalFromMacros(m.protein, m.carbs, m.fat));
  check('carbs non-negative', m.carbs >= 0);

  var tight = WL.macroTargets({ targetKcal: 1000, weightLb: 220, proteinPerLb: 0.8, fatPerLb: 0.35 });
  check('tight target never goes negative on carbs', tight.carbs >= 0, tight.carbs);
  check('tight target sheds fat before protein', tight.fat < 220 * 0.35, tight.fat);
  check('tight target still fits the budget',
    WL.kcalFromMacros(tight.protein, tight.carbs, tight.fat) <= 1010,
    WL.kcalFromMacros(tight.protein, tight.carbs, tight.fat));

  /* ---------- food math ---------- */
  near('kcalFromMacros', WL.kcalFromMacros(30, 40, 10), 30 * 4 + 40 * 4 + 10 * 9, 0.001);
  var line = WL.lineTotals({ kcal: 100, protein: 5, carbs: 10, fat: 2, qty: 2.5 });
  near('line scales by qty', line.kcal, 250, 0.001);
  near('line scales protein', line.protein, 12.5, 0.001);
  var derived = WL.lineTotals({ protein: 10, carbs: 20, fat: 5, qty: 1 });
  near('kcal derived when absent', derived.kcal, 165, 0.001);
  var noQty = WL.lineTotals({ kcal: 300 });
  near('missing qty defaults to 1', noQty.kcal, 300, 0.001);
  var tot = WL.entryTotals({ food: [{ kcal: 100, qty: 2 }, { kcal: 50, qty: 1 }] });
  near('entry totals sum', tot.kcal, 250, 0.001);
  near('empty entry totals to zero', WL.entryTotals({}).kcal, 0, 0.001);

  /* ---------- habits ---------- */
  var ents = {};
  for (i = 0; i < 5; i++) ents[WL.addDays('2026-05-10', -i)] = { habits: { steps: true } };
  check('streak counts back from today', WL.habitStreak(ents, 'steps', '2026-05-10') === 5,
    WL.habitStreak(ents, 'steps', '2026-05-10'));
  check('streak tolerates an unlogged today', WL.habitStreak(ents, 'steps', '2026-05-11') === 5,
    WL.habitStreak(ents, 'steps', '2026-05-11'));
  check('streak breaks after two misses', WL.habitStreak(ents, 'steps', '2026-05-12') === 0);
  check('streak zero for unknown habit', WL.habitStreak(ents, 'nope', '2026-05-10') === 0);
  near('habit rate over 10 days', WL.habitRate(ents, 'steps', 10, '2026-05-10'), 0.5, 0.001);

  /* ---------- projection ---------- */
  var pj = WL.projectGoal(200, 180, -1, '2026-01-01');
  check('projects 20lb at 1lb/wk to ~20 weeks', pj && Math.abs(pj.weeks - 20) < 0.01, pj && pj.weeks);
  check('projected date is 140 days out', pj && pj.date === '2026-05-21', pj && pj.date);
  check('no projection when gaining toward a lower goal', WL.projectGoal(200, 180, 0.5, '2026-01-01') === null);
  check('no projection at zero rate', WL.projectGoal(200, 180, 0, '2026-01-01') === null);
  check('already at goal returns zero weeks', WL.projectGoal(180, 180, -1, '2026-01-01').weeks === 0);
  check('no projection beyond ten years', WL.projectGoal(400, 180, -0.01, '2026-01-01') === null);
  check('projection handles a gaining goal', WL.projectGoal(180, 190, 1, '2026-01-01') !== null);

  /* ---------- end to end ----------
     The loop that matters: log honestly, and the target should land on a
     deficit that actually produces the requested rate. */
  var e2e = WL.estimateTDEE({ trend: ts, intake: intake, profile: prof, end: '2026-02-10' });
  var e2eTarget = WL.dailyTarget({ tdee: e2e.tdee, goalRateLbPerWk: 1, profile: prof });
  check('end to end target within 150 of truth', Math.abs(e2eTarget.target - (TRUE_TDEE - 500)) < 150,
    e2eTarget.target);

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
