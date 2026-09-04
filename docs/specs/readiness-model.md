# Design Spec: Readiness Model (issue #108, epic #55 / E6 "Readiness and Progress")

This is the durable design for E6: the epic that finally answers the question
every earlier epic has been collecting evidence *for* — "how ready is this
learner, really, and what should they do about it" — without ever assuming an
answer it cannot defend. E3 (`docs/specs/practice-sessions.md`) shipped the
evidence ledger, `practice_attempts`. E5 (`docs/specs/memory-model.md`) shipped
`question_mastery`, the derived, per-question verdict on whether a fact is
actually known. Neither one computes a single number a learner can look at and
trust. This document is what does: the eight-component weighted score, the
structural reason it can never overclaim itself, `readiness_snapshots`, the
pure engine that computes one, the two places that engine is ever called from,
and the stage transitions and recommendation a snapshot produces as a
byproduct of existing.

Source of truth for every claim below:

- [Epic #55](https://github.com/marinoscar/oathpath/issues/55) itself — the
  eight-component weight table, the cap clause, the `readiness_snapshots`
  column list, and the explicit out-of-scope list (§10) this document does not
  reach into. Quoted verbatim at the point each decision is spent, never
  restated in this document's own words where the original wording is the
  contract.
- `PRD.md` — "A user who correctly answers ten questions immediately after
  studying them should not appear highly ready" (`docs/specs/memory-model.md`
  already spends this sentence on `distinctCorrectDays`; §2.3 below spends it
  again on `consistency`, deliberately, because it is the same durability
  argument applied one layer up). The worked mock-interview line §3 quotes
  verbatim is also PRD.md's own words, not paraphrase.
- `VISION.md` — "mastery is verified rather than assumed" — the sentence
  E5's own document already spends on `distinctCorrectDays`; this document
  extends the same discipline to an aggregate score, which is why §2 refuses
  to let three structurally-empty components silently inflate it (§2.9).
- `ROADMAP.md` §7 ("Cross-cutting rules") — "All AI goes through
  `AiDispatchService.run`... no background job may call AI on a user's key"
  (§9 below), "No job queue... [scheduling and readiness recompute] run
  synchronously, inside the request or transaction that produces the
  evidence... [and on] `@nestjs/schedule` cron, following the
  `token-cleanup.task.ts` pattern" (§7 below), "One evidence table" (§1), and
  "Engagement never moves readiness... A long streak and a high readiness
  score answer two different questions, and the product must never let one
  stand in for the other" (§2.4, §11) — quoted verbatim at each point spent,
  not re-derived.
