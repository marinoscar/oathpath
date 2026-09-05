# Design Spec: Hands-free voice practice (E12, epic #280)

This is the durable design for E12, the first epic filed after Milestone B
closed the MVP (`ROADMAP.md` §2, §3). Read `docs/specs/voice.md` first; this
document extends its contracts rather than restating them, and it assumes
`docs/specs/ai-evaluation.md`'s dispatch door, `docs/specs/ai-settings.md`'s
role registry, and `docs/specs/realtime-interview.md`'s tool contract exactly
as they already exist. Nothing here touches the realtime transport at all —
E12 is entirely about the request/response speech surface E9 shipped.

E9 built spoken practice around one mechanism: a learner speaks, sees the
raw transcript, edits it if it looks wrong, and only then submits it for
grading. That mechanism is real and it works, and it is also, in
`VISION.md`'s own words, "operating a voice command interface" rather than
"speaking with a patient human coach" — a learner who answers aloud still has
to read a text box and press a button before anything happens. E12 removes
that step for the common case and asks the one question a diff that merely
deletes a confirmation screen cannot answer on its own: **when the learner no
longer confirms the transcript before it is graded, where does E9's
anti-penalty guarantee — "a learner who knew the answer and was misheard must
never be recorded as wrong" — actually live now?** `isMisheardAttempt`
(`mastery-skip.ts`) is unchanged and still correct about the row it is asked
about; the gap this epic closes is that a *correction* of a graded attempt
never used to need to undo a mastery penalty, because the confirmation step
meant a graded attempt was already the learner's approved answer. Auto-submit
means a graded attempt can now be wrong through no fault of the learner's,
and corrected afterward — and nothing before this epic reverses what grading
already did to `question_mastery` when that happens.

Source of truth for every claim below, verified by reading the files rather
than assumed from the epic text:

- `apps/api/src/practice/mastery/mastery-skip.ts` (full file — `isMisheardAttempt`,
  lines ~173–180; `masterySkipReason`, lines ~197–207; `MasteryEvidence`,
  lines ~72–102) — §2 states plainly that this rule is **unchanged** by E12,
  and that `recomputeMasteryForQuestion` (§2) calls it exactly as
  `scheduleMastery` already does, rather than reimplementing it a third time.
- `apps/api/src/practice/mastery/scheduler.ts` (`nextSchedule`, lines
  ~195–256; `initialMasteryRecord`, lines ~259–272) — §2/§2.1's replay is
  defined entirely in terms of this pure function, unmodified, called once
  per qualifying attempt in `answeredAt` order.
- `apps/api/src/practice/mastery/outcome-mapping.ts` (`toAttemptOutcome`,
  lines ~52–58) — §2's replay maps each historical row through this same
  function, never a second mapping written for the replay path.
- `apps/api/src/practice/attempt-grading.service.ts` (`AttemptGradingService`,
  class opens at line 168; `scheduleMastery`, lines ~487–563) — §2 adds
  `recomputeMasteryForQuestion` as a sibling method in this same class,
  reusing the same `tx: Prisma.TransactionClient` convention and the same
  `masterySkipReason`/`nextSchedule` calls `scheduleMastery` already makes.
- `apps/api/src/practice/practice.service.ts` (`recordAttempt`, lines
  579–945, specifically the retry branch at lines 656–674 and the
  `scheduleMastery` call at lines 867–884; `requireRetryTarget`, lines
  1113–1146) — §1 and §2 are both changes to what happens **inside** this
  method's existing transaction, never to its signature or its DTO;
  `requireRetryTarget`'s four conditions are unchanged by this epic.
