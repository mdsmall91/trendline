# Trendline — UX review brief

A personal weight, nutrition and training tracker. Built for one user, running in
production, and now dense enough in places that it needs an outside read.

| | |
| --- | --- |
| **The app, live** | <https://mdsmall91.github.io/trendline/> |
| **Source** | <https://github.com/mdsmall91/trendline> |

Both are public. Nothing to request, no account needed to read either.

Roughly 60 files. Vanilla JavaScript, no framework and no build step — open
`index.html` and that is the whole app. Markup in `index.html`, all interaction
in `js/ui.js`, every design token at the top of `styles/app.css`.

---

## What it does

It tracks bodyweight, food, water, steps and strength training, and uses them to
estimate how many calories the person actually burns — energy balance run
backwards over a trailing window, rather than a formula. Everything else on the
page hangs off that number.

It is **local-first**. The browser holds the data; an account only mirrors it to
a second device. That matters for your review: *you can use almost all of it
immediately, with no sign-up.*

Three tabs at the bottom — Today, Trend, Train — with Foods, Habits and Setup
behind a menu at the top left. It is a phone app that also runs on a desktop.
**Review it at phone width.**

Three features do need a signed-in account, because they call a server: syncing
to a second device, the paste-a-link reader, and the photograph-a-plate reader.
Say the word if you want credentials for those.

---

## The ask: run the tasks, count the cost

We are not looking for a list of heuristic violations. We are looking for the
places where a real task costs more than it should — **run each scenario below
end to end, as the person would, and record what it took.**

Every run happens on a phone-width screen, one-handed where the scenario says so,
against a copy of the app you have used for a few days rather than an empty one.
Several of these only bite on the tenth repetition.

**Record.** Taps and screens to completion. Where you stopped to think, and what
about. Every dead end, backtrack, or moment you were unsure the app had
understood you. The shortest path you found afterwards, if it differs from the
one you took first.

**Report.** Per scenario: the cost you measured, the cost you think it should be,
and the specific change that closes the gap. A finding without a proposed change
is half a finding.

**Ground it.** Against established practice, named: WCAG 2.2 AA for contrast,
target size and focus order; iOS conventions for a home-screen web app, including
thumb reach and the keyboard covering the lower third; and the usual heuristics
where they earn their keep — recognition over recall, undo over confirmation,
visible system state. Where our own constraints below cut against a convention,
say so rather than working around it silently; that tension is worth having on
the record.

### The scenarios

**1. Coffee and a bagel, walking.**
Both already in the library from previous days. One hand, moving, twenty seconds
of attention. This is the most common interaction in the whole app and the one
most worth shaving.
*Target: two foods logged without stopping.*

**2. Chicken breast, weighed.**
On a kitchen scale, 6.4 oz, a food the app has never seen. Involves a lookup, a
unit change, and — the first time — the app asking what a serving weighs.
*Watch for: where the unit question interrupts.*

**3. A restaurant meal with no barcode.**
USDA has nothing useful. The intended route is pasting the restaurant's own
nutrition page. Does anything in the interface lead you there, or do you have to
already know?
*Watch for: the moment search fails and you are stranded.*

**4. The same recipe, twice.**
Log a recipe from a blog link on Monday. Log it again on Thursday. The second
time should cost almost nothing — check that it does, and that you did not end up
with two copies of the same food.
*Watch for: duplicates, and re-entering what was already known.*

**5. A full gym session.**
Five exercises, four sets each, logged as you go. Phone on a bench, one hand,
between sets. Twenty small interactions in forty minutes — this is where friction
multiplies.
*Target: a set logged in under three taps.*

**6. Correcting yesterday.**
Last night's dinner was logged at 6 oz; it was closer to 10. Find it, change it,
confirm the day's totals moved.
*Watch for: whether editing feels as cheap as adding.*

**7. Two days behind.**
A weekend went unlogged. Catch up on Monday. Backfilling means changing the date
repeatedly, and the app is built around "today".
*Watch for: the date control under sustained use.*

**8. Water, eight times.**
Logged in small amounts across a day, each one a five-second interruption. Cheap
individually; the question is whether it stays cheap by the eighth.
*Target: no more than two taps, from cold.*

**9. "Is my iron low?"**
A question the person actually asks. Find the answer, work out whether it is a
real shortfall or just missing data, and decide what to do next. This tests
reading, not entering.
*Watch for: whether coverage clarifies or muddies.*

