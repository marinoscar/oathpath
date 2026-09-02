# Design Spec: Civics content (versioned question bank, dynamic answers)

This is the durable design for E2 — the versioned, provenance-tracked USCIS
civics question bank both test versions read from, the dynamic-answer
lifecycle that keeps "who is the Speaker of the House" correct without ever
rewriting history, and the read/admin API surfaces built on top of it. An epic
and its child issues link here instead of restating the design — read this
first, then the issue you were sent to implement.

Source of truth for every claim below:

- `apps/api/prisma/schema.prisma` — `CivicsTestVersion` and `LearnerProfile`
  (both shipped by E1; the tables this epic's tables hang off of), the
  `Notification` model's comment on the partial index Prisma cannot express
  declaratively (the same limitation §3 below runs into), `Credential` and
  `AuditEvent` (the `@db.Uuid` / `@map` / `@db.Timestamptz` conventions a new
  table follows), and `JourneyStage`'s enum declaration (the house shape for a
  small, closed, Postgres-enforced set).
- `apps/api/prisma/migrations/` — verified empty of any partial-index
  precedent today (`grep -rl "WHERE" */migration.sql` returns nothing); the
  index in §3 is the first hand-written migration statement in this
  repository, not a pattern already in use elsewhere.
- `apps/api/src/journey/journey-stages.ts` — the registry idiom (one
  API-owned declaration, read by the web over an endpoint, never duplicated)
  and its compile-time proof technique, both of which recur below for a
  different set.
- `apps/api/src/journey/test-version-resolution.ts` — "the cutoff date
  appears exactly once, and it is here": the pattern of putting a rule that
  must never drift into one named file with nothing else allowed to inline
  it, which §7's content-hash rule and §9's audit action both follow on their
  own axis.
- `apps/api/src/journey/journey.controller.ts` — the no-user-id structural
  rule (every route resolves the caller from `@CurrentUser('id')`, never a
  parameter) and the "ship reference data alongside what needs it" shape
  `journeyProfileSchema` uses, which §8's question-detail endpoint copies for
  resolved answers.
- `apps/api/src/common/clock/clock.ts` — `Clock`, the mandatory "never `new
  Date()`" rule, and `calendarDateIn`, which is what a dynamic-answer
  effective date actually is (a calendar day, not an instant).
- `apps/api/src/common/constants/us-states.constants.ts` — the 56-entry
  `US_STATES_AND_TERRITORIES` list (50 states, DC, and the five populated
  territories: PR, GU, VI, AS, MP), the single source `state`-scope content
  must resolve against without drifting from orientation's own validation.
- `apps/api/src/common/constants/roles.constants.ts` — the closed permission
  set. `system_settings:read`/`system_settings:write` are the only strings
  this design reuses; nothing here adds to the set.
- `apps/api/src/email/email-settings.controller.ts` — the reasoning for
  reusing `system_settings:*` rather than inventing an `email_settings:*` (or
  here, `civics:*`) pair: a new permission string costs a seed change, a
  re-seed, and every existing Admin role being updated, for a page that is
  administering system configuration by any reading.
- `apps/api/src/ai/ai-settings.service.ts` — the working `auditEvent.create`
  call this design's audit write mirrors, including its full-value-in-`meta`
  posture for a non-secret, compile-time-proven-safe payload — the contrast
  case for `journey.service.ts`'s redacted `meta`, cited below.
- `apps/api/src/journey/journey.service.ts` — the *other* audit shape,
  `journey:profile_update`, which redacts every field **value** because a
  learner's own profile is private. §9 explains why the civics dynamic-answer
  audit action does the opposite on purpose.
- `apps/api/prisma/seed.ts` — the existing seed script's shape (a standalone,
  framework-free `ts-node` process, not run through Nest's DI container) that
  §7's content loader is a sibling of, not a rewrite of.
- `apps/api/src/allowlist/allowlist.controller.ts` — the `page`/`pageSize`
  query-parameter pattern §8's paginated question list reuses rather than
  inventing a second pagination shape.
- `ROADMAP.md` §3 (the epic table), §7 ("Cross-cutting rules" — "OathPath
  owns the truth", "Content provenance", "No new permission strings", "Registry
  idiom"), and the 2026-09-02 decision log entry "Both civics test versions
  ship" — the 100-question 2008 bank (10 asked, 6 to pass) and the
  128-question 2025 bank (20 asked, 12 to pass), both shipped from the first
  migration.
- `VISION.md`'s "OathPath Owns the Truth" section and `PRD.md`'s identical
  quotation of it — `> **OathPath owns the truth. AI owns the interaction.**`
  — the foundational rule this whole document exists to make concrete for one
  content domain.
- `CLAUDE.md`'s "Adding a New AI Model Role" and "Adding a Notification"
  sections — two more worked examples of the one-registry idiom this design
  does **not** need for civics content (§1 explains why: this is rows in a
  table with a real seeder, not a small, hand-authored, code-adjacent list),
  and its mandatory Clock rule, restated in §10.
- `docs/specs/ai-settings.md` and `docs/specs/journey-shell.md` — the house
  model for this document's voice and structure: verified sources first, then
  the design, then rejected alternatives, reasons stated plainly, no
  marketing.

**Most of what this document describes has since shipped; two things have
not.** The `civics_categories`, `civics_questions`, and `civics_answers`
tables exist, with the `DynamicScope` enum and the partial unique index from
§3; `apps/api/src/civics/` holds the read endpoints (§8) and the admin
dynamic-answer endpoints (§9); `apps/api/prisma/content/` holds the content
files, the structural validator, and the idempotent loader (§6–§7). What has
**not** shipped:

1. **Neither content file is human-verified.** `civics-2008.json` is
   `UNVERIFIED_MODEL_DRAFT` — drafted to give the rest of this epic
   realistic-shaped data to build against, not transcribed from the official
   USCIS PDF, with every dynamic (officeholder) answer an explicit
   `"[DRAFT PLACEHOLDER]"` string. `civics-2025.json` is `AWAITING_SOURCE`
   with **zero** questions — the 128-question bank was deliberately not
   fabricated. The loader enforces this rather than merely documenting it
   (§7); see
   [`docs/runbooks/updating-civics-content.md`](../runbooks/updating-civics-content.md)
   for how a human transcribes and verifies either file.
2. **The admin dynamic-answer page is UI work in flight**, not yet merged to
   `main` as of this writing — the API surface in §9 it renders against is
   live. (The Learn destination against §8's read API has since shipped,
   issue #121.)

Every other fact cited above about the *existing* codebase has been verified
against the files named; a child issue remains free to find a better answer
to a specific sub-problem as long as it keeps the contracts this document
promises to the epics around it — the three table shapes, the
slot-uniqueness invariant, the resolution rules, and the provenance
requirement.

---

## 1. Where this sits relative to E1

E1 already shipped `civics_test_versions` — the two-row lookup table (`v2008`,
`v2025`) that gives `learner_profiles.test_version_code` a real foreign-key
target and carries each version's shape: `questions_asked`, `pass_threshold`,
`senior_questions_asked`, `senior_pass_threshold`, and a nullable
`content_hash` the schema comment already says is "populated once E2 loads
the versioned, provenance-tracked question content and hashes it."

This epic is that population. Three new tables hang off `civics_test_versions`
by its `code`:

```
civics_test_versions (E1)
        │ code
        ├──< civics_categories   (test version, section, name, sort order)
        │        │ id
        │        └──< civics_questions   (version, number, category, prompt,
        │                 │ id                senior_eligible, dynamic_scope)
        │                 └──< civics_answers  (question, text, sort, state,
        │                                        verified_at, effective_from,
        │                                        effective_to, source_note)
