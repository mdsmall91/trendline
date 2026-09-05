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

Then check **Table Editor**. You should see five tables — `settings`,
`foods`, `habits`, `days`, `entries` — each marked **RLS enabled**.

**If any table does not say RLS enabled, stop and re-run the script.** Row
Level Security is the only thing standing between your data and anyone who
opens the app's page. The anon key is public by design; the policy is what
restricts every row to the account that created it.

The script is safe to run more than once.

---

## 3. Send a code instead of a link

**This is the step that otherwise makes the app look broken.**

Supabase's default sign-in email contains a magic *link*. Trendline asks
for a six-digit *code*, because a link has to open in the exact browser
that requested it — which on iOS routinely means the wrong one, and would
break sign-in on a home-screen app.

**Authentication → Emails → Magic Link**, and replace the message body:

```html
<h2>Your Trendline sign-in code</h2>
<p>Enter this in the app:</p>
<p style="font-size:28px;letter-spacing:6px;font-family:monospace"><b>{{ .Token }}</b></p>
<p>It expires in an hour. If you didn't ask for it, ignore this email.</p>
```

Save. The `{{ .Token }}` placeholder is what produces the six digits.

While you're in **Authentication → Providers**, confirm **Email** is
enabled. It is on by default.

---

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

Open Trendline → **Setup → Sync**, paste both values, **Turn on sync**.

Then enter your email, and type the six digits from the message.

Do the same on every other device, **with the same email address**. That is
what ties them to one account.

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

**The email has a link, not a code.** Step 3 was skipped. Fix the template
and request a new code.

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
