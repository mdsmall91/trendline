# Edge Functions

Two small servers. Everything else in Trendline runs in the browser; these
two exist because there are exactly two things a browser is not allowed to do.

| Function | Why it can't be done in the app |
| --- | --- |
| `recipe` | A browser cannot read another site's page. |
| `health` | An iPhone app cannot hold a Supabase session. |
| `plate` | A key that reads photographs must not ship in a web app. |

None of them can read your data. Only `plate` holds a secret, and it holds it in
Supabase's secret store rather than in this repository.

---

## Installing them

Two routes. Neither needs a paid anything.

### Route A — paste them into the dashboard

Nothing to install. **Edge Functions → Deploy a new function → via editor.**
Name them `recipe` and `health`, paste the contents of each `index.ts`, turn
**Verify JWT off**, deploy.

`health` needs a second file, `parse.js`, alongside its `index.ts` — create it
in the editor's file tree with that exact name before deploying, or the function
will not boot.

### Route B — the CLI

The Supabase CLI is not in winget, and there is no npm here, so on this machine
it means downloading the release binary by hand: `supabase_windows_amd64.zip`
from <https://github.com/supabase/cli/releases/latest>, about 56 MB. Unzip
`supabase.exe` anywhere and call it by its full path.

```bash
supabase login
```

Opens a browser and stores a token. Interactive — it has to be run in a real
terminal.

Then, from the `trendline` folder — note `--project-ref`, which skips linking
and the database password prompt that comes with it:

```bash
supabase functions deploy recipe --project-ref mmwymuxutgmwfmvkvxzw --no-verify-jwt
```

```bash
supabase functions deploy health --project-ref mmwymuxutgmwfmvkvxzw --no-verify-jwt
```

The plate reader needs a key of its own, set once and stored by Supabase:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref mmwymuxutgmwfmvkvxzw
```

```bash
supabase functions deploy plate --project-ref mmwymuxutgmwfmvkvxzw --no-verify-jwt
```

**The `--no-verify-jwt` is not laziness, and it does not mean unauthenticated.**
Both functions check their caller themselves. See "Why the two are secured
differently" below — the short version is that the platform flag also rejects
the browser's CORS preflight, which by specification cannot carry credentials.

To check they arrived:

```bash
supabase functions list
```

---

## Why the two are secured differently

This looks inconsistent and isn't.

**`recipe` requires a signed-in account.** It fetches arbitrary URLs, and an
open endpoint that does that is a gift to anyone who finds it — they get to make
requests that appear to come from inside Supabase's network. So it hands the
caller's token to the auth server and refuses anything that comes back
unrecognised. The caller has an account on this project, and the only account is
yours.

That check is inside the function rather than the platform's `verify_jwt` flag
for one specific reason: the flag also rejects the browser's CORS preflight,
which cannot carry an `Authorization` header by specification. With the flag on,
the app never gets as far as making the real request — and the failure surfaces
as a CORS error, which sends you looking in entirely the wrong place. Same
guarantee, minus a trap.

It also refuses private and loopback addresses, re-checks after every redirect,
caps what it reads, and gives up after twelve seconds.

**`health` cannot require an account at all.** Health Auto Export posts JSON to a URL on a
schedule; it has no way to sign in to Supabase, hold a session, or refresh a
token. So it authenticates on the ingest token instead — the same token the iOS
Shortcut uses, checked inside the database by `ingest_steps`.

That function is the reason this is safe rather than merely convenient. It can
do exactly one thing: set the step count on one day. It cannot read your weight,
your food, or anything else. The Edge Function holds no elevated key of its own —
it forwards to `ingest_steps` with the public anon key and the token, so it has
no more power than the Shortcut did.

If the URL leaked tomorrow, the worst available outcome is someone lying to you
about how far you walked. You revoke it with one `DELETE`.

---

## `recipe`

**Called by:** Foods → Recipes → *Add from a link*
**Requires:** a signed-in Trendline account

Fetches a recipe page and returns the `<script type="application/ld+json">`
blocks in it. That is the whole job. It does not decide what a serving is or
what the calories are — that lives in `js/recipe.js`, in the app, tested against
saved fixtures from four real pages in `tests/recipe-tests.html`.

Keeping the parsing in the app and the fetching in the function is deliberate:
the interesting half is the half that can be tested without a network, and it
runs where you can see it.

### What it will and won't find

Recipe sites publish nutrition as structured data because that is what puts a
calorie count into a Google result. It is a declared, machine-readable field.
The reader takes those stated figures and nothing else — it never reads the
ingredient list, never estimates, and never fills a gap with a plausible number.

So there are three honest outcomes, and the card says which one you got:

- **the numbers, per serving** — the common case
- **"that recipe does not publish nutrition"** — name and servings still get
  filled in, the four macro boxes are yours to complete
- **"that site would not let the reader in"** — some publishers block anything
  that isn't a person clicking, and there is no polite way around that

Of the four sites tested while building it, four published a complete set.

---

## `health`

**Called by:** Health Auto Export on your iPhone
**Requires:** a valid ingest token on the URL

Turns a Health Auto Export payload into daily step rows. Setup for the phone
side is in [`../../HEALTH-EXPORT.md`](../../HEALTH-EXPORT.md).

Steps only, on purpose. Garmin also writes workouts and active energy into Apple
Health, and importing those would double-count against the sessions you log in
Trendline — the same lift counted twice, once by you and once by your watch,
both feeding the exercise credit that comes off the calorie budget. Steps are
the one thing Trendline does not otherwise record.

The parser (`health/parse.js`) is imported by both the function and
`tests/health-tests.html`, so the code the tests ran against is the code that
runs on the server.

---

## `plate`

**Called by:** Today → *Scan a plate*
**Requires:** a signed-in account, and `ANTHROPIC_API_KEY` in the project secrets

Photographs a meal and returns what is probably on it, with probable amounts.
Every word there is load-bearing.

A model reading a photograph identifies foods well and weighs them badly. There
is no scale in the picture and no second viewpoint, so the difference between
120 g and 200 g of rice is a centimetre of mound height a photograph does not
resolve. The design follows from that rather than apologising for it afterwards:

- every item carries a confidence, and the prompt tells the model to use *low*
  freely rather than to look decisive
- **nothing is ever logged from here directly** — results open as an editable
  list and you confirm
- any row can be looked up in USDA at its estimated weight, which replaces a
  guess with a measurement and brings the micronutrients with it

That last point is the whole design. The model is good at "that is a chicken
thigh, about 140 g". A database is good at "140 g of chicken thigh contains
this". Each does the half it is good at — and the confidence stays where it was
after a lookup, because the database fixed what is *in* the food and knows
nothing about how much of it was on the plate.

An estimate presented as a measurement would be worse than no feature at all: it
would quietly poison the calorie history that the adaptive TDEE — energy balance
run backwards over exactly this data — is computed from.

### Cost

One image plus a short reply to Claude Sonnet, on the order of a cent or two per
scan at current prices. The function passes token usage back so the app can say
what a scan cost rather than leaving it a mystery. The photo is shrunk to 1024px
in the browser first: a plate is recognisable at that size, and the upload is the
slow part on a phone.

### If the key is missing

It answers 503 with a sentence saying so, rather than failing in a way that looks
like a bug. Set the secret and there is nothing to redeploy — secrets are read on
the next invocation.

---

## Changing them later

Edit and re-deploy the same way; the URL stays the same. Logs are under
**Edge Functions → [name] → Logs** in the dashboard, and each function returns a
sentence rather than a status code when it fails, so most problems read
straight off the response.