- `ROADMAP.md` §9 (decision log, 2026-09-02 entries) — "Voice is inside the
  MVP, not after it. E6's readiness model caps a learner's score while there
  is no spoken-answer evidence and no mock-interview evidence" (§2.9, §3) and
  "Every journey stage has an owning epic... `performing → ready` belongs to
  E6 (#55) — `ready` is a readiness judgement and nothing else is entitled to
  make it, requiring both that the score clears its threshold *and* that the
  cap has lifted, so a learner can never reach `ready` on typed answers alone"
  (§8) — both quoted verbatim rather than paraphrased, because the exact
  wording is what a later reader will hold this document to.
- `docs/specs/memory-model.md` §2, §3 — `question_mastery`'s exact columns
  (`state`, `lapses`, `dueAt`) this epic reads, `nextSchedule`'s
  `MasteryState` union, and `apps/api/src/practice/mastery/selector.ts`'s
  `WEAK_LAPSES_THRESHOLD` — reused here by import, per this document's own
  instruction (§2.5), never redeclared.
- `docs/specs/practice-sessions.md` §2.2, §7, §9 — `practice_attempts`'
  exact columns this epic reads (`outcome`, `hintUsed`, `revealed`,
  `answeredAt`, `inputMode`, `source`), the closed `PracticeOutcome` union
  (`correct` \| `partial` \| `incorrect` \| `skipped`), and self-mark's
  `gradingMethod: 'self'` — read here, unweighted by grading method, for the
  same reason §2.2 below states rather than assumes.
- `docs/specs/journey-shell.md` §1, §3.2 — the eight-value `JourneyStage`
  enum this epic reads and writes three more transitions of (§8), and
  `learner_profiles`' own posture toward a value nothing has computed yet
  (§10's honesty rule) — the same posture `capReason` and a not-yet-generated
  `narrative` both take.
- `apps/api/src/journey/stage-transitions.ts` — `nextStageOnMasteryEvent`'s
  exact shape (no Prisma, no Clock, prior/next facts in, a decision out) that
  §8's `nextStageOnReadinessSnapshot` mirrors deliberately, and the file's own
  header comment recording that only `oriented → learning` and
  `learning → remembering` were its concern — E6's three transitions were
  never its job to add.
- `apps/api/src/practice/mastery/scheduler.ts`,
  `apps/api/src/practice/mastery/selector.ts` — `nextSchedule`'s pure-module
  shape this document's own `computeReadiness` copies exactly (§5), and
  `WEAK_LAPSES_THRESHOLD`'s exact value (`2`) and reasoning, imported rather
  than redeclared (§2.5).
- `apps/api/src/auth/tasks/token-cleanup.task.ts` — the exact
  `@Injectable()` + `@Cron(CronExpression...)` shape (§7) the nightly
  readiness pass follows, with no separate "tasks module" anywhere in this
  application.
- `apps/api/src/civics/civics-explain.service.ts` — the shipped `tutor`-role
  call-site pattern (`AiDispatchService.runStream`, grounded in rows already
  read for the feature's own non-AI response, never-throw `unavailable`
  handling) §9 points a later reader at rather than re-describing.
- `CLAUDE.md`'s "Adding an AI feature" and "Journey/Practice/Progress add no
  permission strings, for the same reason" — the exact posture §6's two
  endpoints take, cited by name rather than re-derived.

---

## 1. Where this sits relative to E1, E3, and E5

E1 (`journey-shell.md`) shipped `learner_profiles.stage`, `Clock`, and the
eight-value `JourneyStage` enum with three of its seven consecutive
transitions still unclaimed as of that document's own decision log. E3
(`practice-sessions.md`) shipped `practice_attempts` — "the single evidence
table for the whole product," per that document's own §2.2 header, deliberately
one table rather than two so that "E5's mastery scheduler and E6's readiness
engine each read one evidence source instead of a `UNION` over two"
(ROADMAP.md §7, "One evidence table"). E5 (`memory-model.md`) shipped
`question_mastery` — the *derived*, per-question verdict on whether a fact is
actually known, and the deterministic Study Coach that turns that verdict into
"what should this learner do right now."

**This epic computes nothing E3 or E5 already computes.** It does not decide
whether an individual answer was correct — E3's `matchAnswer` already did
that, irrevocably, at grading time. It does not decide whether an individual
question is mastered — E5's `nextSchedule` already does that, per question,
on every graded attempt. What neither predecessor does, and what this epic
exists to do, is **aggregate**: take the whole shape of a learner's evidence —
how much of the bank they've touched, how reliably they recall it, how much of
what they've touched has actually stuck, how recently, how much of what once
went wrong has since been fixed, and how much of that evidence came from a
mode closer to the real interview than typing into a box — and turn it into
one number, one capped ceiling, one plain-English reason, and one
recommendation, all of them re-derivable from a snapshot alone, forever, even
after the mastery rows and attempt rows that produced it have moved on.

`question_mastery` is read here exactly as it is: `state` and `lapses`, per
row, for the caller's own test version. `practice_attempts` is read here
exactly as it is: the caller's own most recent graded rows, filtered by
`hintUsed`/`revealed`, and their `answeredAt` dates. Nothing in this epic
writes to either table, and nothing in this epic re-derives a fact those two
tables already settle — a `question_mastery` row's `state` is not
re-classified here the way `selector.ts`'s `classifyMasteryBucket` classifies
it into a queue bucket; it is read as-is, as one of eight inputs to a formula
that has never seen a bucket in its life.

---

## 2. The eight components

All eight are normalized to `[0, 1]` before weighting. The weights sum to
exactly `1.00`, and that sum — not a second clamp anywhere in the engine — is
the entire mechanism by which this score can never overclaim itself (§2.9).

| # | `key` | weight | formula | evidence until |
|---|---|---|---|---|
| 1 | `coverage` | 0.15 | `distinctQuestionsAttempted / totalQuestionsInVersion` | now |
| 2 | `recall` | 0.20 | over the most recent 20 qualifying graded attempts: `(correctCount + 0.5·partialCount) / qualifyingCount` | now, floored at 5 qualifying attempts |
| 3 | `retention` | 0.20 | `(masteredCount·1.0 + reviewCount·0.6) / totalAttemptedQuestions` | now |
| 4 | `consistency` | 0.10 | `min(distinctPracticeDaysInLast14, 7) / 7` | now |
| 5 | `remediation` | 0.10 | `remediatedCount / everWeakCount`, or `1.0` if `everWeakCount === 0` | now |
| 6 | `english` | 0.05 | `0.5·min(readingCredit/6, 1) + 0.5·min(writingCredit/4, 1)`, credited per distinct sentence at its best outcome in a trailing 30-day window | now |
| 7 | `spoken` | 0.10 | `min(distinctQuestionsCorrectSpoken / 20, 1)` | now |
| 8 | `interview` | 0.10 | `min(mockInterviewsPassed / 2, 1)` | E8 |
| | | **1.00** | | |

`ReadinessComponentKey` is this table's `key` column, in this order, and the
order is load-bearing beyond readability: it is the tie-break order §8's top
recommendation reads when two components have identical weighted headroom,
and it is the order `evidenceCounts`/`components` are expected to iterate in
on any client that renders them as a list rather than a bar chart.

```ts
export type ReadinessComponentKey =
  | 'coverage'
  | 'recall'
  | 'retention'
  | 'consistency'
  | 'remediation'
  | 'english'
  | 'spoken'
  | 'interview';
```

### 2.1 `coverage` (0.15) — how much of the bank has this learner even touched

`distinctQuestionsAttempted / totalQuestionsInVersion`. "Attempted" means
"has a `question_mastery` row" — the same absence-is-the-default idiom
`memory-model.md` §2 already establishes: a question with no row has never
produced a schedulable outcome, and coverage does not credit a question the
learner has never actually engaged with just because it exists in the bank.
This is the shallowest of the eight components by design — it says nothing
about *quality* of recall, only *breadth* — which is exactly why it carries
the lowest of the five currently-earnable weights (tied with `remediation`)
rather than a larger one: breadth without depth is not what "ready" means.

### 2.2 `recall` (0.20) — the evidence floor, and why one exists

Over the caller's most recent 20 graded `practice_attempts` rows where
`hintUsed = false AND revealed = false`: `(correctCount +
0.5·partialCount) / qualifyingCount`. The `hintUsed`/`revealed` filter is not
incidental — a hint or a reveal is, per `practice-sessions.md` §2.2's own
column comments, "weaker recall evidence than one with no assistance at
all," and `recall` specifically means *unassisted* recall, so an attempt
that was assisted is excluded from this component's denominator entirely
rather than counted and discounted. (`retention`, §2.3, is the component
that *does* read assisted evidence, because retention is asking a different
question — "did it stick" — that a self-marked or hint-assisted correct
still answers honestly.)

**If fewer than 5 qualifying attempts exist, the component value is `0`, but
`evidenceCounts.recall.qualifyingAttempts` reports the true, low count** —
never `0` standing in for "unmeasured." This is the identical honesty
convention `question_mastery`'s absent-row-means-new idiom already
establishes one table over: a learner three unassisted attempts into the
product is not "at 0% recall," which would be a claim about their memory
this product has no basis to make yet; they are "not enough evidence yet,"
which is what the UI renders instead of a percentage, exactly the way
`memory-model.md` §2's `state: 'new'`-by-absence convention lets a reader
distinguish "verified as unknown" from "never checked." Five is not an
arbitrary round number chosen for this document alone — it is the smallest
sample this component's own `0.5`-weighted partial credit can produce a
result finer than 10-percentage-point increments from (`1/5 = 20%` steps),
which is the coarsest granularity this document considers honest to render
as a percentage at all.

### 2.3 `retention` (0.20) — how much of what's been touched has actually stuck

`(masteredCount·1.0 + reviewCount·0.6) / totalAttemptedQuestions`, over
`question_mastery` rows only (a question with no row contributes to neither
the numerator nor the denominator — it is not "attempted," §2.1). `lapsed`
and `learning` rows contribute `0` — a `lapsed` row is, by E5's own state
machine, a *former* `review`/`mastered` row that regressed, and crediting it
here would let a question that has since been forgotten again still count
toward "how much has stuck." `review` earns partial credit (`0.6`, not `1.0`
and not `0`) because E5's own promotion rule (`memory-model.md` §3.1,
`MASTERY_PROMOTION_THRESHOLD`) already defines `mastered` as the verified
state — a `review` row is real, positive evidence of recall, just not yet
verified across the three distinct days E5 requires before it counts as
durable. `0.6` rather than, say, `0.5`, reflects that a `review` row has
already survived at least one real spaced interval (E5's SM-2 progression
never produces `review` from a single lucky guess); it is closer to
"probably known" than to a coin flip.

### 2.4 `consistency` (0.10) — evidence of durability, never an engagement mechanic

`min(distinctPracticeDaysInLast14CalendarDays, 7) / 7`, using
`Clock.calendarDateIn` per `CLAUDE.md`'s Clock rule — a **rolling** 14-day
window, computed fresh on every snapshot, that decays on its own as days pass
with no practice; there is no floor, no protection, and nothing that keeps it
from falling the moment a learner stops.

**This is deliberately not the same fact as E7's `daily_activity`, streaks,
or points, and stating why is required by ROADMAP.md §7's own rule, quoted
here in full because a later reader should not have to trust a summary of
it:**

> **Engagement never moves readiness.** `PRD.md` requires the separation
> explicitly. E7's `daily_activity`, streaks, and points are kept
> structurally out of E6's readiness engine's inputs — not filtered out at
> read time, but never wired in as an input in the first place. A long streak
> and a high readiness score answer two different questions, and the product
> must never let one stand in for the other.

`consistency` does not violate this rule, and the reason is structural, not a
promise this document is merely making: `consistency` is read **only** from
`practice_attempts.answeredAt` dates — the same evidence ledger every other
component in this table reads, `E7`'s own inputs included — never from
`daily_activity`, a streak counter, or a points total, none of which this
component's formula or its caller's Prisma query ever touches. It carries no
reward for a long run and no penalty beyond the natural one the rolling
window already applies — a missed day simply ages out of the 14-day window
14 days later, exactly like any other day. What it *is* is a durability
signal: `PRD.md`'s own worked example — "A user who correctly answers ten
questions immediately after studying them should not appear highly ready" —
is a single-session failure mode; `consistency` is the same argument applied
across days rather than within one sitting, evidence that a learner's recall
has been demonstrated more than once, spread out, rather than crammed into a
single burst that happens to also touch several different questions.

### 2.5 `remediation` (0.10) — full credit for nothing to remediate, deliberately

Over every `question_mastery` row that has **ever** had `lapses >= 2` —
reusing `apps/api/src/practice/mastery/selector.ts`'s own
`WEAK_LAPSES_THRESHOLD` constant by import, never redeclared, for the
identical one-source-of-truth reason every registry in this codebase gives
for not maintaining a second copy of a number that must never drift:
`remediatedCount / everWeakCount`, where "remediated" means the row's
*current* `state` is `review` or `mastered`. Because `memory-model.md` §2's
own `lapses` column comment states plainly that it is "incremented exactly
once per transition into `lapsed` — never once per subsequent miss while
already there," a row's stored `lapses` value never decreases, so "has ever
had `lapses >= 2`" is simply "has `lapses >= 2` right now" — no separate
historical tally is needed, and none is threaded through `ReadinessEvidence`
(§5).

**If `everWeakCount === 0` — the learner has never struggled on anything —
the component value is `1.0`, full credit, not `0`.** This is a deliberate
decision, stated here as one rather than left to be inferred: there is
nothing to remediate, so there is nothing to be penalized for not having
remediated. A `0` would punish a learner for a fact about their history that
is, if anything, good news — the alternative (`0` for "no evidence either
way," the same honest-absence posture §2.2 gives `recall` below five
attempts) does not apply here, because unlike `recall`'s "have we even
measured this," `remediation`'s underlying question — "of everything that
has ever gone wrong, how much has since been fixed" — has a well-defined,
true answer when nothing has ever gone wrong: all of it (vacuously) has.

### 2.6 `english` (0.05) — real, since #141 (epic #59 / E10)

Fed from `english_attempts` (`english-test.md` §5), not from
`practice_attempts`: a learner reads one sentence aloud and is scored on
word accuracy, or hears one sentence and types it back. Within a trailing
`ENGLISH_WINDOW_DAYS = 30` window (rolling, measured in instants off
`Clock.now()` — not calendar days, unlike `consistency`'s §2.4 window,
because this component counts distinct *sentences*, never buckets by day),
each **distinct** sentence is credited once, at its **best** in-window
outcome: `correct` = 1.0, `partial` = 0.5 (`recall`'s own partial credit,
reused rather than reinvented), anything else (incorrect, or no attempt) =
0. The two segments are scored, and combined, separately:

```
readingValue = min(readingCredit / 6, 1)
writingValue = min(writingCredit / 4, 1)
english = 0.5 · readingValue + 0.5 · writingValue
```

`ENGLISH_READING_TARGET = 6` and `ENGLISH_WRITING_TARGET = 4` differ on
purpose, and the difference is the design, not an inconsistency to
reconcile: a reading pass is scored against a recognizer's transcript — one
extra, imperfect step between what the learner said and what gets graded —
while a writing pass is scored against exactly what the learner typed, with
no intermediate transformation at all. One reading pass is therefore weaker
evidence than one writing pass, so reaching full credit needs more of them.
The even `0.5`/`0.5` split between the two formulas means a learner who has
only ever done one segment tops out at half the component, no matter how
much of that segment they do — reading and writing are two separate
requirements of the real test, not two interchangeable ways of clearing
one. `english-test.md` §6.2 is this formula's full worked arithmetic and
design record; this section states the shipped result, not a re-derivation
of it.

A learner with no in-window `english_attempts` rows of either kind reads
`english = 0` — the ordinary case for most learners, and never a distinct
"unmeasured" state the way `recall`'s evidence floor (§2.2) needs one:
`english`'s `0` has had exactly one meaning since before this component had
any real evidence to read (§2.9 restates why that matters for the cap).

### 2.7 `spoken` (0.10) — real, since #104 (epic #58 / E9)

`min(distinctQuestionsCorrectSpoken / 20, 1)` — `practice_attempts` rows
where `inputMode = 'spoken'` (declared in `practice-sessions.md` §2.2,
wired by #104's spoken practice mode) and `outcome = 'correct'`, counted by
distinct `questionId`. A learner with no spoken-and-correct attempts reads
`spoken = 0` — the ordinary case for a learner who has only ever typed, not
a distinct "unmeasured" state, the identical posture `english`'s §2.6
closing paragraph already takes for the same reason. `20` is the same
reasoning §2.6 gives: a round, generous denominator that reaches full
credit well before a learner has spoken every question in a
~100–128-question bank, because full credit here is meant to represent
"has demonstrated real spoken fluency across a meaningful slice of the
material," not "has spoken the entire bank."

### 2.8 `interview` (0.10) — the constant PRD.md already chose

`min(mockInterviewsPassed / 2, 1)` — `practice_attempts` rows with
`source = 'mock_interview'` (declared in `practice-sessions.md` §2.2,
unwired until E8), grouped into completed interview sessions, "passed"
meaning the interview cleared the caller's `civics_test_versions` row's own
`passThreshold` (reusing that column, never a second constant). Zero
evidence until E8. **The `2` is not this document's own choice — it is
`PRD.md`'s own worked example, quoted here verbatim because a later reader
should see the product's own words, not this document's summary of them:**

> Completing two mock interviews is the best way to strengthen your
> readiness now.

Two passed mock interviews is full credit for this component specifically
because the product itself already told a learner, in exactly those words,
that two is the number worth doing — a different constant here would put
this component's math and the product's own stated advice out of sync with
each other.

### 2.9 The structural cap: why a `typed_only` learner is held under 80, and English pushes that ceiling to 80, not past it

**`spoken` (0.10) and `interview` (0.10) sum to `0.20` of the total weight,
and both read `0` for a learner with no spoken-answer evidence and no
mock-interview evidence — an ordinary, honest zero for a learner who has
never yet answered a question correctly with `inputMode: 'spoken'` or
passed a mock interview, the identical "no evidence yet" reading `english`'s
own `0` already carries (§2.6), not a placeholder standing in for an epic
that has not shipped. The weighted score can therefore never exceed `0.80`
— 80 out of 100 — for a learner with neither kind of evidence, regardless of
how much `english` credit they have earned. This is the cap
`capReason: 'typed_only'` (§3) names, and it still falls directly out of the
weights table above, not a second clamp anywhere in this document's
engine.**

**Before #141 (epic #59 / E10), `english` was also mathematically `0` for
every learner, which made `0.75` — not `0.80` — the honest ceiling this
section originally described, because all three of `english`/`spoken`/
`interview` were structurally zero together. Since #141, `english` (0.05,
§2.6) is a real, continuously-earnable component fed from
`english_attempts`, and it is earnable by a learner who has never once
spoken a civics answer or sat a mock interview — reading and writing
English sentences requires neither. A `typed_only` learner with full
English credit therefore reaches `0.75 + 0.05 = 0.80`, and one with only
the writing segment maxed (reading requires speaking aloud; writing does
not) reaches `0.75 + 0.025 = 0.775`. `0.75` remains the ceiling only for the
narrower case this section used to be the only case: a learner with NONE of
the three components — `english` included — reading `0`.**

This is not a leak in the cap; it is the weights table working exactly as
designed, for a wider set of learners than it used to need to cover. There
is no `min(score, 75)` step in `computeReadiness` (§5), and there never
should be one — nor should a `min(score, 80)` be added now to "fix" the
fact that a typed-only learner can reach 80. The weights table in §2 is the
*only* place a ceiling number — `75`, `80`, or any number that could drift
from either — needs to appear, which is exactly the discipline this
codebase already commits to elsewhere for the identical reason:
`journey-shell.md` and `apps/api/src/ai/ai-model-roles.ts` both argue
against "two things that must agree but are not derived from each other" as
a category of bug, not a specific one. A hand-maintained ceiling constant
would be exactly that category: correct only until someone edits the
weights table and forgets the clamp, or edits the clamp and forgets the
weights table, with nothing in the type system or a test catching the
drift until a learner's score behaves inexplicably. §11 records this
rejection formally; it is stated here first because the absence of a second
cap is the single fact about this design most likely to look, to an
implementer skimming quickly, like a bug to "fix" — and, since #141, the
asymmetry between "English can raise the ceiling" and "English does not
lift `capReason`" (below) is the second thing most likely to earn that same
"fix."

**`capReason` deliberately still reads only two paths —
`evidenceCounts.spoken.attempts` and `evidenceCounts.interview.attempts`
(§3) — and does not read `english` at all. This is `english-test.md` §6.3's
own instruction, not a gap this section is flagging.** Reading and writing
English sentences is not evidence that a learner can answer a **civics**
question aloud, which is the specific thing the cap exists to require
before it lifts. A learner who has read and written every English sentence
in the bank perfectly, and has never once spoken a civics answer or sat a
mock interview, is still exactly the learner `capReason: 'typed_only'`
exists to name — full `english` credit raises that learner's *score* to 80,
and must not also make `capReason` stop naming their status.

This is also `ROADMAP.md`'s own stated reason Milestone B exists inside the
MVP boundary rather than after it, quoted in full because the framing —
"Voice is inside the MVP, not after it" — is the decision this cap
structurally enforces:

> **2026-09-02 — Voice is inside the MVP, not after it.** E6's readiness
> model caps a learner's score while there is no spoken-answer evidence and
> no mock-interview evidence. Milestone A alone would tell every learner the
> same capped ceiling regardless of practice volume. Milestone B (E9–E11) is
> therefore part of the MVP boundary, not a post-launch enhancement.

---

## 3. The cap — `capReason`

```ts
export type CapReason = 'typed_only' | null;
```

`capReason = 'typed_only'` when `evidenceCounts.spoken.attempts === 0 AND
evidenceCounts.interview.attempts === 0` — quoting the epic body's own
clause precisely: **no spoken-answer evidence and no mock-interview
evidence**. It becomes `null` the instant either kind of evidence exists at
all, even one attempt — the cap is about *any* real evidence existing, not
about being "done" with either. `evidenceCounts.spoken.attempts` and
`evidenceCounts.interview.attempts` are populated verbatim from
`distinctQuestionsCorrectSpoken` and `mockInterviewsPassed` (§5) — the only
granularity `ReadinessEvidence` carries for either signal. **Stated plainly
so a later reader does not have to infer it**: under this rule, a learner
who has attempted spoken practice or a mock interview but has not yet gotten
one right stays capped, because `ReadinessEvidence` has no field for "tried
but missed" separately from "correct" or "passed" — the cap lifts on the
first piece of *credited* evidence, not the first attempt of either kind.
This is a deliberate reading of the epic's clause, not an oversight: the two
components these counts feed (§2.7, §2.8) are themselves scored on credited
evidence only, so gating the cap on the identical granularity keeps
`capReason` answering the same underlying question its two components do,
rather than a looser one that could say "not capped" while both components
still read `0`.

**The weighted-score ceiling of 75 (§2.9) still applies gradually, rising as
`english`/`spoken`/`interview` climb from real evidence — `capReason` is a
distinct, binary, explain-*why*-you're-stuck signal, not a synonym for
"components incomplete."** A learner one passed mock interview into E8's
evidence has `capReason: null` (the cap has lifted — real evidence of the
kind the epic clause names exists) while their score may still sit well
under 75 (the `interview` component itself is only at `0.5` credit, and
`english`/`spoken` may still both read `0`). The two facts answer different
questions on purpose: "is there a structural reason you cannot move past a
number" (`capReason`) versus "how close are you to that number regardless"
(`score`).

**When `capReason === 'typed_only'`, the UI's cap message MUST be exactly
this — word for word, fixed learner-facing copy the frontend renders
unmodified, never paraphrased, never re-templated with a live count:**

> Your civics knowledge is strong, but you have limited interview practice.
> Completing two mock interviews is the best way to strengthen your
> readiness now.

This is the same sentence §2.8 already quotes from `PRD.md` — the cap
message is not this document's own invention layered on top of the product's
worked example; it *is* the product's worked example, delivered verbatim as
the explanation for why a learner is stuck.

---

## 4. `readiness_snapshots`

```prisma
model ReadinessSnapshot {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @map("user_id") @db.Uuid
  computedAt       DateTime  @map("computed_at") @db.Timestamptz
  score            Int
  stage            JourneyStage
  components       Json
  evidenceCounts   Json      @map("evidence_counts")
  capReason        String?   @map("cap_reason")
  topRecommendation Json     @map("top_recommendation")
  narrative        String?   @db.Text
  narrativeGeneratedAt DateTime? @map("narrative_generated_at") @db.Timestamptz
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, computedAt])
  @@map("readiness_snapshots")
}
```

`userId` is `onDelete: Cascade`, the identical posture every other
per-learner table in this schema already takes (`PracticeAttempt.userId`,
`QuestionMastery.userId`) — a snapshot has no meaning independent of the
account it summarizes. `score` is `round(weightedSum * 100)`, an integer
0–100 chosen specifically for display: a UI renders "72," never "0.7182,"
and storing the already-rounded integer means every reader of this table
(the home widget, the trend line, a future admin report) renders the
identical number with no re-rounding step of its own to keep in sync with
the engine's.

`components` and `evidenceCounts` store the **full** per-component
breakdown — `ReadinessComponentResult` (`{ value, weight, contribution }`,
§5) for every one of the eight keys, and the raw evidence counts §5's
`evidenceCounts` shape defines — so that a rendered snapshot stays
**self-explaining forever, even after the underlying evidence changes
later**. This is the epic body's own stated reason for snapshotting at all
rather than computing on every read, and §12 records it as a rejected
alternative in full; the short version, spent here because it is this
table's own reason to exist: a `question_mastery` row this snapshot summarized
can be re-scheduled, lapsed, or re-promoted by the time a learner looks at
last Tuesday's number again, and the stored `components`/`evidenceCounts`
document is what lets that historical number still mean exactly what it
meant on the day it was computed, rather than silently re-describing today's
evidence under yesterday's date.

`capReason` is nullable `String` at the schema level (not the Prisma-enum
posture `MasteryState`/`JourneyStage` take) because its one live value,
`'typed_only'`, is not expected to grow into a genuinely open-ended set the
way those two are — the closed TypeScript union (§3) is the real contract,
enforced at the application layer the same way `PracticeAttempt.aiFeedback`'s
`Json?` column is application-typed rather than schema-typed. `topRecommendation`
is `Json`, not `NOT NULL` — §8 defines its shape, and every snapshot this
document's own engine produces always computes one (there is no "no
recommendation" state), so the column carries no null case to design around.

`narrative`/`narrativeGeneratedAt` are for issue #134 (the Progress Guide,
§9) — both nullable, filled in **lazily**, absent without complaint when AI
is unavailable, and their absence **never blocks snapshot creation**: a
snapshot is a complete, useful row the instant `computeReadiness` (§5)
returns, with or without a narrative sentence layered on top of it later.

