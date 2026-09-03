# Design Spec: Habit, Streaks and Reminders (issue #103, epic #56 / E7 "Habit")

This is the durable design for E7: the epic that gives this product the axis
`VISION.md` calls **Motivation and Engagement** and draws a hard line around
in the same breath — daily goals, streaks with real protection, session-end
celebrations, and a coach that reminds a learner at their own local hour —
while remaining, by construction, unable to move the one number E6
(`docs/specs/readiness-model.md`) already promised never moves for this
reason. E1 (`journey-shell.md`) shipped `learner_profiles.timezone`,
`daily_goal_minutes`, and `Clock`, and shipped Home's goal ring as an honest
placeholder rather than a fabricated zero. E3 (`docs/specs/practice-sessions.md`)
shipped the evidence an attempt or a completed session already is. E5
(`docs/specs/memory-model.md`) shipped the deterministic recommender whose
copy this epic's reminders borrow rather than re-derive. E6
(`docs/specs/readiness-model.md`) shipped the readiness engine and, in the
same document, the one sentence this epic is built to never contradict. This
document is what turns all four into `daily_activity`, a streak a learner can
trust, a freeze budget that protects real effort without becoming unlimited,
three reminder events with final copy, and the one settings namespace that
lets a learner say when and whether they hear from any of it.

Source of truth for every claim below:

- [Epic #56](https://github.com/marinoscar/oathpath/issues/56) itself — the
  `daily_activity` column list, `streak_freezes` on the learner profile, the
  three notification event keys, the `study` namespace, the hourly-not-daily
  cron, and the six "decisions locked" this document is required to keep,
  quoted at the point each is spent rather than restated in this document's
  own words:

  > **DB.** `daily_activity` — user, `activity_date @db.Date`, `tz_used`,
  > `practice_seconds`, `attempts`, `correct`, `goal_met`;
  > `@@unique([user_id, activity_date])`. Plus `streak_freezes` on the
  > learner profile.
  >
  > Every other timestamp in this schema is `Timestamptz`; a **local day** is
  > a different thing and must be explicit. The date is computed in the
  > learner's `timezone` and the zone used is stored alongside it, so a
  > learner who moves does not silently lose or gain a day.

  and, on why hourly:

  > The reminder cron runs **hourly**, not daily, selecting learners whose
  > local reminder hour has just arrived — a single daily cron cannot deliver
  > "9am your time" across time zones.

- [Issue #103](https://github.com/marinoscar/oathpath/issues/103) itself —
  the acceptance criteria this document is checked against, and the reason
  it exists at all, stated in its own words: "Seven siblings then build
  against those rules in parallel... With nothing written down each one
  re-derives them and they disagree. Notification copy in particular is
  where getting it wrong is cheapest to do and most expensive to ship."
- `PRD.md`'s "Engagement and the Journey" section — the two questions this
  epic and E6 each answer, quoted verbatim because the exact wording is what
  a later reader should hold both documents to:

  > **Engagement:** *Am I consistently doing the work?*
  >
  > **Readiness:** *Does the evidence indicate that I am becoming prepared?*
  >
  > Points, streaks, achievements, and challenges encourage the journey. They
  > must never artificially increase the user's Readiness Score.

- `VISION.md`'s "Motivation and Engagement" and "Notifications Should Feel
  Intelligent" sections — "A streak shows consistency. Points show activity.
  Achievements mark milestones. **None of these make someone ready**,"
  the useful/not-useful notification pair §5 quotes verbatim rather than
  paraphrasing, and the "What We Will Not Build" list's own line — "a
  leaderboard-driven competition between applicants" — §9 cites by name.
- `docs/specs/readiness-model.md` §2.4 — the readiness side's own statement
  of this exact boundary, quoted here in full because §1 states the rule as
  binding on *this* document and a later reader should see both documents
  agree word for word rather than trust a summary:

  > **Engagement never moves readiness.** `PRD.md` requires the separation
  > explicitly. E7's `daily_activity`, streaks, and points are kept
  > structurally out of E6's readiness engine's inputs — not filtered out at
  > read time, but never wired in as an input in the first place. A long
  > streak and a high readiness score answer two different questions, and
  > the product must never let one stand in for the other.

- `ROADMAP.md` §7 ("Cross-cutting rules") — "No job queue... Reminders (E7)
  and the nightly readiness pass (E6) run on `@nestjs/schedule` cron,
  following the `token-cleanup.task.ts` pattern" (§6 below), "Local days are
  explicit... A learner who travels or changes their timezone setting must
  not silently lose or gain a day of streak credit. The reminder cron (E7)
  runs **hourly**, not daily" (§3, §6), and "no background job may call AI on
  a user's key... the nightly readiness recompute (E6) and the hourly
  reminder cron (E7) are both deterministic" (§6 — this cron never calls
  `AiDispatchService`, for the identical structural reason `readiness-model.md`
  §7 gives its own nightly pass).
- `ROADMAP.md` §8 (post-MVP backlog) — quoted verbatim rather than
  paraphrased in §9: "Points, achievements, and weekly challenges... E7 ships
  goals, streaks, and celebrations only. **Leaderboards are not deferred —
  they are on `VISION.md`'s 'will not build' list** and will not appear in a
  future epic either."
- `docs/specs/practice-sessions.md` §2.2 — `practice_attempts`' exact,
  already-shipped columns this epic reads (`outcome`, `answeredAt`) and never
  writes, and the "one evidence table" rule this epic's own `daily_activity`
  table does not compete with: `daily_activity` is a derived rollup **of**
  that evidence, not a second ledger of it.
- `docs/specs/memory-model.md` — `apps/api/src/practice/mastery/selector.ts`'s
  `WEAK_LAPSES_THRESHOLD`, reused here (§9) as the worked example of "import a
  constant, never redeclare it," and the pure-module idiom (`nextSchedule`, no
  Nest, no Prisma) this document's own `computeStreak` and
  `settleStreakFreezes` (§4) follow to the letter.
- `docs/specs/journey-shell.md` §10 and
  `apps/api/src/journey/dto/journey-home.dto.ts` — the honesty rule this
  epic is the one that satisfies: `dailyGoal.tracked` is hardcoded `false`
  with no `minutesToday` field for the whole of E1–E6, and that file's own
  comment states, verbatim, "When E7 lands session tracking it adds the
  measured field alongside and flips `tracked`." §2 and §8 below are what
  makes that comment true.
- `apps/api/src/common/clock/clock.ts` — `Clock.now()` and
  `Clock.calendarDateIn(timeZone)`, the only two methods this epic's local-day
  derivation (§3) is built on, cited here rather than re-derived: "at
  2026-01-15T23:30:00-08:00 the answer in `America/Los_Angeles` is measured
  from January 15, while the same instant is already January 16 in UTC."
