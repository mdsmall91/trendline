'use strict';

/* =============================================================
   TRENDLINE — UI
   Render-on-change. Every input writes to the store and calls
   render(); no virtual DOM and no framework, because the whole
   surface is five panels.
   ============================================================= */

(function () {

  var $ = function (id) { return document.getElementById(id); };
  var day = WL.todayKey();
  var range = 30;
  var foodFilterText = '';
  var authStage = 'idle';       /* idle | code | busy */
  var authEmail = '';
  var authMessage = '';
  var syncing = false;

  function fmt(n, dp) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toFixed(dp === undefined ? 0 : dp);
  }
  function signed(n, dp) {
    if (n === null || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(dp === undefined ? 1 : dp);
  }
  function esc(s) { return Chart.esc(s); }

  function longDate(key) {
    var d = WL.fromKey(key), t = WL.todayKey();
    if (key === t) return 'Today';
    if (key === WL.addDays(t, -1)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function ago(iso) {
    if (!iso) return 'never';
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  /* ---------------------------------------------------------------
     DERIVED STATE — the single place the engine is called.
     --------------------------------------------------------------- */
  function derive() {
    var st = Store.settings();
    var pts = Store.weightPoints();
    var series = WL.trendSeries(pts, st.alpha);
    var hasWeight = pts.length > 0;

    var currentTrend = series.length ? series[series.length - 1].trend : null;
    var lastRaw = pts.length ? pts[pts.length - 1].weight : null;
    var basisLb = currentTrend !== null ? currentTrend : (lastRaw || 0);

    var profile = {
      weightLb: basisLb, heightIn: st.heightIn, age: st.age,
      sex: st.sex, activity: st.activity
    };

    var intake = Store.intakeMap();
    var tdee = WL.estimateTDEE({ trend: series, intake: intake, profile: profile });
    var target = WL.dailyTarget({
      tdee: tdee.tdee, goalRateLbPerWk: st.goalRateLbPerWk,
      profile: profile, floorKcal: st.floorKcal
    });
    var macros = WL.macroTargets({
      targetKcal: target.target, weightLb: basisLb,
      proteinPerLb: st.proteinPerLb, fatPerLb: st.fatPerLb
    });
    var rate = WL.trendRate(series, 21);
    var projection = (hasWeight && typeof st.goalWeight === 'number' && rate !== null)
      ? WL.projectGoal(currentTrend, st.goalWeight, rate, series[series.length - 1].date)
      : null;

    return {
      st: st, pts: pts, series: series, hasWeight: hasWeight,
      currentTrend: currentTrend, lastRaw: lastRaw, basisLb: basisLb,
      intake: intake, tdee: tdee, target: target, macros: macros,
      rate: rate, projection: projection,
      engine: Store.engineEntries()
    };
  }

  /* ---------------------------------------------------------------
     TODAY
     --------------------------------------------------------------- */

  function renderToday(D) {
    $('dayLabel').textContent = longDate(day);
    $('nextDay').disabled = day >= WL.todayKey();

    var d = Store.peekDay(day);
    var lines = Store.entriesFor(day);
    var eaten = WL.entryTotals({ food: lines });
    var tgt = D.hasWeight ? D.target.target : null;
    var left = tgt === null ? null : tgt - eaten.kcal;

    $('eaten').textContent = fmt(eaten.kcal);
    $('target').textContent = tgt === null ? '—' : fmt(tgt);
    $('remaining').textContent = left === null ? '—' : fmt(Math.abs(left));
    $('remainingLabel').textContent = left === null ? 'log a weight to set a target'
      : (left < 0 ? 'calories over' : 'calories left');
    $('budgetCard').classList.toggle('over', left !== null && left < 0);

    var pct = (tgt && tgt > 0) ? Math.min(100, (eaten.kcal / tgt) * 100) : 0;
    $('budgetBar').classList.toggle('over', left !== null && left < 0);
    $('budgetBar').firstElementChild.style.width = pct + '%';
    $('targetBasis').textContent = basisText(D);

    var m = D.macros, mm = [
      { k: 'Protein', got: eaten.protein, want: m.protein },
      { k: 'Carbs',   got: eaten.carbs,   want: m.carbs },
      { k: 'Fat',     got: eaten.fat,     want: m.fat }
    ];
    $('macros').innerHTML = mm.map(function (x) {
      var p = x.want > 0 ? Math.min(100, (x.got / x.want) * 100) : 0;
      return '<div class="macro"><div class="label"><span>' + x.k + '</span></div>' +
        '<div class="val">' + fmt(x.got) + ' / ' + (D.hasWeight ? fmt(x.want) : '—') + ' g</div>' +
        '<div class="bar"><i style="width:' + p + '%"></i></div></div>';
    }).join('');

    if (document.activeElement !== $('weightInput')) {
      $('weightInput').value = (d && typeof d.weight === 'number') ? d.weight : '';
    }
    var tr = D.series.length ? WL.trendAt(D.series, day) : null;
    $('weightHint').textContent = tr === null
      ? 'Weigh in first thing, after the bathroom, before food. Same conditions every day is what makes the trend mean anything.'
      : 'Trend on this day: ' + fmt(tr, 1) + ' lb';

    var log = $('foodLog');
    if (!lines.length) {
      log.innerHTML = '<li><span class="empty" style="flex:1">Nothing logged yet.</span></li>';
    } else {
      log.innerHTML = lines.map(function (line) {
        var t = WL.lineTotals(line);
        var sub = [];
        if (line.qty && line.qty !== 1) sub.push('x' + line.qty);
        if (t.protein || t.carbs || t.fat) {
          sub.push(fmt(t.protein) + 'p ' + fmt(t.carbs) + 'c ' + fmt(t.fat) + 'f');
        }
        return '<li><span class="name"><b>' + esc(line.name || 'Quick add') + '</b>' +
          (sub.length ? '<small>' + esc(sub.join('  ·  ')) + '</small>' : '') + '</span>' +
          '<span class="kcal">' + fmt(t.kcal) + '</span>' +
          '<button class="btn ghost" data-rm="' + esc(line.id) + '" aria-label="Remove">&times;</button></li>';
      }).join('');
    }

    $('foodList').innerHTML = Store.foods().map(function (f) {
      return '<option value="' + esc(f.name) + '"></option>';
    }).join('');

    $('habitToday').innerHTML = Store.habits().map(function (h) {
      var on = !!(d && d.habits && d.habits[h.id]);
      var streak = WL.habitStreak(D.engine, h.id, day);
      return '<label class="habit"><input type="checkbox" data-habit="' + esc(h.id) + '"' +
        (on ? ' checked' : '') + '><span class="name">' + esc(h.name) + '</span>' +
        '<span class="streak' + (streak >= 3 ? ' hot' : '') + '">' +
        (streak ? streak + 'd' : '') + '</span></label>';
    }).join('') || '<p class="empty">No habits yet. Add some on the Habits tab.</p>';

    if (document.activeElement !== $('dayNote')) $('dayNote').value = (d && d.note) || '';
  }

  /* Says out loud where the target came from. A number you cannot
     explain is a number you stop trusting in week three. */
  function basisText(D) {
    if (!D.hasWeight) return 'Add a weigh-in to start the adaptive loop.';
    var t = D.tdee, s;
    if (t.method === 'baseline') {
      s = 'Estimated from the formula (' + fmt(t.tdee) + ' cal/day). ' +
        'Log weight and food for two weeks and this switches to your real numbers.';
    } else {
      s = 'Your measured burn: ' + fmt(t.tdee) + ' cal/day (' + t.confidence + ' confidence).';
    }
    if (D.target.clamped) {
      s += ' Target held at the ' + D.target.floor + ' floor — that is ' +
        fmt(D.target.actualRate, 2) + ' lb/wk, not ' + fmt(D.target.requestedRate, 2) + '.';
    }
    return s;
  }

  /* ---------------------------------------------------------------
     TREND
     --------------------------------------------------------------- */

  function renderTrend(D) {
    var series = D.series;
    if (range < 9999 && series.length) {
      var from = WL.addDays(series[series.length - 1].date, -range);
      series = series.filter(function (p) { return p.date >= from; });
    }
    $('weightChart').innerHTML = Chart.weight(series, { goal: D.st.goalWeight });

    var first = D.series.length ? D.series[0] : null;
    var totalChange = (first && D.currentTrend !== null) ? D.currentTrend - first.trend : null;
    var wk = D.series.length ? WL.trendAt(D.series, WL.addDays(D.series[D.series.length - 1].date, -7)) : null;
    var weekChange = (wk !== null && D.currentTrend !== null) ? D.currentTrend - wk : null;

    /* Shown as a distance, not a signed difference: "-15.9" next to a
       goal reads as if you are already under it. */
    var toGoal = { v: '—', n: 'lb' };
    if (typeof D.st.goalWeight === 'number' && D.currentTrend !== null) {
      var diff = D.currentTrend - D.st.goalWeight;
      toGoal = Math.abs(diff) < 0.1
        ? { v: '0.0', n: 'you are there' }
        : { v: fmt(Math.abs(diff), 1), n: diff > 0 ? 'lb to go' : 'lb below goal' };
    }

    var stats = [
      { k: 'Trend weight', v: fmt(D.currentTrend, 1), n: D.lastRaw !== null ? 'last weigh-in ' + fmt(D.lastRaw, 1) : '' },
      { k: 'Rate', v: D.rate === null ? '—' : signed(D.rate, 2), n: 'lb / week, 21-day' },
      { k: '7-day change', v: signed(weekChange, 1), n: 'lb of trend' },
      { k: 'Since start', v: signed(totalChange, 1), n: first ? 'from ' + fmt(first.trend, 1) : '' },
      { k: 'Burn (TDEE)', v: fmt(D.tdee.tdee), n: D.tdee.method === 'adaptive' ? 'measured, ' + D.tdee.confidence : 'formula estimate' },
      { k: 'Target', v: D.hasWeight ? fmt(D.target.target) : '—', n: 'cal / day' },
      { k: 'To goal', v: toGoal.v, n: toGoal.n },
      { k: 'Arrives', v: D.projection ? longDate(D.projection.date) : '—',
        n: D.projection ? Math.round(D.projection.weeks) + ' weeks' : 'need a steady rate' }
    ];
    $('trendStats').innerHTML = stats.map(function (s) {
      return '<div class="stat"><div class="k">' + esc(s.k) + '</div><div class="v">' + esc(s.v) +
        '</div><div class="n">' + esc(s.n || '') + '</div></div>';
    }).join('');

    /* Caveats, shown only when they actually apply. */
    var notes = [];
    if (D.pts.length && D.pts.length < 10) {
      notes.push('Ten weigh-ins is roughly where the trend stops lying. You have ' + D.pts.length + '.');
    }
    if (D.tdee.method === 'baseline' && D.pts.length >= 10) {
      notes.push('Still on the formula because food logging is under 75% of days. The adaptive number needs the intake side to be honest.');
    }
    if (D.tdee.clamped) {
      notes.push('The measured burn came out physiologically implausible and has been clamped. Usually that means a mistyped weight or a week of under-logging.');
    }
    if (D.rate !== null && D.st.goalRateLbPerWk > 0 && D.rate > -0.05 && D.pts.length >= 14) {
      notes.push('The trend is flat or rising against a loss goal. Before cutting the target, check that the food log is complete — under-logging is the usual answer, not metabolism.');
    }
    if (D.currentTrend !== null && D.st.goalRateLbPerWk / (D.currentTrend / 100) > 1.05) {
      notes.push('That rate is over 1% of bodyweight per week. It works, but expect to give some of it back.');
    }
    $('trendNotes').innerHTML = notes.map(function (t) {
      return '<div class="note">' + esc(t) + '</div>';
    }).join('');

    var end = WL.todayKey(), days = [];
    for (var i = 20; i >= 0; i--) {
      var k = WL.addDays(end, -i);
      days.push({ date: k, kcal: D.intake[k] || 0 });
    }
    $('intakeChart').innerHTML = Chart.intake(days, { target: D.hasWeight ? D.target.target : 0 });

    var logged = days.filter(function (x) { return x.kcal > 0; });
    if (!logged.length) {
      $('intakeSummary').textContent = 'No food logged in the last three weeks.';
    } else {
      var mean = logged.reduce(function (a, x) { return a + x.kcal; }, 0) / logged.length;
      var over = D.hasWeight ? logged.filter(function (x) { return x.kcal > D.target.target; }).length : 0;
      $('intakeSummary').textContent = logged.length + ' of 21 days logged · average ' +
        fmt(mean) + ' cal' + (D.hasWeight ? ' · ' + over + ' over target' : '');
    }
  }

  /* ---------------------------------------------------------------
     FOODS / HABITS
     --------------------------------------------------------------- */

  function renderFoods() {
    var foods = Store.foods();
    $('foodCount').textContent = foods.length;
    var q = foodFilterText.toLowerCase();
    var shown = q ? foods.filter(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; }) : foods;

    $('foodLibrary').innerHTML = shown.length ? shown.map(function (f) {
      var t = WL.lineTotals({ kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, qty: 1 });
      var sub = [];
      if (f.serving) sub.push(f.serving);
      sub.push(fmt(t.protein) + 'p ' + fmt(t.carbs) + 'c ' + fmt(t.fat) + 'f');
      return '<li><span class="name"><b>' + esc(f.name) + '</b><small>' + esc(sub.join('  ·  ')) +
        '</small></span><span class="kcal">' + fmt(t.kcal) + '</span>' +
        '<button class="btn ghost" data-food-rm="' + esc(f.id) + '" aria-label="Delete">&times;</button></li>';
    }).join('') : '<li><span class="empty" style="flex:1">' +
      (q ? 'Nothing matches.' : 'Your library is empty. Add the ten things you eat most and you are basically done.') +
      '</span></li>';
  }

  function renderHabits(D) {
    var today = WL.todayKey();
    var hs = Store.habits();
    $('habitBoard').innerHTML = hs.length ? hs.map(function (h) {
      var cells = '';
      for (var i = 29; i >= 0; i--) {
        var k = WL.addDays(today, -i);
        var e = D.engine[k];
        var on = !!(e && e.habits && e.habits[h.id]);
        cells += '<i class="' + (on ? 'on' : '') + '" title="' + esc(k) + '"></i>';
      }
      var streak = WL.habitStreak(D.engine, h.id, today);
      var rate = WL.habitRate(D.engine, h.id, 30, today);
      return '<div style="margin-bottom:var(--s-5)">' +
        '<div class="habit" style="border:0;padding:0 0 var(--s-1)">' +
        '<span class="name">' + esc(h.name) + '</span>' +
        '<span class="streak' + (streak >= 3 ? ' hot' : '') + '">' + streak + 'd · ' +
        Math.round(rate * 100) + '%</span>' +
        '<button class="btn ghost" data-habit-rm="' + esc(h.id) + '" aria-label="Delete">&times;</button>' +
        '</div><div class="grid30">' + cells + '</div></div>';
    }).join('') : '<p class="empty">No habits yet.</p>';
  }

  /* ---------------------------------------------------------------
     ACCOUNT / SYNC
     --------------------------------------------------------------- */

  function renderAccount() {
    var body = $('accountBody');

    if (!Sync.configured()) {
      body.innerHTML =
        '<p class="hint" style="margin:0 0 var(--s-3)">Sync is off. Everything works and stays on this device.</p>' +
        '<div class="note plain">Create a free Supabase project, run <code>supabase/schema.sql</code> ' +
        'in its SQL editor, then paste the two values from <b>Project Settings &rarr; API</b> below. ' +
        'No credit card. Full steps are in the README.</div>' +
        '<label class="field" style="margin-top:var(--s-4)"><span>Project URL</span>' +
        '<input type="text" id="cfgUrl" inputmode="url" autocapitalize="off" autocorrect="off" ' +
        'spellcheck="false" placeholder="https://abcdefgh.supabase.co"></label>' +
        '<label class="field"><span>Anon / public key</span>' +
        '<textarea id="cfgKey" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
        'placeholder="eyJhbGciOi…"></textarea></label>' +
        '<button class="btn primary" id="cfgSave">Turn on sync</button>' +
        (authMessage ? '<div class="note">' + esc(authMessage) + '</div>' : '');
      return;
    }

    if (!Sync.signedIn()) {
      if (authStage === 'code') {
        body.innerHTML =
          '<p class="hint" style="margin:0 0 var(--s-3)">Six-digit code sent to <b>' + esc(authEmail) + '</b>.</p>' +
          '<div class="row">' +
          '<label class="field" style="margin:0"><span class="sr">Code</span>' +
          '<input type="text" id="authCode" inputmode="numeric" autocomplete="one-time-code" ' +
          'maxlength="6" placeholder="123456"></label>' +
          '<button class="btn primary grow-0" id="authVerify">Verify</button></div>' +
          '<button class="btn ghost" id="authBack" style="margin-top:var(--s-2)">Use a different email</button>' +
          (authMessage ? '<div class="note">' + esc(authMessage) + '</div>' : '') +
          /* Supabase ships a Magic Link template by default, which sends a
             link rather than a code. Without this hint the first sign-in
             looks like a broken app instead of a one-line settings change. */
          '<p class="hint">Got a <b>link</b> in the email instead of a code? In Supabase go to ' +
          '<b>Authentication &rarr; Emails &rarr; Magic Link</b> and put <code>{{ .Token }}</code> ' +
          'in the template. See SETUP.md.</p>';
      } else {
        body.innerHTML =
          '<p class="hint" style="margin:0 0 var(--s-3)">Sign in to sync this log across your devices. ' +
          'No password — a one-time code by email.</p>' +
          '<div class="row">' +
          '<label class="field" style="margin:0"><span class="sr">Email</span>' +
          '<input type="email" id="authEmail" inputmode="email" autocomplete="email" ' +
          'placeholder="you@example.com" value="' + esc(authEmail) + '"></label>' +
          '<button class="btn primary grow-0" id="authSend"' + (authStage === 'busy' ? ' disabled' : '') + '>' +
          (authStage === 'busy' ? 'Sending…' : 'Send code') + '</button></div>' +
          (authMessage ? '<div class="note">' + esc(authMessage) + '</div>' : '');
      }
      return;
    }

    var s = Store.sync();
    var pending = Sync.pendingCount();
    body.innerHTML =
      '<div class="stats" style="grid-template-columns:repeat(2,1fr)">' +
      '<div class="stat"><div class="k">Account</div><div class="v" style="font-size:0.9375rem">' +
      esc((Sync.account() || {}).email || '') + '</div></div>' +
      '<div class="stat"><div class="k">Last sync</div><div class="v" style="font-size:0.9375rem">' +
      esc(ago(s.lastSyncAt)) + '</div><div class="n">' +
      (pending ? pending + ' waiting to upload' : 'everything uploaded') + '</div></div>' +
      '</div>' +
      (s.lastError ? '<div class="note">Last sync failed: ' + esc(s.lastError) + '</div>' : '') +
      '<div class="row" style="margin-top:var(--s-4);flex-wrap:wrap">' +
      '<button class="btn primary" id="syncNow"' + (syncing ? ' disabled' : '') + '>' +
      (syncing ? 'Syncing…' : 'Sync now') + '</button>' +
      '<button class="btn grow-0" id="signOut">Sign out</button></div>' +
      (Sync.configSource() === 'device'
        ? '<p class="hint">Project details were entered on this device. Put them in ' +
          '<code>config.js</code> and they apply everywhere automatically. ' +
          '<button class="btn ghost" id="cfgClear" style="padding:0 4px">Forget them</button></p>'
        : '');
  }

  function renderSyncPill() {
    var pill = $('syncPill');
    var cls = 'pill', text = '';
    if (!Sync.configured()) { cls += ' muted'; text = 'local'; }
    else if (!Sync.signedIn()) { cls += ' warn'; text = 'sign in'; }
    else if (syncing) { text = 'syncing'; }
    else if (typeof navigator !== 'undefined' && navigator.onLine === false) { cls += ' muted'; text = 'offline'; }
    else if (Store.sync().lastError) { cls += ' warn'; text = 'retry'; }
    else {
      var pending = Sync.pendingCount();
      if (pending) { cls += ' muted'; text = pending + ' ↑'; }
      else { cls += ' ok'; text = 'synced'; }
    }
    pill.className = cls;
    pill.textContent = text;
  }

  /* ---------------------------------------------------------------
     SETTINGS
     --------------------------------------------------------------- */

  function renderSettings() {
    var s = Store.settings();
    function setIf(id, v) { if (document.activeElement !== $(id)) $(id).value = v; }
    setIf('stAge', s.age);
    setIf('stHeight', s.heightIn);
    $('stSex').value = s.sex;
    $('stActivity').value = s.activity;
    setIf('stGoalWeight', (typeof s.goalWeight === 'number') ? s.goalWeight : '');
    setIf('stRate', s.goalRateLbPerWk);
    setIf('stProtein', s.proteinPerLb);
    setIf('stFat', s.fatPerLb);
    $('stAlpha').value = s.alpha;
    $('alphaVal').textContent = Number(s.alpha).toFixed(2);

    var bytes = 0;
    try { bytes = (localStorage.getItem(Store.KEY) || '').length; } catch (e) {}
    var dates = Store.loggedDates();
    $('storageHint').textContent = dates.length + ' days logged · ' +
      (bytes < 1024 ? bytes + ' bytes' : (bytes / 1024).toFixed(1) + ' KB') +
      (dates.length ? ' · since ' + dates[0] : '');

    $('storageNote').textContent = (Sync.configured() && Sync.signedIn())
      ? 'This device keeps a full local copy and works offline; the cloud copy is the backup. ' +
        'Clearing site data here is recoverable — sign in again and it comes back.'
      : 'Everything lives in this browser only. Nothing is uploaded and no one else can see it — ' +
        'which also means clearing site data erases it. Export occasionally, or turn on sync.';
  }

  /* ---------------------------------------------------------------
     RENDER
     --------------------------------------------------------------- */

  function render() {
    var D = derive();
    renderToday(D);
    renderTrend(D);
    renderFoods();
    renderHabits(D);
    renderAccount();
    renderSettings();
    renderSyncPill();
  }

  /* ---------------------------------------------------------------
     SYNC SCHEDULING
     --------------------------------------------------------------- */

  var syncTimer = null;

  function doSync(reason) {
    if (!Sync.configured() || !Sync.signedIn() || syncing) return Promise.resolve();
    syncing = true;
    renderSyncPill();
    return Sync.run().then(function (r) {
      syncing = false;
      /* Only a full re-render when something actually arrived. */
      if (r && (r.pulled || r.pushed)) render();
      else { renderSyncPill(); renderAccount(); }
    }).catch(function () {
      syncing = false;
      renderSyncPill();
      renderAccount();
    });
  }

  /* Debounced: a burst of edits while logging a meal is one upload. */
  function scheduleSync() {
    renderSyncPill();
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { doSync('edit'); }, 2500);
  }
  window.__tlChanged = scheduleSync;

  /* ---------------------------------------------------------------
     EVENTS
     --------------------------------------------------------------- */

  function num(el) {
    var v = parseFloat(el.value);
    return isFinite(v) ? v : null;
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) {
        x.setAttribute('aria-selected', String(x === b));
      });
      Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
        p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab);
      });
      window.scrollTo(0, 0);
    });
  });

  function goTab(name) {
    var b = document.querySelector('.tabs button[data-tab="' + name + '"]');
    if (b) b.click();
  }

  $('prevDay').addEventListener('click', function () { day = WL.addDays(day, -1); render(); });
  $('nextDay').addEventListener('click', function () {
    if (day < WL.todayKey()) { day = WL.addDays(day, 1); render(); }
  });
  $('dayLabel').addEventListener('click', function () { day = WL.todayKey(); render(); });

  $('syncPill').addEventListener('click', function () {
    if (!Sync.configured() || !Sync.signedIn()) { goTab('settings'); return; }
    doSync('manual');
  });

  /* weight */
  function saveWeight() {
    var v = num($('weightInput'));
    Store.setWeight(day, v);
    render();
  }
  $('saveWeight').addEventListener('click', saveWeight);
  $('weightInput').addEventListener('change', saveWeight);
  $('weightInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('weightInput').blur(); saveWeight(); }
  });

  /* food */
  function addFoodLine() {
    var name = $('foodPick').value.trim();
    if (!name) return;
    var qty = num($('foodQty'));
    if (qty === null || qty <= 0) qty = 1;
    var f = Store.findFoodByName(name);
    if (!f) {
      $('inlineName').textContent = name;
      $('inlineNew').hidden = false;
      $('inKcal').focus();
      return;
    }
    Store.addEntry(day, {
      foodId: f.id, name: f.name, qty: qty,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
    });
    $('foodPick').value = ''; $('foodQty').value = 1;
    $('inlineNew').hidden = true;
    render();
  }
  $('addFoodLine').addEventListener('click', addFoodLine);
  $('foodPick').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); addFoodLine(); }
  });

  $('inSave').addEventListener('click', function () {
    var f = Store.addFood({
      name: $('inlineName').textContent, serving: '',
      kcal: num($('inKcal')), protein: num($('inP')), carbs: num($('inC')), fat: num($('inF'))
    });
    var qty = num($('foodQty')); if (qty === null || qty <= 0) qty = 1;
    Store.addEntry(day, {
      foodId: f.id, name: f.name, qty: qty,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
    });
    ['inKcal', 'inP', 'inC', 'inF'].forEach(function (id) { $(id).value = ''; });
    $('inlineNew').hidden = true;
    $('foodPick').value = ''; $('foodQty').value = 1;
    render();
  });
  $('inCancel').addEventListener('click', function () { $('inlineNew').hidden = true; });

  function quickAdd() {
    var k = num($('quickKcal'));
    if (k === null || k <= 0) return;
    Store.addEntry(day, { name: 'Quick add', qty: 1, kcal: k });
    $('quickKcal').value = '';
    render();
  }
  $('addQuick').addEventListener('click', quickAdd);
  $('quickKcal').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); quickAdd(); }
  });

  $('foodLog').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-rm]');
    if (!b) return;
    Store.removeEntry(b.dataset.rm);
    render();
  });

  $('habitToday').addEventListener('change', function (ev) {
    var cb = ev.target.closest('[data-habit]');
    if (!cb) return;
    Store.setHabit(day, cb.dataset.habit, cb.checked);
    render();
  });

  $('dayNote').addEventListener('input', function () { Store.setNote(day, $('dayNote').value); });

  $('rangeSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-range]');
    if (!b) return;
    range = Number(b.dataset.range);
    Array.prototype.forEach.call($('rangeSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    render();
  });

  $('saveFood').addEventListener('click', function () {
    var name = $('nfName').value.trim();
    if (!name) { $('nfName').focus(); return; }
    Store.addFood({
      name: name, serving: $('nfServing').value.trim(),
      kcal: num($('nfKcal')), protein: num($('nfP')), carbs: num($('nfC')), fat: num($('nfF'))
    });
    ['nfName', 'nfServing', 'nfKcal', 'nfP', 'nfC', 'nfF'].forEach(function (id) { $(id).value = ''; });
    render();
  });
  $('foodFilter').addEventListener('input', function () {
    foodFilterText = $('foodFilter').value;
    renderFoods();
  });
  $('foodLibrary').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-food-rm]');
    if (!b) return;
    Store.removeFood(b.dataset.foodRm);
    render();
  });

  $('addHabit').addEventListener('click', function () {
    var v = $('newHabit').value.trim();
    if (!v) return;
    Store.addHabit(v);
    $('newHabit').value = '';
    render();
  });
  $('newHabit').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('addHabit').click(); }
  });
  $('habitBoard').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-habit-rm]');
    if (!b) return;
    if (!confirm('Delete this habit? Past check-ins stay in the data but stop being shown.')) return;
    Store.removeHabit(b.dataset.habitRm);
    render();
  });

  /* account */
  $('accountBody').addEventListener('click', function (ev) {
    var t = ev.target;
    if (t.closest('#authSend')) {
      var email = ($('authEmail').value || '').trim();
      if (!email || email.indexOf('@') < 0) { authMessage = 'That does not look like an email address.'; renderAccount(); return; }
      authEmail = email; authStage = 'busy'; authMessage = ''; renderAccount();
      Sync.requestCode(email).then(function () {
        authStage = 'code'; authMessage = ''; renderAccount();
        var c = $('authCode'); if (c) c.focus();
      }).catch(function (e) {
        authStage = 'idle'; authMessage = String(e.message || e); renderAccount();
      });
    } else if (t.closest('#authVerify')) {
      var code = ($('authCode').value || '').trim();
      if (!code) return;
      authMessage = ''; renderAccount();
      Sync.verifyCode(authEmail, code).then(function () {
        authStage = 'idle'; authMessage = '';
        render();
        doSync('sign-in');
      }).catch(function (e) {
        authMessage = String(e.message || e);
        authStage = 'code';
        renderAccount();
      });
    } else if (t.closest('#authBack')) {
      authStage = 'idle'; authMessage = ''; renderAccount();
    } else if (t.closest('#syncNow')) {
      doSync('manual');
    } else if (t.closest('#cfgSave')) {
      try {
        Sync.setConfig($('cfgUrl').value, $('cfgKey').value);
        authMessage = '';
        render();
      } catch (e) {
        authMessage = String(e.message || e);
        renderAccount();
      }
    } else if (t.closest('#cfgClear')) {
      if (!confirm('Forget the Supabase project details on this device? You will be signed out of sync.')) return;
      Sync.signOut();
      Sync.clearConfig();
      authStage = 'idle'; authEmail = ''; authMessage = '';
      render();
    } else if (t.closest('#signOut')) {
      if (!confirm('Sign out? Your data stays in the cloud and on this device.')) return;
      Sync.signOut();
      authStage = 'idle'; authEmail = ''; authMessage = '';
      render();
    }
  });
  $('accountBody').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'authEmail') { ev.preventDefault(); var b = $('authSend'); if (b) b.click(); }
    if (ev.target.id === 'authCode')  { ev.preventDefault(); var v = $('authVerify'); if (v) v.click(); }
  });

  /* settings */
  function bindSetting(id, key, parse) {
    $(id).addEventListener('change', function () {
      Store.setSetting(key, parse($(id)));
      render();
    });
  }
  bindSetting('stAge', 'age', function (el) { return num(el) || 40; });
  bindSetting('stHeight', 'heightIn', function (el) { return num(el) || 70; });
  bindSetting('stSex', 'sex', function (el) { return el.value; });
  bindSetting('stActivity', 'activity', function (el) { return el.value; });
  bindSetting('stGoalWeight', 'goalWeight', function (el) { return num(el); });
  bindSetting('stRate', 'goalRateLbPerWk', function (el) { var v = num(el); return v === null ? 0 : v; });
  bindSetting('stProtein', 'proteinPerLb', function (el) { var v = num(el); return v === null ? 0.8 : v; });
  bindSetting('stFat', 'fatPerLb', function (el) { var v = num(el); return v === null ? 0.35 : v; });
  $('stAlpha').addEventListener('input', function () {
    $('alphaVal').textContent = parseFloat($('stAlpha').value).toFixed(2);
  });
  $('stAlpha').addEventListener('change', function () {
    Store.setSetting('alpha', parseFloat($('stAlpha').value));
    render();
  });

  /* data */
  $('exportBtn').addEventListener('click', function () {
    var blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'trendline-' + WL.todayKey() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  $('importBtn').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function () {
    var file = $('importFile').files[0];
    if (!file) return;
    if (!confirm('Import replaces everything on this device. Continue?')) {
      $('importFile').value = '';
      return;
    }
    var r = new FileReader();
    r.onload = function () {
      if (Store.importJSON(String(r.result))) {
        day = WL.todayKey(); render(); doSync('import'); alert('Imported.');
      } else {
        alert('That file did not look like a Trendline export. Nothing was changed.');
      }
      $('importFile').value = '';
    };
    r.readAsText(file);
  });
  $('resetBtn').addEventListener('click', function () {
    if (!confirm('Erase every weigh-in, food and habit on this device? Export first if you want a copy.')) return;
    if (!confirm('Last check — this cannot be undone.')) return;
    Store.reset();
    day = WL.todayKey();
    render();
  });

  window.__tlSaveError = function () {
    alert('Could not save — this browser\'s storage is full or blocked. Export your data before doing anything else.');
  };

  /* Roll the view over if the app is left open past midnight, and sync
     when it comes back to the foreground. */
  setInterval(function () {
    var t = WL.todayKey();
    if (day !== t && document.visibilityState === 'visible' && WL.daysBetween(day, t) === 1) {
      day = t; render();
    }
  }, 60000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') doSync('foreground');
  });
  window.addEventListener('online', function () { renderSyncPill(); doSync('online'); });
  window.addEventListener('offline', renderSyncPill);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline is a bonus, not a requirement */ });
  }

  render();
  doSync('startup');
})();
