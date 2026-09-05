'use strict';

/* =============================================================
   TRENDLINE — UI
   Render-on-change. Every input writes to the store and calls
   render(); no virtual DOM and no framework, because the whole
   surface is five panels.
   ============================================================= */

(function () {

  var $ = function (id) { return document.getElementById(id); };

  /* Bumped by hand on each deploy, and shown under Setup → Version.
     Its only job is to let "it still looks old" be answered with a
     number instead of a guess. Keep it in step with CACHE in sw.js. */
  var BUILD = '2026-09-05.10';
  var day = WL.todayKey();
  var range = 30;
  var foodFilterText = '';
  var authStage = 'idle';       /* idle | password | codeRequest | code */
  var authEmail = '';
  var authMessage = '';
  var syncing = false;
  var lookup = { results: [], status: '', open: false };
  var macroKey = 'protein';     /* which macro the Trend chart is showing */

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
    /* Training credit is computed here but deliberately NOT fed into
       estimateTDEE. That estimate measures what the body actually did
       with the food it got, training included; adding an allowance into
       the measurement would make the measurement chase itself. The
       credit belongs to the day's budget, not to the metabolism.

       It self-corrects over weeks anyway: eat the credit, and if it was
       too generous the trend slows, the measured burn falls, and the
       target comes down on its own. */
    var training = WL.dayTraining(Store.workoutsFor(day), profile);

    var rate = WL.trendRate(series, 21);
    var projection = (hasWeight && typeof st.goalWeight === 'number' && rate !== null)
      ? WL.projectGoal(currentTrend, st.goalWeight, rate, series[series.length - 1].date)
      : null;

    return {
      st: st, pts: pts, series: series, hasWeight: hasWeight,
      currentTrend: currentTrend, lastRaw: lastRaw, basisLb: basisLb,
      intake: intake, tdee: tdee, target: target, macros: macros,
      rate: rate, projection: projection, training: training, profile: profile,
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
    /* Training is spent, so it raises the day's allowance. Half of what
       was burned, by design — see WL.EXERCISE_CREDIT. */
    var credit = D.hasWeight ? D.training.credit : 0;
    var tgt = D.hasWeight ? D.target.target + credit : null;
    var left = tgt === null ? null : tgt - eaten.kcal;

    $('eaten').textContent = fmt(eaten.kcal);
    /* The target is shown as base + credit rather than as one number,
       because a target that moves for no visible reason is a target
       nobody believes. */
    $('target').textContent = tgt === null ? '—'
      : (credit ? fmt(D.target.target) + ' + ' + fmt(credit) : fmt(tgt));
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
        /* The row is the edit affordance. A separate pencil per line is
           a lot of furniture on a phone for something you do often. */
        return '<li><button class="rowedit" data-edit="' + esc(line.id) + '">' +
          '<span class="name"><b>' + esc(line.name || 'Quick add') + '</b>' +
          (sub.length ? '<small>' + esc(sub.join('  ·  ')) + '</small>' : '') + '</span>' +
          '<span class="kcal">' + fmt(t.kcal) + '</span></button>' +
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
    if (D.training.credit) {
      s += ' Training added ' + fmt(D.training.credit) + ' — half of the ' +
        fmt(D.training.gross) + ' you worked off.';
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

    renderMacroChart(D, end);
  }

  /* ---------------------------------------------------------------
     MACROS OVER TIME

     Same 21-day window as the intake chart above it, so the two read
     as one picture rather than two arguments.

     Only protein is scored against its target. Protein is a floor —
     hitting it is the win, and on a deficit it is the macro worth
     protecting. Carbs and fat are the remainder after protein and
     calories are settled; they land where they land, and colouring a
     day red for exceeding a number the app itself derived would be
     inventing a failure that does not exist.
     --------------------------------------------------------------- */

  var MACRO_LABEL = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

  function renderMacroChart(D, end) {
    var macros = Store.macroMap();
    var days = [];
    for (var i = 20; i >= 0; i--) {
      var k = WL.addDays(end, -i);
      var m = macros[k];
      days.push({ date: k, value: m ? m[macroKey] : 0 });
    }

    var target = D.hasWeight ? D.macros[macroKey] : 0;
    $('macroChart').innerHTML = Chart.macro(days, {
      target: target,
      scored: macroKey === 'protein',
      empty: 'Log some food and the days appear here.'
    });

    var logged = days.filter(function (x) { return x.value > 0; });
    var name = MACRO_LABEL[macroKey];
    if (!logged.length) {
      $('macroSummary').textContent = 'No food logged in the last three weeks.';
      return;
    }
    var mean = logged.reduce(function (a, x) { return a + x.value; }, 0) / logged.length;
    var parts = [logged.length + ' of 21 days logged', 'average ' + fmt(mean) + ' g'];
    if (target > 0) parts.push('target ' + fmt(target) + ' g');

    if (macroKey === 'protein' && target > 0) {
      var hit = logged.filter(function (x) { return x.value >= target * 0.9; }).length;
      parts.push('within reach of target on ' + hit + ' of ' + logged.length);
    }
    $('macroSummary').textContent = parts.join(' · ') +
      (macroKey === 'protein'
        ? '. Protein is the one to defend on a deficit — it is what decides whether the weight you lose is fat.'
        : '. ' + name + ' is the remainder after protein and calories, so there is no such thing as being over on it.');
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
     TRAIN
     --------------------------------------------------------------- */

  var ACTIVITY_LABEL = {
    walk_easy: 'Walk — easy', walk_brisk: 'Walk — brisk', hike: 'Hike',
    jog: 'Jog', run: 'Run', cycle_easy: 'Bike — easy', cycle_hard: 'Bike — hard',
    swim: 'Swim', row: 'Row', elliptical: 'Elliptical', stairs: 'Stairs',
    lift_moderate: 'Lifting — moderate', lift_hard: 'Lifting — hard', other: 'Other'
  };

  function workoutLabel(w) {
    if (w.kind === 'steps') return 'Steps';
    if (w.name) return w.name;
    return ACTIVITY_LABEL[w.activity] || 'Session';
  }

  function renderTrain(D) {
    var list = Store.workoutsFor(day);
    var stepRec = Store.stepsOn(day);

    if (document.activeElement !== $('stepsInput')) {
      $('stepsInput').value = (stepRec && stepRec.steps) ? stepRec.steps : '';
    }
    if (!D.hasWeight) {
      $('stepsHint').textContent = 'Log a weight first — step calories depend on what you are carrying.';
    } else if (stepRec && stepRec.steps) {
      $('stepsHint').textContent = fmt(stepRec.steps) + ' steps ≈ ' +
        fmt(WL.stepsKcal(stepRec.steps, D.profile)) + ' cal, worked out from your weight and height.';
    } else {
      $('stepsHint').textContent = 'One number for the whole day. Saving again replaces it rather than adding to it.';
    }

    var sessions = list.filter(function (w) { return w.kind !== 'steps'; });
    var rows = list.map(function (w) {
      var kc = WL.workoutKcal(w, D.profile);
      var sub = [];
      if (w.kind === 'steps') sub.push(fmt(w.steps) + ' steps');
      else {
        if (w.activity && ACTIVITY_LABEL[w.activity] && w.name) sub.push(ACTIVITY_LABEL[w.activity]);
        if (w.minutes) sub.push(fmt(w.minutes) + ' min');
        var vol = WL.setsVolume(w.sets);
        if (vol) sub.push(fmt(vol) + ' lb moved');
      }
      if (typeof w.kcal === 'number' && w.kcal > 0) sub.push('entered by hand');
      return '<li><span class="name"><b>' + esc(workoutLabel(w)) + '</b>' +
        (sub.length ? '<small>' + esc(sub.join('  ·  ')) + '</small>' : '') + '</span>' +
        '<span class="kcal">' + fmt(kc) + '</span>' +
        '<button class="btn ghost" data-wo-rm="' + esc(w.id) + '" aria-label="Remove">&times;</button></li>';
    }).join('');
    $('workoutLog').innerHTML = rows ||
      '<li><span class="empty" style="flex:1">Nothing logged for this day.</span></li>';

    var t = D.training;
    $('trainStats').innerHTML = [
      { k: 'Worked off', v: D.hasWeight ? fmt(t.gross) : '—', n: 'net calories' },
      { k: 'Added to today', v: D.hasWeight ? '+' + fmt(t.credit) : '—', n: 'half of it' },
      { k: 'Sessions', v: String(sessions.length), n: stepRec ? 'plus steps' : '' },
      { k: 'Eat up to', v: D.hasWeight ? fmt(D.target.target + t.credit) : '—', n: 'cal today' }
    ].map(function (s) {
      return '<div class="stat"><div class="k">' + esc(s.k) + '</div><div class="v">' + esc(s.v) +
        '</div><div class="n">' + esc(s.n || '') + '</div></div>';
    }).join('');

    $('trainNote').textContent = 'Every number here is net — what the activity cost above sitting ' +
      'still for the same minutes, because your measured burn already counts the sitting. ' +
      'Half of it comes back as food. The other half is the margin against MET tables and step ' +
      'counters both running generous.';

    /* 30-day burn. Uses the intake bar chart: same shape of question,
       and one chart renderer is easier to keep honest than two. */
    var end = WL.todayKey(), days = [], total = 0, active = 0;
    for (var i = 29; i >= 0; i--) {
      var k = WL.addDays(end, -i);
      var d = WL.dayTraining(Store.workoutsFor(k), D.profile);
      days.push({ date: k, kcal: d.gross });
      if (d.gross > 0) { total += d.gross; active++; }
    }
    $('trainChart').innerHTML = Chart.intake(days, {
      target: 0, empty: 'Log a session and the days appear here.'
    });
    $('trainSummary').textContent = active
      ? active + ' of 30 days trained · ' + fmt(total) + ' net calories worked off · ' +
        fmt(Math.round(total * WL.EXERCISE_CREDIT)) + ' given back as food'
      : 'Nothing logged in the last 30 days.';
  }

  /* ---------------------------------------------------------------
     FOOD LOOKUP

     Results are held in module state rather than read back out of the
     DOM, so logging one does not depend on the markup surviving a
     re-render. Each row carries its index and nothing else.
     --------------------------------------------------------------- */

  function renderLookup() {
    var panel = $('lookupPanel');
    panel.hidden = !lookup.open;
    if (!lookup.open) return;

    $('lookupStatus').textContent = lookup.status || '';
    $('lookupResults').innerHTML = lookup.results.map(function (r, i) {
      var sub = [];
      if (r.serving) sub.push(r.serving);
      sub.push(fmt(r.protein) + 'p ' + fmt(r.carbs) + 'c ' + fmt(r.fat) + 'f');
      sub.push(r.source === 'usda' ? 'USDA' : 'Open Food Facts');
      /* USDA lab foods publish macros and no calorie figure. Saying so
         is the difference between a number you trust and one you don't. */
      if (r.kcalDerived) sub.push('cal from macros');
      return '<li style="padding:0"><button class="result" data-pick="' + i + '">' +
        '<span class="name"><b>' + esc(r.name) + '</b><small>' + esc(sub.join('  ·  ')) +
        '</small></span><span class="kcal">' + fmt(r.kcal) + '</span></button></li>';
    }).join('');
  }

  function setLookup(status, results) {
    lookup.open = true;
    lookup.status = status || '';
    lookup.results = results || [];
    renderLookup();
  }

  function closeLookup() {
    lookup.open = false; lookup.results = []; lookup.status = '';
    renderLookup();
  }

  /* ---------------------------------------------------------------
     THE AMOUNT EDITOR

     One panel doing two jobs, because they are the same job: deciding
     what numbers a line in the log should carry.

       'new'    a lookup result on its way in. USDA lab foods are
                stated per 100g, which is a laboratory convention and
                not a portion anybody eats, so the grams have to be
                settable before it lands.
       'entry'  a line already logged. Previously the only way to fix
                one was delete and re-add, which loses the food and
                retypes everything.

     Every number stays editable by hand in both modes. The databases
     are good, not right, and the person who ate the thing is a better
     authority than a national average.
     --------------------------------------------------------------- */

  var editing = null;   /* {mode:'new', rec} | {mode:'entry', id} */

  function feSet(id, v) { $(id).value = (v === null || v === undefined) ? '' : v; }

  function openFoodEditForResult(rec) {
    editing = { mode: 'new', rec: rec };
    var perGram = !!(rec.per100g && rec.per100g.kcal !== null);
    $('feTitle').textContent = rec.name;
    $('feGramsRow').hidden = !perGram;
    $('feQtyRow').hidden = perGram;

    if (perGram) {
      feSet('feGrams', rec.servingGrams || 100);
      feSet('feQtyG', 1);
    } else {
      feSet('feQty', num($('foodQty')) || 1);
    }
    feSet('feKcal', rec.kcal); feSet('feP', rec.protein);
    feSet('feC', rec.carbs); feSet('feF', rec.fat);

    $('feSave').textContent = 'Log it';
    $('feHint').textContent = perGram
      ? 'Stated as ' + rec.serving + '. Change the grams and the numbers follow; ' +
        'or type over any of them.'
      : 'Serving: ' + rec.serving + '. Change anything that looks wrong before logging it.';
    $('foodEdit').hidden = false;
    (perGram ? $('feGrams') : $('feQty')).focus();
  }

  function openFoodEditForEntry(id) {
    var e = Store.entry(id);
    if (!e) return;
    editing = { mode: 'entry', id: id };
    $('feTitle').textContent = e.name || 'Logged food';
    $('feGramsRow').hidden = true;
    $('feQtyRow').hidden = false;
    feSet('feQty', typeof e.qty === 'number' ? e.qty : 1);
    feSet('feKcal', e.kcal); feSet('feP', e.protein);
    feSet('feC', e.carbs); feSet('feF', e.fat);
    $('feSave').textContent = 'Save';
    $('feHint').textContent = 'These are the numbers for ONE serving. The log multiplies them ' +
      'by the servings above.';
    $('foodEdit').hidden = false;
    lookup.open = false; renderLookup();
    $('feKcal').focus();
  }

  function closeFoodEdit() {
    editing = null;
    $('foodEdit').hidden = true;
  }

  /* Grams changed: rescale from the per-100g basis the source gave us.
     Only ever applies in 'new' mode, because a logged entry no longer
     carries a per-100g basis to rescale from. */
  function feRescale() {
    if (!editing || editing.mode !== 'new') return;
    var g = num($('feGrams'));
    var scaled = FoodAPI.atGrams(editing.rec, g);
    if (!scaled) return;
    feSet('feKcal', scaled.kcal); feSet('feP', scaled.protein);
    feSet('feC', scaled.carbs); feSet('feF', scaled.fat);
  }

  function saveFoodEdit() {
    if (!editing) return;

    var vals = {
      kcal: num($('feKcal')), protein: num($('feP')),
      carbs: num($('feC')), fat: num($('feF'))
    };

    if (editing.mode === 'entry') {
      var q = num($('feQty'));
      Store.updateEntry(editing.id, {
        qty: (q === null || q <= 0) ? 1 : q,
        kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
      });
      closeFoodEdit();
      render();
      return;
    }

    var rec = editing.rec;
    var perGram = !$('feGramsRow').hidden;
    var qty = num(perGram ? $('feQtyG') : $('feQty'));
    if (qty === null || qty <= 0) qty = 1;
    var grams = perGram ? num($('feGrams')) : null;
    var serving = grams ? grams + ' g' : rec.serving;

    /* The library entry is keyed by name, so re-scanning the same
       product finds it again. When the amount has been changed, the
       name carries it — "Chicken breast (150 g)" and the same food at
       100g are different servings and must not overwrite each other. */
    var name = rec.name;
    if (grams && rec.servingGrams && Math.abs(grams - rec.servingGrams) > 0.5) {
      name = rec.name + ' (' + grams + ' g)';
    }

    var existing = Store.findFoodByName(name);
    var f = existing
      ? Store.addFood({
          id: existing.id, name: name, serving: serving,
          kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
        })
      : Store.addFood({
          name: name, serving: serving,
          kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
        });

    Store.addEntry(day, {
      foodId: f.id, name: f.name, qty: qty,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
    });
    $('foodPick').value = '';
    $('foodQty').value = 1;
    closeFoodEdit();
    closeLookup();
    render();
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
        '<div class="note" id="authMsg"' + (authMessage ? '' : ' hidden') + '>' + esc(authMessage) + '</div>';
      return;
    }

    if (!Sync.signedIn()) {
      if (authStage === 'password' || authStage === 'idle' || authStage === 'busy') {
        return renderPasswordForm(body);
      }
      if (authStage === 'code') {
        body.innerHTML =
          '<p class="hint" style="margin:0 0 var(--s-3)">Six-digit code sent to <b>' + esc(authEmail) + '</b>.</p>' +
          '<div class="row">' +
          '<label class="field" style="margin:0"><span class="sr">Code</span>' +
          '<input type="text" id="authCode" inputmode="numeric" autocomplete="one-time-code" ' +
          'maxlength="6" placeholder="123456"></label>' +
          '<button class="btn primary grow-0" id="authVerify">Verify</button></div>' +
          '<button class="btn ghost" id="authBack" style="margin-top:var(--s-2)">Use a different email</button>' +
          '<div class="note" id="authMsg"' + (authMessage ? '' : ' hidden') + '>' + esc(authMessage) + '</div>' +
          /* Supabase ships a Magic Link template by default, which sends a
             link rather than a code. Without this hint the first sign-in
             looks like a broken app instead of a one-line settings change. */
          '<p class="hint">Got a <b>link</b> in the email instead of a code? In Supabase go to ' +
          '<b>Authentication &rarr; Emails &rarr; Magic Link</b> and put <code>{{ .Token }}</code> ' +
          'in the template. See SETUP.md.</p>';
      } else {
        body.innerHTML =
          '<p class="hint" style="margin:0 0 var(--s-3)">A one-time code by email. This needs the ' +
          'Supabase <b>Magic Link</b> template to contain <code>{{ .Token }}</code>; the stock ' +
          'template sends a link instead.</p>' +
          '<div class="row">' +
          '<label class="field" style="margin:0"><span class="sr">Email</span>' +
          '<input type="email" id="authEmail" inputmode="email" autocomplete="email" ' +
          'placeholder="you@example.com" value="' + esc(authEmail) + '"></label>' +
          '<button class="btn primary grow-0" id="authSend">Send code</button></div>' +
          '<button class="btn ghost" id="usePassword">Use a password instead</button>' +
          '<div class="note" id="authMsg"' + (authMessage ? '' : ' hidden') + '>' + esc(authMessage) + '</div>';
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

  /* Show an error without re-rendering.

     Re-rendering a form to show a message wipes everything already typed
     in it — mistype a password and the email goes too, and in the setup
     form a bad paste takes the long anon key with it. So the message gets
     its own slot and only that slot changes. */
  function setAuthMessage(text) {
    authMessage = text || '';
    var slot = $('authMsg');
    if (!slot) { renderAccount(); return; }
    slot.textContent = authMessage;
    slot.hidden = !authMessage;
  }

  function setAuthBusy(busy) {
    ['pwSignIn', 'pwSignUp', 'authSend', 'authVerify', 'cfgSave'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = busy;
    });
  }

  /* Password first. It works with no email configuration at all, which is
     the difference between sync working tonight and sync waiting on a
     dashboard setting. */
  function renderPasswordForm(body) {
    /* An empty form is the same shape whether you have never signed in
       or were signed in five minutes ago, and those need different
       words. On iOS the second case is common and looks like a bug:
       the installed app has its own storage, separate from Safari, so
       signing in on the website leaves the app asking again. Naming
       the account it remembers turns "why is this broken" into "oh,
       right". */
    var known = Sync.lastAccount();
    if (authEmail === '' && known) authEmail = known;

    var intro = known
      ? 'This device is signed out of <b>' + esc(known) + '</b>. Sign in again and your log comes back — ' +
        'nothing was lost, it is all still in the cloud and on any device you are signed in on. ' +
        'On iPhone the app you installed to the home screen keeps its own separate login from Safari, ' +
        'so signing in here is a separate step from signing in on the website.'
      : 'Sign in to sync across your devices. Use the same account on each one.';

    body.innerHTML =
      '<p class="hint" style="margin:0 0 var(--s-3)">' + intro + '</p>' +
      '<label class="field"><span>Email</span>' +
      '<input type="email" id="pwEmail" inputmode="email" autocomplete="username" ' +
      'autocapitalize="off" spellcheck="false" placeholder="you@example.com" value="' + esc(authEmail) + '"></label>' +
      '<label class="field"><span>Password</span>' +
      '<input type="password" id="pwPass" autocomplete="current-password" ' +
      'placeholder="at least 6 characters"></label>' +
      '<div class="row">' +
      '<button class="btn primary" id="pwSignIn">Sign in</button>' +
      '<button class="btn" id="pwSignUp">Create account</button>' +
      '</div>' +
      '<button class="btn ghost" id="useCode" style="margin-top:var(--s-2)">Email me a code instead</button>' +
      '<div class="note" id="authMsg"' + (authMessage ? '' : ' hidden') + '>' + esc(authMessage) + '</div>';
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

    /* A key committed in config.js applies to every device, so the field
       shows it as already handled rather than inviting a second copy. */
    var cfgKey = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.USDA_API_KEY) || '';
    if (document.activeElement !== $('usdaKey')) {
      $('usdaKey').value = cfgKey ? '' : FoodAPI.usdaKey();
    }
    $('usdaKey').placeholder = cfgKey ? 'set in config.js — nothing to do here' : 'paste the key here';
    $('usdaKey').disabled = !!cfgKey;
    if (!$('usdaStatus').dataset.sticky) {
      $('usdaStatus').textContent = FoodAPI.hasUsdaKey()
        ? 'Key is set. Name search is on.'
        : 'No key yet. Barcode scanning still works without one.';
    }

    var bytes = 0;
    try { bytes = (localStorage.getItem(Store.KEY) || '').length; } catch (e) {}
    var dates = Store.loggedDates();
    $('storageHint').textContent = dates.length + ' days logged · ' +
      (bytes < 1024 ? bytes + ' bytes' : (bytes / 1024).toFixed(1) + ' KB') +
      (dates.length ? ' · since ' + dates[0] : '');

    $('buildHint').textContent = 'Build ' + BUILD +
      (('serviceWorker' in navigator)
        ? '. Updates are fetched on every launch and applied straight away.'
        : '. This browser has no offline support, so you are always on the latest.');

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
    renderTrain(D);
    renderFoods();
    renderHabits(D);
    renderLookup();
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

  /* A heartbeat, for the app left open rather than opened.

     Everything else that triggers a sync is an event: an edit, coming
     back to the foreground, the network returning. None of those fire
     for a phone sitting on the counter with the app up, or a laptop
     tab open all afternoon — so a weigh-in logged on one device could
     sit unseen on the other for hours despite both being online.

     Only when visible. A background tab syncing achieves nothing and
     spends battery, and on iOS a suspended app does not run timers at
     all — which is fine, because the foreground handler covers exactly
     that case the moment it wakes. The two together mean the data is
     never more than ten minutes stale on any device that is awake. */
  var SYNC_EVERY_MS = 10 * 60 * 1000;

  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    doSync('periodic');
  }, SYNC_EVERY_MS);

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
    var rm = ev.target.closest('[data-rm]');
    if (rm) { Store.removeEntry(rm.dataset.rm); render(); return; }
    var ed = ev.target.closest('[data-edit]');
    if (ed) openFoodEditForEntry(ed.dataset.edit);
  });

  /* train */
  var workoutKind = 'cardio';

  function saveSteps() {
    Store.setSteps(day, num($('stepsInput')));
    render();
  }
  $('saveSteps').addEventListener('click', saveSteps);
  $('stepsInput').addEventListener('change', saveSteps);
  $('stepsInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('stepsInput').blur(); saveSteps(); }
  });

  $('kindSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-kind]');
    if (!b) return;
    workoutKind = b.dataset.kind;
    Array.prototype.forEach.call($('kindSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    $('cardioFields').hidden = workoutKind !== 'cardio';
    $('liftingFields').hidden = workoutKind !== 'lifting';
  });

  $('addWorkout').addEventListener('click', function () {
    var minutes = num($('woMinutes'));
    var kcal = num($('woKcal'));
    /* Without minutes there is nothing to estimate from, so a session
       with neither minutes nor a hand-entered figure would be worth
       zero and quietly look like it counted. */
    if (minutes === null && kcal === null) {
      $('woMinutes').focus();
      return;
    }
    var w = { kind: workoutKind, minutes: minutes, kcal: kcal };
    if (workoutKind === 'lifting') {
      w.activity = $('woIntensity').value;
      w.name = $('woName').value.trim() || 'Lifting';
      var sets = WL.parseSets($('woSets').value);
      if (sets.length) w.sets = sets;
    } else {
      w.activity = $('woActivity').value;
      w.name = '';
    }
    Store.addWorkout(day, w);
    ['woMinutes', 'woKcal', 'woName', 'woSets'].forEach(function (id) { $(id).value = ''; });
    render();
  });

  $('workoutLog').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-wo-rm]');
    if (!b) return;
    Store.removeWorkout(b.dataset.woRm);
    render();
  });

  /* food lookup — search by name */
  $('searchOnline').addEventListener('click', function () {
    var q = $('foodPick').value.trim();
    if (!q) { $('foodPick').focus(); setLookup('Type what you ate first, then look it up.', []); return; }
    setLookup('Searching for “' + q + '”…', []);
    FoodAPI.searchFoods(q).then(function (rows) {
      if (!rows.length) setLookup('Nothing found for “' + q + '”. Add it by hand and it is yours from then on.', []);
      else setLookup(rows.length + ' found. Tap one to log it — it joins your library too.', rows);
    }).catch(function (e) {
      setLookup(String(e.message || e), []);
    });
  });

  $('lookupResults').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-pick]');
    if (!b) return;
    var rec = lookup.results[Number(b.dataset.pick)];
    if (rec) openFoodEditForResult(rec);
  });

  /* amount editor */
  $('feGrams').addEventListener('input', feRescale);
  $('feSave').addEventListener('click', saveFoodEdit);
  $('feCancel').addEventListener('click', closeFoodEdit);
  $('foodEdit').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); saveFoodEdit(); }
  });

  /* food lookup — barcode */
  function openScanner() {
    $('scannerOverlay').hidden = false;
    $('manualBarcode').value = '';
    var why = Scanner.unavailableReason();
    if (why) {
      /* No camera is not a dead end — the digits under the bars are
         right there on the package. */
      $('scanStatus').textContent = why + ' You can still type the digits below.';
      $('manualBarcode').focus();
      return;
    }
    $('scanStatus').textContent = 'Starting the camera…';
    Scanner.start('scanView', function (err, code) {
      if (err) {
        $('scanStatus').textContent = String(err.message || err) + ' You can still type the digits below.';
        return;
      }
      $('scanStatus').textContent = 'Read ' + code + ' — looking it up…';
      resolveBarcode(code);
    }).then(function () {
      /* Specific, because "point the camera at the barcode" is what
         everyone is already doing when it fails. The bars need to fill
         the width and be about a hand span away — closer than feels
         right, and the usual reason nothing reads. */
      if (Scanner.running()) {
        $('scanStatus').textContent = 'Fill the width with the bars, about a hand span away, ' +
          'and hold still. If nothing happens in a few seconds, take a photo instead — ' +
          'the camera focuses better for a photo than it does while streaming.';
      }
    });
  }

  function closeScanner() {
    Scanner.stop();
    $('scannerOverlay').hidden = true;
  }

  /* Shared by the camera and the typed-in path, because from here they
     are the same thing: a number that may or may not be in the database. */
  function resolveBarcode(code) {
    closeScanner();
    setLookup('Looking up ' + code + '…', []);
    FoodAPI.lookupBarcode(code).then(function (rec) {
      if (!rec) {
        /* Two databases have now been asked. Say which, so this reads as
           a gap in the world's data rather than a broken scanner — and
           say what to do about it, since typing it once is the end of
           the problem for that product forever. */
        setLookup('Barcode ' + code + ' is in neither Open Food Facts nor USDA. Both are ' +
          'incomplete on US groceries, so this happens. Type the name and macros off the ' +
          'label once and it lives in your library from then on.' +
          (FoodAPI.hasUsdaKey() ? '' : ' (USDA was skipped — no key set under Setup → Food lookup.)'), []);
        return;
      }
      setLookup('Found it. Tap to log.', [rec]);
    }).catch(function (e) {
      setLookup(String(e.message || e), []);
    });
  }

  $('scanBarcode').addEventListener('click', openScanner);
  $('scanClose').addEventListener('click', closeScanner);

  /* The still-photo path. Also the escape hatch when the live scanner
     is running but not reading — the phone focuses properly for a
     photo in a way it does not while streaming. */
  $('photoBarcode').addEventListener('click', function () {
    $('photoBarcodeFile').click();
  });
  $('photoBarcodeFile').addEventListener('change', function () {
    var file = $('photoBarcodeFile').files[0];
    $('photoBarcodeFile').value = '';       /* so the same shot can be retried */
    if (!file) return;
    $('scanStatus').textContent = 'Reading the photo…';
    Scanner.scanImage(file, 'scanView').then(function (code) {
      $('scanStatus').textContent = 'Read ' + code + ' — looking it up…';
      resolveBarcode(code);
    }).catch(function (e) {
      /* Stays open: the whole point is to let them line up another shot. */
      $('scanStatus').textContent = String(e.message || e);
    });
  });
  $('manualBarcodeGo').addEventListener('click', function () {
    var v = $('manualBarcode').value.trim();
    if (v) resolveBarcode(v);
  });
  $('manualBarcode').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('manualBarcodeGo').click(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !$('scannerOverlay').hidden) closeScanner();
  });

  /* USDA key */
  function usdaSay(text) {
    $('usdaStatus').dataset.sticky = '1';
    $('usdaStatus').textContent = text;
  }
  $('usdaSave').addEventListener('click', function () {
    var k = $('usdaKey').value.trim();
    FoodAPI.setUsdaKey(k);
    usdaSay(k ? 'Saved on this device. Put it in config.js to have it on all of them.' : 'Key cleared.');
  });
  $('usdaTest').addEventListener('click', function () {
    if (!FoodAPI.hasUsdaKey()) { usdaSay('Nothing to test — no key set.'); return; }
    usdaSay('Testing…');
    FoodAPI.searchFoods('egg', { limit: 1 }).then(function (rows) {
      usdaSay(rows.length ? 'Working — the key is good.' : 'The key was accepted but returned nothing.');
    }).catch(function (e) { usdaSay(String(e.message || e)); });
  });

  $('habitToday').addEventListener('change', function (ev) {
    var cb = ev.target.closest('[data-habit]');
    if (!cb) return;
    Store.setHabit(day, cb.dataset.habit, cb.checked);
    render();
  });

  $('dayNote').addEventListener('input', function () { Store.setNote(day, $('dayNote').value); });

  $('macroSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-macro]');
    if (!b) return;
    macroKey = b.dataset.macro;
    Array.prototype.forEach.call($('macroSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    render();
  });

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
    if (t.closest('#pwSignIn') || t.closest('#pwSignUp')) {
      var creating = !!t.closest('#pwSignUp');
      var em = ($('pwEmail').value || '').trim();
      var pw = $('pwPass').value || '';
      authEmail = em;   /* remembered so a later re-render keeps it */
      if (!em || em.indexOf('@') < 0) { setAuthMessage('That does not look like an email address.'); return; }
      if (pw.length < 6) { setAuthMessage('Password needs at least 6 characters.'); return; }
      setAuthMessage(''); setAuthBusy(true);
      (creating ? Sync.signUp(em, pw) : Sync.signInPassword(em, pw)).then(function () {
        authStage = 'idle'; authMessage = '';
        render();
        doSync('sign-in');
      }).catch(function (e) {
        setAuthBusy(false);
        setAuthMessage(String(e.message || e));
      });
    } else if (t.closest('#useCode')) {
      authStage = 'codeRequest'; authMessage = ''; renderAccount();
    } else if (t.closest('#usePassword')) {
      authStage = 'password'; authMessage = ''; renderAccount();
    } else if (t.closest('#authSend')) {
      var email = ($('authEmail').value || '').trim();
      authEmail = email;
      if (!email || email.indexOf('@') < 0) { setAuthMessage('That does not look like an email address.'); return; }
      setAuthMessage(''); setAuthBusy(true);
      Sync.requestCode(email).then(function () {
        authStage = 'code'; authMessage = ''; renderAccount();
        var c = $('authCode'); if (c) c.focus();
      }).catch(function (e) {
        authStage = 'codeRequest'; setAuthMessage(String(e.message || e));
      });
    } else if (t.closest('#authVerify')) {
      var code = ($('authCode').value || '').trim();
      if (!code) return;
      setAuthBusy(true);
      Sync.verifyCode(authEmail, code).then(function () {
        authStage = 'idle'; authMessage = '';
        render();
        doSync('sign-in');
      }).catch(function (e) {
        setAuthBusy(false);
        setAuthMessage(String(e.message || e));
      });
    } else if (t.closest('#authBack')) {
      authStage = 'codeRequest'; authMessage = ''; renderAccount();
    } else if (t.closest('#syncNow')) {
      doSync('manual');
    } else if (t.closest('#cfgSave')) {
      try {
        Sync.setConfig($('cfgUrl').value, $('cfgKey').value);
        authMessage = '';
        render();
      } catch (e) {
        /* In place: a rejected paste must not take the key with it. */
        setAuthMessage(String(e.message || e));
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
    if (ev.target.id === 'pwEmail' || ev.target.id === 'pwPass') {
      ev.preventDefault(); var si = $('pwSignIn'); if (si) si.click(); return;
    }
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
  /* The manual escape hatch. The automatic path should make this
     unnecessary, but "unnecessary" is not what you want to be told
     while looking at a screen that is visibly out of date. */
  $('updateBtn').addEventListener('click', function () {
    if (!('serviceWorker' in navigator)) { window.location.reload(); return; }
    $('updateStatus').textContent = 'Checking…';
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) { window.location.reload(); return; }
      return reg.update().then(function () {
        /* If an update was found, the controllerchange handler reloads
           the page and this message is never read. */
        $('updateStatus').textContent = reg.installing || reg.waiting
          ? 'Update found — reloading…'
          : 'Already on the latest build.';
      });
    }).catch(function (e) {
      $('updateStatus').textContent = 'Could not check: ' + String(e.message || e);
    });
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
    if (document.visibilityState === 'visible') { doSync('foreground'); return; }
    /* Leaving the camera running in the background keeps the indicator
       light on and, on iOS, comes back as a black frame. */
    if (Scanner.running()) closeScanner();
  });
  window.addEventListener('online', function () { renderSyncPill(); doSync('online'); });
  window.addEventListener('offline', renderSyncPill);

  /* ---------------------------------------------------------------
     STAYING UP TO DATE

     A home-screen app has no address bar and no reload button, so if
     it does not go looking for a new version there is no way for the
     person holding it to ask for one. Three things together:

       1. sw.js is network-first for the app's own code, so a launch
          with signal already gets current files.
       2. The registration is asked to update on launch and every time
          the app comes back to the foreground.
       3. When a new worker takes over, the page reloads itself once.

     The reload is guarded by a flag rather than a timestamp: the
     classic failure here is a worker that keeps activating and a page
     that keeps reloading, and a flag makes that impossible within a
     page's lifetime. Reloading at all is only safe because everything
     typed into this app is written to localStorage on the keystroke —
     there is no in-flight form state to lose. */
  var reloading = false;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      function check() {
        if (document.visibilityState !== 'visible') return;
        reg.update().catch(function () { /* offline: try again next time */ });
      }
      check();
      document.addEventListener('visibilitychange', check);

      /* A worker that installs while an old one is still controlling
         the page sits in `waiting` until every tab closes. Telling it
         to skip means the update lands on this launch, not the next. */
      reg.addEventListener('updatefound', function () {
        var next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', function () {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            next.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(function () { /* offline is a bonus, not a requirement */ });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  render();
  doSync('startup');
})();
