'use strict';

/* =============================================================
   TRENDLINE — STORE

   Local-first. localStorage is the source of truth for the UI and
   is written synchronously on every change; the cloud is a mirror
   that catches up when it can. The app is fully usable with no
   account and no network, forever.

   SCHEMA (v2) — shaped for sync, not for convenience:

     settings  one record
     foods     { id: record }    personal food library
     habits    { id: record }    habit definitions
     days      { date: record }  weight, note, habit ticks
     entries   { id: record }    one logged food line
     workouts  { id: record }    one training session or step count
     plans     { id: record }    a custom workout template, or a program

   Food lines are their own records rather than an array inside the
   day. If they lived on the day, logging breakfast on your phone and
   lunch on your laptop would resolve as last-writer-wins and one meal
   would silently vanish. As separate records they merge.

   Every record carries:
     updatedAt   ISO string, set on the device that made the edit.
                 Decides who wins a conflict.
     deletedAt   soft delete, so a deletion propagates instead of the
                 record simply reappearing from the other device.
     dirty       local-only flag: needs pushing. Cleared on success.
   ============================================================= */

var Store = (function () {

  var KEY = 'tl.v2';
  var LEGACY_KEY = 'wl.v1';

  function now() { return new Date().toISOString(); }

  function uid(prefix) {
    var rand;
    try {
      var a = new Uint8Array(8);
      crypto.getRandomValues(a);
      rand = Array.prototype.map.call(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (e) {
      rand = Math.random().toString(16).slice(2, 18);
    }
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + rand;
  }

  function defaultSettings() {
    return {
      sex: 'unspecified', age: 40, heightIn: 70, activity: 'moderate',
      goalWeight: null, goalRateLbPerWk: 1,
      proteinPerLb: 0.8, fatPerLb: 0.35, alpha: 0.15, floorKcal: 1200,
      /* Overrides the computed target when set. The formula runs
         underneath regardless, so clearing this returns to it. */
      targetOverride: null,
      /* Ounces a day. 64 is the familiar eight-glasses figure — a rule
         of thumb with no particular evidence behind it, which is why it
         is a default and not a recommendation. Set it to whatever you
         actually want to hit. */
      waterGoalOz: 64,
      /* The name of an iOS Shortcut that triggers Health Auto Export.
         Empty means the steps button just pulls what has already been
         sent, which is all a web app can do on its own. */
      stepsShortcut: '',
      updatedAt: now(), dirty: false
    };
  }

  function defaultHabits() {
    var t = now();
    return {
      h_protein: { id: 'h_protein', name: 'Hit protein target', sort: 0, updatedAt: t, deletedAt: null, dirty: false },
      h_steps:   { id: 'h_steps',   name: '8,000 steps',        sort: 1, updatedAt: t, deletedAt: null, dirty: false },
      h_alcohol: { id: 'h_alcohol', name: 'No alcohol',         sort: 2, updatedAt: t, deletedAt: null, dirty: false },
      h_sleep:   { id: 'h_sleep',   name: '7 hours sleep',      sort: 3, updatedAt: t, deletedAt: null, dirty: false }
    };
  }

  function defaults() {
    return {
      version: 2,
      deviceId: uid('dev'),
      settings: defaultSettings(),
      foods: {}, habits: defaultHabits(), days: {}, entries: {}, workouts: {}, plans: {},
      sync: { userId: null, email: null, cursors: {}, lastSyncAt: null, lastError: null }
    };
  }

  var state = null;

  /* ---------------------------------------------------------------
     LOAD / MIGRATE
     --------------------------------------------------------------- */

  function load() {
    if (state) return state;
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }

    if (!raw) {
      /* First run on a browser that has the old single-file version:
         bring it forward rather than making the user start over. */
      var legacy = null;
      try { legacy = localStorage.getItem(LEGACY_KEY); } catch (e) {}
      state = legacy ? migrateV1(safeParse(legacy)) : defaults();
      flush();
      return state;
    }

    var parsed = safeParse(raw);
    if (!parsed) {
      /* Never lose data to a parse error: park the bad blob under its
         own key and start clean rather than overwriting it. */
      try { localStorage.setItem(KEY + '.corrupt.' + Date.now(), raw); } catch (e) {}
      state = defaults();
      flush();
      return state;
    }
    state = normalize(parsed);
    return state;
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* Fill in anything a hand-edited or older payload is missing, so the
     rest of the app can stop null-checking. */
  function normalize(obj) {
    var d = defaults();
    if (!obj || typeof obj !== 'object') return d;
    if (obj.version === 1 || (obj.entries === undefined && obj.days === undefined)) {
      return migrateV1(obj);
    }
    var out = {
      version: 2,
      deviceId: obj.deviceId || d.deviceId,
      settings: Object.assign({}, d.settings, obj.settings || {}),
      foods: normalizeFoods(obj.foods),
      habits: obj.habits && typeof obj.habits === 'object' && Object.keys(obj.habits).length
        ? obj.habits : d.habits,
      days: obj.days && typeof obj.days === 'object' ? obj.days : {},
      entries: obj.entries && typeof obj.entries === 'object' ? obj.entries : {},
      /* Absent in payloads written before training existed. An older
         device syncing up must not have its file rejected for it. */
      workouts: obj.workouts && typeof obj.workouts === 'object' ? obj.workouts : {},
      plans: obj.plans && typeof obj.plans === 'object' ? obj.plans : {},
      sync: Object.assign({}, d.sync, obj.sync || {})
    };
    if (!out.sync.cursors || typeof out.sync.cursors !== 'object') out.sync.cursors = {};
    return out;
  }

  /* Foods written before recipes and tags existed have neither field.
     Filling them in here means the rest of the app can filter and tag
     without guarding every access. */
  function normalizeFoods(map) {
    if (!map || typeof map !== 'object') return {};
    Object.keys(map).forEach(function (k) {
      var f = map[k];
      if (!f || typeof f !== 'object') return;
      if (!f.kind) f.kind = 'food';
      if (!Array.isArray(f.tags)) f.tags = [];
      if (typeof f.servings !== 'number') f.servings = null;
    });
    return map;
  }

  /* v1 kept food lines in an array on each day and foods/habits in
     arrays. Everything becomes a keyed record with a timestamp. */
  function migrateV1(v1) {
    var out = defaults();
    if (!v1 || typeof v1 !== 'object') return out;
    var t = now();

    if (v1.settings) out.settings = Object.assign(out.settings, v1.settings, { updatedAt: t, dirty: true });

    (v1.foods || []).forEach(function (f) {
      if (!f || !f.name) return;
      var id = f.id || uid('f');
      out.foods[id] = {
        id: id, name: f.name, serving: f.serving || '',
        kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat,
        updatedAt: t, deletedAt: null, dirty: true
      };
    });

    if (Array.isArray(v1.habits) && v1.habits.length) {
      out.habits = {};
      v1.habits.forEach(function (h, i) {
        if (!h || !h.id) return;
        out.habits[h.id] = {
          id: h.id, name: h.name, sort: i,
          updatedAt: t, deletedAt: null, dirty: true
        };
      });
    }

    Object.keys(v1.entries || {}).forEach(function (date) {
      var e = v1.entries[date];
      if (!e) return;
      out.days[date] = {
        id: date, weight: (typeof e.weight === 'number' ? e.weight : null),
        note: e.note || '', habits: e.habits || {},
        updatedAt: t, deletedAt: null, dirty: true
      };
      (e.food || []).forEach(function (line) {
        var id = uid('e');
        out.entries[id] = {
          id: id, date: date, foodId: line.foodId || null, name: line.name || 'Quick add',
          qty: typeof line.qty === 'number' ? line.qty : 1,
          kcal: line.kcal, protein: line.protein, carbs: line.carbs, fat: line.fat,
          updatedAt: t, deletedAt: null, dirty: true
        };
      });
    });

    return out;
  }

  /* ---------------------------------------------------------------
     PERSIST
     --------------------------------------------------------------- */

  var saveTimer = null;
  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 120);
    if (typeof window !== 'undefined' && window.__tlChanged) window.__tlChanged();
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* Quota is the only realistic failure and it must be loud:
         silent data loss is the one thing a personal log cannot do. */
      if (typeof window !== 'undefined' && window.__tlSaveError) window.__tlSaveError(e);
    }
  }

  /* Mark a record edited on this device. Everything that mutates goes
     through here so nothing can be changed without becoming pushable. */
  function touch(rec) {
    rec.updatedAt = now();
    rec.dirty = true;
    return rec;
  }

  /* ---------------------------------------------------------------
     ACCESSORS — live records, deletions filtered out
     --------------------------------------------------------------- */

  function settings() { return load().settings; }
  function sync() { return load().sync; }
  function deviceId() { return load().deviceId; }

  function alive(map) {
    var out = [];
    Object.keys(map).forEach(function (k) {
      if (map[k] && !map[k].deletedAt) out.push(map[k]);
    });
    return out;
  }

  function foods() {
    return alive(load().foods).sort(function (a, b) {
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
  }

  function habits() {
    return alive(load().habits).sort(function (a, b) {
      return (a.sort || 0) - (b.sort || 0);
    });
  }

  function day(date) {
    var s = load();
    if (!s.days[date] || s.days[date].deletedAt) {
      s.days[date] = {
        id: date, weight: null, note: '', habits: {},
        updatedAt: now(), deletedAt: null, dirty: false
      };
    }
    if (!s.days[date].habits) s.days[date].habits = {};
    return s.days[date];
  }

  function peekDay(date) {
    var d = load().days[date];
    return (d && !d.deletedAt) ? d : null;
  }

  function entriesFor(date) {
    return alive(load().entries).filter(function (e) { return e.date === date; });
  }

  /* Shape the engine expects: { date: { weight, food[], habits } } */
  function engineEntries() {
    var s = load(), out = {};
    Object.keys(s.days).forEach(function (k) {
      var d = s.days[k];
      if (!d || d.deletedAt) return;
      out[k] = { weight: d.weight, habits: d.habits || {}, note: d.note || '', food: [] };
    });
    alive(s.entries).forEach(function (e) {
      if (!out[e.date]) out[e.date] = { weight: null, habits: {}, note: '', food: [] };
      out[e.date].food.push(e);
    });
    return out;
  }

  function weightPoints() {
    var s = load();
    return Object.keys(s.days).filter(function (k) {
      var d = s.days[k];
      return d && !d.deletedAt && typeof d.weight === 'number' && isFinite(d.weight) && d.weight > 0;
    }).sort().map(function (k) { return { date: k, weight: s.days[k].weight }; });
  }

  /* Day -> kcal, for days that have food logged. A day with an empty
     log is absent rather than zero: "ate nothing" and "logged nothing"
     must never be confused by the TDEE estimator. */
  function intakeMap() {
    var out = {};
    alive(load().entries).forEach(function (e) {
      var t = WL.lineTotals(e);
      out[e.date] = (out[e.date] || 0) + t.kcal;
    });
    return out;
  }

  /* Day -> { kcal, protein, carbs, fat }, for days with food logged.

     Same rule as intakeMap: a day with an empty log is absent rather
     than zero, so "ate no carbs" and "logged nothing" stay different
     things. An average that quietly counts unlogged days as zeroes is
     an average that always says you are doing better than you are. */
  function macroMap() {
    var out = {};
    alive(load().entries).forEach(function (e) {
      var t = WL.lineTotals(e);
      var d = out[e.date] || (out[e.date] = { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      d.kcal += t.kcal; d.protein += t.protein; d.carbs += t.carbs; d.fat += t.fat;
    });
    return out;
  }

  function loggedDates() {
    var s = load(), set = {};
    Object.keys(s.days).forEach(function (k) {
      var d = s.days[k];
      if (d && !d.deletedAt && (typeof d.weight === 'number' || d.note ||
        (d.habits && Object.keys(d.habits).length))) set[k] = 1;
    });
    alive(s.entries).forEach(function (e) { set[e.date] = 1; });
    alive(s.workouts).forEach(function (w) { set[w.date] = 1; });
    return Object.keys(set).sort();
  }

  /* ---------------------------------------------------------------
     MUTATIONS
     --------------------------------------------------------------- */

  function setWeight(date, lb) {
    var d = day(date);
    d.weight = (typeof lb === 'number' && isFinite(lb) && lb > 0) ? lb : null;
    touch(d);
    save();
  }

  /* Ounces drunk today. One running total rather than a list of
     glasses: nobody wants to audit their own hydration, they want to
     know whether to have another one. */
  function setWater(date, oz) {
    var d = day(date);
    var v = (typeof oz === 'number' && isFinite(oz) && oz >= 0) ? oz : 0;
    d.water = Math.min(v, 500);
    touch(d);
    save();
  }

  function waterOn(date) {
    var d = peekDay(date);
    return (d && typeof d.water === 'number') ? d.water : 0;
  }

  function setNote(date, text) {
    var d = day(date);
    d.note = text || '';
    touch(d);
    save();
  }

  function setHabit(date, habitId, on) {
    var d = day(date);
    if (on) d.habits[habitId] = true;
    else delete d.habits[habitId];
    touch(d);
    save();
  }

  function addEntry(date, line) {
    var s = load();
    var id = uid('e');
    s.entries[id] = touch({
      id: id, date: date, foodId: line.foodId || null,
      name: line.name || 'Quick add',
      qty: typeof line.qty === 'number' ? line.qty : 1,
      /* What was actually typed, alongside the servings it worked out
         to. Logging "2 oz" and reading back "x0.57" a week later is
         technically the same fact and practically a different one — you
         cannot check a number you do not recognise. qty stays the
         canonical amount; these two are how it was said. */
      amount: typeof line.amount === 'number' ? line.amount : null,
      unit: line.unit || null,
      kcal: line.kcal, protein: line.protein, carbs: line.carbs, fat: line.fat,
      deletedAt: null
    });
    save();
    return s.entries[id];
  }

  /* Change a line that is already logged.

     Only the fields passed are touched, and undefined is ignored rather
     than written, so an edit that adjusts calories cannot silently blank
     the macros next to them. */
  function updateEntry(id, patch) {
    var s = load();
    var e = s.entries[id];
    if (!e || e.deletedAt) return null;
    /* amount and unit belong on this list too. Leaving them off let an
       edit change the calories while the row went on claiming the old
       amount — a line reading "4 oz" beside six ounces of numbers,
       which is worse than either half being wrong alone. */
    ['name', 'qty', 'amount', 'unit', 'kcal', 'protein', 'carbs', 'fat'].forEach(function (k) {
      if (patch[k] !== undefined) e[k] = patch[k];
    });
    touch(e);
    save();
    return e;
  }

  function entry(id) {
    var e = load().entries[id];
    return (e && !e.deletedAt) ? e : null;
  }

  function removeEntry(id) {
    var s = load();
    if (!s.entries[id]) return;
    s.entries[id].deletedAt = now();
    touch(s.entries[id]);
    save();
  }

  /* ---------------------------------------------------------------
     WORKOUTS

     One record per session, and steps are a session too — a day's step
     count is a thing that happened, with a start and an end, and giving
     it its own kind keeps the calorie maths in one place instead of
     scattering a special case through the UI.

     Only one steps record per day is meaningful (the count is
     cumulative, so two of them would double-count), so writing steps
     replaces the day's existing steps record rather than adding to it.
     Sessions have no such rule: three walks in a day are three walks.
     --------------------------------------------------------------- */

  function workoutsFor(date) {
    return alive(load().workouts).filter(function (w) { return w.date === date; })
      .sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1; });
  }

  function addWorkout(date, w) {
    var s = load();
    var id = uid('w');
    s.workouts[id] = touch({
      id: id, date: date,
      kind: w.kind || 'cardio',
      activity: w.activity || null,
      name: w.name || '',
      minutes: typeof w.minutes === 'number' ? w.minutes : null,
      steps: typeof w.steps === 'number' ? w.steps : null,
      kcal: typeof w.kcal === 'number' ? w.kcal : null,
      sets: Array.isArray(w.sets) ? w.sets : null,
      /* Which catalog session this came from. Dropped here originally,
         which quietly severed the link a progression model needs to
         compare the same session across weeks. */
      templateId: w.templateId || null,
      finishedAt: null,
      createdAt: now(),
      deletedAt: null
    });
    save();
    return s.workouts[id];
  }

  function setSteps(date, steps) {
    var s = load();
    var existing = null;
    alive(s.workouts).forEach(function (w) {
      if (w.date === date && w.kind === 'steps') existing = w;
    });
    var n = (typeof steps === 'number' && isFinite(steps) && steps > 0) ? steps : null;

    if (existing) {
      if (n === null) { existing.deletedAt = now(); touch(existing); save(); return null; }
      existing.steps = n;
      touch(existing);
      save();
      return existing;
    }
    if (n === null) return null;
    return addWorkout(date, { kind: 'steps', steps: n, name: 'Steps' });
  }

  function stepsOn(date) {
    var found = null;
    alive(load().workouts).forEach(function (w) {
      if (w.date === date && w.kind === 'steps') found = w;
    });
    return found;
  }

  /* ---------------------------------------------------------------
     PLANS — custom workouts and programs

     One collection with a kind, rather than two tables, because they
     are the same record with a different payload: a workout is a list
     of exercises, a program is a list of workouts against days. Making
     them one thing means one editor shape, one sync mapping, and one
     place where "which of these still points at something real" is
     answered.

     The catalog's own sessions are NOT stored here. They are read-only
     seeds shipped with the app; copying one produces a plan you own and
     can edit, and the original stays put so a later catalog update does
     not silently rewrite something you changed.
     --------------------------------------------------------------- */

  function plans(kind) {
    return alive(load().plans)
      .filter(function (p) { return !kind || p.kind === kind; })
      .sort(function (a, b) {
        return String(a.name || '').toLowerCase() < String(b.name || '').toLowerCase() ? -1 : 1;
      });
  }

  function plan(id) {
    var p = load().plans[id];
    return (p && !p.deletedAt) ? p : null;
  }

  function savePlan(rec) {
    var s = load();
    var id = rec.id || uid('p');
    var prev = s.plans[id];
    s.plans[id] = touch({
      id: id,
      kind: rec.kind || (prev && prev.kind) || 'workout',
      name: rec.name || 'Untitled',
      /* A workout carries items; a program carries a schedule. The
         unused one stays null rather than an empty array, so "this
         program has no days yet" and "this is a workout" never look
         the same to anything reading it. */
      items: rec.items !== undefined ? rec.items : (prev ? prev.items : null),
      schedule: rec.schedule !== undefined ? rec.schedule : (prev ? prev.schedule : null),
      sourceId: rec.sourceId !== undefined ? rec.sourceId : (prev ? prev.sourceId : null),
      notes: rec.notes !== undefined ? rec.notes : (prev ? prev.notes : ''),
      deletedAt: null
    });
    save();
    return s.plans[id];
  }

  function removePlan(id) {
    var s = load();
    if (!s.plans[id]) return;
    s.plans[id].deletedAt = now();
    touch(s.plans[id]);
    save();
  }

  /* Programs that reference a workout. Asked before deleting one, so a
     program is never left pointing at nothing — a schedule with a hole
     in it is worse than a refusal to make one. */
  function programsUsing(workoutId) {
    return plans('program').filter(function (p) {
      return (p.schedule || []).some(function (d) { return d.planId === workoutId; });
    });
  }

  /* ---------------------------------------------------------------
     STRENGTH SESSIONS

     A session is a workout record whose `sets` array holds one row per
     PLANNED set, filled in as the set is done. Plan and result live in
     the same row on purpose: the prescription that was on screen when
     you lifted is the prescription the log should show forever, even
     if the template is edited afterwards.

     Each row:
       ex        exercise id            targetMin/Max  prescribed range
       name      display name at the    rirTarget      prescribed RIR
                 time it was logged     unit           reps|seconds|meters
       idx       set number             scope          total|per_side
       load      what was actually      reps           what was actually
                 selected                              achieved
       rir       what it actually felt  done           logged or not
                 like
     --------------------------------------------------------------- */

  function startSession(date, plan) {
    var rows = [];
    (plan.items || []).forEach(function (it) {
      for (var i = 1; i <= (it.sets || 1); i++) {
        rows.push({
          ex: it.ex, name: it.name, idx: i,
          targetMin: it.min, targetMax: it.max,
          rirTarget: (it.rir === undefined ? null : it.rir),
          unit: it.unit || 'reps',
          scope: it.scope || 'total',
          rest: it.rest || null,
          load: null, reps: null, rir: null, done: false
        });
      }
    });
    return addWorkout(date, {
      kind: 'lifting',
      name: plan.name || 'Workout',
      activity: plan.intensity || 'lift_moderate',
      minutes: null,
      templateId: plan.templateId || null,
      sets: rows
    });
  }

  /* Log one set in place. The row index is used rather than a search,
     because two sets of the same exercise are deliberately identical
     in every other respect and must stay individually addressable. */
  function logSet(workoutId, rowIndex, result) {
    var s = load();
    var w = s.workouts[workoutId];
    if (!w || w.deletedAt || !Array.isArray(w.sets)) return null;
    var row = w.sets[rowIndex];
    if (!row) return null;
    ['load', 'reps', 'rir'].forEach(function (k) {
      if (result[k] !== undefined) row[k] = result[k];
    });
    row.done = result.done !== undefined ? !!result.done : true;
    /* A whole new array so a merge from another device compares the
       session as one value rather than half-updating it. */
    w.sets = w.sets.slice();
    touch(w);
    save();
    return row;
  }

  /* Minutes are what the calorie estimate runs on, so a finished
     session needs them. Asked for at the end rather than the start:
     nobody knows how long a workout will take before doing it. */
  function finishSession(workoutId, minutes) {
    var s = load();
    var w = s.workouts[workoutId];
    if (!w || w.deletedAt) return null;
    if (typeof minutes === 'number' && minutes > 0) w.minutes = minutes;
    w.finishedAt = now();
    touch(w);
    save();
    return w;
  }

  /* The most recent completed sets for an exercise, newest first.
     This is the history a progression model reads. */
  function exerciseHistory(exerciseId, limit) {
    var out = [];
    alive(load().workouts).forEach(function (w) {
      if (!Array.isArray(w.sets)) return;
      w.sets.forEach(function (r, i) {
        if (r && r.done && r.ex === exerciseId) {
          out.push({
            date: w.date, workoutId: w.id, row: i,
            load: r.load, reps: r.reps, rir: r.rir,
            targetMin: r.targetMin, targetMax: r.targetMax, rirTarget: r.rirTarget
          });
        }
      });
    });
    out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.row - a.row; });
    return limit ? out.slice(0, limit) : out;
  }

  /* An unfinished session on this day, if there is one. Reopening the
     app mid-workout should land you back in the workout. */
  function openSession(date) {
    var found = null;
    alive(load().workouts).forEach(function (w) {
      if (w.date === date && w.kind === 'lifting' && Array.isArray(w.sets) &&
          w.sets.length && !w.finishedAt) found = w;
    });
    return found;
  }

  /* Change a workout in place — used when an exercise is appended to a
     session that is already running. */
  function updateWorkout(id, patch) {
    var s = load();
    var w = s.workouts[id];
    if (!w || w.deletedAt) return null;
    Object.keys(patch).forEach(function (k) {
      if (patch[k] !== undefined) w[k] = patch[k];
    });
    touch(w);
    save();
    return w;
  }

  function removeWorkout(id) {
    var s = load();
    if (!s.workouts[id]) return;
    s.workouts[id].deletedAt = now();
    touch(s.workouts[id]);
    save();
  }

  /* Tags are stored lower-cased and de-duplicated, because "Dinner" and
     "dinner" filtering as two different things is the kind of small
     betrayal that makes people stop tagging. */
  function cleanTags(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : String(list || '').split(','))
      .forEach(function (t) {
        var v = String(t || '').trim().toLowerCase();
        if (!v || seen[v]) return;
        seen[v] = 1; out.push(v);
      });
    return out;
  }

  function addFood(f) {
    var s = load();
    var id = f.id || uid('f');
    var prev = s.foods[id];
    s.foods[id] = touch({
      id: id, name: f.name, serving: f.serving || '',
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat,
      /* 'food' or 'recipe'. A recipe is something you assembled rather
         than bought, so it also knows how many servings it makes. */
      kind: f.kind || (prev && prev.kind) || 'food',
      servings: (typeof f.servings === 'number' && f.servings > 0) ? f.servings
        : (prev ? prev.servings : null) || null,
      tags: f.tags !== undefined ? cleanTags(f.tags) : ((prev && prev.tags) || []),
      /* Per serving, like the macros, and absent rather than empty when
         nothing is known. Carried forward on an edit so that correcting
         a calorie figure does not silently throw away a vitamin panel
         that took a lookup to acquire. */
      micros: f.micros !== undefined ? (f.micros || null) : ((prev && prev.micros) || null),
      deletedAt: null
    });
    save();
    return s.foods[id];
  }

  /* ---------------------------------------------------------------
     SEARCHING YOUR OWN LIBRARY

     What you already eat should be easier to reach than what a public
     database has heard of. A recipe you built and logged forty times is
     a better answer to "chicken" than the USDA's forty-first entry for
     raw poultry, and it always will be.

     rankLibrary is pure — it takes the list rather than reading
     storage — so the ordering can be tested without a browser.

     The order:

       1. An exact name match, whatever kind it is. If you typed the
          whole name of a thing, you meant that thing, and burying it
          under a fuzzy match would be perverse.
       2. Recipes, best match first. Something you assembled yourself
          is nearly always what you meant when its name comes up.
       3. Foods, best match first.

     Within each group, a name that STARTS with what you typed beats
     one that merely contains it, and a tag match comes last — a tag is
     a category, and a category is a weaker claim than a name.
     --------------------------------------------------------------- */

  function matchScore(food, q) {
    var name = String(food.name || '').toLowerCase();
    if (!name) return 0;
    if (name === q) return 4;
    if (name.indexOf(q) === 0) return 3;
    if (name.indexOf(q) >= 0) return 2;
    var tags = food.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (String(tags[i]).toLowerCase().indexOf(q) >= 0) return 1;
    }
    return 0;
  }

  function rankLibrary(list, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return (list || [])
      .map(function (f) { return { f: f, score: matchScore(f, q) }; })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) {
        /* An exact match outranks everything, including the recipe
           preference below it. */
        var aExact = a.score === 4, bExact = b.score === 4;
        if (aExact !== bExact) return aExact ? -1 : 1;

        var aRecipe = (a.f.kind || 'food') === 'recipe';
        var bRecipe = (b.f.kind || 'food') === 'recipe';
        if (aRecipe !== bRecipe) return aRecipe ? -1 : 1;

        if (a.score !== b.score) return b.score - a.score;
        return String(a.f.name).toLowerCase() < String(b.f.name).toLowerCase() ? -1 : 1;
      })
      .map(function (x) { return x.f; });
  }

  function searchLibrary(query, limit) {
    var out = rankLibrary(foods(), query);
    return limit ? out.slice(0, limit) : out;
  }

  /* Every tag in use, with how many foods carry it. Sorted by use, so
     the chips you reach for most are the ones nearest the front. */
  function allTags() {
    var counts = {};
    foods().forEach(function (f) {
      (f.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : 1);
    }).map(function (t) { return { tag: t, count: counts[t] }; });
  }

  function removeFood(id) {
    var s = load();
    if (!s.foods[id]) return;
    s.foods[id].deletedAt = now();
    touch(s.foods[id]);
    save();
  }

  /* One food by id. The micronutrient panel lives on the food rather
     than being copied onto every entry, so reading a day's micros means
     following foodId back here. */
  function food(id) {
    var f = load().foods[id];
    return (f && !f.deletedAt) ? f : null;
  }

  function findFoodByName(name) {
    var q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    var f = foods();
    for (var i = 0; i < f.length; i++) if (f[i].name.toLowerCase() === q) return f[i];
    return null;
  }

  function addHabit(name) {
    var s = load();
    var id = uid('h');
    s.habits[id] = touch({
      id: id, name: name, sort: Object.keys(s.habits).length,
      deletedAt: null
    });
    save();
    return s.habits[id];
  }

  function removeHabit(id) {
    var s = load();
    if (!s.habits[id]) return;
    s.habits[id].deletedAt = now();
    touch(s.habits[id]);
    save();
  }

  function setSetting(key, value) {
    var s = load();
    s.settings[key] = value;
    touch(s.settings);
    save();
  }

  /* ---------------------------------------------------------------
     EXPORT / IMPORT / RESET
     --------------------------------------------------------------- */

  function exportJSON() { return JSON.stringify(load(), null, 2); }

  /* Import replaces everything, and is validated first so a wrong file
     cannot wipe a real log. Every record is marked dirty so the import
     propagates to the cloud rather than being undone by the next pull. */
  function importJSON(text) {
    var parsed = safeParse(text);
    if (!parsed || typeof parsed !== 'object') return false;
    if (!parsed.entries && !parsed.days) return false;
    var keepSync = load().sync;
    var next = normalize(parsed);
    /* Cursors are reset so the next pull re-reads the whole cloud copy
       and reconciles it against what was just imported. */
    next.sync = { userId: keepSync.userId, email: keepSync.email, cursors: {}, lastSyncAt: null, lastError: null };
    ['foods', 'habits', 'days', 'entries', 'workouts', 'plans'].forEach(function (c) {
      Object.keys(next[c]).forEach(function (k) { next[c][k].dirty = true; });
    });
    next.settings.dirty = true;
    state = next;
    flush();
    return true;
  }

  function reset() {
    var keepSync = load().sync;
    state = defaults();
    state.sync.userId = keepSync.userId;
    state.sync.email = keepSync.email;
    flush();
  }

  /* Local wipe used when signing out: the account's data stays in the
     cloud, it just stops living on this device. */
  function clearLocal() {
    state = defaults();
    flush();
  }

  return {
    KEY: KEY, LEGACY_KEY: LEGACY_KEY,
    load: load, save: save, flush: flush, touch: touch, now: now, uid: uid,
    defaults: defaults, normalize: normalize, migrateV1: migrateV1,
    settings: settings, sync: sync, deviceId: deviceId,
    foods: foods, habits: habits, day: day, peekDay: peekDay,
    entriesFor: entriesFor, engineEntries: engineEntries,
    workoutsFor: workoutsFor, addWorkout: addWorkout, removeWorkout: removeWorkout,
    setSteps: setSteps, stepsOn: stepsOn,
    rankLibrary: rankLibrary, searchLibrary: searchLibrary,
    plans: plans, plan: plan, savePlan: savePlan, removePlan: removePlan,
    programsUsing: programsUsing,
    startSession: startSession, logSet: logSet, finishSession: finishSession,
    updateWorkout: updateWorkout,
    exerciseHistory: exerciseHistory, openSession: openSession,
    weightPoints: weightPoints, intakeMap: intakeMap, macroMap: macroMap, loggedDates: loggedDates,
    setWeight: setWeight, setNote: setNote, setHabit: setHabit,
    setWater: setWater, waterOn: waterOn,
    addEntry: addEntry, updateEntry: updateEntry, entry: entry, removeEntry: removeEntry,
    addFood: addFood, food: food, removeFood: removeFood, findFoodByName: findFoodByName,
    allTags: allTags, cleanTags: cleanTags,
    addHabit: addHabit, removeHabit: removeHabit, setSetting: setSetting,
    exportJSON: exportJSON, importJSON: importJSON, reset: reset, clearLocal: clearLocal
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Store;
