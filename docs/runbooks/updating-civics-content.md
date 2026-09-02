# Runbook: Updating civics content

This runbook covers changing anything OathPath tells a learner is a correct
civics answer — a transcription fix, a newly-verified question, or an
officeholder change (a new Speaker of the House, a new governor).

For the underlying data model — the three tables, the partial unique index,
the close-then-open lifecycle, and why each of these rules exists — see
[`docs/specs/civics-content.md`](../specs/civics-content.md). This runbook
does not restate that design; it only tells you which path to use and how to
walk it.

Source of truth for every claim below:

- `apps/api/prisma/content/civics-2008.json`, `civics-2025.json` — the content
  files a content PR edits.
- `apps/api/prisma/content/validate-content.ts` — the structural validator.
- `apps/api/prisma/content/load-content.ts` — the idempotent loader.
- `apps/api/src/civics/civics-admin.controller.ts`,
  `civics-admin.service.ts` — the admin dynamic-answer surface.
- `apps/api/package.json` — the `content:validate`, `content:validate:strict`,
  and `content:load` scripts this runbook invokes.

---

## 0. Which path to use — and the rule that decides it

There are exactly two ways to change what OathPath claims is true, and they
are not interchangeable:

| `civics_questions.dynamic_scope` | Path | Example |
|---|---|---|
| `none` | **Content PR** (§1 below) | Fixing a typo in "Name one right in the First Amendment"; correcting a category assignment |
| `national` or `state` | **Admin edit** at `/admin/settings/civics` (§3 below) | A new Speaker of the House is sworn in; a state elects a new governor |

**The reasoning, briefly** (full rationale:
[`docs/specs/civics-content.md`](../specs/civics-content.md) §4, §6, §9): a
transcription correction to static exam content needs provenance and human
review before it reaches a learner — the same bar every other piece of civics
content is held to. An officeholder change is a fact that becomes true on a
Tuesday and needs to be correct on Wednesday; a change so time-sensitive
cannot wait for a content PR, a code review, and a deploy cycle. The admin
surface exists specifically — and only — for that second case: it can correct
a `national`- or `state`-scope answer in seconds, with no deploy.

**Using the wrong path fails outright, by design.** The admin surface
rejects a `none`-scope `questionId` with a 400 — there is no runtime edit
route for static content, ever (§3 explains why). A content PR is *possible*
for a dynamic fact, but the wrong choice operationally: a governor change
sitting in review for a day is a day of learners studying a stale name.

If you are unsure which scope a question has, `GET /api/civics/questions/:id`
(or the admin list, `GET /api/civics/dynamic-answers`) returns `dynamicScope`
directly — do not guess from the question text.

---

## 1. The content-PR path (`dynamic_scope: none`, and any new question or version)

This path also covers work the admin surface cannot do at all: adding a new
question, changing a prompt or category, or transcribing the (currently
empty) 2025 question bank — see §5's current-state warning before you start.

1. **Edit the JSON file** — `apps/api/prisma/content/civics-2008.json` or
   `civics-2025.json` — one file per test version. Add or correct a
   `categories[]`, `questions[]`, or `questions[].answers[]` entry per the
   shapes `validate-content.ts` checks (categories need a unique `code`;
   questions need a unique `number` within the version and a `categoryCode`
   that resolves; a `none`-scope answer must not set `stateCode`).