---

## 5. The pure engine — `computeReadiness`

`apps/api/src/readiness/readiness-engine.ts` (issue #122) — pure, no
NestJS, no Prisma, no Clock, no import statement at all: the identical shape
`nextSchedule` (`memory-model.md` §3) and `recommendNextAction`
(`journey-shell.md` §4) already establish for a rule that must produce the
same output for the same input forever, and must be directly unit-testable,
table of cases and all, with no database in the loop.

```ts
// apps/api/src/readiness/readiness-engine.ts — pure, no NestJS, no Prisma, no
// Clock — mirrors nextSchedule/recommendNextAction exactly.

export interface ReadinessEvidence {
  totalQuestionsInVersion: number;
  masteryRows: Array<{ state: MasteryState; lapses: number }>; // one per question_mastery row for this user+version
  recentQualifyingAttempts: Array<{ outcome: 'correct' | 'partial' | 'incorrect' | 'skipped' }>; // most recent 20, hintUsed=false, revealed=false
  distinctPracticeDaysInLast14: number;
  distinctQuestionsCorrectSpoken: number;
  englishBestOutcomesInWindow: Array<{ kind: 'reading' | 'writing'; outcome: 'correct' | 'partial' | 'incorrect' }>; // one per distinct english_sentences row attempted in the trailing 30 days, at its best in-window outcome
  mockInterviewsPassed: number;
}

export interface ReadinessComponentResult {
  value: number;      // normalized [0, 1] — §2's formula column
  weight: number;      // this component's weight — §2's weight column, copied onto the result so a reader never has to cross-reference the table
  contribution: number; // value * weight — what this component actually added to the score
}

export interface ReadinessResult {
  score: number; // 0-100, round(sum(contribution) * 100)
  components: Record<ReadinessComponentKey, ReadinessComponentResult>;
  evidenceCounts: Record<ReadinessComponentKey, Record<string, number>>;
  capReason: 'typed_only' | null;
}

export function computeReadiness(evidence: ReadinessEvidence): ReadinessResult;
```

**The caller — a `ReadinessService` — is responsible for querying Prisma and
assembling `ReadinessEvidence`, exactly as `PracticeService` assembles a
`MasteryRecord` before ever calling `nextSchedule`.** `computeReadiness`
itself never sees a `userId`, a Prisma client, or a test-version code — it
sees four already-resolved numbers and three arrays (mastery rows, recent
attempt outcomes, and — since #141 — one entry per distinct English
sentence attempted in the trailing window) and returns a result that is, by
construction, reproducible from those inputs alone.

`masteryRows` is deliberately narrower than a `QuestionMastery` row — only
`state` and `lapses`, because that is the entirety of what `retention`
(§2.3) and `remediation` (§2.5) need; `coverage` (§2.1) reads the array's
own `.length`. `recentQualifyingAttempts` is likewise narrowed to `outcome`
alone — the caller has already applied the `hintUsed = false AND revealed =
false` filter and the "most recent 20" limit (§2.2) before this function
ever sees the array, the identical division of labor `matchAnswer`'s own
`AcceptedAnswer` narrowing already establishes in `practice-sessions.md`
§7.1: "Whoever calls [the pure function] is responsible for first
resolving... and passing only [what grading needs] in." `englishBestOutcomesInWindow`
takes the same shape for the same reason: the caller owns the 30-day
window, the distinct-sentence grouping, and the best-of reduction (all
QUERY concerns); this function owns only the credit table and the two
denominators (§2.6) — SCORING concerns. Neither half is testable without a
database if the two are mixed.

`evidenceCounts`' per-key shape, exactly as the engine populates it:

| Key | Shape |
|---|---|
| `coverage` | `{ distinctQuestionsAttempted, totalQuestionsInVersion }` |
| `recall` | `{ qualifyingAttempts, correctCount, partialCount, incorrectCount, skippedCount }` |
| `retention` | `{ masteredCount, reviewCount, totalAttemptedQuestions }` |
| `consistency` | `{ distinctPracticeDaysInLast14 }` |
| `remediation` | `{ everWeakCount, remediatedCount }` |
| `english` | `{ readingSentences, writingSentences, readingCredit, writingCredit }` |
| `spoken` | `{ attempts: distinctQuestionsCorrectSpoken }` |
| `interview` | `{ attempts: mockInterviewsPassed }` |

`english`'s two credit fields are not integers — a `partial` sentence
contributes `0.5`, so a fractional credit total is the ordinary case, not a
rounding artefact; `readingSentences`/`writingSentences` are the plain
counts of distinct sentences with any in-window attempt, the figure that
tells "no practice" apart from "practised and missed."

`spoken.attempts` and `interview.attempts` are named `attempts` specifically
because §3's `capReason` rule reads those two exact paths — a reader of
`evidenceCounts` should be able to find the cap's own inputs without also
knowing which of the eight components they happen to feed. `english` is
deliberately absent from that list — §2.9/§3 state why.

---

## 6. API surface

`GET /api/readiness` — the latest snapshot for the caller. Lazily computes
and persists one if none exists yet, or the latest is **stale** —
**stale** meaning: an existing snapshot older than the caller's most recent
`practice_attempts.answered_at`. This is the same "recomputed on session
completion" fact §7's first trigger states as a rule; here it is restated as
the read-side consequence of that rule: if a session has completed *since*
the last snapshot, that snapshot no longer reflects the evidence, and this
endpoint is the one place a caller could otherwise be shown a number known
to already be wrong. **A snapshot produced by the nightly cron pass (§7) is
never "stale" by this rule**, because the cron itself just ran the identical
computation this endpoint would otherwise run — recomputing again on the
next `GET` would produce the same result at real, avoidable cost.

`GET /api/readiness/history` — a paginated list of past snapshots, newest
first, for the trend line — the product surface the epic body itself names
as the reason snapshotting exists at all (§4, §12).

**Both are `@Auth()` with no permissions, no user-id parameter** — the same
rule every other per-user route in this codebase already follows, stated
here by citing `CLAUDE.md`'s own name for it rather than re-deriving it:
"Journey/Practice/Progress add no permission strings, for the same reason" —
every authenticated learner owns their own readiness data exactly as they
own their own learner profile, their own practice attempts, and their own
mastery rows, and no route here accepts another user's id, ever.

---

## 7. Recompute triggers

Exactly two, and no third:

**(a) Synchronously, at the end of `PracticeService.completeSession`** (or
wherever a session's completion is finalized) — inside the same request that
produces the evidence, matching `ROADMAP.md` §7's rule verbatim:

> **No job queue.** Scheduling (E5) and readiness recompute (E6) run
> synchronously, inside the request or transaction that produces the
> evidence.

**(b) A nightly cron via `@nestjs/schedule`**, following
`apps/api/src/auth/tasks/token-cleanup.task.ts`'s exact shape: a plain
`@Injectable()` class with a `@Cron(CronExpression.EVERY_DAY_AT_3AM)` (or
the same expression `token-cleanup.task.ts` already runs on — a shared,
uncontested hour with no other cron competing for it) method, added to its
owning module's `providers` array — **no separate "tasks module" anywhere
in this application**, the identical structural rule `ROADMAP.md` §7
states for this exact cron by name:

> Reminders (E7) and the nightly readiness pass (E6) run on
> `@nestjs/schedule` cron, following the `token-cleanup.task.ts` pattern.

The nightly pass recomputes every active user's snapshot so `consistency`'s
14-day window (§2.4) and any stage transition decay honestly while a learner
is away, rather than only ever moving forward on a day the learner happens
to open the app — a learner who stops practicing for two weeks should see
their `consistency` component (and, if it moves them, their score) reflect
that the next time they look, not a number frozen from the day they left.

**The nightly pass never calls AI.** `ROADMAP.md` §7 states the reason as a
direct structural consequence of where BYOK keys live, quoted here rather
than restated because the "why" is load-bearing, not incidental:

> Consequence: **no background job may call AI on a user's key**, because a
> user's key is not available outside a request from that user. This is the
> direct reason nothing AI-driven runs on cron — the nightly readiness
> recompute (E6) and the hourly reminder cron (E7) are both deterministic.

Concretely: the cron writes `score`, `stage`, `components`, `evidenceCounts`,
`capReason`, and `topRecommendation` — every field `computeReadiness` (§5)
and §8's stage/recommendation logic produce — and leaves `narrative` /
`narrativeGeneratedAt` **untouched** (`null`, or whatever they already were)
on every row it creates. Narrative generation is request-triggered only,
never cron-triggered — §9 is the complete design for where it actually
happens.

---

## 8. Stage transitions and the top recommendation

Both are computed as part of **writing a new snapshot** — not a
per-attempt pure function the way E5's `nextStageOnMasteryEvent` is (that
function fires on every graded attempt, because a mastery transition is a
per-attempt fact); these fire per snapshot, because they depend on an
**aggregate score** that only exists once a snapshot has been computed.

### 8.1 `nextStageOnReadinessSnapshot`

A new pure function, in a **sibling file** to
`apps/api/src/journey/stage-transitions.ts` — `apps/api/src/journey/
readiness-stage-transitions.ts` — rather than added to that file directly.
This is a deliberate choice, not a coin flip, and it is worth stating why:
`stage-transitions.ts`'s own header ties it explicitly to `MasteryState` and
per-attempt events ("the caller... owns the transaction and the
`learner_profiles` read/write; this module only ever sees the values it was
handed" — about a mastery event specifically), and its own import
(`MasteryState` from `../practice/mastery/scheduler`) makes it E5's file,
not a generic "stage transitions" file that happens to hold two functions
from two different epics. A per-snapshot, aggregate-score-driven decision is
a genuinely different *kind* of trigger from a per-attempt mastery-state
comparison, and giving it its own file mirrors how `study-coach.ts` sits
beside `next-action.ts` rather than inside it (`memory-model.md` §6) — one
function per file per triggering event, not one file accreting every stage
rule regardless of what fires it.

```ts
export const READINESS_PRACTICING_THRESHOLD = 50; // score at which remembering -> practicing
export const READINESS_PERFORMING_THRESHOLD = 65; // score at which practicing -> performing
export const READINESS_READY_THRESHOLD = 80; // score at which performing -> ready, AND capReason must be null

export function nextStageOnReadinessSnapshot(
  currentStage: JourneyStage,
  score: number,
  capReason: 'typed_only' | null,
): JourneyStage | null;
```

Only three forward transitions exist, each gated on the row's **current
stage alone**, mirroring `nextStageOnMasteryEvent`'s own header discipline
exactly ("every other combination returns `null`"):

```
remembering -> practicing   when score >= READINESS_PRACTICING_THRESHOLD (50)
practicing  -> performing   when score >= READINESS_PERFORMING_THRESHOLD (65)
performing  -> ready        when score >= READINESS_READY_THRESHOLD (80)
                             AND capReason === null
```

Every other `(currentStage, score, capReason)` combination — including a
regression (a `performing`-stage learner whose score has since fallen below
65), and including `currentStage === 'speaking'` — returns `null`. That
second exclusion is worth naming rather than leaving for a reader to
discover: `speaking` sits between `remembering` and `practicing` in the
`JourneyStage` enum, but it is `journey-shell.md`/`ROADMAP.md` §9's E9-owned
axis ("`remembering → speaking` belongs to E9... a learner enters `speaking`
once they have real spoken-answer evidence"), orthogonal to this document's
score-driven progression rather than a rung on the same ladder. A learner
whose stage E9 has already advanced to `speaking` is not moved by this
function at all — `nextStageOnReadinessSnapshot` only recognizes
`currentStage === 'remembering' | 'practicing' | 'performing'` as inputs it
acts on. Reconciling a `speaking`-staged learner's forward path through
`practicing`/`performing`/`ready` is E9's own design question when it ships,
the identical "the epic that creates the evidence owns the transition" rule
`ROADMAP.md` §9 already states for `speaking` itself — not a gap this
document silently papers over, and not this document's decision to make on
E9's behalf either.

**Regression never happens automatically, on purpose, matching the same
rule `ROADMAP.md` §9 already states for `speaking → remembering`:** nothing
in this function ever moves a stage *backward* even when a score falls below
a threshold it once cleared — the identical "a learner who stops speaking
does not fall back to `remembering`... demoting a visible stage for a quiet
week is the discouragement `VISION.md` rules out" reasoning applies without
modification to `practicing`/`performing`/`ready`; the score itself is
always visible and always honest about a decline, which is what makes a
silently-regressing stage badge redundant discouragement rather than useful
information.

`ready` is the one transition this design gates on more than score alone —
requiring `capReason === null` in addition to clearing `80` — and
`ROADMAP.md` §9's own decision log states the reason precisely enough that
this document quotes it rather than restating it:

> `performing → ready` belongs to E6 (#55) — `ready` is a readiness
> judgement and nothing else is entitled to make it, requiring both that the
> score clears its threshold *and* that the cap has lifted, so a learner can
> never reach `ready` on typed answers alone.

### 8.2 Top recommendation

```ts
export interface ReadinessTopRecommendation {
  componentKey: ReadinessComponentKey | null;
  title: string;
  reason: string;
  path: string;
}
```

**When `capReason === 'typed_only'`, the recommendation is always the
capped-evidence requirement — `componentKey: null`**, title and reason drawn
from §3's fixed cap copy, `path: '/practice'` — the same destination
`interview_countdown`/`review`/`practice` already share
(`journey-shell.md`/`memory-model.md` §6's "three kinds naming one
destination, not a duplicated branch"), with the note that E8 will
re-point this path once a dedicated mock-interview route exists to send a
learner to directly. This is not a competing choice against the
currently-earnable components below — a capped learner is told about the
cap **every time**, because the cap is the single most consequential true
thing this product can say to them, ahead of any smaller headroom
optimization among components they can already move freely.

**When not capped**, the recommendation picks the component — among the
six currently-earnable ones (`coverage`, `recall`, `retention`,
`consistency`, `remediation`, and, since #141 (epic #59 / E10), `english` —
never `spoken`/`interview`, which read real evidence today (§2.7–§2.8) but
are never a candidate for this pick regardless: recommending "go do more
spoken/interview practice" as a headroom pick would send a learner to no
practice destination of its own, distinct from the general practice surface
every other headroom pick already shares) — with the greatest
`weight * (1 - value)`, the "weighted headroom": how
much this component could still add to the score, scaled by how much it's
worth. Ties are broken by §2's declared component order (`coverage` before
`recall` before `retention`...) — the same stable-tie-break discipline
`selector.ts`'s `orderNewByCategoryCoverage` already applies for the
identical reason: a comparator that can return a genuine tie must not be
allowed to reorder nondeterministically between two calls on identical
input.

---

## 9. Progress Guide narrative (issue #134)

One paragraph, described here rather than over-specified, because the
narrative's own design belongs to issue #134 in full: generated via
`AiDispatchService.runStructured` or `.run` (`apps/api/src/ai/
ai-dispatch.service.ts`) with the `tutor` role, following the shipped
call-site pattern `apps/api/src/civics/civics-explain.service.ts` already
establishes for that exact role — never re-derived here. Called once when a
snapshot has `narrative === null`, from the **request path only**: never
from the cron (§7 already states this), and never blocking snapshot
creation — a snapshot is created and returned immediately even if its
narrative hasn't been generated yet, and a client can re-request the same
snapshot a moment later once it's populated. Alternatively, the narrative
may be generated inline, in `GET /api/readiness`'s own handler, *after* the
snapshot read — but this must never fail the request if the dispatch result
is `unavailable`, the identical never-throw contract every other
`AiDispatchService` caller already honors (`CLAUDE.md`'s "Adding an AI
feature," step 3).

The prompt is grounded in the snapshot's **own** `components`,
`evidenceCounts`, and `capReason` fields — never in the model's own guesses
about a learner it has no other information about — the same grounding rule
`buildExplainPrompt`/`buildGradingPrompt` already establish and this
document does not re-argue.

---

## 10. Out of scope (deliberately)

Restated here so a later reader does not mistake a silence in this document
for an oversight:

- **Producing spoken, interview, or English evidence was never this
  document's own job — this engine only scores whatever evidence its caller
  assembles.** `interview` evidence is produced by #133 (epic #57 / E8,
  mock interviews), `english` evidence by #141 (epic #59 / E10, reading and
  writing scoring), and `spoken` evidence by #104 (epic #58 / E9, spoken
  practice mode inside the practice session) — all three real today (§2.6,
  §2.7, §2.8). This corrects this section's own original placeholder,
  written when this document first declared all three components and named
  a future, repeat-numbered "E11" as `english`'s producer before E10's issue
  existed to name instead.
- **E7's engagement layer.** Streaks, `daily_activity`, points, and
  celebrations are E7's design entirely; §2.4 states at length why
  `consistency` is not that layer wearing a different name, and
  `ROADMAP.md` §7's "Engagement never moves readiness" rule is what makes
  the boundary structural rather than a promise this document alone keeps.
- **Any AI call from the nightly cron.** §7 states this as a rule with a
  reason, not merely a fact; the narrative (§9) is request-triggered only,
  forever, by the same structural argument that keeps every other
  AI-driven feature in this codebase off a background job.
- **Widening `capReason` beyond `'typed_only'`.** A second cap reason would
  need a second structural gap in `capReason`'s own two-path computation the
  way `typed_only` has one in `spoken`/`interview` (§2.9, §3) —
  deliberately not `english`, which reads real evidence but was never one
  of the two paths `capReason` gates on; nothing in E1–E11 creates a second
  such gap, so this document declares no second value for one that does
  not yet, and may never, exist.

---

## 11. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **A hard `min(score, 75)` clamp instead of letting the cap fall out of the weights** | A second ceiling that must be kept in sync with the weights table by hand — exactly the "two things that must agree but are not derived from each other" category of bug `journey-shell.md` and `ai-model-roles.ts` both already argue against. §2.9's cap needs no clamp because it is arithmetically incapable of exceeding 75 while three components summing to 0.25 weight are structurally 0 — a `min()` call would be redundant at best and, at worst, a second value someone edits without noticing the weights table changed underneath it. |
| **Computing readiness on every read instead of snapshotting** | Rejected on the epic body's own three stated reasons, quoted rather than summarized because each is independently load-bearing: the trend line (`GET /api/readiness/history`, §6) **is the product** — there is no trend to show if nothing is ever stored; a rendered number **must remain explicable after the inputs move** — a `question_mastery` row can be rescheduled or re-promoted by the time a learner revisits last week's score, and a live recompute would silently rewrite history under an old date; and recomputing a learner's **entire** history on every read is **neither cheap nor honest** — cheap, because it means re-aggregating every mastery row and the last 20 qualifying attempts on every page load instead of reading one row; honest, because "your readiness two weeks ago" rendered from today's evidence is not actually a fact about two weeks ago. |
| **Folding `consistency` into E7's engagement streaks instead of a separate evidence-only signal** | Would violate `ROADMAP.md` §7's "Engagement never moves readiness" rule the moment the two shared a data source — quoted in full at §2.4 rather than paraphrased, because the rule is explicit that the separation is enforced by *never wiring engagement in as an input in the first place*, not by filtering it out after the fact. `consistency` reads only `practice_attempts.answeredAt`, the same evidence ledger every other component reads, specifically so it can never become a covert engagement input by construction. |
| **A `remediation` value of `0` when `everWeakCount === 0`** | Considered and rejected at §2.5: would penalize a learner for a fact about their own history — never having struggled — that is unambiguously good, conflating "nothing to remediate" with "remediation failed," two different facts a single `0` cannot distinguish. |
| **Excluding self-marked (`gradingMethod: 'self'`) attempts from `recall`'s qualifying set** | Considered, and rejected: `recall`'s filter is `hintUsed`/`revealed`, not `gradingMethod` — a self-marked attempt is, per `practice-sessions.md` §9, a genuinely `outcome: 'correct'` row from the product's point of view, and E5's own scheduler already discounts self-mark's *weight* through smaller ease/interval growth rather than excluding it from any transition. Excluding it here a second time, on a different axis, would double-discount the identical evidence for the identical reason `memory-model.md` §3.7 already rejects gating any state transition on grading method beyond the one place (`review → mastered`'s `distinctCorrectDays` threshold) E5 already designed for it. |
| **A per-component, hand-authored second recommendation table instead of computing weighted headroom** | Would need to be kept in sync with §2's weights every time a weight changed, the identical drift risk §2.9's cap clamp is rejected for. Weighted headroom (`weight * (1 - value)`) is derived arithmetic over values §5's engine already produces — nothing to author, nothing to keep in sync, and it automatically reprioritizes if a future epic reweights the table. |
| **A stage transition function that also handles regression (moving a stage backward when score falls)** | Rejected at §8.1 on the identical reasoning `ROADMAP.md` §9 already gives for `speaking → remembering` not being automatic: the score itself is the honest, always-visible signal of a decline; demoting a visible stage badge on top of that is redundant discouragement `VISION.md` already rules out, not additional information. |

---

## 12. Worked examples

A fictional learner, Dana, across three test-clock days
(`X-Test-Clock`), 100 questions in her active test version. Every
number below is arithmetically checked and self-consistent — **these three
points are asserted verbatim by `tests/e2e/readiness.spec.ts` (issue
#146)**, so a later implementation must reproduce this table exactly, not
merely approximately.

Prior stage entering Day 1: `remembering` (already reached via E5).

### Day 1 — `2026-04-06T12:00:00Z`

`question_mastery` rows (20 total): `mastered: 2`, `review: 6`,
`learning: 10`, `lapsed: 2`. Most recent 20 qualifying attempts:
`correct: 14`, `partial: 2`, `incorrect: 4`. 14 distinct-day-in-14
practice days recorded so far: `3`. Rows with `lapses >= 2`: `2`, of which
`1` is currently `review`/`mastered`. No spoken evidence, no interview
evidence.

| Component | value | weight | contribution |
|---|---|---|---|
| coverage | `20/100 = 0.20` | 0.15 | `0.03` |
| recall | `(14 + 0.5·2)/20 = 0.75` | 0.20 | `0.15` |
| retention | `(2·1.0 + 6·0.6)/20 = 0.28` | 0.20 | `0.056` |
| consistency | `min(3,7)/7 = 0.428571` | 0.10 | `0.0428571` |
| remediation | `1/2 = 0.5` | 0.10 | `0.05` |
| english | `0` | 0.05 | `0` |
| spoken | `0` | 0.10 | `0` |
| interview | `0` | 0.10 | `0` |
| **sum** | | **1.00** | **0.3288571** |

`score = round(0.3288571 × 100) = 33`. `evidenceCounts.spoken.attempts = 0`
and `evidenceCounts.interview.attempts = 0` → `capReason: 'typed_only'`.
`nextStageOnReadinessSnapshot('remembering', 33, 'typed_only')` → `33 <
READINESS_PRACTICING_THRESHOLD (50)` → `null`. **Stage stays
`remembering`.** Top recommendation: capped — the fixed §3 copy, `path:
'/practice'`.

### Day 2 — `2026-04-08T12:00:00Z`

`question_mastery` rows (40 total): `mastered: 8`, `review: 14`,
`learning: 14`, `lapsed: 4`. Most recent 20 qualifying attempts: `correct:
18`, `partial: 1`, `incorrect: 1`. Distinct practice days in the last 14:
`7`. Rows with `lapses >= 2`: `4`, of which `3` are currently
`review`/`mastered`. Still no spoken or interview evidence.

| Component | value | weight | contribution |
|---|---|---|---|
| coverage | `40/100 = 0.40` | 0.15 | `0.06` |
| recall | `(18 + 0.5·1)/20 = 0.925` | 0.20 | `0.185` |
| retention | `(8·1.0 + 14·0.6)/40 = 0.41` | 0.20 | `0.082` |
| consistency | `min(7,7)/7 = 1.0` | 0.10 | `0.10` |
| remediation | `3/4 = 0.75` | 0.10 | `0.075` |
| english | `0` | 0.05 | `0` |
| spoken | `0` | 0.10 | `0` |
| interview | `0` | 0.10 | `0` |
| **sum** | | **1.00** | **0.502** |

`score = round(0.502 × 100) = 50`. Still `capReason: 'typed_only'` (no
spoken or interview evidence yet).
`nextStageOnReadinessSnapshot('remembering', 50, 'typed_only')` → `50 >=
READINESS_PRACTICING_THRESHOLD (50)` and `currentStage === 'remembering'` →
returns `'practicing'`. **Stage advances to `practicing`** — Day 2 lands
exactly on the threshold, on purpose, to pin the boundary case (`>=`, not
`>`). Top recommendation: still capped — the fixed §3 copy.

### Day 3 — `2026-04-10T12:00:00Z`

`question_mastery` rows (55 total): `mastered: 12`, `review: 20`,
`learning: 18`, `lapsed: 5`. Most recent 20 qualifying attempts: `correct:
19`, `partial: 0`, `incorrect: 1`. Distinct practice days in the last 14:
`7` (still capped). Rows with `lapses >= 2`: `5`, of which `4` are
currently `review`/`mastered`. Dana has now completed and passed **one**
mock interview (`mockInterviewsPassed: 1`) — still no spoken-practice
evidence: she has not yet answered a question correctly with
`inputMode: 'spoken'`.

| Component | value | weight | contribution |
|---|---|---|---|
| coverage | `55/100 = 0.55` | 0.15 | `0.0825` |
| recall | `19/20 = 0.95` | 0.20 | `0.19` |
| retention | `(12·1.0 + 20·0.6)/55 = 24/55 = 0.436364` | 0.20 | `0.0872727` |
| consistency | `min(7,7)/7 = 1.0` | 0.10 | `0.10` |
| remediation | `4/5 = 0.8` | 0.10 | `0.08` |
| english | `0` (no `english_attempts` evidence) | 0.05 | `0` |
| spoken | `0` | 0.10 | `0` |
| interview | `min(1/2,1) = 0.5` | 0.10 | `0.05` |
| **sum** | | **1.00** | **0.5897727** |

`score = round(0.5897727 × 100) = 59`. `evidenceCounts.interview.attempts =
1` (not `0`) → `capReason: null` — **the cap lifts**, even though only one
of the two components it gates (`interview`) carries any evidence at all,
and even though `interview` itself is only at half credit.
`nextStageOnReadinessSnapshot('practicing', 59, null)` → `59 <
READINESS_PERFORMING_THRESHOLD (65)` → `null`. **Stage stays `practicing`**
— the cap lifting and a stage transition are independent facts; one can
change without the other.

Top recommendation, no longer capped, computed over the six
currently-earnable components' weighted headroom (`weight × (1 − value)`):

| Component | headroom |
|---|---|
| coverage | `0.15 × (1 − 0.55) = 0.0675` |
| recall | `0.20 × (1 − 0.95) = 0.01` |
| retention | `0.20 × (1 − 0.436364) = 0.112727` |
| consistency | `0.10 × (1 − 1.0) = 0` |
| remediation | `0.10 × (1 − 0.8) = 0.02` |
| english | `0.05 × (1 − 0) = 0.05` |

`retention` has the greatest headroom (`0.112727`) → `topRecommendation:
{ componentKey: 'retention', ... }` — Dana's `review`-state rows (20 of
them, only partially credited at `0.6`) are, at this point, the single
largest lever left on her score: converting more of them to `mastered` adds
more to the number than any other currently-earnable move available to her.

---

## 13. Divergences from this design, as shipped

Issue #150 requires this document reconciled against
`readiness-engine.ts`, `readiness.service.ts`,
`readiness-recompute.task.ts`, `readiness-stage-transitions.ts`, and
`readiness.controller.ts` as they actually shipped (epic #55, E6), with
every place they disagree recorded here rather than silently edited over —
mirroring `docs/specs/practice-sessions.md` §15's own pattern. Every row
below was checked directly against the shipped source, not against the
issue text.

| This document said | What shipped | Why the shipped design is right |
|---|---|---|
| §2.7: `spoken`'s formula is declared now "exactly the unwired-role idiom one layer up" (§2.6), with "zero evidence until E9" — reading, by analogy with `english` (§2.6, a literal hardcoded `0`) and `interview` (§2.8, a literal hardcoded `0`), as a stub returning `0` unconditionally until E9 ships. | `ReadinessService.assembleEvidence` computes `distinctQuestionsCorrectSpoken` for real, today — a genuine Prisma query for distinct `questionId`s among `practice_attempts` rows with `inputMode: 'spoken', outcome: 'correct'`, not a hardcoded `0`. Its own comment states the reasoning: "`inputMode: 'spoken'` already exists on `practice_attempts`... nothing stops reading it honestly today." At the time this was written, the *result* was `0` for every user, because no code path yet wrote `inputMode: 'spoken'` — so this was not, at that point, an observable behavior change from what §2.7 promised. Since #104 (epic #58 / E9) shipped spoken practice mode, `practice_attempts` rows with `inputMode: 'spoken'` are genuinely produced, so this component now reads real, nonzero evidence for a learner who has actually answered a question correctly aloud; a typed-only learner still scores `spoken: 0`. | This was a genuine, deliberate implementation judgment call, not an error: unlike `english` (no column existed to read at all — a real one would need to be invented) and `interview` (no grouping key existed to turn attempt rows into "interview sessions" — inventing one would have been guessing at E8's design), `spoken`'s one input (`inputMode = 'spoken'`) already existed as a real column with a real, unambiguous meaning. Reading it for real cost nothing extra and needed no future migration or follow-up edit once E9 started writing it — the component went live the moment E9 shipped, with no change to this file. Hardcoding `0` here would have been the *safer-looking* choice that was actually less honest: it would have silently stayed `0` even after E9 started writing real spoken attempts, until someone remembered to come back and wire it up — and since E9 shipped with no edit to this file needed at all, that is exactly the outcome this decision avoided. |

No other divergence was found. §2's formulas and weights, §3's `capReason`
rule, §4's `readiness_snapshots` schema, §5's `ReadinessEvidence`/
`ReadinessResult` shapes, §6's two endpoints, §7's two recompute triggers
(including the nightly cron's shape and its never-calls-AI rule), §8's
three stage thresholds and the `ready` gate's `capReason === null`
requirement, and §9's narrative generation (request-path only, never
blocking) were all checked line-by-line against the shipped source and
match exactly.

**A note on §12's worked example, not itself a divergence:** the example's
precise 33/50/59 scores are not reproduced by an automated test.
`tests/e2e/specs/readiness.spec.ts` (issue #146) exercises the real shipped
engine end to end, but over its own self-designed, hand-verifiable evidence
table rather than Dana's exact numbers — that file's own header explains
why in full (an AI-graded `partial` outcome and an exact `lapses`-threshold
mix have no honest way to be dialed to through the real product surface in
an E2E test with no AI configured). §12 itself remains an accurate,
independently hand-checked worked example of the shipped formulas; it is
simply not the literal fixture any test asserts against.
