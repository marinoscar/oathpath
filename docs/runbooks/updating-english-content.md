# Runbook: Updating English reading/writing content

This runbook covers adding or revising a sentence in OathPath's English
reading and writing practice — the two segments a learner reads aloud or
types from dictation, scored word-by-word against a sentence composed from
an official USCIS vocabulary list.

For the underlying design — why sentences are composed rather than
transcribed, the word-error-rate thresholds, the accent rule, and the
readiness formula — see [`docs/specs/english-test.md`](../specs/english-test.md)
§1. This runbook does not restate that design; it only tells you which files
to touch, in what order, and what the tooling checks for you versus what
only a human can catch.

**Read this before writing a single sentence.** The content this runbook
covers is the content most likely to be corrupted by good intentions: with
no written procedure, the path of least resistance is to ask a model for
twenty more sentences, which is exactly what §4 below locks out — and the
failure is invisible, because a wrong sentence looks exactly like a right
one.

Source of truth for every claim below, verified directly against the
checked-in files and the running tools, not assumed from `english-test.md`'s
own design-time prose (two of that document's own worked category names —
`"QUESTION WORDS"`, `"OTHER (FUNCTION)"` — turned out, on inspection of the
real JSON, to be shipped as `QUESTION_WORDS` and `OTHER_FUNCTION`; every tag
and count below is what the files actually contain today, not what an
earlier design draft said they would):

- `apps/api/prisma/content/english-vocabulary-reading.json`,
  `english-vocabulary-writing.json` — the two official vocabulary lists.
  64 entries across 8 categories (`PEOPLE`, `CIVICS`, `PLACES`, `HOLIDAYS`,
  `QUESTION_WORDS`, `VERBS`, `OTHER_FUNCTION`, `OTHER_CONTENT`) for reading;
  75 entries across 8 categories (the same set with `HOLIDAYS`/
  `QUESTION_WORDS` swapped for `MONTHS`) for writing.
- `apps/api/prisma/content/english-sentences.json` — the composed sentences.
  36 today: 16 reading, 20 writing, all `version: "v1"`.
- `apps/api/prisma/content/english-vocabulary.ts` — `expandVocabulary`,
  `tokenizeForVocabularyMatch`, `deriveVocabTags`, and
  `validateEnglishContent` — the mechanized, word-by-word checker.
- `apps/api/prisma/content/load-english-content.ts` — the idempotent loader,
  called from `apps/api/prisma/seed.ts` as a sibling step to the civics
  loader.
- `apps/api/prisma/schema.prisma` — the `EnglishSentence` model (`source_url`,
  `retrieved_at`, `content_sha256`, `vocab_tags`), grepped directly for this
  runbook rather than copied from another document.
- `apps/api/test/english-content-validator.spec.ts` — runs
  `validateEnglishContent` against the real, shipped content files (not a
  fixture); confirmed by running it: `21 passed`.
