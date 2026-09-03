# Design Spec: Practice sessions (deterministic grading, `practice_attempts`)

This is the durable design for E3 — the first destination where a learner
*produces* an answer instead of recognizing one, the deterministic
exact-match-plus-normalisation grader that scores it with no AI dependency at
all, and `practice_attempts`, which epic #52 calls "the single evidence table
for the whole product": E5 (#54) reads it to compute verified mastery, E6
(#55) reads it to compute readiness, E7 (#56) reads it for streak/engagement
signals kept structurally apart from readiness, and E8 (#57) writes into the
identical table with `source = 'mock_interview'` rather than a parallel one.
An epic and its child issues link here instead of restating the design — read
this first, then the issue you were sent to implement.

Source of truth for every claim below:

- `ROADMAP.md` §3 (the epic table's E3 row and its dependency on E1+E2), §4
  ("Why this order" — the "Deterministic before AI" paragraph, which is this
  epic's entire reason for existing as its own step ahead of E4), §5 (the
  dependency graph: `E2 --> E3`, `E3 --> E4`, `E3 --> E5`, `E3 --> E7`), §7
  ("Cross-cutting rules" — "One evidence table", "No job queue", "Local days
  are explicit", "Test affordances are non-production only", "No test may run
  against a database"), and the 2026-09-02 decision-log entries "
  `practice_attempts` is one table" and "The study-coach recommender (E5) is
  deterministic" — the exact commitments this document is required to keep.
- [Epic #52](https://github.com/marinoscar/oathpath/issues/52) itself — the
  four locked decisions verbatim, the column list for both new tables, the
  API and web slice, and the explicit out-of-scope list (semantic grading,
  spaced repetition, readiness, streaks, spoken answers) this document does
  not reach into.
- `docs/specs/journey-shell.md` §4 and §4.1 — the closed `NextAction.kind`
  union and its "never a route that redirects to `/`" invariant, which this
  epic extends by exactly one member (`practice`), never by a free-form path.
- `docs/specs/civics-content.md` §4 and its worked example (§4.1, the Speaker
  of the House) — the close-then-open dynamic-answer lifecycle that makes
  `answer_snapshot` (§6 below) necessary in the first place, and §5's
  resolution table, which is the exact function this epic's grading path
  calls to learn what a question's accepted answers currently are.
- `apps/api/src/journey/next-action.ts` — `NEXT_ACTION_KINDS`,
  `NEXT_ACTION_PATHS`, and the comment naming this epic explicitly: "E3 (#52)
  re-points `interview_countdown` to `/practice` once Practice has real
  content to send a learner to." §9 below is that re-pointing, specified.
- `apps/api/src/journey/test-version-resolution.ts` — "the cutoff date
  appears exactly once, and it is here": the one-named-file idiom for a rule
  that must never drift, which §5's normalisation pipeline and §7's matcher
  copy for the identical reason (a rule with no Nest, no Prisma, and no
  second inlined copy anywhere).
- `apps/api/src/civics/answer-resolution.ts` — the pure, standalone,
  Clock-free function shape (`resolveAnswerScope`, `selectAnswers`) that
  civics-content.md §5's resolution table compiles down to, and that this
  epic's grading path calls as-is rather than re-deriving "which answers are
  current" from raw rows a second time.
- `apps/api/src/practice/answer-matching.ts` and its spec — **already
  written and already the authoritative implementation of §7 and §7.1
  below.** Its own header names this document by filename ("practice-
  sessions.md's normalisation table, as a pure module") and states outright
  that its step order "is PART OF THE CONTRACT" defined here. Every claim in
  §7/§7.1 has been verified against this file line by line, not drafted
  ahead of it.
- `apps/api/prisma/migrations/20260903000000_add_practice_sessions_and_attempts/migration.sql`
  and the committed schema (`git log`'s `8c13a87`, "feat(db): practice_sessions
  and practice_attempts tables", closing issue #66) — the actual, applied DDL
  §2 describes: exact column list, nullability, `onDelete` behaviour, and the
  two indexes that exist (and the ones that, on inspection, do not).
- `apps/api/prisma/schema.prisma` — `JourneyStage` and `CivicsDynamicScope`
  (the house convention for a small, closed, code-owned set: a real Postgres
  enum, not a plain string, because the set is not one a feature registry is
  meant to extend at runtime), `AiUsageEvent`'s comment on nullable token
  columns (`null` means unknown, `0` is a false claim — the same reasoning
  §4 applies to `duration_ms`), `CivicsAnswer`/`CivicsQuestion`/
  `CivicsTestVersion`/`LearnerProfile` (the tables this epic's tables hang
  off of by foreign key), and `SystemSettings.value` / `UserSettings.value`
  (the plain `Json` convention `practice_sessions.summary` and
  `practice_attempts.answer_snapshot` both follow).
- `apps/api/src/common/clock/clock.ts` — `Clock`, the mandatory "never
  `new Date()`" rule restated in §11 for this epic's timestamps
  (`started_at`, `completed_at`, `answered_at`).
- `apps/api/src/common/constants/roles.constants.ts` — the closed permission
  set. Nothing in this design adds to it; §10 explains why every practice
  route is `@Auth()` with no permission, the same posture
  `journey.controller.ts` and the AI per-user routes already take.
- `apps/api/src/journey/journey.controller.ts` — the no-user-id structural
  rule (every route resolves the caller from `@CurrentUser('id')`, never a
  parameter) this epic's own controller follows for the same reason: a
  learner's own practice history is exactly as private as their own learner
  profile.
- `apps/api/src/allowlist/allowlist.controller.ts` — the `page`/`pageSize`
  query-parameter shape §10's session-list endpoint reuses rather than
  inventing a second pagination convention.
- `apps/web/src/pages/PracticePage.tsx` and
  `docs/specs/journey-shell.md` §8.2 — the current `/practice` destination:
  a designed empty state shipped by E1, stating plainly that "there's
  nothing to practice here yet." This epic is what replaces it with a real
  page; §12 records that this file, like `LearnPage.tsx` before it, is
  **superseded** rather than deleted-and-forgotten once E3 ships.
- `CLAUDE.md`'s "Using the Clock" section — restated in §11 — and the
  "MANDATORY: Issue-Driven Development" section, which is why this document
  exists at all: issue #64 requires it before implementation is finalized.

**One correction to issue #64's own problem statement, stated here because a
later reader should not inherit a stale count.** The issue was filed
observing that "`docs/specs/` holds exactly two documents today —
`ai-settings.md` and `vps-deploy.md`". That was true when #25 (AI
configuration) and the VPS deploy work were the only completed epics with a
spec; it is no longer true. As of this writing `docs/specs/` holds **four**
documents — `ai-settings.md`, `vps-deploy.md`, `journey-shell.md` (E1), and
`civics-content.md` (E2) — verified by listing the directory. Both of the
newer two say nothing about practice, which is the part of the issue's
premise that does still hold: this is the first document to describe
`practice_attempts`, the normalisation pipeline, or anything at
`/practice`.

**More of this epic has already shipped than "not started" on the roadmap
table suggests.** Two of #52's nine child issues are done as of this
writing, verified against the actual repository state rather than against
the issue tracker: issue #66 shipped the `practice_sessions` and
`practice_attempts` tables (migration
`20260903000000_add_practice_sessions_and_attempts`, commit `8c13a87`), and
issue #70 shipped `apps/api/src/practice/answer-matching.ts` — a complete,
tested, pure implementation of the normalisation pipeline and matcher this
document specifies in §7 and §7.1. **§2's table descriptions below are
therefore a description of applied DDL, not a proposal** — every column,
nullability mark, and `onDelete` behaviour has been checked directly against
the migration's SQL and the generated Prisma client, not drafted from the
issue text alone (and in a few places the shipped schema resolves a question
the issue text left open in a way this document had to reconcile — §2.2 and
§9 say where). **What has not shipped** is everything else: no
`PracticeService`, no `PracticeController`, no `/api/practice/*` route, and
no change yet to `PracticePage.tsx` or `next-action.ts` — verified by
grepping `apps/api/src/practice/` (which holds only the matcher and its
spec) and `apps/api/src/**/*.controller.ts` for `practice`. §10 and §12 are
this document's design for that remaining surface, not a description of code
that exists.

**One additional fact worth naming plainly: E4 (#53) has already begun.**
As of this writing, `apps/api/prisma/schema.prisma` carries uncommitted
edits adding `PracticeFailureCause`, and three nullable columns —
`failureCause`, `aiFeedback`, `aiUsageEventId` — to `practice_attempts`
itself (issue #110, migration
`20260903010000_add_practice_attempt_ai_grading`), extending
`gradingMethod: 'ai'` from a declared-but-unreachable value (§8) into a real
one. **None of that is this document's design to make**, and §2.2's table
below deliberately does not include those three columns — they belong to
whatever epic #53 design document eventually covers AI grading in full, the
way this document covers E3. They are named here only so a later reader who
diffs the live schema against §2.2 and finds three extra columns does not
mistake this document for stale; it is scoped to what issue #64 asked for,
and E4's own docs slice is where those columns belong.

This document is what the *remaining* E3 work — the practice module, the web
pages, the Playwright spec — builds *against*. Every fact cited above about
the existing codebase has been verified against the files named; a child
issue is free to find a better answer to a specific sub-problem as long as
it keeps the contracts already locked by the shipped schema and the shipped
matcher — the two table shapes exactly as migrated, the closed enums, the
normalisation pipeline's order, and `matchAnswer`'s contract.

---

## 1. Where this sits relative to E1 and E2

E1 shipped the shell this epic hangs a real destination off of: the
`/practice` route already exists and already renders (§12), `learner_profiles`
already carries `test_version_code`, `state_code`, and `senior_exemption`
(the three facts a session selector needs to know which questions to draw
from), and `Clock` already exists as the one injectable notion of "now."

E2 shipped the content this epic grades against: `civics_questions` (a
`prompt`, a `dynamic_scope`, a `senior_eligible` flag), `civics_answers` (the
close-then-open lifecycle, §6 below), and — critically for this epic —
`apps/api/src/civics/answer-resolution.ts`, a pure function pair that already
answers "what are this question's currently correct answers, for this
learner" without touching a database itself. §7's grading path calls
`resolveAnswerScope` and `selectAnswers` exactly as E2 left them; this epic
does not re-derive "which answer rows are current" a second time, for the
identical reason civics-content.md §3 gives for not duplicating `effective_to
IS NULL` behind a second `is_current` flag — a second place the same fact is
computed is a second place it can drift from the first.

**What E3 adds that neither predecessor has**: a place where a learner types
an answer rather than reads one, a graded outcome, and the one row every
later epic's algorithm is built to read. E1's `nextAction` recommender
already anticipates this epic by name — `next-action.ts`'s own header says
"E3 (#52) re-points `interview_countdown` to `/practice`" — so this document
is also the place that re-pointing is specified precisely (§9), rather than
left as a comment nobody circles back to.

---

## 2. Two new tables

```
learner_profiles (E1)          civics_questions (E2)
        │ user_id                       │ id
        │                               │
        │                               │
practice_sessions ──────────────< practice_attempts >──── civics_questions
        │ id                            │ id, session_id?
        └── kind, status,               │ source, input_mode, prompt_mode,
            planned_count,              │ outcome, grading_method,
            summary (json)              │ revealed, hint_used, duration_ms,
                                         │ answer_snapshot (json)
```

Two tables, not one, for a reason that is really about **cardinality, not
convenience**: a session is the *container* a learner opens once and answers
several questions inside ("Quick 5" is five attempts inside one session); an
attempt is the *evidence* — one row per question actually answered, revealed,
or skipped. Collapsing them into one wide table (session columns repeated on
every attempt row) would either denormalize `kind`/`planned_count` across
every attempt in a session, or force every attempt to *be* a one-question
session, which breaks the "Quick 5" and "by category" flows the epic
requires outright, and would also break the one E8 needs least: an
attempt with **no** enclosing `practice_sessions` row at all (§2.2's
`session_id` note).

### 2.1 `practice_sessions`

| Column | Prisma type (design level) | Nullable | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `userId` | `String @db.Uuid` | no | FK → `users.id`, `onDelete: Cascade` — a session has no meaning independent of the learner who opened it, the same posture `LearnerProfile.user` already takes, not the `Restrict` posture content tables take. |
| `kind` | `PracticeSessionKind` (Postgres enum) | no | `quick` \| `category` \| `review` \| `weak` \| `mixed`. §4 covers which two ship in E3 and which three are declared, unwired, for E5. |
| `status` | `PracticeSessionStatus` (Postgres enum), default `in_progress` | no | `in_progress` \| `completed` \| `abandoned`. §5 is the full lifecycle; there is no fourth state, and specifically no `paused` — a session a learner walks away from and later resumes is still `in_progress` until it resolves one of the other two ways. |
| `testVersionCode` | `String` | no | FK → `civics_test_versions.code`, `onDelete: Restrict` — the same posture `LearnerProfile.testVersion` already takes: a test version cannot be deleted while sessions still reference it. Recorded on the *session*, not derived from the learner's current profile at read time, because a learner's `test_version_code` can in principle change (a corrected filing date), and a session already in progress — or long completed — must keep saying which bank it actually drew its questions from, not whichever bank the profile happens to say today. |
| `categoryId` | `String? @db.Uuid` | yes | FK → `civics_categories.id`, `onDelete: SetNull`. Populated only for `kind: 'category'`; null for every other kind, `quick` included, since a "Quick 5" draws across the learner's whole active test version rather than one section. `SetNull`, not `Restrict`: the category is a descriptive filter the session was started with, not a dependency the session's own integrity rests on — if a category is later removed, the historical session record should keep existing with `categoryId: null` rather than block the category's deletion or vanish itself. |
| `plannedCount` | `Int` | no | How many questions this session intends to ask, decided at creation (`5` for Quick 5, a category's remaining unseen count for `kind: 'category'`). Read by the summary screen to render "4 of 5" honestly, and read by E7 as one input to whether a day's goal was met — never itself a promise that exactly this many attempts exist, since a learner can abandon early. |
| `startedAt` | `DateTime @db.Timestamptz`, DB default `now()` | no | Application code sets it explicitly from `Clock.now()` at creation (§11) rather than relying on the column's own `DEFAULT CURRENT_TIMESTAMP` — the default exists as a safety net for a row inserted by something other than the practice service, not as the path the service itself is meant to take. |
| `completedAt` | `DateTime? @db.Timestamptz` | yes | Null while `in_progress`. Set once, when `status` transitions to `completed` **or** `abandoned` — both are terminal, and both close out the session's open-endedness the same way, which is why one column serves both rather than two mutually-exclusive nullable columns. |
| `summary` | `Json?` | yes | Computed once at completion — counts by `outcome`, a duration total, anything the summary screen renders — the same plain `Json` convention `SystemSettings.value`/`UserSettings.value` already use. **Nullable, and null while `in_progress`**, because there is nothing to summarize yet — not an empty object standing in for "no summary," which would be indistinguishable from a genuinely empty completed session. **Derived, not authoritative**: a cached rendering of the session's own `practice_attempts` rows, present so the summary screen and any later "recent sessions" list do not have to re-aggregate on every read, never a second place `outcome` counts are recorded that could drift from the attempts themselves. |
| `createdAt` / `updatedAt` | `DateTime @db.Timestamptz` | no | House convention — `updatedAt` moves on every status transition, unlike `practice_attempts` (§2.2), which has no `updatedAt` at all. |

```
@@index([userId, startedAt])
@@map("practice_sessions")
```

This is the **entire** index list the migration actually creates — verified
against `migration.sql` directly, not assumed from the acceptance criteria.
There is deliberately no second index on `status`: the one query this table
serves today is "this user's sessions, newest first" (the "recent sessions"
list, and the same lookup the create-session flow uses to find any existing
`in_progress` row, §5), and `[userId, startedAt]` already serves both — a
`WHERE status = 'in_progress'` clause over a small, per-user row set does not
need its own index to be fast. This is also why the invariant §5 describes
(at most one `in_progress` session per user) is enforced by the create-session
service method, never by a database constraint: no partial unique index on
`status = 'in_progress'` exists in the shipped migration, so nothing at the
database level currently prevents two concurrent requests from each creating
one — a gap this document states plainly rather than papering over (see §13's
rejected alternative on this exact point).

### 2.2 `practice_attempts` — the single evidence table for the whole product

Every column below is drawn directly from epic #52's own slice description.
For each, this table states **what later epic reads it and why it could not
be added afterward without a migration over live rows** — the epic body's
own justification for shipping two of these ahead of any reader existing.

| Column | Prisma type (design level) | Nullable | Read by | Notes |
|---|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | — | |
| `userId` | `String @db.Uuid` | no | E5, E6, E7 | FK → `users.id`, `onDelete: Cascade` — the user's own evidence, gone with the account, the same `AiUsageEvent.user` posture. |
| `questionId` | `String @db.Uuid` | no | E5, E6, E8 | FK → `civics_questions.id`, `onDelete: Restrict` — a question cannot be deleted while attempts reference it; content is `Restrict`-protected everywhere in this schema (civics-content.md §2), and an attempt's evidentiary value depends on the question it was an attempt *at* continuing to exist. |
| `source` | `PracticeAttemptSource` (Postgres enum), default `practice` | no | E5, E6, E8 | `practice` \| `mock_interview`. §3 below is the full "why one table" argument; this column is the discriminator it turns on. E3 writes only `practice`; E8 (#57) is the epic that ever writes `mock_interview`, into this exact table, not a parallel one. |
| `sessionId` | `String? @db.Uuid` | yes | web (session/summary screens) | FK → `practice_sessions.id`, `onDelete: SetNull` — **not** `Cascade`. An attempt is *evidence* that a question was answered, and deleting the session it happened to occur under (a housekeeping purge of old session rows, say) must not silently delete the fact that the learner answered a question; the attempt survives with `sessionId: null`, the identical shape a mock-interview attempt already has. **Non-null for every `source: 'practice'` row and null for `source: 'mock_interview'`**: E3's own module creates the enclosing session before an attempt can exist, but E8's interview groups its answers by whatever concept an interview attempt turns out to need — nothing that has anything to do with `practice_sessions`. Making `session_id` nullable now is what lets E8 write into this table without inventing a `practice_sessions` row that means nothing to it. |
| `inputMode` | `PracticeInputMode` (Postgres enum), default `typed` | no | E9, E10 | `typed` \| `spoken`. E3 writes only `typed` — there is no microphone yet. `spoken` is declared now because E9 (Voice foundation) wires it: "recall without hints" and "answered a question they heard" are distinct readiness signals in `PRD.md`, and retrofitting the *column* onto attempts a learner already produced (with no way to know, after the fact, whether an old typed answer was typed or transcribed from speech) is not possible at all, migration or not — the fact has to be captured at the moment of the attempt or it is lost permanently. |
| `promptMode` | `PracticePromptMode` (Postgres enum), default `read` | no | E9 | `read` \| `heard`. E3 writes only `read` — nothing plays audio yet. Same "capture now or lose forever" argument as `inputMode`, and the same epic (E9) is the first real reader of the non-default value. |
| `responseText` | `String? @db.Text` | yes | debrief screens | The learner's raw, unmodified input — never normalised in place. Null only when `outcome: 'skipped'` and the learner supplied no text at all (they hit skip, or revealed with nothing typed). `@db.Text`: a response has no meaningful length bound at the schema level, though §7 caps what the matcher will *process* at 2000 characters — the column is not the place that cap is enforced. |
| `outcome` | `PracticeOutcome` (Postgres enum) | no | E5, E6, E7, E8 | `correct` \| `partial` \| `incorrect` \| `skipped`. §8 is the full account of why `partial` is declared now and unreachable from E3's own grading path until E4 exists to produce it. |
| `gradingMethod` | `PracticeGradingMethod` (Postgres enum) | **no** | E5 (the mastery discount, §9), E6, E8 | `exact` \| `self` \| `ai`. **Not nullable** — every attempt row, `skipped` included, records who or what made the call. §8.1 spells out exactly what value a skip gets and why, since the column's own `NOT NULL` constraint means "no grading happened" is not an option the schema leaves open the way a nullable column would. `exact` is the only value E3's own deterministic path writes on a fresh, response-bearing attempt; `self` is written only by the self-mark escape hatch (§9); `ai` is declared for E4 and unreachable until it ships (§8). |
| `revealed` | `Boolean`, default `false` | no | E5 (evidence weighting) | True once the learner has seen the accepted answer for this question, whether or not they had already responded. §9.1 covers exactly how this interacts with self-mark. |
| `hintUsed` | `Boolean`, default `false` | no | E5 (evidence weighting) | True if the learner requested a hint before submitting a response. Distinct from `revealed`: a hint narrows the field without giving away the accepted answer outright, so a correct outcome with `hintUsed: true` is real but *weaker* recall evidence than one with no assistance at all — the same "weaker evidence, not disqualified evidence" posture §9 gives self-mark. |
| `durationMs` | `Int?` | yes | E6, E8 (pacing, debrief) | Wall-clock time from question shown to response submitted. Null, never `0`, when the client cannot report a duration (a resumed session's first attempt after the page was reloaded, for instance) — the identical "null means unknown, `0` is a false claim of speed" reasoning `ai_usage_events`'s token columns already state in `schema.prisma`, applied to timing instead of tokens. Declared now because — like `inputMode`/`promptMode` — a duration not captured at the moment of the attempt cannot be reconstructed afterward; there is nothing to backfill it from. |
| `answeredAt` | `DateTime @db.Timestamptz` | no | E5 (distinct-day mastery), E7 (streaks) | The instant the attempt resolved to a terminal outcome — a submitted response, a skip, or a reveal with no response. Set from `Clock.now()`, never client-supplied and, unlike `practice_sessions.startedAt`, carries **no DB default at all**: the column is `NOT NULL` with nothing to fall back on, so application code must supply it explicitly on every insert. E5's "correct on 3 or more distinct days" rule (journey-shell.md §1) depends on this being the server's own clock, not a timestamp a client device could misreport. **Corrected from an earlier draft's "in the learner's own local day"**: as shipped, E5's distinct-day count reasons in **UTC** calendar days, not the learner's local one — `docs/specs/memory-model.md` §3.3/§3.5 record the correction against the real `nextSchedule`. |
| `answerSnapshot` | `Json` | no | E5, E6, E8 (debrief and re-grade transparency) | §6 is the complete account of what this holds and why. No default — the shipped column requires a value on every insert, which is the concrete enforcement of locked decision #4: there is no code path that can write an attempt without also freezing what it was graded against. |
| `createdAt` | `DateTime @db.Timestamptz` | no | — | House convention. **There is no `updatedAt` on this table at all** — the schema's own comment states it plainly: "An attempt is an immutable record of something that already happened — same reasoning as `AiUsageEvent`." §9 designs the self-mark mechanism around this fact rather than against it: self-marking is never a later mutation of a stored row. |

```
@@index([userId, questionId, answeredAt])
@@index([sessionId])
@@map("practice_attempts")
```

The first index is epic #52's own acceptance criterion, verbatim — it is
also the index E5's mastery scheduler needs to ask "on how many distinct
days has this learner answered this question correctly," and the exact
query shape `civics_answers`'s `[questionId, stateCode]` index serves for a
different table's version of "give me everything relevant to one question,
fast." The second is the session-detail view's own query — every attempt
belonging to one session. (A third index, on `aiUsageEventId`, exists in the
schema as of this writing but belongs to E4's in-flight work named above,
not to this document's scope.)

---

## 3. Why one evidence table, not two

**Locked decision #1** (epic #52): ordinary practice (E3) and mock-interview
answers (E8) write into the *same* `practice_attempts` table, distinguished
by `source`.

The argument is not aesthetic economy. It is that E5's mastery scheduler and
E6's readiness engine each need to answer questions that only make sense over
a learner's **complete** answer history to a question — "on how many
distinct days has this learner gotten this right, regardless of where they
answered it" (E5), "how much real evidence exists for this learner's
readiness, across every mode they've been evaluated in" (E6). With two
tables, both of those become a `UNION` (or two queries merged in
application code) on every read, forever, for every consumer of this data —
E5, E6, and any future epic that reads attempt history at all. A `UNION` is
not merely more code: it is a second place the two tables' column shapes
have to be kept compatible, and a second place a bug can silently read from
only one side and under-count. `source` is one column, checked at write
time and read at query time exactly like `civics_questions.dynamic_scope`
already is (civics-content.md §5) — a single filterable fact on a single
row, not two independently-evolving schemas an aggregation has to reconcile.

This is also why `input_mode`, `prompt_mode`, and `session_id` (nullable
specifically so E8 need not fabricate a session) are shaped the way §2.2
describes: a single table serving two very different producers (a practice
loop and an interview engine) has to accommodate the columns that make sense
for only one of them without either producer being forced to fake a value
for a column it has no honest answer to.

---

## 4. Session kinds, and which ones ship now

`practice_sessions.kind` declares all **five** values epic #52 names —
`quick`, `category`, `review`, `weak`, `mixed` — even though E3 wires only
the first two. This is the identical shape `docs/specs/ai-settings.md`
decision #1 locks for the six AI model roles ("six role slots declared, two
wired... a schema change (and a settings migration over live rows) when
voice work starts"), applied here to a session-kind enum instead of a
settings schema, for the same reason: `review`, `weak`, and `mixed` are real
product concepts E5's spaced-repetition scheduler needs a session kind to
select *into* the moment it exists, and adding an enum value later is a
migration over every session row already written, whereas declaring the
value now and simply never producing it until the selector exists costs
nothing.

| `kind` | Ships in | Selector (design level) |
|---|---|---|
| `quick` | **E3**, ordering upgraded by **E5** | Five questions, drawn from the learner's active test version. Under E3's own selector: unseen-first, falling back to least-recently-attempted once every question has been seen at least once. **E5 (issue #78) replaces that ordering** — without changing the `kind` or its wire contract — with `mastery/selector.ts`'s `selectQuestionsV2`: due, then weak, then new by category coverage, then steady, then mastered by recency (`docs/specs/memory-model.md` §5). |
| `category` | **E3**, ordering upgraded by **E5** | Every remaining unseen question in one `civics_categories` row for the learner's test version, `plannedCount` set to that count. Gains the identical `selectQuestionsV2` ordering upgrade `quick` does. |
| `review` | Declared; **still unwired after E5's full merge** | `question_mastery` and its mastery-aware selector both exist now (issue #78), but `createPracticeSessionSchema`'s `kind` enum still rejects `"review"` as a 400 — **corrected here from an earlier draft of this table, which described E5 as wiring this value.** It does not: E5 instead applies the mastery-aware ordering above to the two kinds already wired, `quick` and `category`, rather than adding new session kinds. `apps/web/src/pages/PracticePage.tsx`'s own header states this precisely: "THERE IS NO `kind: 'review' \| 'weak' \| 'mixed'` REQUEST ON THIS PAGE." Widening the schema to offer a genuine review session remains a separate, later change. |
| `weak` | Declared; **still unwired after E5's full merge** | Same correction as `review` — nothing in this codebase computes or requests `kind: 'weak'` today; `mastery/selector.ts`'s `weak` bucket biases the two wired kinds' ordering instead. |
| `mixed` | Declared; **still unwired after E5's full merge** | Same correction as `review` — no distinct `mixed` selection algorithm has been written; a blend of due and weak content is exactly what the wired kinds' new ordering already surfaces first. |

**E3's own module never produces `review`, `weak`, or `mixed`.** A session
created with one of those three kinds is not a state `POST
/api/practice/sessions` (§10) can even construct — the DTO's `kind` field is
validated against the two wired values, the same closed-set validation
`aiSettingsSchema` gives its role map. **This is still true after E5's full
merge, not just before it** (`docs/specs/memory-model.md` §5.3 corrects an
earlier draft of this document that assumed otherwise): the other three
exist only in the **database enum**, reachable once some later change
constructs a session with one of them, exactly the way `AI_MODEL_ROLES`'
four unwired roles render inert on `/admin/settings/ai` today without being
selectable for inference.

---

## 5. The session status lifecycle

`practice_sessions.status` is a three-value closed enum — `in_progress` →
`completed` | `abandoned` — with exactly one open state and two terminal
ones, and no `paused` state:

- **`in_progress`** — set at creation, the only status a session is ever
  created with. A learner mid-session who closes the tab, loses connectivity,
  or simply stops answering is *still* `in_progress`; there is no "paused"
  state to distinguish that from a session actively being answered right
  now, because nothing this epic needs to compute (a summary, a mastery
  input, a readiness input) depends on the distinction — an abandoned
  session's attempts are real evidence for whatever questions were actually
  answered before the learner left, regardless of why they left.
- **`completed`** — set once the learner has answered (or skipped, or
  revealed) every question the session planned to ask, and the summary
  screen has been shown. `completedAt` is stamped at the same instant.
- **`abandoned`** — set when a *new* session start finds an existing
  `in_progress` row for the same user. **This is the only trigger.** There
  is deliberately no cron sweeping stale `in_progress` rows to `abandoned`
  on a timer: ROADMAP §7's "No job queue" rule states plainly that
  scheduling and recompute in this product run synchronously, inside the
  request that produces the evidence, and a session's own completion state
  is exactly that kind of fact — it is decided the moment it becomes
  knowable (a new session start proves the old one was not going to be
  finished), not on the next tick of an unrelated clock. This also gives
  the invariant `practice_sessions` needs — **at most one `in_progress`
  session per user at a time** — a concrete enforcement point: the create-session
  service method closes any existing `in_progress` row (`status: 'abandoned'`,
  `completedAt: Clock.now()`) inside the same transaction that opens the new
  one. **This is an application-level invariant, not a database one** — §2.1
  already states the fact plainly: the shipped migration defines no partial
  unique index on `status = 'in_progress'`, unlike the genuinely
  database-enforced invariant civics-content.md §3 works out for
  `civics_answers` with a `sort`/`COALESCE` partial index. A concurrent pair
  of requests from the same user (two tabs, a double-tap) could in principle
  each pass the "is there an open session" check before either has committed
  and both create one — a narrow, low-consequence race (the loser's row is
  still `in_progress`, and the *next* session start closes it) that this
  document accepts rather than proposes a database-level fix for; see §13.
  A UI can still offer "resume" for a session the learner just left seconds
  ago; that is a client-side affordance over the same `in_progress` row, not
  a reason to avoid closing it out once a real new session actually starts.

A session that is `abandoned` after zero attempts (the learner started
Quick 5 and left immediately) is not an error case to special-case away — it
is a session with `plannedCount: 5` and no `practice_attempts` rows at all,
which every downstream reader already has to tolerate for a session
abandoned after three of five, and there is nothing about zero that is
qualitatively different from three.

---

## 6. Why `answer_snapshot` is stored per attempt

**Locked decision #4** (epic #52): `answer_snapshot` is stored on every
attempt row, not computed on demand from the current state of
`civics_answers`.

civics-content.md §4 already states the underlying fact this design leans
on directly: a `national`- or `state`-scope answer's `text` is never edited
in place — a correction closes the existing row (`effective_to` set) and
opens a new one. §4.1's worked example is the reason `answer_snapshot` has
to exist at all: a learner graded correct on 2026-06-01 against "Jane Q.
Doe" for "who is the Speaker of the House" must have that grading stay
explicable *forever*, even after John R. Roe is sworn in on 2027-01-03 and
the row that answer belonged to is closed. `civics_answers`' own rows
already guarantee the *content* survives (closed, not deleted) — but an
attempt recomputing "was this correct" at *read* time, by re-running §5's
resolution table against **today's** current answers, would silently
re-grade every past attempt against whichever answer happens to be open
right now. A learner's debrief screen a year from now would show "you
answered Jane Q. Doe, and the correct answer is John R. Roe" for a question
they got *right* the day they answered it — which is not a debrief, it is
the product quietly telling a learner they used to know something they
still know, that they no longer know it.

So `answer_snapshot` freezes, at grading time, exactly what the learner was
graded against — **the shape below is the shipped one**
(`practiceAnswerSnapshotSchema`, `apps/api/src/practice/dto/practice-attempt.dto.ts`),
not the illustrative sketch an earlier draft of this document carried; §15
records the rename:

```json
{
  "resolvedAt": "2026-06-01T14:03:00.000Z",
  "answerResolution": "resolved",
  "resolvedForStateCode": null,
  "answers": [
    {
      "id": "…",
      "text": "Jane Q. Doe",
      "sort": 0,
      "stateCode": null,
      "verifiedAt": "2026-05-01T00:00:00.000Z"
    }
  ]
}
```

`answers` is the **entire** array §5's `selectAnswers` returned at that
moment — every simultaneously-correct alternative for a `none`-scope
question, or the single current row for a `national`/`state`-scope one —
not only the one the learner happened to match, because a debrief showing
"you said X; Y and Z were also accepted" is real information a single
matched answer discards. **`matchedAnswerId`/`matchedAnswerText`/`rule` are
deliberately NOT stored here** — see §15: they are `matchAnswer`'s return
shape (§7), reported once on the graded-attempt response, and recoverable
forever by re-running the pure `matchAnswer` over `responseText` and this
frozen `answers` list, so persisting them a second time would be a value
computable from data already on the row. `answerResolution` records
civics-content.md §5's `state_required` case too: an attempt against a
`state`-scope question with no state set at the time is `incorrect`/`skipped`
with an empty `answers` array and `answerResolution: 'state_required'`, so a
debrief can say "you hadn't set your state yet" rather than "there was no
correct answer to this question," which would be a lie about the question,
not an honest account of what the learner's profile allowed at the time.
`resolvedAt` is the instant resolution ran (`Clock.now()`), kept inside the
document so a reader holding only this JSON can say which moment's answers
these were without also holding the enclosing row.

`answer_snapshot` is a plain `Json` column, the same convention
`SystemSettings.value`/`UserSettings.value`/`practice_sessions.summary`
already use — a document with a stable shape this document defines, not a
normalized set of columns, because it exists to be *read back whole* by a
debrief screen, never queried or filtered on its internal fields.

---

## 7. Deterministic grading: the normalisation pipeline

E3's entire grading path is one pure module,
`apps/api/src/practice/answer-matching.ts` (issue #70) — already written,
already tested, and cited throughout this section by exact behaviour rather
than by intent. It exports `normalizeAnswer(text)` and
`matchAnswer(response, acceptedAnswers)` — no Nest, no Prisma, no database,
**no import statement at all** — the identical shape
`test-version-resolution.ts` and `answer-resolution.ts` already establish
for a rule that must never drift and must be testable directly, table of
cases and all. This module constructs no `Date` and needs none; it is a
string function, and the same input yields the same output forever, which
is what lets a practice attempt be re-graded (§9) or audited months later
and reach the identical verdict.

`normalizeAnswer` applies these seven steps, **in this order, and the order
is the contract**:

| # | Step | Input → output (worked example) |
|---|---|---|
| 1 | Unicode NFKC normalise, then lowercase, then trim. | `"Ｕ.S.A"` → `"u.s.a"` (full-width characters collapse to ASCII before anything else runs; NFKC also folds ligatures and the several Unicode space characters an IME can produce) |
| 2 | Strip a leading filler opening, re-applied up to four passes. | `"i think it is the constitution"` → `"the constitution"` (`"i think"` strips on pass one, exposing `"it is"` for pass two) |
| 3 | Strip a trailing possessive (`'s` / `’s`, both apostrophe forms), then convert every non-letter/non-digit character — punctuation and hyphens alike — to a space and split into tokens. | `"speaker's role, twenty-seven!"` → tokens `["speaker","role","twenty","seven"]` |
| 4 | Expand abbreviations, whole-token/whole-phrase only, in one left-to-right pass that never rescans its own output. | `"potus"` → `"president"`; `"i live in dc"` → `"i live in district of columbia"` |
| 5 | Drop leading articles (`a`, `an`, `the`) — every consecutive one at the very start of the token list. | `["the","president"]` → `["president"]` |
| 6 | Rewrite every maximal run of number words/ordinals to one digit token, composing units + tens + `hundred` the way English does (not a 1–100 lookup table). | `"twenty-seven"` → `"27"`; `"first"` → `"1"`; `"twenty first"` → `"21"` |
| 7 | Re-join the surviving tokens with single spaces. | free by construction — the token list can carry no empty entries, so joining cannot produce a run or an edge space |

**Step 2's exact filler list, longest-first, is nine patterns, not seven
loosely described ones** — verified against `LEADING_FILLERS` in the source
file: `"the answer is"`, `"my answer is"`, `"i think it's"` / `"i think
its"` (both spellings — see below), `"i think"`, `"answer:"`, `"it is"`,
`"it's"`, `"its"`. Every pattern requires a following whitespace character,
so none can fire mid-string and none can swallow a whole short answer. Two
details are load-bearing, not incidental:

- **Both apostrophe characters are matched** (`'` U+0027 and `’` U+2019),
  because step 1's NFKC pass does **not** unify them — a phone keyboard's
  smart quote survives normalisation untouched, and a rule written for only
  the ASCII apostrophe would silently fail on a large share of mobile input.
- **`"its"` (no apostrophe) is treated as filler too, a known, accepted
  collision.** "Its" and "it's" are both real English strings, so an answer
  that genuinely opens with the possessive pronoun "its ..." would lose its
  first token. The file's own comment states the trade explicitly: no
  accepted civics answer begins with a possessive pronoun, while "it's the
  Constitution" is an extremely common way to answer, so this rule is
  worth the one collision it accepts.

**Step 3's possessive strip deletes rather than spaces**, and that
distinction is what makes it correct: `"president's"` must become
`"president"`, not `"president s"` with a stray token nothing on the other
side of a comparison would have. The general punctuation rule that follows
*does* space (rather than delete) — hyphens included — which is the specific
mechanism that lets `"twenty-seven"` reach step 6 as two separate,
recombinable tokens instead of the single unsplittable token `"twentyseven"`
deleting the hyphen would produce.

**Step 4's table is a fixed, listed set, not a general abbreviation
detector**: `president of the united states` → `president`; `u s a` → `united
states`; `u s` → `united states`; `d c` → `district of columbia`; `usa` →
`united states`; `us` → `united states`; `dc` → `district of columbia`;
`potus` → `president`. Two properties of how the table is applied are load-
bearing:

- **Whole-token/whole-phrase only, never substring.** A naive
  `.replace('us', 'united states')` over raw text would turn `"houses"` into
  `"hounited statesnes"`. Because step 3 has already split the input into
  discrete tokens, the replacement can only ever match a token (or an exact
  run of tokens) in full.
- **`us` colliding with the English pronoun "us" is a known, accepted
  trade**, exactly like step 2's `"its"` collision: on a naturalization
  civics test, `us`-as-country is overwhelmingly the intended reading, and
  leaving `"the U.S."` unmatched against `"the United States"` was the
  headline bug issue #70 was filed to fix. The alternative — dropping the
  rule to protect a pronoun usage that essentially never occurs among these
  100–128 questions' accepted answers — fails the common case to guard
  against one that does not arise in this domain.

**Step 6 runs both directions because the accepted answer is normalised
through the identical function.** A `civics_answers` row storing
`"twenty-seven"` and a learner typing `"27"` both normalise to `"27"`; a row
storing `"27"` and a learner typing `"twenty-seven"` normalise to the same
value from the other side — there is no separate "canonical accepted form"
kept anywhere; one function runs over both strings. The scanner enforces two
ordering guards so it cannot invent a value out of word salad: a units word
may only add onto a multiple of ten (`"twenty seven"` is `27`, but `"seven
seven"` stays two separate `7`s), and a tens word may only open a fresh
hundreds group (`"seven twenty"` is `"7 20"`, not `27`). An ordinal always
ends the run it appears in, because English ordinals are terminal —
`"twenty first"` is one number, `"first twenty"` is two.

### 7.1 `matchAnswer`

```ts
interface AcceptedAnswer {
  readonly id: string;
  readonly text: string;
}

type MatchRule = 'exact' | 'normalized';

interface AnswerMatch {
  outcome: 'correct' | 'incorrect';
  matchedAnswerId: string | null;
  matchedAnswerText: string | null;   // the answer's ORIGINAL text, never normalised
  rule: MatchRule | null;
}

function matchAnswer(
  response: string,
  acceptedAnswers: readonly AcceptedAnswer[],
): AnswerMatch;
```

`AcceptedAnswer` is deliberately narrower than a `CivicsAnswer` row — only
`id` and `text`, because that is the entirety of what grading needs. Whoever
calls `matchAnswer` (the not-yet-written practice service) is responsible
for first resolving the question's currently-correct rows through
`civics/answer-resolution.ts` (§1) and passing only their `id`/`text` pairs
in; building the fuller `answer_snapshot` (§6) — with `sort`, `stateCode`,
and the rest — is that caller's job, done from the same resolved rows,
never from `matchAnswer`'s own return value.

**The two passes run completely separately — every accepted answer checked
for an exact match before any is checked for a normalised one — and that
ordering is deliberate, not an optimisation.** A question with accepted
answers `"the President"` and `"President"` would, in a single fused loop
that checked each accepted answer both ways in turn, report a learner who
typed `"President"` verbatim as a `normalized` match against `"the
President"` if that row happened to be checked first — the wrong answer id
*and* the wrong rule, purely as an accident of how the content was seeded.
Two full passes make the reported `rule` a fact about the learner's
response, never a fact about row order.

1. **Pass 1 — `exact`.** The response, trimmed, equals some accepted
   answer's text, also trimmed, compared **case-sensitively** with no
   normalisation applied at all.
2. **Pass 2 — `normalized`.** `normalizeAnswer(response)` equals
   `normalizeAnswer(acceptedAnswer.text)` for some accepted answer — checked
   only if no exact match was found in pass 1.
3. **No match** — `{ outcome: 'incorrect', matchedAnswerId: null,
   matchedAnswerText: null, rule: null }`.

**What this function does NOT do, by design, not by omission:** no edit
distance, no similarity score, no substring containment, no "starts with,"
no token-overlap ratio. A response that is merely *close* to an accepted
answer — one letter off, a plausible misspelling, a near-miss paraphrase —
is `incorrect`, full stop. Substring containment in particular fails in both
directions at once: `"not the president"` contains `"the president"`;
`"Washington"` is contained by both `"George Washington"` and `"Washington,
D.C."`, answers to two different questions. There is no threshold that makes
either safe, so there is no threshold — the near-miss this leaves on the
table is exactly the seam E4 exists to occupy (§8), and blurring it here
would leave two different, uncoordinated notions of "close enough" competing
inside the same codebase.

**Degenerate input never throws, and is checked before either pass runs.**
A non-string, an empty or whitespace-only response, or a response whose *raw*
length exceeds `MAX_RESPONSE_LENGTH` (2000 characters — checked before any
regex touches the string, so the bound cannot itself be the expensive part)
all return `incorrect` immediately. One more edge case worth naming: a
response that normalises to the **empty string** (e.g. the response was
nothing but filler and punctuation — `"it's..."` on its own) is also treated
as no match, even if some pathological accepted-answer row also normalised
to empty; two empty strings are not allowed to "agree." A `matchAnswer` call
is never the thing that turns a malformed client request into a 500.

---

## 8. `partial` and `grading_method: 'ai'` — declared now, unreachable until E4

Two values exist in this epic's enums that **E3's own grading path never
produces**:

- **`outcome: 'partial'`** — a judgment call no deterministic function in
  this document is capable of making. Exact-match-plus-normalisation is
  binary by construction: a response either equals an accepted answer
  (after normalisation) or it does not. "Partially correct" requires
  weighing a response's *meaning* against a multi-part or nuanced accepted
  answer — precisely the semantic-grading capability ROADMAP §3 assigns to
  E4's Evaluator role. Declaring it now, rather than adding it as a
  migration once E4 exists, follows the exact reasoning §4 gives for the
  three unwired session kinds: an enum value added after real rows exist
  under the old, narrower set is a migration over live data; declaring the
  full closed set from the start, unreachable until its producer ships,
  costs nothing.
- **`gradingMethod: 'ai'`** — the seam epic #52 names directly: "AI grading
  arrives in E4." `apps/api/src/practice/answer-matching.ts`'s
  `matchAnswer` is deliberately the **entire** grading decision E3 makes;
  E4's contribution is a *second* grading path, called only when the
  deterministic one returns `incorrect` and a caller's AI is available
  (`AiDispatchService.run(userId, 'grader', …)`, per ROADMAP §7's single
  dispatch door), producing its own `outcome` (`correct` | `partial` |
  `incorrect`) with `gradingMethod: 'ai'`. **E3 changes nothing about this
  document's schema or `matchAnswer`'s contract to make that possible** —
  the epic body states the intended shape precisely: "E4 changes one
  function rather than introducing the whole surface at once." The one
  function it changes is the grading *orchestration* the practice module
  calls (deterministic first, AI as a fallback the caller may or may not
  have configured) — never `matchAnswer` itself, which stays exactly the
  seven-step, no-fuzzy-matching pipeline in §7 forever, because that is the
  one part of grading this product commits to being fully explainable with
  no model in the loop at all.

A learner with no BYOK key, or whose administrator has not bound the
`grader` role, sees exactly E3's behavior today: an incorrect deterministic
match stays `incorrect` unless the learner self-marks it (§9). That is the
concrete meaning of ROADMAP §4's "Deterministic before AI" — the practice
loop this epic ships is not a preview of E4, it is a complete, correct
product on its own, and E4 only ever makes an `incorrect` verdict *more
lenient*, never the reverse.

### 8.1 What `grading_method` is for a `skipped` attempt

§2.2 flags this as a fact the shipped schema settles that the issue text
left open: `grading_method` is `NOT NULL` on every row, `skipped` outcomes
included, so "no grading was attempted" is not a state the column can
represent with its own value the way a nullable column would let it. This
document resolves the apparent tension by reading `grading_method` as
answering a slightly different question than "did grading happen" — it
answers **which decision-maker's verdict produced this row's `outcome`**.
E3's own deterministic pipeline is that decision-maker for every attempt it
creates, and deciding "this attempt has no response to grade, so the
outcome is `skipped`" is itself a decision the pipeline makes, in exactly
the same sense that deciding "this response matches no accepted answer, so
the outcome is `incorrect`" is. Both are `grading_method: 'exact'`. `'self'`
and `'ai'` are reserved for the two cases where a *different* verdict —
the learner's own claim, or a model's judgment — overrides or supplies what
the deterministic pipeline alone could not: self-mark (§9) upgrades an
`incorrect` or `skipped` result to `correct`, and E4's grader (§8) will supply its own
`outcome` when the deterministic pipeline's is `incorrect` and a caller's AI
is available. Neither of those two cases has anything to say about a skip —
a learner who skips has given nothing for either a self-mark or an AI
grader to evaluate — so a skipped attempt's `grading_method` is always
`'exact'`.

---

## 9. Self-mark: a first-class outcome, discounted by E5

**Locked decision #3** (epic #52): self-mark is not a UI convenience
layered over the "real" grading path — it is a first-class `outcome`
transition, recorded with `grading_method = 'self'`, and it is **discounted**
by E5's mastery rule.

The need for it is a direct consequence of §7's own stated limits.
`matchAnswer` will never accept a real paraphrase, a plausible synonym, or a
response that is unambiguously correct in substance but happens to be
worded in a way this epic's seven normalisation steps do not anticipate —
that is what "no edit distance, no similarity score" in §7 costs a learner
who genuinely knew the answer. Without an escape hatch, that learner is
told they are wrong when they are not, on a product whose entire premise is
building accurate confidence toward a real interview. `VISION.md`'s
tone rules already forbid condescension; grading a correct learner as wrong
with no recourse is a harsher failure than a tone problem.

**The mechanism actually shipped as a distinct route performing a genuine
update against an already-persisted row — §15 records this as a reversal of
this document's original design, which is preserved below only as the
reasoning self-mark still has to satisfy, not as a description of the
shipped code:**

1. The learner answers (or skips) a question through the ordinary
   `POST .../attempts` call (§10). That call is the **only** place grading
   happens and the **only** place a `practice_attempts` row is created — it
   always writes something, `incorrect` or `skipped` included, because an
   attempt that produces no row is not evidence at all (§15). There is no
   side-effect-free "check" call ahead of it: a learner who disagrees with
   the verdict is disagreeing with something already on the record, not
   something floating unwritten in a request/response pair.
2. If that attempt came back `incorrect` or `skipped`, the client may reveal
   the accepted answer to the learner and, having revealed it, call
   `POST .../attempts/:attemptId/self-mark` (§10) — a **second, distinct
   route**, naming the exact attempt it acts on. This route performs the one
   mutation this table permits: it flips that row's `outcome` to `'correct'`
   and its `gradingMethod` to `'self'`. It refuses (409) unless `revealed`
   is already `true` on the row, for the reason given below, and refuses
   (400) an attempt already `'correct'` by `'exact'` — self-mark can only
   ever upgrade an `incorrect` or `skipped` verdict, never relitigate a
   match the deterministic pipeline already accepted, because overwriting
   `'exact'` with `'self'` would downgrade verified evidence to a learner's
   own claim. It is **idempotent**: calling it again on an
   already-self-marked attempt returns the same row unchanged.

`practice_attempts` still carries no `updatedAt` column, and is still, in
every ordinary sense, evidence of something that already happened — the two
columns this one route is permitted to move are the single, narrow exception
that exists specifically so `gradingMethod: 'self'` can be recorded as its
own distinguishable fact forever, not a general-purpose mutation surface.
§15 explains why this shape won out over the single-write design below.

Revealing before self-marking is required for the identical reason
regardless of which call carries the flag: self-mark is the learner
asserting "I said the right thing, the matcher just didn't recognize it,"
and that assertion is only checkable by the learner against the actual
accepted answer, not against their own unaided memory of what they think
the answer probably was.

**Why it is `outcome: 'correct'`, not a fourth outcome value of its own.**
A self-marked attempt genuinely *is* a correct answer from the product's
point of view going forward — it counts toward "how many questions has this
learner gotten right" the same way an exact match does. What distinguishes
it is not whether it counts, but **how much it should count**, which is
exactly what `grading_method` records for a downstream reader to weigh.
Inventing a `self_correct` outcome value instead would force every reader
that only cares about "was this right" (a summary screen's tally, for
instance) to enumerate two outcome values for one concept, for no benefit
over reading one boolean-shaped fact (`outcome`) and one provenance fact
(`grading_method`) independently — the identical two-independent-facts
argument `docs/specs/ai-settings.md` §5 makes for `userKeyConfigured` and
`systemReady` rather than one merged flag, applied here to "was it right"
and "how do we know."

**Why E5 must discount it, and what this document commits to on that
point.** journey-shell.md §1 states the `remembering` stage's own entry
condition in exactly these words: "A question has been verified as
mastered — correct on 3 or more distinct days," and ROADMAP §4 restates the
underlying rule from `VISION.md`: mastery must be *verified*, not
*assumed*. A self-marked attempt is, definitionally, the one point in this
whole evidence table where the system is trusting the learner's own
judgment in place of an independent check — the exact thing "verified, not
assumed" rules out treating as equal-weight evidence. This document
therefore locks the **fact** that `grading_method = 'self'` must never
receive the same weight in E5's mastery computation as `grading_method =
'exact'` or `grading_method = 'ai'`, without locking E5's exact formula for
*how much less* — that number belongs to E5's own design (#54), which has
the mastery model in front of it and this document does not. What is fixed
here, and must not move without reopening this decision at the epic level,
is that `grading_method` is present on every graded attempt specifically so
E5 has the fact to discount *against*; an E5 implementation that computed
mastery straight from `outcome` alone, blind to `grading_method`, would
silently violate this decision the day it shipped, with nothing in the
schema to catch it.

### 9.1 Interaction with `revealed` and `hint_used`

`revealed` and `hint_used` are independent booleans, not states on a
ladder, and both can be true on the same attempt (a learner takes a hint,
still cannot answer, and reveals). Neither one *by itself* changes
`outcome` or `grading_method` — revealing what the accepted answer was does
not, on its own, retroactively make a response correct; only an explicit
self-mark decision does that (§9), and only once revealing has already
happened. A learner who reveals but does **not** self-mark, having typed no
response at all, gets exactly §8.1's default: `outcome: 'skipped'`,
`gradingMethod: 'exact'`, `revealed: true` — seeing the answer without ever
producing or claiming one is not evidence of recall in either direction,
and recording it as `incorrect` would overstate what actually happened
exactly as much as recording it `correct` would understate the learner's
non-attempt.

---

## 10. API surface (design level)

Every route is `@Auth()` with **no permission**, resolving the caller from
`@CurrentUser('id')` — the identical posture `journey.controller.ts` and
every per-user AI route already take, for the identical reason: a learner's
own practice history is exactly as private, and exactly as unconditionally
theirs to act on, as their own learner profile or their own AI key. No route
accepts another user's id, ever.

**No `POST .../questions/:questionId/check` route** — an earlier draft of
this table specified one; §15 records why the shipped design has no
side-effect-free pre-check at all.

| Method + path | Notes |
|---|---|
| `POST /api/practice/sessions` | Body: `kind` (`quick` \| `category` only — §4), `categoryId?` (required iff `kind: 'category'`), `plannedCount?` (integer, 1–20, default 5 — clamped down to the questions actually available, §2.1). Closes any existing `in_progress` session for the caller first (§5), resolves `testVersionCode` from the caller's own `learner_profiles` row, and creates the new one, returning it with its first question (prompt only) and `progress: { answered: 0, planned }`. |
| `GET /api/practice/sessions` | Paginated, `page`/`pageSize` per `AllowlistController`'s convention, newest first — the "recent sessions" list. Each row adds live `answeredCount`/`correctCount` counted from the attempt rows, not from the stored `summary`, so an abandoned session still reports what it actually answered. |
| `GET /api/practice/sessions/:id` | One session, every attempt recorded against it, and — while still `in_progress` with attempts remaining — the next unanswered question (prompt only) and `progress`. Ownership-checked, not permission-checked — the `storage_objects` posture (`CLAUDE.md`'s RBAC section): every authenticated user may read their own, and a `PermissionsGuard` here would reject the ordinary case. **A session belonging to another learner is a 404, not a 403** (§15). |
| `POST /api/practice/sessions/:id/attempts` | Body: `questionId`, `responseText?`, `skipped?` (default `false`), `revealed?` (default `false`), `hintUsed?` (default `false`), `durationMs?`. **No `selfMarkCorrect` field, and none is ever accepted here** — §15 records why self-mark moved to its own route below. Re-runs `matchAnswer` server-side (never trusts a client-reported verdict) and writes exactly one `practice_attempts` row — `outcome`, `gradingMethod: 'exact'`, `revealed`, `hintUsed`, `answerSnapshot`, `answeredAt: Clock.now()`. One attempt per question per session: a repeat is a 409. Returns `{ attempt, acceptedAnswers, nextQuestion, progress }` — the accepted answers are shown here for the first time, earned because the attempt is already recorded, and frozen into the same response's `attempt.answerSnapshot`. |
| `POST /api/practice/sessions/:id/attempts/:attemptId/self-mark` | No body. Flips a recorded `incorrect` or `skipped` attempt to `outcome: 'correct'`, `gradingMethod: 'self'` (§9). Refuses (409) unless the attempt's `revealed` is already `true`; refuses (400) an attempt already `correct` by `'exact'`. Idempotent — a second call on an already self-marked attempt returns it unchanged. **A distinct route on purpose** (§15): it keeps `gradingMethod: 'self'` permanently distinguishable from `'exact'`, and nesting it under the owner-resolved session means the attempt id can never be probed on its own. |
| `POST /api/practice/sessions/:id/complete` | Sets `status: 'completed'`, `completedAt`, and computes `summary` (§2.1) from the session's own attempts. Refuses (409) a session that is `abandoned`. **Idempotent** — completing an already-completed session returns the stored summary unchanged and does not move `completedAt`. |

**No new audit action.** Unlike an admin settings write or a role change,
an ordinary practice attempt is routine product usage, not a privileged or
security-relevant action — the same reasoning that keeps `ai_usage_events`
outside the `audit_events` table entirely (docs/specs/ai-settings.md §9):
usage is recorded because a later reader needs the data, not because
anyone needs to explain *who was allowed* to produce it.

---

## 11. The `Clock` rule, restated for this epic

Every timestamp this epic writes — `practice_sessions.startedAt` /
`completedAt`, `practice_attempts.answeredAt` — comes from `Clock.now()`,
injected, never a bare `new Date()`. This matters concretely, not only as
house style: E5's "correct on 3 or more distinct days" rule and E7's streak
computation both read `answeredAt` to determine which learner-local calendar
day an attempt falls on, and both need a Playwright spec (per ROADMAP §7)
that can advance the clock a day via `X-Test-Clock` without sleeping in
real time to prove a multi-day rule works at all. `apps/api/src/journey/`
already holds to this with a `grep` for a bare `Date` construction that
returns nothing, comments included; this epic's `practice` module is
expected to pass the identical check.

---

## 12. Web: `/practice` is superseded, not replaced from a blank page

E1 shipped `/practice` as a real, mounted, non-redirecting route
(journey-shell.md §2.3) carrying the designed empty state in
`apps/web/src/pages/PracticePage.tsx` — "This is where you'll answer
questions out loud or in writing and get real feedback... There's nothing
to practice here yet." This epic replaces that component's contents with
the real destination (Quick 5, by category, recent sessions), the same
**superseded, not deleted-and-forgotten** relationship civics-content.md §8.1
records for `LearnPage.tsx` when E2 landed on top of E1's `/learn` stub.

**`interview_countdown` re-points to `/practice`**, per `next-action.ts`'s
own header comment anticipating this exact epic. `NEXT_ACTION_PATHS` gains
`practice: '/practice'`, `NextActionKind` widens by exactly the one member
epic #52 and journey-shell.md §4 both name (`practice`), and
`recommendNextAction`'s branch 2 (an unexpired interview date) changes its
`path` from `NEXT_ACTION_PATHS.interview_countdown` (still `/learn`) to
`NEXT_ACTION_PATHS.practice` — never a change to `explore`, which keeps
pointing at `/learn` exactly as it does today, since "the learning and
practice tools are on their way" is only half-true once E3 ships and the
copy for that branch is E3's to update alongside the path. This follows
journey-shell.md §4.1's structural rule to the letter: one more hardcoded,
verified path added to the same closed mapping, never a caller-supplied or
assembled string.

---

## 13. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Two tables — `practice_attempts` and `interview_attempts` — instead of one table plus `source`** | Every downstream reader that needs a learner's *complete* answer history (E5's mastery, E6's readiness) would need a `UNION` on every query, forever, and the two schemas would have to be kept column-compatible by convention rather than by construction. §3. |
| **An `isCorrect` boolean instead of the `outcome` enum** | Cannot express `skipped` (never attempted) or `partial` (E4's semantic near-miss) without a second column that duplicates part of what the boolean already claims to answer, and a boolean plus a "why" column is exactly the two-facts-in-one-field problem `docs/specs/ai-settings.md` §5 already rejects for `ready`. §8, §9. |
| **Recomputing accepted answers at read time instead of storing `answer_snapshot`** | A dynamic answer's `text` changes over time by design (civics-content.md §4); recomputing "was this correct" against **today's** current answer would silently re-grade a learner's past attempt every time the underlying fact changes, telling them they used to know something they still know. §6. |
| **Levenshtein or another fuzzy/similarity match in `matchAnswer`** | A near-miss is exactly the case E4's semantic grader exists to judge with actual understanding of *why* a response is close — a distance threshold picked without that understanding either accepts real errors (a misspelling that happens to also be a different, wrong answer) or rejects real near-correct answers arbitrarily, and it would compete with E4's grader for the same judgment call with no coordination between the two. §7, §8. |
| **A `self_correct` outcome value instead of `outcome: 'correct'` + `gradingMethod: 'self'`** | Forces every reader that only needs "was this right" to enumerate two outcome values for one concept, when "was it right" and "how do we know" are independent facts a summary tally and E5's mastery weighting each read for a different purpose. §9. |
| **Adding `outcome: 'partial'` and `gradingMethod: 'ai'` only when E4 ships, via a migration** | Costs a migration over every attempt row already written by then, for values that cost nothing to declare now and stay simply unreachable until their producer exists — the identical trade-off `docs/specs/ai-settings.md` decision #1 already makes for the four unwired AI model roles. §8. |
| **A cron sweeping stale `in_progress` sessions to `abandoned`** | ROADMAP §7's "No job queue" rule: scheduling and recompute run synchronously, inside the request that produces the evidence. A new session start is the moment "this one was not going to finish" actually becomes knowable; a timer guesses at a fact the next real session start already proves. §5. |
| **A `paused` session status distinct from `in_progress`** | Nothing downstream (a summary, a mastery input, a readiness input) needs the distinction — an abandoned session's real attempts are evidence regardless of why the learner left, and a fourth status would be a state with no reader. §5. |
| **Requiring `session_id` non-null on every `practice_attempts` row** | Would force E8's mock-interview attempts to reference a `practice_sessions` row that means nothing to an interview flow, purely to satisfy a `NOT NULL` constraint this table's other producer has no honest value for. §2.2. |
| **Self-mark reachable without first revealing the accepted answer** | Turns self-mark into "mark myself correct because I want to be," with nothing checking the claim against the actual accepted answer the learner is asserting they matched. §9. |
| **Recording `duration_ms: 0` when a client cannot report a duration** | `0` is a claim — a false one, that the learner answered instantly — for the identical reason `ai_usage_events`' token columns are nullable rather than defaulting to zero on a failed call. §2.2. |
| **A `PATCH`-style endpoint that mutates an already-persisted attempt for reveal and self-mark — this document's ORIGINAL decision, since reversed** | Rejected here on the reasoning that `practice_attempts` has no `updatedAt` column and its schema comment calls it an immutable record. **§15 records that the shipped implementation does exactly this** for self-mark alone — a narrowly-scoped, distinct-route update of `outcome`/`gradingMethod`, not a general PATCH — because the alternative (folding self-mark into the same write that creates the attempt) required a side-effect-free "check" call ahead of it, which itself conflicts with "an attempt that is not written is not evidence." Kept here, struck through in spirit rather than deleted, so a reader sees the reasoning this decision had to overcome, not just its outcome. §9, §10, §15. |
| **A nullable `grading_method`, so a `skipped` attempt could record "no grading happened"** | The shipped column is `NOT NULL`; reconciling that fact with a skip is this document's job (§8.1), and reading `grading_method` as "which decision-maker's verdict produced this outcome" rather than "did grading occur" answers it without needing a schema change the migration has already foreclosed. §8.1. |
| **A database-level partial unique index on `practice_sessions(user_id) WHERE status = 'in_progress'`** | Not what the shipped migration does — verified directly against its SQL, which defines only two ordinary indexes. The application-level check in the create-session flow is cheaper to have shipped in the same migration and closes a narrow, low-consequence race (§5) well enough for E3; nothing in this document rules out adding the index later as a tightening, and doing so would not change any contract this document promises. §2.1, §5. |

---

## 14. Out of scope (deliberately)

Epic #52's own text names these explicitly; restated here so a later reader
does not mistake a silence in this document for an oversight:

- **Semantic grading and AI-generated explanations.** E4 (#53) is the first
  epic that dispatches to a model at all in this product. §8 is the seam;
  nothing in this document's schema or `matchAnswer` contract is designed
  to change when E4 lands.
- **Spaced repetition and the review queue.** E5 (#54) owns
  `question_mastery` and the scheduling logic behind `review`/`weak`/`mixed`
  session kinds (§4). This document only declares the enum values E5 will
  eventually produce.
- **Readiness scoring.** E6 (#55) reads `practice_attempts` as one of its
  inputs; nothing in this epic computes a readiness number of any kind.
- **Streaks and the daily goal.** E7 (#56) reads `practice_attempts` and
  `practice_sessions.plannedCount` as inputs; this epic writes the rows,
  it does not compute engagement metrics over them. ROADMAP §7's
  "Engagement never moves readiness" rule already keeps this separation
  structural once E6 and E7 both exist.
- **Spoken answers.** `inputMode: 'spoken'` and `promptMode: 'heard'` are
  declared columns with no producer until E9 (#58). Nothing about
  microphone capture, transcription, or audio playback is this epic's
  concern.
- **Mock interview grouping.** `source: 'mock_interview'` is a value this
  table's enum accepts; the interview flow that ever writes it, and
  whatever grouping concept replaces `session_id` for that flow, is E8's
  (#57) design, not this document's.

---

## 15. Divergences from this design, as shipped

Issue #87 requires this document reconciled against `PracticeController`,
`PracticeService`, and the `practice` DTOs as they actually shipped (issue
#73), and every place they disagree recorded with the reason — not silently
edited over. This section is that record; the inline notes elsewhere in this
document ("§15 records...") point back here rather than restating it. Every
row below was checked directly against the shipped source, not against the
issue text.

| This document said | What shipped | Why the shipped design is right |
|---|---|---|
| §10: `POST /api/practice/sessions/:id/questions/:questionId/check` — a side-effect-free pre-check, called before an attempt exists, so a learner could see a verdict without anything being written. | **No such route exists.** The only way to see a grading verdict is `POST .../attempts` (§10), which grades **and writes** in the same call. There is no way to probe a question's answer without producing an evidence row. | This is issue #73's own specified design, not an omission: "flips a recorded `incorrect` to `correct`" presumes the attempt is already recorded. It is also the better design on this document's own terms — an attempt that is not written is not evidence, and a callable-any-number-of-times "check" endpoint would let a learner probe the same question repeatedly (learning the accepted answer by trial and error) with no record of having done so at all, which is worse for the exact mastery-verification goal §9's discounting argument exists to protect. |
| §9: self-mark folds into the **single** write that creates the attempt, via a `selfMarkCorrect` flag on `POST .../attempts`, specifically because `practice_attempts` has no `updatedAt` column and a later mutation would contradict its immutability. §13 rejected a "PATCH-style endpoint that mutates an already-persisted attempt" on that basis. | Self-mark is `POST /api/practice/sessions/:id/attempts/:attemptId/self-mark` — a **second, distinct route**, called after the fact, that performs an actual `UPDATE` on the already-persisted row (`outcome` → `'correct'`, `gradingMethod` → `'self'`). §9 and §10 are rewritten above to describe this. | The single-write design depended on the "check" route above existing (step 1 of the original §9 mechanism), which did not ship, for the reason in the row above. Once grading always writes immediately, self-mark can only ever be a decision made about an *existing* row, so it has to be a second call. Making it a **separate route** rather than a field on a generic "update attempt" endpoint is deliberate, not incidental: it keeps `gradingMethod: 'self'` structurally distinguishable from `'exact'` forever — there is no field a future edit could widen into a general attempt-mutation surface, only this one named, narrowly-scoped transition, gated on `revealed` and refusing to downgrade an `'exact'` match. This is worth stating plainly because it reverses this document's own §13 entry, not because the original reasoning about immutability was wrong: the table is still immutable in every sense except this one, named exception. |
| §6: `answer_snapshot`'s illustrative shape used `questionId`, `resolutionStatus`, `acceptedAnswers`, `matchedAnswerId`, `matchedAnswerText`, `rule`, `normalizedResponse`. | The shipped `practiceAnswerSnapshotSchema` uses `resolvedAt`, `answerResolution`, `resolvedForStateCode`, `answers` (each `{ id, text, sort, stateCode, verifiedAt }`) — **and stores no `matchedAnswerId`/`matchedAnswerText`/`rule` at all.** §6 is rewritten above with the real shape. | Field names aside, the substantive change is dropping the matched-answer identity and rule from the stored document. Both are recoverable exactly, at any time, by re-running the pure `matchAnswer` over the attempt's own `responseText` and this frozen `answers` list — the matcher takes no clock, no database, and no configuration, so it returns the same verdict forever. Freezing the *inputs* to a deterministic function is what makes storing its *output* a second time redundant; the verdict the product actually queries on lives in the row's own `outcome`/`gradingMethod` columns, not inside the JSON document. |
| §10: `POST /api/practice/sessions` did not list `plannedCount` as an accepted body field. | The shipped body accepts an optional `plannedCount` (integer, 1–20, default 5), clamped down to the questions actually available for the selection. §10 is corrected above. | An omission from an earlier pass, not a design change — `MAX_PLANNED_COUNT` and the clamping behavior are real and load-bearing (they are what keeps "4 of 5" on the summary screen honest per §2.1), simply not previously reflected in the endpoint's own row. |
| §10: `POST .../attempts` was described as returning "the created attempt" and refusing (409) whenever the session was "not `in_progress`"; `POST .../complete` was described as refusing (409) any session that was "not `in_progress`" (which would include an already-`completed` one). | `POST .../attempts` returns `{ attempt, acceptedAnswers, nextQuestion, progress }`. `POST .../complete` is **idempotent** on an already-`completed` session (returns the stored summary unchanged, does not move `completedAt`) and refuses (409) only an `abandoned` one. §10 is corrected above for both. | The richer attempts response is what makes one round trip carry the graded verdict, the accepted answers, and the next question together — exactly the "immediate feedback" epic #52 asks for, without a second request. Idempotent completion matters because a retried request (a flaky connection, a double-tap on a "finish" button) must not become an error the learner has to interpret; treating a second `complete` call as a failure would punish a client for something the client could not have known was redundant. |

No divergence was found in §7's normalisation table: every step, its order,
the nine-entry filler list, the eight-entry abbreviation table, and the
number-word scanner's ordering guards were checked line-by-line against
`apps/api/src/practice/answer-matching.ts` and match exactly, including the
two load-bearing orderings the module's own comments call out (filler
stripped before punctuation; abbreviations expanded after tokenization).
§2's table descriptions of the shipped columns, nullability, and indexes
were likewise re-checked against `apps/api/prisma/schema.prisma` directly
and found accurate as written.