```

**Why three tables and not a nested JSON blob on `civics_test_versions`.** A
category, a question, and an answer are each queried, filtered, and (for
answers) individually corrected on their own — the read API in §8 paginates
questions independently of categories, and the admin surface in §9 corrects
one answer row without touching its question. A JSON blob would make every
one of those operations "load the whole version, mutate in memory, write the
whole version back," which is exactly the failure `system_settings`'s
`global` blob already demonstrates for a much smaller document
(`docs/specs/ai-settings.md` §3: "an `ai` key inside that blob would be
silently destroyed the next time an admin saved an unrelated feature flag").
The three tables also give the seeder in §7 a real primary key
(`(test_version_code, number)`) to upsert against, instead of diffing two
JSON trees.

**Why this is not a registry, unlike journey stages or AI model roles.** The
eight journey stages and the six AI model roles are small, closed,
hand-authored sets that ship in a TypeScript file reviewed as code. The
civics question bank is 100 to 128 rows per version, transcribed from an
external, occasionally-changing government source, corrected by a
non-engineer content reviewer following the process in §6 — it is data with
its own lifecycle, not a constant a developer edits in an IDE. This is exactly
why §7 puts it in versioned JSON loaded by a seeder rather than in a
`CIVICS_QUESTIONS` array: the registry idiom's whole value (`journey-stages.ts`'s
compile-time proof, `ai-model-roles.ts`'s derived schema) comes from the set
being small enough to read in one file, and 100+ rows per version is past
that point.

---

## 2. The three tables

### 2.1 `civics_categories`

| Column | Prisma type | Nullable | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `testVersionCode` | `String @map("test_version_code")` | no | FK → `civics_test_versions.code`, `onDelete: Restrict` — a version cannot be deleted while its categories exist, same posture as `LearnerProfile.testVersion`. |
| `section` | `String` | no | The exam's top-level grouping as USCIS publishes it — e.g. `"AMERICAN GOVERNMENT"`, `"AMERICAN HISTORY"`, `"INTEGRATED CIVICS"`. Free text, not an enum: it is presentation grouping copied verbatim from the source, not a value this application branches on. |
| `code` | `String` | no | A stable slug, e.g. `"principles_of_american_democracy"`. This is what `civics_questions.category_id` really addresses in spirit; the surrogate `id` exists only because Postgres FKs are cheaper over a UUID than a string, per the house convention every other table here follows. |
| `name` | `String` | no | Display name, e.g. `"Principles of American Democracy"`. |
| `sortOrder` | `Int @map("sort_order")` | no | Render order within a version — categories are not alphabetical in the official material (Government precedes History precedes Integrated Civics), and this column is the only place that order is recorded. |
| `createdAt` / `updatedAt` | `DateTime @db.Timestamptz` | no | House convention. |

```
@@unique([testVersionCode, code])
@@index([testVersionCode, sortOrder])
@@map("civics_categories")
```

The unique constraint is the real key `civics_questions` relies on
conceptually; `id` is the FK target only because that is cheaper to index.

### 2.2 `civics_questions`

| Column | Prisma type | Nullable | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `testVersionCode` | `String @map("test_version_code")` | no | FK → `civics_test_versions.code`, `onDelete: Restrict`. |
| `number` | `Int` | no | The official question number within its version — `1..100` for `v2008`, `1..128` for `v2025` (ROADMAP §9's seed figures). This is what a learner and a content reviewer both call the question by; it is never reassigned once content ships (§6). |
| `categoryId` | `String @map("category_id") @db.Uuid` | no | FK → `civics_categories.id`, `onDelete: Restrict`. |
| `prompt` | `String @db.Text` | no | The question text, verbatim from the source. `@db.Text`: a prompt has no meaningful length bound, the same reasoning `Credential.secret` already states for an unrelated column. |
| `seniorEligible` | `Boolean @map("senior_eligible")`, default `false` | no | Marks membership in the fixed subset of questions asked to a `senior_exemption` learner (the 65/20 accommodation `journey-shell.md` §3.1 names). Per version, the count of `senior_eligible = true` rows must equal that version's `civics_test_versions.senior_questions_asked` — an invariant across two tables Postgres cannot check with a constraint, so §6's loader validates it structurally, the same way §3.3 hands a validation Postgres cannot express to application code rather than pretending a constraint covers it. |
| `dynamicScope` | `DynamicScope` (Postgres enum), default `none` | no | `none` \| `national` \| `state`. Governs how §4's answer resolution behaves for this question. A **question-level, essentially permanent** fact: whether "who is the Speaker of the House" is a national dynamic fact is not a business rule anyone toggles, it is a property of the question itself, fixed when the content is transcribed. |
| `createdAt` / `updatedAt` | `DateTime @db.Timestamptz` | no | |

```
@@unique([testVersionCode, number])
@@index([categoryId])
@@map("civics_questions")
```

`@@unique([testVersionCode, number])` is the acceptance criterion verbatim —
it is also the seeder's upsert key (§7).

**One FK gap Postgres cannot close on its own:** nothing stops a question's
`categoryId` from pointing at a category belonging to a *different*
`testVersionCode` than the question's own. Cross-table consistency like this
is not expressible as a Postgres `CHECK` (a check constraint cannot reference
another table), so — like `seniorEligible`'s count invariant above — it is
the content loader's job, verified once at seed time, not the database's job,
verified on every write.

### 2.3 `civics_answers`

| Column | Prisma type | Nullable | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `questionId` | `String @map("question_id") @db.Uuid` | no | FK → `civics_questions.id`, `onDelete: Cascade` — an answer has no meaning independent of its question, unlike the `Restrict` posture above, which protects rows that other rows still reference *for a reason of their own*. |
| `text` | `String @db.Text` | no | The accepted answer, verbatim. |
| `sort` | `Int` | no | Which **slot** this row occupies among a question's simultaneously acceptable answers — see §3.1. `0`-based, dense per question (or per question+state for `state`-scope questions). |
| `stateCode` | `String? @db.Char(2) @map("state_code")` | yes | Non-null only for a `state`-scope question's per-state rows. Must be a value from `US_STATES_AND_TERRITORIES` (56 codes, DC and the five territories included) — the same list `journey-shell.md` §3.2 requires `learner_profiles.state_code` to admit, so a `state`-scope answer set can be complete for every learner who can set a state at all. |
| `verifiedAt` | `DateTime @db.Timestamptz @map("verified_at")` | no | When a human reviewer (§6) confirmed this exact text against the authoritative source. Not necessarily the same instant the fact took effect — a reviewer can verify today a change that took effect last month. |
| `effectiveFrom` | `DateTime @db.Timestamptz @map("effective_from")` | no | When this became the correct answer in the real world. For a question's first-ever content load this is the content's own retrieval date; for a correction (§4) it is the real-world date of the change, sourced, never a guess. |
| `effectiveTo` | `DateTime? @db.Timestamptz @map("effective_to")` | yes | `NULL` means **currently correct**. See §3 for why this is the only "is this current" signal — there is no separate boolean. |
| `sourceNote` | `String @db.Text @map("source_note")` | no | A citation: which official document or record this row's text and dates come from — e.g. `"U.S. House of Representatives, Office of the Clerk — history.house.gov, retrieved 2026-01-15"`. Required on every row, not just corrections: a first-load answer needs the same accountability a corrected one does. |
| `createdAt` / `updatedAt` | `DateTime @db.Timestamptz` | no | |

```
@@index([questionId, stateCode])
@@map("civics_answers")
```

Plus one hand-written raw-SQL statement in the generated migration — §3
covers exactly why it cannot be a Prisma `@@unique` or `@@index` attribute and
exactly what it says.

---

## 3. Why there is no `is_current` flag

"Current" is `effective_to IS NULL`. A `isCurrent BOOLEAN` column sitting next
to it would be a second place that fact is recorded, and the two can drift —
exactly the class of problem the `Notification` model's own comment in
`schema.prisma` already names for an unrelated table: "Ideally a partial
index `WHERE read_at IS NULL`, which Prisma cannot express declaratively."
That comment is the situation; this design is the first table in the
repository that actually needs the partial index the comment could only
work around with a composite one — `notifications` needed the predicate for
**query performance** and a composite index serves that identical need.
This table needs the predicate to enforce a **correctness invariant**
(at most one current answer per slot — see below), which a composite index
cannot do: a composite `@@unique([questionId, stateCode, effectiveTo])`
would let two rows both carrying `effectiveTo: NULL` coexist, because
Postgres unique indexes treat every `NULL` as distinct from every other
`NULL` — the exact hazard §3.2 covers for `stateCode` applies to `effectiveTo`
too, and unlike `notifications`, this table cannot use the same workaround
Prisma can express.

So this is the first hand-written migration statement in this repository
(`apps/api/prisma/migrations/` has no `WHERE` in any existing
`migration.sql`, verified). It is added to the generated migration file by
hand, immediately after `prisma migrate dev` produces it, the same way the
`notifications` comment already documents as the fallback whenever Prisma's
declarative schema cannot express what's needed.

### 3.1 The apparent contradiction, and why it isn't one

Read literally, "one open answer per question" cannot be right: several
civics questions have **more than one simultaneously correct answer** —
"Name one branch or part of the government" (executive / legislative /
judicial), "Name one American Indian tribe in the United States" (dozens
accepted), "What is one right in the First Amendment?" (speech / religion /
press / assembly / petition). Each of those is `dynamic_scope = 'none'`, and
every one of its accepted answers is, correctly, an open row (`effective_to:
NULL`) at the same time as the others. A unique index on bare
`(question_id, state_code) WHERE effective_to IS NULL` would reject every
answer after the first one for these questions, and the content would not
load at all.

The invariant this table actually needs is **at most one open answer per
SLOT**, not per question — where a slot is `(question_id, state_code, sort)`.
The index is:

```sql
CREATE UNIQUE INDEX civics_answers_open_slot_unique
  ON civics_answers (question_id, COALESCE(state_code, ''), sort)
  WHERE effective_to IS NULL;
