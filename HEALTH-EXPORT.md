# Steps from your watch, automatically

Garmin writes your step count into Apple Health. This gets it from there into
Trendline without you typing anything.

**Cost:** Health Auto Export is $5.99/year, or a one-off for lifetime. No Apple
Developer account is involved — that $99 is for shipping apps to the App Store,
not for using one.

---

## About importing this instead of typing it

Health Auto Export can export and import automations — it has since v8.2.12 —
and stores them as plain JSON under `Auto Export/Automations` in iCloud Drive.
So a ready-made file is possible in principle.

What is missing is the schema. It is not in their help centre, not in the
GitHub docs repo, and not in any writeup I could find. Guessing at field names
risks the worst outcome available here: a file that imports looking fine, with
half its settings silently fallen back to defaults.

One exported stub fixes that permanently — see the last section.

Until then, this page is the form itself: every field, with the value to put in
it. Fourteen fields, most of them defaults.

---

## Before you start

The Edge Function is deployed and tested — nothing to do there.

Your endpoint and token:

| | |
| --- | --- |
| URL | `https://mmwymuxutgmwfmvkvxzw.supabase.co/functions/v1/health` |
| Header name | `x-trendline-token` |
| Header value | your ingest token |

If you need the token again, in the Supabase SQL editor:

```sql
select token from public.ingest_tokens where label = 'ios-shortcut-steps';
```

The token goes in a **header**, not on the end of the URL. Both work, but URLs
turn up in logs, screenshots and share sheets in a way headers don't. It is a
narrow token either way — all it can do is set a step count on one day — but
there's no reason to hand it around more than necessary.

---

## The form, field by field

**Automations → New Automation → REST API**

| # | Field | Set it to | Why |
| --- | --- | --- | --- |
| 1 | Automation Name | `Trendline steps` | |
| 2 | Notifications | **Notify When Run** on | Turn it off once you trust it. For the first few days you want to see it fire. |
| 3 | URL | the address above | |
| 4 | Request Timeout | leave default | The function answers in well under a second. |
| 5 | HTTP Headers | key `x-trendline-token`, value your token | This is the authentication. |
| 6 | Data Type | **Health Metrics** | Not Workouts — see the last section. |
| 7 | Health Metrics | **Steps** only | Everything else is ignored on arrival, so sending it only costs battery. |
| 8 | Export Format | **JSON** | CSV is not read. |
| 9 | Export Version | **Version 2** | Either works — v2 only changes workout data, and metrics are identical — but v2 is the current one. |
| 10 | Date Range | **Default** | See below. This is the important one, and it is not the obvious choice. |
| 11 | Summarize Data | **on** | Gives one figure per period instead of every raw sample. |
| 12 | Time Grouping | **Day** | One number per day, which is what a day's step count is. |
| 13 | Batch Requests | **off** | Only matters for payloads far larger than this. |
| 14 | Sync Cadence | as often as offered | Cheap, and it makes the locked-phone problem below mostly go away. |

Then add the Automations **widget to your Home Screen**. Their docs say plainly
that it helps automations run in the background — it is a free reliability win
and takes ten seconds.

Tap **Run** to test. You should get back:

```json
{ "ok": true, "written": 7, "days": ["2026-09-05", "2026-09-04", …] }
```

Open Trendline, pull it fresh, and the days are in the log.

---

## Why "Default" and not "Previous 7 Days"

This one is counter-intuitive, I had it wrong at first, and it has already bitten
once: seven rows in the database ending *yesterday*, with the ingest token showing
it had run *today*. The pipe was fine; the window was stopping short of today.

If steps look stuck a day behind, this is why, and this is the fix.

Read their definitions side by side:

- **Default** — "the full previous day plus data up to the current date and time"
- **Previous 7 Days** — "the full previous seven days"

Only one of those says *up to the current time*. Today's steps are the number
you actually look at — they are what moves the calorie budget you are spending
right now — and Default is the only setting documented to include them.

So Default is the everyday automation. Its trailing edge is short, but with the
cadence running through the day that mostly stops mattering.

### Add a second automation for backfill