- `apps/api/test/english-content-loader.spec.ts` — proves the loader's
  idempotency against a mocked Prisma client (`docs/TESTING.md`'s "API tests
  never touch a database" rule — no live database is needed to run it).
- `apps/api/package.json` — the `content:validate`/`content:load` scripts
  §5 below explains you should **not** reach for here, and `prisma:seed`,
  which you should.

---

## 1. Where the words come from

USCIS publishes two **vocabulary lists** — the finite set of words a
test-taker may be asked to read or write — never a list of complete
sentences. Both are downloaded, hashed PDFs, already checked in:

| List | `sourceUrl` | Retrieved | `sha256` |
|---|---|---|---|
| Reading | `https://www.uscis.gov/sites/default/files/document/guides/reading_vocab.pdf` | 2026-09-04 | `56be9761b36d44afdbf6efeb825330232bd089d55eb1cf2865d00999a98db04a` |
| Writing | `https://www.uscis.gov/sites/default/files/document/guides/writing_vocab.pdf` | 2026-09-04 | `217244ecfb9ed6c5d79f9c281f9c1f6e4290ea358ced85192522b6218431bc08` |

**The reading and writing lists are never merged into one allowed set.**
USCIS's own guidance says the lists overlap but "are not the same," and a
word can be legal in a writing sentence and illegal in a reading sentence
(`taxes` and `and` are writing-only; every question word —
`who`/`what`/`when`/`where`/`why`/`how` — is reading-only). A reading
sentence is checked only against the reading list; a writing sentence only
against the writing list.

If a vocabulary list itself needs a correction (a transcription error, or
USCIS republishes a revised list), that is a **separate, larger change** —
a new `provenance.retrievedAt`/`sha256`, and re-validation of every sentence
already composed against the old list, since a word that was allowed
yesterday may not be today. Treat it as its own PR, reviewed by a second
human against the freshly re-downloaded PDF, before touching any sentence.
The rest of this runbook assumes the two lists themselves are not changing.

---

## 2. How a sentence is composed

Sentences live in the third file, `english-sentences.json`. Unlike the two
vocabulary files, there is no official sentence list to transcribe from —
USCIS's own instruction to the officers who compose test sentences (quoted
in full in `english-test.md` §1.1) is to "create as many interrogative
sentences (or questions) as you can, using only the words on the list." A
sentence here is composed the same way, by a human, from one list only:

