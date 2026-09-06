// =============================================================
// TRENDLINE — RECIPE READER
//
// Fetches a recipe page and returns the structured-data blocks in it.
// That is the entire job. It does not decide what a serving is, what
// the calories are, or whether the page was worth reading — all of
// that lives in js/recipe.js, in the app, where it can be tested
// against saved fixtures without a network.
//
// WHY THIS EXISTS AT ALL
//
// A browser cannot read another site's page. That is the same rule
// that stops a random web page from reading your webmail, and it
// applies here even though the intent is innocent. Something outside
// the browser has to do the fetching, and this is the smallest
// possible something.
//
// WHY IT IS NOT AN OPEN PROXY
//
// Left unguarded, a "fetch any URL for me" endpoint is a gift to
// anyone who finds it: they get to make requests that appear to come
// from inside Supabase's network, including to addresses only
// reachable from there. Three things prevent that.
//
//   1. It requires a signed-in Trendline account. The check is done
//      here rather than by the platform's verify_jwt flag, because
//      that flag also rejects the browser's CORS preflight — which
//      cannot carry an Authorization header, by specification — and a
//      rejected preflight means the app never gets to make the real
//      call at all. So: deployed with verification off, and the token
//      checked against the auth server on the line marked below.
//      Same guarantee, minus a failure mode that looks like a CORS
//      bug and isn't.
//   2. It refuses private and loopback addresses — and it re-checks
//      after EVERY redirect, because a public URL that redirects to
//      169.254.169.254 is the standard way around a check done only
//      once at the start.
//   3. It reads a bounded number of bytes and gives up after twelve
//      seconds, so a hostile page cannot hold a worker open or fill
//      its memory.
//
// Deploy:  supabase functions deploy recipe --no-verify-jwt
// =============================================================

const MAX_BYTES = 3_000_000;      // a fat recipe page is ~700 KB
const MAX_BLOCK_BYTES = 400_000;  // structured data, not the whole page
const MAX_BLOCKS = 40;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;

// Sites serve different markup to things that look like scrapers, and
// several serve nothing at all. Identifying honestly as a browser-shaped
// client gets the same HTML a person would see.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------
// Address checking
//
// Hostnames are matched by shape rather than resolved, because this
// runs before the request and DNS is not available to it. That leaves
// one gap — a public hostname whose DNS record points at a private
// address — which the redirect re-check does not close either. The
// honest summary is that this stops the easy cases and the sign-in
// requirement stops the rest: an attacker needs an account on this
// project first, and the only account is mine.
// ---------------------------------------------------------------

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localdomain)$/i;

function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;         // unique local IPv6
  if (/^fe80:/i.test(h)) return true;                     // link local IPv6
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;                // cloud metadata
  if (a >= 224) return true;                              // multicast, reserved
  return false;
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That is not a link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https links can be read.');
  }
  if (BLOCKED_HOST.test(u.hostname) || isPrivateAddress(u.hostname)) {
    throw new Error('That address is not reachable from here.');
  }
  return u;
}

// ---------------------------------------------------------------
// Fetching, one hop at a time
//
// Redirects are followed by hand rather than by fetch, so every hop
// gets the same address check as the first one.
// ---------------------------------------------------------------

async function fetchPage(start: URL, signal: AbortSignal): Promise<{ url: string; html: string }> {
  let url = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new Error('That page redirected to nowhere.');
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(
        res.status === 403 || res.status === 401
          ? 'That site would not let the reader in. Some publishers block anything that is not a person clicking.'
          : `That page came back ${res.status}.`,
      );
    }

    const type = res.headers.get('content-type') || '';
    if (type && !/text\/html|xhtml|text\/plain/i.test(type)) {
      await res.body?.cancel();
      throw new Error('That link is not a web page.');
    }

    return { url: url.toString(), html: await readCapped(res) };
  }
  throw new Error('That page redirected too many times.');
}

// Read the body up to a cap and then stop, rather than trusting
// Content-Length or hoping the page is small.
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  try { await reader.cancel(); } catch { /* already done */ }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    if (at + c.length > total) break;
    buf.set(c, at);
    at += c.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

// ---------------------------------------------------------------
// Pulling out the structured data
//
// A regex, and on purpose. The target is the text inside a specific
// script tag, not the document's meaning — there is no tree to walk
// and no attribute to be confused by, so a parser would buy nothing
// and cost a dependency.
// ---------------------------------------------------------------

const LD_TAG = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

function extractBlocks(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  LD_TAG.lastIndex = 0;
  while ((m = LD_TAG.exec(html)) !== null && out.length < MAX_BLOCKS) {
    const text = m[1].trim();
    if (text && text.length <= MAX_BLOCK_BYTES) out.push(text);
  }
  return out;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title\s*>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// ---------------------------------------------------------------

// Who is asking. The token is handed to the auth server rather than
// decoded here: verifying a signature by hand is exactly the kind of
// security code that is easy to write and easy to write wrongly, and
// the service whose keys signed it is one request away.
async function isSignedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(auth)) return false;
  const base = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!base || !key) return false;
  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: { 'Authorization': auth, 'apikey': key },
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  // The preflight is answered before anything else and without
  // authentication, because a browser cannot attach credentials to it.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST a { url }.' }, 405);

  if (!await isSignedIn(req)) {
    return json({ error: 'Sign in to Trendline first.' }, 401);
  }

  let target: URL;
  try {
    const body = await req.json();
    target = checkUrl(String(body?.url ?? ''));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Bad request.' }, 400);
  }

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const page = await fetchPage(target, control.signal);
    const blocks = extractBlocks(page.html);
    return json({
      ok: true,
      url: page.url,
      title: extractTitle(page.html),
      blocks,
      // Said plainly, so the app can tell "the site publishes nothing"
      // apart from "the reader failed". They need different sentences.
      blockCount: blocks.length,
    });
  } catch (e) {
    const msg = control.signal.aborted
      ? 'That page took too long to answer.'
      : (e instanceof Error ? e.message : 'The page could not be read.');
    return json({ error: msg }, 502);
  } finally {
    clearTimeout(timer);
  }
});
