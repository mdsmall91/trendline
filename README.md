# Trendline

A personal weight, intake and habit app. Trend weight instead of weigh-ins,
a calorie target that measures your actual metabolism, and cloud sync
across your devices.

No subscription, no ads, no engagement loop, no food database with three
conflicting entries for the same banana. Built for an audience of one —
which is what makes it better than the commercial options rather than
worse.

**Runs free. No Apple Developer account, no App Store, no credit card.**

---

## Put it on your iPhone

It installs to the home screen as a real app: its own icon, full screen,
no Safari chrome, works offline.

1. Host the folder anywhere that serves HTTPS. GitHub Pages is free and
   takes two minutes: repo **Settings → Pages → Deploy from a branch →
   main → / (root)**.
2. Open the URL in **Safari** on your iPhone (it must be Safari — Chrome
   on iOS cannot install web apps).
3. Tap **Share → Add to Home Screen**.

That's the install. From then on it's an icon on your home screen.

**What you give up by not paying Apple $99/year:** it cannot read Apple
Health, so a smart scale can't fill in your weight automatically — you
type it, which takes five seconds. Everything else works.

### Running it locally

```
python3 -m http.server 8000     # then visit localhost:8000
```

No build step, no dependencies, no install. Edit a file and reload.

---

## Cloud sync (optional, free, ~5 minutes)

The app is fully usable with no account and no network, forever. Sync is
an addition, not a dependency. Turn it on and your log follows you between
your phone and your laptop, and stops being one browser-cache-clear away
from gone.

**Step-by-step walkthrough, including the traps: [SETUP.md](SETUP.md).**

