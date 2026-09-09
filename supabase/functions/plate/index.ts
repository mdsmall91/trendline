// =============================================================
// TRENDLINE — READ A PHOTOGRAPH, OR A PAGE
//
// Three jobs, one function, because they share a key and a key is the
// thing worth keeping in one place:
//
//   a photograph of a plate    what is on it, and roughly how much
//   a photograph of a label    what the panel on the back states
//   the text of a web page     what the page states
//
// The first is an estimate and says so everywhere. The other two are
// transcription: the numbers exist and the job is to copy them without
// inventing the ones that are missing.
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

// Reading a page is a different job from reading a photograph, and it
// wants its own shape: one food, stated per serving, with whatever
// micronutrients the page bothered to print.
const PAGE_TOOL = {
  name: 'record_food',
  description: 'Record the nutrition this page states for one food or dish.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The food as the page names it, brand included.' },
      serving: {
        type: 'string',
        description: 'The serving the figures are for, as the page states it — "1 cup (240 ml)", "2 pieces".',
      },
      servings: {
        type: 'number',
        description: 'How many of those servings the whole recipe or package makes. Omit if not stated.',
      },
      kcal: { type: 'number', description: 'Calories PER SERVING.' },
      protein: { type: 'number', description: 'Grams of protein per serving.' },
      carbs: { type: 'number', description: 'Grams of carbohydrate per serving.' },
      fat: { type: 'number', description: 'Grams of fat per serving.' },
      fiber: { type: 'number', description: 'Grams of fibre per serving.' },
      sugar: { type: 'number', description: 'Grams of total sugars per serving.' },
      addedSugar: { type: 'number', description: 'Grams of added sugar per serving.' },
      satFat: { type: 'number', description: 'Grams of saturated fat per serving.' },
      sodium: { type: 'number', description: 'Milligrams of sodium per serving.' },
      chol: { type: 'number', description: 'Milligrams of cholesterol per serving.' },
      potassium: { type: 'number', description: 'Milligrams of potassium per serving.' },
      calcium: { type: 'number', description: 'Milligrams of calcium per serving.' },
      iron: { type: 'number', description: 'Milligrams of iron per serving.' },
      vitC: { type: 'number', description: 'Milligrams of vitamin C per serving.' },
      vitD: { type: 'number', description: 'Micrograms of vitamin D per serving.' },
      found: {
        type: 'boolean',
        description: 'False if the page states no nutrition at all. Do not guess in that case.',
      },
      note: { type: 'string', description: 'One short sentence on anything unclear or missing.' },
    },
    required: ['name', 'found'],
  },
};

const PAGE_SYSTEM = `You read nutrition figures off a web page, for a food log.

The page text is given to you. Report ONLY what the page states.

- Every figure must be PER SERVING, and say which serving in the serving
  field. If the page states per 100 g, that is the serving: "100 g".
- A percentage of a Daily Value is not an amount. Convert only when the page
  also gives the amount; otherwise leave the field out.
- Omit any field the page does not state. An omitted field is correct and
  useful; an invented one silently corrupts a food log.
- Units matter: sodium, cholesterol, potassium, calcium and iron in
  MILLIGRAMS, vitamin D in MICROGRAMS, everything else in grams.
- If the page carries several foods, take the one the URL is about — the
  dish the page is for, not something in a sidebar.
- If there is no nutrition on the page at all, set found false. Do not
  reconstruct it from the ingredients.`;

const LABEL_SYSTEM = `You read a nutrition information panel from a photograph, for a food log.

This is transcription, not estimation. The numbers are printed in front of you.

- Report the figures for ONE serving, and put the serving the panel states in
  the serving field — "2/3 cup (55g)", "1 bar (40 g)". US panels print the
  serving at the top; if the panel gives both per-serving and per-100g columns,
  use the per-serving one and say so in the serving field.
- servings is the "servings per container" figure when the panel prints one.
- A percentage of a Daily Value is not an amount. US panels print both; take
  the amount. Where only the percentage is printed, omit the field.
- Omit any field the panel does not print. An omitted field is correct and
  useful; an invented one silently corrupts a food log. Do not fill gaps from
  what you know about this kind of product.
- Units are as printed: sodium, cholesterol, potassium, calcium and iron in
  MILLIGRAMS, vitamin D in MICROGRAMS, everything else in grams.
- The name should be the product as the package names it, brand included, if
  any of the front of the package is visible. If only the panel is in frame,
  leave the name empty rather than guessing at the product.
- If a figure is blurred, cropped or unreadable, omit it. A missing number is a
  box the person fills in; a misread one is a number they will never check.
- If the photograph is not a nutrition panel at all, set found false.`;

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
      ok: true, service: 'trendline-plate',
      expects: 'POST { image, mediaType, mode? } or { text, url }',
      modes: ['plate', 'label', 'page'],
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

  let image = '', mediaType = 'image/jpeg', pageText = '', pageUrl = '', mode = '';
  try {
    const body = await req.json();
    pageText = String(body?.text ?? '').slice(0, 60_000);
    pageUrl = String(body?.url ?? '').slice(0, 500);
    image = String(body?.image ?? '');
    mode = String(body?.mode ?? '');
    if (!image && !pageText) throw new Error('Nothing to read.');
    if (image) {
      mediaType = String(body?.mediaType ?? 'image/jpeg');
      if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) throw new Error('Unsupported image type.');
      if (image.length > MAX_IMAGE_BYTES) {
        throw new Error('That photo is too large. The app should have shrunk it first.');
      }
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Bad request.' }, 400);
  }

  /* A photograph of a nutrition panel is the same job as a page: one
     food, stated per serving, with whatever the source bothered to
     print. So it takes the page's tool and its own prompt, and comes
     back in the page's shape — which the app already knows how to
     land in the add-a-food form. */
  const readingLabel = !!image && mode === 'label';
  const readingPage = !image;
  const readingFood = readingPage || readingLabel;

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
        system: readingLabel ? LABEL_SYSTEM : (readingPage ? PAGE_SYSTEM : SYSTEM),
        tools: [readingFood ? PAGE_TOOL : TOOL],
        tool_choice: { type: 'tool', name: readingFood ? 'record_food' : 'record_plate' },
        messages: [{
          role: 'user',
          content: readingPage
            ? [{
                type: 'text',
                text: 'Page: ' + pageUrl + '\n\n' + pageText +
                  '\n\nWhat nutrition does this page state, and for what serving?',
              }]
            : [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
                {
                  type: 'text',
                  text: readingLabel
                    ? 'What does this nutrition panel state, and for what serving?'
                    : 'What is on this plate, and roughly how much of each?',
                },
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

    if (readingFood) {
      return json({
        ok: true,
        food: block.input ?? null,
        /* Echoed so the app can tell a label read from a page read
           without having to remember what it asked for. */
        mode: readingLabel ? 'label' : 'page',
        usage: data.usage ?? null,
        model: MODEL,
      });
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