**10. Day one.**
A private window, nothing logged. Get to the point where the app is telling you
something useful. Note everything that looks broken but is merely empty.
*Watch for: the gap between "set up" and "useful".*

---

## What changed since this brief was written

A first pass has been made against an outside read of the scenarios below.
Run them against the current app, not the one described in the paragraphs
above — several of the costs this brief was written to measure have already
moved.

**Today is reordered.** Budget, then a Quick add strip of the four foods
most likely to be logged right now, then Food, then macros, weight, water,
micronutrients, habits, note. Weight folds to one line once it is in.
Water shows two quick amounts with the rest behind *More*.

**Quick add is the primary route.** One tap logs a food at the amount it
is usually logged in, with an *Added · Undo* line. The pencil beside it
opens the amount editor.

**The `+` is now a labelled button** reading *Add food another way*. The
five-route sheet behind it is unchanged.

**A search that comes back thin says where else to look**, in place:
scan the package, paste a nutrition link, type the numbers. Both in the
composer and after a USDA miss.

**The composer no longer carries amount and unit.** There is one amount
editor, opened deliberately, reachable from a quick-add pencil, a typed
suggestion, a logged line, or a lookup result. Logged rows now say
*Edit*.

**As-you-type suggestions were being rendered into a hidden container**
and had not been visible since the add sheet was built. Fixed.

**The still-photo barcode route is now the primary button**, with the
live camera second.

**A nutrition panel can be photographed** instead of typed, from the By
hand route — which is the only way the micronutrients ever get filled in
for a packaged food.

**A catch-up strip** opens from the date: the last week, with a dot on
the days that have anything in them, one tap to any of them.

## Known rough edges

Reported from daily use — no need to rediscover these.

**USDA search is about half useful.**
The free food database is generic and weak on brands. When it misses, the
routes that answer are a barcode or a pasted link. Those are now offered at
the moment of the miss; whether the wording gets anybody to take them is
exactly the sort of thing this review should say.

**Barcode autocapture is unreliable.**
The live camera preview often fails to catch a code. A still photo decodes far
more often and is now the primary button, with the camera second.

**Steps arrive from outside the app.**
A separate iPhone app pushes step counts in. It cannot run overnight — iOS
forbids reading Health while the phone is locked — so today's figure is often
stale, and the app has to say so without sounding broken.

---

## Constraints worth knowing before you propose

Some of these are deliberate and expensive to give up.

**Honesty first.**
The app refuses to state what it cannot support. It won't show a burn estimate
under 75% logging coverage, won't score total sugars against a daily value meant
for added sugar, and marks a nutrient nobody measured as *absent* rather than
zero. "Just show a number" is usually a proposal to break this, and it will be
declined — but a proposal to make a refusal **read better** is very welcome.

**One user.**
No onboarding funnel, no accounts to manage, no growth surface. Optimise for the
hundredth use, not the first.

**Offline.**
It must work in a gym basement with no signal. Anything that needs the network —
food lookup, the link reader, the plate photo — is an addition that degrades
gracefully, never a dependency.

**No framework.**
Plain HTML, CSS and JavaScript, deliberately. A redesign that assumes React or a
component library is not implementable here. Tokens and utility classes are fine
and already exist.

**Both themes.**
Light and dark, following the phone. Any colour proposal needs to hold in both.

---

## Questions we would most like answered

Beyond anything else you find:

- Does coverage — "38% of your iron, from 30% of today's calories" — read as
  useful precision, or as noise that undermines the number beside it? This one
  is untouched and still open.
- Four quick-add foods, ranked by frequency discounted by a fortnight's
  half-life. Is four the right number, is the half-life right, and does the
  ranking put the right thing first on a Tuesday morning?
- Logging is now a commit with an Undo rather than a confirm. Is six seconds
  long enough to notice a wrong tap while walking?
- The amount editor is one sheet doing four jobs — a new lookup result, a
  library food at an unusual amount, a logged line being corrected, and the
  serving-weight question. Does it still read as one thing?
- Quick add takes the space directly under the calorie number. Is that the
  right trade against the Food composer sitting at the fold?

---

## Out of scope

Please don't spend time on:

- Visual identity or branding — the palette and type are settled and not the
  problem.
- Marketing, landing pages, onboarding funnels. There is one user and he is
  already using it.
- Backend architecture, sync design, or the database schema.
- Feature proposals that require a native app, a framework, or a paid API.

---

*Trendline · local-first PWA · 810 tests across 10 suites*