```

This is exactly what every real case needs, and nothing more:

- **A multi-answer static question** (`dynamic_scope: 'none'`) gets one slot
  per accepted alternative — `sort: 0, 1, 2, …` — all open at once, all
  `state_code: NULL`. They occupy *different* slots, so the index never sees
  them as a conflict.
- **A `national`-scope question** ("who is the Speaker of the House") has
  exactly one slot: `sort: 0`, `state_code: NULL`. The index guarantees at
  most one open row in that one slot — which is precisely "at most one
  current Speaker" — while still permitting any number of *closed* historical
  rows in the same slot.
- **A `state`-scope question** ("who is your governor") has one slot per
  state: `sort: 0` for every row, `state_code` varying across the 56 values.
  The index guarantees at most one open governor per state, and a national
  answer and a per-state answer can coexist on the same question with no
  interference, because they differ in `state_code`.

So the two requirements — "several simultaneously correct static answers"
and "at most one current dynamic fact" — were never actually in tension. They
were two different readings of "answer" (a static alternative vs. a dynamic
current value), and `sort` is what makes the index able to tell them apart
without knowing which reading applies.

### 3.2 Why `COALESCE(state_code, '')`, not bare `state_code`

This is the subtle part, and it is not merely about the national/per-state
split reading nicely — it is what makes the index constrain anything at all
for the rows that most need constraining. Postgres unique indexes (partial
ones included) treat every `NULL` as distinct from every other `NULL`. A bare

```sql
CREATE UNIQUE INDEX ... ON civics_answers (question_id, state_code, sort)
  WHERE effective_to IS NULL;
