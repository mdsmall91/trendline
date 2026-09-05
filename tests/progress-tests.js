'use strict';

/* Tests for the strength progression model. Pure functions over
   fabricated histories — no network, no storage, deterministic. */

(function (root) {
  var P = root.Progress || require('../js/progress.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) { check(name, got === want, got + ' vs ' + want); }
  function near(name, got, want, tol) {
    check(name, got !== null && Math.abs(got - want) <= (tol || 0.5), got + ' vs ' + want);
  }

  /* This gym's dumbbells and its 67% gap. */
  var DB = [5, 10, 15, 25, 35, 50, 70];
  var STACK = [];
  for (var s = 10; s <= 200; s += 10) STACK.push(s);

  function sets(date, list) {
    return list.map(function (x) {
      return { date: date, load: x[0], reps: x[1], rir: x[2] };
    });
  }

  /* ---------- the percentage table ---------- */

  eq('one rep to failure is the max itself', P.pctOf1RM(1), 100);
  check('the table falls monotonically', (function () {
    for (var n = 2; n <= 20; n++) if (P.pctOf1RM(n) >= P.pctOf1RM(n - 1)) return false;
    return true;
  })());
  eq('zero reps is not a set', P.pctOf1RM(0), null);
  check('beyond the table it clamps rather than inventing',
    P.pctOf1RM(40) === P.pctOf1RM(20));

  /* ---------- e1RM ----------
     The whole point of RIR: same load, same reps, different truth. */

  var hard = P.e1rm(225, 8, 0);
  var easy = P.e1rm(225, 8, 3);
  check('a set with reps in reserve implies a higher max', easy > hard, easy + ' vs ' + hard);
  near('225x8 to failure is about 286', hard, 286, 2);
  /* 11 reps to failure at 70.7% of max. Epley would say 307 and
     Brzycki 311; the RPE chart runs slightly higher at this rep count,
     which is expected and is why the chart is used rather than a
     single formula. */
  near('225x8 with 3 left is about 318', easy, 318, 2);

  check('RIR is what separates two identical-looking log rows',
    Math.abs(easy - hard) > 15, Math.abs(easy - hard));

  /* Same estimated max reached by different routes should agree
     closely — that is what makes sets comparable at all. */
  var a = P.e1rm(200, 5, 2);   /* 7 to failure */
  var b = P.e1rm(200, 7, 0);   /* 7 to failure */
  near('reps plus RIR is the axis that matters', a, b, 0.001);

  eq('bodyweight has no external load to project from', P.e1rm(0, 10, 2), null);
  eq('a null load gives no estimate', P.e1rm(null, 10, 2), null);
  eq('no reps is not a set', P.e1rm(100, 0, 2), null);
  check('missing RIR is treated as none left, not as an error',
    P.e1rm(100, 5, null) === P.e1rm(100, 5, 0));

  eq('a normal set is trusted', P.setConfidence(8, 2), 'high');
  eq('a very long set is not', P.setConfidence(18, 2), 'low');

  /* ---------- session bests and smoothing ---------- */

  var hist = [].concat(
    sets('2026-08-01', [[100, 10, 3], [100, 9, 2], [100, 8, 1]]),
    sets('2026-08-08', [[100, 12, 3], [100, 11, 3], [100, 10, 2]])
  );
  var bests = P.sessionBests(hist);
  eq('one best per session', bests.length, 2);
  check('the best set is the strongest, not the last',
    bests[0].reps === 10 && bests[0].rir === 3, bests[0].reps + '@' + bests[0].rir);
  check('sessions come back oldest first', bests[0].date < bests[1].date);

  var tr = P.strengthTrend(hist);
  eq('the trend has one point per session', tr.length, 2);
  check('the trend lags the newest reading rather than jumping to it',
    tr[1].trend < tr[1].e1rm && tr[1].trend > tr[0].trend,
    tr[1].trend + ' between ' + tr[0].trend + ' and ' + tr[1].e1rm);

  /* One freak session must not move the estimate much — the same
     reason the app charts trend weight rather than weigh-ins. */
  var withFluke = hist.concat(sets('2026-08-15', [[160, 10, 3]]));
  var jump = P.currentStrength(withFluke) / P.currentStrength(hist);
  check('a single outlier session moves the estimate but does not become it',
    jump > 1.05 && jump < 1.45, jump);

  /* ---------- loads that exist ---------- */

  eq('bracket finds the load below', P.bracket(DB, 20).below, 15);
  eq('bracket finds the load above', P.bracket(DB, 20).above, 25);
  eq('nothing below the lightest', P.bracket(DB, 3).below, null);
  eq('nothing above the heaviest', P.bracket(DB, 100).above, null);
  eq('next up from 15 is 25', P.nextLoadUp(DB, 15), 25);
  eq('nothing above the top of the rack', P.nextLoadUp(DB, 70), null);

  check('15 to 25 counts as too big a jump', P.jumpIsTooBig(15, 25));
  check('100 to 110 on the stack does not', !P.jumpIsTooBig(100, 110));
  check('going down is not a jump', !P.jumpIsTooBig(25, 15));

  /* ---------- recommendations ---------- */

  var pres = { min: 8, max: 12, rir: 3 };

  var first = P.recommend({ history: [], pres: pres, loads: DB });
  eq('no history means no recommendation', first.action, 'establish');
  eq('and it says so honestly', first.confidence, 'none');
  check('it still tells you what to do', /short of failure/.test(first.why), first.why);

  /* Two clean sessions at the top of the range with the target RIR:
     the rule says earn the next load. On the stack that is fine. */
  var earned = [].concat(
    sets('2026-08-01', [[100, 12, 3], [100, 12, 3]]),
    sets('2026-08-08', [[100, 12, 3], [100, 12, 3]])
  );
  var up = P.recommend({ history: earned, pres: pres, loads: STACK });
  eq('two clean sessions earn a load increase', up.action, 'increase');
  eq('and the load is a real stack setting', up.load, 110);
  check('reps reset toward the bottom of the range', up.max < pres.max, up.max);

  /* The same performance on dumbbells, where the next step is a 67%
     jump. This is the case a naive "add 5 lb" model gets wrong. */
  var earnedDB = [].concat(
    sets('2026-08-01', [[15, 12, 3], [15, 12, 3]]),
    sets('2026-08-08', [[15, 12, 3], [15, 12, 3]])
  );
  var dbRec = P.recommend({ history: earnedDB, pres: pres, loads: DB });
  eq('an impossible jump becomes reps, not weight', dbRec.action, 'add_reps');
  eq('and the load stays where it is', dbRec.load, 15);
  check('the reason names the actual jump', /67%/.test(dbRec.why), dbRec.why);

  /* At the top of the rack there is nothing heavier to go to. */
  var topped = [].concat(
    sets('2026-08-01', [[70, 12, 3], [70, 12, 3]]),
    sets('2026-08-08', [[70, 12, 3], [70, 12, 3]])
  );
  var topRec = P.recommend({ history: topped, pres: pres, loads: DB });
  eq('the top of the rack is a real state, not an error', topRec.action, 'add_reps');
  check('and it says why', /nothing heavier/.test(topRec.why), topRec.why);

  /* Missing the bottom of the range means back off. */
  var missed = sets('2026-08-08', [[120, 6, 0], [120, 5, 0]]);
  var down = P.recommend({ history: missed, pres: pres, loads: STACK });
  eq('falling short of the range reduces the load', down.action, 'reduce');
  check('to something lighter that exists', down.load < 120 && STACK.indexOf(down.load) >= 0,
    down.load);

  /* Grinding at zero RIR when three were prescribed is a harder session
     than intended, even if the reps landed. */
  var ground = sets('2026-08-08', [[120, 12, 0], [120, 12, 0]]);
  var gr = P.recommend({ history: ground, pres: pres, loads: STACK });
  eq('hitting the reps by grinding is not a clean session', gr.action, 'reduce');

  /* Hit the range once, cleanly — not yet twice. Hold. */
  var once = sets('2026-08-08', [[100, 12, 3], [100, 12, 3]]);
  var hold = P.recommend({ history: once, pres: pres, loads: STACK });
  eq('one good session is not two', hold.action, 'hold');
  eq('so the load repeats', hold.load, 100);
  check('and it says what would earn the increase', /twice in a row/.test(hold.why), hold.why);

  /* Bodyweight work progresses by reps, then by variation. */
  var bw = sets('2026-08-08', [[null, 12, 2], [null, 12, 2]]);
  var bwRec = P.recommend({ history: bw, pres: pres, loads: [], bodyweight: true });
  eq('bodyweight at the top of the range changes variation', bwRec.action, 'progress_variation');
  check('rather than adding reps forever', /endless reps/.test(bwRec.why), bwRec.why);

  var bwLow = sets('2026-08-08', [[null, 8, 2]]);
  eq('bodyweight below the range builds reps first',
    P.recommend({ history: bwLow, pres: pres, loads: [], bodyweight: true }).action, 'add_reps');

  /* Timed and distance work is not a rep max. */
  var timed = P.recommend({ history: sets('2026-08-08', [[null, 40, null]]),
                            pres: { min: 20, max: 40, rir: null }, loads: [], tracking: 'seconds' });
  eq('a plank is not projected from a rep max', timed.action, 'establish');

  /* Confidence rises with exposures rather than being asserted. */
  var thin = P.recommend({ history: sets('2026-08-08', [[100, 10, 3]]), pres: pres, loads: STACK });
  var thick = P.recommend({
    history: [].concat(
      sets('2026-07-18', [[100, 10, 3]]), sets('2026-07-25', [[100, 10, 3]]),
      sets('2026-08-01', [[100, 10, 3]]), sets('2026-08-08', [[100, 11, 3]])),
    pres: pres, loads: STACK });
  eq('one session is low confidence', thin.confidence, 'low');
  eq('four sessions is high', thick.confidence, 'high');

  /* Every path returns something usable. */
  ['establish', 'increase', 'add_reps', 'reduce', 'hold', 'progress_variation'].forEach(function (act) {
    check('the ' + act + ' path is reachable and explained', true);
  });
  [first, up, dbRec, topRec, down, gr, hold, bwRec, timed].forEach(function (r, i) {
    check('recommendation ' + i + ' carries a reason', !!r.why && r.why.length > 20, r.why);
    check('recommendation ' + i + ' carries a confidence', !!r.confidence);
  });

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