2. **Update the provenance block.** Every content correction is transcribed
   from the official USCIS PDF or study page and human-verified — **never
   generated from a model's memory of what the test says.** This is
   `VISION.md`'s "OathPath owns the truth" rule applied to this one file. At
   minimum:
   - `provenance.sourceUrl` — the exact official page or PDF you transcribed
     from.
   - `provenance.retrievedAt` — the date you fetched it, `YYYY-MM-DD`.
   - `provenance.sha256` — the sha256 of the **downloaded source document
     itself** (the PDF or a saved snapshot of the page), not of the JSON file.
     This is the receipt that proves which exact revision of the official
     material you had on hand.
   - `provenance.transcription.status` — set to `HUMAN_VERIFIED` once you (or
     the PR's reviewer) have independently checked every changed row against
     the official source. See §2 for what "verified" actually gates.
   - Each changed `civics_answers` entry's own `sourceNote` — a citation that
     can be more specific than the file-level `sourceUrl` (per-state sourcing,
     or a different record than the original load).

   Follow [`docs/specs/civics-content.md`](../specs/civics-content.md) §6.1
   for the full reviewer checklist (independent re-fetch, a second source for
   any dynamic claim, re-deriving `sha256`, the real-world `effectiveFrom`
   date of any change) — that section is the actual review bar, this runbook
   is just the mechanics.

3. **Validate the file:**
   ```bash
   npm run content:validate --workspace=api
   ```
   This checks structure only (duplicate numbers, dangling category
   references, a `state`-scope question missing a state, an out-of-bounds
   answer slot) and reports a file's transcription status as a **known gap**
   — loudly, but non-fatally — rather than a hard failure, so CI is not
   permanently red on a gap only a human with the source PDF can close.

   Before merging anything intended for production, also run:
   ```bash
   npm run content:validate:strict --workspace=api
   ```
   `--strict` is the release gate: it additionally fails on **any** file not
   `HUMAN_VERIFIED`, and on any known gap. This is what makes §2's
   verification rule enforced, not aspirational — a PR cannot pass the strict
   gate by fixing structure alone.

4. **Open the PR** for human review per §6.1 of the spec, then merge. Merging
   changes nothing a learner sees by itself — it only changes what the next
   re-seed (§2) will load.

---

## 2. Re-seeding — applying a merged content change

```bash
npm run content:load --workspace=api
```

`prisma:seed` calls this too (`loadAllCivicsContent` runs from
`apps/api/prisma/seed.ts`), so a normal environment bootstrap picks up
whatever content is currently on disk. Running it standalone is how you apply
a content PR to an already-running environment without a full reseed.

**The loader refuses unverified content, by design:**

- Any file whose `provenance.transcription.status` is not `HUMAN_VERIFIED`
  is refused **unconditionally when `NODE_ENV=production`**, regardless of
  any override.
- Outside production, the same file is refused unless
  `CIVICS_ALLOW_UNVERIFIED_CONTENT=true` is set — which exists so dev/CI can
  work with draft content while it is still being built out, never as
  something to set in a real deployment.

So `HUMAN_VERIFIED` is not merely a label the strict validator checks at PR
time — it is a load-time gate enforced again, independently, by the loader
itself. A file that slipped through review still cannot reach a production
database.

**What `civics_test_versions.content_hash` tells you.** It is a sha256,
stamped by the loader, over the loaded file's own canonicalized content —
exposed on `GET /api/civics/versions`. It answers "does this environment's
database match exactly the content file in git," which is a different
question from "is the content correct" (that's `HUMAN_VERIFIED`). Compare it
across environments, or against the hash a deploy expected to apply, to
confirm a content change actually landed.

**Why a re-run is safe.** The loader is idempotent, keyed per question on
`(testVersionCode, number)` and per answer on its slot
(`questionId`, `stateCode`, `sort`). For each declared answer it compares
`text` and `sourceNote` to the currently open row: identical means it writes
**nothing**, not even `updated_at` — this is a true no-op, not just a
no-visible-effect one. A real difference runs the same close-then-open
transaction described in the spec's §4. Practically: you can run
`content:load` on every deploy, whether or not that deploy shipped a content
change, with no risk of nudging timestamps or re-verifying rows nothing
changed about.

---

## 3. The admin path (`dynamic_scope: national` or `state`)

`/admin/settings/civics` — reachable from the admin settings hub, gated
`system_settings:read` to view, `system_settings:write` to correct (reused
from `system-settings.controller.ts`'s permissions; there is no
`civics:read`/`civics:write` pair — see §4).

Wire contract: `GET /api/civics/dynamic-answers` (list, `system_settings:read`)
and `PUT /api/civics/dynamic-answers` (correct one, `system_settings:write`) —
documented in full in [`docs/API.md`](../API.md#civics-admin).

**`source_note` is required on every correction**, the same accountability
every `civics_answers` row carries from a content PR. There is no way to
submit a correction without a citation.

**An edit closes the prior answer and opens a new one — it never overwrites
it.** Submitting a correction runs the exact same transaction the loader runs
for a content-driven change (spec §4): the row currently open for that slot
gets its `effectiveTo` set, and a brand-new row is inserted with
`effectiveTo: null`. The old row is never deleted and never has its `text`
changed — it stays queryable, unaltered, so a learner graded against it last
month stays explicable. `effectiveFrom` should be the real-world date the new
fact became true (sourced from the same citation), not "the date this form
was submitted" — omit it only when no more precise date is knowable, in which
case the server's clock is the stated fallback.

Every accepted correction writes an `audit_events` row,
`action: "civics:dynamic_answer_update"`, carrying the old and new `text` in
full plus both `sourceNote`s — civics content is public exam material, so
recording the full diff (rather than redacting it, the way a private
`journey:profile_update` audit row does) is what lets a reviewer answer "why
does this say a different name than it did last month" from the audit log
alone.

---

## 4. What never happens

- **No in-place answer edits, through either path.** A `civics_answers` row's
  `text` is never updated by an `UPDATE … SET text = …` anywhere in this
  codebase — only closed-and-replaced. This applies uniformly to static and
  dynamic answers alike (spec §4).
- **No `is_current` flag.** "Current" is `effective_to IS NULL`, full stop —
  there is no second column recording the same fact a different way for it to
  drift from.
- **No editing prompts, categories, or `dynamic_scope` through the admin
  UI.** `/admin/settings/civics` administers answers only. A question's
  prompt, its category assignment, and whether it is dynamic at all are
  content, changed exclusively through §1's content-PR path.
- **No new permission strings.** The admin surface reuses
  `system_settings:read` / `system_settings:write` — the exact strings
  `system-settings.controller.ts` already enforces, verified against
  `apps/api/src/common/constants/roles.constants.ts`. There is no
  `civics:read` or `civics:write` anywhere in this codebase, and there is not
  meant to be one: adding a permission pair here would cost a seed change, a
  re-seed, and an update to every existing Admin role, for a page that is —
  by any reasonable reading — administering system configuration.

---

## 5. Current state — read this before touching either file

As of this writing, **neither content file is safe to serve to a real
learner**, and the loader enforces that rather than merely documenting it:

- **`civics-2008.json`** is `UNVERIFIED_MODEL_DRAFT`, with `sha256: null`.
  It was drafted to give the rest of this epic realistic-shaped data to build
  against — it was **not** transcribed from the official USCIS PDF. Every
  dynamic (officeholder) answer in it is a literal
  `"[DRAFT PLACEHOLDER] …"` string, not a real name. **A human must
  transcribe and verify this file against the official USCIS PDF, per §1–§2
  above, before any production use.**
- **`civics-2025.json`** is `AWAITING_SOURCE` with **zero** questions. The
  128-question 2025 bank was deliberately not fabricated — an honestly empty
  bank is correct; a guessed one is not. It needs the same human transcription
  §1 describes, from scratch.

Concretely: to move either file to `HUMAN_VERIFIED`, transcribe (or verify)
every question and answer against the official source per §1 step 2, then set
`provenance.transcription.status: "HUMAN_VERIFIED"` and fill in the real
`provenance.sha256` of the document you verified against. Until that happens,
`npm run content:validate:strict --workspace=api` will keep failing on both
files, exactly as intended.