```

would let an unlimited number of open rows share `question_id = X,
state_code = NULL, sort = 0` — because to Postgres, no two of those `NULL`s
are ever "the same" key. That is exactly the set of rows the dynamic-answer
lifecycle most needs constrained: every `national`-scope question ("who is
the President", "who is the Speaker of the House") has `state_code: NULL` by
definition. A bare index would silently let two "current President" rows
exist at once — the single worst failure this table could have, undetected
by the database, undetected by a query, discoverable only when a learner
sees two different names — while looking, on inspection, like a real
uniqueness constraint.

`COALESCE(state_code, '')` collapses every `NULL` to the same sentinel value
before the index compares rows, so every `national`-scope slot's `NULL`s
collide with each other the way the invariant requires. `''` is a safe
sentinel here specifically because `state_code` is `@db.Char(2)`: no real
state or territory code is empty, so `''` cannot collide with a legitimate
`state`-scope value.

### 3.3 What the index does not enforce, and where that does

The index guarantees uniqueness among the rows that already exist. It cannot
guarantee that a `national`-or-`state`-scope question's rows only ever *use*
slot `0` — a bug that inserted a second `national` answer at `sort: 1` (a
different slot) would not violate the index at all, and the question would
silently gain a second, un-conflicting "current" fact. Enforcing "a
`national`/`state`-scope question uses exactly one slot" requires reading the
*question's own* `dynamic_scope`, and a Postgres index predicate can only see
columns of the table it is defined on — the identical same-table-only
limitation that makes `civics_questions.dynamicScope` a fact this table's
constraint cannot consult directly at all.

That check therefore lives in the content loader's structural validator
(this epic's dedicated validation issue, #101), run once whenever content is
loaded, not on every write: after parsing a version's questions and answers,
it groups answers by question and asserts that a `national`- or
`state`-scope question uses only `sort: 0` across every row it defines, and
separately (§2.2) that a `state`-scope question defines exactly one row per
entry in `US_STATES_AND_TERRITORIES`, no gaps and no duplicates. A
database-level partial index enforces the correctness invariant Postgres can
see; a content-time validator enforces the shape invariant that requires
seeing the question row too. Neither substitutes for the other, and §3.1
already showed why folding the second into the first (a denormalized copy of
`dynamic_scope` onto `civics_answers`, so the index's predicate could see it)
is unnecessary here — the slot key alone already produces the correct
behavior for every real case, with no extra column and nothing to keep in
sync.

---

## 4. The dynamic-answer lifecycle

A correction to a `national`- or `state`-scope answer **closes** the existing
open row (`effective_to` set) and **opens** a new one. It never edits an
existing row's `text` in place.

**Why.** `practice_attempts.answer_snapshot` (E3) records, at grading time,
the answer text a learner was actually graded against. A learner graded
correct on 2026-06-01 against "the Speaker of the House is Jane Q. Doe" must
have that grading stay explicable forever, even after the real Speaker
changes. An in-place edit of the row's `text` would silently rewrite that
history: the snapshot would still point at the same row id, but the row it
points to would now say something the learner was never actually shown. This
is the identical shape of failure the credential store refuses for a decrypt
error (`docs/specs/ai-settings.md` §13) — "silently substituting a different
answer for the old one" is a worse failure than a visible one, because
nothing downstream can tell it happened.

This same reasoning is not confined to `national`/`state` scope. A genuine
correction to a **static** answer's text (not merely `sourceNote` metadata)
carries the same explainability concern, so this design applies the
close-then-open pattern uniformly to every `civics_answers` correction,
dynamic or static, rather than carving out a special "static answers may be
edited in place" exception. One rule, one code path, and §3's slot-based
index already accommodates it without modification: closing a slot's row and
opening a new one in the *same* slot is exactly what the index allows any
number of times, in sequence, for any scope.

### 4.1 Worked example: the Speaker of the House changes

1. **E2's content load** seeds question `number: 43` on `v2008`
   (`dynamicScope: 'national'`) with one open answer row: `sort: 0`,
   `stateCode: NULL`, `text: "Jane Q. Doe"`, `effectiveFrom: 2023-01-07`
   (the real date she became Speaker, per the cited source),
   `verifiedAt: 2026-01-15` (the content team's retrieval/verification date),
   `effectiveTo: NULL`, `sourceNote: "U.S. House of Representatives, Office
   of the Clerk — history.house.gov, retrieved 2026-01-15"`.
