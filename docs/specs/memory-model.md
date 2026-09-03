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
| `intervalDays` | `Int`, default `0` | no | The spacing this row's last schedule computed, in whole days. `0` only as the column's structural default for a row that (per the `state` note above) is never actually read in that shape — every real row's `intervalDays` is at least `LAPSE_INTERVAL_DAYS` (`1`, §3.1) the instant it is created. |
| `ease` | `Float`, default `2.5` | no | The SM-2-style easiness factor. §3.1 gives the exact bounds (`[1.3, 3.0]`) and deltas; `2.5` is `STARTING_EASE`, the SM-2 convention this variant keeps rather than inventing a different starting point with no external referent. |
| `correctStreak` | `Int`, default `0` | no | Consecutive correct answers since the last reset, incremented by **any** correct outcome — an objective `correct` and a self-marked `correct_self` credit it identically (§3.4; corrected here from an earlier draft of this design that gated this column to objective corrects only). Self-mark's discount is never expressed by holding this counter back; it is expressed entirely through smaller `ease` and `intervalDays` growth (§3.4). |
| `lapses` | `Int`, default `0` | no | How many times this question has fallen out of `review`/`mastered` back into `lapsed`. Incremented **exactly once per transition into `lapsed`** — never once per subsequent miss while already there (§3.8's Row 10) — because it answers "how many times has this been forgotten after being verified," not "how many wrong answers has this question ever received." |
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
| `STARTING_EASE` | `2.5` | SM-2's own convention — no external referent to invent a different starting point from. |
| `MIN_EASE` | `1.3` | Floor. A row this hard still reviews, just at the shortest cadence this algorithm produces. |
| `MAX_EASE` | `3.0` | Ceiling. Prevents an unbroken correct streak from producing runaway multi-year intervals. |
| `EASE_BUMP_CORRECT` | `+0.1` | Applied for an objectively-graded `correct` outcome. |
| `EASE_BUMP_SELF_MARKED` | `+0.05` | Exactly half of `EASE_BUMP_CORRECT` — the entire ease side of the self-mark discount (§3.4). |
| `EASE_PENALTY_INCORRECT` | `-0.2` | Applied for `incorrect`, regardless of prior state. |
| `LAPSE_INTERVAL_DAYS` | `1` | The interval a row is given on its first-ever correct repetition, **and** the interval any `incorrect` outcome collapses or resets to. One constant serves both roles in the shipped scheduler — there is no separate "first learning step" constant. |
| `SECOND_REPETITION_INTERVAL_DAYS` | `3` | The interval for a row's *second* correct repetition (`correctStreak` reaching `2`), before ease-driven growth begins. |
| `SELF_MARKED_INTERVAL_DISCOUNT` | `0.5` | Applied to the same base interval an objective `correct` would have computed for this repetition, then floored at `1` day — the entire interval side of the self-mark discount (§3.4). |
| `MASTERY_PROMOTION_THRESHOLD` | `3` | The `distinctCorrectDays` value that promotes `review` → `mastered`. §3.5/§3.7 record why this is the only gate on that promotion, self-mark included. |

**Interval progression for an objectively-graded `correct`:** 1st correct
repetition → `LAPSE_INTERVAL_DAYS` (1 day); 2nd →
`SECOND_REPETITION_INTERVAL_DAYS` (3 days); 3rd and every one after →
`round(previousIntervalDays × ease)`, floored at `1`. `correct_self` reuses
this exact same base — computed from the same `correctStreak`, the same
prior `ease`, the same prior `intervalDays` — and then applies
`SELF_MARKED_INTERVAL_DISCOUNT` to that base, floored at `1` day. There is
no second, independent interval progression for self-mark; the two variants
can never silently drift apart because one is always defined in terms of the
other.

Interval results are always rounded to the nearest whole day (round-half-up)
and floored at `1` — a `dueAt` of "today" is never produced by this function;
the earliest a question can be shown again is tomorrow.

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
§2). The shipped scheduler states these as two short lists rather than a
single crossing diagram, and this document now mirrors that rather than the
more elaborate (and, on the correct-outcome side, wrong) diagram an earlier
draft drew:

