# Design Spec: English reading and writing tests (issue #124, epic #59 / E10 "Reading and writing tests")

This is the durable design for E10: the naturalization interview's reading
and writing segments — a learner reads one composed sentence aloud and is
scored on word accuracy, then hears one sentence spoken and types it back.
Both reuse the deterministic-matching discipline E3 already built rather than
inventing a second scorer, both reuse the confirm-before-grade and
low-confidence handling E9 already built for spoken civics answers, and both
feed a ninth-in-spirit-but-sixth-declared readiness component that has been
sitting at a hardcoded `0` since E6 shipped. An epic and its child issues
link here instead of restating the design — read this first, then the issue
you were sent to implement.

Source of truth for every claim below:

- `docs/specs/civics-content.md` — §3 (why "current" is `effective_to IS
  NULL` and not a second boolean — the answer-lifecycle discipline this
  document does **not** need, because a sentence has no lifecycle of
  changing officeholders, but §7's "content is data, not code" posture is
  reused verbatim in §1 below), §7 (the loader idempotency contract —
  "running the loader again with unchanged content must be a true no-op" —
  which §1.3 below extends to a new content file rather than restating).
- `docs/specs/voice.md` — §1 (the degradation rule and why wiring a role
  must never silently break an already-deployed installation — the same
  discipline `english` already lives under today, per
  `docs/specs/readiness-model.md` §2.6, and one this epic does not disturb),
  §3 (confirm-before-grade — the transcript is shown to the learner and can
  be edited before anything is graded; §3 below is this exact mechanism
  reused for a reading attempt, not a new one), §8 (`asrConfidence`/
  `transcript`/`retryOfAttemptId` on `practice_attempts` — the shape §5
  below deliberately does **not** reuse, because `english_attempts` is its
  own table, but the *reasoning* for those three columns is what §3 below
  imports), §10 (the RBAC posture every learner-owned, no-user-id route in
  this codebase takes — reused verbatim in §7 below).
