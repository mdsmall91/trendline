# Workout data

Extracted from the two source Markdown files, which remain the editable
originals. Regenerate rather than hand-editing these:

```
index.md                → exercises.json   (catalog: 51 exercises + taxonomy)
workout-combinations.md → workouts.json    (10 sessions, 4 programs, combos)
equipment.json          → written here; what this gym can actually select
```

Extract from the source files by their HTML-comment markers, not by the
first occurrence of the marker text — both markers are also named in prose
earlier in each document, and slicing on that finds an empty region.

## What was checked

Every substitution, session item, combination and schedule reference
resolves to a real id. Every exercise is satisfiable with the equipment in
`home_gym.equipment`. Nothing dangles.

## Browsing by body part excludes cardio

The four cardio machines list `quadriceps` and `gluteus_maximus` as primary
muscles, which is defensible but makes the elliptical show up under
"glutes". Excluding `body_part == "cardio"` from muscle-based browsing
reproduces the coverage table in `index.md` exactly — all twelve rows — so
that exclusion is the documented intent, not a workaround.

## Why equipment.json exists

Progression is only useful if it recommends a load that can actually be
selected. The dumbbells are 5, 10, 15, 25, 35 — the 15 to 25 gap is a 67%
jump on a one-arm lift, so reps have to carry progression across it rather
than load. The medicine balls, at even 5 lb steps, are the only implement
here where a textbook small increment exists.

Two things that make stack numbers non-comparable and are recorded rather
than folded away:

* The low cable runs through a bottom pulley that splits the load, so 100
  on the stack is about 50 lb at the handle. Logs keep the **displayed**
  stack number, because that is what gets set on the machine next session;
  the ratio is there so effective load can be shown beside it and so a
  low-cable row is never compared against a high-cable pulldown.
* The Hoist free bar weighs about 25 lb on its own (user estimate, not a
  measurement), so a bar-only set is not zero. Held as its own field: if
  the real figure differs, one number changes and no history is rewritten.
