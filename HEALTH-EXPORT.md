# Steps from your watch, automatically

Garmin writes your step count into Apple Health. This gets it from there into
Trendline without you typing anything.

**What it costs:** Health Auto Export is £5.99/$5.99 a year, or a one-off for
lifetime. Everything else here is free, and no Apple Developer account is
involved — that $99 is for shipping apps to the App Store, not for using one.

**What it replaces:** the hand-built Shortcut in `STEPS-SHORTCUT.md`. That route
still works and still costs nothing. This one is about fifteen minutes shorter
to set up and rather more reliable, because a maintained app is doing the part
that used to be twelve Shortcut actions.

---

## Before you start

The Edge Function has to be deployed. See
[`supabase/functions/README.md`](supabase/functions/README.md) — one command,
and it's the same trip as the recipe reader.

You also need your ingest token. If you set up the Shortcut you already have it.
If not, run this in the Supabase SQL editor:

```sql
select token from public.ingest_tokens where label = 'ios-shortcut-steps';
```

If that returns nothing, run `supabase/steps-ingest.sql` first — it creates the
token and prints it.

Your URL is that token on the end of the function address:

```
https://mmwymuxutgmwfmvkvxzw.supabase.co/functions/v1/health?token=YOUR_TOKEN_HERE
```

Treat it like a key, because it is one. A narrow one — see the README for what
it can and cannot do — but a key.

---

## On the phone

1. Install **Health Auto Export — JSON+CSV** from the App Store and open it.
2. Allow it to read **Steps** when iOS asks. It only needs that one.
3. **Automations → +**
4. Set it up like this:

   | Setting | Value | Why |
   | --- | --- | --- |
   | Automation type | **REST API** | |
   | URL | the address above, token and all | |
   | Method | **POST** | |
   | Data type | **Health Metrics** | not Workouts |
   | Export format | **JSON** | |
   | Aggregation / Period | **Days** | one row per day, which is what a day's step count is |
   | Date range | **Last 7 days** | see below |
   | Schedule | hourly, or as often as it offers | see below |

5. Under **Health Metrics**, select **Steps** and nothing else. Other metrics
   are ignored on arrival, so sending them only wastes battery.
6. Tap **Run** / **Export Now** once to test it.

You should get a response like:

```json
{ "ok": true, "written": 7, "days": ["2026-09-05", "2026-09-04", …] }
```

Open Trendline, pull it fresh, and the days are in the log.

---

## Why seven days and not one

Two reasons, and they compound.

**Apple Health cannot be read while the phone is locked.** That is an iOS
security property, not a bug in the app and not something any app can work
around. A scheduled export that fires while the phone is sitting locked on a
bedside table reads nothing. Any promise of "it runs every night with nothing to
open" is overselling — including the one I made earlier about the Shortcut.

**Garmin's numbers arrive late.** The watch syncs when it syncs, and a day's
step count can still be climbing hours after the day ended.

Re-sending the last seven days every time fixes both. A run that catches the
phone unlocked backfills whatever the locked runs missed, and a day that was
still settling gets corrected on the next pass.

Re-sending is safe: `ingest_steps` writes one row per date, keyed on the date
itself, so sending the same day fifty times leaves one row with the latest
figure. It replaces, it never accumulates. That matters more than it sounds —
steps feed the exercise credit that comes off your calorie budget, and a
double-counted day would quietly hand you calories you never earned.

---

## When it doesn't work

**`{"error": "That ingest token is not recognised."}`**
The token on the end of the URL is wrong or has been revoked. Re-run the
`select` above and check it against what's in the app, character for character.

**`{"ok": true, "written": 0, "note": "No step data in that export. It carried: …"}`**
It ran, and sent something other than steps. The note names what actually
arrived — go back to **Health Metrics** and select Steps.

**`{"ok": true, "written": 0, "note": "That export contained no metrics at all."}`**
Usually the phone was locked when it fired, or the date range is empty. Unlock
the phone and run it by hand to confirm the setup is right.

**A 404**
The function isn't deployed yet. See `supabase/functions/README.md`.

**Nothing at all happens on a schedule, but manual runs work**
That's the locked-phone problem. iOS also throttles background work for apps you
rarely open. Nothing to fix — the seven-day window is the fix, and it catches up
the next time the phone is awake.

---

## What it doesn't import

Steps, and only steps.

Garmin also writes workouts and active energy into Apple Health. Importing those
would double-count: the same session logged once by you in Trendline and once by
your watch, both feeding the exercise credit. Trendline already knows about your
lifts and your cardio because you told it. Steps are the one thing it has no
other way to know.