```
On any correct outcome (objective or self-marked, identically):
  new      -> learning
  learning -> review
  lapsed   -> learning   (rebuilding after a regression)
  review   -> mastered   (only once distinctCorrectDays >= 3), else stays review
  mastered -> mastered

On an incorrect outcome:
  review, mastered      -> lapsed     (an actual regression; `lapses` increments)
  new, learning, lapsed -> learning   (a miss on a question not yet verified,
                                        not a regression; `lapses` unchanged)
```

**The load-bearing rule, stated once, referenced everywhere below, and the
single biggest correction this document makes relative to an earlier
draft:** `correctStreak` is incremented **unconditionally by any correct
outcome** — an objective `correct` and a self-marked `correct_self` credit
it identically. There is no gate anywhere in the shipped scheduler that
blocks `correct_self` from advancing this counter, and — because every
state-*crossing* transition above is driven by the row's **current `state`
alone**, never by `correctStreak`'s value or by which outcome variant
produced it — there is no gate that blocks `correct_self` from crossing a
state boundary either:

- **`learning` → `review` fires on the very next correct answer**, full
  stop — objective or self-marked, and regardless of `correctStreak`'s
  numeric value. A row that has never had more than one correct answer in
  its life still graduates the moment that one answer lands while the row is
  sitting in `learning`. There is no two-consecutive-corrects gate anywhere
  in the shipped code; `correctStreak` is tracked and reported, but nothing
  in this transition reads it.
- **`lapsed` → `learning` fires on the very next correct answer after the
  lapse** — the identical rule; self-mark rebuilds a lapsed row exactly as an
  objective correct would.
- **`review` → `mastered` is the one transition this design gates on more
  than the row's current state alone** — it additionally requires
  `distinctCorrectDays >= MASTERY_PROMOTION_THRESHOLD` (3), and a
  self-marked correct advances that counter on the same footing as an
  objective one (§3.5). This is the *only* place self-mark's weaker evidence
  is allowed to matter for *whether* a transition happens; everywhere else,
  the discount is expressed purely through smaller numbers, never through a
  blocked transition (§3.7 restates why this used to be described
  differently, and is not).

**Self-mark's discount is never expressed by holding a transition back.** It
is expressed entirely through two smaller numbers, applied identically no
matter which state the row is in:

- **Ease**: an objective `correct` adds `EASE_BUMP_CORRECT` (`0.1`); a
  `correct_self` adds `EASE_BUMP_SELF_MARKED` (`0.05`, exactly half),
  clamped to `[MIN_EASE, MAX_EASE]`.
- **Interval**: both variants compute the *same* base interval from
  `correctStreak`, the prior `ease`, and the prior `intervalDays` (§3.1's
  progression); `correct_self` then multiplies that base by
  `SELF_MARKED_INTERVAL_DISCOUNT` (`0.5`), floored at `1` day. An objective
  `correct` uses the base unchanged.

**A miss (`incorrect`) from `review` or `mastered` is a lapse; a miss from
`new`, `learning`, or `lapsed` is not.** Only the first increments `lapses` —
a question that was never verified in the first place cannot fall *out of*
verified status. In both cases the row's `correctStreak` resets to `0`, its
`ease` drops by `EASE_PENALTY_INCORRECT` (`0.2`, still clamped to
`MIN_EASE`), and its interval collapses to `LAPSE_INTERVAL_DAYS` (`1` day) —
but the two cases land in **different states**: a miss from `review` or
`mastered` moves the row to `lapsed`; a miss from `new`, `learning`, **or
`lapsed` itself** moves the row to `learning`. That last case corrects an
earlier draft's claim that a repeated miss while already `lapsed` leaves the
row sitting at `lapsed` — the shipped scheduler routes it to `learning`
instead, the same destination as any other non-regression miss (§3.8's Row
10). `distinctCorrectDays` is left completely unchanged by any miss, of
either kind — never reset, never decremented (§3.5, §3.6).

