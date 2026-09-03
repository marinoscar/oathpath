# Design Spec: Memory model (spaced repetition, verified mastery, and the Study Coach)

This is the durable design for E5 (epic #54): the moment this product stops
treating every question as equally fresh and starts remembering, per learner
and per question, what has actually been verified. E3 (`docs/specs/practice-sessions.md`)
shipped the evidence — `practice_attempts`, one row per question ever
answered. E4 (`docs/specs/ai-evaluation.md`) shipped a second, independent way
to grade that evidence. Neither one decides *what a learner should do next* or
*whether a question is actually known*. This document is what does: the
`question_mastery` table, the pure scheduling function that moves a question
through it, the queue that orders practice around it, and the deterministic
Study Coach that turns all of it into the one line Home shows.

Nine sibling issues (#71, #75, #78, #82, #86, #90, #94, #98, #102 — the
mapping from epic #54's own child-issue list is recorded in §11) build against
this document in parallel. Every number in it — every constant, every column,
every transition — is written to be implemented literally, not adapted; a
child issue that finds a better answer to a specific sub-problem should still
keep the contracts this document promises to the epics around it: the five
`state` values, the `nextSchedule` signature, the ≥3-distinct-days mastery
rule, and the closed `nextAction`/journey-stage unions this epic extends by
exactly the members it names.

Source of truth for every claim below:

- [Epic #54](https://github.com/marinoscar/oathpath/issues/54) and
  [issue #67](https://github.com/marinoscar/oathpath/issues/67) themselves —
  the five locked decisions verbatim (§10 restates them at the point each is
  spent), the `question_mastery` column list, and the explicit out-of-scope
  list (§9) this document does not reach into.
- `VISION.md` — "The user should never have to decide from a wall of study
  options what to do next" (§6's reason for the Study Coach existing at all),
  and "The system should spend more time on what is weak, revisit what is
  becoming stale, and continue sampling what appears strong so that **mastery
  is verified rather than assumed**" — the sentence §2's `distinct_correct_days`
  column and §5's mastered-sampling bucket both exist to satisfy.
- `PRD.md` — the same rule stated as a product requirement: "A user who
  correctly answers ten questions immediately after studying them should not
  appear highly ready."
- `ROADMAP.md` §7 ("Cross-cutting rules") — "No job queue" (§4 below extends
  this rule rather than re-deriving it), "Local days are explicit" (§3.3's
  `due_at` derivation), and the 2026-09-02 decision log entries "`practice_attempts`
  is one table", "The study-coach recommender (E5) is deterministic", and
  "Every journey stage has an owning epic" — the exact commitments this
  document is required to keep for the `oriented → learning → remembering`
  transitions (§7).
- `docs/specs/practice-sessions.md` §2.2, §8.1, §9, §9.1 — the shipped
  `practice_attempts` columns this epic reads (`outcome`, `gradingMethod`,
  `revealed`, `answeredAt`), the self-mark mechanism as a **second, distinct
  route** performing a real `UPDATE` on an already-persisted row (the reason
  §4 below says scheduling runs inside *two* transactions, not one), and
  §9.1's ruling that a `skipped` attempt is "not evidence of recall in either
  direction" — the reason §3.2 excludes `skipped` from `nextSchedule` entirely
  rather than scheduling it as a weak signal.
- `docs/specs/ai-evaluation.md` §6, §8 — the grading ladder's three rungs and
  the `verdict` values (`correct` / `partial` / `incorrect`) rung 2's grader
  can produce, which is where §3.1's `partial` mastery outcome comes from.
- `docs/specs/journey-shell.md` §1, §3.2, §6 — the eight-value `JourneyStage`
  enum, the `learner_profiles` columns this epic reads (`stage`, `timezone`)
  and writes (`stage` only — §7), and the "every stage has an owning epic"
  table this document fills in for `learning` and `remembering`.
- `apps/api/src/common/clock/clock.ts` — `Clock.now()` and
  `Clock.calendarDateIn(timeZone)`, the exact calendar-day derivation §3.3
  uses for `due_at` and the distinct-day credit, quoted rather than
  reinvented: "at 2026-01-15T23:30:00-08:00 the answer in `America/Los_Angeles`
  is measured from January 15, while the same instant is already January 16
  in UTC."
- `apps/api/src/notifications/notifications.service.ts`'s file header — the
  complete "WHY NOT A QUEUE" rationale §4 below cites by name rather than
  restating, and the one place this epic's reasoning *diverges* from it
  (detached-and-best-effort vs. captured-and-atomic), stated explicitly
  rather than silently.
- `apps/api/src/journey/next-action.ts` — `NEXT_ACTION_KINDS`,
  `NEXT_ACTION_PATHS`, `recommendNextAction`'s ordering comment
  ("orientation > interview_countdown > practice > explore"), and its own
  header's promise that E5 adds exactly one more kind (`review`) "on the same
  extend-the-union-when-the-destination-exists discipline" — the file §6
  widens.
- `apps/api/src/practice/practice.service.ts`, `apps/api/src/practice/answer-matching.ts`,
  `apps/api/src/civics/answer-resolution.ts` — the house convention this
  document's `nextSchedule` follows: a pure module, no Nest, no Prisma, no
  import statement at all, unit-tested directly against a table of cases.
- `apps/api/src/ai/ai-model-roles.ts` — the `embed` role, declared and
  unwired, cited in §9 as exactly the kind of "declared now, built later"
  seam this document does not reach into for weak-area clustering.
- `CLAUDE.md`'s "Adding a practice session kind" — the pattern §5 follows to
  wire `review`/`weak`/`mixed` into `PracticeService.createSession`, already
  declared in the `PracticeSessionKind` enum and already unwired for exactly
  this epic to wire.

**Nothing described past this line exists yet.** There is no
`question_mastery` table, no `apps/api/src/practice/mastery/` directory, no
`GET /api/practice/queue`, no `GET /api/progress/mastery`, and
`recommendNextAction` has no `review` branch. This document is what E5's
child issues (§11) build *against*, not a description of code already in the
repository. Every fact cited above about the *existing* codebase has been
verified against the files named; the *proposed* architecture in every other
section is a design, precise enough that a child issue's unit tests should be
written straight from §3's worked table rather than invented independently.

---

## 1. Where this sits relative to E1, E3, and E4

E1 (`journey-shell.md`) shipped `learner_profiles.stage` and `.timezone`, and
`Clock`. E3 (`practice-sessions.md`) shipped `practice_attempts` — the
evidence — and the deterministic exact-match grader. E4 (`ai-evaluation.md`)
shipped a second grading path on top of it: an AI verdict of `correct` /
`partial` / `incorrect`, recorded with `gradingMethod: 'ai'`, plus the
self-mark escape hatch's own `gradingMethod: 'self'`.

None of the three answers the two questions this epic exists to answer:
**does this learner actually know this question**, verified rather than
assumed, and **what should they do right now**, without being shown a wall of
options. `question_mastery` (§2) is the first; the Study Coach (§6) is the
second, and it is a *consumer* of the first, not an independent guess — every
sentence the Coach renders is derived from mastery state that already exists
in the database by the time it runs.

---

## 2. `question_mastery`

One row per `(user, question)` pair, created the first time that question
ever produces a **schedulable** outcome (§3.2 defines that term precisely —
it excludes `skipped`) and updated on every schedulable outcome after that.
There is no row for a question the learner has never had a schedulable
outcome on; the state such a question is in is `new`, and that fact is true
by the *absence* of a row, never by a row that says so (the same "absence is
the default" idiom `PracticeAttempt.aiFeedback`/`failureCause` already use
for "no grader ran" — journey-shell.md's honesty rule, one table over).

| Column | Prisma type (design level) | Nullable | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | House convention — the epic's own text names only the unique pair below as identifying, but every table in this schema carries a synthetic `id`, and this one is no exception. |
| `userId` | `String @db.Uuid` | no | FK → `users.id`, `onDelete: Cascade` — the same posture `PracticeAttempt.userId` already takes: a learner's own derived mastery state has no meaning independent of the account it summarizes. |
| `questionId` | `String @db.Uuid` | no | FK → `civics_questions.id`, `onDelete: Restrict` — mirrors `PracticeAttempt.questionId` exactly, for the identical reason: a question cannot be deleted while a learner's mastery of it is still on record. **No separate `testVersionCode` column** — `civics_questions` already belongs to exactly one test version, and a mastery row's version is implied by its question, the same reasoning `PracticeAttempt` itself uses (only `PracticeSession` carries `testVersionCode` directly). |
| `state` | `QuestionMasteryState` (Postgres enum), default `new` | no | `new` \| `learning` \| `review` \| `lapsed` \| `mastered` — §3 is the complete state machine. **Practically unreachable as a stored value**: because a row is created the moment a question first becomes schedulable, and creation always computes at least one transition out of `new` in the same write (§3.2), no row is ever left sitting in the database with `state: 'new'` in steady state — the default exists so the column type is total, and so a future caller reading a row mid-transaction sees a defined value, not because a query is expected to find one. A question genuinely in the `new` state is a question with **no row at all**. |
| `dueAt` | `DateTime @db.Timestamptz` | no | The instant this question re-enters the selector's "due" bucket (§5). **Not nullable, and always set on creation** — §3.3 gives the exact derivation (local-midnight arithmetic in the learner's own timezone, per `ROADMAP.md` §7's "local days are explicit" rule), which always produces a real value, even for a question's very first scheduled row. |
| `intervalDays` | `Int`, default `0` | no | The spacing this row's last schedule computed, in whole days. `0` only as the column's structural default for a row that (per the `state` note above) is never actually read in that shape — every real row's `intervalDays` is at least `LEARNING_STEP_DAYS` (`1`, §3.1) the instant it is created. |
| `ease` | `Float`, default `2.5` | no | The SM-2-style easiness factor. §3.1 gives the exact bounds (`[1.3, 3.0]`) and deltas; `2.5` is `EASE_DEFAULT`, the SM-2 convention this variant keeps rather than inventing a different starting point with no external referent. |
| `correctStreak` | `Int`, default `0` | no | Consecutive **objectively**-graded (`gradingMethod` `'exact'` or `'ai'`, outcome `correct`) answers since the last reset. §3.4 states, as its own named rule, why this column is the one gate `correct_self`/`partial` can never advance — the mechanism that makes self-mark's discount concrete for state *transitions*, distinct from §3.5's mechanism for the distinct-day count. |
| `lapses` | `Int`, default `0` | no | How many times this question has fallen out of `review`/`mastered` back into `lapsed`. Incremented **exactly once per transition into `lapsed`** — never once per subsequent miss while already there (§3's Row 8) — because it answers "how many times has this been forgotten after being verified," not "how many wrong answers has this question ever received." |
| `totalAttempts` | `Int`, default `0` | no | Count of **schedulable** outcomes this row has been updated for — `correct`, `correct_self`, `partial`, `incorrect`. **Excludes `skipped`** attempts entirely (§3.2): a skip never touches this row, so it is not counted here either. This is deliberately not the same number as `practice_attempts`'s own per-question attempt count, which does include skips — the two answer different questions, the same way `practice_sessions.summary` and a live `practice_attempts` aggregate can legitimately differ (`practice-sessions.md` §10's "recent sessions" note). |
| `distinctCorrectDays` | `Int`, default `0` | no | **The column that makes `VISION.md`'s rule enforceable.** Counts distinct calendar days (learner's own timezone) on which this question has received a **credit-eligible** outcome — `correct` or `correct_self`, never `partial`, never more than once per day regardless of how many credit-eligible attempts land on the same day (§3.5). This is *not* a running attempt count and *not* a percentage; it is a count of **days**, specifically so that answering the same question correctly ten times between 2pm and 2:15pm produces `distinctCorrectDays: 1`, not `10` — the exact failure `PRD.md` names by name ("A user who correctly answers ten questions immediately after studying them should not appear highly ready"). A count-of-attempts column could not distinguish "ten correct answers in one sitting" from "one correct answer on each of ten different days"; a count-of-days column cannot help but distinguish them, which is why this is the column the mastery promotion rule (§3.5) reads, not `totalAttempts` or `correctStreak`. |
| `lastOutcome` | `QuestionMasteryOutcome` (Postgres enum) | no | `correct` \| `correct_self` \| `partial` \| `incorrect` — the outcome that produced this row's current shape. **Not nullable**: a row only exists once at least one schedulable outcome has been recorded, so there is no "row exists but nothing has happened yet" state to represent (the same reasoning that keeps `PracticeAttempt.gradingMethod` `NOT NULL`, `practice-sessions.md` §8.1). A distinct enum from `PracticeOutcome` on purpose — `skipped` is not a member, because it is never a value this column can hold (§3.2). |
| `lastAttemptAt` | `DateTime @db.Timestamptz` | no | `Clock.now()` at the moment of the schedulable outcome that last updated this row. Read by the selector's "weak" bucket ordering (§5) and by the Study Coach's recency input (§6), never by `nextSchedule` itself to derive "already credited today" (§3.5 states explicitly why that derivation is unsafe from this column alone). |
| `createdAt` / `updatedAt` | `DateTime @db.Timestamptz` | no | House convention, present on every table in this schema; not named in the epic's own column list but added here for the same reason `practice_sessions.updatedAt` exists — `updatedAt` moves on every scheduling write, unlike `practice_attempts`, which is genuinely immutable end to end. |

```
@@unique([userId, questionId])
@@index([userId, dueAt])
@@index([userId, state])
@@map("question_mastery")
```

The first two are epic #54's own acceptance criteria, verbatim. **The third
is one addition beyond the issue's literal list, added here rather than left
for a later migration**: §5's "lapsed and weak" bucket filters by `state`
directly, unmoderated by `dueAt` — a `lapsed` row is eligible for the queue
regardless of whether it happens to be "due" yet, so a query that can only
range-scan `(userId, dueAt)` would have to fall back to a sequential scan
filtered by `state` for that bucket. Adding the index now, before any row
exists, costs nothing; adding it later is the identical migration-over-live-
data trade-off `practice-sessions.md` §2.1 already accepts once for a
different index and does not need repeating on this table needlessly.

---

## 3. `nextSchedule` — the pure SM-2-variant scheduler

`apps/api/src/practice/mastery/scheduler.ts` (issue #75). No Nest, no Prisma,
no import statement at all — the identical shape `answer-matching.ts` and
`answer-resolution.ts` already establish for a rule that must never drift and
must be directly unit-testable, table of cases and all, per this document's
own §11.

```ts
export type QuestionMasteryState = 'new' | 'learning' | 'review' | 'lapsed' | 'mastered';
export type MasteryOutcome = 'correct' | 'correct_self' | 'partial' | 'incorrect';

/** The row's shape immediately BEFORE this schedule runs. `state: 'new'`
 *  with every numeric field at its column default is what the caller passes
 *  when no row exists yet — see NEW_MASTERY_SNAPSHOT below. */
export interface MasterySnapshot {
  state: QuestionMasteryState;
  intervalDays: number;
  ease: number;
  correctStreak: number;
  lapses: number;
  totalAttempts: number;
  distinctCorrectDays: number;
}

export interface NextScheduleContext {
  outcome: MasteryOutcome;
  /** Clock.now() — nextSchedule takes "now" as data and reads no clock
   *  itself, the same reason every pure function in this codebase does. */
  now: Date;
  /** learner_profiles.timezone — for calendar-day arithmetic (§3.3). */
  timezone: string;
  /** Computed by the CALLER from practice_attempts, never derived here from
   *  the mastery row alone. §3.5 states exactly why and exactly how. */
  alreadyCreditedToday: boolean;
}

export interface MasterySchedule extends MasterySnapshot {
  dueAt: Date;
  lastOutcome: MasteryOutcome;
  lastAttemptAt: Date;
}

export const NEW_MASTERY_SNAPSHOT: MasterySnapshot = {
  state: 'new',
  intervalDays: 0,
  ease: 2.5,
  correctStreak: 0,
  lapses: 0,
  totalAttempts: 0,
  distinctCorrectDays: 0,
};

export function nextSchedule(
  prior: MasterySnapshot,
  ctx: NextScheduleContext,
): MasterySchedule;
```

### 3.1 Constants

| Constant | Value | Meaning |
|---|---|---|
| `EASE_DEFAULT` | `2.5` | SM-2's own convention — no external referent to invent a different starting point from. |
| `EASE_MIN` | `1.3` | Floor. A row this hard still reviews, just at the shortest cadence this algorithm produces. |
| `EASE_MAX` | `3.0` | Ceiling. Prevents an unbroken correct streak from producing runaway multi-year intervals. |
| `EASE_DELTA_CORRECT` | `+0.1` | Applied only for an **objective** `correct` outcome. |
| `EASE_DELTA_INCORRECT` | `-0.2` | Applied for `incorrect`, regardless of prior state. |
| `LEARNING_STEP_DAYS` | `1` | The fixed interval used for every row in `learning` or `lapsed` state below the graduation gate. |
| `GRADUATION_STREAK` | `2` | The `correctStreak` value that promotes `learning`/`lapsed` → `review`. |
| `GRADUATION_INTERVAL_DAYS` | `6` | The flat interval a row is given the instant it graduates — deliberately **not** ease-multiplied, so the graduation row in a worked table is hand-verifiable without compounding two prior ease bumps. |
| `REVIEW_MULTIPLIER_FULL` | `1.0` | Interval growth multiplier in `review`/`mastered` state for an objective `correct`. |
| `REVIEW_MULTIPLIER_DISCOUNTED` | `0.5` | Interval growth multiplier for `correct_self` and `partial` — the concrete number behind "advances the schedule less" (§3.4). |
| `MASTERY_DISTINCT_DAYS_REQUIRED` | `3` | §3.5's promotion threshold, taken directly from `VISION.md`/`PRD.md`. |

Interval results are always rounded to the nearest whole day (round-half-up)
and floored at `1` — a `dueAt` of "today" is never produced by this function;
the earliest a question can be shown again is tomorrow, local time.

### 3.2 What `nextSchedule` is never called for

**`skipped` is not a member of `MasteryOutcome`, and a skipped attempt never
reaches this function at all.** `practice-sessions.md` §9.1 already states
the reason in full for the attempt row itself — "seeing the answer without
ever producing or claiming one is not evidence of recall in either
direction" — and this document adopts that ruling rather than re-deriving it:
a skip leaves the `question_mastery` row, if one exists, completely
untouched. `totalAttempts` on that row therefore counts strictly fewer
attempts than the same question's row count in `practice_attempts`, and that
gap is intentional, not a bug to reconcile.

### 3.3 `dueAt` derivation

`dueAt` is computed as **the UTC instant that begins the learner's local
calendar day, N days from today**, where N is the newly computed
`intervalDays` and "today" is `Clock.calendarDateIn(timezone)` at the moment
of the write:

```
dueAt = startOfLocalDayInUTC(addDays(clock.calendarDateIn(timezone), intervalDays), timezone)
```

This is deliberately **not** `now + N * 24h`. A learner reviewing at 11pm and
one reviewing at 7am on the same local day, both scheduled `intervalDays: 1`,
become due at the identical instant — local midnight the next day — rather
than at two different times exactly 24 hours after their own answer. "Due
tomorrow" means *available all of tomorrow*, the same local-day framing
`ROADMAP.md` §7 already requires for `daily_activity` and streaks, applied
here to scheduling instead of engagement.

### 3.4 State transitions, and the rule that gates every one of them

Five states, four real transitions (`new` is never itself a stored value —
§2):

```
(no row)
   │  any schedulable outcome
   ▼
learning ──2 consecutive OBJECTIVE 'correct' (GRADUATION_STREAK)──▶ review
   ▲                                                                  │
   │ 1 objective 'correct'                                            │ miss
   │ (re-graduation, same gate as above)                              ▼
lapsed ◀──────────────────── miss (from review OR mastered) ──── mastered
                                                                       ▲
                                                          distinctCorrectDays
                                                          reaches 3, state
                                                          already 'review'
```

**The load-bearing rule, stated once, referenced everywhere below:**
`correctStreak` — the column every state-*crossing* transition in the diagram
above is gated on — is incremented **only** by an objective `correct`
outcome (`gradingMethod` `'exact'` or `'ai'`). `correct_self` and `partial`
leave it exactly where it was: neither incremented (they are not confirmed
recall) nor reset (they are not evidence *against* recall either).
Consequently:

- **`learning`/`lapsed` → `review` requires two objective corrects.** A row
  sitting at `correctStreak: 1` because of an objective correct, then given a
  `correct_self` or a `partial`, stays at `correctStreak: 1` and does not
  graduate — the row's `dueAt` still moves (it "holds at the current step,"
  below), but the state boundary does not.
- **`lapsed` → `learning` requires the *first* objective correct after the
  lapse.** A `correct_self` or `partial` recorded while `lapsed` leaves the
  row `lapsed`, for the identical reason.

**Interval effect of `correct_self`/`partial` while in `learning`/`lapsed`
("holding the step"):** because these two outcomes never move
`correctStreak`, and `LEARNING_STEP_DAYS` is a flat constant rather than an
ease-multiplied one, the row is simply re-scheduled at the *same* step —
`intervalDays` stays `LEARNING_STEP_DAYS` (`1`) and `dueAt` moves to
tomorrow, exactly as if the row had just entered `learning` for the first
time. There is no fractional or fifty-percent version of a one-day step to
express; the discount here is expressed entirely through what these outcomes
*cannot* do (advance the streak, cross the graduation gate), not through a
smaller number.

**Interval effect in `review`/`mastered`:** here the discount *is* a number,
because the interval is already ease-multiplied and a smaller multiplier is
a real, visible difference: `intervalDays = round(intervalDays * ease *
REVIEW_MULTIPLIER)`, where `REVIEW_MULTIPLIER` is `1.0` for `correct` and
`0.5` for `correct_self`/`partial` (§3's Row 4 vs. Row 6 for exact size).

**A miss (`incorrect`) from `review` or `mastered` is a lapse; a miss from
`learning` or `lapsed` is not.** Only the first increments `lapses` and moves
`distinctCorrectDays` back to `0` (§3.6) — a question that was never
verified in the first place cannot fall *out of* verified status, so a miss
while still learning simply resets the streak and interval, exactly as a
fresh `learning` row would, without touching `lapses` at all. A repeated
miss while **already** `lapsed` does not increment `lapses` a second time
(§3's Row 8) — the counter answers "how many times has this been forgotten,"
which is a fact about *transitions into* `lapsed`, not about every subsequent
wrong answer recorded while already there.

### 3.5 `distinctCorrectDays`: the axis self-mark is never discounted on

`distinctCorrectDays` increments by **at most one per calendar day**, on
outcome `correct` **or** `correct_self` — never `partial`, which is real but
substantively incomplete evidence, not a correct answer. It resets to `0`
the instant a row lapses (§3.6 explains why zero, not a partial reduction).

**The `alreadyCreditedToday` boolean cannot be derived from `question_mastery`'s
own columns, and that is stated here explicitly because a naive
implementation gets it wrong.** The obvious-looking shortcut — "compare
today's calendar date to `lastAttemptAt`'s calendar date; skip crediting if
they match" — breaks on the single most common multi-attempt-per-day
sequence this product has: an attempt graded `incorrect` this morning,
revealed, and self-marked `correct_self` an hour later, same calendar day.
Under the shortcut, the self-mark's own scheduling call would see
`lastAttemptAt` already stamped *today* (from the morning's miss) and
wrongly skip the credit the self-mark itself is supposed to earn.

So the caller — `apps/api/src/practice/mastery/mastery.service.ts` — computes
`alreadyCreditedToday` from `practice_attempts` directly, not from the
mastery row: a single query, using the same `[userId, questionId,
answeredAt]` index `practice-sessions.md` §2.2 already ships, for whether any
**other** row for this `(user, question)` already has `answeredAt` on
today's calendar date (learner's timezone) and either `outcome: 'correct'`
or `gradingMethod: 'self'`. `question_mastery` is deliberately a compact
summary row with no per-day history; `practice_attempts` is the table that
actually has one, and this is the one place the scheduler needs to consult it
rather than its own cached summary.

### 3.6 Why a lapse resets `distinctCorrectDays` to zero, not partially

A softer alternative — halving the count, or decaying it — was considered
and rejected. `VISION.md`'s own language is "revisit what is becoming
stale," and a lapse is the concrete event that makes a question's prior
evidence stale: the fact that it was once answered correctly on three
different days does not change, but it stops being a reliable *predictor* of
today's recall the moment the learner demonstrably forgets it. A partial
reset (say, to `1`) would let a single fresh correct answer after a lapse
put the row back at `distinctCorrectDays: 2` and one more ordinary review
away from `mastered` again — re-earning "verified" status without the
multi-day re-confirmation `VISION.md` requires the first time. Zero is the
only value that makes "mastered again" require the same fresh, multi-day
evidence "mastered" required the first time.

### 3.7 Why self-mark can complete mastery but can never start it

Two different gates in this design, deliberately asymmetric, and named here
because the asymmetry is easy to mistake for an inconsistency rather than a
decision:

- **`learning`/`lapsed` → `review`** is gated on `correctStreak`, which only
  an objective `correct` advances. Self-mark **cannot** promote a question
  into verified territory in the first place — a row with no independently-
  confirmed correct answer at all never leaves active learning no matter how
  many times the learner self-marks it.
- **`review` → `mastered`** is gated on `distinctCorrectDays`, which a
  `correct_self` **does** advance. Self-mark **can** supply the third
  distinct day that completes a mastery claim already substantially
  supported by objective evidence.

The distinction is what "already substantially supported" means concretely:
by the time a row is sitting in `review` at all, it has already graduated
through two independent, machine-confirmed correct answers (§3.4). A
self-mark at that point is corroborating testimony added to a claim with
real evidence behind it, not the sole basis for the claim — which is exactly
epic #54's own decision 2, "discounted, not ignored," read literally: ignored
would mean self-mark counts for nothing on the axis that defines mastery;
discounted means it counts, but only ever as the *completing* signal, never
the *founding* one.

### 3.8 Worked transitions

Every row below is a complete, self-contained input/output pair a unit test
should be able to assert directly. "Day N" is a relative calendar day in the
learner's own timezone, not a literal date.

| # | Scenario | Prior state | Prior fields (`interval`/`ease`/`streak`/`lapses`/`total`/`distinctDays`) | `outcome` | credited today? | New state | New fields | `dueAt` | Why |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Brand-new question, first-ever attempt, exact match | *(no row)* | `0`/`2.5`/`0`/`0`/`0`/`0` | `correct` | no | `learning` | `1`/`2.6`/`1`/`0`/`1`/`1` | Day 2 | First schedulable outcome creates the row and immediately advances it past the implicit `new` state — §2's "no row ever persists `state: 'new'`" claim, in practice. |
| 2 | Same question, Day 2, second consecutive objective correct | `learning` | `1`/`2.6`/`1`/`0`/`1`/`1` | `correct` | no | `review` | `6`/`2.7`/`2`/`0`/`2`/`2` | Day 8 | `correctStreak` reaches `GRADUATION_STREAK` (2) — graduates to `review` at the flat `GRADUATION_INTERVAL_DAYS` (6), not an ease-multiplied value. |
| 3 | A **different** brand-new question, first-ever attempt is a **miss** | *(no row)* | `0`/`2.5`/`0`/`0`/`0`/`0` | `incorrect` | — | `learning` | `1`/`2.3`/`0`/`0`/`1`/`0` | Day 2 | Never entered `review`/`mastered`, so this is not a lapse (`lapses` stays `0`) — just the ordinary start of learning, one miss in. |
| 4 | Row 2's question, Day 8, third distinct day, objective correct | `review` | `6`/`2.7`/`2`/`0`/`2`/`2` | `correct` | no | **`mastered`** | `16`/`2.8`/`3`/`0`/`3`/`3` | Day 24 | `distinctCorrectDays` reaches `MASTERY_DISTINCT_DAYS_REQUIRED` (3) while `state: 'review'` — promotion. Interval math is unchanged by the promotion (`round(6 × 2.7 × 1.0) = 16`); only the `state` label changes. |
| 5 | Row 4's question, much later, a miss while `mastered` | `mastered` | `16`/`2.8`/`3`/`0`/`3`/`3` | `incorrect` | — | `lapsed` | `1`/`2.6`/`0`/`1`/`4`/`0` | +1 day | A real lapse: `lapses` increments, `distinctCorrectDays` resets to `0` (§3.6), interval collapses to `LEARNING_STEP_DAYS`. |
| 6 | Row 5's question, next day, **self-marked** correct | `lapsed` | `1`/`2.6`/`0`/`1`/`4`/`0` | `correct_self` | no | `lapsed` (**unchanged**) | `1`/`2.6`/`0`/`1`/`5`/`1` | +1 day | `correctStreak` never moves for `correct_self`, so the row cannot cross `lapsed → learning` (§3.7) — it "holds the step," due again tomorrow. `distinctCorrectDays` **does** credit (`0→1`): the discount lives in the state gate, not the day count. |
| 7 | An established `review` question receives an **AI partial verdict** | `review` | `10`/`2.5`/`4`/`0`/`6`/`2` | `partial` | no | `review` (**unchanged**) | `13`/`2.5`/`4`/`0`/`7`/`2` | +13 days | `intervalDays = round(10 × 2.5 × 0.5) = 13` — real but half-strength growth (an objective correct here would have produced `round(10 × 2.5 × 1.0) = 25`). `distinctCorrectDays` does **not** credit — `partial` is not a correct answer. |
| 8 | A **repeated** miss while already `lapsed` | `lapsed` | `1`/`1.35`/`0`/`2`/`9`/`0` | `incorrect` | — | `lapsed` (**unchanged**) | `1`/`1.3`/`0`/`2`/`10`/`0` | +1 day | `lapses` stays `2` — only the `review`/`mastered → lapsed` *transition* increments it, not every subsequent miss while already there. `ease` floors at `EASE_MIN` (`1.3`), not the uncapped `1.15`. |

---

## 4. Why scheduling is synchronous

`nextSchedule` runs **inside the same Prisma transaction as the evidence
write it is scheduling from** — twice over, because `practice-sessions.md`
§9/§15 records that self-mark shipped as a genuine second write against an
already-persisted attempt row, not folded into the first:

1. `POST /api/practice/sessions/:id/attempts` (issue #78) — the `$transaction`
   that already writes the `practice_attempts` row is extended to also
   upsert `question_mastery` (creating it from `NEW_MASTERY_SNAPSHOT` if this
   is the question's first schedulable outcome) and, inside the same
   transaction, apply §7's stage-transition check.
2. `POST /api/practice/sessions/:id/attempts/:attemptId/self-mark` — its own
   `UPDATE` of the attempt row gains the identical extension: a second
   `nextSchedule` call, with `outcome: 'correct_self'`, against whatever the
   mastery row's state already was.

**This reuses, and then deliberately diverges from, the rationale
`apps/api/src/notifications/notifications.service.ts`'s own header already
gives in full** — `ROADMAP.md` §7's "No job queue" rule names that file
directly as the reasoning to reuse rather than re-derive: no broker, no
worker process, no job table anywhere in this application, and the volumes
here (one scheduling computation per graded attempt) do not justify
introducing the first one. That much is identical.

**Where this document's reasoning parts ways with that file's:**
notifications are dispatched **detached** — `notify()` schedules the send on
a later microtask and returns immediately, accepting "no durability and no
retry" as a stated trade-off, because a lost notification is, at worst, a
missed email. Mastery scheduling cannot accept that trade at all. An attempt
recorded without its corresponding `question_mastery` update would be
evidence that silently never entered the spaced-repetition system — and
because `ROADMAP.md` §7 also rules out a cron sweep or a retry queue, nothing
would ever notice or repair the gap. So scheduling here is **captured, not
detached**: part of the same atomic transaction as the evidence write, which
either both commit or neither does, rather than fire-and-forget best effort
on top of a commit that already happened.

---

## 5. Selector v2 — `GET /api/practice/queue`

`apps/api/src/practice/mastery/queue-selector.ts` (issue #78) exports
`buildQueue(userId, testVersionCode, options)`, the ordering both the read
endpoint below and `PracticeService.createSession`'s new `review`/`weak`/
`mixed` branches (`CLAUDE.md`'s "Adding a practice session kind" pattern —
these three enum values are already declared, unwired, in
`PracticeSessionKind`) draw from — one function, so the counts a learner sees
on the picker screen match what a session started moments later actually
contains.

Four buckets, filled **in order**, each exhausted before the next is
touched, until the requested count is reached:

| # | Bucket | Definition | Order within bucket |
|---|---|---|---|
| 1 | **Due** | `state IN ('review', 'mastered')` AND `dueAt <= now` | `dueAt` ascending — most overdue first. |
| 2 | **Lapsed and weak** | `state = 'lapsed'` **OR** `lastOutcome IN ('incorrect', 'partial')` (regardless of `state` or `dueAt` — a `lapsed` row is always eligible immediately; a `learning` row whose most recent evidence was a miss counts as "weak" the same way) | `lastAttemptAt` ascending — longest-neglected first. |
| 3 | **New, by category coverage** | Questions with **no** `question_mastery` row at all | Round-robin across `civics_categories` in their existing render `sort` order — one question from each category per pass — rather than exhausting one category before moving to the next, so early practice touches breadth before depth. |
| 4 | **Sampled mastered** | `state = 'mastered'` AND `dueAt > now` (a due mastered row is already in bucket 1) AND not attempted (any outcome) within the last `MASTERED_SAMPLE_COOLDOWN_DAYS` | Uniform random sample, capped at `MASTERED_SAMPLE_RATE` of the queue's total requested slots |

| Constant | Value |
|---|---|
| `MASTERED_SAMPLE_RATE` | `1/20` (5%) of the queue's requested slot count, rounded down |
| `MASTERED_SAMPLE_COOLDOWN_DAYS` | `14` |

Bucket 4 exists specifically to satisfy epic #54's own decision 5 and
`VISION.md`'s "continue sampling what appears strong so that mastery is
verified rather than assumed" — without it, a `mastered` question with a long
interval could go unreviewed for months on the strength of a state label
alone. A **5-question Quick 5 draws zero mastered samples on average**
(`round(5 × 0.05) = 0`); a 20-question `mixed` session draws one. The
14-day cooldown exists so the same mastered question is not repeatedly
sampled across several short sessions in the same week, spreading coverage
across the whole mastered pool rather than always resurfacing whichever
mastered question happens to sort first.

`GET /api/practice/queue` (`@Auth()`, no permission — the same posture every
other `/api/practice/*` route already takes, `practice-sessions.md` §10) is a
**read-only counts endpoint**, per the epic's own text ("exposes the counts
the Practice page renders") — it does not create a session. Response shape:

```json
{
  "testVersionCode": "v2025",
  "due": 4,
  "lapsedOrWeak": 2,
  "newAvailable": 116,
  "masteredSampleAvailable": true
}
```

A learner who wants to *act* on these counts starts a session with
`POST /api/practice/sessions`, `kind: 'review' | 'weak' | 'mixed'` — the
existing endpoint, gaining new selector branches that call the same
`buildQueue`, exactly the pattern `kind: 'category'` already uses today.

---

## 6. The deterministic Study Coach

`apps/api/src/journey/study-coach.ts` (issue #82) widens
`apps/api/src/journey/next-action.ts`'s closed `NextActionKind` union by
exactly the one member its own header already anticipates by name: `review`.
Nothing about the existing four kinds' ordering or paths changes —
`orientation > interview_countdown > review > practice > explore` — `review`
slots in between the two E1/E3 both already gate on "is there an interview
coming up" and "has the learner practiced today," because reviewing material
that is due or lapsed is a more specific, more urgent true thing to say than
a generic five-question nudge, but never more urgent than an actual
interview date on the calendar.

```ts
// Widens NextActionInput (journey-shell.md §4) with exactly the facts this
// epic's mastery data adds — nothing broader.
interface StudyCoachInput extends NextActionInput {
  dueCount: number;        // question_mastery rows in bucket 1 or 2 of §5
  lapsedCount: number;     // rows specifically in state 'lapsed'
}
```

- **`review`** — fires when `dueCount + lapsedCount > 0`, ranked between
  `interview_countdown` and `practice`. `path: '/practice'` — the same
  destination `practice` and `interview_countdown` already share
  (`next-action.ts`'s own comment: "two kinds naming one destination, not a
  duplicated branch"); the Practice page reads `nextAction.kind` to decide
  which session kind to default into. Reason, templated and deterministic:
  *"You have {dueCount} question{s} ready to review — reviewing what you've
  already learned keeps it from slipping."*

**Why this must be a pure function, stated as plainly as `next-action.ts`'s
own header states it, because the reasoning does not change one epic later:**
"what should I do next" must produce an identical, explainable answer on two
consecutive loads, must work with no AI key configured at all, and must never
put a provider outage in front of the single most-viewed card in the
product. E6 (`docs/specs/ai-evaluation.md`'s `tutor` role) may layer a
model-written narrative *gloss* on top of whatever `kind`/`reason` this
function already decided — epic #54's own decision 4 says so explicitly —
but the decision itself never moves into `AiDispatchService`. Reusing that
dispatch path here would make a value multiple other systems depend on being
exactly reproducible (journey-shell.md §4.1's "never a route that redirects
to `/`" invariant is enforced by `kind` mapping to one hardcoded path — a
model choosing `kind` freely would reopen exactly the free-form-string risk
§4.1 already closed) into something a model call could make nondeterministic.

`dueCount` and `lapsedCount` are computed the same way `GET
/api/practice/queue`'s response is (§5) — one shared query, not a duplicate
count kept in sync by convention.

---

## 7. Evidence-driven stage transitions: `oriented → learning → remembering`

`apps/api/src/journey/stage-transitions.ts` (issue #82) — a small, pure
function, deliberately shaped like `nextSchedule` itself: no Prisma, no
Clock, just prior/next facts in and a decision out.

```ts
function nextStageOnMasteryEvent(
  currentStage: JourneyStage,
  priorMasteryState: QuestionMasteryState,
  nextMasteryState: QuestionMasteryState,
): JourneyStage | null; // null means "no change"
```

Two rules, each stated once in `ROADMAP.md`'s decision log and implemented
here exactly as named:

- **`oriented → learning`**: fires when `currentStage === 'oriented'`,
  unconditionally — "the spaced-repetition scheduler begins tracking
  questions for this learner" is true the instant **any** schedulable
  outcome produces a `question_mastery` row, whether that outcome was
  `correct` or `incorrect` (Row 3, §3.8). Because `stage` only ever moves
  forward and this check reads the profile's *current* stage inside the same
  transaction, "the first time this fires" and "every time this fires while
  still `oriented`" are the same event — there is no separate "is this
  really the first row" query to write; the guard is the stage comparison
  itself.
- **`learning → remembering`**: fires when `currentStage === 'learning'` and
  `priorMasteryState !== 'mastered' && nextMasteryState === 'mastered'` — a
  question was just verified as mastered for the first time. Both facts are
  already sitting in `nextSchedule`'s own return value from the same
  transaction (§3.8's Row 4 is exactly this event); no separate count of
  "how many mastered rows does this user have" is computed, for the same
  reason the `oriented` guard needs none.

Both checks run **inside the same transaction** as the `question_mastery`
write that triggers them (§4) — the identical "decided the moment it becomes
knowable, never on a timer" posture `practice-sessions.md` §5 already
establishes for `abandoned` sessions. `speaking` and `ready`
(`journey-shell.md` §1) remain E9's and E6's respectively; nothing here
touches either.

---

## 8. `GET /api/progress/mastery`

`apps/api/src/progress/` (issue #86) — a new, small module; `@Auth()`, no
permission, no user-id parameter, the same posture every other per-user
route in this product already takes.

```json
{
  "testVersionCode": "v2025",
  "totalQuestions": 128,
  "attempted": 64,
  "byState": { "new": 64, "learning": 20, "review": 30, "lapsed": 4, "mastered": 10 },
  "categories": [
    {
      "categoryId": "…",
      "name": "American Government",
      "totalQuestions": 57,
      "byState": { "new": 20, "learning": 10, "review": 15, "lapsed": 2, "mastered": 10 },
      "masteredCount": 10
    }
  ]
}
```

`totalQuestions` and each category's own count come from `civics_questions`
(E2's content, scoped to the caller's `testVersionCode`); `byState` is a
`GROUP BY state` over the caller's own `question_mastery` rows, joined to
each question's category for the per-category breakdown. `attempted` is
`totalQuestions - byState.new`. This is a read aggregate with no scheduling
side effect of its own — it never calls `nextSchedule` and never writes.

---

## 9. Out of scope (deliberately)

Epic #54's own text names these explicitly; restated here so a later reader
does not mistake a silence in this document for an oversight:

- **The readiness score.** E6 (#55) reads `question_mastery` as one of its
  inputs (retention and remediation signals) but computes nothing about
  readiness here — `ROADMAP.md` §7's "Engagement never moves readiness" rule
  keeps this boundary structural once both exist.
- **Streaks, goals, and reminders.** E7 (#56) reads `practice_attempts` and,
  once it exists, `question_mastery`'s `dueAt`/`lapses`, for reminder
  triggers and streak protection — nothing in this epic computes engagement
  metrics of any kind.
- **Embedding-based weak-area clustering.** `apps/api/src/ai/ai-model-roles.ts`'s
  `embed` role stays declared and unwired through this epic exactly as it
  has since #25 — `ROADMAP.md` §8's post-MVP backlog names retrieval-based
  clustering explicitly as real future value that nothing in E1–E11 needs.
  §5's "weak" bucket is a simple, explainable rule over `lastOutcome`
  (§5), never a similarity search.
- **Mock-interview attempts feeding the scheduler.** E8 (#57) is the epic
  that writes `practice_attempts` rows with `source: 'mock_interview'`;
  whether those attempts also produce `question_mastery` updates is E8's own
  design question, not answered here.
- **FSRS, or any alternative to the SM-2 variant in §3.** §10 records why.

---

## 10. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **FSRS instead of an SM-2 variant** | FSRS's own parameters (stability, difficulty, retrievability) are fit from a large corpus of real review logs this product has none of on day one; an untrained, default-parameter FSRS is not demonstrably better than a well-understood SM-2 variant and is materially harder to specify exactly enough for issue #67's own acceptance criterion — "a table of cases the sibling scheduler's unit tests can be written straight from." §3's constants and worked table are hand-verifiable line by line; nothing about this design forecloses swapping `nextSchedule`'s internals later, since every caller depends only on its pure signature. |
| **A job queue for scheduling** | `ROADMAP.md` §7's "No job queue" rule, restated by `notifications.service.ts`'s own header for a different feature and inherited here rather than re-derived (§4): no broker, no worker process, and no second failure mode anywhere in this app for a computation this cheap. Mastery scheduling additionally cannot tolerate the detached, best-effort posture a queue (or `notify()`'s own fire-and-forget shape) would imply — §4 states the divergence explicitly. |
| **An AI-chosen next action** | `ROADMAP.md`'s 2026-09-02 decision log states the requirement outright: deterministic, identical across two consecutive loads, explainable in one sentence, and working with no AI key configured — none of which an inference call can guarantee. `next-action.ts`'s own header makes the identical argument one epic earlier: "a model call would make that a coin flip and would put a provider outage in front of the application's front page." §6. |
| **Withholding distinct-day credit entirely from self-marked answers** | Would make the discount indistinguishable from disqualification on the one axis — verified mastery — the epic's decision 2 ("discounted, not ignored") most directly protects. The chosen design discounts self-mark on the state-transition axis instead (§3.4, §3.7), so "weaker evidence" and "no evidence" stay genuinely different outcomes. |
| **Deriving `alreadyCreditedToday` from `question_mastery`'s own `lastAttemptAt`/`lastOutcome`** | Breaks on the ordinary same-day incorrect-then-self-marked sequence self-mark itself produces (§3.5) — a summary row that remembers only the single most recent attempt cannot answer "was *any* attempt today already credited." The caller queries `practice_attempts` directly instead, over an index that already exists. |
| **Resetting `distinctCorrectDays` partially (e.g., halving) on a lapse rather than to zero** | A partial reset still lets a single fresh correct answer after a lapse re-reach `mastered` without genuinely fresh multi-day evidence, failing `VISION.md`'s "revisit what is becoming stale" standard almost as surely as not resetting at all. §3.6. |
| **Letting `correct_self` advance `correctStreak`, treating it as equivalent to an objective correct for graduation purposes** | Would let a learner talk their way from `learning` straight to `review` — and, chained with an unmodified promotion rule, all the way to `mastered` — on self-assertion alone, with no independently-confirmed correct answer anywhere in the row's history. §3.4, §3.7. |

---

## 11. Worked examples / live examples footer

None of the files below exist yet; every path is chosen to match this
codebase's existing conventions (`apps/api/src/practice/`,
`apps/api/src/journey/`) rather than invented ad hoc, since #71–#98 build
directly against these locations. The mapping from epic #54's own
child-issue list to the issue numbers named throughout this document:

| Issue | Child-issue item (epic #54) | Files this document specifies for it |
|---|---|---|
| **#67** (this document) | Design spec | `docs/specs/memory-model.md` |
| **#71** | Migration — `question_mastery` (+ backfill) | `apps/api/prisma/schema.prisma` (`QuestionMastery` model, `QuestionMasteryState`, `QuestionMasteryOutcome` enums — §2), a new `apps/api/prisma/migrations/…_add_question_mastery/` |
| **#75** | Pure scheduler + tests | `apps/api/src/practice/mastery/scheduler.ts` (`nextSchedule`, `NEW_MASTERY_SNAPSHOT` — §3), `apps/api/src/practice/mastery/scheduler.spec.ts` (§3.8's table, as literal test cases) |
| **#78** | Selector v2 and `GET /api/practice/queue` | `apps/api/src/practice/mastery/mastery.service.ts` (the upsert wrapper, `alreadyCreditedToday` query — §3.5, called from inside both attempt-write transactions — §4), `apps/api/src/practice/mastery/queue-selector.ts` (`buildQueue` — §5), `apps/api/src/practice/practice.controller.ts` (the new route), `PracticeService.createSession`'s new `review`/`weak`/`mixed` branches |
| **#82** | Study-coach recommender and stage transitions | `apps/api/src/journey/study-coach.ts` (§6), `apps/api/src/journey/next-action.ts` (widened `NextActionKind`/`NEXT_ACTION_PATHS`), `apps/api/src/journey/stage-transitions.ts` (`nextStageOnMasteryEvent` — §7) |
| **#86** | `GET /api/progress/mastery` | `apps/api/src/progress/progress.controller.ts`, `apps/api/src/progress/progress.service.ts` (§8) |
| **#90** | Practice queue UI and real home Next-up | `apps/web/src/pages/PracticePage.tsx` (real queue counts and session kinds), the Home Next-up card reading `study-coach.ts`'s `review` kind |
| **#94** | Progress page v1 | `apps/web/src/pages/ProgressPage.tsx` — supersedes `journey-shell.md` §8.3's designed empty state, the same **superseded, not deleted-and-forgotten** relationship `practice-sessions.md` §12 records for `/practice` |
| **#98** | Playwright `memory.spec.ts` | `tests/e2e/memory.spec.ts` — advances `X-Test-Clock` a day to prove §3.8's Row 1 → Row 2 graduation and the queue's "due" bucket without sleeping in real time, per `practice-sessions.md` §11's identical requirement for E3's own spec |
| **#102** | Docs | `CLAUDE.md` — a new "Adding to the memory model" Common Patterns entry, alongside "Adding a New AI Model Role" and "Adding a practice session kind"; `docs/API.md` — `GET /api/practice/queue` and `GET /api/progress/mastery` |
