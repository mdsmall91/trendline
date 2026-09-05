'use strict';

/* =============================================================
   TRENDLINE — STRENGTH PROGRESSION

   Rules, plus a model of what you can currently do. Not a generator:
   nothing here invents an exercise or reshuffles a program. It answers
   one narrow question — given what you actually lifted last time, what
   load and reps should be on the bar today — and refuses to answer it
   when the history is too thin to mean anything.

   THREE IDEAS DO ALL THE WORK

   1. Reps in reserve makes sets comparable. 225x8 with three left and
      225x8 to failure are the same row in a log and completely
      different performances. Adding RIR to reps gives "reps to
      failure", which is the number that maps onto a percentage of
      your maximum.

   2. A percentage table converts that to an estimated one-rep max, so
      sets at different loads and rep counts can be compared at all.
      Eight reps at 185 and five at 205 are otherwise incommensurable.

   3. Estimates are smoothed across sessions, for the same reason this
      app charts trend weight rather than weigh-ins: one set is mostly
      noise — sleep, coffee, how the day went — and reacting to it is
      how you end up chasing your own variance.

   AND ONE CONSTRAINT THAT SHAPES EVERYTHING

   The recommendation must be a load that exists in this room. The
   dumbbells are 5, 10, 15, 25, 35, so the honest answer to "you have
   outgrown the 15" is often not "use 16.25" but "stay at 15 and do
   more reps until 25 is reachable". A model that cannot say that is a
   model that stalls people.
   ============================================================= */