- `apps/api/src/ai/dto/ai-speech.dto.ts` (`aiTranscribeOkSchema`, lines
  113–143, specifically the `text` field's comment, lines 118–125) — §1's
  "an empty transcript is never auto-submitted" rule is stated against this
  exact, already-shipped contract: `text: ''` is `status: 'ok'`, not a
  refusal.
- `apps/web/src/pages/PracticeSessionPage.tsx` (the transcription effect,
  lines ~425–509, specifically the `'ok'` branch, lines ~445–465) — §1
  describes precisely what this effect does differently when
  `autoSubmitSpoken` is true, and precisely what stays identical when it is
  false.
- `apps/web/src/components/voice/QuestionAudio.tsx` (full file; `speakBound`/
  `usePremium`, lines 209–213; `utterance.rate = 0.95`, line 256) — §5's
  `speechRate` default and its reasoning are this file's own, already-shipped
  behaviour, made a preference rather than a literal.
- `apps/api/src/ai/ai-speech.controller.ts` (full file) and
  `apps/api/src/ai/ai-speech.service.ts` (`AiSpeechService`, class at line
  184, constructor at line 187) — §5 adds one sibling read route and method
  to this existing controller/service, on the identical `@Auth()`
  no-permissions shape every other route on it already uses.
- `apps/api/src/ai/ai.types.ts` (`AiSynthesisRequest`/`AiSynthesisResult`,
  lines 615–682) — §4's cache-miss synthesis call is this exact, unmodified
  type; no new AI request/result shape is added by this epic.
- `apps/api/src/ai/providers/ai-provider.interface.ts` (`AiProvider`, lines
  91–297, specifically `synthesize`, lines 251–255) — §5's `listVoices()`
  addition sits beside it, on the same interface.
- `apps/api/src/ai/providers/openai.provider.ts` (`OPENAI_CAPABILITIES`,
  lines 123–130; `DEFAULT_SPEECH_VOICE`, line 139; `SPEECH_CONTENT_TYPES`,
  lines 152–159) — §5 states this is the one file an OpenAI-specific voice
  list would live in, beside the constant that already plays this role for
  the default voice.
- `apps/api/src/ai/ai-dispatch.service.ts` (`AiDispatchService`, `providers`
  field and constructor, lines ~549–568; `resolve`, lines ~1095–1157) — §5's
  `listVoices()` on the dispatcher reads `this.aiSettings.get()` and
  `this.providers` exactly as `resolve` does, but — unlike every other public
  method on this class — needs no caller credential at all, because a voice
  catalog costs nothing to read.
- `apps/api/src/ai/ai-model-roles.ts` (lines 21–30, the "detection rather
  than prevention" argument for why the registry lives in the API and the
  web reads it over an endpoint) — §5 reuses this argument verbatim for the
  voice list.
- `apps/api/src/storage/providers/storage-provider.interface.ts` (the
  `StorageProvider` interface, full file) and
  `apps/api/src/storage/providers/storage-providers.module.ts` (`STORAGE_PROVIDER`
  bound to `S3StorageProvider`) — §4's cache writes through this exact port,
  never through the storage module's own service layer.
- `apps/api/src/storage/objects/objects.service.ts` (`getObjectWithAuthCheck`,
  lines 572–586; `getObjectForDelete`, lines 611–625, and its own comment on
  why a delete-only bypass could not share the read/write helper) — §4 states
  precisely why the audio cache does not reuse this file's ownership model at
  all, quoting `CLAUDE.md`'s own warning about it.
- `CLAUDE.md`'s RBAC section ("Ownership governs read and write... There is
  **no admin bypass**...", and "threading the permission through the shared
  helper would make it a read and write bypass in the same edit") and its
  "Adding an AI feature" section ("no feature resolves a credential or
  selects a provider... the server key... is never used for inference") — §4
  quotes both directly.
- `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` (the
  `study` namespace, lines 160–241, and the file's own "CRITICAL: NO
  `.default()` ANYWHERE" header) and `docs/specs/habit-streaks.md` §7 (the
  six-file checklist for adding a namespace) — §5's `voice` namespace follows
  this exact pattern, file for file, with no `.default()` anywhere.
- `apps/api/prisma/schema.prisma` (`SystemSettings.updatedByUserId`, lines
  127–134, relation `"SettingsUpdater"`, `onDelete: SetNull`; `AuditEvent.actorUserId`,
  lines 158–166, relation `"ActorEvents"`, `onDelete: SetNull`; `CivicsQuestion`,
  line 977; `CivicsAnswer`, line 1046; the `String @id @default(uuid()) @db.Uuid`
  / `@map` / `@@map` conventions used throughout) — §4's new table and its
  nullable, `SetNull` attribution column follow these exact, already-shipped
  precedents rather than inventing a new one.
- `apps/api/src/civics/civics.controller.ts` (`@Controller('civics')`, line
  113; `@Get('questions/:id')`, line 212; `@Post('questions/:id/explain')`,
  line 305) — §4 adds one sibling read route to this controller.
- `VISION.md` lines 220–230 (the six voice requirements) — line 228, quoted
  verbatim by `docs/specs/voice.md` §3 and reused unchanged by §2 below; line
  230, quoted verbatim by §1 below for the first time in this codebase's
  specs.
- `docs/specs/voice.md` §1 (`textModelRoles()`/`systemReady`, unaffected by
  anything in this epic), §2 (browser TTS as the unconditional default, the
  contract §6 restates unweakened), §3/§3.1/§3.2/§3.3 (confirm-before-grade,
  its worked example, supersession, and the one-retry guard — all extended,
  never restated, below), §6 (all inference through the dispatcher, on the
  caller's key — the rule §4's cache-miss path inherits without exception),
  §9 (the two speech endpoints §4/§5 add siblings to), §10 (RBAC — the
  pattern §8 below follows without modification), §11 (Decisions locked,
  amended in place per this document's own §9's first row).
- `ROADMAP.md` §2 ("Milestone B... closes the MVP"), §3 (the epic table this
  document's own §9's table format matches), §7 ("No new permission strings"
  — the closed permission set §8 below adds nothing to), §8 (the post-MVP
  backlog's own `embed`-role precedent for "declared, not yet consumed" — the
  shape §4's `civics_answer` scope follows).

**Nothing described past this line exists yet.** `grep -rn
"recomputeMasteryForQuestion\|autoSubmitSpoken\|speech_audio_assets\|SpeechAudioAsset\|listVoices"
apps/api/src apps/web/src` returns nothing; `PracticeSessionPage.tsx`'s
transcription effect always waits for a manual submit; `AttemptGradingService`
has one mastery-scheduling method, not two; `AiProvider` has no `listVoices`
method; no `speech_audio_assets` table exists in `schema.prisma`; and the
`voice` key is absent from every one of the six files
`user-settings-namespaces.schema.ts`'s sibling files touch for `study`. Every
path cited above resolves today exactly as described; every contract below is
what this epic's child issues (#281–#290, per §12) build *against*. A child
issue is free to find a better answer to a specific sub-problem as long as it
keeps the contracts this document promises to the pieces around it: the
never-throw provider, the one-dispatch-door rule, `isMisheardAttempt`'s three
conditions unchanged, and the shared-cache/no-server-key rule in §4.

---

## 1. Auto-submit replaces confirm-before-grade

`VISION.md` line 230, quoted verbatim, is the requirement this section exists
to satisfy — the same sentence `docs/specs/voice.md` §3 leaves unquoted while
building the mechanism this epic now points at directly:

> The user should feel like they are speaking with a patient human coach, not
> operating a voice command interface.

E9's shipped flow is, precisely, operating a voice command interface: press
record, wait, read a transcript in a text box, edit it if it looks wrong,
press submit. E12's flow is **hear → speak → grade → correct**: the
transcript is graded the instant it arrives, and any correction happens
*after* grading rather than before it. This is not a smaller version of the
old flow with the middle step removed — it is the flow VISION.md actually
asks for, with the old flow kept as an opt-out for the learner it still
serves.

**`autoSubmitSpoken` is a new field in the `voice` user-settings namespace
(§5), defaulting to `true`.** It governs one branch inside
`PracticeSessionPage.tsx`'s transcription effect (lines ~425–509 today): on
`result.status === 'ok'` with a non-empty transcript, the `'ok'` branch (lines
~445–465) currently ends by calling `setResponse(heard)` and
`setSpokenDraft({ confidence: result.confidence })` and stopping there — the
learner's own tap on Submit is what happens next. Under E12, when
`autoSubmitSpoken` is `true`, that branch instead calls the same submit path
the Submit button already calls, immediately, with `transcript: heard`,
`asrConfidence: result.confidence`, and `inputMode: 'spoken'` — exactly the
fields `recordAttempt`'s DTO already accepts, unchanged. When
`autoSubmitSpoken` is `false`, the branch is untouched: `setResponse`/
`setSpokenDraft` and a manual Submit, byte-for-byte what E9 shipped. **The
confirm-before-grade flow is not deleted — it is the opt-out**, which is the
direct answer to `Decisions locked` #1 in issue #280: this is a formal
amendment of `voice.md` §3 / its own `Decisions locked` #3, stated as such
(§9 below, and the amendment note this epic adds to `voice.md` §3 itself),
not a silent contradiction of a decision that document still records as
locked. Nothing about the anti-penalty guarantee changes by making
auto-submit the default — §2 is where that guarantee is shown to still hold,
mechanically, not merely by assertion.

**An empty transcript is never auto-submitted, on either setting.**
`aiTranscribeOkSchema`'s own comment (`ai-speech.dto.ts`, lines 118–125)
states the fact this rule is built on: `text: ''` is `status: 'ok'`, and it
is a **success** — "a learner who pressed record and said nothing really did
produce no words." `PracticeSessionPage.tsx`'s existing `'ok'` branch already
short-circuits on this (`if (!heard) { setVoiceError(...); return; }`,
lines ~446–455) before anything is written to `response`, and E12 changes
nothing about that check — the auto-submit branch is reached only *after*
it, on the identical non-empty `heard` string the manual-confirm path already
required. Auto-submitting silence would record an attempt for a question the
learner never actually answered, which is exactly the harm `grade()`'s
existing `state_required` handling and `masterySkipReason`'s own first
condition already exist to avoid for a different cause (`mastery-skip.ts`);
an empty spoken answer earns the identical protection a skip does, for the
same reason.

## 2. Where the anti-penalty guarantee now lives

This is the most important section in this document, because it is the one
place where "delete a confirmation screen" is not actually a small change.

**The mechanism, precisely.** `isMisheardAttempt` (`mastery-skip.ts`, lines
173–180) fires — and `masterySkipReason` therefore withholds an attempt from
`scheduleMastery` — under exactly three conditions, unchanged by this epic:
a confidence was reported at all, it is strictly below `ASR_CONFIDENCE_THRESHOLD`
(`0.6`), and the outcome is not `correct`. Every word of that rule is still
correct about the row it is asked about. What auto-submit changes is which
rows now exist to be asked about. **Accented speech very often transcribes
*confidently* and *wrongly*** — a recogniser that is sure it heard "the head
of the executive ranch" reports a high confidence for exactly that string,
because as far as the acoustic model is concerned it heard clearly. Under
E9's confirm-before-grade flow this never mattered: the learner read that
string before it reached grading and fixed it, so the wrong-but-confident
transcript never became a graded attempt at all. Auto-submit removes that
read-it-first step for the default case, so a confidently-wrong transcript
now **does** reach grading, grades `incorrect`, and — because
`isMisheardAttempt`'s second condition (`confidence < 0.6`) is false — is
**not** withheld from `scheduleMastery`. It is scheduled, normally, as a real
regression: `correctStreak` resets, a `review`/`mastered` question lapses,
`dueAt` is pulled in. Auto-submit has opened a hole `isMisheardAttempt` was
never designed to see, because it was never asked to see it: the rule is
about whether a *recorded* attempt was probably a mishearing, not about
whether a learner is later given a chance to correct one that was not.

**The retry mechanism already exists and already has a place for this — it
just does not yet reach far enough.** `voice.md` §3.2's supersession rule
already excludes a superseded attempt from a practice session's *summary*
counts, and `voice.md` §3.1's `masterySkipReason` guard already excludes a
**misheard** superseded attempt from `question_mastery` — but only because,
until this epic, the *only* attempt ever superseded was a misheard one: the
web only ever offered a retry after a low-confidence transcription, so the
attempt a retry pointed at was, by construction, always the exact case
`isMisheardAttempt` had already withheld from scheduling in the first place.
**E12 offers a retry after *any* spoken attempt, misheard or not** (the
amendment to `voice.md` §3.3 below states this precisely), which means a
retry can now supersede an attempt that *was* scheduled — a confidently-wrong
transcript, or simply a genuinely wrong answer the learner wants to correct
before moving on. Supersession already stops that original attempt from being
double-counted in the session summary. **Nothing today stops its mastery
penalty from standing even after it is corrected.**

**`recomputeMasteryForQuestion(tx, userId, questionId)`, added to
`AttemptGradingService` beside `scheduleMastery`, closes exactly that gap.**
Rather than trying to *undo* the specific penalty one prior call applied, it
**replays** the question's entire mastery history from scratch:

```ts
// apps/api/src/practice/attempt-grading.service.ts — added beside
// scheduleMastery (issue #284, epic #280 / E12)

/**
 * Recompute one question's `question_mastery` row from its full attempt
 * history, as if every superseded and skipped attempt had never happened.
 *
 * CALLED ONLY WHEN AN ATTEMPT IS WRITTEN WITH A `retryOfAttemptId` — the one
 * case where a NEW attempt changes what an OLDER attempt's row should have
 * meant for scheduling. Every ordinary (non-retry) attempt still goes through
 * `scheduleMastery`'s existing incremental path; replaying the whole history
 * on every attempt would be needless work for the overwhelming majority of
 * attempts, which correct nothing.
 *
 * A REPLAY, NOT AN INVERSE OPERATION, and that is a design decision, not a
 * convenience. `nextSchedule` is not invertible: `ease`, `intervalDays` and
 * `distinctCorrectDays` are each derived from strictly less state than would
 * be needed to run the SM-2 step backwards (the same-UTC-calendar-day dedup
 * in `scheduler.ts` alone means two different histories can produce the
 * identical `MasteryRecord`, so there is no single "previous" record to
 * restore). A replay sidesteps the question entirely: it never asks what the
 * penalty WAS, only what the record WOULD BE if the superseded row had never
 * counted — which is the literal statement of "this correction costs
 * nothing", not an approximation of it.
 */
async recomputeMasteryForQuestion(
  tx: Prisma.TransactionClient,
  userId: string,
  questionId: string,
): Promise<void> {
  const rows = await tx.practiceAttempt.findMany({
    where: { userId, questionId },
    orderBy: { answeredAt: 'asc' },
    select: {
      id: true,
      retryOfAttemptId: true,
      outcome: true,
      gradingMethod: true,
      asrConfidence: true,
      answeredAt: true,
      answerSnapshot: true,
    },
  });

  // SUPERSEDED, REGARDLESS OF WHY. Unlike `voice.md` §3.2's original rule —
  // which only ever excluded a MISHEARD superseded row, because that was the
  // only kind that existed — this replay excludes every superseded row, full
  // stop: a retry corrects the attempt it points at, and the corrected
  // attempt's own mastery effect is exactly what this method exists to erase.
  const supersededIds = new Set(
    rows.map((row) => row.retryOfAttemptId).filter((id): id is string => id !== null),
  );

  let record = initialMasteryRecord();

  for (const row of rows) {
    if (supersededIds.has(row.id)) continue;

    // THE IDENTICAL SKIP RULE `scheduleMastery` ALREADY APPLIES, read from
    // the row rather than pre-judged — a `state_required` or still-misheard
    // attempt in this question's ordinary (non-retry) history contributes
    // nothing to the replay either, for the same reason it contributed
    // nothing the first time.
    const snapshot = row.answerSnapshot as { answerResolution: 'resolved' | 'state_required' };
    const skip = masterySkipReason({
      answerResolution: snapshot.answerResolution,
      outcome: row.outcome,
      asrConfidence: row.asrConfidence,
    });
    if (skip !== null) continue;

    record = nextSchedule(
      record,
      toAttemptOutcome(row.outcome, row.gradingMethod),
      row.answeredAt,
    );
  }

  await tx.questionMastery.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: { userId, questionId, ...toMasteryRow(record) },
    update: toMasteryRow(record),
  });
}
```

`recordAttempt` (`practice.service.ts`, lines 748–887) calls this instead of
its ordinary `scheduleMastery` call **only on the branch that already checks
`input.retryOfAttemptId`** (lines 656–674): the new attempt is written first,
inside the same transaction, and `recomputeMasteryForQuestion` is called
immediately after, over the now-complete row set that includes it. Every
other attempt — the overwhelming majority, which corrects nothing — keeps
calling `scheduleMastery` exactly as `voice.md` §3.1 already specifies, with
no replay and no extra query.

**Why a replay is honest by construction, stated plainly:** `nextSchedule` is
a pure function of a record, an outcome, and a timestamp. Two states computed
by feeding it the identical sequence of qualifying attempts are, by
definition, identical — there is no "penalty" left over to track down and
subtract, because nothing about the replay ever depended on what the
superseded attempt did to the record in the first place. This is the same
"corrected once, never edited in place" evidence-ledger stance `voice.md`
§3.2 already takes toward the `practice_attempts` row itself (the superseded
attempt is never deleted, never rewritten), applied one layer down, to the
*derived* state that row's grading once fed into.

### 2.1 Worked example

A learner is mid-review on question 23, `state: 'review'`, `correctStreak: 4`,
`ease: 2.7`, `intervalDays: 12`, `distinctCorrectDays: 2`, `lapses: 1`. They
answer aloud: `asrConfidence: 0.9` (well above `0.6` — not misheard), the
transcript is wrong, and grading returns `outcome: 'incorrect'`.

**Without `recomputeMasteryForQuestion` — the E9-era mechanism, applied to an
attempt auto-submit made possible.** Because `isMisheardAttempt(0.9,
'incorrect')` is `false`, `scheduleMastery` is not withheld. `nextSchedule`
runs its ordinary incorrect branch: `state: 'review'` was a regression, so
`state → 'lapsed'`, `lapses: 1 → 2`, `correctStreak → 0`, `ease → 2.5`,
`dueAt → +1 day`. The learner then notices the mistake and retries,
answering correctly this time (`asrConfidence: 0.95`). If the retry's mastery
effect were scheduled the old way — incrementally, on top of the record the
first attempt just wrote — `nextSchedule(lapsed-record, 'correct', …)`
produces `state → 'learning'` (lapsed always promotes to learning, never
straight back to review), `correctStreak → 1`, `lapses` still `2`,
`distinctCorrectDays → 3`. **The learner ends up demoted from `review` to
`learning`, with a permanently incremented lapse count and a reset streak —
for a question they answered correctly, corrected once.**

**With `recomputeMasteryForQuestion`.** The first attempt is now superseded
by the retry, so it is excluded from the replay entirely — its
`incorrect`/`lapsed` effect never happened as far as the replay is concerned.
The replay reconstructs the exact pre-attempt state (`review`, streak 4,
ease 2.7, interval 12, `distinctCorrectDays` 2, lapses 1 — the identical
numbers the record held before either attempt, because every attempt before
them is replayed unchanged) and then applies **only** the retry's `correct`
outcome on top: `correctStreak → 5`, `ease → 2.8`,
`distinctCorrectDays → 3` (a new calendar day), interval
`round(12 × 2.7) = 32` days, and — because `review` promotes to `mastered`
once `distinctCorrectDays >= 3` — `state → 'mastered'`. `lapses` stays `1`.
**This is exactly what the record would read if the learner had simply
answered correctly on the first try, with no mishearing, no misgrading, and
no retry involved at all.** The correction cost nothing, which is the literal
content of `Decisions locked` #2 (§9).

## 3. `transcript` is redefined, and no column is added

`voice.md` §8 defines `practice_attempts.transcript` as "the text the learner
CONFIRMED they said, after the confirm-before-grade step." Under auto-submit
there is, on the default path, no confirm step to have happened before
grading — the transcript is graded the instant it arrives. **`transcript`'s
meaning narrows to what is still true on every path: the text that was
graded, exactly as the learner left it.** On the confirm-before-grade opt-out
(`autoSubmitSpoken: false`) that is unchanged from today — the confirmed,
possibly-edited text. On the auto-submit default it is the recogniser's own
output, verbatim, because nothing edited it before grading ran on it — which
is also, not coincidentally, exactly what `responseText` already holds on
that same row (`voice.md` §8's own note that the two columns "happen to share
an answer" today). Nothing about `transcript`'s *storage* changes: it is
still never the raw guess a learner corrected away, because on the
auto-submit path there is no separate raw guess to have discarded — the
graded text and the recognised text are the same string by construction.

**`retryOfAttemptId` is what records that the learner did not leave it,
without a second column saying so.** A row with no `retryOfAttemptId`
pointing at it stands as-is: its `transcript` is what was graded and, as far
as this product is concerned, what the learner meant. A row that **is**
pointed at by a later `retryOfAttemptId` is a row the learner corrected —
that fact is already fully expressed by the link itself, exactly as `voice.md`
§3.2 already uses it to exclude a row from a session's summary counts and as
§2 above uses it to exclude a row from `recomputeMasteryForQuestion`'s
replay.

**A `transcript_confirmed` boolean column was considered and rejected for
exactly that reason.** It would encode, in a second place, a fact
`retryOfAttemptId` already encodes: "was this row corrected" and "does
something point at this row as superseded" are the same question asked
twice, in two representations that could disagree — a row whose boolean was
set `false` by a bug while nothing actually retried it, or the reverse. A
second place is a place that can drift from the first, and the two would
then disagree about a fact every downstream reader (`voice.md` §3.2's summary
exclusion, §2's replay exclusion, a future review screen) needs answered
identically. One representation, read by every consumer, cannot drift from
itself.

## 4. The audio cache is content-addressed and shared

`QuestionAudio.tsx`'s premium path (`voice.md` §2) calls
`POST /api/ai/speech/synthesize` fresh, on the learner's own key, every
single time a civics question is played back — including the hundredth time
the same question's prompt is read to a hundredth learner. Nothing about that
text ever changes between requests for an unchanged question, so every one of
those calls after the first is pure, billable waste. E12 adds a cache in
front of it, for civics content specifically.

```prisma
// apps/api/prisma/schema.prisma — added by this epic
enum SpeechAudioScope {
  civics_question
  civics_answer
}

model SpeechAudioAsset {
  id String @id @default(uuid()) @db.Uuid

  scope SpeechAudioScope

  // civics_questions.id when scope is civics_question, civics_answers.id
  // when scope is civics_answer. NOT a Prisma foreign key: the column is
  // POLYMORPHIC across two tables depending on `scope`, and a single FK
  // column cannot reference either conditionally. Referential integrity here
  // is enforced by the write path (the only writer resolves refId from a
  // real question or answer row before synthesizing), not by the schema.
  refId String @map("ref_id") @db.Uuid

  // The provider voice id this clip was synthesized with, e.g. "alloy".
  voice String

  // sha256 of the EXACT text that was synthesized — the load-bearing part
  // of the key, not a convenience. See the prose below.
  contentSha256 String @map("content_sha256")

  format     String @default("mp3")
  storageKey String @map("storage_key")
  byteLength Int    @map("byte_length")

  // Who paid for the ONE call that produced this clip — an attributed
  // cross-subsidy (§4's own "who pays" paragraph below), never the server
  // key. Nullable + SetNull, matching `SystemSettings.updatedByUserId` and
  // `AuditEvent.actorUserId` (schema.prisma, both already SetNull): this row
  // outlives the account that first asked for it, because every learner
  // after them reads the identical bytes.
  generatedByUserId String? @map("generated_by_user_id") @db.Uuid
  generatedByUser   User?   @relation("SpeechAudioGenerator", fields: [generatedByUserId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@unique([scope, refId, voice, contentSha256])
  @@map("speech_audio_assets")
}
```

**Why no `storage_objects` row, and no FK to one.** `CLAUDE.md`'s RBAC
section states the rule this table would otherwise collide with head-on:
"Ownership governs read and write. A user may read, download and update
metadata only on objects they uploaded... There is **no admin bypass on
those paths**." That rule is correct for a learner's own upload and exactly
wrong for a cached civics clip every learner must be able to read regardless
of who first requested it — `objects.service.ts`'s `getObjectWithAuthCheck`
(lines 572–586) would reject every learner except the one named in
`generatedByUserId` on their very next request for the same question.
`getObjectForDelete` (lines 611–625) already exists as a second resolver
specifically because, in `CLAUDE.md`'s own words about widening it instead,
"threading the permission through the shared helper would make it a read and
write bypass in the same edit" — the identical shape of mistake this table
would reintroduce if it tried to reuse `storage_objects`' ownership model by
special-casing it. The fix is the one that section's own reasoning points at:
a genuinely different access rule gets a genuinely different code path, not
a bypass threaded through the one built for a different rule.

**Why the `StorageProvider` port is still the right layer.** The new speech
module imports `StorageProvidersModule` and injects
`@Inject(STORAGE_PROVIDER) storage: StorageProvider` directly — the same
`upload(key, stream, options)` / `getSignedDownloadUrl(key, options)`
interface `ObjectsService` already sits on top of, with none of that
service's ownership logic in between. This is not a new pattern invented for
audio: it is the plain object-storage primitive the whole application
already has, used without the one layer (`storage_objects` + its
ownership-scoped service) that answers a question — "whose object is this"
— this cache does not ask.

**Why `contentSha256` is in the unique key, not the question id alone.** A
civics question's `prompt` is fixed, but a **dynamic answer**
(`civics_answers`, `effective_to`) changes when an admin corrects it
(`PUT /api/civics/dynamic-answers`, `docs/specs/civics-content.md` §9) — and
if this cache ever serves answer audio (the declared-but-unconsumed
`civics_answer` scope, below), a stale cached clip of a superseded answer
must never be handed to a learner as if it were current. Hashing the exact
text rather than keying on the question/answer id alone makes that
structurally impossible rather than a cache-invalidation problem to remember:
a changed answer hashes to a different `contentSha256`, so the lookup for
the *new* text is unconditionally a miss, and the row for the *old* text
simply stops being addressed by anything — no invalidation logic exists
because none is needed. **A `civics_answer` row for a dynamic answer that has
since been corrected is unreachable by construction**, which is a stronger
guarantee than a TTL or an explicit purge would give.

**The key layout**: `speech/civics/<scope>/<refId>/<voice>/<contentSha256>.<format>`
— e.g. `speech/civics/civics_question/3f2a.../alloy/9e1c....mp3`. Scoped by
content type first so a future non-civics use of the same mechanism (there is
none planned; see §11) would sort under its own prefix rather than
intermingling with this one.

**The race on a double miss, and why the loser discards its row rather than
failing.** Two learners can request the same never-before-heard question's
audio within the same few hundred milliseconds, both miss the cache, and both
dispatch a synthesis call — each on their **own** key, so there is no
double-billing risk to guard against, only a double write. Both upload their
own copy of the resulting bytes to the same storage key (the key is a pure
function of `scope`/`refId`/`voice`/`contentSha256`, so both uploads target
the identical object and the second simply overwrites the first with
byte-identical content) and both attempt to `create` a `SpeechAudioAsset` row
naming that key. The unique constraint on `(scope, refId, voice,
contentSha256)` admits exactly one `create`; the loser's insert fails with
Prisma's `P2002`. **The loser catches that specific error, re-reads the
winner's now-existing row, and serves *that* row's `storageKey` to its own
request** — the learner who lost the race still gets their audio, on the
first try, with no visible failure and no retry prompt. Nothing is deleted
from storage (the loser's upload wrote the same bytes to the same key the
winner's row already names, so there is nothing distinct to clean up), and no
request fails merely because two learners asked for the same clip at once.

**Who pays.** The first learner to request a given `(scope, refId, voice)`
combination triggers the synthesis call, on **their own** BYOK key — never
the server key at `('ai', 'openai')`, for the identical reason
`CLAUDE.md`'s "Adding an AI feature" section already states for every other
inference path in this codebase: "the instant one inference call runs on it
instead of the caller's own key, every per-user usage figure... becomes
wrong from that call onward, **silently**." Every learner after the first
reads the cached bytes at no cost to anyone. This is a deliberate, accepted
cross-subsidy — `generatedByUserId` records who it was, so it is attributed
rather than anonymous, but nothing refunds or discloses it to that learner,
and nothing in this design tries to spread the cost more evenly. It is the
same shape of asymmetry a CDN's first cache-fill request already accepts,
applied to a BYOK key instead of a server's own compute.

**A learner's own account being reset does not touch this table.**
`docs/specs/account-reset.md`'s reset erases a learner's own data; a cached
civics clip they happened to be the first to request is shared product
content by the time a second learner has read it, not their data — exactly
the reasoning `generatedByUserId`'s `SetNull` (rather than `Cascade`) already
encodes structurally.

## 5. The admin binds the model; the learner picks the voice

The `speak` role's binding is unchanged — an admin still picks which model
serves it, exactly as `docs/specs/ai-settings.md` and `voice.md` §1/§2
already specify, and E12 adds no new model role. What is new is a second,
narrower choice a **learner** makes: which of that model's voices they want
to hear.

```ts
// apps/api/src/ai/providers/ai-provider.interface.ts addition
/**
 * The voices this provider's `speak` capability can produce, for a picker to
 * render — NEVER a network call, NEVER async, and NEVER throws. A voice list
 * is provider-authored, static data (OpenAI does not expose a "list voices"
 * endpoint at all), not something worth a round trip on every page load, and
 * a picker that can fail to populate is worse than one that renders a fixed,
 * always-available list.
 */
listVoices(): AiVoiceDescriptor[];
```

```ts
// apps/api/src/ai/providers/openai.provider.ts addition, beside
// DEFAULT_SPEECH_VOICE (line 139) — the one file OpenAI's own voice list
// lives in, exactly as OPENAI_CAPABILITIES and SPEECH_CONTENT_TYPES already
// do for this provider's other speech facts.
const OPENAI_TTS_VOICES: readonly AiVoiceDescriptor[] = [
  { id: 'alloy', label: 'Alloy' },
  { id: 'echo', label: 'Echo' },
  { id: 'fable', label: 'Fable' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'nova', label: 'Nova' },
  { id: 'shimmer', label: 'Shimmer' },
];

listVoices(): AiVoiceDescriptor[] {
  return OPENAI_TTS_VOICES;
}
```

`AiDispatchService` gains a matching `listVoices(): Promise<AiVoiceDescriptor[]>`,
beside `createRealtimeSession`, reading `this.aiSettings.get()` and
`this.providers` exactly as `resolve` (lines ~1095–1157) already does — but,
unlike every other public method on that class, **it needs no caller
credential at all**: a static catalog costs nothing to read and reveals
nothing about any key, so there is no `no_user_key` branch and no per-caller
check. If no provider is configured, or the configured provider does not
`supports('tts')`, it returns `[]` rather than an `unavailable` result —
there is no failure mode here worth a discriminated union over, because an
empty list already renders correctly as "no premium voices to choose from
yet."

`AiSpeechController` gains one sibling read route:

```
GET /api/ai/speech/voices   @Auth(), no permissions
```

returning `{ role: 'speak', voices: AiVoiceDescriptor[] }`. **Why the web
reads this over an endpoint rather than a duplicated constant in
`apps/web/src/config`** — `ai-model-roles.ts`'s own argument (lines 21–30),
reused verbatim rather than re-derived: "a duplicate in `apps/web/src/config`
with a test asserting the two agree is DETECTION rather than prevention —
the copies can still disagree in a working tree, in a branch, and in any
build where the test is not run." A hand-copied voice list in the web bundle
would be exactly that: correct the day it is written, and silently wrong the
day OpenAI adds or renames a voice and nobody remembers the second copy.

**The `voice` user-settings namespace**, added to
`user-settings-namespaces.schema.ts` on the identical pattern `study`
(lines 160–241) already establishes — every field optional, **no
`.default()` anywhere**, per that file's own header:

```ts
// apps/api/src/common/schemas/user-settings-namespaces.schema.ts addition
export const DEFAULT_AUTO_SUBMIT_SPOKEN = true;
export const DEFAULT_SPEECH_RATE = 0.95;

export const voiceSchema = z
  .object({
    autoSubmitSpoken: z.boolean().optional(),
    // Shape-validated, membership not — the identical rule
    // aiSynthesizeRequestSchema's own `voice` field already states: the
    // accepted set belongs to the provider, and this layer owns only the
    // charset bound.
    ttsVoiceId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    speechRate: z.number().min(0.5).max(2).optional(),
  })
  .strict();

export const voicePatchSchema = z
  .object({
    autoSubmitSpoken: z.boolean().nullable().optional(),
    ttsVoiceId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .optional(),
    speechRate: z.number().min(0.5).max(2).nullable().optional(),
  })
  .strict();
```

Absent means the built-in default, resolved at read time: `autoSubmitSpoken`
true (§1), `ttsVoiceId` whatever `DEFAULT_SPEECH_VOICE` names on the
configured provider, `speechRate` `0.95`. **The same six files
`docs/specs/habit-streaks.md` §7 names for `study`, touched the identical
way for `voice`:**

1. `user-settings-namespaces.schema.ts` — declare `voiceSchema`/`voicePatchSchema`.
2. `settings.schema.ts` — `voice: voiceSchema.optional()` / `voice:
   voicePatchSchema.nullable().optional()`.
3. `settings.types.ts` — `voice?: VoiceValue` on `UserSettingsValue`.
4. `settings/dto/update-user-settings.dto.ts` — the same two fields on
   `UpdateUserSettingsDto`/`PatchUserSettingsDto`.
5. `settings/dto/user-settings-response.dto.ts` — `voice:
   voiceSchema.optional()` on the response projection.
6. `settings/user-settings/user-settings.service.ts` — `toResponse`'s
   conditional-spread line, matching the pattern the file already applies for
   `navigation` and `study`.

**`speechRate` defaults to `0.95`, matching `QuestionAudio.tsx`'s existing,
already-shipped literal** (`utterance.rate = 0.95`, line 256) — this epic
turns a hardcoded value into a preference with that value as its default,
not a new number. That file's own comment states why `0.95` specifically: "A
civics question read at conversational speed is hard to follow for somebody
studying in a second language, which is most of the people this product is
for." `speechRate` governs the **browser** `speechSynthesis` path only —
`utterance.rate` is a client-side playback parameter with no equivalent on
the premium synthesis path in this epic's scope (OpenAI's TTS endpoint has no
speed control this application uses today), and folding a speed knob into the
premium path would also have to become part of §4's cache key, which nothing
in this epic's acceptance criteria requires. A learner who wants a slower
premium voice is unaffected by this preference; that is a real, named gap,
not an oversight — see §11.

## 6. Browser speechSynthesis remains the unconditional fallback

`voice.md` §2 is unweakened by any of the above: an unbound `speak` role, a
learner who has expressed no `ttsVoiceId` preference, and a premium
synthesis call that fails all fall back to `window.speechSynthesis`, exactly
as `QuestionAudio.tsx` already implements. Nothing about caching (§4) or a
voice picker (§5) changes when the premium path is unavailable — the picker
simply has nothing to offer, and the question is still read aloud by the
browser, at whatever `speechRate` the learner has set. An unbound `speak`
still warns nobody, for the identical reason `voice.md` §2 already gives:
"an unbound `speak` is simply the state of every fresh install... nothing is
missing."

| `transcribe` | `speak` | Behaviour |
|---|---|---|
| Bound | Bound | Mic renders; auto-submit (or confirm, per `autoSubmitSpoken`) grades spoken answers. Premium "hear this question" is available, served from the cache on a repeat request, and the learner's `ttsVoiceId` preference is honoured when set. |
| Bound | Unbound | Mic renders and grades exactly as above. "Hear this question" runs on browser `speechSynthesis` only — no voice picker has anything bound to offer, and nothing says so, per §2's "not a degraded state" rule. |
| Unbound | Bound | No mic; the session runs entirely in text, per `voice.md` §1's "hidden, not disabled" rule — auto-submit and the retry mechanism (§1, §2) are both unreachable because no spoken attempt is ever produced. Premium "hear this question" still works, cached or not. |
| Unbound | Unbound | No mic, no premium voice. Browser `speechSynthesis` reads every question at the learner's `speechRate`; every practice interaction is typed. Identical to a deployment that has never touched AI voice settings at all. |

## 7. Voice is still always optional

Unchanged from `voice.md` §5, inherited rather than redefined: reading a
question aloud is always an addition to the visible question text, answering
aloud is always an alternative to typing, and switching between the two
mid-session never loses the session, the answered questions, or the progress
counter — `PracticeAttempt.inputMode` is still the per-row column that makes
this true, and E12 adds no session-level "voice session" flag that could
disagree with a mid-session switch. `autoSubmitSpoken: false` is one more way
a learner keeps full manual control over every spoken answer, on top of
typing being available on every question regardless of that preference.

## 8. RBAC

**Adds no permission strings**, for the identical reason `voice.md` §10
already states and this epic does not need to restate at length: every route
this epic adds or extends — `GET /api/civics/questions/:id/audio`,
`GET /api/ai/speech/voices` — is `@Auth()` with no permissions and no
route accepts a user id, because every authenticated learner practises with
their own voice on their own key and hears the same shared civics content
every other learner does. `ROADMAP.md` §7's closed permission set
(`system_settings:read/write`, `users:read/write`, `rbac:manage`,
`allowlist:read/write`, `storage:*`) gains nothing from this epic, matching
every voice-adjacent epic before it.

## 9. Decisions locked

All ten, from epic #280, restated with the reasoning that makes each one
load-bearing rather than a preference:

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Auto-submit replaces confirm-before-grade, and `voice.md` §3 / its own `Decisions locked` #3 is formally amended — not silently contradicted.** | Two specs disagreeing about the same flow is worse than either rule alone, and `ROADMAP.md` §1 forbids silently editing a locked decision — a changed decision is itself worth a record. §1. |
| 2 | **The anti-penalty guarantee moves to `recomputeMasteryForQuestion`, and a correction always costs exactly zero.** | `VISION.md` line 228 is a requirement, not an aspiration; auto-submit opens a high-confidence hole `isMisheardAttempt` structurally cannot see, because it was never asked to see a *corrected* attempt, only a *recorded* one. §2. |
| 3 | **`transcript` is redefined; no `transcript_confirmed` column.** | A boolean would encode, in a second place, exactly what `retryOfAttemptId` already encodes — two representations of "was this corrected" that could drift apart and disagree. §3. |
| 4 | **The audio cache never touches `storage_objects` and writes through the `StorageProvider` port.** | Owner-only reads with no admin bypass is right for a learner's own upload and wrong for shared civics content; threading a bypass through `getObjectWithAuthCheck` would make it a read AND write bypass in one edit, per `CLAUDE.md`'s own warning. §4. |
| 5 | **The cache key is content-addressed, not a question id alone.** | A dynamic answer changes; hashing the exact text makes invalidation automatic and makes serving stale, superseded-answer audio structurally impossible rather than a policy to remember. §4. |
| 6 | **Synthesis on a cache miss always runs on the caller's own key; the server key at `('ai', 'openai')` is never used.** | `CLAUDE.md`'s "Adding an AI feature" and `voice.md` §6: one inference call on the server key silently invalidates every per-user usage figure on `GET /api/ai/usage`, with nothing in the result shape to distinguish the fallback call from a normal one. §4. |
| 7 | **Browser `speechSynthesis` stays the unconditional fallback; an unbound `speak` warns nobody.** | `voice.md` §2: a fresh install with nothing configured must still read every question aloud, with no admin action and no credential. §6. |
| 8 | **Voice is still always optional; typing is available on every path.** | `voice.md` §5, `VISION.md` lines 220–228. §7. |
| 9 | **`autoSubmitSpoken` is a preference, defaulting to `true`.** | The new default is the point of this epic, but the confirm step was load-bearing for at least one real learner (accessibility, trust, a noisy environment) and turning it off must cost that learner nothing. §1, §5. |
| 10 | **No new permission string.** | Every learner practises with their own voice, on their own key, and hears the same shared civics content every other learner does; no route accepts a user id. §8. |

## 10. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Deferring `scheduleMastery`** (holding a spoken attempt's mastery write in a pending state for a short "correction window" before committing it) | Reintroduces exactly the synchronous-scheduling requirement `voice.md` §3.1 and `practice.service.ts`'s own comment already state the reason for — the very NEXT question in the session depends on `question_mastery` reflecting THIS attempt immediately, and a deferred write would have to be reconciled against a selector that already ran without it. A replay after the fact (§2) needs no window at all: it is correct whenever it runs, immediately or much later. §2. |
| **A fifth `PracticeOutcome` value for a superseded attempt** | Repeats the exact rejection `voice.md` §3.1 already made for a "retry-specific" outcome value: it would ripple a migration through every reader of `outcome` (readiness's `spoken` component, progress, mock interviews) for a fact `retryOfAttemptId` plus the replay in §2 already records with no schema change at all. §2. |
| **A `transcript_confirmed` boolean column** | Encodes, in a second place, exactly what `retryOfAttemptId` already encodes — a second representation of "was this corrected" that can disagree with the first. §3. |
| **Caching in `storage_objects` with a nullable owner** | `CLAUDE.md`'s ownership rule for that table has no admin bypass by design, and a nullable-owner special case is precisely the kind of bypass its own warning about `getObjectWithAuthCheck` rules out — "would make it a read and write bypass in the same edit." §4. |
| **A per-learner rather than shared cache** | Defeats the entire point of caching: every learner would independently pay for and store the identical audio for the identical question, which is the exact waste this section exists to remove. Attribution (`generatedByUserId`) already gives the "who paid" answer a per-learner cache would have given for free, at none of its cost. §4. |
| **Pre-warming the whole catalog on the server key** | `CLAUDE.md`'s "no background job may call AI on a user's key" rule, restated for the direction that matters here: a pre-warm job has no user's key to run on at all, so it could only run on the server key at `('ai', 'openai')` — the exact silent per-user-accounting corruption `voice.md` §6 and this document's own §4 already rule out for the request-time path. §4. |
| **Confidence-gated auto-submit** (auto-submit only when `confidence >= 0.6`, confirm-before-grade otherwise) | Reintroduces a second, undocumented confidence threshold with no product reasoning behind the specific cutoff for THIS decision, and — worse — teaches a learner that a LOW-confidence transcript is treated more carefully than a high-confidence one, when a high-confidence-but-wrong transcript (an accent transcribed confidently and incorrectly) is exactly the case §2 exists to protect. Uniform auto-submit plus a zero-cost correction (§2) protects both cases identically, with one rule instead of two. §1, §2. |
| **Duplicating the voice list in `apps/web/src/config`** | `ai-model-roles.ts`'s own argument against a duplicated registry, reused verbatim: a copy "can still disagree in a working tree, in a branch, and in any build where the test is not run" — detection rather than prevention. §5. |

## 11. Out of scope (deliberately)

- **Realtime speech-to-speech** — E11 / #60, unaffected by anything in this
  epic; `voice-hands-free.md` never touches the tool-driven transport
  `docs/specs/realtime-interview.md` specifies.
- **Reading and writing** — E10 / #59; the auto-submit and cache mechanisms
  here are civics-practice-shaped and are not extended to
  `/practice/reading`/`/practice/writing` by this epic.
- **Caching anything but civics question/answer audio.** The `civics_answer`
  scope is declared in `SpeechAudioScope` but has no consuming endpoint in
  this document — the same "declared, not yet wired" posture
  `ROADMAP.md` §8 already accepts for the `embed` model role, so a later
  feature that reads an accepted answer aloud needs no migration to start
  using it.
- **Pre-warming the cache** for any question ahead of a real learner request
  — see §10's rejected alternative; nothing in this epic runs synthesis
  outside a live, per-learner request.
- **Rate limits and spend caps** on speech calls, cached or not — carried
  over unresolved from `ai-settings.md` §18 and `voice.md` §13, unchanged by
  this epic.
- **A second TTS provider or a cross-provider voice catalog format.**
  `AiVoiceDescriptor` is shaped for whatever a provider wants to return; no
  attempt is made here to normalise voice ids across providers that do not
  exist in this codebase yet.
- **Storing the learner's own recording.** `voice.md` §4 is untouched — audio
  a learner speaks is still transcribed and discarded, never persisted, on
  every path this epic touches.
- **A premium-voice `speechRate` control.** §5 states this plainly rather
  than silently: `speechRate` governs the browser fallback only in this
  epic's scope.

## 12. Suggested phasing (non-binding)

Not the actual issue list — the epic owns that — but the dependency order
the modules impose:

1. This document.
2. The `voice` user-settings namespace (§5's six-file change) and
   `AiVoiceDescriptor`/`listVoices()` on `AiProvider`, `OpenAiProvider`,
   `FakeAiProvider`, and `AiDispatchService` — no dependency on anything
   else in this list.
3. `GET /api/ai/speech/voices` (§5).
4. The `speech_audio_assets` migration (§4) and the `StorageProvider`-backed
   cache read/write path, landing behind `GET /api/civics/questions/:id/audio`
   — depends on 2 for the synthesis call the cache-miss path makes.
5. `AttemptGradingService.recomputeMasteryForQuestion` (§2) and the one-line
   change in `recordAttempt`'s retry branch that calls it instead of the
   ordinary `scheduleMastery` — depends on nothing above; it is a pure
   backend change over the schema E9 already shipped.
6. Web: `autoSubmitSpoken` wired into `PracticeSessionPage.tsx`'s
   transcription effect (§1), the retry affordance widened to any spoken
   attempt rather than only a misheard one (the `voice.md` §3.3 amendment),
   and `QuestionAudio.tsx`'s premium path routed through the cached endpoint
   for a civics question ref — depends on 3 and 4.
7. The `voice` namespace's settings-page controls (auto-submit toggle, voice
   picker reading `GET /api/ai/speech/voices`, speech-rate slider) —
   depends on 2, 3, 6.
8. Tests: unit coverage for `recomputeMasteryForQuestion` (the worked example
   in §2.1 as a table of cases), the cache's double-miss race, and a
   Playwright spec extending `tests/e2e/specs/voice.spec.ts` per issue #58's
   own end-to-end acceptance pattern.
9. Documentation: `CLAUDE.md`'s "Adding a New AI Model Role" section gains no
   new entry (no role is added), but its speech-adjacent notes gain a
   pointer here; `docs/API.md` documents the two new endpoints; `voice.md`'s
   own amendment notes (this document's companion edit) land in the same
   commit as the code they describe, not before it.
