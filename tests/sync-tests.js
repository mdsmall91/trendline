'use strict';

/* Tests for the sync merge logic and the v1 -> v2 migration.
   Runs in the browser and under node. The network half is not mocked;
   what is tested is the part that can silently lose data. */

(function (root) {
  var Sync  = root.Sync  || require('../js/sync.js');
  var Store = root.Store || require('../js/store.js');

  var failures = [], passes = 0;
  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) { check(name, got === want, JSON.stringify(got) + ' != ' + JSON.stringify(want)); }

  var T1 = '2026-09-01T10:00:00.000Z';
  var T2 = '2026-09-01T11:00:00.000Z';
  var T3 = '2026-09-01T12:00:00.000Z';

  /* ---------- pickWinner ---------- */
  var a = { id: 'x', name: 'local', updatedAt: T2 };
  var b = { id: 'x', name: 'remote', updatedAt: T1 };
  eq('later local edit wins', Sync.pickWinner(a, b).name, 'local');
  eq('later remote edit wins', Sync.pickWinner(b, a).name, 'local');
  eq('missing local takes remote', Sync.pickWinner(null, b).name, 'remote');
  eq('missing remote keeps local', Sync.pickWinner(a, null).name, 'local');
  /* Ties must resolve the same way on every device or they re-push forever. */
  eq('tie goes to remote', Sync.pickWinner(
    { id: 'x', name: 'local', updatedAt: T1 },
    { id: 'x', name: 'remote', updatedAt: T1 }).name, 'remote');

  /* ---------- mergeCollection ---------- */
  var local = {
    keep:  { id: 'keep',  v: 'local',  updatedAt: T3, dirty: true },
    lose:  { id: 'lose',  v: 'local',  updatedAt: T1, dirty: true },
    alone: { id: 'alone', v: 'local',  updatedAt: T2, dirty: true }
  };
  var res = Sync.mergeCollection(local, [
    { id: 'keep', v: 'remote', updatedAt: T2 },
    { id: 'lose', v: 'remote', updatedAt: T3 },
    { id: 'new',  v: 'remote', updatedAt: T2 }
  ]);
  eq('newer local survives the pull', local.keep.v, 'local');
  check('surviving local stays dirty so it still pushes', local.keep.dirty === true);
  eq('older local is overwritten', local.lose.v, 'remote');
  check('overwritten local is no longer dirty', local.lose.dirty === false);
  eq('unseen remote record is added', local['new'].v, 'remote');
  check('added remote is not dirty', local['new'].dirty === false);
  eq('local-only record is untouched', local.alone.v, 'local');
  eq('applied count', res.applied, 2);
  eq('kept count', res.kept, 1);
  check('malformed remote rows are ignored', (function () {
    var m = {}; Sync.mergeCollection(m, [null, {}, { id: 'ok', updatedAt: T1 }]);
    return Object.keys(m).length === 1;
  })());

  /* ---------- dirty collection ---------- */
  eq('collectDirty finds only dirty', Sync.collectDirty({
    a: { id: 'a', dirty: true }, b: { id: 'b', dirty: false }, c: { id: 'c', dirty: true }
  }).length, 2);

  /* ---------- wire format ---------- */
  var rec = {
    id: 'e1', date: '2026-09-01', foodId: 'f1', name: 'Eggs', qty: 2,
    kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5,
    updatedAt: T1, deletedAt: null, dirty: true
  };
  var row = Sync.toRow('entries', rec, 'user-1');
  eq('camelCase becomes snake_case', row.food_id, 'f1');
  eq('user id is stamped on the row', row.user_id, 'user-1');
  eq('updated_at is carried', row.updated_at, T1);
  check('local-only dirty flag is never sent', !('dirty' in row));
  check('syncedAt is never sent', !('synced_at' in row));

  row.synced_at = '2026-09-01T12:00:01.000Z';
  var back = Sync.fromRow('entries', row);
  eq('round trip keeps foodId', back.foodId, 'f1');
  eq('round trip keeps qty', back.qty, 2);
  eq('round trip keeps updatedAt', back.updatedAt, T1);
  eq('syncedAt is read back', back.syncedAt, '2026-09-01T12:00:01.000Z');
  check('a day with null habits is repaired', (function () {
    var d = Sync.fromRow('days', { id: '2026-09-01', habits: null, updated_at: T1 });
    return d.habits && typeof d.habits === 'object';
  })());

  var srow = Sync.settingsToRow({ goalWeight: 190, alpha: 0.15, updatedAt: T1, dirty: true }, 'user-1');
  eq('settings payload is nested under data', srow.data.goalWeight, 190);
  check('settings payload drops local flags', !('dirty' in srow.data) && !('updatedAt' in srow.data));
  eq('settings round trip', Sync.settingsFromRow({ data: { goalWeight: 190 }, updated_at: T1 }).goalWeight, 190);

  /* ---------- cursor ---------- */
  eq('maxSyncedAt takes the highest', Sync.maxSyncedAt(
    [{ synced_at: 'b' }, { synced_at: 'd' }, { synced_at: 'c' }], 'a'), 'd');
  eq('maxSyncedAt never moves backwards', Sync.maxSyncedAt([{ synced_at: 'a' }], 'z'), 'z');
  eq('maxSyncedAt on an empty page', Sync.maxSyncedAt([], null), null);

  /* ---------- two devices, one account ----------
     The scenario that actually loses data in a naive implementation:
     both devices log food on the same day while offline. */

  function FakeServer() {
    this.rows = {};      // table -> id -> row
    this.clock = 0;
  }
  FakeServer.prototype.push = function (table, rows) {
    var self = this, out = [];
    if (!this.rows[table]) this.rows[table] = {};
    rows.forEach(function (r) {
      var copy = Object.assign({}, r);
      copy.synced_at = 'S' + String(++self.clock).padStart(6, '0');
      self.rows[table][r.id] = copy;   // upsert
      out.push(copy);
    });
    return out;
  };
  FakeServer.prototype.pull = function (table, cursor) {
    var all = Object.keys(this.rows[table] || {}).map(function (k) { return this.rows[table][k]; }, this);
    return all.filter(function (r) { return !cursor || r.synced_at > cursor; })
      .sort(function (x, y) { return x.synced_at < y.synced_at ? -1 : 1; });
  };

  function Device(name, server) {
    this.name = name; this.server = server;
    this.entries = {}; this.cursor = null;
  }
  Device.prototype.log = function (id, date, name, kcal, at) {
    this.entries[id] = {
      id: id, date: date, foodId: null, name: name, qty: 1, kcal: kcal,
      protein: null, carbs: null, fat: null,
      updatedAt: at, deletedAt: null, dirty: true
    };
  };
  Device.prototype.remove = function (id, at) {
    this.entries[id].deletedAt = at;
    this.entries[id].updatedAt = at;
    this.entries[id].dirty = true;
  };
  /* Mirrors run(): push everything dirty, then pull and merge. */
  Device.prototype.sync = function () {
    var dirty = Sync.collectDirty(this.entries);
    var stamps = {};
    dirty.forEach(function (r) { stamps[r.id] = r.updatedAt; });
    var returned = this.server.push('entries', dirty.map(function (r) {
      return Sync.toRow('entries', r, 'user-1');
    }));
    returned.forEach(function (row) {
      var rec = this.entries[row.id];
      if (rec && rec.updatedAt === stamps[row.id]) rec.dirty = false;
    }, this);

    var page = this.server.pull('entries', this.cursor);
    Sync.mergeCollection(this.entries, page.map(function (r) { return Sync.fromRow('entries', r); }));
    this.cursor = Sync.maxSyncedAt(page, this.cursor);
  };

  var server = new FakeServer();
  var phone = new Device('phone', server);
  var laptop = new Device('laptop', server);

  /* Both offline, same day, different meals. */
  phone.log('e_break', '2026-09-01', 'Eggs', 143, T1);
  laptop.log('e_lunch', '2026-09-01', 'Chicken', 281, T1);

  phone.sync();
  laptop.sync();
  phone.sync();

  var phoneDay = Object.keys(phone.entries).filter(function (k) { return !phone.entries[k].deletedAt; });
  var laptopDay = Object.keys(laptop.entries).filter(function (k) { return !laptop.entries[k].deletedAt; });
  eq('phone has both meals', phoneDay.length, 2);
  eq('laptop has both meals', laptopDay.length, 2);
  check('neither meal was lost', phone.entries.e_break && phone.entries.e_lunch &&
    laptop.entries.e_break && laptop.entries.e_lunch);

  /* Same record edited on both devices — later edit must win everywhere. */
  phone.entries.e_break.name = 'Eggs (3)';
  phone.entries.e_break.kcal = 215;
  phone.entries.e_break.updatedAt = T2;
  phone.entries.e_break.dirty = true;

  laptop.entries.e_break.name = 'Eggs (4)';
  laptop.entries.e_break.kcal = 286;
  laptop.entries.e_break.updatedAt = T3;   // later
  laptop.entries.e_break.dirty = true;

  phone.sync(); laptop.sync(); phone.sync(); laptop.sync();
  eq('later edit wins on the phone', phone.entries.e_break.name, 'Eggs (4)');
  eq('later edit wins on the laptop', laptop.entries.e_break.name, 'Eggs (4)');
  eq('the two devices agree', phone.entries.e_break.kcal, laptop.entries.e_break.kcal);

  /* A deletion must propagate, not resurrect. */
  laptop.remove('e_lunch', '2026-09-02T09:00:00.000Z');
  laptop.sync(); phone.sync();
  check('deletion reaches the other device', !!phone.entries.e_lunch.deletedAt);
  phone.sync(); laptop.sync();
  check('deleted record stays deleted', !!phone.entries.e_lunch.deletedAt && !!laptop.entries.e_lunch.deletedAt);

  /* Converged and quiet: nothing left to push on either side. */
  eq('phone has nothing pending', Sync.collectDirty(phone.entries).length, 0);
  eq('laptop has nothing pending', Sync.collectDirty(laptop.entries).length, 0);

  /* A third device joining later must receive the full history. */
  var tablet = new Device('tablet', server);
  tablet.sync();
  eq('a new device pulls the whole history', Object.keys(tablet.entries).length, 2);
  eq('and sees the winning edit', tablet.entries.e_break.name, 'Eggs (4)');
  check('and sees the deletion', !!tablet.entries.e_lunch.deletedAt);

  /* ---------- v1 -> v2 migration ---------- */
  var v1 = {
    version: 1,
    settings: { goalWeight: 190, alpha: 0.15 },
    foods: [{ id: 'f1', name: 'Eggs', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 }],
    habits: [{ id: 'h_steps', name: '8,000 steps' }],
    entries: {
      '2026-09-01': {
        weight: 205.2, note: 'travel',
        food: [{ foodId: 'f1', name: 'Eggs', qty: 2, kcal: 143 },
               { name: 'Quick add', qty: 1, kcal: 300 }],
        habits: { h_steps: true }
      }
    }
  };
  var v2 = Store.migrateV1(v1);
  eq('migration keeps the weight', v2.days['2026-09-01'].weight, 205.2);
  eq('migration keeps the note', v2.days['2026-09-01'].note, 'travel');
  check('migration keeps habit ticks', v2.days['2026-09-01'].habits.h_steps === true);
  eq('food lines become their own records', Object.keys(v2.entries).length, 2);
  eq('lines keep their date', v2.entries[Object.keys(v2.entries)[0]].date, '2026-09-01');
  eq('food library carries over', Object.keys(v2.foods).length, 1);
  eq('habit definitions carry over', v2.habits.h_steps.name, '8,000 steps');
  eq('settings carry over', v2.settings.goalWeight, 190);
  check('everything migrated is marked for upload',
    Object.keys(v2.entries).every(function (k) { return v2.entries[k].dirty; }) &&
    v2.days['2026-09-01'].dirty && v2.settings.dirty);
  check('migrated records all carry a timestamp',
    Object.keys(v2.entries).every(function (k) { return !!v2.entries[k].updatedAt; }));
  check('garbage in does not throw', (function () {
    try { Store.migrateV1(null); Store.migrateV1({ entries: { x: null } }); return true; }
    catch (e) { return false; }
  })());

  var summary = { passes: passes, failures: failures.length, detail: failures };
  root.__syncResults = summary;
  if (typeof document !== 'undefined') {
    var el = document.getElementById('out');
    if (el) { el.textContent = JSON.stringify(summary, null, 2); el.className = failures.length ? 'fail' : 'pass'; }
  } else {
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 1;
  }
})(typeof window !== 'undefined' ? window : globalThis);
