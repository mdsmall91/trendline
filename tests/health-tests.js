/* Tests for the Health Auto Export reader.

   This one is an ES module rather than a plain script, because the
   file under test is imported by a Deno Edge Function and has to be a
   module for that. Importing the same file here rather than keeping a
   copy is the whole point: the parser that runs on the server is the
   parser these assertions ran against. */

import { summarizeSteps, dayKey, quantityOf, isStepMetric, metricsOf }
  from '../supabase/functions/health/parse.js';

var failures = [], passes = 0;

function check(name, cond, detail) {
  if (cond) passes++;
  else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
}
function eq(name, got, want) {
  check(name, got === want, JSON.stringify(got) + ' vs ' + JSON.stringify(want));
}

/* ---------- day keys ----------
   The reason this is a string slice and not a Date is in parse.js:
   the payload states local wall-clock time, Trendline's days are
   local days, and the server runs in UTC. Parsing would move an
   evening walk onto the next day. */

eq('a Health Auto Export timestamp', dayKey('2026-09-04 00:00:00 -0400'), '2026-09-04');
eq('an ISO timestamp', dayKey('2026-09-04T21:13:00-04:00'), '2026-09-04');
eq('a bare date', dayKey('2026-09-04'), '2026-09-04');
eq('a late-evening local time stays on its own day',
  dayKey('2026-09-04 23:45:00 -0400'), '2026-09-04');
eq('nonsense', dayKey('yesterday'), null);
eq('an impossible month', dayKey('2026-13-04 00:00:00 -0400'), null);
eq('an impossible day', dayKey('2026-09-00 00:00:00 -0400'), null);
eq('a number', dayKey(20260904), null);
eq('undefined', dayKey(undefined), null);

/* ---------- quantities ----------
   The key has been qty, Sum and value across versions. */

eq('qty', quantityOf({ qty: 8234 }), 8234);
eq('Sum', quantityOf({ Sum: 900 }), 900);
eq('value', quantityOf({ value: 12 }), 12);
eq('a numeric string', quantityOf({ qty: '450' }), 450);
eq('qty wins when several are present', quantityOf({ qty: 1, Sum: 2 }), 1);
eq('zero is a real count', quantityOf({ qty: 0 }), 0);
eq('a negative count is not', quantityOf({ qty: -5 }), null);
eq('no quantity at all', quantityOf({ date: '2026-09-04' }), null);
eq('not an object', quantityOf(null), null);

/* ---------- metric names ---------- */

check('the name the app actually sends', isStepMetric('step_count'));
check('case does not matter', isStepMetric('Step_Count'));
check("Apple's own identifier", isStepMetric('HKQuantityTypeIdentifierStepCount'));
check('a plural spelling', isStepMetric('steps'));
check('active energy is not steps', !isStepMetric('active_energy'));
check('an empty name is not steps', !isStepMetric(''));

/* ---------- where the metrics array lives ----------
   It has moved between versions, so all the shapes seen in the wild
   are accepted. A silent zero here looks exactly like a quiet week. */

eq('nested under data', metricsOf({ data: { metrics: [{ name: 'a' }] } }).length, 1);
eq('at the top level', metricsOf({ metrics: [{ name: 'a' }] }).length, 1);
eq('a bare array', metricsOf([{ name: 'a' }]).length, 1);
eq('nothing recognisable', metricsOf({ nope: true }).length, 0);
eq('null', metricsOf(null).length, 0);

/* ---------- a whole payload ---------- */

var daily = {
  data: {
    metrics: [{
      name: 'step_count',
      units: 'count',
      data: [
        { date: '2026-09-03 00:00:00 -0400', qty: 7101, source: 'iPhone' },
        { date: '2026-09-04 00:00:00 -0400', qty: 8234, source: 'iPhone' }
      ]
    }]
  }
};
var d = summarizeSteps(daily);
eq('two days in, two days out', d.days.length, 2);
eq('days come back in order', d.days[0].date, '2026-09-03');
eq('the count survives', d.days[1].steps, 8234);
eq('both points were used', d.points, 2);
eq('nothing was skipped', d.skipped, 0);

/* Hourly aggregation: many points, one day. Summing within a day is
   right; summing across payloads would not be, and that is prevented
   downstream by ingest_steps keying its row on the date. */
var hourly = {
  data: {
    metrics: [{
      name: 'step_count',
      data: [
        { date: '2026-09-04 08:00:00 -0400', qty: 1200 },
        { date: '2026-09-04 09:00:00 -0400', qty: 800.5 },
        { date: '2026-09-04 10:00:00 -0400', qty: 34.5 },
        { date: '2026-09-05 08:00:00 -0400', qty: 500 }
      ]
    }]
  }
};
var h = summarizeSteps(hourly);
eq('hourly points fold into days', h.days.length, 2);
eq('the day is the sum of its hours', h.days[0].steps, 2035);
eq('and the next day is its own', h.days[1].steps, 500);

/* Other metrics are ignored, but their names are reported — a phone
   set up to send the wrong thing should produce a readable answer,
   not a shrug. */
var mixedMetrics = {
  data: {
    metrics: [
      { name: 'active_energy', data: [{ date: '2026-09-04 00:00:00 -0400', qty: 540 }] },
      { name: 'step_count', data: [{ date: '2026-09-04 00:00:00 -0400', qty: 6000 }] }
    ]
  }
};
var m = summarizeSteps(mixedMetrics);
eq('only steps are counted', m.days.length, 1);
eq('and only the step figure', m.days[0].steps, 6000);
check('but every metric name is reported',
  m.metrics.indexOf('active_energy') >= 0 && m.metrics.indexOf('step_count') >= 0,
  m.metrics.join(','));

/* A payload with no steps is not an error. It is a fact worth
   reporting accurately. */
var noSteps = summarizeSteps({ data: { metrics: [{ name: 'heart_rate', data: [] }] } });
eq('no steps means no days', noSteps.days.length, 0);
eq('and the metric that did arrive is named', noSteps.metrics[0], 'heart_rate');

/* Malformed points are dropped and counted, never guessed at. */
var messy = summarizeSteps({
  data: {
    metrics: [{
      name: 'step_count',
      data: [
        { date: '2026-09-04 00:00:00 -0400', qty: 100 },
        { date: 'not a date', qty: 999 },
        { date: '2026-09-04 00:00:00 -0400' },
        null
      ]
    }]
  }
});
eq('the good point is kept', messy.days[0].steps, 100);
eq('and all three bad ones are counted, not silently dropped', messy.skipped, 3);

/* The database refuses anything over 200,000, so the reader clamps
   rather than sending a row it knows will be rejected. */
var absurd = summarizeSteps({
  data: { metrics: [{ name: 'step_count', data: [{ date: '2026-09-04', qty: 5000000 }] }] }
});
eq('an impossible count is clamped', absurd.days[0].steps, 200000);

eq('an empty payload', summarizeSteps({}).days.length, 0);
eq('a null payload', summarizeSteps(null).days.length, 0);
eq('a string payload', summarizeSteps('nope').days.length, 0);

var summary = { passes: passes, failures: failures.length, detail: failures };
globalThis.__results = summary;
var el = typeof document !== 'undefined' && document.getElementById('out');
if (el) {
  el.textContent = JSON.stringify(summary, null, 2);
  el.className = failures.length ? 'fail' : 'pass';
}
