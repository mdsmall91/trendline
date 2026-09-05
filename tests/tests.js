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

  /* ---------- training ---------- */

  var lifter = { weightLb: 200, heightIn: 70 };
  var kg200 = 200 * 0.45359237;   /* 90.72 kg */

  /* kcal/min = MET x 3.5 x kg / 200, minus one MET for the resting
     burn that the TDEE estimate already counts. */
  near('metKcal is net of resting', WL.metKcal(6, 60, 200), (6 - 1) * 3.5 * kg200 / 200 * 60, 0.5);
  check('metKcal at 1 MET is zero, not negative', WL.metKcal(1, 60, 200) === 0);
  check('metKcal below 1 MET is zero', WL.metKcal(0.5, 60, 200) === 0);
  check('metKcal with no minutes is zero', WL.metKcal(6, 0, 200) === 0);
  check('metKcal with no weight is zero', WL.metKcal(6, 60, 0) === 0);
  check('metKcal ignores junk', WL.metKcal(6, 'abc', 200) === 0);

  /* An hour of hard lifting must not come out anywhere near the gross
     figure a fitness tracker would show — that gap is the whole point. */
  var grossHour = 6 * 3.5 * kg200 / 200 * 60;
  check('an hour of lifting is well under the gross figure',
    WL.metKcal(6, 60, 200) < grossHour - 90, WL.metKcal(6, 60, 200));

  /* Steps: 10,000 at 70in and 200lb should land in the range every
     step counter and calculator agrees on, roughly 300-400 net. */
  var s10k = WL.stepsKcal(10000, lifter);
  check('10k steps lands in a defensible range', s10k > 300 && s10k < 400, s10k);
  check('zero steps is zero', WL.stepsKcal(0, lifter) === 0);
  check('negative steps is zero', WL.stepsKcal(-500, lifter) === 0);
  check('steps need a weight', WL.stepsKcal(10000, { heightIn: 70 }) === 0);

  /* Height matters: a taller person covers more ground per step. */
  var shortWalk = WL.stepsKcal(10000, { weightLb: 200, heightIn: 62 });
  var tallWalk = WL.stepsKcal(10000, { weightLb: 200, heightIn: 76 });
  check('taller stride burns more over the same step count', tallWalk > shortWalk * 1.15,
    tallWalk + ' vs ' + shortWalk);
  check('missing height falls back rather than zeroing',
    WL.stepsKcal(10000, { weightLb: 200 }) > 0);

  /* Heavier costs more over the same distance. */
  check('heavier burns more per step',
    WL.stepsKcal(10000, { weightLb: 250, heightIn: 70 }) > s10k);

  /* A hand-entered figure beats any estimate. */
  check('manual calories win over the MET estimate',
    WL.workoutKcal({ kind: 'cardio', activity: 'run', minutes: 60, kcal: 412 }, lifter) === 412);
  check('manual zero does not win (blank, not "no calories")',
    WL.workoutKcal({ kind: 'cardio', activity: 'run', minutes: 60, kcal: 0 }, lifter) > 0);
  check('unknown activity falls back to a middling MET',
    WL.workoutKcal({ kind: 'cardio', activity: 'quidditch', minutes: 30 }, lifter) > 0);
  check('a steps record routes to the steps model',
    Math.abs(WL.workoutKcal({ kind: 'steps', steps: 10000 }, lifter) - s10k) < 0.001);

  /* ---------- the 2:1 rule ----------
     Locked: half of what is worked off comes back as food. */
  var dayW = [
    { kind: 'steps', steps: 8000 },
    { kind: 'cardio', activity: 'jog', minutes: 30 },
    { kind: 'lifting', activity: 'lift_hard', minutes: 45 }
  ];
  var dt = WL.dayTraining(dayW, lifter);
  check('credit is exactly half the burn', dt.credit === Math.round(dt.gross * 0.5),
    dt.credit + ' of ' + dt.gross);
  check('the credit ratio is the locked one', WL.EXERCISE_CREDIT === 0.5);
  check('day training counts its sessions', dt.count === 3);
  check('an empty day is zero, not null',
    WL.dayTraining([], lifter).gross === 0 && WL.dayTraining([], lifter).credit === 0);
  check('no workouts at all is zero', WL.dayTraining(null, lifter).credit === 0);
  check('a day of training is worth something but not a meal',
    dt.credit > 100 && dt.credit < 500, dt.credit);

  /* ---------- lifting detail ---------- */

  var sets = WL.parseSets('Bench 3x8 185\nSquat 5x5 225\nPullups 3x10\n\n  Face pulls  ');
  check('parses four lines, blank ignored', sets.length === 4, sets.length);
  check('parses exercise', sets[0].exercise === 'Bench', sets[0].exercise);
  check('parses sets and reps', sets[0].sets === 3 && sets[0].reps === 8);
  check('parses weight', sets[0].weight === 185);
  check('bodyweight work has no weight', sets[2].weight === null && sets[2].reps === 10);
  check('a bare name still survives', sets[3].exercise === 'Face pulls' && sets[3].sets === null);
  check('capital X works too', WL.parseSets('Row 4X12 95')[0].reps === 12);
  check('multi-word exercise names survive',
    WL.parseSets('Incline dumbbell press 3x10 60')[0].exercise === 'Incline dumbbell press');
  check('decimal weight parses', WL.parseSets('Curl 3x10 22.5')[0].weight === 22.5);
  check('empty text gives no sets', WL.parseSets('').length === 0);
  check('null text gives no sets', WL.parseSets(null).length === 0);

  near('volume is sets x reps x load', WL.setsVolume(sets), 3 * 8 * 185 + 5 * 5 * 225, 0.001);
  check('bodyweight adds nothing to volume',
    WL.setsVolume([{ sets: 3, reps: 10, weight: null }]) === 0);
  check('sets round trip through text',
    WL.parseSets(WL.setsToText(sets))[0].weight === 185);

  /* Sets must never move the calorie number — minutes and intensity do. */
  var withSets = { kind: 'lifting', activity: 'lift_hard', minutes: 45, sets: sets };
  var without = { kind: 'lifting', activity: 'lift_hard', minutes: 45 };
  check('lifting detail does not change the burn',
    WL.workoutKcal(withSets, lifter) === WL.workoutKcal(without, lifter));

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