1. **Decide the sentence's `kind`.** `reading` sentences are phrased as
   **questions** (USCIS's own word: "interrogative"); `writing` sentences
   are **declarative statements** — the real interview's own shape, since an
   officer *dictates* a statement for the applicant to write and never
   dictates a question. Do not mix the two.
2. **Draw every word only from that kind's own vocabulary list.** A `"/"` in
   a vocabulary entry (`"state/states"`, `"is/are/was/be"`) means either
   alternative is allowed — you do not need to pick one when composing, only
   when checking §5 confirms your choice is on the list.
3. **Pick the next `ordinal`** for that `kind` — the highest current ordinal
   for `reading` or `writing` (grep the file, or count entries of that
   `kind`) plus one. `(kind, ordinal)` is the loader's own upsert key: a
   collision here silently rewrites an existing sentence rather than adding
   a new one, so guess wrong and §5's own duplicate-ordinal check catches it
   before the loader ever runs.
4. **Watch for accidental duplicates through the scorer's own abbreviation
   table.** `normalizeAnswer` (the same function that scores an attempt, and
   the same one §5's validator tokenizes through) collapses "President of
   the United States" to the single token `president` before anything is
   compared. Two sentences that read as obviously different to a human can
   normalise identically. If you intend two distinct sentences, do not lean
   on that phrase's presence or absence as the only thing that tells them
   apart.
5. **Write the `provenance` block** for the new entry — see §3.

A **revision** to an existing sentence's text follows the same five steps
against the existing entry (same `kind`, same `ordinal`, new `text`) rather
than adding a new one — this is a versioned content edit, not a fresh
sentence, and the loader's value-comparison (§6) means only the changed
entry ever gets a new `updated_at`.

---

## 3. The provenance block — exact field names

Every `english-sentences.json` entry carries a `provenance` object with
three fields. These are the JSON file's own key names; the database columns
they load into (`EnglishSentence` in `schema.prisma`, verified directly)
use the mapped, snake_case names shown alongside each:

| JSON field | Database column (`@map`) | What it records |
|---|---|---|
| `sourceUrl` | `source_url` | Which vocabulary list this sentence was composed against and validated against — not a URL to a sentence document, because none exists (§1). Copy this verbatim from the matching vocabulary file's own `provenance.sourceUrl` — the reading list's URL for a `reading` sentence, the writing list's for a `writing` sentence. |
| `retrievedAt` | `retrieved_at` | The date that vocabulary list was fetched, `YYYY-MM-DD` — copy from the same vocabulary file's own `provenance.retrievedAt`. |
| `sha256` | `content_sha256` | The sha256 of the **vocabulary PDF**, never of `english-sentences.json` itself — copy from the same vocabulary file's own `provenance.sha256`. This is the receipt that proves which exact revision of the official word list the sentence was checked against. |

A sentence's own `provenance` is therefore not a new fact you invent — it is
a copy of whichever vocabulary file's provenance applies to that sentence's
`kind`. If a vocabulary list is ever re-fetched (§1), every sentence
composed against the old fetch keeps its **old** `provenance` (it accurately
records what it was checked against at the time), and only a sentence you
are actively revalidating against the new fetch gets the new one.

The file also carries one **top-level** `composition` block, separate from
any single sentence's own `provenance`, that records who composed and who
reviewed the *sentences* (as opposed to who transcribed the *vocabulary
list*, which is each vocabulary file's own `provenance.transcription`):

```json
"composition": {
  "status": "HUMAN_COMPOSED_AND_REVIEWED",
  "reviewedBy": "@your-github-handle",
  "reviewedAt": "YYYY-MM-DD",
  "note": "<full prose: who composed these sentences, who reviewed them, and against which two vocabulary files>"
}
```

Update `reviewedBy`/`reviewedAt`/`note` every time you touch the file — this
block, plus the PR itself, is the human-review record §4 requires. There is
no separate sign-off table; the file and the PR **are** the record.

---

## 4. The never-model-generated rule, and why it exists

**Sentences in this file are never model-generated, composed by an AI, or
lightly edited from an AI's draft.** This is worth stating with its reason
rather than left as a bare prohibition, because the reason is what should
stop you from making an exception "just this once":

A sentence containing one word outside the official vocabulary teaches a
learner material the real test will never use — and it does so
**invisibly**. The wrong sentence *reads* right: it is grammatical, natural,
plausible English, indistinguishable at a glance from a sentence built
entirely from the approved list. A human skimming the file for sense would
not catch it, because nothing about the sentence *looks* wrong — it only
fails when checked mechanically, word by word, against the list. That is
precisely the failure mode a language model is worst positioned to avoid: a
model's whole competence is producing fluent, plausible sentences, which is
exactly the property that makes an off-vocabulary word in its output
undetectable by a reviewer's read-through. Asking a model to "only use these
words" is asking it to police the one property its training gives it no
special ability to police — it can produce a sentence that sounds fine
regardless of whether every word actually cleared the list, and "sounds
fine" is exactly what a human reviewer would also (wrongly) trust.

This is also why §5's mechanized check exists at all, and why it is
**exhaustive and mechanical rather than a matter of a reviewer's attention**:
review-by-reading cannot catch this specific failure, by construction, no
matter how careful the reviewer is.

### What the tooling checks for you, and what it cannot

The loader and its validator (`english-vocabulary.ts`) mechanically,
exhaustively check:

- **Every word of every sentence resolves to a token on that sentence's own
  vocabulary list** — the one check no human read-through can substitute
  for (see above).
- **No duplicate `(kind, ordinal)`** across the file — a collision the
  loader's own unique key would otherwise silently resolve by overwriting.
- **`vocabTags` is always derived**, never hand-typed — you do not write
  this field at all; the loader computes it from the same token-by-token
  pass that validates the sentence, so it cannot drift from what the
  sentence's own words actually are.

A human must still catch, because no tool checks these:

- **The sentence is actually grammatical, natural English** — the validator
  has no opinion on word order, only on whether each word independently
  appears on the list. `"United capital the States is what?"` passes the
  vocabulary check and is not a sentence a real officer would ever ask.
- **`kind` matches the sentence's actual grammatical mood** — a declarative
  sentence saved as `kind: "reading"`, or a question saved as `"writing"`,
  passes the vocabulary check (both lists are checked the same way
  regardless of mood) but violates §2's rule and would surface as a reading
  question a learner is asked to write, or vice versa.
- **The sentence is genuinely a new, distinct sentence** — not an
  accidental near-duplicate through the abbreviation-collapse quirk §2 step
  4 names.
- **`composition.reviewedBy`/`reviewedAt`/`note` are true and current** —
  nothing enforces that a human actually reviewed the file; the block is a
  record of a fact, not a mechanism that produces the fact.
- **The PR itself carries a second human's review** — the same
  content-review discipline
  [`docs/specs/civics-content.md`](../specs/civics-content.md) §6.1
  establishes for civics content, applied here: one person composes, a
  different person reviews before merge, and the PR is where that happened
  is recorded.

---

## 5. Validating your change

**Do not run `npm run content:validate --workspace=api` to check an English
content change.** That script globs every `.json` file in
`apps/api/prisma/content/`, including the three English files, and runs them
all through the **civics-shaped** structural validator
(`validate-content.ts`), which expects a `categories[].code` field the
English files do not have. Verified directly, running that command against
this repository's current, correct English content reports 14 false
`category.duplicateCode` errors and fails outright — a pre-existing gap in
that script (it was written before English content existed), not a sign
anything about your English change is wrong. Report this as a separate
issue if you hit it; do not chase these errors trying to "fix" your content
file.

The correct check for English content is the Jest suite that actually
understands its shape:

```bash
cd apps/api
npm test -- --testPathPatterns=english-content
```

This runs both `english-content-validator.spec.ts` (validates the real,
shipped files — 21 assertions, no database needed) and
`english-content-loader.spec.ts` (proves the loader's idempotency against a
mocked Prisma client — also no database needed). Verified by running it
against this repository as-is: `Test Suites: 2 passed, 2 total`.

A failure here names the exact offending sentence and token — for example,
`sentence.offVocabularyToken` names the sentence text and the specific word
that is not on the list, and `sentence.duplicateOrdinal` names the two
sentences sharing an ordinal. Fix the content file, not the test.

---

## 6. Re-running the seed

**There is no standalone `content:load`-equivalent for English content
today.** The civics loader has its own script
(`npm run content:load --workspace=api`), but that script invokes only
`load-content.ts` (civics) — verified by reading
`apps/api/scripts/content-env.js`, which hardcodes that one file. The
English loader (`load-english-content.ts`) is wired only as a second,
sibling call inside `apps/api/prisma/seed.ts`, alongside
`loadAllCivicsContent`. To apply an English content change to a running
database, run the full seed:

```bash
cd apps/api
npm run prisma:seed --workspace=api
```

This is safe to run against an environment that already has data: every
step in `seed.ts` — roles, permissions, system settings, civics content,
and English content — is an upsert or an idempotent, value-compared write
(verified by reading `seed.ts` directly). Re-running it after a sentence
change writes only the sentence(s) you actually changed;
`LoadEnglishContentSummary`'s own `sentencesUnchanged` counter, logged to
the console as `[english-loader] sentences: N written / M unchanged`, is how
you confirm that from the output.

---

## 7. Putting it together — the full procedure

1. Confirm which vocabulary list (`english-vocabulary-reading.json` or
   `-writing.json`) your sentence draws from, per its intended `kind` (§1).
2. Compose the sentence by hand, from that list only, following §2's five
   steps. **Never ask a model to draft or "help phrase" it** (§4).
3. Add or edit the entry in `english-sentences.json`, with the exact
   `provenance` fields from §3, copied from the matching vocabulary file.
4. Update the file's top-level `composition` block (§3) — who composed,
   who is about to review, and against which two files.
5. Run `cd apps/api && npm test -- --testPathPatterns=english-content` (§5)
   and fix anything it reports before opening a PR.
6. Open the PR. A second human reviews the actual sentence text against the
   two vocabulary files — the same "one composes, a different one reviews"
   bar `civics-content.md` §6.1 sets for civics content — and that review is
   what the PR thread itself records.
7. After merge, run `npm run prisma:seed --workspace=api` (§6) against any
   environment that needs the change — including your own local database
   before you manually verify the sentence through
   `GET /api/english/next?kind=<reading|writing>`.
