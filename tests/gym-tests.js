'use strict';

/* Tests for the gym catalog layer. Fixtures are injected rather than
   fetched, so this runs offline and deterministically. The fixture is
   a trimmed copy of the real catalog's shape. */

(function (root) {
  var Gym = root.Gym || require('../js/gym.js');
  var failures = [], passes = 0;

  function check(name, cond, detail) {
    if (cond) passes++;
    else failures.push({ test: name, detail: detail === undefined ? '' : String(detail) });
  }
  function eq(name, got, want) { check(name, got === want, got + ' vs ' + want); }

  var CAT = {
    home_gym: { equipment: ['dumbbell', 'flat_bench', 'hoist_low_cable', 'hoist_high_cable',
                            'hoist_weight_stack', 'hoist_free_bar', 'curl_bar', 'weight_plates',
                            'medicine_ball', 'elliptical_machine'] },
    taxonomy: {
      body_parts: ['chest', 'back', 'biceps', 'quads', 'glutes', 'cardio'],
      body_part_aliases: { arms: ['biceps'], legs: ['quads', 'glutes'] },
      body_part_muscles: {
        chest: ['pectoralis_major'], back: ['latissimus_dorsi'],
        biceps: ['biceps', 'brachialis'], quads: ['quadriceps'],
        glutes: ['gluteus_maximus'], cardio: ['quadriceps', 'gluteus_maximus']
      }
    },
    exercises: [
      { id: 'ex_db_curl', name: 'Dumbbell curl', aliases: ['bicep curl'], body_part: 'biceps',
        primary_muscles: ['biceps', 'brachialis'], secondary_muscles: [],
        movement_pattern: 'elbow_flexion', equipment: ['dumbbell'], difficulty: 'beginner',
        laterality: 'bilateral', mechanic: 'isolation', tracking_mode: 'reps',
        substitutions: [{ exercise_id: 'ex_curl_bar_curl', relationship: 'same_pattern', reason: 'r' }] },
      { id: 'ex_curl_bar_curl', name: 'Plate-loaded curl-bar curl', aliases: [], body_part: 'biceps',
        primary_muscles: ['biceps'], secondary_muscles: [], movement_pattern: 'elbow_flexion',
        equipment: ['curl_bar', 'weight_plates'], difficulty: 'beginner',
        laterality: 'bilateral', mechanic: 'isolation', tracking_mode: 'reps', substitutions: [] },
      { id: 'ex_row', name: 'Seated cable row', aliases: [], body_part: 'back',
        primary_muscles: ['latissimus_dorsi'], secondary_muscles: ['biceps'],
        movement_pattern: 'horizontal_pull',
        equipment: ['hoist_low_cable', 'hoist_weight_stack'], difficulty: 'beginner',
        laterality: 'bilateral', mechanic: 'compound', tracking_mode: 'reps',
        substitutions: [{ exercise_id: 'ex_db_curl', relationship: 'partial_alternative', reason: 'r' }] },
      { id: 'ex_pulldown', name: 'Lat pulldown', aliases: [], body_part: 'back',
        primary_muscles: ['latissimus_dorsi'], secondary_muscles: ['biceps'],
        movement_pattern: 'vertical_pull',
        equipment: ['hoist_high_cable', 'hoist_weight_stack'], difficulty: 'beginner',
        laterality: 'bilateral', mechanic: 'compound', tracking_mode: 'reps', substitutions: [] },
      { id: 'ex_hoist_squat', name: 'Hoist free-bar squat', aliases: [], body_part: 'quads',
        primary_muscles: ['quadriceps', 'gluteus_maximus'], secondary_muscles: [],
        movement_pattern: 'squat', equipment: ['hoist_free_bar', 'hoist_weight_stack'],
        difficulty: 'intermediate', laterality: 'bilateral', mechanic: 'compound',
        tracking_mode: 'reps', substitutions: [] },
      { id: 'ex_one_arm_row', name: 'One-arm dumbbell row', aliases: [], body_part: 'back',
        primary_muscles: ['latissimus_dorsi'], secondary_muscles: [],
        movement_pattern: 'horizontal_pull', equipment: ['dumbbell', 'flat_bench'],
        difficulty: 'beginner', laterality: 'unilateral', mechanic: 'compound',
        tracking_mode: 'reps', substitutions: [] },
      { id: 'ex_slam', name: 'Medicine-ball slam', aliases: [], body_part: 'quads',
        primary_muscles: ['quadriceps'], secondary_muscles: [],
        movement_pattern: 'ballistic_slam', equipment: ['medicine_ball'],
        difficulty: 'beginner', laterality: 'bilateral', mechanic: 'compound',
        tracking_mode: 'reps', substitutions: [] },
      /* Cardio lists quads and glutes as primary — true, and the reason
         it has to be excluded from muscle browsing. */
      { id: 'ex_elliptical', name: 'Precor elliptical trainer', aliases: [], body_part: 'cardio',
        primary_muscles: ['quadriceps', 'gluteus_maximus'], secondary_muscles: [],
        movement_pattern: 'cyclic_elliptical', equipment: ['elliptical_machine'],
        difficulty: 'beginner', laterality: 'bilateral', mechanic: 'compound',
        tracking_mode: 'minutes', substitutions: [] },
      /* Needs kit that is not in home_gym.equipment. */
      { id: 'ex_sled', name: 'Sled push', aliases: [], body_part: 'quads',
        primary_muscles: ['quadriceps'], secondary_muscles: [],
        movement_pattern: 'squat', equipment: ['sled'], difficulty: 'advanced',
        laterality: 'bilateral', mechanic: 'compound', tracking_mode: 'meters', substitutions: [] }
    ]
  };

  var TPL = { sessions: [{ id: 's1', name: 'Test session', items: [] }], programs: [] };

  var KIT = {
    dumbbell: { each_lb: [5, 10, 15, 25, 35] },
    medicine_ball: { each_lb: [10, 15, 20, 25, 30, 35] },
    weight_plates: { total_available_lb: 225 },
    hoist_free_bar: { bar_weight_lb: 30 },
    curl_bar: { bar_weight_lb: 25 },
    hoist_weight_stack: {
      max_lb: 200,
      mechanical_ratio: { hoist_free_bar: 1.0, hoist_high_cable: 1.0, hoist_low_cable: 0.5 }
    }
  };

  Gym._inject(CAT, TPL, KIT);

  /* ---------- search ---------- */

  var b = Gym.search('biceps');
  eq('body part search is recognised as such', b.mode, 'muscle');
  eq('biceps trains two things directly', b.primary.length, 2);
  check('the curls are the direct answers',
    b.primary.map(function (e) { return e.id; }).sort().join(',') === 'ex_curl_bar_curl,ex_db_curl',
    b.primary.map(function (e) { return e.id; }).join(','));
  eq('rows involve biceps without training them', b.secondary.length, 2);

  /* The whole reason cardio is excluded: it lists quads and glutes as
     primary, so a leg search would otherwise return the elliptical. */
  var q = Gym.search('quads');
  check('quads excludes the elliptical',
    q.primary.map(function (e) { return e.id; }).indexOf('ex_elliptical') < 0,
    q.primary.map(function (e) { return e.id; }).join(','));
  check('glutes excludes the elliptical too',
    Gym.search('glutes').primary.map(function (e) { return e.id; }).indexOf('ex_elliptical') < 0);
  /* But asking for cardio by name must still return the machines. */
  check('cardio by name returns the machines',
    Gym.search('cardio').primary.map(function (e) { return e.id; }).indexOf('ex_elliptical') >= 0);

  eq('an alias maps to its parts', Gym.search('arms').primary.length, 2);
  eq('legs covers quads and glutes', Gym.search('legs').mode, 'muscle');

  var t = Gym.search('curl');
  eq('free text is not a muscle search', t.mode, 'text');
  check('free text finds the curls', t.primary.length >= 2, t.primary.length);
  check('an alias is searchable',
    Gym.search('bicep curl').primary.map(function (e) { return e.id; }).indexOf('ex_db_curl') >= 0);
  check('a movement pattern is searchable',
    Gym.search('vertical pull').primary.map(function (e) { return e.id; }).indexOf('ex_pulldown') >= 0);
  check('equipment is searchable',
    Gym.search('dumbbell').primary.length >= 2, Gym.search('dumbbell').primary.length);
  eq('an empty query returns everything', Gym.search('').primary.length, CAT.exercises.length);
  eq('nonsense returns nothing', Gym.search('zzzz').primary.length, 0);

  /* ---------- availability ---------- */

  check('an owned exercise is available', Gym.available(Gym.byId('ex_db_curl')));
  check('an exercise needing a sled is not', !Gym.available(Gym.byId('ex_sled')));
  check('the equipment filter hides it',
    Gym.search('', { equipmentOnly: true }).primary.length === CAT.exercises.length - 1);

  /* ---------- substitutions ---------- */

  var subs = Gym.substitutes('ex_db_curl');
  eq('a substitution resolves to an exercise', subs.length, 1);
  check('same-pattern is flagged as such', subs[0].samePattern === true);
  var partial = Gym.substitutes('ex_row');
  check('a partial alternative is NOT flagged same-pattern', partial[0].samePattern === false);

  /* ---------- loads ----------
     The point of all of this: recommend a weight that exists. */

  var dbBilateral = Gym.selectableLoads(Gym.byId('ex_db_curl'));
  check('a bilateral dumbbell lift offers singles and pairs',
    dbBilateral.indexOf(5) >= 0 && dbBilateral.indexOf(70) >= 0, dbBilateral.join(','));
  var dbUni = Gym.selectableLoads(Gym.byId('ex_one_arm_row'));
  check('a one-arm lift offers only single dumbbells',
    dbUni.indexOf(70) < 0 && dbUni.indexOf(35) >= 0, dbUni.join(','));
  check('the 15 to 25 gap is real and has nothing between it',
    dbUni.indexOf(20) < 0 && dbUni.indexOf(15) >= 0 && dbUni.indexOf(25) >= 0, dbUni.join(','));

  var ball = Gym.selectableLoads(Gym.byId('ex_slam'));
  eq('medicine balls run in even fives', ball.join(','), '10,15,20,25,30,35');

  var stack = Gym.selectableLoads(Gym.byId('ex_pulldown'));
  check('the stack stops at its maximum', stack[stack.length - 1] === 200, stack[stack.length - 1]);
  check('loads never repeat a value', (function () {
    var seen = {};
    for (var i = 0; i < dbBilateral.length; i++) {
      if (seen[dbBilateral[i]]) return false;
      seen[dbBilateral[i]] = 1;
    }
    return true;
  })());
  check('loads come back ascending', (function () {
    for (var i = 1; i < stack.length; i++) if (stack[i] <= stack[i - 1]) return false;
    return true;
  })());

  /* ---------- mechanical reality ---------- */

  eq('the low cable halves the load', Gym.loadRatio(Gym.byId('ex_row')), 0.5);
  eq('the high cable does not', Gym.loadRatio(Gym.byId('ex_pulldown')), 1);
  eq('a dumbbell has no ratio', Gym.loadRatio(Gym.byId('ex_db_curl')), 1);

  eq('the Hoist bar weighs 30', Gym.barWeight(Gym.byId('ex_hoist_squat')), 30);
  eq('the curl bar weighs 25', Gym.barWeight(Gym.byId('ex_curl_bar_curl')), 25);
  eq('a dumbbell has no bar', Gym.barWeight(Gym.byId('ex_db_curl')), 0);

  /* 100 on the stack at a low-cable handle is about 50 lb. */
  eq('low-cable effective load halves', Gym.effectiveLoad(Gym.byId('ex_row'), 100), 50);
  /* A free-bar set adds the bar on top of the stack setting. */
  eq('free-bar effective load adds the bar', Gym.effectiveLoad(Gym.byId('ex_hoist_squat'), 100), 130);
  eq('a bar-only set is not zero', Gym.effectiveLoad(Gym.byId('ex_hoist_squat'), 0), 30);
  eq('a dumbbell is what it says', Gym.effectiveLoad(Gym.byId('ex_db_curl'), 25), 25);
  eq('a negative load is rejected', Gym.effectiveLoad(Gym.byId('ex_db_curl'), -5), null);

  check('the low-cable note explains the halving',
    /halv/i.test(Gym.loadNote(Gym.byId('ex_row'))), Gym.loadNote(Gym.byId('ex_row')));
  check('a plain dumbbell needs no note', Gym.loadNote(Gym.byId('ex_db_curl')) === '');

  var summary = { passes: passes, failures: failures.length, detail: failures };
  root.__results = summary;
  if (typeof document !== 'undefined') {
    var el = document.getElementById('out');
    if (el) {
      el.textContent = JSON.stringify(summary, null, 2);
      el.className = failures.length ? 'fail' : 'pass';
    }
  } else {
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 1;
  }
})(typeof window !== 'undefined' ? window : globalThis);
