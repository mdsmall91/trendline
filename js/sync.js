'use strict';

/* =============================================================
   TRENDLINE — SYNC

   Local-first, last-write-wins per record.

   Two clocks, deliberately:

     updatedAt  set by the device that made the edit. Decides who wins
                a conflict, so the newer EDIT wins rather than whoever
                happened to reconnect last.
     syncedAt   set by the server. Used only as the pull cursor, so a
                device with a wrong clock cannot make itself invisible
                by writing a timestamp in the past.

   Deletions are soft (deletedAt) because a hard delete on one device
   is indistinguishable from a record the other device has not seen
   yet, and the record would simply come back.

   The network half is plain fetch against Supabase's REST and auth
   endpoints. No SDK: it would be one more thing to cache for offline
   use, and this is about 200 lines.
   ============================================================= */

var Sync = (function () {

  var AUTH_KEY = 'tl.auth';

  /* Column mapping per table. Local records are camelCase, Postgres is
     snake_case, and the list is explicit so an added local field cannot
     accidentally start being written to the server. */
  var TABLES = {
    foods:    { fields: ['id', 'name', 'serving', 'kcal', 'protein', 'carbs', 'fat', 'kind', 'servings', 'tags'] },
    habits:   { fields: ['id', 'name', 'sort'] },
    days:     { fields: ['id', 'weight', 'note', 'habits'] },
    entries:  { fields: ['id', 'date', 'foodId', 'name', 'qty', 'kcal', 'protein', 'carbs', 'fat'] },
    workouts: { fields: ['id', 'date', 'kind', 'activity', 'name', 'minutes', 'steps', 'kcal', 'sets', 'createdAt', 'templateId', 'finishedAt'] }
  };
  var TABLE_NAMES = ['foods', 'habits', 'days', 'entries', 'workouts'];

  function snake(s) { return s.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }); }
  function camel(s) { return s.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  /* ---------------------------------------------------------------
     PURE MERGE LOGIC  (no network, no storage — unit tested)
     --------------------------------------------------------------- */

  /* Later edit wins. A tie goes to the remote so that every device
     converges on the same value instead of each keeping its own and
     re-pushing it forever. */
  function pickWinner(local, remote) {
    if (!local) return remote;
    if (!remote) return local;
    var l = local.updatedAt || '', r = remote.updatedAt || '';
    return r >= l ? remote : local;
  }

  /* Fold a page of remote rows into a local map.

     A local record that is dirty AND newer than the remote keeps its
     dirty flag, so it still gets pushed on the next round. A local
     record the remote beat is overwritten and its dirty flag cleared,
     because the edit it represented has lost. */
  function mergeCollection(localMap, remoteRecords) {
    var applied = 0, kept = 0;
    remoteRecords.forEach(function (remote) {
      if (!remote || !remote.id) return;
      var local = localMap[remote.id];
      var winner = pickWinner(local, remote);
      if (winner === remote) {
        localMap[remote.id] = Object.assign({}, remote, { dirty: false });
        applied++;
      } else {
        kept++;
      }
    });
    return { applied: applied, kept: kept };
  }

  function collectDirty(map) {
    var out = [];
    Object.keys(map).forEach(function (k) {
      if (map[k] && map[k].dirty) out.push(map[k]);
    });
    return out;
  }

  /* Local record -> wire row. */
  function toRow(table, rec, userId) {
    var row = { user_id: userId };
    TABLES[table].fields.forEach(function (f) {
      var v = rec[f];
      row[snake(f)] = (v === undefined) ? null : v;
    });
    row.updated_at = rec.updatedAt;
    row.deleted_at = rec.deletedAt || null;
    return row;
  }

  /* Wire row -> local record. syncedAt is carried so the cursor can be
     advanced, but it is never used for conflict resolution. */
  function fromRow(table, row) {
    var rec = { deletedAt: row.deleted_at || null, updatedAt: row.updated_at, syncedAt: row.synced_at };
    TABLES[table].fields.forEach(function (f) { rec[f] = row[snake(f)]; });
    if (table === 'days' && (!rec.habits || typeof rec.habits !== 'object')) rec.habits = {};
    if (table === 'foods') {
      /* A row written by a device that predates tags comes back with
         nulls in those columns. Repaired here so the UI never has to
         ask whether a food is old. */
      if (!Array.isArray(rec.tags)) rec.tags = [];
      if (!rec.kind) rec.kind = 'food';
      if (typeof rec.servings !== 'number') rec.servings = null;
    }
    return rec;
  }

  function settingsToRow(s, userId) {
    var data = {};
    Object.keys(s).forEach(function (k) {
      if (k !== 'updatedAt' && k !== 'dirty') data[k] = s[k];
    });
    return { user_id: userId, data: data, updated_at: s.updatedAt };
  }

  function settingsFromRow(row) {
    return Object.assign({}, row.data || {}, {
      updatedAt: row.updated_at, syncedAt: row.synced_at, dirty: false
    });
  }

  /* Highest server timestamp in a page, for advancing the cursor. */
  function maxSyncedAt(rows, current) {
    var max = current || '';
    rows.forEach(function (r) {
      var v = r.synced_at || r.syncedAt || '';
      if (v > max) max = v;
    });
    return max || null;
  }

  /* ---------------------------------------------------------------
     AUTH
     --------------------------------------------------------------- */

  var CONFIG_KEY = 'tl.config';

  /* Config comes from config.js when it is filled in, and otherwise from
     whatever was entered in the app. The in-app path exists so the whole
     thing can be set up from a phone: editing a committed file is not a
     reasonable thing to ask of someone standing in their kitchen.

     Committed config wins, so once config.js is filled in it is the one
     source of truth and a stale value typed on one device cannot quietly
     override it. */
  function localCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return (c && c.SUPABASE_URL && c.SUPABASE_ANON_KEY) ? c : null;
    } catch (e) { return null; }
  }

  function cfg() {
    var committed = (typeof CONFIG !== 'undefined') ? CONFIG : null;
    if (committed && committed.SUPABASE_URL && committed.SUPABASE_ANON_KEY) return committed;
    return localCfg() || { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
  }

  function configured() {
    var c = cfg();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
  }

  function configSource() {
    var committed = (typeof CONFIG !== 'undefined') ? CONFIG : null;
    if (committed && committed.SUPABASE_URL && committed.SUPABASE_ANON_KEY) return 'file';
    return localCfg() ? 'device' : 'none';
  }

  /* Is this the secret key rather than the publishable one?

     Worth real effort to catch. The service role key bypasses Row Level
     Security entirely, and pasting it into a page that ships to a phone
     would hand every reader of the page full read/write on the database.
     It is an easy mistake — the two keys sit next to each other in the
     Supabase dashboard and look alike.

     A substring check does not work: in the classic JWT format the role
     is inside the base64 payload, so the literal text "service_role"
     never appears in the key itself. It has to be decoded. */
  function b64urlDecode(seg) {
    var s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof atob === 'function') return atob(s);
    return Buffer.from(s, 'base64').toString('binary');
  }

  function isSecretKey(key) {
    /* Newer Supabase key format is prefixed in the clear. */
    if (/^sb_secret_/i.test(key)) return true;
    if (/^sb_publishable_/i.test(key)) return false;

    var parts = key.split('.');
    if (parts.length === 3) {
      try {
        var claims = JSON.parse(b64urlDecode(parts[1]));
        if (claims && claims.role) return claims.role === 'service_role';
      } catch (e) { /* not a JWT we can read — fall through */ }
    }
    /* Last resort for a plain string that simply says what it is. */
    return /service_role/i.test(key);
  }

  /* Rejects the two mistakes that otherwise surface as a confusing 401
     twenty minutes later, or as a silent security hole. */
  function setConfig(url, key) {
    url = String(url || '').trim().replace(/\/+$/, '');
    key = String(key || '').trim().replace(/\s+/g, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
      throw new Error('That should look like https://abcdefgh.supabase.co');
    }
    if (!key) throw new Error('Paste the anon / public key.');
    if (isSecretKey(key)) {
      throw new Error('That is the secret / service role key — it bypasses row security and must never go in the app. Use the anon (publishable) key.');
    }
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: key })); }
    catch (e) { throw new Error('Could not save the settings on this device.'); }
  }

  function clearConfig() {
    try { localStorage.removeItem(CONFIG_KEY); } catch (e) {}
  }

  function readAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeAuth(a) {
    try {
      if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) {}
  }

  function signedIn() { var a = readAuth(); return !!(a && a.refresh_token); }
  function account() { var a = readAuth(); return a ? { id: a.user_id, email: a.email } : null; }

  function authFetch(path, body) {
    var c = cfg();
    return fetch(c.SUPABASE_URL + '/auth/v1/' + path, {
      method: 'POST',
      headers: { 'apikey': c.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.msg || j.error_description || j.message || ('auth ' + r.status));
        return j;
      });
    });
  }

  /* Two ways in, and password is the default.

     Password needs no email at all: no template to configure, no mail
     server to rate-limit you, no link that has to come back to the exact
     browser that asked for it. On iOS that last one matters — a
     home-screen app has its own storage, separate from Safari, so a link
     opened in Safari authenticates the wrong thing.

     The one-time code path is kept for anyone who would rather not have
     a password, but it depends on the Supabase email template carrying
     {{ .Token }}, and the stock template does not. */

  function signUp(email, password) {
    return authFetch('signup', { email: email, password: password })
      .then(function (j) {
        if (!j.access_token) {
          /* Supabase withholds the session when email confirmation is on. */
          throw new Error('Account created, but the project requires email confirmation. ' +
            'Either confirm from the email, or turn off Authentication → Providers → Email → Confirm email, then sign in.');
        }
        storeSession(j, email);
        return account();
      });
  }

  function signInPassword(email, password) {
    return authFetch('token?grant_type=password', { email: email, password: password })
      .then(function (j) {
        if (!j.access_token) throw new Error('No session came back. Check the email and password.');
        storeSession(j, email);
        return account();
      });
  }

  function requestCode(email) {
    return authFetch('otp', { email: email, create_user: true });
  }

  function verifyCode(email, code) {
    return authFetch('verify', { email: email, token: code, type: 'email' })
      .then(function (j) {
        storeSession(j, email);
        return account();
      });
  }

  /* The last email that successfully signed in here, kept separately
     from the session and outliving it.

     iOS is the reason. A home-screen app has its own storage, entirely
     separate from Safari, so signing in on the website leaves the
     installed app signed out — and an empty form gives no hint that
     this is what happened. Remembering the address lets the app say
     which account it is asking about instead of just asking again. */
  var LAST_EMAIL_KEY = 'tl.lastEmail';

  function rememberAccount(email) {
    try {
      if (email) localStorage.setItem(LAST_EMAIL_KEY, String(email));
    } catch (e) {}
  }

  function lastAccount() {
    var a = readAuth();
    if (a && a.email) return a.email;
    try { return localStorage.getItem(LAST_EMAIL_KEY) || ''; } catch (e) { return ''; }
  }

  function storeSession(j, email) {
    var resolved = (j.user && j.user.email) || email || (readAuth() || {}).email;
    writeAuth({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + ((j.expires_in || 3600) * 1000),
      user_id: (j.user && j.user.id) || (readAuth() || {}).user_id,
      email: resolved
    });
    rememberAccount(resolved);
  }

  function signOut() {
    writeAuth(null);
    var s = Store.load();
    s.sync.userId = null; s.sync.email = null; s.sync.cursors = {}; s.sync.lastSyncAt = null;
    Store.flush();
  }

  /* Is this refusal actually about the token, or about the weather?

     Signing someone out is destructive — it costs them a password
     entry and, on a phone, usually a trip to a password manager. It
     must only happen when the refresh token is genuinely dead.

     Everything else the endpoint can return is temporary: 429 when the
     built-in mailer rate limit has been tripped, 5xx when Supabase is
     having a moment, and 503 when a free project has paused after a
     week of no activity — which is the normal state of a personal app
     you did not open on holiday. Treating those as "session expired"
     is how you get logged out of an app you never logged out of. */
  function isDeadRefreshToken(status, body) {
    if (status !== 400 && status !== 401) return false;
    var j = body || {};
    var text = String(j.error || j.error_code || j.msg || j.message || '').toLowerCase();
    return /invalid[_ ]grant|refresh[_ ]token|already used|not found/.test(text);
  }

  /* Refresh a minute early so a long request cannot start on a token
     that expires mid-flight. */
  function accessToken() {
    var a = readAuth();
    if (!a) return Promise.reject(new Error('not signed in'));
    if (a.access_token && a.expires_at - 60000 > Date.now()) return Promise.resolve(a.access_token);
    var c = cfg();
    return fetch(c.SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': c.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: a.refresh_token })
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok) {
          if (isDeadRefreshToken(r.status, j)) {
            writeAuth(null);
            throw new Error('Session expired — sign in again.');
          }
          /* Keep the session and say what actually happened. The next
             sync retries; nothing has been lost. */
          throw new Error('Could not reach the account service (' + r.status + '). Still signed in — it will retry.');
        }
        storeSession(j, a.email);
        return j.access_token;
      });
    });
  }

  /* ---------------------------------------------------------------
     REST
     --------------------------------------------------------------- */

  function rest(token, path, opts) {
    var c = cfg();
    opts = opts || {};
    return fetch(c.SUPABASE_URL + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({
        'apikey': c.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.text().then(function (t) {
        var j = t ? JSON.parse(t) : null;
        if (!r.ok) throw new Error((j && (j.message || j.hint)) || ('http ' + r.status));
        return j;
      });
    });
  }

  var PAGE = 500;

  function pullTable(token, table, cursor) {
    var q = 'select=*&order=synced_at.asc&limit=' + PAGE;
    if (cursor) q += '&synced_at=gt.' + encodeURIComponent(cursor);
    return rest(token, table + '?' + q);
  }

  /* on_conflict is named explicitly. PostgREST can infer it from the
     primary key, but being explicit means a future index change cannot
     silently turn an upsert into a duplicate-key error. */
  function conflictTarget(table) {
    return table === 'settings' ? 'user_id' : 'user_id,id';
  }

  function pushRows(token, table, rows) {
    if (!rows.length) return Promise.resolve([]);
    return rest(token, table + '?on_conflict=' + conflictTarget(table), {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: rows
    });
  }

  /* ---------------------------------------------------------------
     THE RUN
     --------------------------------------------------------------- */

  var running = false;

  function run() {
    if (running) return Promise.resolve({ skipped: 'already running' });
    if (!configured()) return Promise.resolve({ skipped: 'not configured' });
    if (!signedIn()) return Promise.resolve({ skipped: 'not signed in' });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.resolve({ skipped: 'offline' });
    }

    running = true;
    var s = Store.load();
    var report = { pushed: 0, pulled: 0 };
    var token;

    return accessToken().then(function (t) {
      token = t;
      var a = readAuth();
      s.sync.userId = a.user_id;
      s.sync.email = a.email;

      /* Push first. Anything this device changed while offline should be
         visible to the merge that follows, not overwritten by it. */
      var chain = Promise.resolve();

      TABLE_NAMES.forEach(function (table) {
        chain = chain.then(function () {
          var dirty = collectDirty(s[table]);
          if (!dirty.length) return;
          var stamps = {};
          dirty.forEach(function (r) { stamps[r.id] = r.updatedAt; });
          var rows = dirty.map(function (r) { return toRow(table, r, a.user_id); });
          return pushRows(token, table, rows).then(function (returned) {
            (returned || []).forEach(function (row) {
              var rec = s[table][row.id];
              if (!rec) return;
              rec.syncedAt = row.synced_at;
              /* Only clear the flag if the record has not been edited
                 again since this push was assembled. */
              if (rec.updatedAt === stamps[row.id]) rec.dirty = false;
            });
            report.pushed += rows.length;
          });
        });
      });

      chain = chain.then(function () {
        if (!s.settings.dirty) return;
        var stamp = s.settings.updatedAt;
        return pushRows(token, 'settings', [settingsToRow(s.settings, a.user_id)])
          .then(function (returned) {
            var row = (returned || [])[0];
            if (row) s.settings.syncedAt = row.synced_at;
            if (s.settings.updatedAt === stamp) s.settings.dirty = false;
            report.pushed++;
          });
      });

      /* Then pull, paging until a short page comes back. */
      TABLE_NAMES.forEach(function (table) {
        chain = chain.then(function () {
          function page() {
            return pullTable(token, table, s.sync.cursors[table]).then(function (rows) {
              rows = rows || [];
              if (!rows.length) return;
              var recs = rows.map(function (r) { return fromRow(table, r); });
              var res = mergeCollection(s[table], recs);
              report.pulled += res.applied;
              s.sync.cursors[table] = maxSyncedAt(rows, s.sync.cursors[table]);
              if (rows.length === PAGE) return page();
            });
          }
          return page();
        });
      });

      chain = chain.then(function () {
        return pullTable(token, 'settings', s.sync.cursors.settings).then(function (rows) {
          rows = rows || [];
          if (!rows.length) return;
          var remote = settingsFromRow(rows[0]);
          var winner = pickWinner(s.settings, remote);
          if (winner === remote) {
            s.settings = Object.assign({}, s.settings, remote, { dirty: false });
            report.pulled++;
          }
          s.sync.cursors.settings = maxSyncedAt(rows, s.sync.cursors.settings);
        });
      });

      return chain;
    }).then(function () {
      s.sync.lastSyncAt = Store.now();
      s.sync.lastError = null;
      Store.flush();
      running = false;
      return report;
    }).catch(function (err) {
      s.sync.lastError = String(err.message || err);
      Store.flush();
      running = false;
      throw err;
    });
  }

  function pendingCount() {
    var s = Store.load(), n = 0;
    TABLE_NAMES.forEach(function (t) { n += collectDirty(s[t]).length; });
    if (s.settings.dirty) n++;
    return n;
  }

  return {
    /* pure */
    pickWinner: pickWinner, mergeCollection: mergeCollection, collectDirty: collectDirty,
    toRow: toRow, fromRow: fromRow, settingsToRow: settingsToRow, settingsFromRow: settingsFromRow,
    maxSyncedAt: maxSyncedAt, snake: snake, camel: camel, TABLE_NAMES: TABLE_NAMES,
    isSecretKey: isSecretKey, isDeadRefreshToken: isDeadRefreshToken,
    lastAccount: lastAccount,
    /* stateful */
    configured: configured, configSource: configSource,
    setConfig: setConfig, clearConfig: clearConfig,
    signedIn: signedIn, account: account,
    signUp: signUp, signInPassword: signInPassword,
    requestCode: requestCode, verifyCode: verifyCode, signOut: signOut,
    run: run, pendingCount: pendingCount
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
