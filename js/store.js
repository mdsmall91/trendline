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
      foods: {}, habits: defaultHabits(), days: {}, entries: {}, workouts: {},
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
    ['name', 'qty', 'kcal', 'protein', 'carbs', 'fat'].forEach(function (k) {
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
      deletedAt: null
    });
    save();
    return s.foods[id];
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
    ['foods', 'habits', 'days', 'entries', 'workouts'].forEach(function (c) {
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
    weightPoints: weightPoints, intakeMap: intakeMap, macroMap: macroMap, loggedDates: loggedDates,
    setWeight: setWeight, setNote: setNote, setHabit: setHabit,
    addEntry: addEntry, updateEntry: updateEntry, entry: entry, removeEntry: removeEntry,
    addFood: addFood, removeFood: removeFood, findFoodByName: findFoodByName,
    allTags: allTags, cleanTags: cleanTags,
    addHabit: addHabit, removeHabit: removeHabit, setSetting: setSetting,
    exportJSON: exportJSON, importJSON: importJSON, reset: reset, clearLocal: clearLocal
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Store;