var Progress = (function () {

  /* Percentage of one-rep max you can lift for N reps to failure.

     The standard RPE chart, which treats RPE 9 at eight reps as
     equivalent to RPE 10 at nine — so the whole thing collapses to a
     single axis: reps + RIR. Values beyond twelve are extrapolated and
     get flagged, because a set of twenty tells you about endurance
     rather than maximum strength and the relationship stops holding. */
  var PCT = {
    1: 100.0, 2: 95.5, 3: 92.2, 4: 89.2, 5: 86.3, 6: 83.7,
    7: 81.1, 8: 78.6, 9: 76.2, 10: 73.9, 11: 70.7, 12: 68.0,
    13: 65.5, 14: 63.2, 15: 61.0, 16: 59.0, 17: 57.1, 18: 55.3,
    19: 53.6, 20: 52.0
  };

  var MAX_N = 20;

  function pctOf1RM(repsToFailure) {
    var n = Math.round(Number(repsToFailure));
    if (!isFinite(n) || n < 1) return null;
    if (n > MAX_N) n = MAX_N;
    return PCT[n];
  }

  /* Estimated one-rep max for a single set.

     Returns null rather than a number when the inputs cannot support
     one: bodyweight work has no external load to project from, and a
     set with no rep count is not a set. Null is a real answer here and
     callers are expected to handle it — a fabricated e1RM is worse
     than an absent one, because it looks like knowledge. */
  function e1rm(load, reps, rir) {
    var l = Number(load), r = Number(reps);
    var i = (rir === null || rir === undefined) ? 0 : Number(rir);
    if (!isFinite(l) || l <= 0) return null;
    if (!isFinite(r) || r < 1) return null;
    if (!isFinite(i) || i < 0) i = 0;
    var pct = pctOf1RM(r + i);
    if (!pct) return null;
    return (l * 100) / pct;
  }

  /* How much to trust it. Beyond twelve reps to failure the percentage
     relationship is doing more extrapolating than measuring, and a set
     taken well past the prescribed RIR was a different set than the
     one planned. */
  function setConfidence(reps, rir) {
    var n = Number(reps) + (rir === null || rir === undefined ? 0 : Number(rir));
    if (!isFinite(n)) return 'none';
    if (n <= 12) return 'high';
    if (n <= MAX_N) return 'low';
    return 'none';
  }

  /* ---------------------------------------------------------------
     FROM SETS TO A STRENGTH ESTIMATE
     --------------------------------------------------------------- */

  /* One number per session: the best set in it.

     Best rather than average, because the later sets of an exercise
     are fatigued by the earlier ones and averaging them measures your
     endurance under fatigue rather than your strength. */
  function sessionBests(history) {
    var byDate = {};
    (history || []).forEach(function (h) {
      var v = e1rm(h.load, h.reps, h.rir);
      if (v === null) return;
      if (!byDate[h.date] || v > byDate[h.date].e1rm) {
        byDate[h.date] = { date: h.date, e1rm: v, load: h.load, reps: h.reps, rir: h.rir };
      }
    });
    return Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  }

  /* Smoothed strength, newest last. The same exponential smoothing the
     rest of the app uses on bodyweight, and for the same reason: a
     single reading is mostly noise, and the line is the signal. Alpha
     is higher here (0.4) because strength sessions are sparser than
     weigh-ins, so each one has to count for more. */
  function strengthTrend(history, alpha) {
    var a = (typeof alpha === 'number' && alpha > 0 && alpha < 1) ? alpha : 0.4;
    var bests = sessionBests(history);
    var prev = null;
    return bests.map(function (b) {
      prev = (prev === null) ? b.e1rm : prev + a * (b.e1rm - prev);
      return { date: b.date, e1rm: b.e1rm, trend: prev, load: b.load, reps: b.reps, rir: b.rir };
    });
  }

  function currentStrength(history) {
    var t = strengthTrend(history);
    return t.length ? t[t.length - 1].trend : null;
  }

  /* ---------------------------------------------------------------
     CHOOSING A LOAD THAT EXISTS
     --------------------------------------------------------------- */

  /* The heaviest selectable load at or below a target, and the lightest
     above it. Both, because "what can I actually put on the bar" has
     two answers and choosing between them is the interesting part. */
  function bracket(loads, target) {
    var below = null, above = null;
    (loads || []).forEach(function (l) {
      if (l <= target && (below === null || l > below)) below = l;
      if (l > target && (above === null || l < above)) above = l;
    });
    return { below: below, above: above };
  }

  /* The next load up from where you are. Null when there isn't one —
     which is a real state at the top of the dumbbell rack, not an
     error. */
  function nextLoadUp(loads, current) {
    var best = null;
    (loads || []).forEach(function (l) {
      if (l > current && (best === null || l < best)) best = l;
    });
    return best;
  }

  /* Is the next step so big it should be crossed with reps instead?

     On this rack the 15 to 25 dumbbell is a 67% jump. Nobody adds two
     thirds to a working weight and keeps their rep range; the honest
     move is to stay put and build reps until the bigger load is
     actually reachable. Ten percent is the conventional line for
     compound work and it holds up here. */
  var BIG_JUMP = 0.10;

  function jumpIsTooBig(from, to) {
    if (!from || !to || to <= from) return false;
    return (to - from) / from > BIG_JUMP;
  }

  /* ---------------------------------------------------------------
     THE RECOMMENDATION
     --------------------------------------------------------------- */

  /* Did the last session earn a load increase?

     The rule from the programme notes: every set at the top of its rep
     range, with at least the target RIR, on two consecutive exposures.
     Both conditions matter. Hitting the top of the range while grinding
     at zero RIR is not the same performance as hitting it with three in
     reserve, and only the second one has earned more weight. */
  function earnedIncrease(history, pres) {
    var bests = sessionBests(history);
    if (bests.length < 2) return false;
    var byDate = {};
    (history || []).forEach(function (h) {
      (byDate[h.date] = byDate[h.date] || []).push(h);
    });
    var dates = Object.keys(byDate).sort().slice(-2);
    if (dates.length < 2) return false;

    for (var d = 0; d < dates.length; d++) {
      var sets = byDate[dates[d]];
      for (var i = 0; i < sets.length; i++) {
        var s = sets[i];
        if (!(Number(s.reps) >= pres.max)) return false;
        if (pres.rir !== null && pres.rir !== undefined) {
          if (!(Number(s.rir) >= pres.rir)) return false;
        }
      }
    }
    return true;
  }

  /* Was the last session harder than it was meant to be? */
  function struggled(history, pres) {
    var byDate = {};
    (history || []).forEach(function (h) {
      (byDate[h.date] = byDate[h.date] || []).push(h);
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) return false;
    var last = byDate[dates[dates.length - 1]];
    var missedReps = 0, overshot = 0;
    last.forEach(function (s) {
      if (Number(s.reps) < pres.min) missedReps++;
      if (pres.rir !== null && pres.rir !== undefined &&
          s.rir !== null && s.rir !== undefined && Number(s.rir) < pres.rir - 1) overshot++;
    });
    return missedReps > 0 || overshot >= Math.ceil(last.length / 2);
  }

  function lastLoad(history) {
    var dates = {}, out = null, latest = '';
    (history || []).forEach(function (h) {
      if (h.date > latest && h.load !== null && h.load !== undefined) {
        latest = h.date; out = h.load;
      } else if (h.date === latest && h.load > out) {
        out = h.load;
      }
    });
    return out;
  }

  function countSessions(history) {
    var d = {};
    (history || []).forEach(function (h) { d[h.date] = 1; });
    return Object.keys(d).length;
  }

  /* What to do this session.

     opts:
       history   completed sets for this exercise, newest first or any
                 order — dates are what matter
       pres      { min, max, rir } the prescription being followed
       loads     selectable loads for this exercise, ascending
       tracking  'reps' | 'seconds' | 'meters' | 'minutes'
       bodyweight  true when there is no external load to add

     Always returns an action and a sentence. 'establish' is a real
     answer and the right one more often than people expect: with one
     session of history there is nothing to compare against, and saying
     so is better than dressing a guess up as a recommendation. */
  function recommend(opts) {
    opts = opts || {};
    var history = opts.history || [];
    var pres = opts.pres || { min: 8, max: 12, rir: 3 };
    var loads = opts.loads || [];
    var sessions = countSessions(history);

    if (opts.tracking && opts.tracking !== 'reps') {
      return {
        action: 'establish', load: null, min: pres.min, max: pres.max, rir: pres.rir,
        confidence: 'none',
        why: 'Timed and distance work is not projected from a rep max. Reach the top of the ' +
             'target with steady form, then change the difficulty deliberately.'
      };
    }

    if (!sessions) {
      return {
        action: 'establish', load: null, min: pres.min, max: pres.max, rir: pres.rir,
        confidence: 'none',
        why: 'First time logging this. Pick a load you could stop ' +
             (pres.rir === null || pres.rir === undefined ? 'comfortably short of failure' :
              pres.rir + ' reps short of failure') +
             ' and the next session has something to work from.'
      };
    }

    var last = lastLoad(history);

    if (opts.bodyweight || !last) {
      var top = Math.max.apply(null, history.map(function (h) { return Number(h.reps) || 0; }));
      return {
        action: top >= pres.max ? 'progress_variation' : 'add_reps',
        load: null, min: pres.min, max: pres.max, rir: pres.rir,
        confidence: sessions >= 2 ? 'medium' : 'low',
        why: top >= pres.max
          ? 'You are at the top of the range with bodyweight. Move to a harder variation rather ' +
            'than adding reps indefinitely — endless reps stop training strength.'
          : 'Build toward ' + pres.max + ' reps before changing anything.'
      };
    }

    if (struggled(history, pres)) {
      var down = bracket(loads, last * 0.92).below;
      return {
        action: 'reduce',
        load: (down !== null && down < last) ? down : last,
        min: pres.min, max: pres.max, rir: pres.rir,
        confidence: 'medium',
        why: (down !== null && down < last)
          ? 'Last time came in under the target. Back to ' + down + ' lb and rebuild from there.'
          : 'Last time came in under the target and there is nothing lighter to select. Hold ' +
            last + ' lb and aim for clean reps rather than more weight.'
      };
    }

    var strength = currentStrength(history);
    var conf = sessions >= 4 ? 'high' : sessions >= 2 ? 'medium' : 'low';

    if (earnedIncrease(history, pres)) {
      var up = nextLoadUp(loads, last);
      if (up === null) {
        return {
          action: 'add_reps', load: last, min: pres.min, max: pres.max, rir: pres.rir,
          confidence: conf,
          why: 'You have earned more weight and there is nothing heavier to select. Add reps, ' +
               'or slow the tempo down.'
        };
      }
      if (jumpIsTooBig(last, up)) {
        return {
          action: 'add_reps', load: last, min: pres.min, max: pres.max, rir: pres.rir,
          confidence: conf,
          why: 'You have earned more weight, but the next step is ' + up + ' lb — a ' +
               Math.round(((up - last) / last) * 100) + '% jump. Stay at ' + last +
               ' and build reps until that is reachable.'
        };
      }
      return {
        action: 'increase', load: up, min: pres.min, max: pres.min + 2, rir: pres.rir,
        confidence: conf,
        why: 'Two clean sessions at the top of the range. Go to ' + up +
             ' lb and start back at the bottom of it.'
      };
    }

    /* Nothing has been earned and nothing has gone wrong: repeat, and
       say what would move it on. Predicting a load from e1RM here would
       be overriding a rule that exists precisely to stop weekly churn. */
    var target = null;
    if (strength) {
      var pctAt = pctOf1RM(pres.max + (pres.rir || 0));
      if (pctAt) target = (strength * pctAt) / 100;
    }
    var suggest = target ? bracket(loads, target).below : null;

    return {
      action: 'hold',
      load: last, min: pres.min, max: pres.max, rir: pres.rir,
      confidence: conf,
      estimated1RM: strength ? Math.round(strength) : null,
      why: 'Repeat ' + last + ' lb. Every set at ' + pres.max + ' reps with ' +
           (pres.rir === null || pres.rir === undefined ? 'clean form' : pres.rir + ' in reserve') +
           ', twice in a row, earns the next load up' +
           (suggest && suggest > last ? ' — your recent sets suggest ' + suggest +
            ' lb is already within reach.' : '.')
    };
  }

  return {
    PCT: PCT, BIG_JUMP: BIG_JUMP,
    pctOf1RM: pctOf1RM, e1rm: e1rm, setConfidence: setConfidence,
    sessionBests: sessionBests, strengthTrend: strengthTrend, currentStrength: currentStrength,
    bracket: bracket, nextLoadUp: nextLoadUp, jumpIsTooBig: jumpIsTooBig,
    earnedIncrease: earnedIncrease, struggled: struggled, lastLoad: lastLoad,
    countSessions: countSessions, recommend: recommend
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Progress;
