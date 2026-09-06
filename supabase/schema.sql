-- =============================================================
-- TRENDLINE — CLOUD SCHEMA
--
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Safe to re-run: everything is IF NOT EXISTS / OR REPLACE.
--
-- Shape notes:
--   * Primary key is (user_id, id). Record ids are generated on the
--     device, so scoping them by user keeps two accounts from ever
--     colliding on a date string like '2026-09-05'.
--   * updated_at comes from the device that made the edit and decides
--     conflicts. synced_at is set here and is only ever a read cursor,
--     so a device with a wrong clock cannot hide its own rows.
--   * deleted_at is a soft delete. A hard delete is indistinguishable
--     from a row the other device has not seen yet, and would simply
--     come back on the next sync.
--   * RLS restricts every row to its owner. This is the actual security
--     boundary — the anon key in config.js is public by design.
-- =============================================================

-- ---------- tables ----------

create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null,
  synced_at  timestamptz not null default now()
);

create table if not exists public.foods (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  name       text,
  serving    text,
  -- 'food' or 'recipe'. A recipe is a food you assembled rather than
  -- bought, so it carries how many servings it makes; everything else
  -- about it behaves identically, which is why it is a column and not
  -- a second table.
  kind       text,
  servings   double precision,
  tags       jsonb,
  kcal       double precision,
  protein    double precision,
  carbs      double precision,
  fat        double precision,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.habits (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  name       text,
  sort       integer default 0,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- id is the calendar day, 'YYYY-MM-DD'
create table if not exists public.days (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  weight     double precision,
  note       text,
  habits     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- one logged food line. Separate from days so that logging breakfast on
-- one device and lunch on another merges instead of one overwriting the
-- other.
create table if not exists public.entries (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  date       text not null,
  food_id    text,
  name       text,
  qty        double precision,
  kcal       double precision,
  protein    double precision,
  carbs      double precision,
  fat        double precision,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- one training session. Steps are a session too: a day's step count has
-- a start and an end, and giving it a kind keeps the calorie maths in
-- one place. `sets` is free-form lifting detail (exercise/sets/reps/
-- weight) that the calorie estimate deliberately does not read.
create table if not exists public.workouts (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  date       text not null,
  kind       text,
  activity   text,
  name       text,
  minutes    double precision,
  steps      double precision,
  kcal       double precision,
  sets       jsonb,
  -- which catalog session this was started from, and when it was
  -- finished. An unfinished session is one you are still standing in.
  template_id text,
  finished_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- Columns added after the first release. Existing projects re-run this
-- file and pick them up; a fresh one gets them from the create above.
alter table public.workouts add column if not exists template_id text;
alter table public.workouts add column if not exists finished_at timestamptz;
alter table public.foods add column if not exists kind     text;
alter table public.foods add column if not exists servings double precision;
alter table public.foods add column if not exists tags     jsonb;

-- a custom workout template, or a program that schedules them. One
-- table with a kind, because they are the same record with a different
-- payload and splitting them would double every mapping for nothing.
create table if not exists public.plans (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  kind       text,
  name       text,
  items      jsonb,
  schedule   jsonb,
  source_id  text,
  notes      text,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

-- The amount as it was typed, next to the servings it became. Added
-- after the fact, so these are ALTERs rather than columns in the create
-- above — running this file on an existing project has to stay safe.
alter table public.entries add column if not exists amount double precision;
alter table public.entries add column if not exists unit   text;

-- ---------- pull cursor ----------
-- Every read is "give me what changed since X", so this index is the
-- one that matters.

create index if not exists settings_cursor_idx on public.settings (user_id, synced_at);
create index if not exists foods_cursor_idx    on public.foods    (user_id, synced_at);
create index if not exists habits_cursor_idx   on public.habits   (user_id, synced_at);
create index if not exists days_cursor_idx     on public.days     (user_id, synced_at);
create index if not exists entries_cursor_idx  on public.entries  (user_id, synced_at);
create index if not exists entries_date_idx    on public.entries  (user_id, date);
create index if not exists workouts_cursor_idx on public.workouts (user_id, synced_at);
create index if not exists workouts_date_idx   on public.workouts (user_id, date);
create index if not exists plans_cursor_idx    on public.plans    (user_id, synced_at);

-- synced_at must be server-set on every write, including upserts that
-- arrive with a stale value in the payload.
create or replace function public.touch_synced_at()
returns trigger language plpgsql as $$
begin
  new.synced_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['settings','foods','habits','days','entries','workouts','plans'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before insert or update on public.%I
       for each row execute function public.touch_synced_at()', t, t);
  end loop;
end $$;

-- ---------- row level security ----------
-- Without this the anon key would be readable by anyone. With it, a row
-- is only ever visible or writable by the account that owns it.

alter table public.settings enable row level security;
alter table public.foods    enable row level security;
alter table public.habits   enable row level security;
alter table public.days     enable row level security;
alter table public.entries  enable row level security;
alter table public.workouts enable row level security;
alter table public.plans    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings','foods','habits','days','entries','workouts','plans'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I
         for all to authenticated
         using (user_id = auth.uid())
         with check (user_id = auth.uid())', t);
  end loop;
end $$;
