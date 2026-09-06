// =============================================================
// TRENDLINE — READING A HEALTH AUTO EXPORT PAYLOAD
//
// Pure. No network, no Deno, no browser — which is the point: the
// Edge Function next door imports it, and tests/health-tests.html
// imports the same file, so the thing that is tested is the thing
// that runs.
//
// ---------------------------------------------------------------
// WHAT HEALTH AUTO EXPORT SENDS
//
// A metrics array, each metric a name and a list of dated points:
//
//   { "data": { "metrics": [ { "name": "step_count", "units": "count",
//       "data": [ { "date": "2026-09-04 00:00:00 -0400", "qty": 8234 } ] } ] } }
//
// The shape has moved between versions — sometimes the metrics sit at
// the top level, the quantity key has been qty, Sum and value — so
// this reads tolerantly and says what it ignored, rather than
// returning zero and letting a silent format change look like a
// quiet week.
//
// ---------------------------------------------------------------
// DATES ARE LOCAL, AND THAT IS WHY THE STRING IS SLICED
//
// The date arrives as local wall-clock time with its offset attached:
// "2026-09-04 00:00:00 -0400". Trendline's day keys are local dates
// too — the day you lived, not a UTC window. Taking the first ten
// characters keeps those aligned.
//
// Parsing it into a Date and formatting it back would convert to
// whatever timezone the server happens to be in, and Supabase Edge
// Functions run in UTC. An evening walk logged at 21:00 Eastern would
// land on tomorrow. Slicing the string is not a shortcut around the
// date handling; it is the correct date handling here.
// =============================================================

const MAX_STEPS_PER_DAY = 200000;

// Apple calls it HKQuantityTypeIdentifierStepCount; Health Auto Export
// calls it step_count. Both spellings, and the obvious ones, are
// accepted because the cost of guessing wrong is a silent zero.
const STEP_NAMES = ['step_count', 'steps', 'stepcount', 'step count', 'hkquantitytypeidentifierstepcount'];

export function isStepMetric(name) {
  return STEP_NAMES.indexOf(String(name || '').trim().toLowerCase()) >= 0;
}

// The metrics array, wherever this version of the app decided to put it.
export function metricsOf(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload;
  const d = payload.data;
  if (d && Array.isArray(d.metrics)) return d.metrics;
  if (Array.isArray(payload.metrics)) return payload.metrics;
  if (d && Array.isArray(d)) return d;
  return [];
}

export function dayKey(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

// qty is current; Sum and value are what older exports and some
// aggregation settings produce.
export function quantityOf(point) {
  if (!point || typeof point !== 'object') return null;
  const keys = ['qty', 'Qty', 'sum', 'Sum', 'value', 'Value', 'quantity'];
  for (const k of keys) {
    const v = point[k];
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && isFinite(n) && n >= 0) return n;
  }
  return null;
}

/* Fold a payload into one step total per day.
 *
 * Summing within a day is right for both of Health Auto Export's
 * aggregation settings: with daily aggregation there is one point and
 * the sum is that point; with hourly there are up to 24 and the day is
 * their total. What must never happen is summing ACROSS payloads, and
 * that is handled downstream — ingest_steps writes a deterministic
 * row id per date, so re-sending a day replaces it. Steps are
 * cumulative, and a double-counted day inflates the exercise credit
 * that comes off the calorie budget.
 */
export function summarizeSteps(payload) {
  const totals = Object.create(null);
  const seenMetrics = [];
  let points = 0, skipped = 0;

  for (const metric of metricsOf(payload)) {
    if (!metric || typeof metric !== 'object') continue;
    const name = String(metric.name || '');
    if (seenMetrics.indexOf(name) < 0) seenMetrics.push(name);
    if (!isStepMetric(name)) continue;

    const rows = Array.isArray(metric.data) ? metric.data : [];
    for (const row of rows) {
      const date = dayKey(row && row.date);
      const qty = quantityOf(row);
      if (date === null || qty === null) { skipped++; continue; }
      totals[date] = (totals[date] || 0) + qty;
      points++;
    }
  }

  const days = Object.keys(totals).sort().map((date) => ({
    date,
    // Steps are whole things. Hourly points arrive fractional often
    // enough that a day can land on 8234.000000001.
    steps: Math.min(Math.round(totals[date]), MAX_STEPS_PER_DAY),
  }));

  return {
    days,
    points,
    skipped,
    // Every metric name in the payload, so a phone configured to send
    // the wrong one produces a readable answer instead of a shrug.
    metrics: seenMetrics,
  };
}

export const _internals = { MAX_STEPS_PER_DAY, STEP_NAMES };
