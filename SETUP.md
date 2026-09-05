# Finalizing Supabase

Turning on sync. About ten minutes, free, no credit card.

Sync is optional — Trendline works fully without it. What you get: your log
follows you between phone and laptop, and stops being one cleared browser
cache away from gone.

---

## 1. Create the project

[supabase.com](https://supabase.com) → sign in → **New project**

| Field | Value |
|---|---|
| Name | `Trendline` |
| Database password | **Generate a new one** and put it in your password manager |
| Region | Whichever is closest to you |
| Plan | Free |

Provisioning takes a couple of minutes.

> The database password is for connecting to Postgres directly. Trendline
> never uses it — the app authenticates with the anon key and an emailed
> code. So you never paste it into the app, and it should not be a password
> you use anywhere else.

---

## 2. Create the tables

**SQL Editor** → **New query** → paste the entire contents of
[`supabase/schema.sql`](supabase/schema.sql) → **Run**.

You want `Success. No rows returned`.

Then check **Table Editor**. You should see six tables — `settings`,
`foods`, `habits`, `days`, `entries`, `workouts` — each marked **RLS
enabled**.

> **Already set this up before training existed?** Re-run the whole file.
> It is idempotent, it does not touch existing rows, and it adds the
> `workouts` table. Without it, training logs stay on the device they were
> entered on and never reach your other devices.

**If any table does not say RLS enabled, stop and re-run the script.** Row
Level Security is the only thing standing between your data and anyone who
opens the app's page. The anon key is public by design; the policy is what
restricts every row to the account that created it.

The script is safe to run more than once.

---

## 3. Turn off email confirmation

**Authentication → Providers → Email**

- **Enable Email provider**: on (it is by default)
- **Confirm email**: **off**

That's it. Trendline signs you in with an email and a password, so no
message ever has to be sent or received. Leave *Confirm email* on and
Supabase withholds the session until you click a link in an email, which
is the one thing that stalls setup.

Passkeys, OAuth providers and phone auth are all irrelevant here — the app
doesn't use them, and enabling them changes nothing.

### If you'd rather not have a password

There's a second sign-in option in the app — **Email me a code instead** —
which sends a six-digit code. It needs one extra step, because Supabase's
stock template sends a *link* and the app asks for a *code*: go to
**Authentication → Emails → Magic Link** and put `{{ .Token }}` in the
template body:

```html
<h2>Your Trendline sign-in code</h2>
<p>Enter this in the app:</p>
<p style="font-size:28px;letter-spacing:6px;font-family:monospace"><b>{{ .Token }}</b></p>
<p>It expires in an hour.</p>
```

If that screen is read-only or missing in your dashboard, ignore it and use
the password. Codes exist for people who don't want a password, not because
they work better.

Why a code and not the link itself: a magic link has to open in the exact
browser that asked for it. On iOS a home-screen app has its own storage,
separate from Safari, so tapping the link in Mail signs in Safari and
leaves the app still logged out.

## 4. Copy the two values

**Project Settings → API**

- **Project URL** — `https://<something>.supabase.co`
- **anon** / **public** key — the long one labelled `anon`

Take the **anon** key. **Not** the `service_role` / secret key, which sits
right next to it and looks nearly identical. That key bypasses Row Level
Security, and putting it in a page that ships to your phone would hand
anyone who opens that page your whole database. Trendline refuses it if you
paste it by mistake, but know the difference anyway.

---

## 5. Turn on sync

Open Trendline → **Setup → Sync**, paste the URL and key, **Turn on sync**.

Then enter your email and a password and press **Create account**. First
device only — on every device after that, use the same email and password
and press **Sign in**. That shared account is what ties them together.

### Making it permanent (optional)

Values entered in the app live on that device only. To have every device
pick them up automatically, put them in [`config.js`](config.js) and push:

```js
var CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...'
};
```

Both are safe to commit — that is the entire point of Row Level Security. A
filled-in `config.js` overrides anything typed on a device, so there is one
source of truth.

---

## 5b. Food search (optional, 60 seconds)

Barcode scanning needs nothing — it uses Open Food Facts, which has no key
and no account. Searching foods by *name* uses the USDA database, which
wants a free key.

[fdc.nal.usda.gov/api-key-signup.html](https://fdc.nal.usda.gov/api-key-signup.html)
— email address, no card, key arrives instantly. Paste it into
**Setup → Food lookup** and press **Test it**.

You can also put it in `config.js` as `USDA_API_KEY` so every device picks
it up. Weigh that against the repo being public: unlike the Supabase anon
key, which is protected by Row Level Security, a USDA key in a public repo
is a rate limit strangers can spend. On a private repo, commit it. On a
public one, the per-device field is the safer place.

Skip this entirely and everything else still works — you just type macros
by hand for foods without a barcode, which is what the app did before.

---

## 6. Prove it actually works

Don't trust the green pill. Check both ends.

1. In the app, log a weight and a quick-add calorie entry.
2. Tap the sync pill in the header. It should read **synced**.
3. In Supabase → **Table Editor → days**. Your weigh-in should be sitting
   there, with your `user_id` on it.
4. Open the app on a second device, sign in with the same email. Your
   history should arrive within a few seconds.

If step 4 works, you're done.

---

## When something goes wrong

**"Account created, but the project requires email confirmation."**
*Confirm email* is still on — see step 3. Turn it off, then **Sign in**
(the account already exists; don't press Create account again).

**"Invalid login credentials".** Wrong password, or no account yet on this
project. Press **Create account** once, then **Sign in** everywhere else.

**The email has a link, not a code.** Only applies to the code option. The
Magic Link template needs `{{ .Token }}` — or just use a password.

**"Email rate limit exceeded".** Supabase's built-in mail server allows only
a handful of messages per hour — it is meant for testing. Wait an hour. You
sign in once per device, so this rarely comes up. If it becomes a nuisance,
add your own SMTP under **Authentication → Emails → SMTP Settings**;
Resend's free tier is plenty.

**The pill says "retry" and Setup shows an error.**

| Error | Cause |
|---|---|
| `401` / `JWT` | Wrong key, or the URL and key are from different projects |
| `relation ... does not exist` | Step 2 didn't run — re-run `schema.sql` |
| `permission denied` | RLS policies missing — re-run `schema.sql` |
| `Failed to fetch` | Offline, or the project is paused (see below) |

**Nothing syncs after a week away.** Free projects pause after about seven
days of no activity. The dashboard has a **Restore** button. An app you open
daily never goes quiet.

**Sync is broken and I want my data.** It is already on your device —
Trendline is local-first and never waits on the network. **Setup → Export
JSON** works offline and always has.

---

## What this costs

Nothing. Free tier is 500MB of database and 50,000 monthly active users. A
year of daily logging is a few megabytes, and the user count here is one.