2. On 2027-01-03, a new Speaker — John R. Roe — is sworn in.
3. A reviewer opens the content PR (§6) or, once #93's sibling issue for the
   admin surface (§9) ships, an admin submits the correction through
   `/admin/settings/civics-dynamic-answers` (or wherever that route lands —
   this document fixes the permission and audit shape, not the exact path).
   Either way the write is:
   - `UPDATE civics_answers SET effective_to = '2027-01-03T00:00:00Z' WHERE id = <old row id>` — using the real-world effective date of the change, sourced from the same citation, not `Clock.now()`. `Clock.now()` is the fallback only when no precise real-world date is knowable, so the two rows stay contiguous with no gap and no overlap.
   - `INSERT INTO civics_answers (question_id, sort, state_code, text, effective_from, effective_to, verified_at, source_note) VALUES (<question id>, 0, NULL, 'John R. Roe', '2027-01-03', NULL, <Clock.now() at write time>, <new citation>)`.
   - **Both statements execute inside one `$transaction`.** A reader must
     never observe a moment with zero open rows for this slot (the question
     would appear to have no current answer, when it manifestly does) or two
     open rows (the exact bug §3.2 exists to prevent).
4. **The uniqueness index is what makes this transaction safe against a
   mistake, not just a review process.** If step 3's UPDATE were forgotten —
   the new row inserted without closing the old one — the `INSERT` collides
   with `civics_answers_open_slot_unique` on `(question_id, '', 0)` and fails
   at the database level, immediately, rather than silently producing two
   simultaneously "current" Speakers that only a query happens to notice
   later.
5. A learner who practiced this question on 2026-06-01 was graded against
   the row created in step 1. That row still exists — closed, not deleted —
   with its original `text`, `effectiveFrom`, and `sourceNote` intact, so
   `practice_attempts.answer_snapshot` (E3) can always explain, for any past
   attempt, exactly what was shown and why it was correct at the time.

---

## 5. Resolution rules

Given a caller's `test_version_code`, `state_code` (possibly unset), and
`senior_exemption`, here is how an answer set is chosen for one question.

| `dynamic_scope` | Learner `state_code` | Resolved answer(s) |
|---|---|---|
| `none` | (irrelevant) | **Every** open row for the question (`effective_to IS NULL`), ordered by `sort` — all accepted alternatives, none of them state-dependent. |
| `national` | (irrelevant) | The single open row at `sort: 0`, `state_code: NULL`. |
| `state` | set, e.g. `'TX'` | The single open row at `sort: 0`, `state_code: 'TX'`. Applies identically to every code in `US_STATES_AND_TERRITORIES`, DC and the five territories included — e.g. a Puerto Rico learner resolves the row with `state_code: 'PR'`, whose text is the territory's own accurate answer (the 2008 test's own content explicitly covers "no U.S. senators" for territory residents). |
| `state` | **not set** (`NULL`) | **No answer is resolved.** The question is still returned — never hidden, never guessed — with a flag the client renders as *"Set your state to see this answer"*, linking to the profile field that sets it. |

Hiding a `state`-scope question with no state set was considered and
rejected: the learner would see a shorter question list than the version's
`questions_asked` actually contains, with nothing explaining the gap.
Guessing a state (defaulting to the most common one, or picking the first
alphabetically) was also rejected: it would hand a learner a **wrong**
answer to memorize with no indication it might not apply to them, which is
worse than an honest "we don't know yet." Showing the question with an
honest missing-answer state is the same move `journey-shell.md` §10 makes for
every widget whose real data doesn't exist yet: a designed absence, stated in
plain language, never a fabricated stand-in.