1. Create a free project at [supabase.com](https://supabase.com). No card
   required.
2. In the dashboard open **SQL Editor**, paste all of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. It creates the
   five tables, the indexes, and the row-level security policies.
3. Open **Project Settings → API** and copy the **Project URL** and the
   **anon / public** key.
4. Give the app those two values, either way:
   - **From your phone** — open **Setup → Sync** and paste them into the
     form. Stored on that device only. Nothing to edit, nothing to deploy.
   - **Once, for every device** — put them in [`config.js`](config.js) and
     push. A filled-in `config.js` always wins over anything typed on a
     device, so there is one source of truth.
5. In Supabase, **Authentication → Providers → Email**, turn **Confirm
   email off**. No mail then has to be sent or received at all.
6. In the app: **Setup → Sync**, enter an email and password, **Create
   account**. On every other device, same email and password, **Sign in**.

Signing in with an emailed code is offered too, but it needs the Supabase
Magic Link template to carry `{{ .Token }}` — the stock template sends a
link, and a link has to open in the browser that asked for it, which on
iOS means Safari rather than the home-screen app.

The setup form refuses a URL that isn't a project endpoint, and refuses
the **secret / service role key** — that one bypasses Row Level Security,
and putting it in a page that ships to a phone would hand every reader of
the page the whole database. The two keys sit next to each other in the
dashboard and look alike, so the check decodes the token and reads its
`role` claim rather than matching on text (in the JWT format the words
`service_role` never actually appear in the key).

**The anon key is safe to commit.** It is a publishable key that identifies
the project; it does not grant access to anything. Row Level Security is
the actual boundary, and the policy in `schema.sql` restricts every row to
the account that created it. Never put the **service role** key in
`config.js` — that one does bypass RLS.

Supabase's free tier pauses a project after a week of no activity. An app
you open daily never goes quiet, so in practice this won't bite you.

### When it syncs

On launch, on every edit (debounced 2.5s, so logging a meal is one upload),
every time the app comes back to the foreground, when the network returns,
on a tap of the header pill, and on a ten-minute heartbeat while the app is
visible.

The heartbeat exists because everything else is an event, and none of those
events fire for a phone sitting on the counter with the app open. Without
it, a weigh-in logged on the laptop could sit unseen on the phone for hours
with both online. It only runs while visible: a background tab syncing
achieves nothing and spends battery, and on iOS a suspended app does not run
timers at all — which is fine, because the foreground trigger covers exactly
that case the moment it wakes.

### How sync works

Local-first, last-write-wins per record. Your device never waits on the
network: every edit is written to local storage immediately and the cloud
catches up when it can.

Two clocks, deliberately:

| | set by | used for |
|---|---|---|
| `updated_at` | the device that made the edit | deciding who wins a conflict |
| `synced_at` | the server | the pull cursor, and only that |

Splitting them means the newer **edit** wins rather than whoever happened
to reconnect last, and a device with a wrong clock cannot make its own rows
invisible by writing a timestamp in the past.

Two details that are easy to get wrong and lose data:

- **Food lines are their own records**, not an array inside the day. If they
  lived on the day, logging breakfast on your phone and lunch on your laptop
  would resolve as last-writer-wins and one meal would silently vanish. As
  separate records they merge. There is a test for exactly this.
- **Deletions are soft.** A hard delete on one device is indistinguishable
  from a record the other device hasn't seen yet, so the row would simply
  come back on the next sync.

The network layer is plain `fetch` against Supabase's REST and auth
endpoints — no SDK, because it would be one more thing to cache for offline
use and this is about 200 lines.

---

## The six things it does

**1. Trend weight, not weigh-ins.** A single reading is mostly water,
sodium and gut contents; a real 180lb body swings 3–4lb for reasons that
have nothing to do with fat. Every number in the app is driven by an
exponentially weighted moving average. The chart shows both, so the scatter
around the line makes the point visually.

The smoothing constant is per *day*, not per reading, so a weigh-in after a
five-day gap gets `1-(1-α)^5` of the pull. Without that, sporadic logging
leaves the trend lagging arbitrarily far behind reality.

**2. Adaptive TDEE.** The one genuinely smart number. Energy balance run
backwards over a trailing window:

```
TDEE = mean daily intake − (trend weight change in lb × 3500) / days
```

This *measures* your metabolism instead of predicting it from a formula,
and it silently absorbs everything a formula misses — NEAT, adaptation, and
chronic under-logging of intake. Two windows (14 and 28 days) are blended so
the estimate is responsive without being jumpy.

Guard rails, because a confident wrong number is worse than an honest
fallback:

- Days with no food logged are **absent, not zero**. "Ate nothing" and
  "logged nothing" must never be confused.
- Under 75% logging coverage it refuses to run and falls back to
  Mifflin-St Jeor.
- A physiologically implausible result is clamped and flagged, because that
  means the inputs are wrong, not the metabolism.

**3. Calorie and macro logging against a personal library.** You log the
~150 things you actually eat; a new name asks for its macros once and joins
the library. Quick-add covers restaurant meals. Within two weeks logging is
mostly autocomplete, and every row is right — which no general database can
promise.

**3b. Macros over time.** The Trend page charts protein, carbs and fat by
day against their targets, with the average of the logged days drawn across
them — because one day of macros mostly reflects what was in the fridge.

Only protein is scored. Protein is a floor: hitting it is the win, and on a
deficit it is what decides whether the weight you lose is fat. Carbs and fat
are the remainder after protein and calories are settled — they land where
they land, and colouring a day red for exceeding a number the app itself
derived would be inventing a failure.

**3c. One place to log, in the unit the food is sold in.** Type a name,
an amount, and a unit. The unit list is built per food from what that
food states about itself: something sold by weight offers grams and
ounces, something measured in cups offers cups, tablespoons and
teaspoons, and a cereal bar offers servings and says why.

Cups never convert to grams. A cup of flour and a cup of honey differ by
a factor of two and a half, so a conversion would be inventing a
density. The dropdown is short when the food is vague, which is the
honest version of a dropdown that is always full and sometimes wrong.

The day's list shows what you typed — "4 oz" — rather than the servings
it worked out to. `x0.567` is the same fact and a different thing: you
cannot check a number you do not recognise.

**4. Habits.** Daily checkboxes with streaks and a 30-day grid. Streaks
tolerate an unlogged today, because a streak that breaks at 00:01 every
morning trains you to stop looking at it.

**5. Food lookup.** Barcode scanning against Open Food Facts (no API key)
and name search against USDA FoodData Central (free key, optional). Anything
looked up is written into your library, so the second time you eat it there
is no network call — the library is the cache and there is no second one.
Manual entry never went anywhere; lookup just saves the typing.

**5b. Recipes from a link.** Paste a recipe URL and the nutrition arrives
filled in. This is not scraping: recipe sites publish their figures as
schema.org structured data because that is what puts a calorie count into a
Google result, so the reader takes declared, machine-readable fields. It
never reads the ingredient list and never estimates.

Which means three honest outcomes, and the card says which one you got: the
numbers, "that recipe does not publish nutrition" (name and servings still
filled in), or "that site would not let the reader in". Four of the four
sites tested published a complete set.

What comes back lands in the add-a-recipe form rather than saving itself —
sites do get their own nutrition wrong, and the numbers are per serving as
the *site* defines a serving. Both are one glance to check and impossible to
notice afterwards.

The one trap worth naming: `recipeYield` is the loosest field in the whole
object. One tested site yields `["2", "2 cups (8 servings)"]` — two cups,
eight portions. Taking the first value is wrong by a factor of four. So a
value that says "servings" wins wherever it sits, and when nothing does, the
app says the count is a guess instead of picking one confidently.

Servings are the hard part, not nutrients. Every source states per-100g,
only some state per-serving, and "serving" means whatever the manufacturer
decided. So the app keeps both, and where a source gives no serving the
label reads `100 g` rather than an unmarked `1`. Two specific traps it
handles, both found in live responses:

- USDA Foundation foods carry protein, fat and carbohydrate and **no energy
  field at all**. Calories are derived with Atwater factors and the row says
  `cal from macros`, so the number is trusted for the right reason.
- A USDA serving of "1 cup" with no gram weight cannot be scaled from
  per-100g values. Scaling it anyway is how a calorie count silently
  triples, so it stays at 100g and says so.

**6. Training, and the 2:1 rule.** Steps, cardio and lifting sessions.
Calories are estimated from METs and bodyweight, or taken from a
hand-entered figure if you have one — a chest strap beats any table, and an
estimate that silently overrides a measurement is worse than no estimate.

Every figure is **net**: what the activity cost above sitting still for the
same minutes. An hour of lifting is ~600 gross calories for a 200lb man, but
~100 of those would have burned anyway and the TDEE estimate already counts
them. Gross numbers are how exercise trackers hand people a second dinner.

Half of what you work off comes back as food. The other half is deliberate
margin: MET tables assume a textbook pace, step counters over-count, and
neither knows you sat down for four minutes between sets. The ratio lives in
one constant, `WL.EXERCISE_CREDIT`.

The credit is **not** fed back into the adaptive TDEE. That estimate
measures what your body actually did with the food it got, training
included; adding an allowance into the measurement would make the
measurement chase itself. The credit belongs to the day's budget, not to the
metabolism — and it self-corrects anyway. Eat the credit, and if it was too
generous the trend slows, the measured burn falls, and the target comes down
on its own.

Lifting detail is typed one exercise per line — `Bench 3x8 185` — because a
structured form with four inputs per exercise is six taps a set on a phone,
which is how a training log stops getting filled in. Sets and reps are a
record of what you did; they deliberately do not move the calorie number.

---

## Honesty rules

The app says where its numbers came from and admits when it doesn't know.
That's a design requirement, not a nicety: a number you can't explain is a
number you stop trusting in week three.

- The target line states whether it's measured or formula-derived, and with
  what confidence.
- An aggressive goal on a small body is clamped to a floor, and the app
  reports the rate you'll **actually** get instead of the one you asked for.
- A flat trend against a loss goal prompts you to check the food log before
  cutting calories, because under-logging is the usual answer.
- `3500 kcal/lb` is an approximation. It overstates early loss (glycogen and
  water) and understates it later. Fine for a loop that re-estimates weekly.

---

## Files

```
index.html              shell — six panels
config.js               your Supabase URL + anon key (empty = sync off,
                        and it can be set in the app instead), plus an
                        optional USDA key for food search
js/core.js              the engine. Pure functions, no DOM, no storage.
js/store.js             local-first storage, v1 migration, dirty tracking
js/sync.js              merge logic + Supabase REST/auth over plain fetch
js/foodapi.js           Open Food Facts + USDA normalizers and lookups
js/recipe.js            reads schema.org Recipe nutrition out of a page's
                        structured data. Pure; the fetching is an Edge Function
js/units.js             which units a food can honestly be measured in, and
                        the conversions. Refuses what it cannot justify.
js/scanner.js           camera barcode scanning, wrapping the vendored lib
js/gym.js               exercise catalog: search, substitution, selectable loads
js/chart.js             hand-rolled SVG. No charting library.
js/ui.js                render-on-change
styles/app.css          self-contained tokens, light + dark
sw.js                   offline shell. Only caches same-origin assets —
                        a cached sync response would be worse than none.
vendor/                 html5-qrcode, vendored rather than CDN-loaded so
                        scanning still works with no signal. Lazy-loaded.
data/                   exercise catalog, session templates, this gym's
                        real equipment. See data/README.md.
supabase/schema.sql     tables, indexes, RLS policies
supabase/steps-ingest.sql  write-only token + function for the
                        iOS Shortcut that posts daily steps
supabase/functions/     the only two things a browser may not do:
                          recipe/  fetch another site's page
                          health/  receive Health Auto Export's steps
                        Neither holds a key. See its README.
SETUP.md                Supabase walkthrough
STEPS-SHORTCUT.md       Garmin steps into the log, by hand-built Shortcut
HEALTH-EXPORT.md        the same thing, via Health Auto Export
tests/                  630 assertions
```

## Tests

```
node tests/tests.js          # 106 — the engine, incl. training calories
node tests/sync-tests.js     # 101 — merge logic, wire format, session safety
node tests/food-tests.js     #  93 — food lookup normalizers and library ranking
node tests/gym-tests.js      #  42 — catalog search, substitution, real loads
node tests/progress-tests.js #  77 — e1RM, RIR, load selection, the rules
node tests/recipe-tests.js   # 100 — recipe reading, against four real pages
node tests/units-tests.js    #  63 — unit conversion, and what it refuses
```

Or open any of the `tests/*.html` pages in a browser, which is the only
way to run `health-tests.html` — 48 assertions on the Health Auto Export
reader, which is an ES module because the Edge Function imports the same
file. Serve the folder rather than opening it from disk; modules need
http. If the app's service worker has cached an old copy, unregister it
first.

The two that matter most:

- **End-to-end engine:** a synthetic body with a true TDEE of 2600 eating
  2100/day is fed in as noisy weigh-ins, and the estimator has to recover
  ~2600 and set a target within 150 calories of truth.
- **The 2:1 rule holds exactly:** the credit is half of the burn *as
  displayed*, not half of the unrounded figure. Rounding in the wrong order
  puts the two numbers on screen a calorie apart, and the first person to
  check the arithmetic stops trusting both.
- **When to sign someone out:** only a genuinely dead refresh token does
  it. A 429, a 5xx, or a paused free project must not, because signing
  someone out costs a password entry and a trip to a password manager, and
  "logged out of an app I never logged out of" is the result.
- **Two-device convergence:** two devices log different meals on the same
  day while offline, then edit the same record, then one deletes. Both must
  end up identical, with nothing lost and nothing resurrected — and a third
  device joining later must receive the full history.

## Your data

With sync off, everything is in `localStorage` in one browser and clearing
site data erases it — export occasionally. With sync on, this device keeps a
full local copy and works offline while the cloud copy is the backup;
clearing site data is recoverable.

Export is plain readable JSON. Import validates before it replaces anything,
and marks every record for upload so a restore propagates instead of being
undone by the next pull.

## Not in here, on purpose

Barcode scanning, a branded-food database, exercise calorie logging (it
double-counts against an adaptive TDEE that already includes your activity),
social features, and streak guilt-tripping.