- `apps/api/src/notifications/notification-events.ts` — `NotificationEventDef`'s
  exact shape (`key`, `label`, `description`, `channels`, `defaultEnabled`,
  `mandatory?`), and its own invariant this document's §5 depends on: "a
  mandatory event must also be `defaultEnabled: true`" — moot here, because
  none of the three events this epic adds sets `mandatory` at all.
- `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` and
  `apps/api/src/settings/user-settings/user-settings.service.ts` — the sparse,
  never-`.default()` contract §7 extends to the `study` namespace, and that
  service's own comment naming the exact cost of missing a file: "adding
  `dataTables` / `navigation` a **six-file** change: a namespace missing from
  `userSettingsSchema` is accepted by the controller, dropped here, and never
  seen again by a subsequent GET — with no error anywhere."
- `apps/api/src/email/templates/role-changed.email.ts` — the shipped
  `{ subject, html, text }` template shape §5's three templates follow, its
  `html` tagged-literal escaping discipline, and CLAUDE.md's "Adding a
  Notification" three-step pattern (registry entry, template, `notify()` at
  the real trigger) this epic's own three events follow without a fourth
  step invented.
- `apps/api/src/auth/tasks/token-cleanup.task.ts` — the exact
  `@Injectable()` + `@Cron(CronExpression...)` shape §6's hourly task copies,
  with no separate "tasks module" anywhere in this application.
- `apps/api/src/practice/practice.service.ts` — `recordAttempt`'s and
  `completeSession`'s real, shipped call sites (§2), including the exact
  comment recording *why* mastery scheduling runs inside `recordAttempt`'s own
  `$transaction` while readiness recompute runs synchronously *after*
  `completeSession`'s write commits — the identical choice §2's accrual call
  sites make, for reasons stated at each site rather than assumed to transfer.
