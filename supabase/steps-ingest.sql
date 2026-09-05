-- =============================================================
-- TRENDLINE — STEP INGEST
--
-- Lets an iOS Shortcut write a daily step count into your log
-- without holding your Trendline password.
--
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Safe to re-run.
--
-- WHY A TOKEN AND NOT A PASSWORD
--
-- The obvious way to do this is to have the Shortcut sign in with your
-- email and password and use the session it gets back. That works, and
-- it means a copy of the password that opens your whole account is
-- sitting in a Shortcut, in plain text, forever.
--
-- Instead: one function, callable by anyone holding a token, which can
-- do exactly one thing — set the step count on one day. It cannot read
-- your weight, your food, or anything else. If the token leaks, the
-- worst anyone can do is lie to you about how much you walked, and you
-- revoke it with one DELETE.
--
-- The function is SECURITY DEFINER, so it runs as its owner and steps
-- around Row Level Security deliberately. That is the whole point: the
-- caller is anonymous and has no session, and the token is what
-- establishes which account the row belongs to.
-- =============================================================

-- ---------- tokens ----------

create table if not exists public.ingest_tokens (
  token        text primary key,
  user_id      uuid not null references auth.users on delete cascade,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- No policies are created on purpose. RLS is on and nothing is granted,
-- so the table is unreachable through the REST API in either direction —
-- the only thing that ever reads it is the SECURITY DEFINER function
-- below, and the only thing that writes it is you, here.
alter table public.ingest_tokens enable row level security;
revoke all on public.ingest_tokens from anon, authenticated;

-- ---------- the one thing it can do ----------

create or replace function public.ingest_steps(
  p_token text,
  p_date  text,
  p_steps double precision
)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid;
  v_id   text;
begin
  -- Reject anything that is not a plausible day key before it reaches
  -- the table, so a malformed Shortcut cannot invent rows on dates that
  -- do not exist.
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'date must be YYYY-MM-DD';
  end if;

  if p_steps is null or p_steps < 0 or p_steps > 200000 then
    raise exception 'steps out of range';
  end if;

  select user_id into v_user from ingest_tokens where token = p_token;
  if v_user is null then
    raise exception 'invalid token';
  end if;

  update ingest_tokens set last_used_at = now() where token = p_token;

  -- A deterministic id, so running the Shortcut twice in a day replaces
  -- the count rather than adding a second one. Step counts are
  -- cumulative: two rows for one day would be double-counted by the
  -- calorie estimate, which is the whole reason the app treats steps as
  -- one record per day.
  v_id := 'steps_' || p_date;

  -- Any OTHER steps record for the same day — one typed into the app
  -- before the Shortcut existed, say — is soft-deleted rather than left
  -- to be summed alongside this one. Soft, so the deletion syncs to the
  -- phone instead of the record simply coming back.
  update workouts
     set deleted_at = now(), updated_at = now()
   where user_id = v_user
     and date = p_date
     and kind = 'steps'
     and id <> v_id
     and deleted_at is null;

  insert into workouts (user_id, id, date, kind, name, steps, created_at, updated_at, deleted_at)
  values (v_user, v_id, p_date, 'steps', 'Steps', p_steps, now(), now(), null)
  on conflict (user_id, id) do update
    set steps      = excluded.steps,
        deleted_at = null,
        updated_at = now();

  return json_build_object('ok', true, 'date', p_date, 'steps', p_steps);
end
$fn$;

-- Callable without a session. The token inside the call is the credential.
grant execute on function public.ingest_steps(text, text, double precision) to anon, authenticated;

-- ---------- issue yourself a token ----------
-- Run this after the above. Copy the token it prints into the Shortcut.

insert into public.ingest_tokens (token, user_id, label)
select gen_random_uuid()::text, id, 'ios-shortcut-steps'
  from auth.users
 where email = 'coloradojeeper.small@gmail.com'
   and not exists (
     select 1 from public.ingest_tokens t
      where t.user_id = auth.users.id and t.label = 'ios-shortcut-steps'
   );

select token as copy_this_into_the_shortcut, label, created_at
  from public.ingest_tokens
 where label = 'ios-shortcut-steps';

-- ---------- if it ever leaks ----------
-- delete from public.ingest_tokens where label = 'ios-shortcut-steps';
-- then re-run the insert above for a new one.