### 3.5 `distinctCorrectDays`: the axis self-mark is never discounted on

`distinctCorrectDays` increments by **at most one per calendar day**, on
outcome `correct` **or** `correct_self` — never `partial`, which is real but
substantively incomplete evidence, not a correct answer. **It is left
completely unchanged by an incorrect outcome** — a lapse does not reset it to
`0`, or to any smaller value; it simply holds at whatever it already was
(§3.6 explains why, and corrects an earlier draft of this design that
claimed a full reset).

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

### 3.6 Why a lapse leaves `distinctCorrectDays` untouched

An earlier draft of this design specified a **full reset to `0`** on every
lapse, reasoning (from `VISION.md`'s "revisit what is becoming stale") that
a lapse makes a question's prior evidence stale enough that re-earning
`mastered` should require the same fresh, multi-day evidence the first
promotion required, and that a softer partial reset would let one fresh
correct answer re-approach `mastered` without genuinely fresh confirmation.

The shipped scheduler does **neither** a full reset nor a partial one:
`distinctCorrectDays` is copied forward unchanged on the `incorrect` branch
of `nextSchedule` (`distinctCorrectDays: mastery.distinctCorrectDays`) — it
is never decremented anywhere in the function.

Concretely, this means a question that lapses after three distinct correct
days does **not** have to rebuild those three days from scratch to be
re-promoted: a lapsed row returns to `mastered` the moment `review` is
reached again (§3.4's `lapsed → learning → review` path) **and**
`distinctCorrectDays` is still at or above `MASTERY_PROMOTION_THRESHOLD` —
which, since the count never went down, it already is.
`MasteryRecord` stores a single running counter with no per-day history
behind it (the same structural limitation §3.5's `lastOutcome`/
`lastAttemptAt` lookback already lives with), and there is no code path
anywhere in `nextSchedule` that subtracts from it. This document no longer
claims otherwise: the correct statement is that `distinctCorrectDays` only
ever grows, or holds flat on a same-day repeat — it is monotonic for the
life of the row, lapses included.

### 3.7 Self-mark's one real gate: `review` → `mastered`

An earlier draft of this design asserted an asymmetry — that self-mark could
*complete* a mastery claim (advance `distinctCorrectDays` toward the
`review` → `mastered` promotion) but could never *start* one, because
`correctStreak` supposedly never moved for a self-marked outcome. That
premise does not hold: `correctStreak` moves identically for both variants
(§3.4), so `correct_self` alone — with **no independently confirmed correct
answer anywhere in the row's history** — can carry a question from `new`
through `learning` and into `review` exactly as fast as an unbroken run of
objective corrects would (§3.8's Rows 3–4 work this case end to end).

The one place self-mark's weaker evidence genuinely does matter for
*whether* a transition fires, not just for its size, is the `review` →
`mastered` promotion's `distinctCorrectDays >= MASTERY_PROMOTION_THRESHOLD`
gate — and even there, a `correct_self` counts toward that threshold on the
same footing as an objective `correct` (§3.5); it is not blocked from
completing the promotion either. So there is, in the shipped design, no
state transition anywhere that self-mark is excluded from. What self-mark
genuinely never does is earn the *full-strength* ease bump or interval
growth an objective correct earns (§3.4) — that is the entirety of "the
discount," and it is a discount on magnitude, not on which transitions are
reachable. Epic #54's own decision 2, "discounted, not ignored," is
satisfied by that discount alone; this document no longer claims a second,
gate-based discount that the shipped scheduler does not implement.

### 3.8 Worked transitions

Every row below is a complete, self-contained input/output pair a unit test
should be able to assert directly. "Day N" is a relative calendar day in the
learner's own timezone, not a literal date.

| # | Scenario | Prior state | Prior fields (`interval`/`ease`/`streak`/`lapses`/`total`/`distinctDays`) | `outcome` | credited today? | New state | New fields | `dueAt` | Why |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Brand-new question, first-ever attempt, exact match | *(no row)* | `0`/`2.5`/`0`/`0`/`0`/`0` | `correct` | no | `learning` | `1`/`2.6`/`1`/`0`/`1`/`1` | Day 2 | First schedulable outcome creates the row and immediately advances it past the implicit `new` state — §2's "no row ever persists `state: 'new'`" claim, in practice. |
| 2 | Same question, Day 2, second consecutive objective correct | `learning` | `1`/`2.6`/`1`/`0`/`1`/`1` | `correct` | no | `review` | `3`/`2.7`/`2`/`0`/`2`/`2` | Day 5 | `learning` → `review` fires on the very next correct answer regardless of `correctStreak`'s value (§3.4) — reaching `correctStreak: 2` here is incidental, not a gate. Interval uses the scheduler's second-repetition step (`SECOND_REPETITION_INTERVAL_DAYS`, `3`), not a flat graduation constant — there isn't one in the shipped scheduler. |
| 3 | A **different** brand-new question, first-ever attempt is **self-marked** correct | *(no row)* | `0`/`2.5`/`0`/`0`/`0`/`0` | `correct_self` | no | `learning` | `1`/`2.55`/`1`/`0`/`1`/`1` | Day 2 | Self-mark starts a row exactly like an objective correct does — the `new → learning` transition reads no outcome variant (§3.4). The only difference from Row 1 is the smaller ease bump (`EASE_BUMP_SELF_MARKED`, `0.05`, vs. `0.1`); the interval is identical (`LAPSE_INTERVAL_DAYS`, both variants) because the discount only bites once the base interval is above the 1-day floor. |
| 4 | Row 3's question, Day 2, second consecutive **self-marked** correct | `learning` | `1`/`2.55`/`1`/`0`/`1`/`1` | `correct_self` | no | `review` | `2`/`2.6`/`2`/`0`/`2`/`2` | Day 4 | Self-mark alone — with **no objectively-graded correct answer anywhere in this row's history** — crosses `learning` → `review`, contradicting an earlier draft of this design that claimed self-mark could never start or complete this transition (§3.7). The discount is visible only in the smaller numbers: interval `2` days here vs. Row 2's `3` days for the objective equivalent (`round(3 × 0.5) = 2`), and ease `+0.05` vs. `+0.10`. |
| 5 | A third brand-new question, first-ever attempt is a **miss** | *(no row)* | `0`/`2.5`/`0`/`0`/`0`/`0` | `incorrect` | — | `learning` | `1`/`2.3`/`0`/`0`/`1`/`0` | Day 2 | Never entered `review`/`mastered`, so this is not a lapse (`lapses` stays `0`) — just the ordinary start of learning, one miss in. |
| 6 | Row 2's question, on its due date (Day 5), third distinct day, objective correct | `review` | `3`/`2.7`/`2`/`0`/`2`/`2` | `correct` | no | **`mastered`** | `8`/`2.8`/`3`/`0`/`3`/`3` | Day 13 | `distinctCorrectDays` reaches `MASTERY_PROMOTION_THRESHOLD` (3) while `state: 'review'` — promotion, exactly as an earlier draft described. What changes here is only the interval math: the third-and-later repetition uses `round(previousIntervalDays × ease) = round(3 × 2.7) = 8`, not a flat graduation constant. |
| 7 | Row 6's question, much later, a miss while `mastered` | `mastered` | `8`/`2.8`/`3`/`0`/`3`/`3` | `incorrect` | — | `lapsed` | `1`/`2.6`/`0`/`1`/`4`/**`3`** | +1 day | A real lapse: `lapses` increments, interval collapses to `LAPSE_INTERVAL_DAYS`. **`distinctCorrectDays` is left at `3`, not reset to `0`** — an earlier draft of this design claimed a reset here; the shipped scheduler copies the field forward unchanged on every `incorrect` outcome (§3.6). |
| 8 | Row 7's question, next day, **self-marked** correct | `lapsed` | `1`/`2.6`/`0`/`1`/`4`/`3` | `correct_self` | no | `learning` | `1`/`2.65`/`1`/`1`/`5`/**`4`** | +1 day | Self-mark rebuilds a lapsed row exactly like an objective correct would (§3.4) — `lapsed → learning`, not the unchanged `lapsed` an earlier draft claimed. `distinctCorrectDays` continues from its **persisted** value, `3 → 4`, rather than rebuilding from `0` — Rows 7–8 are the same correction, viewed from either side of the lapse. |
| 9 | An established `review` question receives an **AI partial verdict** | `review` | `10`/`2.5`/`4`/`0`/`6`/`2` | `partial` | no | `review` (**unchanged**) | `13`/`2.5`/`4`/`0`/`7`/`2` | +13 days | `intervalDays = round(10 × 2.5 × 0.5) = 13` — real but half-strength growth (an objective correct here would have produced `round(10 × 2.5 × 1.0) = 25`). `distinctCorrectDays` does **not** credit — `partial` is not a correct answer. |
| 10 | A **repeated** miss while already `lapsed` | `lapsed` | `1`/`1.35`/`0`/`2`/`9`/`0` | `incorrect` | — | **`learning`** | `1`/`1.3`/`0`/`2`/`10`/`0` | +1 day | `lapses` stays `2` — only a miss **from** `review`/`mastered` increments it, and a miss while already `lapsed` is not a further regression. Corrected here from an earlier draft: the state moves to `learning`, not staying at `lapsed` — every non-regression miss (from `new`, `learning`, or `lapsed`) lands at the same `learning` destination (§3.4). `ease` floors at `MIN_EASE` (`1.3`), not the uncapped `1.15`. |

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
  `correct` (§3.8's Row 1) or `incorrect` (§3.8's Row 5). Because `stage` only ever moves
  forward and this check reads the profile's *current* stage inside the same
  transaction, "the first time this fires" and "every time this fires while
  still `oriented`" are the same event — there is no separate "is this
  really the first row" query to write; the guard is the stage comparison
  itself.
- **`learning → remembering`**: fires when `currentStage === 'learning'` and
  `priorMasteryState !== 'mastered' && nextMasteryState === 'mastered'` — a
  question was just verified as mastered for the first time. Both facts are
  already sitting in `nextSchedule`'s own return value from the same
  transaction (§3.8's Row 6 is exactly this event); no separate count of
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
| **Withholding distinct-day credit entirely from self-marked answers** | Would make the discount indistinguishable from disqualification on the one axis — verified mastery — the epic's decision 2 ("discounted, not ignored") most directly protects. The chosen design discounts self-mark through smaller ease and interval growth instead (§3.4), never through a blocked transition, so "weaker evidence" and "no evidence" stay genuinely different outcomes. |
| **Deriving `alreadyCreditedToday` from `question_mastery`'s own `lastAttemptAt`/`lastOutcome`** | Breaks on the ordinary same-day incorrect-then-self-marked sequence self-mark itself produces (§3.5) — a summary row that remembers only the single most recent attempt cannot answer "was *any* attempt today already credited." The caller queries `practice_attempts` directly instead, over an index that already exists. |
| **Resetting `distinctCorrectDays` on a lapse — fully to zero, or partially (e.g., halving)** | An earlier draft of this design chose a full reset to `0`, reasoning that re-earning `mastered` should require fresh multi-day evidence each time, and that a partial reset would concede too much of that standard. The shipped scheduler does neither: `distinctCorrectDays` is copied forward unchanged on every `incorrect` outcome (§3.6). This row is kept to record that both a full and a partial reset were considered and are **not** what shipped. |
| **Blocking `correct_self` from advancing `correctStreak` (and thus from state transitions)** | This is the position an earlier draft of this design took, deliberately — it argued this would prevent a learner from self-marking through the entire ladder with no independently-confirmed answer. **It is not what shipped.** The real scheduler treats `correct_self` and an objective `correct` identically for `correctStreak` and every state transition (§3.4, §3.7); a row genuinely can reach `mastered` on self-marks alone. Recorded here, inverted, because the risk this earlier position named is real and worth a deliberate decision — accept it, or file a follow-up issue against `scheduler.ts` — rather than silently dropped. |

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