- `docs/specs/readiness-model.md` — §2 (the eight-component weight table —
  `english` already occupies weight `0.05`, key 6 of 8, formula
  `min(distinctQuestionsCorrectSpokenInEnglish / 20, 1)`, "evidence until
  E11" in the table's own header — a stale forward reference this document
  corrects to E10 in §6 below, since it is this epic, not a repeat-numbered
  E11, that actually produces the evidence), §2.4 (`consistency`'s rolling
  14-day window — the shape §6 below's `ENGLISH_WINDOW_DAYS` copies at a
  different length, not a different mechanism), §2.9 (the structural cap —
  `english` + `spoken` + `interview` sum to `0.25` of the total weight, and
  the score can never exceed `0.75` for a learner with none of the three;
  no second `min()` clamp anywhere in the engine, ever), §5 (`ReadinessEvidence`'s
  exact shape and the "caller assembles the evidence, the engine only
  scores it" division of labor §6 below inherits unmodified).
- `docs/specs/practice-sessions.md` — §7 (the seven-step `normalizeAnswer`
  table, its worked examples, and the two known, accepted collisions —
  `its`/`it's` and `us`-as-pronoun — reused, never re-derived, in §2 below),
  §7.1 (`matchAnswer`'s exact-then-normalized two-pass discipline and its
  explicit refusal of any edit-distance or substring threshold — the same
  refusal this document restates for word-level alignment specifically in
  §9's rejected-alternatives row 5).
- `apps/api/src/practice/answer-matching.ts` — read directly: `normalizeAnswer`
  (line 274) is a pure, import-free function, `MAX_RESPONSE_LENGTH = 2000`
  (line 68), and the module's own header states the discipline this design
  inherits — "THERE IS NO EDIT DISTANCE HERE, AND THERE MUST NEVER BE ONE"
  (lines 23–51). §2 below is the twin statement for the reading scorer,
  spelled out at word granularity instead of whole-answer granularity.
- `apps/api/src/readiness/readiness-engine.ts` — read directly: `computeEnglish`
  (lines 327–338) is `Math.min(evidence.distinctQuestionsCorrectSpokenInEnglish
  / 20, 1)` today, and `ReadinessEvidence.distinctQuestionsCorrectSpokenInEnglish`
  (line 125) is the one field this epic's `ReadinessService` caller must stop
  hardcoding. `capReason` (lines 412–419) reads only
  `evidenceCounts.spoken.attempts` and `evidenceCounts.interview.attempts` —
  verified directly in the source, not inferred — which is the structural
  fact §6.3 below rests on: nothing this epic adds touches that computation
  at all, because `english` is not one of the two paths it reads.
- `apps/api/src/readiness/readiness.service.ts` — read directly, lines
  49–55 and 539–549: `distinctQuestionsCorrectSpokenInEnglish` is a literal
  `const … = 0`, with the service's own header comment stating plainly why
  ("never faked, never inferred from a proxy") and naming E11 as the epic
  expected to fix it — a forward reference this document's own existence
  supersedes, since it is E10, not E11, that ships spoken/typed English
  evidence. §6 below is the corrected assignment.
- `apps/api/src/readiness/top-recommendation.ts` — read directly:
  `EARNABLE_COMPONENT_KEYS` (lines 62–68) is a five-entry, **module-private**
  `const` — `coverage`, `recall`, `retention`, `consistency`, `remediation`
  — never exported, with the file's own header stating why `english`/
  `spoken`/`interview` are excluded today ("declared-but-unwired... recommending
  'go do more spoken/interview practice' would be recommending a feature
  that does not exist yet"). §6.4 below is the one-line edit this epic makes
  to that array once English practice is a real, routed destination.
- `apps/api/src/ai/ai.types.ts` — read directly, lines 606 and its preceding
  doc comment (approx. lines 588–606): `export const ASR_CONFIDENCE_THRESHOLD
  = 0.6`, with the comment's own words — "A `null` confidence NEVER reaches
  this comparison... Unknown is not low" — quoted verbatim in §3 below.
- `apps/web/src/components/voice/confidence.ts` — read directly, in full
  (60 lines): a second, **mirrored** (never fetched) copy of the same
  `0.6` constant and `isLowConfidence`, with the file's own header stating
  precisely why the mirror is safe — "THIS VALUE CHANGES WORDS. IT NEVER
  DECIDES AN OUTCOME... The server owns the verdict... if the two ever
  drift, a learner is invited to re-read a transcript that the server went
  on to trust, or not invited when it did not — a wording mismatch, never a
  wrong record." §3 below restates this reasoning for the reading test's own
  web mirror rather than re-deriving it.
- `apps/api/prisma/schema.prisma` — `PracticeOutcome` (lines 1279–1284:
  `correct` \| `partial` \| `incorrect` \| `skipped`) and `PracticeFailureCause`
  (lines 1355–1362, `misheard` already a member) — the two enums §5 below
  explicitly does **not** reuse (a new `EnglishOutcome` is declared instead,
  §5.1), and the `PracticeAttempt` model's column-comment convention (every
  nullable column's comment states which of several distinct reasons
  produced the null) that `english_attempts`' own columns follow.
- `apps/api/prisma/content/civics-2025.json` — read directly, lines 1–15:
  the exact provenance block shape §1.1 below mirrors field-for-field —
  `sourceUrl`, `retrievedAt` (`YYYY-MM-DD`), `sha256` (of the **downloaded
  source document**, never of the JSON file itself), and a nested
  `transcription: { status, warning }` block whose `warning` states, in
  full prose, precisely what was checked and by what method, and precisely
  what was *not* checked — e.g. "This was an owner sign-off on a machine
  transcription plus an automated source diff — it was NOT an independent
  page-by-page human re-read of the PDF, and this note says so rather than
  implying a stricter check than the one performed."
- `apps/api/prisma/content/load-content.ts` — read directly: the loader is a
  standalone, DI-free script (`CONTENT_DIR = __dirname`, no `@nestjs/*`
  import), every write goes through one `prisma.$transaction` per file, and
  re-running it against unchanged content writes nothing (`Counters.*Unchanged`
  fields exist specifically to prove this in a test). §1.3 below is this
  same idempotency contract applied to a fourth content file.
- `apps/api/prisma/content/validate-content.ts` — read directly: the
  `TranscriptionStatus` union (`UNVERIFIED_MODEL_DRAFT` \| `HUMAN_VERIFIED`
  \| `AWAITING_SOURCE`, lines 46–52) and the `IssueSeverity` union (`error`
  \| `known_gap` \| `warning`, line 106) — §1.4 below's "every word on the
  vocabulary list" check is a new rule in this same file's structural
  category (`error`, always enforced), not a content-completeness rule that
  can be downgraded to a `known_gap`.
- `apps/api/prisma/seed.ts` — read directly, line 3 and line 274:
  `loadAllCivicsContent(prisma)` is called as one `await` inside the seed
  script's own body, described in its neighboring comment as "a sibling
  step, idempotently, on every seed run" — the exact posture §1 below's
  sentence loader takes as well, added as a second sibling call, not folded
  into the civics loader's own function.
- `VISION.md` — line 29 / line 162, "practice reading and writing where
  applicable" (the requirement this epic exists to satisfy) and line 389,
  "We should never create pressure, shame, fear, or unhealthy compulsion to
  increase engagement metrics" (the rule §4's replay-count design and §3's
  misheard-is-absence design both answer to).
- `PRD.md` — line 35, "Readiness must develop over time and be supported by
  evidence from repeated practice, retention, spoken responses, realistic
  mock interviews, reading and writing exercises where applicable, and
  consistent performance" — English reading/writing named explicitly as one
  of the evidence types readiness is built from, not an afterthought bolted
  onto an existing component.
- `docs/specs/ai-settings.md` — the house shape this document's own
  structure copies: verified sources first, then the design, then a
  rejected-alternatives table, reasoning stated plainly, no marketing tone.
- The two official USCIS vocabulary PDFs themselves, downloaded and hashed
  directly — `reading_vocab.pdf` (rev. 08/08, 189,179 bytes, sha256
  `56be9761b36d44afdbf6efeb825330232bd089d55eb1cf2865d00999a98db04`, 64
  entries across 8 categories) and `writing_vocab.pdf` (rev. 08/08, 185,852
  bytes, sha256 `217244ecfb9ed6c5d79f9c281f9c1f6e4290ea358ced85192522b6218431bc0`,
  75 entries across 8 categories), both retrieved 2026-09-04 — and USCIS
  M-1178 (09/17), "Reading Vocabulary Word Strips," whose own instructions
  to the officers who compose test sentences §1.1 quotes verbatim: there is
  no official sentence list, only vocabulary lists, and the reading and
  writing lists are validated separately, never merged.

**Nothing described past this line exists yet**, with one exception already
noted above: the `english` readiness component (key, weight, and formula)
is already declared and already wired into `computeReadiness` — it has been
since E6 shipped — but its one input,
`distinctQuestionsCorrectSpokenInEnglish`, is a literal `0` in
`ReadinessService.assembleEvidence` today, verified directly in the source.
There is no `english_attempts` table, no `apps/api/prisma/content/english-*.json`
file (verified: `apps/api/prisma/content/` holds exactly `civics-2008.json`,
`civics-2025.json`, `load-content.ts`, `validate-content.ts`, and a
`__fixtures__` directory — no `english-*` file of any kind), no
`/api/english/*` route, and no `EnglishOutcome` enum anywhere in
`schema.prisma`. Every path cited above resolves today exactly as
described; every contract below is what this epic's child issues, and
issue #136 specifically for the API surface (§7), build *against*. A child
issue is free to find a better answer to a specific sub-problem as long as
it keeps the contracts this document promises to the pieces around it: the
provenance shape, the WER thresholds, the accent rule, the dictation-not-display
rule, and the readiness formula.

---

## 1. Sourcing

### 1.1 Vocabulary, not sentences, is what USCIS publishes

USCIS publishes reading and writing **vocabulary lists** — the finite set of
words a test-taker may be asked to read or write — never a list of complete
sentences. USCIS's own guidance to the officers who compose sentences says
this outright, and it is worth quoting rather than paraphrasing, because it
is the source itself stating there is nothing to transcribe as a sentence
list. From M-1178 (09/17), "Reading Vocabulary Word Strips":

> Examine the Reading Vocabulary Word List and create as many interrogative
> sentences (or questions) as you can, using only the words on the list.

> Each reading test administered to an applicant will contain no more than
> three (3) sentences. An applicant must read aloud one (1) out of three (3)
> sentences correctly in order to demonstrate an ability to read in English.

> While the reading and writing vocabulary lists have some shared vocabulary
> on civics and history, the lists are not the same. When creating your
> sentences, keep the lists and activities separate to avoid confusing your
> students.

Two consequences of the source's own words, both load-bearing for this
design: **the vocabulary list, not any particular sentence, is the actual
official artifact** — so §1.2 below composes sentences the same way a real
USCIS officer does, from the list, rather than transcribing a sentence list
that does not exist; and **the reading and writing lists are validated
SEPARATELY, never merged into one allowed-word set** — a word can be legal
in a writing sentence and illegal in a reading sentence, or vice versa (the
source's own "the lists are not the same" is not a formality: `taxes` and
`and` sit on the writing list and not the reading list; `many`, `colors`,
and every question word — `who`/`what`/`when`/`where`/`why`/`how` — sit on
the reading list and not the writing list). §1.4's validator checks a
reading sentence against the reading list and a writing sentence against
the writing list, and never checks either against their union.

Two files, siblings of the civics content already under
`apps/api/prisma/content/`, each carrying the **identical** top-level
provenance shape `civics-2025.json` uses — field-for-field, because it
answers the identical question ("where did this content come from, and how
sure are we it's right") for a different content domain — populated with
the real, verified values below rather than a placeholder:

**`apps/api/prisma/content/english-vocabulary-reading.json`**

```json
{
  "provenance": {
    "sourceUrl": "https://www.uscis.gov/sites/default/files/document/guides/reading_vocab.pdf",
    "label": "Reading Vocabulary for the Naturalization Test (rev. 08/08)",
    "retrievedAt": "2026-09-04",
    "sha256": "56be9761b36d44afdbf6efeb825330232bd089d55eb1cf2865d00999a98db04",
    "byteSize": 189179,
    "transcription": {
      "status": "HUMAN_VERIFIED | UNVERIFIED_MODEL_DRAFT | AWAITING_SOURCE",
      "warning": "<full prose: exactly what was verified, exactly what was not, by whom, and how>"
    }
  },
  "categories": ["PEOPLE", "CIVICS", "PLACES", "HOLIDAYS", "QUESTION WORDS", "VERBS", "OTHER (FUNCTION)", "OTHER (CONTENT)"],
  "entryCount": 64
}
```

**`apps/api/prisma/content/english-vocabulary-writing.json`**

```json
{
  "provenance": {
    "sourceUrl": "https://www.uscis.gov/sites/default/files/document/guides/writing_vocab.pdf",
    "label": "Writing Vocabulary for the Naturalization Test (rev. 08/08)",
    "retrievedAt": "2026-09-04",
    "sha256": "217244ecfb9ed6c5d79f9c281f9c1f6e4290ea358ced85192522b6218431bc0",
    "byteSize": 185852,
    "transcription": {
      "status": "HUMAN_VERIFIED | UNVERIFIED_MODEL_DRAFT | AWAITING_SOURCE",
      "warning": "<full prose: exactly what was verified, exactly what was not, by whom, and how>"
    }
  },
  "categories": ["PEOPLE", "CIVICS", "PLACES", "MONTHS", "HOLIDAYS", "VERBS", "OTHER (FUNCTION)", "OTHER (CONTENT)"],
  "entryCount": 75
}
```

`sha256` hashes the source PDF, never the JSON — identical to
`civics-content.md` §6's stated reason: it is a receipt that proves which
exact revision of the official material was on hand at transcription time,
distinct from any hash computed later over the loaded JSON's own content.
`retrievedAt` is a calendar date, `YYYY-MM-DD`, matching the civics
content's own format; `byteSize` is recorded alongside the hash purely as a
second, cheap sanity check a reviewer can eyeball before re-deriving the
full hash. The `transcription.warning` field is **required**, not optional,
and must be full prose stating precisely what was checked and by what
method — `civics-2025.json`'s own warning (quoted in the source list above)
is the model to follow: it names the exact verification method used,
states plainly what that method does *not* establish, and does so without
inflating the confidence of the claim. The reading list's 8 categories
(`PEOPLE`, `CIVICS`, `PLACES`, `HOLIDAYS`, `QUESTION WORDS`, `VERBS`,
`OTHER (FUNCTION)`, `OTHER (CONTENT)`) and the writing list's 8 categories
(the same set with `HOLIDAYS`... `QUESTION WORDS` swapped for `MONTHS`) are
USCIS's own category headings, transcribed verbatim — not invented for this
design — and are what §1.4's `vocabTags` derivation below reads from.

### 1.2 Sentences are composed by a human, not sourced — and interrogative for reading, declarative for writing

Sentences live in a third file: `apps/api/prisma/content/english-sentences.json`.
Unlike the two vocabulary files, this file has no `sourceUrl` in the usual
sense — there is no official sentence list to transcribe from, per §1.1's
own quoted source — but it still carries the same provenance shape, with
`sourceUrl` naming the two vocabulary files it was composed against (by
path, not URL) and `transcription.warning` stating who composed the
sentences and who reviewed them, by name, in the same PR that added or
changed them. "Content is data, not code" (`civics-content.md` §7) applies
here exactly as it does to civics questions: a sentence is not a constant a
developer edits inline in TypeScript, it is versioned, provenance-tracked
JSON, reviewed the same way a civics content PR is reviewed
(`civics-content.md` §6.1) — a human states the source (here: which two
vocabulary lists were drawn from), a second human reviews the actual
content before merge, and the PR itself is the record of who composed and
who approved.

**Reading sentences are phrased as questions; writing sentences are
declarative statements.** This is not a style choice this document is
making up — it is §1.1's own quoted USCIS instruction ("create as many
INTERROGATIVE sentences (or questions) as you can") for the reading list,
and the real interview's own shape for the writing list: an officer
*dictates* a statement for the applicant to write, never a question. Each
`english-sentences.json` entry therefore carries its `kind` (`reading` \|
`writing`) and its text is composed accordingly — "What is the capital of
the United States?" is a legitimate reading-list sentence; "The capital is
Washington, D.C." is a legitimate writing-list sentence; the two kinds are
never interchanged. `civics_questions.dynamicScope`'s own per-row
distinctness (`civics-content.md` §2.2) is the same idea one column over:
a fact fixed on the content row, not something the loader or the scorer
infers at read time.

**One quirk composers must watch for, verified directly against
`normalizeAnswer`'s own abbreviation table (`answer-matching.ts`, step 4):
a sentence naming "President of the United States" in full normalises
identically to one naming only "President."** The table collapses the
five-token phrase `president of the united states` to the single token
`president` before scoring ever runs — the same collapse civics answers
already rely on (`practice-sessions.md` §7's own worked example). A
sentence composer who intends two genuinely different reading sentences
must not lean on that phrase's presence or absence as the only thing that
distinguishes them; §1.3's idempotent loader, keyed on normalised content
where it needs to detect a real change, would otherwise see the same
normalised text twice and treat what the composer meant as two sentences
as one.

### 1.3 Loaded idempotently, as a sibling step

`apps/api/prisma/seed.ts` gains a second, sibling call alongside
`loadAllCivicsContent(prisma)` — call it `loadEnglishContent(prisma)`,
living in `apps/api/prisma/content/load-english-content.ts`, a sibling file
of `load-content.ts`, not a branch added inside it: the two content domains
share a loading *posture* (standalone script, one transaction, idempotent
re-run) but not a schema, a validator, or a set of tables, so folding one
into the other's function would tangle two independent lifecycles the way
`civics-content.md` §7 already argues against for civics content and
`seed.ts` itself (roles/permissions/admin bootstrap, a separate small
lifecycle from content). Idempotency follows `load-content.ts`'s own
contract exactly: keyed on each sentence's own stable id (or, absent one,
its own text — the loader's own issue decides which), re-running the loader
against unchanged content must write nothing, and every insert or update is
preceded by a value comparison, the identical discipline
`civics-content.md` §7 states for the civics loader and
`load-content.ts`'s own `Counters.*Unchanged` fields exist to prove.

### 1.4 Every word must appear on the matching vocabulary list — enforced, not merely reviewed

**The exact validation algorithm.** A vocabulary entry containing a `/`
(`"state/states"`, `"is/are/was/be"`, `"one hundred/100"`) expands to its
alternatives — `["state", "states"]`, `["is", "are", "was", "be"]`,
`["one hundred", "100"]`. Each resulting alternative is tokenised the same
way `normalizeAnswer` tokenises any input — the identical full pipeline §2
below reuses for scoring, applied here too rather than only to its early
splitting step, and deliberately so: tokenising only steps 1–3 (before
abbreviation expansion) would leave a vocabulary entry like `"Washington,
D.C."` as the three separate tokens `washington`, `d`, `c`, but a learner's
sentence containing "D.C." will itself have already been expanded by step
4's abbreviation table to `washington district of columbia` by the time it
is scored — verified directly: `normalizeAnswer("Washington, D.C.")` →
`"washington district of columbia"`, not `"washington d c"`. Tokenising the
vocabulary list through anything less than the full pipeline would produce
allowed tokens (`d`, `c`) that can never actually appear in a normalised
sentence, and would fail to produce the token (`district`) that can. Every
alternative's tokens, across every entry, are unioned into that list's flat
allowed-token set.

A sentence is **valid** when every one of its own tokens — the sentence's
text run through the identical `normalizeAnswer` pipeline and split on
whitespace, per §2.1 — appears in the matching list's allowed-token set (the
reading list for a `kind: 'reading'` sentence, the writing list for
`kind: 'writing'`, per §1.1's separate-lists rule). **A test enforces
this, in the same structural-rule category `validate-content.ts`'s `error`
severity already occupies** (never a `known_gap`, never a `warning` — a
sentence containing an off-list token is a bug in the file regardless of
how "finished" the file otherwise claims to be). Composition is by a
human, review is by a second human, and both are recorded in the PR — the
same content-PR discipline `civics-content.md` §6.1 already establishes,
restated here for a different content domain rather than invented anew.

**`vocabTags` is derived, never hand-authored.** For each token in a
sentence, find which vocabulary entry (or entries) it resolved from, and
take that entry's category (§1.1's 8-value set); a sentence's `vocabTags`
is the union of every category any of its tokens resolved to. This is the
identical "derive it from the lookup that already has to run, never store
a second, hand-typed copy of a fact the list already holds" discipline
`readiness-model.md` §2.6 already states for a shared denominator, applied
here to a tag set instead of a number: a composer who hand-typed
`vocabTags: ["PEOPLE", "CIVICS"]` could drift from what the sentence's own
words actually resolve to the moment either vocabulary file is corrected,
with nothing to catch the mismatch; a derived tag set cannot drift, because
it is recomputed from the same validation pass that already has to run for
§1.4's own enforcement.

**Sentences are NEVER model-generated, and the reasoning is worth stating
in full rather than left as a bare prohibition.** A sentence containing one
word outside the official vocabulary teaches material the real test will
never use — and it does so **invisibly**. The wrong sentence *looks* right:
it reads as grammatical, plausible English, indistinguishable at a glance
from a sentence built entirely from the approved list. A human reviewer
skimming the file for sense would not catch it, because nothing about the
sentence looks wrong — it only fails when checked mechanically, word by
word, against the list. This is precisely the failure mode a model is
worst positioned to avoid: a language model's whole competence is producing
fluent, plausible sentences, which is exactly the property that makes an
off-vocabulary word in its output undetectable by inspection. The
enforced test in this section exists because "review it and it'll look
fine" is not sufficient — the check has to be exhaustive and mechanical,
not a matter of a reviewer's attention holding up across every sentence.

---

## 2. Reading scoring — word error rate

### 2.1 Normalisation, reused

Both the reference sentence and the learner's confirmed transcript (§3) are
normalised through `normalizeAnswer`
(`apps/api/src/practice/answer-matching.ts`, imported, **never
re-implemented**) — the identical seven-step pipeline E3's grader already
runs: Unicode NFKC + lowercase, strip leading filler, strip possessives and
punctuation, expand fixed abbreviations, drop leading articles, rewrite
number words to digits, collapse whitespace. This is the same reuse
`docs/specs/practice-sessions.md` §7 already documents in full; it is not
re-derived here.

After normalisation, both strings are split on whitespace into word
tokens — `normalizeAnswer`'s own output is already whitespace-collapsed and
free of empty tokens (§7's own "free by construction" note), so
`.split(' ')` over its result needs no further cleanup.

**Worked example, checked against the actual function rather than assumed:**
the reference sentence "George Washington was the first President."
normalises as follows — step 1 lowercases and trims; step 3 strips the
trailing period as punctuation (spaced, not deleted, though at a token
boundary this is equivalent to dropping it); step 4's abbreviation table has
no entry for any of these tokens (`george`, `washington`, `was`, `the`,
`first`, `president` — none match `president of the united states`, `u s`,
`u s a`, `d c`, `usa`, `us`, `dc`, or `potus`); step 5 drops the leading
article only if the sentence *begins* with one — this sentence begins with
"George," not "the," so nothing is dropped here (the word "the" mid-sentence
is untouched — step 5 is leading-only); step 6 rewrites the ordinal "first"
to the digit `1`. The normalised form is:

```
george washington was the 1 president
```

— **6 word tokens**: `["george", "washington", "was", "the", "1",
"president"]`, verified by actually running `normalizeAnswer` rather than
counting by hand. (An earlier draft of this document assumed "first"
survives as a word and "the" is dropped as an article; checking against
the actual function shows the opposite is true — "the" is mid-sentence and
step 5 only strips a *leading* article, while "first" is rewritten to "1"
by step 6. This is exactly why every claim in this document about
`normalizeAnswer`'s behavior is checked against the running code rather
than assumed from its name — including, later in this document, one
composed sentence that turned out to collapse identically with a shorter
one purely through step 4's abbreviation table, §1.2's own worked
caution.)

### 2.2 Word-level alignment

Given the normalised reference (`R`, `n` tokens) and the normalised,
learner-confirmed hypothesis (`H`, `m` tokens), align them with the
standard Wagner–Fischer dynamic-programming edit-distance algorithm, run
over **word tokens** rather than characters. The alignment yields a
sequence of operations:

- `match` — a reference word appears, unchanged, at the corresponding
  position.
- `substitute` — a reference word is replaced by a different word.
- `delete` — a reference word is missing entirely (the learner skipped it).
- `insert` — a word appears that is not in the reference (the learner added
  something).

```
errors = substitutions + deletions + insertions
wer    = errors / referenceWordCount
```

`referenceWordCount` is `R`'s own token count (`n`), never the hypothesis's
— WER is a rate against what *should* have been said, not against what
*was* said, which is the standard definition and the one that makes the
metric comparable across attempts at the same sentence regardless of how
much the learner over- or under-said. `errors` — the raw op count, before
it is divided by anything — is carried forward as its own value, because
§2.3's outcome rule reads it directly and not only through `wer`.

### 2.3 The outcome rule — error count first, WER as a bound

```ts
export const WER_CORRECT_MAX = 0.34;
export const WER_PARTIAL_MAX = 0.50;

function classify(errors: number, wer: number): 'correct' | 'partial' | 'incorrect' {
  if (errors === 0 || (errors === 1 && wer <= WER_CORRECT_MAX)) return 'correct';
  if (wer <= WER_PARTIAL_MAX) return 'partial';
  return 'incorrect';
}
```

**This is a compound rule, not a bare WER comparison, and the reason is
worth stating precisely rather than asserted as a constant choice.** The
product truth this rule exists to express is: **one word wrong is not a
failure; two words wrong is not reading the sentence.** A single flat WER
threshold cannot express that truth, because `english-sentences.json`'s
sentences run **3 to 8 words** after normalisation — the writing list's
shortest entries, "We pay taxes." and "Citizens can vote.", both normalise
to exactly 3 tokens (verified: `normalizeAnswer("We pay taxes.")` →
`"we pay taxes"`) — and any single WER threshold is either too strict on a
short sentence or too lenient on a long one: **one** error in a 3-word
sentence is already `wer = 1/3 = 0.333`, while **two** errors in an
8-word sentence is only `wer = 2/8 = 0.25` — a smaller WER for a
*worse* mistake (two wrong words, not one) purely because the sentence
happened to be longer. A flat threshold set low enough to reject the
2-error/8-word case (`0.25`) would also reject the 1-error/3-word case
(`0.333`), penalizing a single slip on the shortest sentences in the set
exactly as hard as two genuine misses on the longest ones.

The compound rule separates the two questions a flat threshold conflates:
**how many words were actually wrong** (`errors`) decides whether this was
"one slip" or "actually didn't read/write it," and **WER bounds how much
one slip is allowed to cost** on a very short sentence, where a single
error is unavoidably a large fraction of the total. `WER_CORRECT_MAX =
0.34` is calibrated to the shortest sentences in the set: on a 3-word
sentence, one error is `1/3 = 0.333 ≤ 0.34` — admitted, exactly what "one
slip on the shortest sentence in the bank" should mean — while on a
hypothetical 2-word fragment, one error would be `1/2 = 0.50 > 0.34`,
correctly refused by the `errors === 1` clause even though it is still
only one wrong word, because missing one word out of two is missing half
the sentence, not "one slip." `WER_PARTIAL_MAX = 0.50` is the outer bound
for `partial` — a fallback for every case the `correct` clause does not
reach (two or more errors, or an `errors === 1` case whose sentence is too
short for `0.34` to admit) — set at "no more than half wrong," the same
"more wrong than right" line `WER_CORRECT_MAX` already uses for the
single-error edge case, applied here to the aggregate.

WER itself is still computed and still stored (`english_attempts.wer`,
§5.2) for every attempt — it is the reported measure, the number a diff
explains, and what `errors`'s bare count alone cannot convey (a `wer` of
`0.05` and a `wer` of `0.33` can both be a single `errors === 1` case, and
the stored value is what lets a later reader, or the Progress Guide
narrative, tell them apart) — but **the outcome itself is never a bare
comparison of `wer` against a threshold.** `errors` is checked first.

### 2.4 The required table

Reference: **"George Washington was the first President."** — normalised
to `george washington was the 1 president` (6 tokens, per §2.1). Every row
below was produced by actually running `normalizeAnswer` and a word-level
edit-distance alignment over the two normalised strings, not hand-counted —
including the discovery, below, that one originally-planned "insertion"
example turned out to normalise identically to the reference and had to be
replaced, which is itself the exact discipline §1.2's own worked caution
about the abbreviation table names.

| # | Attempt (confirmed transcript, raw) | Normalised hypothesis | Diff vs. reference | `errors` | `wer` | Outcome |
|---|---|---|---|---|---|---|
| 1 | "George Washington was the first President." | `george washington was the 1 president` | 6/6 match, 0 ops | 0 | `0/6 = 0.000` | `correct` (`errors === 0`) |
| 2 | "George Washington was first President." (dropped "the") | `george washington was 1 president` | 1 deletion (`the` missing) | 1 | `1/6 = 0.167` | `correct` (`errors === 1`, `0.167 ≤ 0.34`) |
| 3 | "George Washington was the first leader." | `george washington was the 1 leader` | 1 substitution (`president` → `leader`) | 1 | `1/6 = 0.167` | `correct` |
| 4 | "George Washington was our first President." | `george washington was our 1 president` | 1 substitution (`the` → `our`) | 1 | `1/6 = 0.167` | `correct` |
| 5 | "Washington was the first President." (dropped "George") | `washington was the 1 president` | 1 deletion (`george` missing) | 1 | `1/6 = 0.167` | `correct` |
| 6 | "George Washington the first President." (dropped "was") | `george washington the 1 president` | 1 deletion (`was` missing) | 1 | `1/6 = 0.167` | `correct` |
| 7 | "George Washington Adams was the first President." (added a name) | `george washington adams was the 1 president` | 1 insertion (`adams`) | 1 | `1/6 = 0.167` | `correct` — the same `errors === 1` clause admits an insertion exactly as it admits a substitution or a deletion; the rule counts wrong words, not their direction. |
| 8 | "George Washington really was truly the first President." (two insertions) | `george washington really was truly the 1 president` | 2 insertions (`really`, `truly`) | 2 | `2/6 = 0.333` | `partial` — `errors !== 1`, so the `correct` clause never applies regardless of how low `wer` is; `0.333 ≤ 0.50` keeps it `partial` rather than `incorrect`. |
| 9 | "Well George Washington was the first President I believe." (filler front and back) | `well george washington was the 1 president i believe` | 3 insertions (`well` prepended; `i`, `believe` appended) — the 6-token reference matches in full, unbroken, in the middle | 3 | `3/6 = 0.500` | `partial` — the required **boundary** case, pinned exactly at `WER_PARTIAL_MAX`: `0.500 ≤ 0.50` is still `partial`, the same `<=`-not-`<` discipline `readiness-model.md` §12's Day 2 worked example already uses to pin a threshold boundary deliberately rather than leave it untested. |
| 10 | "Washington was our leader." (dropped "George", substituted "the"→"our", dropped "first", substituted "president"→"leader") | `washington was our leader` | 2 deletions (`george`, `1`) + 2 substitutions (`the`→`our`, `president`→`leader`) = 4 ops | 4 | `4/6 = 0.667` | `incorrect` — the required genuine failure: `errors !== 1` and `wer = 0.667 > 0.50`, past even the `partial` bound. |

Row 2–7 are the required near-misses that pass; row 10 is the required
genuine failure that does not. Rows 8–9 additionally exercise the
`partial` band the compound rule (§2.3) creates that a flat threshold
would not necessarily separate out as cleanly — including row 9 pinned
exactly at the `WER_PARTIAL_MAX` boundary, the same deliberate
boundary-pinning `readiness-model.md` §12 already uses elsewhere in this
codebase to make a threshold's edge an asserted fact rather than an
untested assumption.

**A worked caution, kept in the table rather than deleted, because it is
exactly the kind of error this document's own "checked against the running
code, never assumed" discipline exists to catch:** an earlier draft of
this table used "George Washington was the first President **of the
United States**." as its genuine-failure row, expecting four insertions.
Run through the real `normalizeAnswer`, that sentence normalises to
`george washington was the 1 president` — **identical to the reference,
zero errors** — because step 4's abbreviation table collapses `president
of the united states` to `president` before scoring ever sees the extra
words (§1.2's own worked caution about this exact collapse). What looked,
by eye, like an obvious over-reading failure is a perfect `correct` match
once actually normalised. The row was replaced with row 10 above, which
was independently re-verified the same way. This is not a hypothetical
risk this document is warning about in the abstract — it is a mistake this
document's own first draft made and caught only by running the code.

---

## 3. The accent rule (inherited from epic #58 / issue #104)

A reading attempt's audio is transcribed by the existing
`POST /api/ai/speech/transcribe` (`docs/specs/voice.md` §9) — no new
transcription route for reading; this epic is a **new caller** of the
speech surface E9 already shipped, not a second implementation of it. The
learner is shown the transcript and **may confirm it as-is or edit it**
before anything is scored — the identical confirm-before-grade mechanism
`docs/specs/voice.md` §3 already builds for spoken civics answers, reused
verbatim rather than re-derived: "the learner sees the transcript and can
edit it before anything is graded... the confirm step is not optional UI
polish, it is the entire anti-penalty mechanism."

**`ASR_CONFIDENCE_THRESHOLD` is `0.6`, strictly below, and `null` means
unknown — unknown is NOT low.** The API constant
(`apps/api/src/ai/ai.types.ts`, `export const ASR_CONFIDENCE_THRESHOLD =
0.6`) is what the server compares against; the web mirror
(`apps/web/src/components/voice/confidence.ts`, same value, same
`isLowConfidence` semantics) is what decides the confirmation screen's
copy before any request is sent. The mirror is safe for the exact reason
its own file header states, quoted rather than re-argued: "THIS VALUE
CHANGES WORDS. IT NEVER DECIDES AN OUTCOME... if the two ever drift, a
learner is invited to re-read a transcript that the server went on to
trust, or not invited when it did not — a wording mismatch, never a wrong
record." A `null` confidence is never coerced to `0` on either side —
several transcription models report no confidence at all, and treating
unknown as maximally uncertain would flag every transcript from those
models as suspect for a reason that never actually applied.

**Low confidence plus a non-`correct` outcome ⇒ the response is
`misheard`, and no `english_attempts` row is written at all; the learner
is offered a retry.** This is stated as plainly as possible because it is
the single most load-bearing rule in this section: **`misheard` is not an
outcome value here. It is the absence of a recorded failure.** Nothing is
written to `english_attempts` for that submission — no row, no
`outcome: 'incorrect'`, nothing. The learner sees a "that may not be what
you said — try again?" screen and either re-records or types the sentence
instead, and only the retry, once it is either high-confidence or scored
`correct`/`partial` outright, produces a row.

**This is a deliberate, structural divergence from practice's own
`misheard` handling, and the difference is worth stating precisely rather
than left for a reader to reconcile on their own.** In practice
(`docs/specs/voice.md` §3.1), `misheard` is a `failureCause` set on a
`practice_attempts` row that **is** written — the attempt is graded
normally, the outcome the grader produced stands untouched, and
`failureCause: 'misheard'` is set as an annotation explaining *why* it
missed, with the raw graded row kept as real evidence a mishearing
happened and a retry linked to it via `retryOfAttemptId`. Reading is
different because **the thing being measured IS the transcript.** A civics
practice attempt records what the learner *knew* — the transcript is a
means of finding out, and even a mistrusted transcript is evidence that an
attempt happened and roughly what shape the answer took. A reading attempt
records **whether the learner could produce a specific, exact sequence of
words** — WER is computed over the transcript's own text, so if the
transcript itself is not trustworthy, there is no fact left to record at
all: a "reading attempt" whose transcript we do not believe is not
weak evidence of a reading skill, it is no evidence of one. Writing an
`incorrect` (or even a specially-flagged) row in that case would misrepresent
a transcription failure as a reading failure, exactly the conflation E9's
confirm-before-grade mechanism already exists to prevent one layer down —
this section takes that same principle one step further and concludes that
for reading specifically, the honest response to "we don't trust what we
heard" is to record nothing, not to record something hedged.

---

## 4. Writing is dictated, not shown

**The sentence is spoken and never rendered on screen before submission.**
Displaying the sentence's text would let the learner **type what they can
see**, which measures typing accuracy against a visible reference, not
whether they can produce written English from a spoken prompt — a
different, easier task than what the actual naturalization interview
requires (the officer reads the sentence aloud; the applicant has never
seen it in writing). Stating this plainly: showing the sentence silently
changes what is being tested, from "can this learner write English they
hear" to "can this learner copy text," and the second skill says nothing
useful about readiness for the real interview.

**Dictation defaults to the browser's own `window.speechSynthesis`** — no
binding required, no admin configuration, no per-call cost — the identical
default `docs/specs/voice.md` §2 already locks for reading a civics
question aloud: "Hear this question aloud ships on day one... on every
deployment, with no admin action, no credential, and no per-call cost." The
`speak` AI model role (`AI_MODEL_ROLES`, already wired since E9) is the
same **optional premium upgrade** it already is for civics questions — a
higher-quality, provider-hosted voice an admin may bind, dispatched through
`POST /api/ai/speech/synthesize`, never the only way to hear the sentence.
No new role, no new binding, no new degradation-rule table: this epic is a
second caller of an already-wired role, not a third role.

**Replays are permitted and counted.** The attempt request carries a
`replayCount` field — how many times the learner asked to hear the
sentence again before submitting a written answer — and **nothing is
gated on the count**: a learner may replay as many times as they like with
no penalty to their outcome and no limit enforced server-side. The count
is recorded because needing four repeats **is itself a signal** worth
having — a learner who reliably needs several replays to catch a sentence
is telling the product something about their listening comprehension that
a single pass/fail outcome does not capture — but it is a signal recorded
for later analysis and coaching copy, never a signal that changes the
grade of the attempt it's attached to. This is the same restraint
`VISION.md` line 389 requires elsewhere ("We should never create pressure,
shame, fear, or unhealthy compulsion") applied to a specific design
decision: penalizing replay count would punish exactly the honest,
information-seeking behavior (asking to hear it again rather than
guessing) the product should want to encourage.

**If the browser has no `speechSynthesis` support AND `speak` is unbound,
the screen says so plainly and offers reading practice instead — it NEVER
falls back to showing the sentence.** This is the same "never silently
substitute an easier or different task" rule this section opens with,
applied to the degraded-availability case rather than the happy path: a
learner in that state is told the writing segment cannot run right now
(the honest-absence idiom `civics-content.md` §5 and `journey-shell.md`
§10 both already establish elsewhere in this codebase — a designed
absence, stated in plain language, never a fabricated stand-in) and
pointed at reading practice, which needs no audio playback to function
correctly on its own read-aloud-by-the-learner design. Falling back to
displaying the sentence would silently and invisibly convert "writing
practice" into "copying practice," exactly the substitution this section's
opening paragraph rules out — an unavailable feature must fail visibly,
never degrade into a different, easier feature wearing the same name.

**Input field constraints.** The text input the learner types into
disables, at the HTML/component level: `spellcheck`, `autocorrect`,
`autocapitalize`, and `autocomplete`. Each of the four would let the
platform silently correct, capitalize, or suggest text the learner did not
actually produce, which would grade the platform's assistance rather than
the learner's own written English — the identical "assisted evidence is
weaker evidence" principle `docs/specs/readiness-model.md` §2.2 already
states for civics practice's `hintUsed`/`revealed` filter, applied here at
the input-affordance level instead of the scoring level, because unlike a
hint button a spellchecker's correction is not optional or visible as an
event to filter on afterward — it has to be prevented from happening in
the first place.

**Scoring is the identical scorer, unmodified**, §2's normalisation,
word-level alignment, and the same `WER_CORRECT_MAX`/`WER_PARTIAL_MAX`
thresholds — with **no ASR confidence input at all**, because there is no
speech recognition step in the writing path: the learner typed the words
directly, so there is nothing analogous to §3's transcript-trust question
to resolve. A writing attempt's `outcome` is computed straight from
`matchWordErrorRate(reference, typedText)` (§2) with no gate in front of it.

---

## 5. The `english_attempts` table

A new table, `english_attempts`, sibling in shape to `practice_attempts`
but genuinely its own table rather than a widened `practice_attempts` row
— the two evidence streams measure different things (a civics fact known
vs. an English sentence read or written) and would otherwise force
`practice_attempts` to carry columns (`werValue`, `diffOps`, `kind: reading
| writing`, `replayCount`) meaningless for every civics row, the identical
"a JSON blob/overloaded table forces every operation to load, mutate, and
write back the whole irrelevant shape" reasoning `civics-content.md` §1
already gives for not folding categories/questions/answers into one blob.

### 5.1 A new, closed outcome enum — not `PracticeOutcome` reused

```prisma
enum EnglishOutcome {
  correct
  partial
  incorrect
}
```

Three values, not `PracticeOutcome`'s four: **there is no `skipped`
analogue here in the same sense.** A civics practice question can be
explicitly skipped without an attempt at all; a reading/writing segment
that the learner declines is, per §3, either never submitted (no row) or
— for a low-confidence reading recording — the `misheard`-is-absence case,
which is also no row. There is no state in this design where a submission
happened, the learner did attempt it, and the honest outcome is "skipped"
distinct from "incorrect" — a blank or empty typed answer normalises to a
string with a WER of 1.0 against the reference (every reference word
missing, zero matches), which correctly lands `incorrect` under §2.3's
thresholds with no separate enum value required. Reusing `PracticeOutcome`
would import a `skipped` value with no way to ever produce it here, and
would also tie this table's schema to a civics-specific enum for no shared
behavior — the two enums happen to overlap on three of four names today,
which is coincidence, not a reason to couple them.

### 5.2 Columns

| Column | Prisma type | Nullable | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `userId` | `String @map("user_id") @db.Uuid` | no | FK → `users.id`, `onDelete: Cascade` — an attempt has no meaning independent of the learner who made it, the identical posture `PracticeAttempt.userId` already takes. |
| `sentenceId` | `String @map("sentence_id") @db.Uuid` | no | The `english-sentences.json` entry this attempt was scored against (the loader's stable id, §1.3). |
| `kind` | `EnglishSegmentKind` (Postgres enum: `reading` \| `writing`) | no | Which segment produced this row. `english-sentences.json`'s own entries are scoped to one kind or the other (a reading sentence draws only from the reading vocabulary, a writing sentence only from the writing vocabulary, per §1.4), so this column is redundant with the sentence's own file-of-origin in principle but kept as a real column for the same reason `inputMode`/`source` are real columns on `practice_attempts` rather than re-derived on every read: it is queried and filtered on directly (readiness evidence, §6, groups by it). |
| `responseText` | `String @db.Text @map("response_text")` | no | The text actually scored — for writing, exactly what the learner typed; for reading, the learner-CONFIRMED transcript (§3), never the raw, unedited recognizer guess, the identical "confirmed, not raw" rule `docs/specs/voice.md` §3.1 states for `practice_attempts.transcript`. Never null: per §3, a low-confidence reading attempt that is not confirmed/corrected produces no row at all, so every row that exists has real, scored text behind it. |
| `asrConfidence` | `Float? @map("asr_confidence")` | yes | Reading only — the recognizer's own confidence for the transcript that became `responseText`, `0`–`1`. Null for a writing attempt (there is no recognition step, §4's own closing paragraph) and null whenever the provider reported no confidence at all — never defaulted to `0` or `1`, identical reasoning to `PracticeAttempt.asrConfidence`'s own column comment. |
| `wer` | `Float @map("wer")` | no | The exact word-error-rate value §2.2 computed, stored rather than only derived from `outcome`, so a later reviewer (or the Progress Guide narrative, `readiness-model.md` §9) can see *how close* an `incorrect` attempt actually was, not merely that it missed. |
| `diffOps` | `Json @map("diff_ops")` | no | The alignment's own op sequence — `match`/`substitute`/`delete`/`insert`, each carrying the reference word, the hypothesis word (or null for a delete/insert), and position — the same "store the structured verdict, never a free-text summary" posture `PracticeAttempt.aiFeedback`'s column comment already states for a different table, reused here because a diff a UI can render word-by-word (a highlighted "missed word" / "added word" screen) is strictly more useful than a WER number alone, and it is exactly what §2's alignment already computed — nothing extra is derived to produce it. |
| `outcome` | `EnglishOutcome` | no | From §2.3's thresholds, applied identically to both `kind`s. |
| `replayCount` | `Int @default(0) @map("replay_count")` | no | Writing only in practice (§4) — always `0` for a reading row, since reading has no dictation-replay concept of its own (the learner controls their own re-recording, which is a retry, not a replay of a prompt). Never gates the outcome (§4). |
| `answeredAt` | `DateTime @db.Timestamptz @map("answered_at")` | no | Via `Clock.now()`, injected — never a bare `new Date()`, per `CLAUDE.md`'s "Using the Clock" rule, restated here the same way `civics-content.md` §10 restates it for its own epic rather than assuming it carries over silently. |
| `createdAt` / `updatedAt` | `DateTime @db.Timestamptz` | no | House convention. |

```
@@index([userId, kind, answeredAt])
@@map("english_attempts")
```

No `sessionId`, no `practiceSessionId` — reading and writing practice is
not modeled as a `practice_sessions` row in this design (§7's endpoints are
stateless per-attempt calls, not session-scoped the way civics Quick
5/category drills are), so there is no session table for this row to join
against. Whether a future epic wraps a sequence of English attempts into a
session-like grouping is left open and does not need this table's shape to
change to accommodate it later — `userId` + `answeredAt` already lets any
future grouping be reconstructed by range query.

---

## 6. The `english` readiness component

### 6.1 The window is the decay

`ENGLISH_WINDOW_DAYS = 30`. Only `english_attempts` rows from the trailing
30 days count toward the component at all — the window itself **is** the
decay mechanism, the same shape `consistency`
(`readiness-model.md` §2.4) already uses: a rolling window read fresh on
every snapshot computation, with no separate decay curve, no half-life
formula, and no stored "freshness" value anywhere. An attempt that ages
past 30 days simply stops counting, the same way a practice day ages out
of `consistency`'s 14-day window.

**Why 30 and not `consistency`'s 14 — stated as reasoning, not asserted.**
Civics questions are practiced far more often than English segments in the
ordinary shape of a learner's routine — a Quick 5 touches five civics
questions in one sitting, while a reading/writing segment is a much
smaller, more occasional slice of practice time. A 14-day window applied
to English evidence would zero out a learner who did solid English
practice three weeks ago and has simply been focused on civics review
since — an honest reading of "this learner cannot currently produce this
kind of evidence" that would actually be false; the evidence exists, it is
merely outside an unnecessarily tight window. 30 days is wide enough to
keep a learner's most recent real English practice in view through an
ordinary few weeks of civics-heavy study, while still being a **rolling**
window rather than "ever" — a learner who did English practice once, six
months ago, and never again should not still be credited for it today,
which "ever" would do and 30 days does not.

### 6.2 Per-sentence credit and the target denominators

Within the 30-day window, credit each **distinct sentence** by that
sentence's **best** in-window outcome — a sentence attempted three times
in the window, twice `incorrect` and once `correct`, counts once, at
`correct`'s credit:

```
correct = 1.0
partial = 0.5
anything else (no attempt / only incorrect attempts in-window) = 0
```

`0.5` for `partial` is not a new number invented for this component — it
is `recall`'s own existing partial credit
(`readiness-model.md` §2.2: `correctCount + 0.5·partialCount`), reused
because both are answering the identical underlying question ("how much
should a not-quite-right-but-not-wrong response count for"), and two
components independently choosing two different partial-credit values for
the same kind of near-miss would be exactly the silent-disagreement risk
this codebase's registries and shared constants exist to prevent
elsewhere (`readiness-model.md` §2.6's own citation of that principle for
`english`'s and `spoken`'s shared `/20` denominator is the direct
precedent).

```ts
export const ENGLISH_READING_TARGET = 6;
export const ENGLISH_WRITING_TARGET = 4;

readingValue = min(readingCredit / ENGLISH_READING_TARGET, 1);
writingValue = min(writingCredit / ENGLISH_WRITING_TARGET, 1);
english = 0.5 * readingValue + 0.5 * writingValue;
```

**Why the two targets differ — this is the reason reading-only and
writing-only evidence produce different `english` values at equal attempt
counts, and it is a deliberate design choice, not an oversight to
reconcile.** A reading pass is scored against a **recognizer's
transcript** — even a learner-confirmed one — which is one additional,
imperfect step between what the learner actually said and what gets
scored (§3's whole reason for existing). A writing pass is scored against
**exactly the characters the learner typed**, with no intermediate
transformation of any kind. An individual reading pass therefore carries
slightly weaker evidence of the underlying skill than an individual
writing pass does, so more reading passes are needed to reach the same
confidence a smaller number of writing passes already provides. Worked
arithmetic, at equal count and all `correct`: **3 reading passes** →
`readingValue = min(3/6, 1) = 0.5` → contributes `0.5 × 0.5 = 0.25` to
`english`. **3 writing passes** → `writingValue = min(3/4, 1) = 0.75` →
contributes `0.5 × 0.75 = 0.375` to `english`. The same raw count of
successful attempts produces a materially different contribution — `0.25`
vs. `0.375` — precisely because the two kinds of evidence are not treated
as interchangeable, which is the entire point of giving them different
denominators rather than one shared `/N` the way `spoken` alone uses a
single `/20` for "distinct questions correctly spoken" regardless of
category (`readiness-model.md` §2.7) — a single denominator there is right
because every spoken civics question is the *same* underlying quantity;
reading and writing English measure two different skills scored through two
different evidentiary paths, so a shared denominator between *them* would
be the wrong kind of consistency to reach for. (Before this epic, `english`
itself shared `spoken`'s `/20` under the old, now-superseded
`distinctQuestionsCorrectSpokenInEnglish` formula — §6.2 above replaces
that formula rather than extending it, for exactly this reason.)

**Zero with no attempts, and the explanation names the missing evidence.**
A learner with no in-window `english_attempts` rows of either kind has
`readingCredit = writingCredit = 0`, so `english = 0` — never a null or an
"unmeasured" state distinct from `0`, because unlike `recall`'s evidence
floor (`readiness-model.md` §2.2, which distinguishes "measured at 0%"
from "not enough evidence to measure"), `english`'s `0` has never had a
different meaning to guard against: `readiness-model.md` §2.6 already
established, before this epic, that `english` reads `0` for every learner
with no such evidence, by design, not as a placeholder awaiting a real
formula. What this epic changes is only which *specific* rows can raise
that `0` — never the interpretation of the `0` itself. Whatever renders
`evidenceCounts.english` (a Progress Guide narrative, a component
breakdown screen) states plainly which evidence is missing — "no reading
or writing practice in the last 30 days" — rather than presenting a bare
`0%` with no explanation, the same honesty convention every other
structurally-empty-until-evidenced component in this codebase already
follows.

### 6.3 English does NOT lift the structural cap

`capReason` (`readiness-engine.ts`, verified directly, lines 412–419)
reads exactly two paths: `evidenceCounts.spoken.attempts` and
`evidenceCounts.interview.attempts`. **Nothing in this epic touches that
computation, and nothing should.** Reading and writing English sentences
is not evidence that a learner can answer a **civics** question aloud —
the cap exists specifically to withhold a high score from a learner who
has never spoken a civics answer or sat a mock interview, per
`readiness-model.md` §2.9's own worked example of exactly this scenario.
Letting English evidence lift the cap would let a learner reach a high
score — up past the structural `75` ceiling a typed-only learner is
otherwise held under — having still never spoken a civics answer aloud,
which is precisely the gap the cap exists to name. `readiness-model.md`
§2.9's own no-second-clamp rule ("there is no `min(score, 75)` step in
`computeReadiness`, and there never should be one") is the general form of
the rule this section states specifically: this epic adds **no clamp of
any kind**, either a new ceiling or a new cap-lifting condition, to
`computeReadiness` or to `capReason`'s formula. `english`'s own weight
(`0.05`) already reflects its contribution to the overall score honestly;
widening `capReason`'s inputs to include it would be solving a problem
that does not exist by creating the exact "two things that must agree but
are not derived from each other" drift risk `readiness-model.md` §2.9
already argues against for the cap itself.

### 6.4 `EARNABLE_COMPONENT_KEYS` gains `english`

`apps/api/src/readiness/top-recommendation.ts`'s `EARNABLE_COMPONENT_KEYS`
(verified directly, lines 91–98) gained a sixth entry, `english`, when this
epic shipped — it was a five-entry, module-private `const` before this epic
(`coverage`, `recall`, `retention`, `consistency`, `remediation`). This is
that file's own stated precondition for adding a key, quoted rather than
re-derived: `english`/`spoken`/`interview` were excluded before this epic
specifically because "recommending 'go do more spoken/interview practice'
would be recommending a feature that does not exist yet." This epic makes
`/api/english/*` (§7) a real, routed API feature, so the precondition that
file's header sets for adding a component key is met for `english`
specifically — `spoken` and `interview` remain excluded, because neither
has a practice surface of its own yet either. **The reading and writing
screens themselves do not exist yet** (issues #144/#147, later in this same
epic; `apps/web/src/App.tsx` mounts no `/practice/english`, `/practice/reading`,
or `/practice/writing` route), so the shipped `copyFor('english', ...)`
branch points at `/practice` rather than a screen that would 404, with a
comment on the call site itself saying to re-point it once those issues
land — the same "a recommendation must point at the destination it names"
rule this file's own header states, and the same debt pattern
`readiness-model.md` §8.2 already records for the capped card's own path.
The top-recommendation logic's weighted-headroom computation
(`weight * (1 - value)`, already generic over whichever keys are in the
array) needed no change beyond the one-line array edit and the new
`copyFor('english', ...)` branch, grounded in `evidenceCounts.english` —
never a hand-templated count that could drift from the object the engine
already produced.

### 6.5 Recomputation triggers — no new schedule

English evidence is read by the **existing** `ReadinessService.assembleEvidence`
query set, folded into the same evidence-gathering pass that already
computes `distinctQuestionsCorrectSpoken` and `mockInterviewsPassed` for
every other snapshot. No new recompute trigger is added: a snapshot is
already recomputed on practice-session completion, by the nightly cron,
and lazily on `GET /api/readiness` when the latest snapshot is stale
(`readiness-model.md` §7, §6) — an English attempt is not itself a
`practice_sessions` completion event (§5's own note that English has no
session concept), so it does not trigger an *immediate* synchronous
recompute the way finishing a Quick 5 does; the next nightly pass or the
next stale-on-read check picks it up, the identical latency every other
evidence source not tied to session completion already tolerates. This is
a deliberate, minimal choice: adding a third recompute trigger
specifically for English attempts would be a new schedule
`readiness-model.md` §7's own "exactly two, and no third" rule already
forecloses, for a component that (per §6.1) already decays over 30 days —
a window wide enough that the day-or-so of latency before the next
nightly pass reflects a fresh attempt is immaterial to what the score
means.

---

## 7. API surface

Documented here; implemented by issue #136.

```
GET  /api/english/next?kind=reading|writing
POST /api/english/attempts
GET  /api/english/progress
```

**All three are `@Auth()` with NO permissions, no user id on any route, no
new permission string** — the identical reasoning every other
learner-owned surface in `CLAUDE.md`'s RBAC section already states,
restated here rather than re-argued: gating English practice behind a
permission would leave a Viewer, the product's default role, unable to
use a feature every authenticated learner is meant to practice. There is
no "read another learner's English progress" or "submit an attempt on
someone else's behalf" action for a permission to gate in the first place
— every route resolves the caller from `@CurrentUser('id')`, exactly the
structural rule `docs/specs/voice.md` §10 and every prior epic's own RBAC
section already follow without exception. This document fixes the surface
and its authorization posture; the request/response DTOs, the exact
`next` sentence-selection algorithm (which sentence, avoiding recent
repeats), and pagination shape for `progress` are issue #136's own
implementation decisions, made against this contract.

---

## 8. Scope

- **The realtime interview's own reading/writing segments are #60 (E11),
  out of scope here.** A live, spoken interview conducted by a realtime
  model is a different interaction shape entirely (session tokens,
  interruption handling, a tool-call contract — `docs/specs/voice.md` §13's
  own "out of scope" list names this as E11's territory, not E9's or E10's)
  from the standalone reading/writing practice segments this document
  designs. This epic's `english_attempts` table and scorer are a building
  block E11 may eventually call into for its own reading/writing turns, not
  a feature E11 replaces or duplicates — the same "building block, not the
  final consumer" relationship `docs/specs/voice.md` §13 already states for
  its own transcription surface with respect to this very epic.
- **Handwriting recognition is out of scope.** The writing test in this
  design is **typed**, on a real keyboard, with the constraints §4
  describes (no spellcheck/autocorrect/autocapitalize/autocomplete). Optical
  handwriting recognition — photographing or drawing a handwritten
  sentence and recognizing it — is not part of this design at all, and
  nothing in `english_attempts`' schema (§5.2) anticipates it; a future
  epic that wants it would need its own transcription-equivalent step
  ahead of the identical scorer this document already builds, the same way
  §3's reading path adds a transcription step ahead of it today.

---

## 9. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Model-generated sentences** | A sentence containing one word outside the official vocabulary teaches material the real test will never use, and does so invisibly — the sentence reads as fluent, plausible English regardless of whether every word is on the approved list, so a human reviewer skimming for sense cannot catch the defect; only a mechanical, exhaustive per-word check can, which is exactly what §1.4's enforced test does and what asking a model to "only use these words" cannot be trusted to guarantee. §1.4. |
| **Scraping a third-party sentence list** (a test-prep site's own reading/writing sentences) | No verifiable chain back to the actual official vocabulary — a third-party list could easily include words outside USCIS's own set, or omit the provenance trail §1.1's block requires to state confidently where the words came from. It also reintroduces exactly the "content from an unverified external source" problem `civics-content.md` §6 already rejects for civics answers, on a different content type. |
| **Exact string match instead of WER** | A learner who reads the sentence correctly but drops one filler-adjacent word, or mishears one word in an eight-word sentence, would fail an exact match despite substantively having read the sentence correctly — the identical over-strictness `answer-matching.ts`'s own module header rejects for civics answers ("a learner walking into an interview believing a wrong answer" is the failure mode a too-loose matcher risks; an exact-match reading scorer risks the opposite failure, discouraging a learner who is in fact reading correctly). WER's tolerance band (§2.3) is calibrated specifically to admit one genuine slip on a short sentence and nothing more — a middle ground exact match cannot express at all. |
| **Showing the sentence while the learner types** (writing test) | Converts "can this learner write English they hear" into "can this learner copy visible text" — a different, easier task that says nothing useful about interview readiness, where the officer speaks the sentence and the applicant has never seen it written. §4. |
| **Character-level edit distance instead of word-level** | Character-level Levenshtein would treat a single mis-transcribed or mistyped letter inside one word the same as an entirely wrong word, and would treat a short synonym-length word swap as cheaper than a long correct one purely by character count — neither tracks what actually matters for this test, which is *which words* were produced, not how many characters differ. Word-level alignment (§2.2) is also what makes the required diff table (§2.4) directly legible as "which words were missed/added/swapped," the exact granularity a learner-facing correction screen needs to render. |
| **A single flat WER threshold instead of the compound `errors`-then-`WER` rule** | `english-sentences.json`'s sentences run 3 to 8 words after normalisation. One error on a 3-word sentence is already `wer = 0.333`; two errors on an 8-word sentence is only `wer = 0.25` — a smaller WER for a genuinely worse mistake (two wrong words, not one), purely because the sentence was longer. Any single flat threshold is either too strict on the shortest sentences in the set or too lenient on the longest — there is no one number that expresses "one word wrong is not a failure; two words wrong is not reading the sentence" the way the compound rule does by checking `errors` first and using `WER_CORRECT_MAX` only to bound the single-error case on a short sentence. §2.3. |
| **Recording a `misheard` reading attempt as `incorrect`** | Would misrepresent a transcription failure — evidence about the recognizer, not about the learner — as a reading failure, exactly the conflation `docs/specs/voice.md` §3 already exists to prevent for civics practice. §3 goes one step further than practice's own handling: because a reading attempt's entire evidentiary content IS the transcript, a mistrusted transcript is not weak evidence of a reading skill, it is no evidence of one at all, so recording nothing is the honest response — not recording an `incorrect` outcome, and not inventing a hedged third state either. |
| **Letting English evidence lift the spoken/interview cap** | Reading and writing English sentences is not evidence a learner can answer a civics question aloud. Letting it lift the cap would let a learner reach a high score having never spoken a civics answer or sat a mock interview — precisely the gap `readiness-model.md` §2.9's cap exists to hold open until real spoken/interview evidence exists. §6.3. |
| **A separate English scorer instead of reusing `normalizeAnswer`** | Would maintain a second normalisation pipeline with its own filler list, its own abbreviation table, its own number-word handling — genuinely likely to drift from E3's, since the two would be edited independently by different people at different times, reintroducing the exact "two things that must agree but are not derived from each other" bug category `readiness-model.md` §2.9 and `journey-shell.md` both already argue against elsewhere in this codebase. `normalizeAnswer` is a pure, dependency-free, already-tested function; importing it costs nothing and gives both the reading and the writing scorer the identical, single-sourced normalisation civics answers already get. §2.1. |

---

## 10. Rejected alternatives — the `english_attempts` schema and readiness formula specifically

| Alternative | Why it lost |
|---|---|
| **Widening `practice_attempts` with reading/writing columns instead of a new table** | Forces every civics row to carry `werValue`/`diffOps`/`kind: reading\|writing`/`replayCount` columns meaningless to it, the identical "one table forced to serve two unrelated shapes" reasoning `civics-content.md` §1 already gives for keeping categories/questions/answers as three tables instead of a JSON blob. §5. |
| **Reusing `PracticeOutcome` for `english_attempts.outcome`** | `PracticeOutcome`'s fourth value, `skipped`, has no honest analogue here — an unattempted/declined reading or writing segment produces no row at all (§3, §5.1), not a `skipped` row, so importing an enum with a value this table can never legitimately produce would be worse than declaring the three values this table actually needs. §5.1. |
| **A single shared `/N` denominator for reading and writing, matching `spoken`'s and `english`'s (civics) shared `/20`** | Those two share a denominator because they measure the identical underlying quantity (distinct civics questions correctly spoken) filtered only by language. Reading and writing English are two different skills scored through two different evidentiary paths — one passes through a recognizer, one does not — so a shared denominator would flatten a real difference in evidentiary strength this document deliberately preserves via `ENGLISH_READING_TARGET`/`ENGLISH_WRITING_TARGET`. §6.2. |
| **A new cap reason (`'no_english_evidence'` or similar) gating `ready` alongside `typed_only`** | `readiness-model.md` §10 already forecloses widening `capReason` beyond `'typed_only'` without a new structural gap in the weights table to justify it — `english` is a real, non-zero-weighted component contributing to the score continuously (§6.2), not a component that is mathematically `0` for every learner the way `english`/`spoken`/`interview` were before their producing epics shipped. There is no structural gap here for a second cap reason to name. |
| **Recomputing readiness synchronously on every English attempt, as its own third trigger** | `readiness-model.md` §7 states "exactly two, and no third" as a rule with a stated reason (no job queue; every recompute happens inside the request or transaction that produces the evidence, or on the nightly cron). English has no session-completion event of its own to hang a synchronous recompute off, and the 30-day window (§6.1) makes same-instant freshness immaterial — the existing nightly pass and stale-on-read check already suffice. §6.5. |
