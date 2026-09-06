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
  var BUILD = '2026-09-06.26';
  var day = WL.todayKey();
  var range = 30;
  var foodFilterText = '';
  var authStage = 'idle';       /* idle | password | codeRequest | code */
  var authEmail = '';
  var authMessage = '';
  var syncing = false;
  var lookup = { results: [], status: '', open: false, source: null };
  var macroKey = 'protein';     /* which macro the Trend chart is showing */
  var trendView = 'food';       /* Trend sub-tab: food | training */
  var libKind = 'food';         /* Foods panel: food | recipe */
  var microView = 'today';      /* Micronutrient card: today | 14 */
  var tagFilter = null;         /* active tag chip, or null for all */
  var trainView = 'today';      /* Train sub-tab: today | workouts | exercises */
  var exQuery = '';             /* exercise search box */
  var exOpenId = null;          /* exercise whose detail card is open */
  var gymError = '';            /* catalog load failure, shown rather than swallowed */
  var planKind = 'workout';     /* Workouts view: workout | program */
  var editing_plan = null;      /* the plan being edited, as a working copy */
  var peSearch = '';            /* exercise search inside the editor */

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
    /* A manual target replaces the computed one.

       Before there are two weeks of logging, the target comes from
       Mifflin-St Jeor times an activity multiplier, and that formula
       runs high for a lot of people — an activity level chosen
       optimistically can add several hundred calories on its own. The
       adaptive estimate fixes this on its own once it has data, but
       "wait a fortnight" is not an answer to a number you do not
       believe today.

       The engine keeps running underneath. Clearing the override
       returns to it, and the measured burn is still shown, so this is
       a manual override rather than a fork in the logic. */
    var manual = (typeof st.targetOverride === 'number' && st.targetOverride > 0)
      ? Math.round(st.targetOverride) : null;
    if (manual) {
      target = Object.assign({}, target, {
        target: manual, manual: true, computed: target.target,
        actualRate: ((tdee.tdee - manual) * 7) / WL.KCAL_PER_LB
      });
    }

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
        /* What was typed, not what it became. "2 oz" is checkable at a
           glance; "x0.567" is a number you have to reconstruct. */
        if (line.amount && line.unit && line.unit !== 'serving') {
          sub.push(Units.describe(line.amount, line.unit));
        } else if (line.qty && line.qty !== 1) {
          sub.push('x' + fmt(line.qty, 2));
        }
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
    if (D.target.manual) {
      var m = 'Target set by hand to ' + fmt(D.target.target) + '. ' +
        'The formula would have said ' + fmt(D.target.computed) + '. ';
      m += D.tdee.method === 'adaptive'
        ? 'Your measured burn is ' + fmt(D.tdee.tdee) + ', so this is about ' +
          fmt(D.target.actualRate, 2) + ' lb/wk.'
        : 'Once two weeks of weight and food are logged, the measured number will tell you ' +
          'whether this is the right one.';
      if (D.training.credit) m += ' Training added ' + fmt(D.training.credit) + '.';
      return m;
    }
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
    renderTrendWater(end);
    renderTrendTraining(D, end);

    $('trendFood').hidden = trendView !== 'food';
    $('trendWater').hidden = trendView !== 'water';
    $('trendTraining').hidden = trendView !== 'training';
  }

  /* ---------------------------------------------------------------
     WATER OVER TIME

     A day with no water logged is absent, not zero — the same rule the
     intake chart and the TDEE estimate use. "Drank nothing" and
     "did not record it" are different facts, and averaging the second
     as the first invents a dehydration problem out of a logging habit.
     --------------------------------------------------------------- */

  function renderTrendWater(end) {
    var goal = num0(Store.settings().waterGoalOz, 64);
    var days = [], logged = [], met = 0, streak = 0, best = 0;

    for (var i = 29; i >= 0; i--) {
      var k = WL.addDays(end, -i);
      var oz = Store.waterOn(k);
      days.push({ date: k, kcal: oz });
      if (oz > 0) {
        logged.push(oz);
        if (goal > 0 && oz >= goal) {
          met++; streak++; if (streak > best) best = streak;
        } else { streak = 0; }
      } else { streak = 0; }
    }

    var mean = logged.length
      ? logged.reduce(function (a, b) { return a + b; }, 0) / logged.length : 0;

    $('waterTrendStats').innerHTML = [
      { k: 'Days logged', v: String(logged.length), n: 'of the last 30' },
      { k: 'Average', v: fmt(mean) + ' oz', n: 'on the days logged' },
      { k: 'Goal met', v: String(met), n: goal ? 'at ' + fmt(goal) + ' oz' : 'no goal set' },
      { k: 'Best run', v: String(best), n: best === 1 ? 'day' : 'days in a row' }
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + esc(x.k) + '</div><div class="v">' + esc(x.v) +
        '</div><div class="n">' + esc(x.n) + '</div></div>';
    }).join('');

    $('waterTrendNote').textContent = !logged.length
      ? 'Nothing logged yet. The buttons on Today take about a second each.'
      : (logged.length < 7
        ? 'Only ' + logged.length + ' day' + (logged.length === 1 ? '' : 's') +
          ' logged so far, which is too few to read a pattern into.'
        : 'Averaging ' + fmt(mean) + ' oz on the days you logged, and hitting ' +
          fmt(goal) + ' on ' + met + ' of them. Days you did not record are left out ' +
          'rather than counted as nothing.');

    $('waterTrendChart').innerHTML = Chart.intake(days, {
      target: goal,
      empty: 'Log some water and the days appear here.'
    });
    $('waterTrendSummary').textContent = logged.length
      ? logged.length + ' of 30 days logged' + (goal ? ' \u00b7 line is the ' + fmt(goal) + ' oz goal' : '')
      : '';
  }

  /* The training half of the Trend page. The Train tab is for logging;
     this is for looking back, which is a different question and wants a
     longer window than "today". */
  function renderTrendTraining(D, end) {
    var days = [], total = 0, active = 0, sessions = 0, steps = 0;
    for (var i = 29; i >= 0; i--) {
      var k = WL.addDays(end, -i);
      var list = Store.workoutsFor(k);
      var d = WL.dayTraining(list, D.profile);
      days.push({ date: k, kcal: d.gross });
      if (d.gross > 0) { total += d.gross; active++; }
      list.forEach(function (w) {
        if (w.kind === 'steps') steps += (w.steps || 0); else sessions++;
      });
    }
    var credit = Math.round(total * WL.EXERCISE_CREDIT);

    $('trainTrendStats').innerHTML = [
      { k: 'Days trained', v: String(active), n: 'of the last 30' },
      { k: 'Sessions', v: String(sessions), n: 'not counting steps' },
      { k: 'Worked off', v: fmt(total), n: 'net calories' },
      { k: 'Given back', v: '+' + fmt(credit), n: 'as food' }
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + esc(x.k) + '</div><div class="v">' + esc(x.v) +
        '</div><div class="n">' + esc(x.n) + '</div></div>';
    }).join('');

    $('trainTrendNote').textContent = active
      ? 'Averaging ' + fmt(total / 30) + ' net calories a day across the month, or ' +
        fmt(total / Math.max(1, active)) + ' on the days you trained. ' +
        (steps ? 'Steps over the same period: ' + fmt(steps) + '.' : '')
      : 'Nothing logged in the last 30 days, so there is nothing to read into yet.';

    $('trainTrendChart').innerHTML = Chart.intake(days, {
      target: 0, empty: 'Log a session and the days appear here.'
    });
    $('trainTrendSummary').textContent = active
      ? active + ' of 30 days trained'
      : '';
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
     WATER

     One running total for the day rather than a list of glasses.
     Nobody wants to audit their own hydration; they want to know
     whether to have another one.
     --------------------------------------------------------------- */

  function renderWater() {
    var goal = num0(Store.settings().waterGoalOz, 64);
    var oz = Store.waterOn(day);
    var pct = goal > 0 ? Math.min(100, (oz / goal) * 100) : 0;

    $('waterReadout').textContent = fmt(oz) + ' / ' + fmt(goal) + ' oz';
    $('waterBar').style.width = pct + '%';
    /* The slider runs past the goal on purpose. A scale that stops at
       the target cannot show the days you went past it, and quietly
       suggests there is something wrong with having done so. */
    $('waterSlider').max = String(Math.max(128, Math.ceil(goal * 1.5 / 4) * 4));
    if (document.activeElement !== $('waterSlider')) $('waterSlider').value = String(oz);
    if (document.activeElement !== $('waterInput')) $('waterInput').value = oz ? String(oz) : '';

    var left = goal - oz;
    $('waterHint').textContent = goal <= 0
      ? 'No goal set. Setup \u2192 Water and steps.'
      : (left > 0
        ? fmt(left) + ' oz to go. A pint glass is about 16.'
        : (oz === goal ? 'Goal met.' : 'Goal met, ' + fmt(oz - goal) + ' oz past it.'));
  }

  function num0(v, fallback) {
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : fallback;
  }

  function setWater(oz) {
    Store.setWater(day, Math.max(0, oz));
    renderWater();
    scheduleSync();
  }

  /* ---------------------------------------------------------------
     MICRONUTRIENTS

     Every figure is shown with the share of the day it was computed
     from. A percentage without its coverage is the kind of number that
     makes someone buy supplements over a gap in a database.
     --------------------------------------------------------------- */

  function microLinesFor(date) {
    return Store.entriesFor(date).map(function (e) {
      var f = e.foodId ? Store.food(e.foodId) : null;
      return { kcal: e.kcal, qty: e.qty, micros: f && f.micros ? f.micros : null };
    });
  }

  function renderMicroRow(r) {
    var v = Micros.verdict(r);
    var pct = r.percent === null ? null : Math.round(r.percent);
    var amt = r.amount === null ? '—'
      : fmt(r.amount, r.amount < 10 ? 1 : 0) + ' ' + (r.unit === 'ug' ? '\u00b5g' : r.unit);
    var width = pct === null ? 0 : Math.max(0, Math.min(100, pct));

    return '<div class="micro-row ' + esc(v) + '">' +
      '<span class="mname">' + esc(r.label) + '</span>' +
      '<span class="mamt">' + esc(amt) + '</span>' +
      '<span class="micro-track"><i style="width:' + width + '%"></i></span>' +
      '<span class="mpct">' + (pct === null ? '' : pct + '%') + '</span>' +
      '</div>';
  }

  function renderMicros() {
    if (typeof Micros === 'undefined') return;

    var data, days = 1;
    if (microView === 'today') {
      data = Micros.totals(microLinesFor(day));
    } else {
      var perDay = [];
      for (var i = 13; i >= 0; i--) perDay.push(Micros.totals(microLinesFor(WL.addDays(day, -i))));
      data = Micros.average(perDay);
      days = data.days;
    }

    var rows = data.rows || [];
    if (!rows.length || (microView === 'today' && !data.kcalTotal)) {
      $('microBody').innerHTML = '<p class="empty">Nothing logged yet.</p>';
      $('microCoverage').textContent = '';
      return;
    }

    /* The headline sentence. It leads with coverage on purpose: it is
       the number that decides whether any of the others mean anything. */
    var cov = data.coverage;
    if (cov === null) {
      $('microCoverage').textContent = '';
    } else if (microView === 'today') {
      $('microCoverage').textContent = Math.round(cov) + '% of today\u2019s calories came from foods ' +
        'that report micronutrients' +
        (cov < 60 ? '. Below about 60% these figures are a floor, not a measurement \u2014 ' +
          'look foods up rather than typing them and the coverage climbs.' : '.');
    } else {
      $('microCoverage').textContent = 'Averaged over ' + days + ' logged day' +
        (days === 1 ? '' : 's') + '. ' + Math.round(cov) + '% of those calories report micronutrients.';
    }

    function section(title, group, note) {
      var list = rows.filter(function (r) { return r.group === group; });
      if (!list.length) return '';
      return '<div class="micro-head">' + esc(title) + '</div>' +
        (note ? '<div class="hint" style="margin:0 0 var(--s-2)">' + esc(note) + '</div>' : '') +
        list.map(renderMicroRow).join('');
    }

    $('microBody').innerHTML =
      section('Day to day', 'daily') +
      section('Worth watching over weeks', 'watch',
        microView === 'today'
          ? 'One day says little about any of these. The 14-day view is the one to read.'
          : '') +
      '<div class="hint">Against the FDA Daily Values printed on packets \u2014 a general adult ' +
      'reference, not a prescription. Total sugars has no percentage because the Daily Value ' +
      'is for added sugar, and scoring one against the other would mark fruit as a failure.</div>';
  }

  /* ---------------------------------------------------------------
     FOODS / HABITS
     --------------------------------------------------------------- */

  function renderFoods() {
    var isRecipe = libKind === 'recipe';
    var all = Store.foods().filter(function (f) {
      return (f.kind || 'food') === libKind;
    });

    $('libTitle').innerHTML = (isRecipe ? 'Your recipes (' : 'Your foods (') +
      '<span id="foodCount">' + all.length + '</span>)';
    $('nfTitle').textContent = isRecipe ? 'Add a recipe' : 'Add a food';
    $('nfServingsRow').hidden = !isRecipe;
    /* A packaged food is found by barcode; a recipe is found by its
       link. Offering the link box on the Foods tab would be offering a
       route that mostly does not exist there. */
    $('recipeImport').hidden = !isRecipe;
    $('foodFilter').placeholder = isRecipe ? 'Filter by name' : 'Filter by name';

    /* Chips come from what is tagged within THIS tab. Offering a tag
       that only exists on recipes while looking at foods is a filter
       that can only ever return nothing. */
    var counts = {};
    all.forEach(function (f) {
      (f.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : 1);
    });
    if (tagFilter && !counts[tagFilter]) tagFilter = null;

    $('tagFilter').innerHTML = tags.map(function (t) {
      return '<button class="chip" data-tag="' + esc(t) + '" aria-pressed="' +
        (tagFilter === t) + '">' + esc(t) + '<span class="n">' + counts[t] + '</span></button>';
    }).join('');

    var q = foodFilterText.toLowerCase();
    var shown = all.filter(function (f) {
      if (tagFilter && (f.tags || []).indexOf(tagFilter) < 0) return false;
      if (q && f.name.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });

    $('foodLibrary').innerHTML = shown.length ? shown.map(function (f) {
      var t = WL.lineTotals({ kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, qty: 1 });
      var sub = [];
      if (f.serving) sub.push(f.serving);
      if (isRecipe && f.servings) sub.push('makes ' + fmt(f.servings));
      sub.push(fmt(t.protein) + 'p ' + fmt(t.carbs) + 'c ' + fmt(t.fat) + 'f');
      return '<li><span class="name"><b>' + esc(f.name) + '</b><small>' + esc(sub.join('  ·  ')) +
        '</small>' + ((f.tags || []).length
          ? '<small class="tags">' + esc(f.tags.join(' · ')) + '</small>' : '') +
        '</span><span class="kcal">' + fmt(t.kcal) + '</span>' +
        '<button class="btn ghost" data-food-rm="' + esc(f.id) + '" aria-label="Delete">&times;</button></li>';
    }).join('') : '<li><span class="empty" style="flex:1">' +
      (q || tagFilter ? 'Nothing matches.'
        : isRecipe
          ? 'No recipes yet. A recipe is something you assembled — save it once with what one serving costs.'
          : 'Your library is empty. Add the ten things you eat most and you are basically done.') +
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
    renderLiveSession(D);

    var list = Store.workoutsFor(day);
    var stepRec = Store.stepsOn(day);

    if (document.activeElement !== $('stepsInput')) {
      $('stepsInput').value = (stepRec && stepRec.steps) ? stepRec.steps : '';
    }
    if (!D.hasWeight) {
      $('stepsHint').textContent = 'Log a weight first \u2014 step calories depend on what you are carrying.';
    } else if (stepRec && stepRec.steps) {
      $('stepsHint').textContent = fmt(stepRec.steps) + ' steps \u2248 ' +
        fmt(WL.stepsKcal(stepRec.steps, D.profile)) + ' cal, worked out from your weight and height.';
    } else {
      $('stepsHint').textContent = 'One number for the whole day. Saving again replaces it rather than adding to it.';
    }

    var sessions = list.filter(function (w) { return w.kind !== 'steps'; });
    $('workoutLog').innerHTML = list.map(function (w) {
      var kc = WL.workoutKcal(w, D.profile);
      var sub = [];
      if (w.kind === 'steps') sub.push(fmt(w.steps) + ' steps');
      else {
        if (w.activity && ACTIVITY_LABEL[w.activity] && w.name) sub.push(ACTIVITY_LABEL[w.activity]);
        if (w.minutes) sub.push(fmt(w.minutes) + ' min');
        var done = countDone(w);
        if (done.total) sub.push(done.done + ' of ' + done.total + ' sets');
        var vol = sessionVolume(w);
        if (vol) sub.push(fmt(vol) + ' lb moved');
      }
      if (typeof w.kcal === 'number' && w.kcal > 0) sub.push('entered by hand');
      return '<li><span class="name"><b>' + esc(workoutLabel(w)) + '</b>' +
        (sub.length ? '<small>' + esc(sub.join('  \u00b7  ')) + '</small>' : '') + '</span>' +
        '<span class="kcal">' + fmt(kc) + '</span>' +
        '<button class="btn ghost" data-wo-rm="' + esc(w.id) + '" aria-label="Remove">&times;</button></li>';
    }).join('') ||
      '<li><span class="empty" style="flex:1">Nothing logged for this day.</span></li>';

    var t = D.training;
    $('trainStats').innerHTML = [
      { k: 'Worked off', v: D.hasWeight ? fmt(t.gross) : '\u2014', n: 'net calories' },
      { k: 'Added to today', v: D.hasWeight ? '+' + fmt(t.credit) : '\u2014', n: 'half of it' },
      { k: 'Sessions', v: String(sessions.length), n: stepRec ? 'plus steps' : '' },
      { k: 'Eat up to', v: D.hasWeight ? fmt(D.target.target + t.credit) : '\u2014', n: 'cal today' }
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + esc(x.k) + '</div><div class="v">' + esc(x.v) +
        '</div><div class="n">' + esc(x.n || '') + '</div></div>';
    }).join('');

    $('trainNote').textContent = 'Every number here is net \u2014 what the activity cost above sitting ' +
      'still for the same minutes, because your measured burn already counts the sitting. ' +
      'Half of it comes back as food.';

    $('trainToday').hidden = trainView !== 'today';
    $('trainWorkouts').hidden = trainView !== 'workouts';
    $('trainExercises').hidden = trainView !== 'exercises';

    if (trainView === 'workouts') renderWorkoutTemplates();
    if (trainView === 'exercises') renderExerciseIndex();
  }

  /* What the progression model says about an exercise, given the
     prescription in front of you. Returns null when there is nothing
     worth saying rather than a placeholder — a coach that speaks on
     every rep is a coach nobody reads. */
  function adviceFor(exId, pres) {
    if (!Gym.ready()) return null;
    var ex = Gym.byId(exId);
    if (!ex) return null;
    return Progress.recommend({
      history: Store.exerciseHistory(exId),
      pres: pres,
      loads: Gym.selectableLoads(ex),
      tracking: ex.tracking_mode,
      bodyweight: !(ex.equipment || []).length
    });
  }

  var ADVICE_LABEL = {
    increase: 'Go up', add_reps: 'More reps', reduce: 'Back off',
    hold: 'Repeat', establish: 'First time', progress_variation: 'Harder variation'
  };

  function countDone(w) {
    var rows = Array.isArray(w.sets) ? w.sets : [];
    var structured = rows.filter(function (r) { return r && r.ex; });
    return { total: structured.length,
             done: structured.filter(function (r) { return r.done; }).length };
  }

  /* Total external load moved in a session. Zero for bodyweight work,
     which is honest: this measures external load, not effort. */
  function sessionVolume(w) {
    var rows = Array.isArray(w.sets) ? w.sets : [];
    var v = 0;
    rows.forEach(function (r) {
      if (r && r.done && r.load > 0 && r.reps > 0) v += r.load * r.reps;
    });
    if (!v) v = WL.setsVolume(rows);   /* older free-text rows */
    return Math.round(v);
  }

  /* ---------------------------------------------------------------
     THE LIVE SESSION

     One card, one tap per set. The interaction being optimised is the
     one performed forty times in an hour with a phone in one hand;
     everything else on this tab can afford to be a screen, this cannot.
     --------------------------------------------------------------- */

  function renderLiveSession(D) {
    var w = Store.openSession(day);
    $('liveCard').hidden = !w;
    if (!w) return;

    $('liveName').textContent = w.name || 'Workout';
    var c = countDone(w);
    $('liveProgress').textContent = c.done + ' / ' + c.total;

    var rows = w.sets || [];
    var html = '', lastEx = null;
    rows.forEach(function (r, i) {
      if (r.ex !== lastEx) {
        var ex = Gym.ready() ? Gym.byId(r.ex) : null;
        var note = ex ? Gym.loadNote(ex) : '';
        var adv = adviceFor(r.ex, { min: r.targetMin, max: r.targetMax, rir: r.rirTarget });
        html += '<div class="exhead"><b>' + esc(r.name) + '</b>' +
          (adv ? '<span class="advice ' + esc(adv.action) + '">' +
             esc(ADVICE_LABEL[adv.action] || adv.action) +
             (adv.load ? ' \u00b7 ' + fmt(adv.load) + ' lb' : '') + '</span>' +
             '<small>' + esc(adv.why) + '</small>' : '') +
          (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
        lastEx = r.ex;
      }
      var target = r.targetMin === r.targetMax ? String(r.targetMin)
        : r.targetMin + '\u2013' + r.targetMax;
      var unit = r.unit === 'reps' ? '' : ' ' + r.unit;
      html += '<div class="setrow' + (r.done ? ' done' : '') + '" data-set="' + i + '">' +
        '<span class="n">' + r.idx + '</span>' +
        '<span class="prescribed">' + esc(target + unit) +
          (r.rirTarget !== null && r.rirTarget !== undefined ? ' @ ' + r.rirTarget + ' RIR' : '') +
          (r.scope === 'per_side' ? ' each side' : '') + '</span>' +
        (r.done
          ? '<span class="actual">' + (r.load ? fmt(r.load) + ' lb \u00d7 ' : '') + fmt(r.reps) +
            (r.rir !== null && r.rir !== undefined ? ' @ ' + fmt(r.rir) : '') + '</span>'
          : '<span class="actual todo">\u2014</span>') +
        '<button class="btn ghost grow-0" data-logset="' + i + '">' +
          (r.done ? 'Edit' : 'Log') + '</button>' +
        '</div>';
    });
    $('liveSets').innerHTML = html;

    if (document.activeElement !== $('liveMinutes')) {
      $('liveMinutes').value = w.minutes || '';
    }
    $('liveHint').textContent = c.done === c.total && c.total
      ? 'All sets logged. Add the minutes and finish.'
      : 'Log each set as you finish it. Closing the app does not lose the workout.';
  }

  /* ---------------------------------------------------------------
     WORKOUT TEMPLATES
     --------------------------------------------------------------- */

  /* ---------------------------------------------------------------
     WORKOUTS AND PROGRAMS

     A workout is a list of exercises. A program is a list of workouts
     against days. The catalog ships both as read-only seeds: copying
     one gives you an editable plan of your own and leaves the original
     alone, so a later catalog update can never quietly rewrite
     something you changed.
     --------------------------------------------------------------- */

  function planItemLine(it) {
    var t = it.min === it.max ? String(it.min) : it.min + '\u2013' + it.max;
    var bits = [it.sets + ' \u00d7 ' + t + (it.unit === 'reps' ? '' : ' ' + it.unit)];
    if (it.rir !== null && it.rir !== undefined) bits.push(it.rir + ' RIR');
    if (it.scope === 'per_side') bits.push('each side');
    return bits.join('  \u00b7  ');
  }

  function renderWorkoutTemplates() {
    $('planListTitle').textContent = planKind === 'program' ? 'Your programs' : 'Your workouts';
    $('catalogTitle').textContent = planKind === 'program'
      ? 'Programs from the catalog' : 'Workouts from the catalog';

    var mine = Store.plans(planKind);
    $('planList').innerHTML = mine.length ? mine.map(function (p) {
      var sub = planKind === 'program'
        ? (p.schedule || []).length + ' days'
        : (p.items || []).length + ' exercises';
      return '<li><button class="rowedit" data-plan-open="' + esc(p.id) + '">' +
        '<span class="name"><b>' + esc(p.name) + '</b><small>' + esc(sub) + '</small></span>' +
        '</button>' +
        (planKind === 'workout'
          ? '<button class="btn ghost grow-0" data-plan-start="' + esc(p.id) + '">Start</button>'
          : '') + '</li>';
    }).join('') : '<li><span class="empty" style="flex:1">' +
      (planKind === 'program'
        ? 'No programs yet. A program schedules your workouts across a week.'
        : 'No workouts of your own yet. Build one, or copy a catalog session below.') +
      '</span></li>';

    if (!Gym.ready()) {
      $('sessionList').innerHTML = '<li><span class="empty" style="flex:1">' +
        esc(gymError || 'Loading the catalog\u2026') + '</span></li>';
      $('programList').innerHTML = '';
      renderPlanEditor();
      return;
    }

    if (planKind === 'workout') {
      $('sessionList').hidden = false;
      $('programList').innerHTML = '';
      $('sessionList').innerHTML = Gym.sessions().map(function (se) {
        var mins = se.estimated_minutes || [];
        var sub = [];
        if (mins.length === 2) sub.push(mins[0] + '\u2013' + mins[1] + ' min');
        sub.push(se.items.length + ' exercises');
        return '<li><button class="rowedit" data-start="' + esc(se.id) + '">' +
          '<span class="name"><b>' + esc(se.name) + '</b><small>' + esc(sub.join('  \u00b7  ')) +
          '</small></span><span class="kcal">Start</span></button>' +
          '<button class="btn ghost grow-0" data-copy="' + esc(se.id) + '">Copy</button></li>';
      }).join('');
    } else {
      $('sessionList').innerHTML = '';
      $('programList').innerHTML = Gym.programs().map(function (p) {
        var days = p.schedule.map(function (d) {
          var se = Gym.sessions().filter(function (x) { return x.id === d.session_id; })[0];
          return 'Day ' + d.day + ': ' + (se ? se.name : d.session_id);
        });
        return '<div style="margin-bottom:var(--s-5)">' +
          '<div class="habit" style="border:0;padding:0 0 var(--s-1)">' +
          '<span class="name">' + esc(p.name) + '</span>' +
          '<button class="btn ghost grow-0" data-copy-prog="' + esc(p.id) + '">Copy</button></div>' +
          '<div class="hint" style="margin:0">' + esc(days.join(' \u00b7 ')) + '</div>' +
          '<div class="hint">' + esc(p.notes || '') + '</div></div>';
      }).join('');
    }
    renderPlanEditor();
  }

  function renderPlanEditor() {
    var e = editing_plan;
    $('planEdit').hidden = !e;
    if (!e) return;

    $('peTitle').textContent = e.id ? 'Edit' : (e.kind === 'program' ? 'New program' : 'New workout');
    if (document.activeElement !== $('peName')) $('peName').value = e.name || '';
    $('peItemsWrap').hidden = e.kind !== 'workout';
    $('peDaysWrap').hidden = e.kind !== 'program';
    $('peDelete').hidden = !e.id;

    if (e.kind === 'workout') {
      $('peItems').innerHTML = (e.items || []).map(function (it, i) {
        return '<li><span class="name"><b>' + esc(it.name) + '</b><small>' +
          esc(planItemLine(it)) + '</small></span>' +
          '<button class="btn ghost grow-0" data-item-up="' + i + '" aria-label="Up">\u2191</button>' +
          '<button class="btn ghost grow-0" data-item-edit="' + i + '">Edit</button>' +
          '<button class="btn ghost grow-0" data-item-rm="' + i + '" aria-label="Remove">&times;</button></li>';
      }).join('') || '<li><span class="empty" style="flex:1">No exercises yet. Search below to ' +
        'add one.</span></li>';

      if (peSearch && Gym.ready()) {
        var r = Gym.search(peSearch, { equipmentOnly: true });
        $('peAddResults').innerHTML = r.primary.slice(0, 12).map(function (x) {
          return '<li><button class="rowedit" data-add-ex="' + esc(x.id) + '">' +
            '<span class="name"><b>' + esc(x.name) + '</b><small>' +
            esc(String(x.movement_pattern).replace(/_/g, ' ')) + '</small></span>' +
            '<span class="kcal">Add</span></button></li>';
        }).join('') || '<li><span class="empty" style="flex:1">Nothing matches.</span></li>';
      } else {
        $('peAddResults').innerHTML = '';
      }
      $('peHint').textContent = (e.items || []).length
        ? 'A full-body session wants lower-body work, a push and a pull. Across the week, a ' +
          'squat or lunge and a hinge.'
        : '';
    } else {
      var mineW = Store.plans('workout');
      $('peDayPlan').innerHTML = mineW.map(function (w) {
        return '<option value="' + esc(w.id) + '">' + esc(w.name) + '</option>';
      }).join('') || '<option value="">\u2014 build a workout first \u2014</option>';

      $('peDays').innerHTML = (e.schedule || []).slice().sort(function (a, b) {
        return a.day - b.day;
      }).map(function (d, i) {
        var w = Store.plan(d.planId);
        return '<li><span class="name"><b>Day ' + d.day + '</b><small>' +
          esc(w ? w.name : 'this workout was deleted') + '</small></span>' +
          '<button class="btn ghost grow-0" data-day-rm="' + esc(d.day) + '" aria-label="Remove">&times;</button></li>';
      }).join('') || '<li><span class="empty" style="flex:1">No days yet.</span></li>';

      $('peHint').textContent = mineW.length
        ? 'Unlisted days are rest days.'
        : 'Programs schedule your own workouts, so build at least one first.';
    }
  }

  /* ---------------------------------------------------------------
     EXERCISE INDEX
     --------------------------------------------------------------- */

  var QUICK_PARTS = ['chest', 'back', 'shoulders', 'biceps', 'triceps',
                     'quads', 'hamstrings', 'glutes', 'calves', 'core', 'cardio'];

  function exRow(e) {
    var sub = [];
    sub.push(String(e.movement_pattern || '').replace(/_/g, ' '));
    sub.push((e.equipment && e.equipment.length)
      ? e.equipment.map(function (q) { return q.replace(/_/g, ' '); }).join(', ')
      : 'bodyweight');
    return '<li><button class="rowedit" data-ex="' + esc(e.id) + '">' +
      '<span class="name"><b>' + esc(e.name) + '</b><small>' + esc(sub.join('  \u00b7  ')) +
      '</small></span><span class="kcal">' + esc(e.difficulty.slice(0, 3)) + '</span></button></li>';
  }

  function renderExerciseIndex() {
    if (!Gym.ready()) {
      $('exStatus').textContent = gymError || 'Loading the catalog\u2026';
      $('exResults').innerHTML = '';
      $('exQuick').innerHTML = '';
      return;
    }
    $('exQuick').innerHTML = QUICK_PARTS.map(function (p) {
      return '<button class="chip" data-part="' + esc(p) + '" aria-pressed="' +
        (exQuery === p) + '">' + esc(p) + '</button>';
    }).join('');

    var r = Gym.search(exQuery, { equipmentOnly: true });
    $('exResults').innerHTML = r.primary.map(function (e) { return exRow(e); }).join('') ||
      '<li><span class="empty" style="flex:1">Nothing matches. Try a body part, a movement ' +
      'like \u201chinge\u201d, or a piece of kit like \u201cdumbbell\u201d.</span></li>';

    $('exSecondaryWrap').hidden = !r.secondary.length;
    $('exSecondary').innerHTML = r.secondary.map(function (e) { return exRow(e); }).join('');

    $('exStatus').textContent = !exQuery
      ? Gym.exercises().length + ' exercises, all of them possible with your kit.'
      : r.mode === 'muscle'
        ? r.primary.length + ' train this directly' +
          (r.secondary.length ? ', ' + r.secondary.length + ' involve it' : '')
        : r.primary.length + ' match \u201c' + exQuery + '\u201d';

    renderExerciseDetail();
  }

  function renderExerciseDetail() {
    var e = exOpenId && Gym.ready() ? Gym.byId(exOpenId) : null;
    $('exDetail').hidden = !e;
    if (!e) return;

    $('exdName').textContent = e.name;
    $('exdMeta').textContent = [
      String(e.movement_pattern).replace(/_/g, ' '),
      e.mechanic, e.laterality, e.difficulty,
      (e.equipment && e.equipment.length
        ? e.equipment.map(function (q) { return q.replace(/_/g, ' '); }).join(', ')
        : 'bodyweight')
    ].join('  \u00b7  ');

    function block(title, arr) {
      if (!arr || !arr.length) return '';
      return '<div style="margin-top:var(--s-3)"><div style="font-size:0.6875rem;' +
        'letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted)">' + esc(title) +
        '</div><ul style="margin:var(--s-1) 0 0;padding-left:1.1em;font-size:0.875rem">' +
        arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    }

    var muscles = (e.primary_muscles || []).map(function (m) { return m.replace(/_/g, ' '); });
    var also = (e.secondary_muscles || []).map(function (m) { return m.replace(/_/g, ' '); });

    var subs = Gym.substitutes(e.id);
    var same = subs.filter(function (x) { return x.samePattern; });
    var partial = subs.filter(function (x) { return !x.samePattern; });

    var html = block('Works', muscles) + block('Also', also) +
      block('Setup', e.setup) + block('Cues', e.cues) +
      block('Watch for', e.contraindication_notes);

    if (same.length) {
      html += '<div style="margin-top:var(--s-3)"><div style="font-size:0.6875rem;' +
        'letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted)">Swap for</div>' +
        same.map(function (x) {
          return '<button class="chip" data-ex="' + esc(x.exercise.id) + '" ' +
            'style="margin:var(--s-2) var(--s-2) 0 0">' + esc(x.exercise.name) + '</button>';
        }).join('') + '</div>';
    }
    if (partial.length) {
      /* Named differently on purpose. A bridge does not replace the
         hamstring work in an RDL, and offering it as an equal swap is
         how a program quietly loses a movement. */
      html += '<div class="note" style="margin-top:var(--s-3)">Partial alternatives \u2014 these ' +
        'overlap but do not cover the same work, so check what the session loses: ' +
        partial.map(function (x) { return esc(x.exercise.name); }).join(', ') + '.</div>';
    }

    var loads = Gym.selectableLoads(e);
    if (loads.length) {
      html += '<div class="hint">Loads you can actually select: ' +
        esc(loads.slice(0, 12).join(', ')) + (loads.length > 12 ? '\u2026' : '') + ' lb.</div>';
    }
    var note = Gym.loadNote(e);
    if (note) html += '<div class="hint">' + esc(note) + '</div>';

    var hist = Store.exerciseHistory(e.id, 3);
    if (hist.length) {
      html += '<div class="hint">Last: ' + hist.map(function (h) {
        return (h.load ? fmt(h.load) + '\u00d7' : '') + fmt(h.reps) +
          (h.rir !== null && h.rir !== undefined ? ' @' + fmt(h.rir) : '');
      }).join(', ') + '</div>';
    }

    var full = Store.exerciseHistory(e.id);
    var est = Progress.currentStrength(full);
    if (est) {
      var n = Progress.countSessions(full);
      html += '<div class="hint">Estimated one-rep max: ' + fmt(est) + ' lb, smoothed across ' +
        n + ' session' + (n === 1 ? '' : 's') +
        '. One set is mostly noise, so this is a trend rather than a reading.</div>';
    }
    var advice = adviceFor(e.id, { min: 8, max: 12, rir: 3 });
    if (advice && advice.action !== 'establish') {
      html += '<div class="note plain">Next time, at 8-12 reps and 3 RIR: ' +
        esc(advice.why) + ' (' + esc(advice.confidence) + ' confidence)</div>';
    }

    $('exdBody').innerHTML = html;
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
      sub.push(r.source === 'library'
        ? (r.kind === 'recipe' ? 'Your recipe' : 'Your food')
        : (r.source === 'usda' ? 'USDA' : 'Open Food Facts'));
      /* USDA lab foods publish macros and no calorie figure. Saying so
         is the difference between a number you trust and one you don't. */
      if (r.kcalDerived) sub.push('cal from macros');
      return '<li style="padding:0"><button class="result" data-pick="' + i + '">' +
        '<span class="name"><b>' + esc(r.name) + '</b><small>' + esc(sub.join('  ·  ')) +
        '</small></span><span class="kcal">' + fmt(r.kcal) + '</span></button></li>';
    }).join('');
  }

  function setLookup(status, results, source) {
    lookup.open = true;
    lookup.status = status || '';
    lookup.results = results || [];
    /* Who opened this list: 'typing' for as-you-type suggestions,
       undefined for a search or a scan the person asked for. Only the
       first kind gets closed automatically. */
    lookup.source = source || null;
    renderLookup();
  }

  function closeLookup() {
    lookup.open = false; lookup.results = []; lookup.status = ''; lookup.source = null;
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

  /* ---------------------------------------------------------------
     THE AMOUNT EDITOR

     One control, the same one as the main food row: a number and a
     unit.

     It used to be a grams box with no unit beside it, which meant
     anything looked up from USDA — and USDA states everything per
     100 g — opened at 100 g and could not be moved off grams at all.
     Eat four ounces of chicken and you had to do the conversion in
     your head, which is the arithmetic this app exists to do.
     --------------------------------------------------------------- */

  var feUnitChoice = 'serving';

  function feBase() { return editing ? editing.base : null; }

  function round0(v) { return (v === null || v === undefined) ? null : Math.round(v); }
  function round1(v) { return (v === null || v === undefined) ? null : Math.round(v * 10) / 10; }

  function feRenderUnits() {
    var b = feBase();
    if (ALL_UNITS.indexOf(feUnitChoice) < 0) feUnitChoice = 'serving';
    $('feUnit').innerHTML = ALL_UNITS.map(function (u) {
      var known = !b || Units.servingsPerUnit(b, u) !== null;
      return '<option value="' + u + '"' + (u === feUnitChoice ? ' selected' : '') + '>' +
        esc(Units.label(u)) + (known ? '' : ' \u2026') + '</option>';
    }).join('');

    var needs = (b && Units.servingsPerUnit(b, feUnitChoice) === null) ? feUnitChoice : null;
    $('feLearn').hidden = !needs;
    if (needs) {
      var asMass = (needs === 'g' || needs === 'oz');
      $('feLearnLabel').textContent = asMass
        ? 'One serving weighs, in grams' : 'One serving is, in cups';
      $('feLearnValue').value = '';
      $('feLearnValue').placeholder = asMass ? '226' : '0.5';
    }
  }

  /* Scale the source figures to the amount showing. They stay editable
     afterwards: the numbers are a starting point, and a label that
     disagrees with a database is the label's problem, not yours. */
  function feRecompute() {
    var b = feBase();
    if (!b) return;
    var servings = Units.toServings($('feAmount').value, feUnitChoice, b);
    if (servings === null) return;
    function s(v) { return (v === null || v === undefined) ? null : v * servings; }
    feSet('feKcal', round0(s(b.kcal)));
    feSet('feP', round1(s(b.protein)));
    feSet('feC', round1(s(b.carbs)));
    feSet('feF', round1(s(b.fat)));
  }

  function feLearnBasis() {
    var b = feBase();
    if (!b) return;
    var v = Units.parseAmount($('feLearnValue').value);
    if (v === null || v <= 0) { $('feLearnValue').focus(); return; }
    var asMass = (feUnitChoice === 'g' || feUnitChoice === 'oz');
    var label = String(b.serving || '').trim();
    var addition = asMass ? v + ' g' : v + ' cup';
    /* The working copy only. Nothing is saved until Log it, and a
       serving weight learned for a food that is then cancelled should
       not outlive the cancel. */
    b.serving = label ? label + ' (' + addition + ')' : addition;
    if (asMass) b.servingGrams = v;
    feRenderUnits();
    feRecompute();
    $('feAmount').focus();
  }

  function openFoodEditForResult(rec) {
    var b = {
      name: rec.name, serving: rec.serving, servingGrams: rec.servingGrams || null,
      kcal: rec.kcal, protein: rec.protein, carbs: rec.carbs, fat: rec.fat,
      micros: rec.micros || null
    };
    editing = { mode: 'new', rec: rec, base: b };
    feUnitChoice = Units.basisFor(b).mass ? 'g' : 'serving';

    $('feTitle').textContent = rec.name;
    $('feAmount').value = feUnitChoice === 'g'
      ? String(Math.round(Units.basisFor(b).mass))
      : String(Units.parseAmount($('foodAmount').value) || 1);

    feRenderUnits();
    feRecompute();

    $('feSave').textContent = 'Log it';
    $('feHint').textContent = 'Stated as ' + (rec.serving || '1 serving') +
      '. Change the amount or the unit and the numbers follow \u2014 or type over any of them.' +
      (rec.micros ? ' Micronutrients came with it.' : '');
    $('foodEdit').hidden = false;
    revealFoodEdit();
    $('feAmount').focus();
    $('feAmount').select();
  }

  function openFoodEditForEntry(id) {
    var e = Store.entry(id);
    if (!e) return;
    /* The food behind the line is what knows how to convert units. A
       quick add has none, so it stays in servings — which is honest:
       nobody weighed it. */
    var f = e.foodId ? Store.food(e.foodId) : null;
    editing = {
      mode: 'entry', id: id,
      base: {
        name: e.name, serving: f ? f.serving : '', servingGrams: null,
        kcal: e.kcal, protein: e.protein, carbs: e.carbs, fat: e.fat,
        micros: f ? f.micros : null
      }
    };
    feUnitChoice = e.unit || 'serving';
    $('feTitle').textContent = e.name || 'Logged food';
    $('feAmount').value = String(
      (typeof e.amount === 'number' && e.amount > 0) ? e.amount
        : (typeof e.qty === 'number' ? e.qty : 1));

    feRenderUnits();
    feRecompute();

    $('feSave').textContent = 'Save';
    $('feHint').textContent = 'Change the amount or the unit and the numbers follow. ' +
      'Type over any of them to correct what was logged.';
    $('foodEdit').hidden = false;
    lookup.open = false; renderLookup();
    revealFoodEdit();
    $('feAmount').focus();
    $('feAmount').select();
  }

  /* Opened from a row further up the log, the panel can land off-screen
     behind the keyboard — you tap a line and nothing appears to happen. */
  function revealFoodEdit() {
    try { $('foodEdit').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (e) { $('foodEdit').scrollIntoView(); }
  }

  function closeFoodEdit() {
    editing = null;
    $('foodEdit').hidden = true;
  }

  function saveFoodEdit() {
    if (!editing) return;
    var b = editing.base;

    /* The macro boxes show the numbers for the amount on screen, not
       for one serving. So whatever is in them — computed or typed over
       — divides back down before anything is stored, and the library
       keeps one canonical per-serving record however much was eaten.

       That is what retires the old duplicate-food problem: eating 150 g
       of chicken used to create a SECOND library entry called "Chicken
       breast (150 g)" beside the first, because the food record was the
       only place an amount could live. The entry carries the amount
       now, so the library holds foods and the log holds meals. */
    var amount = Units.parseAmount($('feAmount').value);
    if (amount === null || amount <= 0) amount = 1;
    var servings = Units.toServings(amount, feUnitChoice, b);
    if (servings === null || servings <= 0) servings = amount;

    var shown = {
      kcal: num($('feKcal')), protein: num($('feP')),
      carbs: num($('feC')), fat: num($('feF'))
    };
    function per(v) { return (v === null || v === undefined) ? null : v / servings; }
    var vals = {
      kcal: per(shown.kcal), protein: per(shown.protein),
      carbs: per(shown.carbs), fat: per(shown.fat)
    };

    if (editing.mode === 'entry') {
      Store.updateEntry(editing.id, {
        qty: servings, amount: amount, unit: feUnitChoice,
        kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
      });
      closeFoodEdit();
      render();
      return;
    }

    var rec = editing.rec;
    /* Keep the gram weight the source stated even when the amount was
       not touched, so the food can be logged in ounces tomorrow. */
    var serving = b.serving;
    if (rec.servingGrams && serving && !Units.basisFor(b).mass) {
      serving = serving + ' (' + Math.round(rec.servingGrams) + ' g)';
    }

    var existing = Store.findFoodByName(b.name);
    var f = Store.addFood({
      id: existing ? existing.id : undefined,
      /* undefined, not null: addFood keeps what it already had when a
         field is absent, and only a real panel should replace one. */
      name: b.name, serving: serving, micros: b.micros || undefined,
      kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
    });

    Store.addEntry(day, {
      foodId: f.id, name: f.name, qty: servings,
      amount: amount, unit: feUnitChoice,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
    });

    $('foodPick').value = '';
    $('foodAmount').value = '1';
    unitChoice = 'serving';
    refreshUnits();
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
    var st0 = Store.settings();
    if (document.activeElement !== $('stWaterGoal')) {
      $('stWaterGoal').value = String(num0(st0.waterGoalOz, 64));
    }
    if (document.activeElement !== $('stStepsShortcut')) {
      $('stStepsShortcut').value = st0.stepsShortcut || '';
    }
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
    setIf('stTargetOverride', (typeof s.targetOverride === 'number') ? s.targetOverride : '');
    $('stAlpha').value = s.alpha;
    $('alphaVal').textContent = Number(s.alpha).toFixed(2);

    /* The USDA key lives in config.js and applies to every device, so
       there is nothing here to configure. The card that used to sit in
       Setup was a control for a decision already made — clutter on the
       one screen that should stay legible. Set FoodAPI.setUsdaKey() from
       the console if a device ever needs its own.

     */
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
    renderWater();
    renderMicros();
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

  /* Navigation.

     The bottom bar holds the three things done daily; Foods, Habits and
     Setup moved behind the header menu. Six tabs across a phone gave
     each one about sixty pixels, and the two that were hardest to hit
     were the ones opened least — a bad trade in both directions.

     One function drives everything, because the same destination is now
     reachable from two places and having each set its own highlighting
     is how they drift apart. */
  function goTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) {
      x.setAttribute('aria-selected', String(x.dataset.tab === name));
    });
    Array.prototype.forEach.call(document.querySelectorAll('#menu button'), function (x) {
      x.setAttribute('aria-current', x.dataset.tab === name ? 'page' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
    closeMenu();
    window.scrollTo(0, 0);
  }

  function openMenu() {
    $('menu').hidden = false;
    $('menuBtn').setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    $('menu').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
  }

  $('menuBtn').addEventListener('click', function (ev) {
    ev.stopPropagation();
    if ($('menu').hidden) openMenu(); else closeMenu();
  });

  $('menu').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-tab]');
    if (b) goTab(b.dataset.tab);
  });

  /* Tapping anywhere else closes it. An open menu covering the screen
     with no obvious way out is the thing people complain about. */
  document.addEventListener('click', function (ev) {
    if ($('menu').hidden) return;
    if (ev.target.closest('#menu') || ev.target.closest('#menuBtn')) return;
    closeMenu();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !$('menu').hidden) closeMenu();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () { goTab(b.dataset.tab); });
  });

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

  /* ---------------------------------------------------------------
     FOOD ENTRY

     One place to type, not two. The name box, an amount, and a unit
     drawn from what the food actually states about itself.

     The unit list is rebuilt whenever the name changes, because it is
     a property of the food and not of the app: a yoghurt sold by the
     cup can be logged in tablespoons, a chicken breast sold by weight
     cannot, and nothing in the world converts between them without a
     density this app was never told. See js/units.js.
     --------------------------------------------------------------- */

  var unitChoice = 'serving';
  var pendingMicros = null;    /* a panel read from a recipe page, awaiting Save */

  function currentFood() {
    return Store.findFoodByName($('foodPick').value.trim());
  }

  /* Every unit is offered, always. An earlier version listed only the
     ones a food could already justify, which was honest and useless:
     most foods are typed in by hand with no serving description at all,
     so the list collapsed to "servings" and stayed there, with nothing
     on screen suggesting a way out.

     Refusing to guess is still the rule. But there is a third option
     between guessing and refusing, and it is the obvious one: ask.
     Choose grams for a food that has never been weighed and it asks
     what one serving weighs, once, and knows from then on. */
  var ALL_UNITS = ['serving', 'g', 'oz', 'cup', 'tbsp', 'tsp'];

  function refreshUnits() {
    var f = currentFood();
    if (ALL_UNITS.indexOf(unitChoice) < 0) unitChoice = 'serving';
    $('foodUnit').innerHTML = ALL_UNITS.map(function (u) {
      /* An ellipsis marks a unit that will ask a question first, so the
         question is not a surprise. */
      var known = !f || Units.servingsPerUnit(f, u) !== null;
      return '<option value="' + u + '"' + (u === unitChoice ? ' selected' : '') + '>' +
        esc(Units.label(u)) + (known ? '' : ' \u2026') + '</option>';
    }).join('');

    var needs = (f && Units.servingsPerUnit(f, unitChoice) === null) ? unitChoice : null;
    $('unitLearn').hidden = !needs;
    $('unitNote').textContent = '';

    if (needs) {
      var asMass = (needs === 'g' || needs === 'oz');
      /* The question names the macros it applies to, because on its own
         it is ambiguous in a way that goes wrong quietly. "One serving
         weighs how much" invites the weight of the tub, or of the
         portion on the label, or of what you just ate — and whichever
         you answer, the app silently declares the stored calories to be
         for THAT weight. Showing the numbers makes the question
         answerable: this many calories, for how many grams? */
      var macro = (f.kcal === null || f.kcal === undefined)
        ? '' : (fmt(f.kcal) + ' cal' +
            (f.protein !== null && f.protein !== undefined
              ? ', ' + fmt(f.protein) + 'p ' + fmt(f.carbs) + 'c ' + fmt(f.fat) + 'f' : ''));
      $('unitLearnLabel').textContent = asMass
        ? (macro ? macro + ' — how many grams is that?' : 'One serving weighs, in grams')
        : (macro ? macro + ' — how many cups is that?' : 'One serving is, in cups');
      $('unitLearnValue').placeholder = asMass ? '226' : '0.5';
      $('unitLearnValue').value = '';
      $('unitNote').textContent = asMass
        ? 'The weight the calories above are for — usually the serving size on the tub. ' +
          'Once it is in, grams and ounces both work.'
        : 'The amount the calories above are for, as a fraction of a cup.';
    } else if (f && !Units.basisFor(f).mass && !Units.basisFor(f).volumeMl) {
      $('unitNote').textContent = f.name + ' has no weight or volume recorded yet. ' +
        'Choose grams or cups above and it will ask for one.';
    }
  }

  /* Fold the answer into the serving text rather than adding a field.
     "1 cup (226 g)" is both a description a person can read and the
     exact form js/units.js already parses, so one string carries the
     label and the basis with no schema change and no migration. */
  function learnUnitBasis() {
    var f = currentFood();
    if (!f) return;
    var v = Units.parseAmount($('unitLearnValue').value);
    if (v === null || v <= 0) { $('unitLearnValue').focus(); return; }

    var asMass = (unitChoice === 'g' || unitChoice === 'oz');
    var label = String(f.serving || '').trim();
    var addition = asMass ? v + ' g' : v + ' cup';
    Store.addFood({
      id: f.id, name: f.name,
      serving: label ? label + ' (' + addition + ')' : addition,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
    });
    refreshUnits();
    $('foodAmount').focus();
  }

  function addFoodLine() {
    var name = $('foodPick').value.trim();
    if (!name) { $('foodPick').focus(); return; }

    var f = Store.findFoodByName(name);
    if (!f) {
      $('inlineName').textContent = name;
      $('inlineNew').hidden = false;
      ['inServing', 'inKcal', 'inP', 'inC', 'inF'].forEach(function (id) { $(id).value = ''; });
      $('inKcal').focus();
      return;
    }

    var unit = $('foodUnit').value || 'serving';
    var amount = Units.parseAmount($('foodAmount').value);
    if (amount === null || amount <= 0) { $('foodAmount').focus(); return; }

    var qty = Units.toServings(amount, unit, f);
    if (qty === null) {
      /* Should be unreachable, since the list only offers convertible
         units. Unreachable is not the same as impossible. */
      $('unitNote').textContent = 'That food cannot be measured in ' + Units.label(unit) + '.';
      return;
    }

    Store.addEntry(day, {
      foodId: f.id, name: f.name, qty: qty,
      amount: amount, unit: unit,
      kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
    });
    $('foodPick').value = ''; $('foodAmount').value = '1';
    unitChoice = 'serving';
    refreshUnits();
    $('inlineNew').hidden = true;
    closeLookup();
    render();
  }
  $('addFoodLine').addEventListener('click', addFoodLine);
  $('foodUnit').addEventListener('change', function () {
    unitChoice = $('foodUnit').value;
    refreshUnits();
  });
  $('unitLearnSave').addEventListener('click', learnUnitBasis);
  $('unitLearnValue').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); learnUnitBasis(); }
  });
  $('foodPick').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); addFoodLine(); }
  });

  /* Suggestions as you type, from your own library.

     There has always been a <datalist> behind this box, and on a phone
     it may as well not exist: iOS renders it as a cramped dropdown and
     matches only from the START of the name, so a recipe called
     "Slow cooker chicken tikka masala" is invisible to anyone typing
     "tikka" — which is what a person types. A recipe you saved and
     cannot find is worse than one you never saved.

     So the matches are drawn properly, in the same list the lookup
     uses, ranked with recipes first. The datalist stays for desktop
     browsers, where it works fine and costs nothing. */
  $('foodPick').addEventListener('input', function () {
    var q = $('foodPick').value.trim();
    refreshUnits();
    if (q.length < 2) {
      /* Only close a list we opened ourselves. Closing one full of USDA
         results because a letter was deleted would be maddening. */
      if (lookup.source === 'typing') closeLookup();
      return;
    }
    var mine = libraryResults(q);
    if (!mine.length) {
      if (lookup.source === 'typing') closeLookup();
      return;
    }
    refreshUnits();
    setLookup('From your library — tap one to log it. "Look it up" searches USDA.',
      mine, 'typing');
  });

  /* Two ways out of the new-food panel, because there are two things
     people mean by "I ate this".

       Save & log it   it joins the library and autocompletes forever
       Log once        a restaurant plate, someone's birthday cake:
                       the calories count today and nothing is kept

     The second is what the old quick-add box did, in the one place
     where the question is already being asked. */
  function finishNew(save) {
    var name = $('inlineName').textContent;
    var vals = {
      kcal: num($('inKcal')), protein: num($('inP')),
      carbs: num($('inC')), fat: num($('inF'))
    };
    if (vals.kcal === null && vals.protein === null && vals.carbs === null && vals.fat === null) {
      $('inKcal').focus();
      return;
    }
    var amount = Units.parseAmount($('foodAmount').value);
    if (amount === null || amount <= 0) amount = 1;

    if (save) {
      var f = Store.addFood({
        /* Whatever they said a serving is. Blank is fine and costs
           nothing now, because the unit picker asks when it needs to —
           but every food saved with a blank serving used to be stuck on
           servings forever, which is how cottage cheese ended up
           impossible to log in ounces. */
        name: name, serving: $('inServing').value.trim(),
        kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
      });
      Store.addEntry(day, {
        foodId: f.id, name: f.name, qty: amount, amount: amount, unit: 'serving',
        kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
      });
    } else {
      /* No foodId: nothing to point at, because nothing was kept. */
      Store.addEntry(day, {
        name: name, qty: amount, amount: amount, unit: 'serving',
        kcal: vals.kcal, protein: vals.protein, carbs: vals.carbs, fat: vals.fat
      });
    }

    ['inServing', 'inKcal', 'inP', 'inC', 'inF'].forEach(function (id) { $(id).value = ''; });
    $('inlineNew').hidden = true;
    $('foodPick').value = ''; $('foodAmount').value = '1';
    unitChoice = 'serving';
    refreshUnits();
    closeLookup();
    render();
  }

  $('inSave').addEventListener('click', function () { finishNew(true); });
  $('inOnce').addEventListener('click', function () { finishNew(false); });
  $('inCancel').addEventListener('click', function () { $('inlineNew').hidden = true; });

  /* Typing macros by hand gets calories and nothing else: no vitamins,
     no minerals, and a food that drags the micronutrient coverage down
     every time it is eaten. Both routes that bring a full panel with
     them belong right here, where the choice is actually made. */
  $('inLookup').addEventListener('click', function () {
    $('inlineNew').hidden = true;
    $('foodPick').value = $('inlineName').textContent;
    $('searchOnline').click();
  });
  $('inScan').addEventListener('click', function () {
    $('inlineNew').hidden = true;
    openScanner();
  });
  $('inlineNew').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); finishNew(true); }
  });


  $('foodLog').addEventListener('click', function (ev) {
    var rm = ev.target.closest('[data-rm]');
    if (rm) { Store.removeEntry(rm.dataset.rm); render(); return; }
    var ed = ev.target.closest('[data-edit]');
    if (ed) openFoodEditForEntry(ed.dataset.edit);
  });

  /* train */
  var workoutKind = 'cardio';

  /* The catalog is 59KB and only the Train tab needs it, so it is
     fetched the first time that tab is opened rather than on launch.
     A failure is shown, not swallowed: an empty exercise list with no
     explanation reads as a broken app. */
  function ensureGym() {
    if (Gym.ready()) return Promise.resolve(true);
    return Gym.load().then(function () {
      gymError = '';
      render();
      return true;
    }).catch(function (e) {
      gymError = String(e.message || e) + ' Reload once while online and it will be cached.';
      render();
      return false;
    });
  }

  $('trainSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-train]');
    if (!b) return;
    trainView = b.dataset.train;
    Array.prototype.forEach.call($('trainSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    if (trainView !== 'today') ensureGym();
    render();
    window.scrollTo(0, 0);
  });

  /* ---- custom workouts and programs ---- */

  function defaultItemFor(ex) {
    return {
      ex: ex.id, name: ex.name, sets: 3,
      min: 8, max: 12, unit: ex.tracking_mode || 'reps',
      scope: ex.laterality === 'unilateral' ? 'per_side' : 'total',
      rest: 90, rir: 3
    };
  }

  function openPlan(rec) {
    /* A working copy. Editing the stored record directly would make
       Cancel impossible and would write half-finished plans into sync
       on every keystroke. */
    editing_plan = JSON.parse(JSON.stringify(rec));
    peSearch = '';
    $('peAddSearch').value = '';
    renderWorkoutTemplates();
    $('planEdit').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  $('planSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-plan]');
    if (!b) return;
    planKind = b.dataset.plan;
    editing_plan = null;
    Array.prototype.forEach.call($('planSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderWorkoutTemplates();
  });

  $('planNew').addEventListener('click', function () {
    openPlan(planKind === 'program'
      ? { kind: 'program', name: '', schedule: [] }
      : { kind: 'workout', name: '', items: [] });
    $('peName').focus();
  });

  $('planList').addEventListener('click', function (ev) {
    var open = ev.target.closest('[data-plan-open]');
    if (open) {
      var rec = Store.plan(open.dataset.planOpen);
      if (rec) openPlan(rec);
      return;
    }
    var st = ev.target.closest('[data-plan-start]');
    if (st) {
      var w = Store.plan(st.dataset.planStart);
      if (!w || !(w.items || []).length) return;
      startPlan(w.name, w.id, w.items);
    }
  });

  /* Copying a catalog session. The copy is yours from that moment: it
     keeps sourceId so it is obvious where it came from, but nothing
     downstream reads back through it, so editing the copy is safe and a
     catalog update cannot reach it. */
  $('sessionList').addEventListener('click', function (ev) {
    var c = ev.target.closest('[data-copy]');
    if (!c || !Gym.ready()) return;
    ev.stopPropagation();
    var se = Gym.sessions().filter(function (x) { return x.id === c.dataset.copy; })[0];
    if (!se) return;
    var rec = Store.savePlan({
      kind: 'workout', name: se.name + ' (copy)', sourceId: se.id,
      items: se.items.map(function (it) {
        return {
          ex: it.exercise_id, name: Gym.name(it.exercise_id), sets: it.sets,
          min: it.target.min, max: it.target.max, unit: it.target.unit,
          scope: it.target_scope, rest: it.rest_seconds, rir: it.rir_target
        };
      })
    });
    openPlan(rec);
  });

  $('programList').addEventListener('click', function (ev) {
    var c = ev.target.closest('[data-copy-prog]');
    if (!c || !Gym.ready()) return;
    var pg = Gym.programs().filter(function (x) { return x.id === c.dataset.copyProg; })[0];
    if (!pg) return;
    /* A catalog program schedules catalog sessions. Copying it has to
       copy those too, or the new program points at things the plan
       editor cannot show or edit. */
    var made = {};
    var schedule = pg.schedule.map(function (d) {
      if (!made[d.session_id]) {
        var se = Gym.sessions().filter(function (x) { return x.id === d.session_id; })[0];
        if (!se) return null;
        made[d.session_id] = Store.savePlan({
          kind: 'workout', name: se.name, sourceId: se.id,
          items: se.items.map(function (it) {
            return {
              ex: it.exercise_id, name: Gym.name(it.exercise_id), sets: it.sets,
              min: it.target.min, max: it.target.max, unit: it.target.unit,
              scope: it.target_scope, rest: it.rest_seconds, rir: it.rir_target
            };
          })
        }).id;
      }
      return { day: d.day, planId: made[d.session_id] };
    }).filter(Boolean);
    var rec = Store.savePlan({
      kind: 'program', name: pg.name + ' (copy)', sourceId: pg.id,
      schedule: schedule, notes: pg.notes || ''
    });
    planKind = 'program';
    Array.prototype.forEach.call($('planSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.plan === 'program'));
    });
    openPlan(rec);
  });

  /* editor: exercises */
  $('peAddSearch').addEventListener('input', function () {
    peSearch = $('peAddSearch').value.trim();
    renderPlanEditor();
  });

  $('peAddResults').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-add-ex]');
    if (!b || !editing_plan || !Gym.ready()) return;
    var ex = Gym.byId(b.dataset.addEx);
    if (!ex) return;
    editing_plan.items = (editing_plan.items || []).concat([defaultItemFor(ex)]);
    peSearch = '';
    $('peAddSearch').value = '';
    renderPlanEditor();
  });

  $('peItems').addEventListener('click', function (ev) {
    if (!editing_plan) return;
    var rm = ev.target.closest('[data-item-rm]');
    if (rm) {
      editing_plan.items.splice(Number(rm.dataset.itemRm), 1);
      renderPlanEditor();
      return;
    }
    var up = ev.target.closest('[data-item-up]');
    if (up) {
      var i = Number(up.dataset.itemUp);
      if (i > 0) {
        var t = editing_plan.items[i - 1];
        editing_plan.items[i - 1] = editing_plan.items[i];
        editing_plan.items[i] = t;
        renderPlanEditor();
      }
      return;
    }
    var ed = ev.target.closest('[data-item-edit]');
    if (ed) {
      var idx = Number(ed.dataset.itemEdit);
      var it = editing_plan.items[idx];
      var setsStr = prompt(it.name + '\nHow many sets?', String(it.sets));
      if (setsStr === null) return;
      var rangeStr = prompt(it.name + '\nTarget ' + (it.unit === 'reps' ? 'reps' : it.unit) +
        ' \u2014 as "8-12" or a single number', it.min + '-' + it.max);
      if (rangeStr === null) return;
      var rirStr = prompt(it.name + '\nReps in reserve to aim for. Blank for none \u2014 timed ' +
        'holds and carries have no meaningful RIR.',
        it.rir === null || it.rir === undefined ? '' : String(it.rir));
      if (rirStr === null) return;

      var sets = parseInt(setsStr, 10);
      if (isFinite(sets) && sets > 0) it.sets = sets;
      var m = String(rangeStr).match(/(\d+)\s*(?:[-\u2013]\s*(\d+))?/);
      if (m) {
        it.min = Number(m[1]);
        it.max = m[2] ? Number(m[2]) : Number(m[1]);
        if (it.max < it.min) { var q = it.min; it.min = it.max; it.max = q; }
      }
      var rir = parseFloat(rirStr);
      it.rir = isFinite(rir) ? rir : null;
      renderPlanEditor();
    }
  });

  /* editor: program days */
  $('peAddDay').addEventListener('click', function () {
    if (!editing_plan) return;
    var d = parseInt($('peDayNum').value, 10);
    var pid = $('peDayPlan').value;
    if (!isFinite(d) || d < 1 || d > 7 || !pid) return;
    var sched = (editing_plan.schedule || []).filter(function (x) { return x.day !== d; });
    /* One workout per day. Two on the same day is a schedule with no
       answer for which one "today's workout" means. */
    sched.push({ day: d, planId: pid });
    editing_plan.schedule = sched;
    renderPlanEditor();
  });

  $('peDays').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-day-rm]');
    if (!b || !editing_plan) return;
    var d = Number(b.dataset.dayRm);
    editing_plan.schedule = (editing_plan.schedule || []).filter(function (x) { return x.day !== d; });
    renderPlanEditor();
  });

  $('peSave').addEventListener('click', function () {
    if (!editing_plan) return;
    var name = $('peName').value.trim();
    if (!name) { $('peName').focus(); return; }
    editing_plan.name = name;
    Store.savePlan(editing_plan);
    editing_plan = null;
    render();
  });

  $('peClose').addEventListener('click', function () {
    editing_plan = null;
    renderWorkoutTemplates();
  });

  $('peDelete').addEventListener('click', function () {
    if (!editing_plan || !editing_plan.id) return;
    if (editing_plan.kind === 'workout') {
      /* A program pointing at a deleted workout is a schedule with a
         hole in it, which is worse than refusing to make one. */
      var used = Store.programsUsing(editing_plan.id);
      if (used.length && !confirm('This workout is used by ' +
          used.map(function (p) { return p.name; }).join(', ') +
          '. Delete it anyway? Those days will point at nothing.')) return;
    }
    if (!confirm('Delete "' + editing_plan.name + '"? Sessions you already logged from it stay.')) return;
    Store.removePlan(editing_plan.id);
    editing_plan = null;
    render();
  });

  /* ---- starting and running a session ---- */

  function startPlan(name, templateId, items) {
    var existing = Store.openSession(day);
    if (existing && !confirm('There is already a workout in progress for this day. Start ' +
        name + ' instead? The one in progress keeps whatever you logged.')) return;
    if (existing) Store.finishSession(existing.id, existing.minutes || null);
    Store.startSession(day, {
      name: name, templateId: templateId, intensity: 'lift_moderate', items: items
    });
    trainView = 'today';
    Array.prototype.forEach.call($('trainSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.train === 'today'));
    });
    editing_plan = null;
    render();
    window.scrollTo(0, 0);
  }

  $('sessionList').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-start]');
    if (!b || !Gym.ready()) return;
    var se = Gym.sessions().filter(function (x) { return x.id === b.dataset.start; })[0];
    if (!se) return;

    var existing = Store.openSession(day);
    if (existing && !confirm('There is already a workout in progress for this day. Start ' +
        se.name + ' instead? The one in progress keeps whatever you logged.')) return;
    if (existing) Store.finishSession(existing.id, existing.minutes || null);

    Store.startSession(day, {
      name: se.name,
      templateId: se.id,
      /* Sessions of mixed content are logged as moderate lifting for
         the calorie estimate. Minutes, asked for at the end, are what
         that estimate actually turns on. */
      intensity: 'lift_moderate',
      items: se.items.map(function (it) {
        return {
          ex: it.exercise_id,
          name: Gym.name(it.exercise_id),
          sets: it.sets,
          min: it.target.min, max: it.target.max, unit: it.target.unit,
          scope: it.target_scope, rest: it.rest_seconds, rir: it.rir_target
        };
      })
    });
    trainView = 'today';
    Array.prototype.forEach.call($('trainSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.train === 'today'));
    });
    render();
    window.scrollTo(0, 0);
  });

  /* Logging a set. A prompt rather than an inline form on purpose:
     three numbers, one hand, phone propped against a dumbbell. An
     inline editor here means scrolling to find the row you are on. */
  $('liveSets').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-logset]');
    if (!b) return;
    var w = Store.openSession(day);
    if (!w) return;
    var i = Number(b.dataset.logset);
    var row = (w.sets || [])[i];
    if (!row) return;

    var ex = Gym.ready() ? Gym.byId(row.ex) : null;
    var hist = Store.exerciseHistory(row.ex, 1)[0];
    var adv = adviceFor(row.ex, { min: row.targetMin, max: row.targetMax, rir: row.rirTarget });
    /* Already-entered value first, then what the model recommends, then
       simply what was done last time. The recommendation is a default,
       never a lock: it arrives pre-filled and fully overwritable,
       because the person under the bar knows things the model does not. */
    var suggested = row.load !== null ? row.load
      : (adv && adv.load ? adv.load : (hist ? hist.load : null));

    var loadStr = prompt(row.name + ' \u2014 set ' + row.idx + '\nLoad in lb' +
      (ex && Gym.loadNote(ex) ? '\n(' + Gym.loadNote(ex) + ')' : '') +
      (hist ? '\nLast time: ' + (hist.load || 0) + ' \u00d7 ' + hist.reps +
        (hist.rir !== null && hist.rir !== undefined ? ' @ ' + hist.rir + ' RIR' : '') : '') +
      '\nLeave blank for bodyweight.',
      suggested === null ? '' : String(suggested));
    if (loadStr === null) return;

    var target = row.targetMin === row.targetMax ? String(row.targetMin)
      : row.targetMin + '-' + row.targetMax;
    var repsStr = prompt(row.name + ' \u2014 set ' + row.idx + '\n' +
      (row.unit === 'reps' ? 'Reps' : row.unit.charAt(0).toUpperCase() + row.unit.slice(1)) +
      ' (target ' + target + (row.scope === 'per_side' ? ' each side' : '') + ')',
      row.reps === null ? '' : String(row.reps));
    if (repsStr === null) return;

    var rirStr = null;
    if (row.rirTarget !== null && row.rirTarget !== undefined) {
      rirStr = prompt(row.name + ' \u2014 set ' + row.idx +
        '\nReps in reserve \u2014 how many more could you have done?' +
        '\nTarget was ' + row.rirTarget + '. This is an estimate, not a score.',
        row.rir === null ? String(row.rirTarget) : String(row.rir));
      if (rirStr === null) return;
    }

    function n(v) { var x = parseFloat(v); return isFinite(x) ? x : null; }
    Store.logSet(w.id, i, { load: n(loadStr), reps: n(repsStr), rir: n(rirStr), done: true });
    render();
  });

  $('finishSession').addEventListener('click', function () {
    var w = Store.openSession(day);
    if (!w) return;
    var mins = num($('liveMinutes'));
    if (mins === null || mins <= 0) {
      $('liveHint').textContent = 'Minutes first \u2014 the calorie estimate has nothing to work ' +
        'from without them, and a session logged as zero minutes is worth zero calories.';
      $('liveMinutes').focus();
      return;
    }
    var c = countDone(w);
    if (c.done < c.total && !confirm(c.done + ' of ' + c.total + ' sets logged. Finish anyway? ' +
        'The unlogged sets are dropped from the record.')) return;
    Store.finishSession(w.id, mins);
    render();
  });

  $('abandonSession').addEventListener('click', function () {
    var w = Store.openSession(day);
    if (!w) return;
    if (!confirm('Discard this workout and everything logged in it?')) return;
    Store.removeWorkout(w.id);
    render();
  });

  /* ---- the exercise index ---- */

  $('exSearch').addEventListener('input', function () {
    exQuery = $('exSearch').value.trim();
    renderExerciseIndex();
  });

  $('exQuick').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-part]');
    if (!b) return;
    exQuery = (exQuery === b.dataset.part) ? '' : b.dataset.part;
    $('exSearch').value = exQuery;
    renderExerciseIndex();
  });

  function openExercise(id) {
    exOpenId = id;
    renderExerciseIndex();
    $('exDetail').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  ['exResults', 'exSecondary', 'exdBody'].forEach(function (id) {
    $(id).addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ex]');
      if (b) openExercise(b.dataset.ex);
    });
  });

  $('exdClose').addEventListener('click', function () {
    exOpenId = null;
    renderExerciseIndex();
  });

  /* Adding a single exercise to today's workout, starting one if there
     is none. This is the path for "I just want to do some curls" — a
     program is a nice-to-have, logging what you actually did is not. */
  $('exdAdd').addEventListener('click', function () {
    if (!exOpenId || !Gym.ready()) return;
    var e = Gym.byId(exOpenId);
    if (!e) return;
    var w = Store.openSession(day);
    var item = {
      ex: e.id, name: e.name, sets: 3,
      min: 8, max: 12, unit: e.tracking_mode || 'reps',
      scope: e.laterality === 'unilateral' ? 'per_side' : 'total',
      rest: 90, rir: 3
    };
    if (!w) {
      Store.startSession(day, { name: 'Workout', items: [item] });
    } else {
      /* Appending to the live session rather than starting a second
         one: two open workouts on a day is a state with no good
         answer for which one a logged set belongs to. */
      var rows = (w.sets || []).slice();
      for (var i = 1; i <= item.sets; i++) {
        rows.push({
          ex: item.ex, name: item.name, idx: i,
          targetMin: item.min, targetMax: item.max, rirTarget: item.rir,
          unit: item.unit, scope: item.scope, rest: item.rest,
          load: null, reps: null, rir: null, done: false
        });
      }
      Store.updateWorkout(w.id, { sets: rows });
    }
    exOpenId = null;
    trainView = 'today';
    Array.prototype.forEach.call($('trainSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x.dataset.train === 'today'));
    });
    render();
    window.scrollTo(0, 0);
  });


  function saveSteps() {
    Store.setSteps(day, num($('stepsInput')));
    render();
  }
  /* ---------------------------------------------------------------
     FETCHING TODAY'S STEPS

     Worth being precise about what this can do, because the obvious
     reading of a refresh icon is wrong.

     A web app cannot read Apple Health. That is an iOS rule, not a
     gap in this app: Health is readable only by native apps the person
     has granted access to, and only while the phone is unlocked. So
     nothing here reaches into Health directly, and no button ever
     will.

     What it can do is both halves of the chain that already exists:

       1. ask iOS to run a Shortcut, which triggers Health Auto Export
          to send today's steps to the database. Optional, and only
          works if a Shortcut has been named in Setup.
       2. pull from the database, which is where the steps land.

     Step 2 alone is still useful — it fetches whatever the last
     automatic export left there, which on a normal day is minutes old.
     Step 1 is what makes the number current to the minute.
     --------------------------------------------------------------- */

  function pullSteps() {
    var note = $('stepsPullNote');
    if (!Sync.configured() || !Sync.signedIn()) {
      note.textContent = 'Sign in first — steps arrive through your account.';
      return;
    }

    var name = (Store.settings().stepsShortcut || '').trim();
    var before = Store.stepsOn(day);

    if (name) {
      /* Leaves the app. iOS runs the Shortcut, Health Auto Export
         exports, and coming back fires visibilitychange, which syncs
         again — so the number is usually there before the person has
         finished looking at it. */
      note.textContent = 'Asking Shortcuts to run "' + name + '"…';
      try {
        window.location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(name);
      } catch (e) { /* not iOS, or Shortcuts is not installed */ }
    }

    note.textContent = name ? 'Fetching…' : 'Fetching what your phone last sent…';
    $('pullSteps').disabled = true;
    doSync('steps').then(function () {
      $('pullSteps').disabled = false;
      var after = Store.stepsOn(day);
      render();
      if (after && (!before || after.steps !== before.steps)) {
        note.textContent = 'Updated: ' + fmt(after.steps) + ' steps.';
      } else if (after) {
        note.textContent = 'Still ' + fmt(after.steps) + ' steps — nothing newer has arrived yet.';
      } else {
        /* "Nothing for today" and "nothing ever" are different problems
           with different fixes, and the app can tell them apart: if
           yesterday has steps, the pipe works and the export window is
           the thing that is wrong. That is a real setting on the phone
           with a real name, so say it rather than shrugging. */
        var recent = null;
        for (var i = 1; i <= 10 && !recent; i++) {
          var r = Store.stepsOn(WL.addDays(day, -i));
          if (r && r.steps) recent = { date: WL.addDays(day, -i), steps: r.steps, back: i };
        }
        if (recent) {
          note.textContent = 'Nothing for today, but ' + fmt(recent.steps) + ' steps arrived for ' +
            recent.date + '. The pipe works; the export window is stopping short of today. ' +
            'In Health Auto Export set Date Range to "Default" — "Previous 7 Days" means ' +
            'the seven days BEFORE today and leaves today out.';
        } else {
          note.textContent = name
            ? 'Nothing arrived. If the Shortcut ran, give it a few seconds and try again.'
            : 'No steps have ever arrived. Health Auto Export sends them; see HEALTH-EXPORT.md.';
        }
      }
    }).catch(function (e) {
      $('pullSteps').disabled = false;
      note.textContent = 'Could not fetch: ' + String(e.message || e);
    });
  }

  /* water */
  document.querySelector('#panel-today').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-water]');
    if (!b) return;
    setWater(Store.waterOn(day) + Number(b.dataset.water));
  });
  $('waterSlider').addEventListener('input', function () {
    /* Rendered live while dragging, saved on release: writing on every
       pixel of a drag would fill the sync queue with a hundred
       versions of one glass of water. */
    var v = Number($('waterSlider').value);
    $('waterReadout').textContent = fmt(v) + ' / ' + fmt(num0(Store.settings().waterGoalOz, 64)) + ' oz';
  });
  $('waterSlider').addEventListener('change', function () {
    setWater(Number($('waterSlider').value));
  });
  $('saveWater').addEventListener('click', function () {
    var v = num($('waterInput'));
    setWater(v === null ? 0 : v);
  });
  $('waterInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('saveWater').click(); }
  });

  $('pullSteps').addEventListener('click', pullSteps);
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
  /* Your own library, shaped like a lookup result so both can sit in
     one list. No per100g, so it takes the plain servings path in the
     amount editor — which is right: a recipe is portions, not grams. */
  function libraryResults(q) {
    return Store.searchLibrary(q, 8).map(function (f) {
      return {
        name: f.name, serving: f.serving || '1 serving',
        kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat,
        /* The panel travels with the row. Without it, logging a food
           from your own suggestions handed saveFoodEdit a null and
           wiped seventeen nutrients off a food that had them. */
        micros: f.micros || null,
        source: 'library', kind: f.kind || 'food', localId: f.id
      };
    });
  }

  $('searchOnline').addEventListener('click', function () {
    var q = $('foodPick').value.trim();
    if (!q) { $('foodPick').focus(); setLookup('Type what you ate first, then look it up.', []); return; }

    /* Your library answers instantly and without a network, so it goes
       up first and stays put. Waiting on USDA to show you something you
       cooked last Tuesday is backwards — the public database is the
       fallback, not the first port of call. */
    var mine = libraryResults(q);
    setLookup(mine.length
      ? mine.length + ' from your library. Searching USDA too…'
      : 'Searching for “' + q + '”…', mine);

    FoodAPI.searchFoods(q).then(function (rows) {
      /* Anything already in your library is dropped from the USDA half.
         The same name twice, once yours and once theirs, is a choice
         between a thing you have eaten and a thing you have not — and
         showing both invites picking the wrong one. */
      var have = {};
      mine.forEach(function (r) { have[r.name.toLowerCase()] = 1; });
      var fresh = rows.filter(function (r) { return !have[String(r.name).toLowerCase()]; });

      if (!mine.length && !fresh.length) {
        setLookup('Nothing found for “' + q + '”. Add it by hand and it is yours from then on.', []);
      } else {
        setLookup(mine.length
          ? 'Yours first, then ' + fresh.length + ' from USDA.'
          : fresh.length + ' found. Tap one to log it — it joins your library too.',
          mine.concat(fresh));
      }
    }).catch(function (e) {
      /* A failed search does not throw away the half that worked. */
      if (mine.length) {
        setLookup(mine.length + ' from your library. USDA did not answer: ' +
          String(e.message || e), mine);
      } else {
        setLookup(String(e.message || e), []);
      }
    });
  });

  $('lookupResults').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-pick]');
    if (!b) return;
    var rec = lookup.results[Number(b.dataset.pick)];
    if (rec) openFoodEditForResult(rec);
  });

  /* amount editor */
  $('feAmount').addEventListener('input', feRecompute);
  $('feUnit').addEventListener('change', function () {
    feUnitChoice = $('feUnit').value;
    feRenderUnits();
    feRecompute();
  });
  $('feLearnSave').addEventListener('click', feLearnBasis);
  $('feLearnValue').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); feLearnBasis(); }
  });
  $('feSave').addEventListener('click', saveFoodEdit);
  $('feCancel').addEventListener('click', closeFoodEdit);
  $('foodEdit').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); saveFoodEdit(); }
  });

  /* ---------------------------------------------------------------
     SCAN A PLATE

     Results land in an editable list and are logged only on request.
     A portion read off a photograph is an estimate, and an estimate
     written straight into the calorie history would quietly poison
     every number computed from it — the TDEE most of all, since that
     is energy balance run backwards over exactly this data.
     --------------------------------------------------------------- */

  var plateItems = [];

  function renderPlate() {
    var t = Plate.totals(plateItems);
    $('plateItems').innerHTML = plateItems.length ? plateItems.map(function (it, i) {
      var macro = fmt(it.protein) + 'p ' + fmt(it.carbs) + 'c ' + fmt(it.fat) + 'f';
      return '<li><div class="plate-item">' +
        '<span class="pname">' + esc(it.name) +
          ' <span class="conf ' + esc(it.confidence) + '">' + esc(it.confidence) + '</span>' +
          ' <span class="src ' + esc(it.source) + '">' +
            (it.source === 'usda' ? 'database' : 'estimate') + '</span></span>' +
        '<span class="pamt"><input type="text" inputmode="decimal" data-plate-g="' + i +
          '" value="' + esc(String(it.grams)) + '" aria-label="Grams"></span>' +
        '<span class="pmacro">g \u00b7 ' + esc(macro) +
          (it.household ? '  \u00b7  ' + esc(it.household) : '') + '</span>' +
        '<span class="pkcal">' + fmt(it.kcal) + '</span>' +
        '<button class="btn ghost grow-0" data-plate-look="' + i + '">Look up</button>' +
        '<button class="btn ghost grow-0" data-plate-rm="' + i + '" aria-label="Remove">&times;</button>' +
        '</div></li>';
    }).join('') : '<li><span class="empty" style="flex:1">Nothing to log.</span></li>';

    $('plateFooter').textContent = plateItems.length
      ? fmt(t.kcal) + ' cal \u00b7 ' + fmt(t.protein) + 'p ' + fmt(t.carbs) + 'c ' + fmt(t.fat) + 'f. ' +
        '"Look up" swaps a row\u2019s guess for real database figures at that weight, ' +
        'and brings its micronutrients with it.'
      : '';
  }

  function openPlate() {
    plateItems = [];
    $('plateCard').hidden = false;
    $('plateStatus').textContent = 'Reading the photo\u2026';
    renderPlate();
    $('plateCard').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  $('scanPlate').addEventListener('click', function () { $('platePhoto').click(); });

  $('platePhoto').addEventListener('change', function () {
    var file = $('platePhoto').files[0];
    $('platePhoto').value = '';
    if (!file) return;
    openPlate();
    Plate.read(file).then(function (result) {
      plateItems = result.items;
      $('plateStatus').textContent = Plate.summary(result);
      renderPlate();
    }).catch(function (e) {
      $('plateStatus').textContent = String(e.message || e);
      renderPlate();
    });
  });

  $('plateClose').addEventListener('click', function () {
    $('plateCard').hidden = true;
    plateItems = [];
  });

  $('plateItems').addEventListener('input', function (ev) {
    var g = ev.target.closest('[data-plate-g]');
    if (!g) return;
    var i = Number(g.dataset.plateG);
    var v = Units.parseAmount(g.value);
    if (v === null || v <= 0) return;
    plateItems[i] = Plate.atGrams(plateItems[i], v);
    /* Re-rendered without touching the box being typed in, which would
       eat the cursor. Only the numbers beside it move. */
    var li = g.closest('li');
    li.querySelector('.pmacro').textContent = 'g \u00b7 ' +
      fmt(plateItems[i].protein) + 'p ' + fmt(plateItems[i].carbs) + 'c ' + fmt(plateItems[i].fat) + 'f';
    li.querySelector('.pkcal').textContent = fmt(plateItems[i].kcal);
    var t = Plate.totals(plateItems);
    $('plateFooter').textContent = fmt(t.kcal) + ' cal \u00b7 ' + fmt(t.protein) + 'p ' +
      fmt(t.carbs) + 'c ' + fmt(t.fat) + 'f.';
  });

  $('plateItems').addEventListener('click', function (ev) {
    var rm = ev.target.closest('[data-plate-rm]');
    if (rm) { plateItems.splice(Number(rm.dataset.plateRm), 1); renderPlate(); return; }

    var look = ev.target.closest('[data-plate-look]');
    if (!look) return;
    var i = Number(look.dataset.plateLook);
    var item = plateItems[i];
    look.disabled = true;
    look.textContent = '\u2026';
    /* The point of the whole design: the model is good at "that is a
       chicken thigh, about 140 g" and a database is good at "140 g of
       chicken thigh contains this". Each does the half it is good at. */
    FoodAPI.searchFoods(item.name).then(function (rows) {
      var hit = rows[0];
      if (!hit || !hit.per100g || hit.per100g.kcal === null) {
        look.disabled = false; look.textContent = 'Look up';
        $('plateStatus').textContent = 'Nothing in USDA matched "' + item.name +
          '". The estimate stands.';
        return;
      }
      var k = item.grams / 100;
      plateItems[i] = {
        name: hit.name, grams: item.grams, household: item.household,
        confidence: item.confidence, source: 'usda',
        kcal: Math.round(hit.per100g.kcal * k),
        protein: Math.round(hit.per100g.protein * k * 10) / 10,
        carbs: Math.round(hit.per100g.carbs * k * 10) / 10,
        fat: Math.round(hit.per100g.fat * k * 10) / 10,
        micros: (hit.micros100g && typeof Micros !== 'undefined')
          ? Micros.scale(hit.micros100g, k) : null
      };
      /* The confidence stays as it was, deliberately. The database
         fixed what is IN the food; it knows nothing about how much of
         it was on the plate, which is the part that was uncertain. */
      $('plateStatus').textContent = 'Swapped in ' + hit.name + ' at ' + item.grams + ' g.';
      renderPlate();
    }).catch(function (e) {
      look.disabled = false; look.textContent = 'Look up';
      $('plateStatus').textContent = String(e.message || e);
    });
  });

  $('plateLogAll').addEventListener('click', function () {
    if (!plateItems.length) return;
    plateItems.forEach(function (it) {
      /* Saved as a food at the weight seen, so it autocompletes next
         time and its micros are reusable. The entry records grams,
         like everything else logged. */
      var existing = Store.findFoodByName(it.name);
      var f = Store.addFood({
        id: existing ? existing.id : undefined,
        name: it.name, serving: it.grams + ' g',
        micros: it.micros || undefined,
        kcal: it.kcal, protein: it.protein, carbs: it.carbs, fat: it.fat
      });
      Store.addEntry(day, {
        foodId: f.id, name: f.name, qty: 1,
        amount: it.grams, unit: 'g',
        kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat
      });
    });
    plateItems = [];
    $('plateCard').hidden = true;
    render();
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
    /* The reader makes several passes at a photo, and on a big one they
       take a couple of seconds between them. Saying which pass it is on
       is the difference between waiting and wondering. */
    Scanner.scanImage(file, 'scanView', function (msg) {
      $('scanStatus').textContent = msg;
    }).then(function (code) {
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

  $('habitToday').addEventListener('change', function (ev) {
    var cb = ev.target.closest('[data-habit]');
    if (!cb) return;
    Store.setHabit(day, cb.dataset.habit, cb.checked);
    render();
  });

  $('dayNote').addEventListener('input', function () { Store.setNote(day, $('dayNote').value); });

  $('trendSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-trend]');
    if (!b) return;
    trendView = b.dataset.trend;
    Array.prototype.forEach.call($('trendSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    render();
    window.scrollTo(0, 0);
  });

  $('microSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-micro]');
    if (!b) return;
    microView = b.dataset.micro;
    Array.prototype.forEach.call($('microSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderMicros();
  });

  $('libSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-lib]');
    if (!b) return;
    libKind = b.dataset.lib;
    tagFilter = null;
    Array.prototype.forEach.call($('libSeg').children, function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    $('newFoodCard').hidden = true;
    renderFoods();
  });

  $('tagFilter').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-tag]');
    if (!b) return;
    /* Tapping the active chip clears it — the filter is its own undo. */
    tagFilter = (tagFilter === b.dataset.tag) ? null : b.dataset.tag;
    renderFoods();
  });

  $('addFoodBtn').addEventListener('click', function () {
    var card = $('newFoodCard');
    card.hidden = !card.hidden;
    if (!card.hidden) {
      ['nfName', 'nfServing', 'nfServings', 'nfKcal', 'nfP', 'nfC', 'nfF', 'nfTags']
        .forEach(function (id) { $(id).value = ''; });
      $('nfName').focus();
      card.scrollIntoView({ block: 'center' });
    }
  });

  $('cancelFood').addEventListener('click', function () { $('newFoodCard').hidden = true; });

  /* ---------------------------------------------------------------
     A RECIPE FROM A LINK

     What comes back lands in the ordinary add-a-recipe form rather
     than saving itself. Two reasons, and neither is caution for its
     own sake: sites do get their own nutrition wrong, and the numbers
     are per serving as the site defines a serving, which may not be
     how much you actually ate. Both are one glance to check and
     impossible to notice after the fact.
     --------------------------------------------------------------- */

  function readRecipeLink() {
    var raw = $('riUrl').value.trim();
    if (!raw) { $('riUrl').focus(); return; }
    var st = $('riStatus');
    st.textContent = 'Reading the page…';
    $('riGo').disabled = true;

    Recipe.lookup(raw).then(function (r) {
      $('riGo').disabled = false;
      st.textContent = Recipe.summary(r);

      /* Nothing recipe-shaped on the page. Opening an empty form on
         top of that would suggest something had been found. */
      if (r.reason === 'no-recipe') return;

      $('nfName').value = r.name || '';
      $('nfServing').value = r.servingLabel || '1 serving';
      $('nfServings').value = r.servings ? String(r.servings) : '';
      $('nfTags').value = '';
      var per = r.per || {};
      $('nfKcal').value = per.kcal === null || per.kcal === undefined ? '' : String(per.kcal);
      $('nfP').value = per.protein === null || per.protein === undefined ? '' : String(per.protein);
      $('nfC').value = per.carbs === null || per.carbs === undefined ? '' : String(per.carbs);
      $('nfF').value = per.fat === null || per.fat === undefined ? '' : String(per.fat);

      /* A recipe page states fibre, sugars, saturated fat, sodium and
         cholesterol far more often than it states anything else. That
         is a partial panel, which is worth keeping: coverage reporting
         exists precisely so partial data can be counted honestly
         rather than discarded. */
      pendingMicros = null;
      if (r.extras && typeof Micros !== 'undefined') {
        var e = r.extras, panel = {};
        if (e.fiber !== null && e.fiber !== undefined) panel.fiber = e.fiber;
        if (e.sugar !== null && e.sugar !== undefined) panel.sugar = e.sugar;
        if (e.satFat !== null && e.satFat !== undefined) panel.satFat = e.satFat;
        if (e.sodium !== null && e.sodium !== undefined) panel.sodium = e.sodium;
        if (e.cholesterol !== null && e.cholesterol !== undefined) panel.chol = e.cholesterol;
        if (Object.keys(panel).length) pendingMicros = panel;
      }

      $('newFoodCard').hidden = false;
      $('newFoodCard').scrollIntoView({ block: 'center', behavior: 'smooth' });

      /* Land the cursor on the first thing the page did not state, so
         the gap is the next thing touched rather than something to be
         spotted later. */
      if (!r.ok) {
        var first = { calories: 'nfKcal', protein: 'nfP', carbs: 'nfC', fat: 'nfF' }[(r.missing || [])[0]];
        $(first || 'nfName').focus();
      }
    }).catch(function (e) {
      $('riGo').disabled = false;
      st.textContent = e.message || 'That page could not be read.';
    });
  }

  $('riGo').addEventListener('click', readRecipeLink);
  $('riUrl').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); readRecipeLink(); }
  });

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
    /* Saving a name that already exists updates it rather than making a
       second one. Two library rows with the same name are impossible to
       tell apart at the moment you are picking between them, and the
       food picker matches by name anyway — so a duplicate is not a
       choice, it is a coin toss. */
    var dupe = Store.findFoodByName(name);
    Store.addFood({
      id: dupe ? dupe.id : undefined,
      name: name, serving: $('nfServing').value.trim(),
      micros: pendingMicros,
      kind: libKind,
      servings: libKind === 'recipe' ? num($('nfServings')) : null,
      tags: $('nfTags').value,
      kcal: num($('nfKcal')), protein: num($('nfP')), carbs: num($('nfC')), fat: num($('nfF'))
    });
    ['nfName', 'nfServing', 'nfServings', 'nfKcal', 'nfP', 'nfC', 'nfF', 'nfTags']
      .forEach(function (id) { $(id).value = ''; });
    pendingMicros = null;
    $('newFoodCard').hidden = true;
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
  bindSetting('stTargetOverride', 'targetOverride', function (el) { return num(el); });
  bindSetting('stWaterGoal', 'waterGoalOz', function (el) { var v = num(el); return v === null ? 0 : v; });
  bindSetting('stStepsShortcut', 'stepsShortcut', function (el) { return el.value.trim(); });
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

  /* ---------------------------------------------------------------
     MIDNIGHT

     A phone app is almost never closed; it is backgrounded. So the
     view can be hours or days older than the clock, and the failure
     mode is quiet and expensive: breakfast logged into yesterday,
     found a week later when two days look wrong and neither can be
     trusted.

     anchorToday is what the app last believed today to be. Comparing
     against it — rather than against the day on screen — is what makes
     this safe in both directions:

       sitting on today, date changes    move forward with it
       browsing an earlier day           leave it alone, silently

     Without that distinction, rolling over would yank you off the
     Tuesday you deliberately opened.

     The old version checked for a gap of exactly one day, which meant
     a phone left alone over a weekend never rolled over at all. Any
     gap counts now.
     --------------------------------------------------------------- */

  var anchorToday = WL.todayKey();

  function checkDayRollover() {
    var t = WL.todayKey();
    if (t === anchorToday) return;
    var wasOnToday = (day === anchorToday);
    anchorToday = t;
    if (wasOnToday) day = t;
    /* Re-render either way: even when the view stays put, "next day"
       has a new bound and the date label a new meaning. */
    render();
  }

  /* Every thirty seconds while visible. Backgrounded pages have their
     timers throttled or stopped outright, which is exactly why this is
     not the only check. */
  setInterval(function () {
    if (document.visibilityState === 'visible') checkDayRollover();
  }, 30000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      /* Before the sync, not after. Coming back to the app in the
         morning, the date has to be right in the first frame you see —
         waiting on a network round trip leaves a window where the
         obvious thing to do is log breakfast into yesterday. */
      checkDayRollover();
      doSync('foreground');
      return;
    }
    /* Leaving the camera running in the background keeps the indicator
       light on and, on iOS, comes back as a black frame. */
    if (Scanner.running()) closeScanner();
  });

  /* Belt and braces for iOS, where a PWA resumed from the background
     often restores from the back/forward cache and fires pageshow
     rather than visibilitychange. */
  window.addEventListener('pageshow', checkDayRollover);
  window.addEventListener('focus', checkDayRollover);
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
  refreshUnits();
  doSync('startup');
})();
