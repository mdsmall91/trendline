# Daily steps from Garmin, automatically

Garmin has no API a web app can call. What it does have is Apple Health:
Garmin Connect writes your step count there, and iOS Shortcuts can read
Health and post anywhere. So the chain is

```
Garmin watch → Garmin Connect → Apple Health → Shortcut → Trendline
```

---

## There is now an easier route

Health Auto Export does the phone half of this for about six dollars a year,
replacing every step below with a form. See
[`HEALTH-EXPORT.md`](HEALTH-EXPORT.md). Both routes end at the same database
function and you can switch between them freely — the token is the same one.

This page stays because it costs nothing and does work.

## A correction to what this page used to claim

It said the Shortcut "runs itself, nightly, with nothing to open." That was
too strong, and the reason applies to both routes:

**Apple Health cannot be read while the phone is locked.** An automation that
fires at 11pm while the phone sits locked on a bedside table reads nothing. It
is an iOS security property — no app or Shortcut gets around it.

So schedule it for a time you are usually holding the phone, and have it send
the last several days rather than only yesterday. `ingest_steps` keys its row on
the date, so re-sending a day replaces it instead of adding to it, and a run
that catches the phone awake backfills whatever the locked runs missed. That
also picks up late Garmin syncs, where a day's count is still climbing hours
after the day ended.

---

## Before anything else: check Garmin is writing to Health

This is the step people skip, and nothing works without it.

**Garmin Connect app → More → Settings → Apple Health → turn on Steps.**

Then open the **Health** app → Browse → Activity → Steps and confirm today
has a number in it. If Health is empty, fix that before touching Shortcuts —
the Shortcut can only read what is already there.

---

## 1. Install the database side

In Supabase → SQL Editor → New query, paste the whole of
[`supabase/steps-ingest.sql`](supabase/steps-ingest.sql) and run it.

It creates one function that can do exactly one thing — set the step count
on one day — and issues you a token to call it with.

The last statement prints the token. Copy it; you need it in step 3.

**Why a token rather than your password.** The obvious design has the
Shortcut sign in with your email and password and use the session. That
works, and it leaves a copy of the password that opens your whole account
sitting in a Shortcut in plain text forever. The token can only write step
counts and cannot read anything at all. If it leaks, the worst anyone can do
is lie to you about how far you walked, and you revoke it with one line of
SQL.

---

## 2. Build the Shortcut

Shortcuts app → **+** → name it `Trendline Steps`. Add these in order.

**a. Find Health Samples**
- Type: **Steps**
- Add filter: **Start Date** — *is today*
- Sort by Start Date, Limit off

**b. Calculate Statistics**
- Operation: **Sum**
- Input: the samples from step a
- Property: **Value**

**c. Round Number**
- Round the result of step b to the nearest **1**

Health returns steps as many small samples across the day — one per burst of
walking — so they have to be summed. Skipping this posts whatever the last
fragment happened to be, which is why a step count that looks like `43`
means this action is missing.

**d. Format Date**
- Date: **Current Date**
- Format: **Custom**, `yyyy-MM-dd`

**e. Get Contents of URL**
- URL:
  ```
  https://mmwymuxutgmwfmvkvxzw.supabase.co/rest/v1/rpc/ingest_steps
  ```
- Method: **POST**
- Headers:
  | Key | Value |
  |---|---|
  | `apikey` | `sb_publishable_tSgaTLZRuwluENMxA2Nlgw_XVwFFrWy` |
  | `Content-Type` | `application/json` |
- Request Body: **JSON**
  | Key | Type | Value |
  |---|---|---|
  | `p_token` | Text | *the token from step 1* |
  | `p_date` | Text | *the Formatted Date from step d* |
  | `p_steps` | Number | *the Rounded Number from step c* |

Run it once with the ▶ button. iOS asks for Health permission the first
time — allow it. A successful run returns

```json
{"ok": true, "date": "2026-09-05", "steps": 8412}
```

If you get `invalid token`, the token was pasted wrong. If you get
`date must be YYYY-MM-DD`, the Format Date step is not wired into `p_date`.

---

## 3. Make it automatic

Shortcuts → **Automation** tab → **+** → **Time of Day**

- Time: **11:45 PM**
- Repeat: **Daily**
- **Run Immediately**, and turn **Notify When Run** off

11:45pm rather than 10pm because the count is a snapshot of the day so far —
an evening walk after the automation runs would not be counted until the
following night's run overwrote it, and by then the date has changed.

Running it more than once a day is harmless. The function writes a fixed row
per date, so a second run replaces the count rather than adding to it. That
also means you can hit ▶ manually any time you want the number to catch up.

---

## What you should see

Within a few minutes — sooner if you open the app, which syncs on launch and
every ten minutes while it is open — the **Train** tab shows a **Steps** row
for today with the count and its calorie estimate, and half of that estimate
lands on your food target for the day.

If the app already had a hand-typed step count for that day, the Shortcut's
number replaces it. One steps record per day is a rule the app relies on:
step counts are cumulative, so two rows would be double-counted.

---

## When something goes wrong

**The Shortcut returns a big number every day, but the app shows nothing.**
Sync has not run on the device you are looking at. Open the app; it syncs on
launch. Check the pill says `synced`.

**`invalid token`.** The token was pasted with a space or is from a deleted
row. Re-run the last SELECT in `steps-ingest.sql` to see the current one.

**Steps are far too low.** The Calculate Statistics step is missing or is
summing the wrong property. Health stores the day as many samples; the sum
of `Value` is the day's total.

**Steps are roughly double.** Two sources are writing to Health — commonly
Garmin *and* the iPhone's own pedometer. In the Health app, Browse → Steps →
Data Sources & Access, and drag Garmin above iPhone, or turn the iPhone off
as a source.

**It stopped running.** iOS disables automations that fail repeatedly, and
turns them off after some updates. Shortcuts → Automation → check it is
still enabled.
