# Steps from your watch, automatically

Garmin writes your step count into Apple Health. This gets it from there into
Trendline without you typing anything.

**Cost:** Health Auto Export is $5.99/year, or a one-off for lifetime. No Apple
Developer account is involved — that $99 is for shipping apps to the App Store,
not for using one.

---

## There is nothing to import — and that is the app, not an omission

Health Auto Export has no way to import an automation. No config file, no QR
code, no URL scheme, no duplicate button. The only transfer mechanism is its own
iCloud backup, which restores *your* automations onto *your* next phone; it
cannot take a file written by someone else.

So this page is the next best thing: every field of the form, with the value to
put in it. Fourteen fields, most of them defaults.

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
| 10 | Date Range | **Previous 7 Days** | See below. This is the important one. |
| 11 | Summarize Data | **on** | Gives one figure per period instead of every raw sample. |
| 12 | Time Grouping | **Day** | One number per day, which is what a day's step count is. |
| 13 | Batch Requests | **off** | Only matters for payloads far larger than this. |
| 14 | Sync Cadence | as often as offered | Cheap, and it makes the locked-phone problem below mostly go away. |

Tap **Run** to test. You should get back:

```json
{ "ok": true, "written": 7, "days": ["2026-09-05", "2026-09-04", …] }
```

Open Trendline, pull it fresh, and the days are in the log.

---

## Why seven days and not one

Two reasons, and they compound.

**Apple Health cannot be read while the phone is locked.** That is an iOS
security property, not a bug in the app and not something any app works around.
An export that fires while the phone sits locked on a bedside table reads
nothing. Any promise of "it runs every night with nothing to open" is overselling
— including the one I made about the Shortcut route.

**Garmin's numbers arrive late.** The watch syncs when it syncs, and a day's
step count can still be climbing hours after the day ended.

Re-sending the last seven days fixes both. A run that catches the phone unlocked
backfills whatever the locked runs missed, and a day still settling gets
corrected on the next pass.

Re-sending is safe. `ingest_steps` writes one row per date, keyed on the date
itself, so sending the same day fifty times leaves one row holding the latest
figure. It replaces; it never accumulates. That matters more than it sounds:
steps feed the exercise credit that comes off your calorie budget, and a
double-counted day would quietly hand you calories you never earned.

### If the scheduled runs keep missing

Health Auto Export exposes a **Run Automation** action to Apple Shortcuts. So
you can trigger it from a Shortcuts *personal automation* — "when I open
Trendline", or when the phone connects to CarPlay, or any other trigger that
implies the phone is in your hand and unlocked. That is a more reliable clock
than a fixed time, because it fires when the precondition is actually met
rather than hoping it will be.

Worth setting up only if the built-in cadence proves unreliable. Try it plain
first.

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

**Scheduled runs do nothing, manual runs work**
That's the locked-phone problem. iOS also throttles background work for apps you
rarely open. The seven-day window is the fix, and it catches up whenever the
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

## Reference

- [REST API automation setup](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/)
- [JSON export format](https://help.healthyapps.dev/en/health-auto-export/export-format/)
- [Health metrics format](https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/)
- [Backup and restore, and the absence of automation import](https://help.healthyapps.dev/en/health-auto-export/automations/)
