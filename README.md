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
5. In the app: **Setup → Sync**, enter your email, and type the six-digit
   code that arrives. Repeat on your other devices with the same email.

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

## The four things it does

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

**4. Habits.** Daily checkboxes with streaks and a 30-day grid. Streaks
tolerate an unlogged today, because a streak that breaks at 00:01 every
morning trains you to stop looking at it.

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
index.html              shell — five panels
config.js               your Supabase URL + anon key (empty = sync off,
                        and it can be set in the app instead)
js/core.js              the engine. Pure functions, no DOM, no storage.
js/store.js             local-first storage, v1 migration, dirty tracking
js/sync.js              merge logic + Supabase REST/auth over plain fetch
js/chart.js             hand-rolled SVG. No charting library.
js/ui.js                render-on-change
styles/app.css          self-contained tokens, light + dark
sw.js                   offline shell. Only caches same-origin assets —
                        a cached sync response would be worse than none.
supabase/schema.sql     tables, indexes, RLS policies
tests/                  131 assertions
```

## Tests

```
node tests/tests.js         # 67 — the engine
node tests/sync-tests.js    # 64 — merge logic, migration, key safety
```

Or open `tests/tests.html` and `tests/sync-tests.html` in a browser.

The two that matter most:

- **End-to-end engine:** a synthetic body with a true TDEE of 2600 eating
  2100/day is fed in as noisy weigh-ins, and the estimator has to recover
  ~2600 and set a target within 150 calories of truth.
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