If you find gaps — days the phone was locked whenever the export fired —
duplicate the setup with **Date Range: Previous 7 Days** and a **daily** cadence.
Same URL, same header, same everything else.

Re-sending is free and safe. `ingest_steps` writes one row per date, keyed on
the date itself, so sending the same day fifty times leaves one row holding the
latest figure. It replaces; it never accumulates. That matters more than it
sounds: steps feed the exercise credit that comes off your calorie budget, and a
double-counted day would quietly hand you calories you never earned. Two
automations covering the same days cannot double-count.

It also handles Garmin arriving late — the watch syncs when it syncs, and a
day's step count can still be climbing hours after the day ended.

## The locked phone

**Apple Health cannot be read while the phone is locked.** Their own docs say
it: "Automations will only run during periods when your device is unlocked. This
is a limitation imposed by Apple which cannot be circumvented."

So an export scheduled for 3am, with the phone locked on a bedside table, reads
nothing. Any promise that this "runs every night with nothing to open" is
overselling — including the one I made about the Shortcut route.

Three things help, in order of effort:

1. **Charge the phone overnight.** iOS relaxes background limits while charging,
   so exports run more often.
2. **Schedule Reminders**, in the Notifications section — prompts to unlock and
   open the app. Crude, and it works.
3. **Trigger it from Shortcuts.** Health Auto Export exposes a **Run Automation**
   action, so a Shortcuts personal automation can fire it on "when I open
   Trendline" or any other trigger that implies the phone is already in your
   hand. A trigger tied to the precondition beats a fixed time that hopes for it.

Their docs also suggest iPhone Mirroring, which makes the phone behave as
unlocked — that is macOS only, so it is not available to you.

### Watch it work

Each automation has **View Activity Logs**, grouped by run. That is where to
look first when something seems wrong: it shows HTTP status codes, per-day
failures, and messages like "the device may have locked during the export.
Nothing was uploaded." — which tells you the difference between a broken setup
and a locked phone, in one line.

---

## When it doesn't work

Every failure returns a sentence, not a status code. Read the response.

**`"That ingest token is not recognised."`**
The header value is wrong or the token was revoked. Re-run the `select` above and
compare it character for character. Check the header *name* too —
`x-trendline-token`, all lower case, no spaces.

**`"No step data in that export. It carried: …"`**
It ran and sent something other than steps. The note names what actually
arrived. Go back to field 7 and select Steps.

**`"That export contained no metrics at all."`**
Usually the phone was locked when it fired, or the date range came back empty.
Unlock the phone and run it by hand to confirm the setup itself is right.

**A 404**
Check the URL. It ends `/functions/v1/health` with no trailing slash.

**"No health data was found in this date range, so nothing was uploaded."**
That is the app's own message, in Activity Logs, and it never reached Trendline.
Either there genuinely are no steps for the range, or the phone was locked.

**Scheduled runs do nothing, manual runs work**
That's the locked-phone problem. iOS also throttles background work for apps you
rarely open. The backfill automation is the fix, and it catches up whenever the
phone is next awake.

---

## What it doesn't import

Steps, and only steps.

Garmin also writes workouts and active energy into Apple Health. Importing those
would double-count: the same session logged once by you in Trendline and once by
your watch, both feeding the exercise credit. Trendline already knows about your
lifts and your cardio because you told it. Steps are the one thing it has no
other way to know.

---

---

## Making this importable

If you would rather import this than type it, one sample is all it takes:

1. Create any REST API automation — a name and a URL, everything else default.
2. Export or share it, or open **Files → iCloud Drive → Auto Export →
   Automations** and take the JSON that just appeared.
3. Send it over.

A stub has no token in it, so there is nothing sensitive in it at that point.
That one file gives the exact field names your app version uses, and a complete
automation comes back — every field below already set — for you to import over
the stub.

---

## Reference

- [REST API automation setup](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/)
- [JSON export format](https://help.healthyapps.dev/en/health-auto-export/export-format/)
- [Health metrics format](https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/)
- [Backup and restore, and the absence of automation import](https://help.healthyapps.dev/en/health-auto-export/automations/)
