// =============================================================
// TRENDLINE — SCAN A PLATE
//
// Takes a photograph of a meal and returns what is probably on it,
// with probable amounts. Every word in that sentence is doing work.
//
// WHAT THIS CAN AND CANNOT KNOW
//
// A model looking at a photograph can identify foods well. It cannot
// weigh them. There is no scale in the picture, depth is guessed from
// a single viewpoint, and the difference between 120 g and 200 g of
// rice is a centimetre of mound height that no photograph resolves.
//
// So the portion is the weak link, always, and the design follows
// from that rather than apologising for it afterwards:
//
//   - every item comes back with a confidence, and the model is told
//     to use "low" freely rather than to look decisive
//   - nothing is ever logged from here directly. The app opens the
//     results as an editable list and the person confirms
//   - the app can replace any row's nutrition with a real database
//     lookup at the estimated weight, which is the combination worth
//     having: the model for "what is it and roughly how much", USDA
//     for "what is in it"
//
// An estimate presented as a measurement would be worse than no
// feature at all, because it would quietly poison the calorie history
// that everything else in the app is computed from.
//
// SETUP
//
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy plate --no-verify-jwt
//
// The key lives in Supabase's secret store, never in the app, never
// in the repository. The function is the only thing that sees it.
// =============================================================

const MODEL = 'claude-sonnet-5';
const MAX_IMAGE_BYTES = 4_500_000;   // the API's own ceiling is 5 MB of base64
const TIMEOUT_MS = 45_000;

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

// Same reasoning as the recipe reader: the platform's verify_jwt flag
// also rejects the browser's CORS preflight, which cannot carry an
// Authorization header. So the check happens here instead.
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

// ---------------------------------------------------------------
// The tool is the schema. Asking for JSON in prose and parsing the
// reply is the usual way to get this wrong: models write excellent
// JSON right up until the one time they wrap it in an explanation.
// ---------------------------------------------------------------

const TOOL = {
  name: 'record_plate',
  description: 'Record the foods visible in the photograph, with estimated portions.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per distinct food. Combine garnishes into the dish they sit on.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'A plain name that would find this in a nutrition database. ' +
                '"Grilled chicken breast", not "the chicken on the left".',
            },
            grams: {
              type: 'number',
              description: 'Estimated edible weight in grams. Exclude bones, shells and packaging.',
            },
            household: {
              type: 'string',
              description:
                'The same amount described the way a person would say it — ' +
                '"about a cup", "two slices", "a palm-sized piece". Empty if none fits.',
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description:
                'How sure you are of the PORTION, not the identification. Use low freely. ' +
                'A photograph with nothing of known size in it rarely deserves better than low.',
            },
            kcal: { type: 'number', description: 'Estimated calories for the stated grams.' },
            protein: { type: 'number', description: 'Grams of protein for the stated grams.' },
            carbs: { type: 'number', description: 'Grams of carbohydrate for the stated grams.' },
            fat: { type: 'number', description: 'Grams of fat for the stated grams.' },
          },
          required: ['name', 'grams', 'confidence', 'kcal', 'protein', 'carbs', 'fat'],
        },
      },
      note: {
        type: 'string',
        description:
          'One short sentence on anything that limits the estimate — hidden food, ' +
          'no size reference, an unidentifiable sauce. Empty if nothing stands out.',
      },
    },
    required: ['items'],
  },
};

const SYSTEM = `You estimate what is on a plate from a photograph, for a food log.

Identify each distinct food and estimate its edible weight in grams.

On portions, which is the part that goes wrong:
- Look for something of known size — a fork, a standard dinner plate is about
  27 cm, a slice of bread, a can. Say in the note when there is nothing.
- Estimate the weight of what is ACTUALLY THERE, not a typical serving of that
  food. Half a chicken breast is half a chicken breast.
- Prefer to be roughly right over precisely wrong. A range in your head should
  become its middle, with confidence set honestly to reflect the width.
- Set confidence on the PORTION. You may be certain it is rice and have very
  little idea whether it is 100 g or 250 g; that is confidence low.

On nutrition: give figures for the weight you stated, as cooked and as it looks
— fried food carries the oil, dressed salad carries the dressing.

If the photograph does not show food, return an empty items list and say so in
the note. Do not invent a plausible meal.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Response(req.method === 'HEAD' ? null : JSON.stringify({
      ok: true, service: 'trendline-plate', expects: 'POST { image, mediaType }',
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  if (req.method !== 'POST') return json({ error: 'POST an image.' }, 405);

  if (!await isSignedIn(req)) return json({ error: 'Sign in to Trendline first.' }, 401);

  /* Trimmed. Pasting a key into a web form carries a trailing newline
     more often than not, and Anthropic rejects the whole header when it
     does — which surfaces as "your key is wrong" about a key that is
     entirely correct. */
  const apiKey = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim();
  if (!apiKey) {
    return json({
      error: 'No Anthropic key is set on this project. See supabase/functions/README.md.',
    }, 503);
  }

  let image: string, mediaType: string;
  try {
    const body = await req.json();
    image = String(body?.image ?? '');
    mediaType = String(body?.mediaType ?? 'image/jpeg');
    if (!image) throw new Error('No image.');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) throw new Error('Unsupported image type.');
    if (image.length > MAX_IMAGE_BYTES) {
      throw new Error('That photo is too large. The app should have shrunk it first.');
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Bad request.' }, 400);
  }

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: control.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'record_plate' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'What is on this plate, and roughly how much of each?' },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      /* Anthropic's own message is nearly always the useful one — it
         distinguishes an invalid key from one belonging to an org
         without credit from a model this account cannot reach. Passing
         it through beats a friendly sentence that hides the answer. */
      let said = '';
      try {
        const parsed = JSON.parse(detail);
        said = parsed?.error?.message || '';
      } catch { /* not JSON */ }

      const msg = res.status === 401 || res.status === 403
        ? 'Anthropic rejected the key'
        : res.status === 429
          ? 'Anthropic is rate limiting, or the account is out of credit'
          : `Anthropic answered ${res.status}`;
      return json({
        error: msg + (said ? ': ' + said : '.'),
        detail: detail.slice(0, 300),
        /* Enough to tell a mangled paste from a wrong key without ever
           revealing the key: a valid one is ~108 chars and starts
           sk-ant-. */
        keyShape: {
          length: apiKey.length,
          prefix: apiKey.slice(0, 7),
          hasWhitespace: /\s/.test(apiKey),
        },
      }, 502);
    }

    const data = await res.json();
    const block = (data.content || []).find((c: { type?: string }) => c.type === 'tool_use');
    if (!block) {
      return json({ error: 'The reader did not return a result it could use.' }, 502);
    }

    return json({
      ok: true,
      items: block.input?.items ?? [],
      note: block.input?.note ?? '',
      // Passed through so the app can say what a scan costs rather than
      // leaving it a mystery. Tokens, not money — the price per token
      // is not this function's to know.
      usage: data.usage ?? null,
      model: MODEL,
    });
  } catch (e) {
    const msg = control.signal.aborted
      ? 'The reader took too long.'
      : (e instanceof Error ? e.message : 'The photo could not be read.');
    return json({ error: msg }, 502);
  } finally {
    clearTimeout(timer);
  }
});