**`senior_exemption` never touches this table.** It filters the **question
set** a learner is asked from — restricting candidates to rows where
`senior_eligible: true`, and using `civics_test_versions.senior_questions_asked`
/ `senior_pass_threshold` instead of the ordinary figures — a decision made
entirely from `learner_profiles` and `civics_questions`, before any answer is
resolved. Once a question is selected, its answer resolves by the table
above exactly the same way regardless of who is asking: the correct answer
to "who is the Speaker of the House" does not change because the person
being asked qualifies for the 65/20 accommodation.

---

## 6. Provenance

`VISION.md`'s foundational rule — `> **OathPath owns the truth. AI owns the
interaction.**` — and ROADMAP §7's "Content provenance" cross-cutting rule
both apply directly here: civics content is **transcribed from the official
USCIS PDFs and human-verified, never generated from model memory.** No
content JSON file (§7) is ever produced by asking a model what the 100
questions are, and no dynamic-answer correction is ever accepted on an
AI-generated claim about who currently holds an office.

Each content file (§7) carries, at the top level:

- `sourceUrl` — the exact official page or PDF the content was transcribed
  from.
- `retrievedAt` — the calendar date the source was fetched, in `YYYY-MM-DD`.
- `sha256` — the hash of the **downloaded source document itself** (the
  USCIS PDF, or a saved snapshot of the source page), not of the JSON file.
  This is a receipt: it proves which exact revision of the official material
  was on hand at transcription time, and lets a later reviewer re-fetch the
  same URL and confirm nothing has silently changed underneath the citation.

This is distinct from `civics_test_versions.content_hash` (§7), which is
computed by the **loader**, over the loaded JSON file's own content, and
proves the opposite direction of the same question — "does the live database
match exactly this file in git" — rather than "does this file match the
official source."

Each individual `civics_answers` row additionally carries its own
`sourceNote` (§2.3) — a citation can be more specific than the file-level
`sourceUrl`, particularly for a `state`-scope answer sourced state by state,
or for a correction sourced from a different record than the original load.

### 6.1 How a reviewer verifies a content PR

A content correction or a new version's initial load is a pull request
against the JSON files in §7, reviewed by a human before merge:

1. The PR states the exact official source (URL or document) it draws from,
   and includes the file-level `sourceUrl`/`retrievedAt`/`sha256` triple.
2. The reviewer independently opens that source — not the PR author's
   description of it — and confirms question text, category assignment,
   question number, and, for a dynamic correction, the specific new fact.
3. For a dynamic correction specifically, the reviewer confirms the claimed
   fact against a **second, independent official source** where one exists
   (e.g. a state's own official site corroborating a governor named in a
   federal roundup) — a single unlinked claim, however confident, is not
   sufficient for a fact a learner will be graded against.
4. The reviewer re-derives `sha256` on the document they just fetched and
   confirms it matches the PR's stated hash, catching a stale, swapped, or
   silently-edited source.
5. For a dynamic correction, the PR states the real-world `effectiveFrom`
   date of the change (when the new officeholder actually took office) —
   never left to default to "the date this PR merged," which would encode
   the reviewer's schedule as if it were a historical fact.
6. The loader's own structural validation (§3.3, §2.2) runs in CI against
   the changed file: no duplicate `(version, number)`, no orphaned category
   reference, no `state`-scope question missing a state, no dynamic question
   using more than one slot, `senior_eligible` counts matching
   `civics_test_versions`' seeded figures.

Merging is the only action that changes what a learner sees — it triggers no
migration, only the ordinary deploy's seed/load step (§7).

---

## 7. Content is data, not code

Content lives as versioned JSON under `apps/api/prisma/content/` — one file
per test version — `civics-2008.json` and `civics-2025.json`, the names
issue #101 fixes — each
holding that version's categories, questions, and answers, plus the §6
provenance block. This sits beside `apps/api/prisma/seed.ts` (the existing
RBAC/system seed) rather than inside it: `seed.ts` is a small, rarely-changed
bootstrap (roles, permissions, the initial admin) run once per environment
setup, while civics content changes on its own cadence — a dynamic-answer
correction every few weeks, in principle — and re-running the whole RBAC
seed to load one new content file would be the wrong unit of change. The
loader is its own script, a sibling of `seed.ts` in shape (a standalone,
framework-free process, per `seed.ts`'s own header reasoning about why it
avoids Nest's DI container) but triggered independently, as part of the
deploy step that ships a content PR.

**The loader is idempotent, keyed on `(testVersionCode, number)` for
questions** — the same pair `@@unique` already enforces — **and, for
answers, on the slot they claim** (`questionId`, `stateCode`, `sort`).
Running the loader again with unchanged content must be a true no-op: it
must not bump `effectiveFrom`/`verifiedAt` on a row nothing about, just
because a deploy happened to run. Concretely, per declared answer in the
file:

- If no row exists yet for that slot, **insert** it directly, using the
  file's own `effectiveFrom`/`verifiedAt`/`sourceNote` — there is nothing to
  close.
- If an open row exists for that slot and its `text` and `sourceNote` are
  byte-for-byte unchanged from the file, **do nothing** — this is the
  common case, run on every deploy that ships no content change.
- If an open row exists and the file's `text` differs, run the close-then-
  open transaction from §4, using the file's stated `effectiveFrom` (never
  `Clock.now()` unless the content itself has no more specific date to give)
  and a fresh `verifiedAt` at load time (`Clock.now()`, injected — this
  loader is application code and follows the same never-`new Date()` rule as
  everything else, §10).

**`civics_test_versions.content_hash` is stamped by the loader** — a sha256
over the loaded file's own canonicalized content, computed after a
successful load. It answers "does the live database reflect exactly this
file," and is exposed by `GET /api/civics/versions` (§8) so an admin, or an
automated check, can confirm a deploy actually applied the content it was
supposed to.

**A correction is a content PR, never a migration.** The three tables and
the partial index are created once, by this epic's migration; every fact
they hold afterward — a new question, a corrected Speaker, a re-verified
answer — changes through the JSON files and the loader, reviewed the way any
other pull request is. This is the concrete form ROADMAP §7's "content
provenance" rule takes for the pipeline itself, not only for the runtime
grading path.

---

## 8. Read API surface

Every route below is `@Auth()` with **no permission** — civics content is
core product material every authenticated learner reads, the same posture
`journey/*`'s reference-data routes already take, and the closed permission
set (ROADMAP §7) gains nothing from gating a read of public exam content.
None accepts a caller-supplied user id or `state_code` — `state_code` and
`senior_exemption` for resolution (§5) always come from the caller's own
`learner_profiles` row via `@CurrentUser('id')`, the identical structural
rule `journey.controller.ts` states for its own routes.

- **`GET /api/civics/versions`** — every `civics_test_versions` row (`code`,
  `label`, the four question/threshold counts, `contentHash`). Small,
  cacheable, and — per §7 — a way to confirm what content is actually live.
- **`GET /api/civics/versions/:code/categories`** — a version's categories,
  ordered by `sortOrder`.
- **`GET /api/civics/questions`** — paginated and filterable by
  `testVersionCode`, `categoryId`, and `seniorEligible`, using the same
  `page`/`pageSize` query-parameter shape `AllowlistController` already
  establishes rather than a second pagination convention. Returns question
  summaries (`number`, `prompt`, `categoryId`) — not resolved answers, which
  are per-caller (§5) and belong on the detail route.
- **`GET /api/civics/questions/:id`** — one question's detail, **with its
  answer(s) already resolved** against the caller's own `state_code` and
  `senior_exemption`-irrelevant-to-answers posture (§5), each returned answer
  carrying its `text` and `verifiedAt`. A `state`-scope question with no
  caller `state_code` returns the question with an empty answer list and the
  "set your state" flag from §5 — never a 404, never a guess.

This mirrors `journeyProfileSchema`'s "ship the reference data alongside what
needs it" shape (`docs/specs/journey-shell.md`'s citation of that DTO) only
where it earns its keep: `GET /api/civics/versions` is deliberately its own
call rather than folded into every question response, because a version list
changes far less often than a question list and has its own natural cache
lifetime — the same "different audiences, different cache lifetimes"
reasoning `journey-shell.md` §6.1 gives for keeping the stage registry and a
learner's own stage as two endpoints rather than one merged payload.

---

## 9. The admin dynamic-answer surface

Only `national`- and `state`-scope answers are ever admin-editable at
runtime. Static (`none`-scope) content changes exclusively through the
content-PR-and-reseed path in §6–§7; there is no admin UI for it, because
there is no fact in it that changes on its own — inventing a runtime edit
surface for content that only ever changes via a reviewed PR would be a
second, weaker-reviewed path to the same rows.

**Gate: `system_settings:read` to view the current dynamic answers,
`system_settings:write` to correct one — reused, never invented.** This is
`email-settings.controller.ts`'s reasoning verbatim: a new `civics:read` /
`civics:write` pair would cost a seed change, a re-seed, and an update to
every existing Admin role, for a page that is — by any reasonable reading —
administering system configuration. The read/write split itself mirrors
`EmailSettingsController`: looking at the current Speaker of the House is not
the same privilege as changing it.

**The write performs exactly the §4 transaction — never a raw update.** The
service closes the existing open row (using the submitted real-world
`effectiveFrom`, or `Clock.now()` as the stated fallback) and opens the new
one inside a single `$transaction`, the same code path §7's loader uses for
a content-driven correction. There is no endpoint that lets an admin set
`text` on an existing row directly; §4's reasoning for why that is unsafe
applies exactly as much to an admin's mouse click as it does to a content
PR's automated apply.

**Every correction is audited**, action `civics:dynamic_answer_update`,
following the `<domain>:<verb>` convention `ai_settings:replace` and
`journey:profile_update` already use. Its `meta` shape is closer to
`ai_settings:replace`'s than to `journey:profile_update`'s, and the
difference is worth stating plainly: `journey:profile_update` redacts every
field **value** because a learner's profile is private data (state of
residence, interview date, a claimed accommodation). A civics answer's text
is the opposite of private — it is public exam content whose whole point is
to be shown to every learner — so this audit action's `meta` records the
question id, the `stateCode` (or `null` for `national`), the old and new
`text`, both `sourceNote`s, and the real-world `effectiveFrom` used. A
reviewer investigating "why does this say a different name than it did last
month" needs the diff in the audit log itself, not a pointer to a row that
has since closed and is easy to overlook.

---

## 10. The `Clock` rule, restated for this epic

Every "is this the calendar day this answer's `effectiveFrom` claims"
comparison, every `verifiedAt`/`effectiveFrom` stamp the loader or the admin
write applies at run time, and any future reader that computes "how long has
this fact been current" goes through `Clock.now()` (or `calendarDateIn` where
a calendar day rather than an instant is the actual question, per its own
doc comment). Nothing in this epic's service or loader code calls
`new Date()` directly — the same rule `apps/api/src/journey/` already holds
to, verified there by a `grep` that returns nothing, and the rule this
epic's own service code is expected to pass the same way.

---

## 11. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **An `isCurrent` boolean beside `effectiveTo`** | A second place the same fact is recorded is a second place it can drift from the first. `effective_to IS NULL` is already the unambiguous, single-sourced answer to "is this current." §3. |
| **A composite `@@unique([questionId, stateCode, effectiveTo])` instead of a partial index** | Solves nothing: Postgres treats every `NULL` as distinct in a unique index, so two rows both carrying `effectiveTo: NULL` would still coexist — the exact case that must be prevented. This is also why `notifications`' composite-index workaround (`@@index([userId, readAt])`) does not transfer here: that index exists for query performance, not to enforce a correctness invariant, and a composite index cannot enforce the invariant this table needs. §3. |
| **A bare `(question_id, state_code) WHERE effective_to IS NULL` partial unique index** (the issue text's literal wording) | Two independent failures. First, it rejects every answer past the first for a genuinely multi-answer static question — "Name one branch of government" would fail to load its second accepted answer. Second, even restricted to single-answer questions, a bare `state_code` lets Postgres treat every `NULL` as distinct, so it would not constrain `national`-scope answers (`state_code IS NULL`) at all — silently permitting exactly the "two current Presidents" bug the table exists to prevent. The corrected form adds `sort` to the key (resolving the first failure, §3.1) and wraps `state_code` in `COALESCE(state_code, '')` (resolving the second, §3.2). |
| **In-place edits to a dynamic answer's `text`** | An answer graded correct last month must stay explicable; an in-place edit silently rewrites what `practice_attempts.answer_snapshot` (E3) points at. §4. |
| **Exempting static (`none`-scope) answers from the close-then-open rule** | The explainability concern is about any text change a learner could have been graded against, not specifically about officeholder facts. One rule for every correction is simpler than a scope-conditional exception, and §3's slot-based index already supports it with no extra work. §4. |
| **A denormalized copy of `dynamic_scope` on `civics_answers`, so the partial index's predicate could see it and skip static rows** | Unnecessary once `sort` is part of the key: static multi-answer questions naturally occupy distinct slots and never collide with the invariant, so there is nothing for a denormalized scope column to protect against that the slot key doesn't already handle — and it would be one more copy of a fact to keep in sync for no gained guarantee. §3.1, §3.3. |
| **Hiding a `state`-scope question entirely when the learner has no state set** | The learner would see fewer questions than the version's own `questions_asked` promises, with nothing explaining the gap. §5. |
| **Guessing a state (defaulting to the most common, or alphabetically first) when none is set** | Hands the learner a specific, memorizable wrong answer with no signal that it might not apply to them — worse than an honest "we don't know yet." §5. |
| **Letting `senior_exemption` filter which answer resolves, not just which questions are asked** | The correct answer to a question does not depend on who is being asked it. Conflating the two would make `senior_exemption` a second axis on the answer table it has no legitimate reason to be. §5. |
| **A `content_hash` computed over the official USCIS source document, reused as the "is content loaded correctly" hash** | Answers a different question. The source-document hash (§6) proves fidelity to the origin at transcription time; `content_hash` (§7) proves the live database matches the file in git. Collapsing them would lose the ability to tell "the source changed since we transcribed it" apart from "the database drifted from the committed file." |
| **A hand-authored `CIVICS_QUESTIONS` TypeScript registry, mirroring `journey-stages.ts` / `ai-model-roles.ts`** | The registry idiom's value comes from a set small enough to review as code and re-derive types from. 100–128 rows per version, transcribed from an external source and corrected by a non-engineer reviewer through a content PR, is data with its own lifecycle — the seeder and the three tables are the right shape, not a fourth registry file. §1, §7. |
| **A new `civics:read`/`civics:write` permission pair for the admin dynamic-answer surface** | Costs a seed change, a re-seed, and every existing Admin role being updated, for a page administering system configuration by any reading — `email-settings.controller.ts`'s conclusion, unchanged here. §9. |
| **Redacting the old/new answer text in the `civics:dynamic_answer_update` audit `meta`, mirroring `journey:profile_update`** | `journey:profile_update` redacts values because a learner's profile is private. A civics answer's text is public exam content by design; recording the full diff is strictly more useful to a reviewer and reveals nothing that isn't already shown to every learner. §9. |
| **Loading civics content through `apps/api/prisma/seed.ts` directly** | `seed.ts` is a small, rarely-run bootstrap (roles, permissions, the initial admin). Content changes on its own, more frequent cadence via reviewed PRs; folding it into the RBAC seed would force every content-only deploy to re-run bootstrap logic that has nothing to do with it. §7. |
| **Recomputing `senior_eligible`/category-consistency invariants on every read instead of validating once at load time** | These are cross-table shape checks Postgres cannot express as constraints. Checking them on every read repeats the same work for no benefit, since the loader is the only place content enters the table; validating once, at load, catches a bad file before it ever reaches a learner. §2.2, §3.3. |

---

## 12. Out of scope (deliberately)

- **The Learn page's UI itself.** This document settles the data model and
  the API it is read through; how Learn renders a question, a category
  list, or the "set your state" prompt is a separate, sibling issue's design.
- **Grading and `practice_attempts`.** E3 owns the evidence table and the
  `answer_snapshot` mechanism this document's §4 depends on existing; this
  epic only guarantees the answer rows a snapshot can safely point at stay
  stable once graded against.
- **Embedding-based retrieval over civics content.** Named in ROADMAP §8's
  post-MVP backlog as real future value the `embed` AI model role exists for;
  nothing in this epic's three tables is designed against that use case yet,
  though nothing here rules it out either.