- `apps/api/src/journey/journey.service.ts` — `hasPractisedToday`'s existing
  query shape (already reading `practice_attempts` by local day for a
  different purpose, the Study Coach's branch 4/5 split) — cited in §3 as
  the established precedent for "a local day, from a UTC-stamped ledger
  table," reused rather than reinvented for `daily_activity`.
- `apps/api/prisma/schema.prisma` — `LearnerProfile.streakFreezes Int
  @default(2)` and `LearnerProfile.streakFreezesGrantedAt DateTime?
  @db.Timestamptz`, already present in this working tree exactly as the
  epic body specifies (§4), plus `User.dailyActivity DailyActivity[]
  @relation("UserDailyActivity")` — a relation to a model this migration has
  not yet added, marked in §2 as **added by this epic**, not yet merged.

---

## 1. Scope, and the separation rule stated as a hard rule

**`daily_activity` is NOT an input to the readiness engine
(`apps/api/src/readiness/readiness-engine.ts`), and it never will be.** This
is not a filtering rule applied at read time — `computeReadiness`'s
`ReadinessEvidence` interface (`readiness-model.md` §5) has no field a
`daily_activity` row, a streak count, or a freeze balance could even be
assigned to. Wiring one in later would be a new field on that interface, a
new component in the eight-row weight table, and a new entry in this
document's own out-of-scope list below — none of which exists, and none of
which this epic proposes.

The reason is not "these are unrelated tables." It is that engagement and
readiness answer two genuinely different questions, and conflating them is
the specific failure `PRD.md` names by making the two questions bold and
placing them side by side:

> **Engagement:** *Am I consistently doing the work?*
>
> **Readiness:** *Does the evidence indicate that I am becoming prepared?*

A learner can hold a 40-day streak built entirely on five-minute sessions
that never touch a weak question, and a learner can have a 3-day streak that
happens to include a passed mock interview — readiness (E6) reads the second
learner as more prepared, correctly, and nothing in this table or this
document is entitled to disagree with that by feeding a number the other
direction. Streaks, freezes, and the goal ring exist to keep a learner
returning; they carry no claim about what returning proved.

**None of the three notification events this epic adds (§5) is
`mandatory`.** `practice.daily_reminder`, `practice.review_due`, and
`streak.at_risk` are all ordinary, switchable preferences — the same
`defaultEnabled`-but-not-`mandatory` posture `user.welcome` and
`allowlist.invitation` already take in `NOTIFICATION_EVENTS`
(`notification-events.ts`), never the `security.role_changed` posture. A
learner is always free to hear nothing from this epic at all and lose
nothing but the reminder itself — never access, never evidence, never a
readiness point.

---

## 2. What accrues a day — `daily_activity`

```prisma
// ADDED BY THIS EPIC — not yet in apps/api/prisma/schema.prisma. The
// `User.dailyActivity` relation already added to this working tree's
// schema.prisma (uncommitted) points at exactly this model and this
// relation name; this model is what makes that reference resolve.
model DailyActivity {
  id String @id @default(uuid()) @db.Uuid

  userId String @map("user_id") @db.Uuid

  // A LOCAL calendar day, not a moment — see §3. `@db.Date`, deliberately
  // not `@db.Timestamptz`, the identical posture `LearnerProfile.interviewDate`
  // already takes for the same reason: shifting `timezone` later must never
  // silently move which day this row is.
  activityDate DateTime @map("activity_date") @db.Date

  // The IANA zone the boundary above was actually computed in. Non-null,
  // stored, never re-derived at read time. See §3.
  tzUsed String @map("tz_used")

  practiceSeconds Int @default(0) @map("practice_seconds")
  attempts        Int @default(0)
  correct         Int @default(0)

  // MONOTONIC — see §2.3. Never written `false` once it is `true`.
  goalMet Boolean @default(false) @map("goal_met")

  // True only for a row settlement (§4.4) wrote to protect an existing
  // streak across a day the learner did not actually practise. A settled
  // row always has attempts: 0, correct: 0, practiceSeconds: 0, goalMet:
  // false — it is not a fabricated practice day, it is a recorded freeze.
  freezeUsed Boolean @default(false) @map("freeze_used")

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  user User @relation("UserDailyActivity", fields: [userId], references: [id], onDelete: Cascade)

  // The whole accrual and settlement design (§2.4, §4.4) leans on this
  // being a real DB constraint, not an application-level check: two
  // concurrent accrual calls for the same learner's same local day must
  // collapse into one row, not two.
  @@unique([userId, activityDate])
  @@index([userId, activityDate])
  @@map("daily_activity")
}
```

`onDelete: Cascade` on `userId` is the same posture every other per-learner
table in this schema already takes (`PracticeAttempt.userId`,
`ReadinessSnapshot.userId`) — a day of activity has no meaning independent of
the account it happened on.

### 2.1 The two accrual events

Accrual runs on exactly two events, both inside the practice module, both
already-shipped call sites this epic adds one call to rather than a new
trigger of its own:

**(a) `POST /api/practice/sessions/{id}/attempts`** —
`PracticeService.recordAttempt` (`apps/api/src/practice/practice.service.ts`)
— once per graded attempt, including a `skipped` one. A skip is "not evidence
of recall in either direction" for `question_mastery` scheduling
(`practice-sessions.md` §9.1), but it is still five-or-so seconds of a
learner's real time and a real interaction with the product; excluding it
from `attempts`/`practice_seconds` would undercount genuine engagement for
the identical reason `memory-model.md` §3.2 already gives for scheduling a
skip as `incorrect` rather than ignoring it.

**(b) `POST /api/practice/sessions/{id}/complete`** —
`PracticeService.completeSession`, same file — once per session completion.

Both call the accrual service **after their own write has committed** — the
identical placement `readiness-model.md` §7(a) locks for its own recompute
trigger inside `completeSession`, and for the same reason: accrual is not
part of what makes the attempt or the completion valid, so it must not be
able to roll either one back. Unlike readiness recompute, which
`completeSession` currently awaits with no guard around it, **the accrual
call is wrapped so a failure is logged, never thrown** — stated in §2.4.

### 2.2 What each event increments

**On a recorded attempt:**

| Column | Change |
|---|---|
| `attempts` | `+1` |
| `correct` | `+1` when `practice_attempts.outcome === 'correct'` (the ledger row's own outcome column — `practice-sessions.md` §2.2's `PracticeOutcome` union — never the narrower `AttemptOutcome` mastery-scheduling union `memory-model.md` §3 defines; `correct_self_marked` is a scheduling-only distinction that does not exist on this column) |
| `practiceSeconds` | `+= slice` — §2.3 |
| `goalMet` | monotonic OR against the goal — §2.3 |

**On session completion:** the same `practiceSeconds`/`goalMet` update,
computed by the identical formula (§2.3) with `now` = the completion
timestamp — closing the one gap no attempt event ever closes: the seconds
between the last attempt (or, for a session completed with zero attempts,
the session's own `startedAt`) and the moment the learner actually finishes.
**`attempts` and `correct` are untouched by the completion call** — nothing
was answered at completion itself, and crediting it there would double-count
against whichever attempt event already ran.

**This split — a shared time-accrual formula, but session-completion never
touching `attempts`/`correct` — is this document's own reading of the epic
body's two named trigger events, flagged as a judgment call rather than
quoted text**, exactly the way `study-coach.ts`'s own header flags its
"reviewCount is the sum, used for both the gate and the copy" decision
rather than presenting it as unambiguous. The epic body names both events
without spelling out the division of labor between them; the reading above
is the one that keeps every second of measured practice attributed to
exactly one accrual call, never zero and never two.

### 2.3 `practice_seconds`, the cap, and monotonic `goal_met`

**`practice_seconds` is derived server-side from timestamps — never from a
client-supplied duration.** A client-supplied number of seconds spent
practicing is a user-writable engagement metric: nothing stops a client from
reporting 3,600 seconds for a 30-second session, and unlike `responseText`
(graded, and therefore self-limiting — a fabricated answer still has to be
right to help), a duration has no downstream check that would catch a lie.
`durationMs` already exists on `practice_attempts` as **per-question UI
telemetry** (`practice-sessions.md`'s own DTO), and it is exactly this
untrusted a value — this epic does not read it for `practice_seconds`, on
purpose.

The formula, identical at every accrual call site (§2.2):

```
slice = min(now - max(session.startedAt, previousEventTimestamp), ATTEMPT_SECONDS_CAP)

export const ATTEMPT_SECONDS_CAP = 120; // seconds
```

where `previousEventTimestamp` is the prior attempt's `answeredAt` if one
exists in this session, else `session.startedAt`, and `now` is `Clock.now()`
at the current event (the just-graded attempt's `answeredAt`, or the
completion timestamp). **The cap exists because a learner who leaves a tab
open overnight did not practise for nine hours.** Without it, a single
forgotten tab would inflate `practice_seconds` by a number large enough to
flip `goal_met` for days no real practice happened on, and would make
`consistency`-adjacent product surfaces (this document's own streak
included) trivially gameable by doing nothing. 120 seconds is generous
against a real five-question exchange — a learner reading a question,
typing an answer, and seeing feedback comfortably fits inside two minutes —
while bounding the damage of any single unmeasured gap to a number too small
to fabricate a day.

**`goal_met` flips `true` the first time `practiceSeconds >=
learner_profiles.daily_goal_minutes * 60`, and is MONOTONIC: it never flips
back to `false`, including when a learner later raises their daily goal.**
Concretely, the write is `goalMet: existing.goalMet || (newPracticeSeconds
>= dailyGoalMinutes * 60)` — an OR against the row's own prior value, never
a bare reassignment. A day that was earned stays earned: a learner who met a
5-minute goal at 8am and then raises their goal to 15 minutes at noon (a
change to `learner_profiles.dailyGoalMinutes`, not to this row) did not
retroactively fail that morning's session — the goal they cleared was the
goal that existed when they cleared it, and rewriting history under today's
target is the exact "functionally a lie" shape `journey-shell.md` §10 rules
out for a different field on the same Home surface this flag ultimately
feeds (§8).

### 2.4 The write is an upsert, and never fails the triggering action

The write at both accrual call sites is a Postgres `UPSERT` keyed on
`@@unique([userId, activityDate])` — `INSERT ... ON CONFLICT (user_id,
activity_date) DO UPDATE`, incrementing `attempts`/`correct`/`practiceSeconds`
and applying the `goalMet` OR in the same statement (or an equivalent
read-then-write inside a short transaction, since a session accepts only one
attempt at a time — `recordAttempt`'s own "one attempt per question per
session" check already serializes this per learner). Two attempts on the
same local day therefore never produce two rows; the second accrual call for
a day simply increments the first row it already wrote.

**Accrual never fails the action that triggered it** — the same rule
`CLAUDE.md`'s "Adding a Notification" section states for `notify()`: a send
failure "becomes a `notification_deliveries` row, never an exception." Here
there is no delivery row to fall back to, so the rule is enforced directly:
the accrual call is wrapped in a `try`/`catch` at its call site in
`recordAttempt`/`completeSession`, and a failure is logged (`this.logger.error`,
with the userId and sessionId) and swallowed, never rethrown. An attempt
that was graded correctly, or a session that genuinely completed, must never
become a 500 because a rollup table had a transient write failure — the
attempt and the session are the evidence; the day's tally is a derived
convenience on top of it, and a missed increment is recoverable (the next
accrual call for the same day still lands, since the upsert simply adds to
whatever `practiceSeconds` the row already holds) in a way a lost attempt
never would be.

---

## 3. Local days

**A "local day" is not the same kind of value as every other timestamp in
this schema, and this table says so by construction.** Every other new
timestamp column added by E1–E6 is `@db.Timestamptz` — an instant. `activity_date`
is `@db.Date` — a calendar date with no time component, computed once, in the
learner's own `timezone`, through `Clock.calendarDateIn(timeZone)` (#63) —
the identical method `JourneyService`'s existing `hasPractisedToday` query
already calls for a different purpose (the Study Coach's branch 4/5 split,
`journey.service.ts`), reused here rather than reinvented for a second local-day
derivation.

`Clock.calendarDateIn`'s own doc comment states precisely why this cannot be
computed from a bare `Date` and a UTC offset math trick: "at
2026-01-15T23:30:00-08:00 the answer in `America/Los_Angeles` is measured
from January 15, while the same instant is already January 16 in UTC." A
learner in Los Angeles who opens the app at 11:30pm local time is, in UTC,
already the following calendar day — crediting that session to the UTC date
would silently move it to a day the learner never experienced as "today."

### 3.1 `tz_used` is stored, not derived at read time

`tz_used` records the exact IANA zone `calendarDateIn` was called with **at
the moment this row was written**, and it is non-null on every row from the
first migration forward — there is no "unknown zone" state to design around,
because `LearnerProfile.timezone` itself defaults to `'UTC'`, never null
(schema.prisma's own comment: "the honest 'nobody has told us yet' value
that orientation replaces"). Storing it, rather than reading
`learner_profiles.timezone` fresh every time a row is displayed or a streak
is computed, is what keeps a later timezone change from silently rewriting
already-written history.

**Worked example.** A learner practises through late September in
`America/Los_Angeles`. On October 3rd they relocate and update their profile
to `Europe/Madrid` — a nine-hour jump forward. Every `daily_activity` row
written before October 3rd keeps `tzUsed: 'America/Los_Angeles'` and its
`activityDate` exactly as it was computed on the day it was written; none of
those rows is rewritten, re-dated, or re-interpreted under the new zone. The
first practice session after the move computes `activityDate` through
`calendarDateIn('Europe/Madrid')` and writes `tzUsed: 'Europe/Madrid'`. The
streak (§4) walks the sequence of `activityDate` values exactly as stored —
it has no notion of "this row's zone changed" and needs none, because a
calendar date, once written, is already the right unit to compare against
its neighbors regardless of which zone produced it.

### 3.2 What happens to a learner who moves — stated plainly

**Past rows keep their original `tz_used` and are never rewritten.** **New
rows use the new zone.** **A single real instant can be counted under at
most one zone at a time — whichever zone was active when that row was
written — and a same-instant session can therefore land on different
calendar dates depending on when, relative to a timezone change, it was
answered.** This is not a bug to guard against; it is the honest
consequence of a "local day" being a fact about the learner's life at the
moment it happened, not a property of the instant alone. The alternative —
re-deriving every historical `activityDate` under a learner's *current*
timezone on every read — would produce a different streak length depending
on when you asked, for evidence that never itself changed, which is a worse
kind of dishonesty than the one edge case (a nine-hour jump landing a
borderline late-night session on a different date than it would have under
the old zone) this design accepts instead.

---

## 4. Streaks and freezes

### 4.1 `current` and `longest`, defined

**`current`** is the number of consecutive local days, walking backward from
`today`, on which `goalMet` is `true` **or** the day is a freeze day
(`freezeUsed: true`) — **ending today-or-yesterday**, not strictly today.
Concretely: the walk's anchor is `today` if today already has a qualifying
row, else `yesterday` if yesterday has one, else the streak is `0`; from
that anchor, count backward one local day at a time while each day continues
to qualify, stopping at the first day with no row or with a row that
qualifies as neither (`goalMet: false, freezeUsed: false`).

**Ending "today or yesterday" is deliberate, and it is the whole reason the
anchor step exists**: a learner who has not yet opened the app today — it is
2pm, they always practise in the evening — must not see their streak read
`0`. A `0` at 2pm on a day they have every intention of finishing is
functionally a false claim that their streak already broke, and reads as
punishment for something that has not happened yet. Once the day genuinely
ends with no qualifying row and no freeze, it ages out of the "today or
yesterday" window the next morning and the streak reflects that honestly —
the grace is exactly one day long, never longer, and it is a grace about
*when the day is checked*, never a grace about whether the day itself
counted.

**`longest`** is the length of the longest such run anywhere in the
learner's full `daily_activity` history — not only the run touching today.

### 4.2 The pure engine

```ts
// ADDED BY THIS EPIC — apps/api/src/engagement/streaks/streak-engine.ts.
// Pure — no Nest, no Prisma, no Clock, no import statement at all — the
// identical shape nextSchedule (memory-model.md §3) and computeReadiness
// (readiness-model.md §5) already establish for a rule that must produce the
// same output for the same input forever, and must be directly unit-tested
// against a table of cases with no database in the loop.

export interface StreakDay {
  date: string;       // YYYY-MM-DD, this learner's activity_date, local
  goalMet: boolean;
  freezeUsed: boolean;
}

export interface StreakEvidence {
  today: string;              // YYYY-MM-DD, the caller's Clock.calendarDateIn(timezone) result
  days: StreakDay[];           // every daily_activity row this learner has, ANY order
}

export interface StreakResult {
  current: number;
  longest: number;
}

export function computeStreak(evidence: StreakEvidence): StreakResult;
```

`days` is deliberately the learner's **entire** history, not a bounded
recent window — `longest` is defined over all of it, and a bounded window
would silently cap `longest` at the window size the first time a learner's
account is old enough to exceed it. This is safe rather than expensive: the
row count is bounded by the number of distinct calendar days since the
learner's account existed, at most a few thousand for any realistic learner,
and the `@@index([userId, activityDate])` this table ships with makes
fetching it a single ordered range scan. §9 records the alternative —
persisting `longest` on `learner_profiles` instead of deriving it — and why
it lost.

**Algorithm, in prose rather than restated as code** (mirroring how
`memory-model.md` §5's own `selector.ts` bucket ordering is documented —
prose plus a worked example, not a line-by-line trace, for a rule simple
enough that the prose *is* the specification): sort `days` by `date`
ascending; walk once, tracking the length of the current consecutive run
(a day whose date is exactly one calendar day after the previous day in the
run, and that itself qualifies, extends the run; any other day starts a new
run of length 1 if it qualifies, or resets the running length to 0 if it
does not); `longest` is the maximum run length seen anywhere in that single
pass. `current` is computed by the anchor rule in §4.1, walking backward
from `today` (or `today` minus one day) over the same sorted sequence.

### 4.3 Freezes — the budget and its replenishment

```
learner_profiles.streak_freezes Int @default(2)               // already in schema.prisma
learner_profiles.streak_freezes_granted_at Timestamptz? Null   // already in schema.prisma

export const STREAK_FREEZE_MAX = 2;
export const FREEZE_REPLENISH_INTERVAL_DAYS = 7;
```

`streak_freezes` is the number of freezes the learner **holds** right now —
already added to `LearnerProfile` in this working tree, with a `@default(2)`
the column's own comment states is deliberate for a migration over *existing*
rows, not merely new ones: "an existing learner mid-streak the day this
ships starts protected, exactly like a learner who signs up tomorrow" — the
same protection-not-scarcity posture §4.5 states as the product rule.
`streak_freezes_granted_at` is nullable, and null is a real, distinct state
— "never replenished" — the identical honesty convention
`LearnerProfile.testVersionCode` already establishes for "nothing here has
actually happened yet."

**Replenishment**: at most one freeze granted per `FREEZE_REPLENISH_INTERVAL_DAYS`
(7) days, up to `STREAK_FREEZE_MAX` (2), evaluated when the summary is
computed (§4.6) — never on a fixed calendar schedule of its own. Concretely:
if `streakFreezesGrantedAt IS NULL OR today - streakFreezesGrantedAt >= 7
days`, and `streakFreezes < STREAK_FREEZE_MAX`, grant one (`streakFreezes
+= 1`, `streakFreezesGrantedAt = now`); otherwise grant none. A learner who
never lets their balance drop below 2 (never misses an unprotected day) also
never replenishes past 2 — the cap is not "2 plus whatever has accrued
since," it is a hard ceiling.

### 4.4 Consumption is persisted, and why that beats deriving it on every read

**Consuming a freeze writes a real `daily_activity` row** for the missed
day — `freezeUsed: true, attempts: 0, correct: 0, practiceSeconds: 0,
goalMet: false` — rather than being a fact recomputed from "was there a
freeze available" every time the streak is displayed. Three reasons, stated
plainly because a later reader who reaches for "just derive it on read, it's
simpler" should see why that was rejected rather than merely that it was:

1. **The unique key makes a second settle a no-op.** `@@unique([userId,
   activityDate])` means a second settlement pass over the same gap day —
   from a retry, from two near-simultaneous reads — either inserts nothing
   (the row already exists) or is a trivial idempotent update, never a
   double-consumed freeze.
2. **The learner's history is auditable.** A row that says "this day was
   covered" is a durable, inspectable fact — the same evidentiary posture
   every other row in this schema takes toward the past. A derived-on-read
   answer has no artifact a learner, a support engineer, or a later feature
   (a "which days were freeze-protected" list on the celebration or the
   settings page) could ever point at.
3. **The budget can actually decrement.** A freeze that is merely *checked*
   on read and never *spent* is not a budget of 2 — it is unlimited,
   because nothing about "deciding a gap doesn't break the streak" ever
   reduces the number available for the next gap. Persisting the row is
   what makes `STREAK_FREEZE_MAX` a real ceiling rather than a number that
   is computed but never enforced.

**`GET /api/readiness` is the established precedent in this codebase for
exactly this shape — a read path that writes** (`readiness-model.md` §6:
"Lazily computes and persists one if none exists yet, or the latest is
stale"). Settlement here follows the identical posture: a `GET` request
that discovers work needing to be done performs that work and persists its
result, rather than returning a value nothing durable backs.

### 4.5 The product rule, and the bound on how far back settlement reaches

```
export const FREEZE_SETTLE_LOOKBACK_DAYS = 7;
```

**A missed day after weeks of real work must not erase the streak; that is
discouragement, not accountability.** `VISION.md` states the same posture
generally — "We should never create pressure, shame, fear, or unhealthy
compulsion to increase engagement metrics" — and freezes are this epic's
concrete mechanism for it: a single missed day inside an otherwise real
streak is protected automatically, with no action required from the
learner, and **freezes are presented to the learner as protection they
already have, never as a scarcity counter** — the UI states "You have 2
freezes" the way a benefit is stated, never "Only 2 freezes left!" the way a
countdown is.

**A freeze is only consumed to protect an EXISTING streak — never to cover
a gap before the learner's first-ever active day.** Concretely: walking
backward from `yesterday` (settlement never touches `today` — that is
accrual's row, written or not, on its own event-driven schedule, §2), for
up to `FREEZE_SETTLE_LOOKBACK_DAYS` (7) days: a day that already has a
qualifying row (`goalMet` or `freezeUsed`) needs nothing and the walk
continues further back; a day with a row that neither met the goal nor used
a freeze is an already-settled genuine miss and the walk stops there — the
streak ended on that day, honestly; a day with **no row at all** is a gap,
and it is bridged with a freeze **only if** `streakFreezes > 0` **and** the
learner has at least one qualifying `daily_activity` row anywhere before
that gap (i.e., there is a real streak on the far side of it worth
protecting) — otherwise the walk stops without consuming anything, because a
gap before any practice ever happened is not a streak that was interrupted,
it is simply a learner who had not started yet.

**The bound to 7 days is deliberate and separate from the freeze budget
itself**: a learner returning after a month away does not get a month of
retroactive freeze rows — even with an unlimited budget, settlement would
refuse to reach past 7 days back, and their streak has genuinely ended.
Bounding the look-back is what keeps "protection" from quietly becoming
"nothing ever actually breaks a streak" for a learner who simply stops
using freezes as insurance against long absences rather than the single bad
day they are meant for.

### 4.6 `GET /api/engagement/summary`

The one read surface epic #56's own body names. Settlement (replenishment
and freeze consumption, §4.3–§4.5) runs **once, at the top of this
handler**, before the streak is computed and returned — the sole recompute
trigger this epic has, deliberately unlike readiness's two (§7 of
`readiness-model.md`: a synchronous in-request trigger *and* a nightly
cron). Engagement does not need a second, cron-driven trigger the way
readiness does: nothing here decays the moment nobody looks, the way
`consistency`'s rolling 14-day window does, and there is no trend-line
consumer (`GET /api/readiness/history`'s analogue) requiring a fresh row to
exist before anyone asks for it. A streak nobody has looked at today simply
has stale settlement waiting for the next `GET`, which is correct — the
learner has not been shown a wrong number, because they have not been shown
any number.

`@Auth()` with no permissions, no user-id parameter — the same rule every
other per-user route in this codebase already follows: every authenticated
learner owns their own engagement data, exactly as they own their own
learner profile, their own practice attempts, and their own readiness
snapshots, and no route here accepts another user's id, ever.

Response shape (fields only — this document does not fix a DTO's exact key
casing, which is the implementing issue's own concern): the resolved
`current`/`longest` streak (§4.2), `streakFreezes` held, today's
`daily_activity` row if one exists (`practiceSeconds`, `attempts`,
`correct`, `goalMet`), and the learner's own `dailyGoalMinutes` — everything
the goal ring and the streak badge on Home need to stop rendering
`journey-shell.md` §10's placeholder and start rendering the honest,
measured value that placeholder was always waiting for.

---

## 5. The three notification events

All three are declared in `NOTIFICATION_EVENTS`
(`apps/api/src/notifications/notification-events.ts`), following CLAUDE.md's
"Adding a Notification" three-step pattern exactly: a registry entry, a
template per declared channel, and a `notify()` call at the real trigger —
here, the hourly cron (§6), not a request handler.

### 5.1 `practice.daily_reminder`

```ts
{
  key: 'practice.daily_reminder',
  label: 'Daily practice reminder',
  description:
    "Sent at your chosen reminder time on a day you haven't practised yet, when you have nothing specifically due for review.",
  channels: ['email', 'browser'],
  defaultEnabled: true,
}
```

Fires only when the ladder (§6) has already ruled out `streak.at_risk` and
`practice.review_due` — there is nothing urgent to name, so the copy is the
generic five-minutes nudge `VISION.md` gives as its own worked example,
modelled on it directly rather than reusing it verbatim (the review-count
half of that example belongs to §5.2, which is the event that actually fires
when review questions exist):

- **Subject**: "Five minutes is enough today"
- **Body** (opening line, the rest states the learner's own goal and a
  single CTA to `/practice`): "Five minutes is enough today. A quick
  session covers your goal."
- **Plain-text part, opening line**: "Five minutes is enough today."

### 5.2 `practice.review_due`

```ts
{
  key: 'practice.review_due',
  label: 'Questions ready to review',
  description:
    'Sent at your chosen reminder time when you have questions due for review — material you have learned before that is starting to fade.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
}
```

**Names the actual count of due questions** — the same `dueCount +
lapsedCount` figure `study-coach.ts`'s `recommendStudyAction` already
computes and calls `reviewCount`, read here rather than a second count
derived independently, for the identical "the number in the sentence is
always the number that made the card appear" discipline that file's own
header states.

- **Subject**: "{n} question(s) ready to review"
- **Body** (opening line): "You have {n} question{s} ready to review — a
  few minutes now keeps them from slipping."
- **Plain-text part, opening line**: "You have {n} question{s} ready to
  review."

This is the direct model for `VISION.md`'s own worked example — "Five
minutes is enough today. You have four review questions ready" — read as
this event's copy for the case where a learner also has not practised yet
today; when they have already met today's goal but still have review items
waiting, the opening drops the "five minutes" framing (the goal is already
met) and states only the review count.

### 5.3 `streak.at_risk`

```ts
{
  key: 'streak.at_risk',
  label: 'Keep your streak going',
  description:
    'Sent at your chosen reminder time when you have an active streak of two or more days and no freeze available to cover today automatically if you miss it.',
  channels: ['email', 'browser'],
  defaultEnabled: false,
}
```

**This is the only one of the three whose `defaultEnabled` is `false`, and
the reason is stated explicitly rather than left implicit**: it is the only
one of the three that references something the learner could lose. An
unrequested loss-framed message — "you have a streak, and it is at risk" —
is exactly the pressure `VISION.md` forbids by name: "We should never
create pressure, shame, fear, or unhealthy compulsion to increase
engagement metrics." A learner who wants this nudge can turn it on; a
learner who never asked for a countdown on their own consistency is never
handed one by default.

**Forbidden shapes, stated with the examples this document is checked
against**: no exclamation-stacking ("Don't lose your streak!!!"), no
countdown framing ("Your streak expires in 6 hours"), no guilt ("You
haven't studied today!!!" — `VISION.md`'s own named example of what "not
useful" looks like), and no naming of a specific loss ("You'll lose your
12-day streak"). The copy states the positive action, never the negative
consequence:

- **Subject**: "Your streak is still yours today"
- **Body** (opening line): "You're on a {n}-day streak. A quick session
  today keeps it going."
- **Plain-text part, opening line**: "You're on a {n}-day streak."

**None of the three sets `mandatory`.** All three are switchable in the
`notifications` namespace exactly like `user.welcome` — an untouched account
receives them per `defaultEnabled` above, and a learner who mutes any of the
three loses nothing but that message.

---

## 6. The hourly selection rule

```ts
// ADDED BY THIS EPIC — apps/api/src/engagement/tasks/practice-reminder.task.ts
@Injectable()
export class PracticeReminderTask {
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> { /* §6 below */ }
}
```

The exact `@Injectable()` + `@Cron(CronExpression...)` shape
`apps/api/src/auth/tasks/token-cleanup.task.ts` already establishes, added
to `EngagementModule`'s own `providers` array — no separate "tasks module"
anywhere in this application, the same structural rule `readiness-model.md`
§7 already states for its own nightly cron.

**Why hourly, and not daily**: `token-cleanup.task.ts` runs
`EVERY_DAY_AT_3AM` — a single fixed UTC instant that reaches a Tokyo learner
at noon and a Los Angeles learner at 7pm the previous evening. "Remind this
learner at 9am *their* time" is not expressible as a single daily cron
expression at all, because "9am their time" is a different UTC instant for
every distinct timezone this application's learners are in. An hourly cron
sidesteps this entirely: on every run, it asks "whose local hour, right
now, equals their chosen reminder hour" — a question a fixed-time daily job
structurally cannot answer for more than one timezone at once.

### 6.1 Selection, in order

On every hourly firing, **all reads happen first, in one pass**, before any
`notify()` call — the identical discipline `PracticeService.completeSession`
already applies to its own readiness-recompute trigger (read and write the
triggering fact, *then* call out), extended here to a batch of learners
rather than one:

1. Learners whose `user_settings.value.study.reminderEnabled` is not `false`
   (absent means enabled, §7).
2. ...whose **local hour right now** equals their
   `study.reminderHour` (default `9`) — computed via
   `Clock.calendarDateIn`'s companion local-time derivation, in
   `learner_profiles.timezone`.
3. ...who have **not already met today's goal** — `daily_activity` for
   today, `goalMet !== true` (or no row for today at all).
4. ...who have **not already been reminded today** — §6.3.

### 6.2 The ladder — exactly one event per learner per local day

For each learner surviving all four filters, **exactly one** of the three
events fires, chosen by this ladder, evaluated top to bottom:

```
1. streak.at_risk       if current streak >= 2 AND no freeze available to cover today
2. practice.review_due  else if dueCount + lapsedCount > 0
3. practice.daily_reminder  otherwise
```

"No freeze available to cover today" reads `streakFreezes === 0` at
selection time — a learner still holding a freeze is, by construction,
already protected against today lapsing their streak even if they never
open the app, so naming the risk to them would be inaccurate as well as
unnecessary pressure. `dueCount + lapsedCount` is the identical figure
`study-coach.ts`'s `reviewCount` already computes (§5.2) — not a third
independent count.

`notify()` is called **per learner, after all reads for that firing are
complete and outside any `$transaction`** — the same rule
`CLAUDE.md`'s "Adding a Notification" section states for a single request,
applied here across a loop over many learners rather than one: the cron
reads every eligible learner's profile, streak state, and queue counts in
one pass, decides each learner's event, and only then loops calling
`this.notifications.notify(eventKey, learner.userId, data)` once per
learner — never interleaving a read for learner *N+1* with a still-pending
write for learner *N*, and never opening a transaction the notify calls
would have to join (`notify()` is detached by design and must not be asked
to become part of one).

### 6.3 "Already reminded today"

Answered by `notification_deliveries` — the framework's own existing table,
already indexed `[userId, eventKey]` and never a duplicate tracking column
this epic would have to keep in sync with it. Concretely: for each
candidate learner, before selecting an event, query

```sql
SELECT 1 FROM notification_deliveries
WHERE user_id = $1
  AND event_key IN ('practice.daily_reminder', 'practice.review_due', 'streak.at_risk')
  AND created_at >= $local_day_start_utc
  AND created_at <  $local_day_end_utc
LIMIT 1
```

where `$local_day_start_utc`/`$local_day_end_utc` are the UTC instant bounds
of the learner's current local calendar day — the same boundary §3's
`activityDate` derivation computes, applied here to a query range instead of
a stored date. A matching row means this learner already received one of
the three events today, from any earlier hourly firing, and step 4 above
excludes them. `createdAt` is used specifically because `notify()`'s own
contract (`notifications.service.ts`) writes the delivery row synchronously
when the send is scheduled, not when it eventually completes — so this
check reflects "was an attempt already made today," the correct question,
regardless of whether that attempt's eventual `status` was `sent` or
`failed`.

---

## 7. The `study` user-settings namespace

```ts
// user-settings-namespaces.schema.ts — ADDED BY THIS EPIC, alongside the
// existing dataTables/navigation/notifications namespaces in the same file.
export const studySchema = z
  .object({
    reminderHour: z.number().int().min(0).max(23).optional(),
    reminderEnabled: z.boolean().optional(),
  })
  .strict();

export const studyPatchSchema = z
  .object({
    reminderHour: z.number().int().min(0).max(23).nullable().optional(),
    reminderEnabled: z.boolean().nullable().optional(),
  })
  .strict();
```

Both fields optional, **never `.default()`** — the identical rule this
file's own header states for every namespace it already declares:
"Absent MUST mean 'use the application's built-in defaults', computed at
read time by the consumer." **Absent means the built-in default resolved at
read time**: hour `9`, enabled `true`. A `.default(9)` would materialize
`reminderHour: 9` into storage the first time a learner touched any
unrelated setting, freezing them at today's default hour even after a
future change decided the built-in default should move — the same "frozen
column set" failure mode that file's header already spends a full paragraph
on for `dataTables.visibleColumns`.

**Adding this namespace is the six-file change**
`user-settings.service.ts`'s own comment names by number, and this document
names each of the six explicitly so a later implementer has a checklist,
not a count to take on faith:

1. `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` —
   declare `studySchema`/`studyPatchSchema` (above).
2. `apps/api/src/common/schemas/settings.schema.ts` — add `study:
   studySchema.optional()` to the full schema and `study:
   studyPatchSchema.nullable().optional()` to the patch schema.
3. `apps/api/src/common/types/settings.types.ts` — add `study?: StudyValue`
   to the `UserSettingsValue` interface, imported from the namespaces file
   like `dataTables`/`navigation`/`notifications` already are.
4. `apps/api/src/settings/dto/update-user-settings.dto.ts` — the same two
   fields (full and patch) as the `UpdateUserSettingsDto`/`PatchUserSettingsDto`.
5. `apps/api/src/settings/dto/user-settings-response.dto.ts` — `study:
   studySchema.optional()` on the response projection.
6. `apps/api/src/settings/user-settings/user-settings.service.ts` —
   `toResponse`'s conditional-spread line (`...(value.study !== undefined ?
   { study: value.study } : {})`), the same pattern the file already applies
   for `navigation`.

**The consequence of missing one, stated as plainly as that service's own
comment states it for `dataTables`/`navigation`**: a namespace missing from
`userSettingsSchema` (file 2) is accepted by the controller, silently
stripped by `userSettingsSchema.parse()`, and never seen again by a
subsequent `GET` — with no error anywhere. A learner who sets their reminder
hour to 6am would see the write succeed and the very next read report
nothing changed, with nothing in the response or the logs explaining why.

**No new merge method is needed on file 6 beyond the response-projection
line.** `study` has exactly the shape `navigation` already has — a small,
flat object of independently-optional scalar fields, PATCHed field-wise —
so it reuses `navigation`'s existing field-wise-merge codepath rather than
needing its own `mergeStudy` the way `notifications`' three-level nested
shape needed `mergeNotifications` (`user-settings.service.ts`'s own
`mergeDataTables` vs. `mergeNotifications` distinction, restated here for
`study`: replace-wholesale is correct because there is no nested map to
deep-merge inside it).

### 7.1 `study.reminderEnabled` is not the same control as muting an event

**These are two different settings, on two different pages, and the UI copy
must say which one it is changing.** `study.reminderEnabled` (this
namespace) governs step 1 of §6.1's selection ladder — whether the hourly
cron considers this learner **at all**, for any of the three events. Setting
it `false` is "stop checking in on my study habit," a single switch that
silences all three reminder events at once, before the ladder is even
evaluated.

Muting `practice.daily_reminder` specifically in the `notifications`
namespace's matrix (`/settings/notifications`, per-event, per-channel — the
existing shape `notification-preferences.ts` already resolves) is narrower:
it means "the cron may still decide I should hear
`practice.daily_reminder`, but do not actually deliver it to me" — while
`practice.review_due` and `streak.at_risk` remain live for that same
learner if their own toggles are on.

A learner who wants **no** habit reminders at all should turn off
`study.reminderEnabled`; a learner who is happy to hear about due reviews
and an at-risk streak, but finds the generic five-minute nudge unhelpful,
should instead mute `practice.daily_reminder` alone in the notifications
matrix. The journey/study settings page's copy for `reminderEnabled` should
read "Remind me to practice" (paired with the hour picker), never
"Notifications" or anything that could be mistaken for the separate matrix
page's own controls.

---

## 8. Celebration copy rules

**Specific and earned, derived from real response fields — never a generic
exclamation.** The two worked examples this document is checked against,
both directly computable from data this epic and its predecessors already
have on hand:

- *"That is five minutes today — your goal."* — derived from
  `daily_activity.practiceSeconds` crossing `learner_profiles.dailyGoalMinutes
  * 60` (the exact moment `goalMet` flips `true`, §2.3) — the celebration
  fires off the same transition, not a separate check.
- *"You remembered this correctly on three different days."* — derived from
  `question_mastery.distinctCorrectDays` reaching E5's own promotion
  threshold (`memory-model.md` §3.1's `MASTERY_PROMOTION_THRESHOLD`) — this
  epic's celebration surface renders E5's own verified fact, not a new
  count of its own.

**Never** "Amazing! You're doing great!" — or any celebration copy that
would read identically regardless of what actually happened. A message that
could be shown to a learner who met their goal *and* to one who did not is
not a celebration, it is decoration, and it is the exact shape `VISION.md`'s
"not simply because encouragement increases engagement" line (PRD.md,
"Motivation, Not Manipulation") rules out.

**Session-end celebration motion respects `prefers-reduced-motion`** — the
same accessibility posture every other animated surface in this application
already commits to; a learner with the media query set sees the identical
specific, earned copy with no confetti, no ring animation, and no motion at
all standing in for it.

**The word for what the ring measures is `consistency`, never `readiness` or
`progress-toward-readiness`.** `PRD.md` requires the two stay visibly
distinct, and this is where the requirement becomes copy, not just an
architectural boundary: the goal ring and the streak badge on Home describe
*a habit*, and their labels must never borrow readiness's vocabulary — "You
are 40% ready" is not a sentence this ring is ever entitled to render, and
neither is "Your progress toward readiness is..." attached to a streak
number. `readiness-model.md` §2.4 already states the structural half of
this rule ("never wired in as an input"); this is the copy half, on the
surface a learner actually reads.

---

## 9. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **A daily cron instead of hourly** | Cannot express "remind this learner at 9am *their* time" for learners in more than one timezone at once — a single fixed UTC firing reaches every timezone at a different local hour, which is not a bug to route around but a structural mismatch with the requirement. `ROADMAP.md` §7 states the rule this document follows rather than re-derives: "a single daily cron cannot deliver '9am your time' across time zones." An hourly cron, checked against each learner's own local hour on every firing, is the only shape that can. |
| **Recomputing streaks by bucketing `practice_attempts.answered_at` instead of a `daily_activity` row** | `practice_attempts` records *what was answered*, not *whether a day's goal was met* — deriving `goal_met` from it would mean re-running the `practice_seconds` cap-and-sum formula (§2.3) over every attempt on every streak read, for every learner, instead of reading one small upserted row. It would also have nowhere honest to record a settled freeze day (§4.4) — a freeze protects a day with **zero** attempts, and a table whose every row implies "a question was answered" cannot represent "this day was covered by a freeze" without inventing a synthetic attempt that never happened. `daily_activity` exists specifically to be the derived rollup `practice_attempts` was never shaped to be. |
| **Unlimited freezes** | Directly reopens the failure `VISION.md` names — "a product that sacrifices accuracy for engagement" wearing a different name: a freeze budget that never runs out is not protection against one bad day, it is a policy that a streak can never actually break, which makes the streak number stop meaning "consistency" at all. `STREAK_FREEZE_MAX = 2` with a bounded 7-day replenishment (§4.3) keeps freezes doing their one job — absorbing a single real lapse inside real, ongoing effort — without dissolving the concept of a missed day entirely. |
| **Deriving freeze consumption on every read instead of persisting it (§4.4)** | Rejected on three independently load-bearing grounds stated in full at §4.4: no idempotency guard against a double-consumed freeze on a repeated settlement pass, no durable artifact a learner or a later feature can point at as "this day was covered," and — the decisive one — a freeze that is only *checked* and never *spent* is not a budget at all, because nothing about checking it ever reduces what is available for the next gap. |
| **A client-supplied session duration for `practice_seconds`** | §2.3 states the reason directly: a user-writable engagement metric with no downstream check that would catch a fabricated value, unlike a graded response, which still has to be *right* to help the learner. `durationMs` already exists on `practice_attempts` as per-question UI telemetry and is exactly this untrusted — this table computes its own duration from `Clock`-stamped server timestamps instead of reading it. |
| **Storing `activity_date` as `@db.Timestamptz`** | Would make "which local day is this" a computation performed at every read instead of a fact fixed at write time — the identical trap §3.2 rejects for re-deriving a learner's timezone history on demand. A `Timestamptz` column also cannot carry `tz_used` beside it as a single self-explaining fact the way a `@db.Date` plus a sibling `tzUsed` string can; the epic body itself specifies `@db.Date`, and this document keeps that rather than proposing a more "flexible" instant column that would only reopen a question the schema already closes. |
| **Persisting `longestStreak` on `learner_profiles` instead of deriving it (§4.2)** | Unlike `readiness_snapshots`, which snapshots because a trend line and self-explaining historical rows are the product requirement (`readiness-model.md` §4, §12), `daily_activity` is already the durable evidence ledger this fact is computed from — deriving `longest` from it on every read is a single bounded scan over a row count that grows only with account age, and a cached counter would be a second value that could drift the moment a row is backfilled, a bug rewinds one, or settlement (§4.4) writes a freeze row out of the order it was read in. Nothing about `longest` needs to survive the underlying rows moving on the way a readiness snapshot's `components` breakdown does. |
| **Making `streak.at_risk` mandatory or default-on** | §5.3 states the reason as the epic's own opt-in default: it is the one event of the three that references something a learner could lose, and an unrequested loss-framed message is precisely the "pressure... to increase engagement metrics" `VISION.md` rules out by name. `mandatory` is reserved for a fact a user must not be able to silence — a security or privilege change (`security.role_changed`'s own justification) — and a streak is neither. |
| **Points, achievements, weekly challenges, and leaderboards** | Explicitly out of scope for this epic, per the epic body's own closing line and `ROADMAP.md` §8, quoted rather than paraphrased: "Points, achievements, and weekly challenges... E7 ships goals, streaks, and celebrations only. **Leaderboards are not deferred — they are on `VISION.md`'s 'will not build' list** and will not appear in a future epic either." `VISION.md`'s own "What We Will Not Build" list names "a leaderboard-driven competition between applicants" directly — not a future milestone, a permanent exclusion. |
