'use strict';

/* =============================================================
   WEIGHT — CHARTS
   Hand-rolled SVG strings. No charting library: the whole app is
   four files and works offline on a plane, and a weight chart is
   two polylines and some ticks.
   ============================================================= */

var Chart = (function () {

  var W = 340, H = 190;
  var PAD = { t: 10, r: 8, b: 22, l: 32 };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function n(v) { return Math.round(v * 100) / 100; }

  function open(w, h) {
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" ' +
      'preserveAspectRatio="xMidYMid meet" role="img" style="width:100%;height:auto">';
  }

  /* Round a range outward to friendly tick values. */
  function niceScale(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, step: 1 };
    if (min === max) { min -= 1; max += 1; }
    var span = max - min;
    var raw = span / (count || 4);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step: step };
  }

  function shortDate(key) {
    var d = WL.fromKey(key);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* ---------------------------------------------------------------
     WEIGHT — raw weigh-ins as dots, trend as the line, goal dashed.
     The dots are deliberately faint: the point of the chart is that
     the scatter is noise and the line is the truth.
     --------------------------------------------------------------- */
  function weight(series, opts) {
    opts = opts || {};
    if (!series || series.length === 0) {
      return '<p class="empty">Log a few weigh-ins and the trend appears here.</p>';
    }

    var xs = series.map(function (p) { return WL.daysBetween(series[0].date, p.date); });
    var maxX = Math.max(1, xs[xs.length - 1]);

    var vals = [];
    series.forEach(function (p) { vals.push(p.weight, p.trend); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);

    /* A goal 20lb below the data would stretch the axis until the trend
       reads as a flat line, which is exactly the information the chart
       exists to show. Let the goal widen the view only so far; past that
       it becomes a tag at the edge instead. */
    var goal = (typeof opts.goal === 'number' && isFinite(opts.goal)) ? opts.goal : null;
    var goalOff = null;
    if (goal !== null) {
      var allow = Math.max((hi - lo) * 0.6, 2);
      if (goal >= lo - allow && goal <= hi + allow) {
        lo = Math.min(lo, goal); hi = Math.max(hi, goal);
      } else {
        goalOff = goal < lo ? 'below' : 'above';
      }
    }

    var padY = Math.max(0.5, (hi - lo) * 0.12);
    var sc = niceScale(lo - padY, hi + padY, 4);

    var iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    function px(x) { return PAD.l + (x / maxX) * iw; }
    function py(v) { return PAD.t + ih - ((v - sc.min) / (sc.max - sc.min)) * ih; }

    var s = open(W, H);

    for (var v = sc.min; v <= sc.max + 1e-9; v += sc.step) {
      var y = n(py(v));
      s += '<line class="gridline" x1="' + PAD.l + '" y1="' + y + '" x2="' + (W - PAD.r) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (PAD.l - 5) + '" y="' + (y + 3) + '" text-anchor="end">' +
        (sc.step < 1 ? v.toFixed(1) : Math.round(v)) + '</text>';
    }

    if (goal !== null && goalOff === null && goal >= sc.min && goal <= sc.max) {
      var gy = n(py(goal));
      s += '<line class="goalline" x1="' + PAD.l + '" y1="' + gy + '" x2="' + (W - PAD.r) + '" y2="' + gy + '"/>';
    } else if (goalOff) {
      s += '<text class="goaltag" x="' + (W - PAD.r) + '" y="' +
        (goalOff === 'below' ? H - PAD.b - 4 : PAD.t + 9) + '" text-anchor="end">goal ' +
        (Math.round(goal * 10) / 10) + (goalOff === 'below' ? ' \u2193' : ' \u2191') + '</text>';
    }

    for (var i = 0; i < series.length; i++) {
      s += '<circle class="raw" cx="' + n(px(xs[i])) + '" cy="' + n(py(series[i].weight)) + '" r="1.8"/>';
    }

    var d = '';
    for (i = 0; i < series.length; i++) {
      d += (i ? 'L' : 'M') + n(px(xs[i])) + ' ' + n(py(series[i].trend));
    }
    s += '<path class="trendline" d="' + d + '"/>';

    s += '<line class="axis" x1="' + PAD.l + '" y1="' + (H - PAD.b) + '" x2="' + (W - PAD.r) + '" y2="' + (H - PAD.b) + '"/>';
    s += '<text class="tick" x="' + PAD.l + '" y="' + (H - PAD.b + 13) + '">' + esc(shortDate(series[0].date)) + '</text>';
    s += '<text class="tick" x="' + (W - PAD.r) + '" y="' + (H - PAD.b + 13) + '" text-anchor="end">' +
      esc(shortDate(series[series.length - 1].date)) + '</text>';

    return s + '</svg>';
  }

  /* ---------------------------------------------------------------
     INTAKE — one bar per day against the target line. Bars over the
     line are coloured, because the only thing worth seeing here is
     which days ran over and by how much.
     --------------------------------------------------------------- */
  function intake(days, opts) {
    opts = opts || {};
    if (!days || !days.length) {
      return '<p class="empty">Log some food and the days appear here.</p>';
    }
    var target = opts.target || 0;
    var maxV = Math.max(target * 1.25, 1);
    days.forEach(function (d) { if (d.kcal > maxV) maxV = d.kcal; });
    var sc = niceScale(0, maxV, 3);

    var iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    var slot = iw / days.length, bw = Math.max(2, slot * 0.62);
    function py(v) { return PAD.t + ih - (v / sc.max) * ih; }

    var s = open(W, H);

    for (var v = sc.min; v <= sc.max + 1e-9; v += sc.step) {
      var y = n(py(v));
      s += '<line class="gridline" x1="' + PAD.l + '" y1="' + y + '" x2="' + (W - PAD.r) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (PAD.l - 5) + '" y="' + (y + 3) + '" text-anchor="end">' + Math.round(v) + '</text>';
    }

    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (!d.kcal) continue;
      var x = PAD.l + slot * i + (slot - bw) / 2;
      var top = n(py(d.kcal));
      var over = target > 0 && d.kcal > target;
      s += '<rect class="barfill' + (over ? ' over' : '') + '" x="' + n(x) + '" y="' + top +
        '" width="' + n(bw) + '" height="' + n(H - PAD.b - top) + '" rx="1"/>';
    }

    if (target > 0 && target <= sc.max) {
      var ty = n(py(target));
      s += '<line class="targetline" x1="' + PAD.l + '" y1="' + ty + '" x2="' + (W - PAD.r) + '" y2="' + ty + '"/>';
    }

    s += '<line class="axis" x1="' + PAD.l + '" y1="' + (H - PAD.b) + '" x2="' + (W - PAD.r) + '" y2="' + (H - PAD.b) + '"/>';
    s += '<text class="tick" x="' + PAD.l + '" y="' + (H - PAD.b + 13) + '">' + esc(shortDate(days[0].date)) + '</text>';
    s += '<text class="tick" x="' + (W - PAD.r) + '" y="' + (H - PAD.b + 13) + '" text-anchor="end">' +
      esc(shortDate(days[days.length - 1].date)) + '</text>';

    return s + '</svg>';
  }

  return { weight: weight, intake: intake, niceScale: niceScale, esc: esc };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Chart;
