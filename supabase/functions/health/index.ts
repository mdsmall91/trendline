// =============================================================
// TRENDLINE — HEALTH AUTO EXPORT RECEIVER
//
// One endpoint for the iPhone to POST its step counts at. Health Auto
// Export handles the Apple Health side — reading the steps Garmin
// wrote there, on a schedule, in the background — and this turns what
// it sends into rows in the workout log.
//
// WHY IT DOES NOT WRITE TO THE DATABASE ITSELF
//
// It calls the same ingest_steps function the iOS Shortcut calls, with
// the same token, and holds no elevated key of its own. That function
// can do exactly one thing: set the step count on one day. If this
// endpoint were compromised tomorrow, the worst available outcome is
// still a lie about how far someone walked.
//
// The alternative — handing this function the service role key so it
// could write the table directly — would turn a step receiver into
// something that can read every row in the account. There is no
// version of "it's more convenient" worth that.
//
// AUTHENTICATION IS THE TOKEN, NOT A SESSION
//
// Health Auto Export cannot hold a Supabase session or refresh a JWT,
// so this deploys with JWT verification OFF and authenticates on the
// ingest token instead — the token IS the credential, and it is
// checked by ingest_steps inside the database. Without a valid one
// this endpoint can do nothing at all.
//
// Deploy:  supabase functions deploy health --no-verify-jwt
// =============================================================

import { summarizeSteps } from './parse.js';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-trendline-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// A single export can carry months of history on its first run.
const MAX_DAYS_PER_CALL = 120;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// The token may arrive in a header or on the query string. A header is
// preferred — URLs turn up in logs and share sheets in a way headers do
// not — but the query string stays supported, because some builds only
// let you set a URL.
//
// Which one it came from is returned alongside it, purely so a failure
// can say "check the header" to someone who used a header. Being told
// to check the end of a URL you never touched is the kind of small
// wrongness that sends people looking in the wrong place for an hour.
function tokenFrom(req: Request): { token: string; where: 'header' | 'url' | 'none' } {
  const header = (req.headers.get('x-trendline-token') || '').trim();
  if (header) return { token: header, where: 'header' };
  const query = (new URL(req.url).searchParams.get('token') || '').trim();
  if (query) return { token: query, where: 'url' };
  return { token: '', where: 'none' };
}

async function writeDay(
  base: string,
  key: string,
  token: string,
  date: string,
  steps: number,
): Promise<{ date: string; ok: boolean; error?: string }> {
  const res = await fetch(`${base}/rest/v1/rpc/ingest_steps`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ p_token: token, p_date: date, p_steps: steps }),
  });
  if (res.ok) {
    await res.body?.cancel();
    return { date, ok: true };
  }
  const detail = await res.text().catch(() => '');
  return { date, ok: false, error: detail.slice(0, 200) };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // A liveness answer for anything that just wants to know the address
  // is real. Health Auto Export checks a URL before it will save it,
  // and this endpoint used to fail that check twice over: GET returned
  // 405, and HEAD hung outright. Both present to the person typing it
  // as "invalid URL", which is a maddening thing to be told about an
  // address that works perfectly for the one request it exists to
  // serve. Answering a probe costs nothing and does nothing.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Response(
      req.method === 'HEAD' ? null : JSON.stringify({
        ok: true,
        service: 'trendline-health-ingest',
        expects: 'POST a Health Auto Export payload, with an ingest token',
      }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  if (req.method !== 'POST') {
    return json({ error: 'POST a Health Auto Export payload.' }, 405);
  }

  const { token, where } = tokenFrom(req);
  if (!token) {
    return json({
      error: 'No ingest token. Send it as an x-trendline-token header, or add ?token=… to the URL.',
    }, 401);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'That was not JSON.' }, 400);
  }

  const found = summarizeSteps(payload);

  if (found.days.length === 0) {
    // Not an error — an export can legitimately contain no steps. But
    // saying which metrics DID arrive turns "nothing happened" into
    // something diagnosable from the phone.
    return json({
      ok: true,
      written: 0,
      days: [],
      note: found.metrics.length
        ? `No step data in that export. It carried: ${found.metrics.join(', ')}.`
        : 'That export contained no metrics at all.',
    });
  }

  // Newest days first, so if the cap bites it keeps the ones that
  // matter. A first sync carrying a year of history is not worth
  // failing over, and the older days arrive on later runs.
  const days = found.days.slice().reverse().slice(0, MAX_DAYS_PER_CALL);

  const base = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!base || !key) return json({ error: 'The function is missing its project settings.' }, 500);

  const results = [];
  for (const d of days) {
    results.push(await writeDay(base, key, token, d.date, d.steps));
  }

  const failed = results.filter((r) => !r.ok);
  // A bad token fails every row for the same reason; say so once,
  // clearly, rather than a hundred times.
  if (failed.length === results.length) {
    const first = failed[0]?.error || '';
    const bad = /invalid token/i.test(first);
    return json({
      ok: false,
      written: 0,
      error: bad
        ? 'That ingest token is not recognised. Check the ' +
          (where === 'header' ? 'x-trendline-token header.' : 'token on the end of the URL.')
        : 'Nothing could be written.',
      detail: first,
    }, bad ? 401 : 502);
  }

  return json({
    ok: true,
    written: results.length - failed.length,
    days: results.filter((r) => r.ok).map((r) => r.date),
    failed: failed.map((r) => ({ date: r.date, error: r.error })),
    skippedPoints: found.skipped,
  });
});
