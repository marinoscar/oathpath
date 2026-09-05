# Design Spec: Voice foundation (E9, epic #58)

This is the durable design for E9: the epic that wires `transcribe` and
`speak`, the two speech roles `docs/specs/ai-settings.md` declared and left
inert. It answers the one question a one-word diff (`wired: false` →
`wired: true`) cannot answer on its own — what happens to every already-running
deployment the instant those two roles start counting toward readiness — and
it writes down the fairness mechanism `VISION.md` names as this product's
hardest requirement: a learner who knew the answer and was misheard must never
be recorded as wrong.

`docs/specs/ai-settings.md` (epic #25) built the role registry, the
provider abstraction, and the two-flag status gate. `docs/specs/ai-evaluation.md`
(E4) built the dispatch door and the `failure_cause` taxonomy, including
`misheard` — declared, not yet produced. This document is what produces it.
Read both first; this document extends their contracts rather than restating
them.

Source of truth for every claim below:

- `apps/api/src/ai/ai-model-roles.ts` — `AI_MODEL_ROLES` (`transcribe` and
  `speak` — both `wired: false` **today**, before this epic ships;
  capabilities `'transcribe'` and `'tts'`), `wiredModelRoles()`,
  `TEXT_CAPABILITY_FAMILIES` (`['text']` only), `AI_CAPABILITY_FAMILIES`, and
  `capabilityForRole`. §1 below adds a `textModelRoles()` helper beside
  `wiredModelRoles()` in this same file.
- `apps/api/src/ai/ai-settings.service.ts` (`describeReadiness()`, lines
  ~250–283) — the exact formula **today**: `unboundRoles` is
  `wiredModelRoles().filter((role) => !settings.models[role.key])`, and
  `systemReady` is `providerConfigured && settings.enabled &&
  unboundRoles.length === 0`. §1 narrows `systemReady`'s formula in the same
  commit that wires `transcribe`/`speak`, and states exactly why the two
  changes must land together.
- `apps/api/src/ai/ai-dispatch.service.ts` (lines ~539–592) — the real,
  already-implemented check order behind the four `AiUnavailableCause`
  values: `!settings.enabled` → `ai_disabled`; provider missing or the
  resolved capability family unsupported → `capability_unsupported`; no
  model bound for the role → `role_unbound`; no caller credential →
  `no_user_key`, checked last. §6 below reuses this exact order for the two
  new speech methods.
- `apps/api/src/ai/ai-status.service.ts` and
  `apps/api/src/ai/dto/ai-status.dto.ts` — `GET /api/ai/status`'s two
  independent flags, the in-process cache invalidated on a settings write, and
  the compile-time `ForbiddenFieldNames` proof that the response carries no
  secret or admin-only field. §1 adds **no field** to this DTO — see its
  rejected-alternatives entry in §12 for why a new field was considered and
  dropped.
- `apps/api/src/ai/base-ai.provider.ts` — the never-throw pattern this
  document extends to `transcribe`/`synthesize`: a `protected abstract` hook
  that may throw freely, wrapped once in a `try`/`catch` a subclass never
  sees; `SecretRedactor.protect()` called the instant a key is obtained,
  before anything that can throw while holding it; span status set from the
  RESULT, never from reaching `return`; the single `formatError` choke point
  for every error string this class emits.
- `apps/api/src/ai/providers/ai-provider.interface.ts` — the "NO METHOD ON
  THIS INTERFACE MAY THROW. Ever." header and `AiCapabilitySet`, the
  membership test that makes a provider's capability flags load-bearing
  rather than decorative.
- `apps/api/src/ai/ai.types.ts` — `AiUsage` ("EVERY FIELD IS NULLABLE, AND
  THAT IS THE POINT"), `AiCompletionRequest`/`AiCompletionResult`, and
  `AiRecordedCompletionResult` — the shapes §7's two new result types are
  modelled on.
- `apps/api/src/ai/ai-dispatch.service.ts` — `AiDispatchService.run` /
  `runStructured` / `runStream`, the four-step resolution order (role
  binding → capability → caller's key → provider call → record), and the
  `AiUnavailableCause` union. §6 below extends this door with two new
  methods rather than adding a fifth request shape to `run` itself — see
  §6's own note on why `AiRunRequest`'s `{ messages, maxTokens }` shape
  cannot carry an audio buffer.
- `docs/specs/ai-evaluation.md` §4 (the four `AiUnavailableCause` values and
  why the first three are checked before `no_user_key`), §5 (the one
  credential address inference may touch, and what silently falls back to
  the server key breaks), and §8 (`PracticeFailureCause`, the six-value
  enum, `misheard`'s definition: "the response answers a *different*
  question than the one asked, consistent with mishearing the prompt...
  paired with a low ASR confidence score E9's transcription pipeline has
  not shipped yet").
- `apps/api/prisma/schema.prisma` — `PracticeFailureCause` (line ~1355, the
  six-value enum with `misheard` already a member), `model PracticeAttempt`
  (line ~1413: `inputMode`/`promptMode`/`responseText`/`answerSnapshot`/
  `failureCause`/`aiFeedback`/`aiUsageEventId`, and the block comments
  explaining why each is nullable and for what distinct reason), and the
  `onDelete: SetNull` pattern already used on `PracticeAttempt.sessionId`,
  `.mockInterviewId`, and `.aiUsageEventId` — the pattern §8 below reuses
  for `retryOfAttemptId`.
- `apps/api/src/readiness/readiness.service.ts` (~lines 531–540) — the
  `spoken` component's real query: `practiceAttempt.findMany({ where:
  { userId, inputMode: 'spoken', outcome: 'correct' }, distinct:
  ['questionId'] })`. §3.2 states why this needs no change for the
  supersession rule to hold.
- `apps/api/src/practice/practice.service.ts` (`recordAttempt`, ~lines
  549–604) — the existing one-attempt-per-question-per-session guard: a
  `ConflictException` ("Question ... has already been answered in this
  session") thrown when a `practiceAttempt` row already exists for
  `{ sessionId, userId, questionId }`, with the rule's own stated reason
  ("would let a learner grind the same question five times and call it a
  Quick 5"). §3.3 relaxes this guard for exactly one case.
- `apps/api/src/storage/objects/objects.controller.ts` — the multipart
  upload shape (`req.file()` via Fastify's multipart plugin, `@Auth()`
  ownership-scoped, no size check shown at the controller layer today) that
  §9's transcribe endpoint's byte-cap enforcement must NOT copy uncritically
  — see §9's note on why the cap has to be checked before dispatch, not
  inherited from that pattern.
- `apps/web/src/components/ai/AiNotReady.tsx` — issue #43's shared
  point-of-use component: returns `null` when `systemReady`, otherwise an
  `info`-severity `Alert` naming `status.unboundRoles` to an admin. §1 relies
  on this component's existing behavior unchanged for `tutor`/`grader`, and
  on `status.unboundRoles` naming `transcribe`/`speak` too once they are
  wired — the same field, no new one, now reporting more roles because more
  roles are wired.
- `VISION.md` line 228 (quoted in full in §3) and lines 220–230 (the six
  voice requirements: hear questions aloud, answer verbally, type instead,
  switch without losing progress, interrupt naturally, retry when misheard).
- `ROADMAP.md` — E9 (#58, this epic), E10 (#59, reading and writing), E11
  (#60, realtime speech-to-speech); E9's dependency line ("Depends on E4...,
  E3..., and E6...").
- `CLAUDE.md` — "Adding an AI feature" (the one-door rule and the exact
  reasoning against a server-key fallback, restated in §6 for the speech
  path specifically) and the RBAC section's "no permission string" pattern
  for every other learner-owned surface, which §10 follows without
  modification.

**Nothing described past this line exists yet.** `transcribe` and `speak` are
`wired: false` in `AI_MODEL_ROLES` today, and `describeReadiness()`'s
`systemReady` formula still runs over every wired role with no `textModelRoles()`
narrowing; `AiProvider` has no `transcribe` or `synthesize` method;
`practice_attempts` has no `transcript`, `asr_confidence`, or
`retry_of_attempt_id` column; there is no `/api/ai/speech/*` route; and no
ASR-confidence constant exists anywhere in the repository. Every path cited
above resolves today exactly as described; every contract below is what this
epic's child issues build *against*. A child issue is free to find a better
answer to a specific sub-problem as long as it keeps the contracts this
document promises to the pieces around it: the never-throw provider, the
typed `unavailable` result, the one credential address, the no-user-id rule,
and the degradation rule in §1.

---

## 1. The degradation rule

`AI_MODEL_ROLES` declares `transcribe` (capability `'transcribe'`) and
`speak` (capability `'tts'`) with `wired: false` today. **This epic flips
both to `wired: true`.** That is not a side detail — it is the entire point
of E9: a role nobody dispatches to yet is worthless, and `wired: true` is
what lets `OpenAiProvider`'s new `transcribe`/`synthesize` methods (§7) and
`AiDispatchService`'s new `transcribe`/`synthesize` methods (§6) actually be
reached from a route. `realtime` and `embed` stay `wired: false` — this
epic wires exactly the two roles it produces a real caller for, following
`ai-model-roles.ts`'s own rule ("Set `wired: true` only when something
actually dispatches to it," restated from `CLAUDE.md`'s "Adding a New AI
Model Role"). The registry's array is also reordered so the four now-wired
roles (`tutor`, `grader`, `transcribe`, `speak`) come first, matching the
existing comment that order is meaningful because the admin page renders it
in array order.

**Flipping `wired: true` alone, with no other change, breaks every existing
deployment.** `AiSettingsService.describeReadiness()`'s formula, unchanged
until this epic, is:

```ts
const unboundRoles = wiredModelRoles()
  .filter((role) => !settings.models[role.key])
  .map((role) => role.key);

systemReady = providerConfigured && settings.enabled && unboundRoles.length === 0;
```

`wiredModelRoles()` is `AI_MODEL_ROLES.filter((role) => role.wired)`. The
moment `transcribe` and `speak` join that filtered set, `unboundRoles` (and
therefore `systemReady`) starts requiring a bound model for both — and every
already-deployed installation that has never touched a voice setting, and
whose admin changed nothing, reports `systemReady: false` from that deploy
onward, until that same admin binds two models they were never told they
needed. `AiNotReady.tsx` renders unconditionally the instant `systemReady`
flips, so this is not a cosmetic regression: it is every AI surface in a
running installation — tutor explanations, the grading ladder — going dark
for a reason that has nothing to do with either of them, discovered by an
admin who did not touch the AI settings page at all. This is the failure the
rest of this section exists to prevent.

**The fix: wire the roles and narrow `systemReady` in the same commit.**
`systemReady` stops meaning "every wired role is bound" and starts meaning
"every wired role whose `capability` is in `TEXT_CAPABILITY_FAMILIES` is
bound" — today that set is exactly `tutor` and `grader`, because
`TEXT_CAPABILITY_FAMILIES` is `['text']` and both are the only roles whose
`capability` is `'text'`. A new helper sits beside `wiredModelRoles()` in
`apps/api/src/ai/ai-model-roles.ts`:

```ts
/**
 * The wired roles a numeric-generation-floor / systemReady-style rule should
 * apply to: text roles only. `transcribe` and `speak` are wired (this epic)
 * but are NOT in this set, so a fresh install with no voice configuration
 * reports systemReady exactly as it did before this epic shipped.
 */
export function textModelRoles(): AiModelRoleDef[] {
  return wiredModelRoles().filter(
    (role) => TEXT_CAPABILITY_FAMILIES.includes(role.capability),
  );
}
```

`describeReadiness()` narrows accordingly:

```ts
const unboundRoles = wiredModelRoles()
  .filter((role) => !settings.models[role.key])
  .map((role) => role.key);   // UNCHANGED — every wired role, incl. transcribe/speak

const unboundTextRoles = textModelRoles()
  .filter((role) => !settings.models[role.key]);

systemReady =
  providerConfigured && settings.enabled && unboundTextRoles.length === 0;
```

**`unboundRoles` itself is not narrowed, and that is what makes the rest of
this section work with no new API surface.** It keeps its existing,
unchanged meaning — every *wired* role with no binding — and because
`transcribe`/`speak` are now wired, it naturally starts reporting them when
they are unbound, with no new field and no new endpoint. `GET
/api/ai/status`'s `AiStatusResponseDto` keeps exactly the five fields it has
today (`userKeyConfigured`, `systemReady`, `enabled`, `providerConfigured`,
`unboundRoles`); only the two fields' doc comments in
`apps/api/src/ai/dto/ai-status.dto.ts` change, to state that `systemReady`
now means "the text roles are bound" rather than "every wired role is
bound," and that `unboundRoles` may now legitimately contain `'transcribe'`
or `'speak'` without that implying `systemReady: false`.

A voice surface therefore reads the identical field `AiNotReady.tsx` already
reads, asking a narrower question of it: `status.unboundRoles.includes
('transcribe')`. A future voice-specific point-of-use component (out of
scope for this document — a web issue's own concern) follows `AiNotReady
.tsx`'s existing convention of naming the role rather than saying "some
models," reading `unboundRoles` for the one key it cares about instead of
`systemReady`, which no longer answers a voice surface's question at all
(by design — see the table below).

| Role | Bound | Unbound behaviour | Who sees what |
|---|---|---|---|
| `transcribe` | Mic control renders in spoken practice mode; `POST /api/ai/speech/transcribe` dispatches normally. `'transcribe'` absent from `unboundRoles`. | The mic is **hidden**, not disabled — the session runs in text mode with no visible affordance for an action that cannot succeed. `'transcribe'` appears in `unboundRoles`; `systemReady` is **unaffected**, because `transcribe` is not in `textModelRoles()`. A learner sees nothing missing (voice was never offered); an admin holding `system_settings:read` sees `transcribe` named on a voice-specific point-of-use surface, not on `AiNotReady`'s app-wide one. | Every learner (mic present/absent); admin-only diagnostic naming the role, scoped to voice surfaces only. |
| `speak` | "Hear this question" control renders and calls `POST /api/ai/speech/synthesize` for the premium voice. `'speak'` absent from `unboundRoles`. | **Not a degraded state at all** — see §2. `'speak'` appears in `unboundRoles`, and `systemReady` is unaffected for the identical reason. Browser `speechSynthesis` is the default and needs no binding, so "hear the question" keeps working exactly as before. No warning renders anywhere, because nothing is missing. | Every learner (same "hear it" affordance either way, via a different mechanism); no admin message, because there is nothing to fix. |
| `tutor` / `grader` | Contributes to `systemReady`, exactly as today — both are in `textModelRoles()`. | `systemReady: false` (unchanged formula for these two), `AiNotReady.tsx` renders app-wide, naming the role via the same `unboundRoles` field. Completely unchanged by this epic. | Every learner sees the blocked-at-point-of-use state; admin sees the role named. |

## 2. Browser `speechSynthesis` is the default text-to-speech

"Hear this question aloud" ships on day one of this epic, on every
deployment, with no admin action, no credential, and no per-call cost: the
web client calls the browser's own `window.speechSynthesis` /
`SpeechSynthesisUtterance` API, which every evergreen browser implements
locally.

`speak` (the `AI_MODEL_ROLES` entry, capability `'tts'`) is an **optional
premium upgrade** layered on top — a higher-quality, provider-hosted voice an
admin may bind once they have a reason to (a `speak`-capable model, budget for
the calls). `POST /api/ai/speech/synthesize` (§9) is that upgrade's only
route.

This is why row 2 of §1's table is not a "degraded" state at all: it is not
described as a fallback in this document's language, because a fallback
implies something worse-but-functional is substituted for something better
that failed. Here the base experience (browser TTS) is not worse than the
premium one in any way that requires a warning — a learner hears the
question either way — and `speak` unbound is simply the state of every fresh
install. Rendering `AiNotReady`-style copy over an unbound `speak` would tell
a learner something is broken when nothing is: the exact "silence, a
spinner, or a generic error... send the user to check the one thing that is
NOT wrong" failure `AiNotReady.tsx`'s own header names for the key-vs-system
distinction, reproduced here for the wrong reason if a voice surface treated
every unbound role identically.

## 3. Confirm-before-grade

`VISION.md` line 228, quoted verbatim, is the requirement this section
exists to satisfy:

> practice without being unfairly penalized for accent or speech-recognition
> errors.

The mechanism: **the learner sees the transcript and can edit it before
anything is graded.** A spoken answer never reaches the grading ladder
(`docs/specs/ai-evaluation.md` §6) as raw recogniser output. The flow is
hear → answer aloud → **confirm (or correct) the transcript** → grade — the
confirm step is not optional UI polish, it is the entire anti-penalty
mechanism issue #58 names it as (`Decisions locked` #3).

**The confidence threshold.** A constant, `ASR_CONFIDENCE_THRESHOLD = 0.6`,
lives in `apps/api/src/ai/ai.types.ts` alongside the other speech types §7
declares — a shared constant rather than a number typed at each call site,
for the same reason `SYSTEM_STATUS_TTL_MS` and `STREAK_FREEZE_MAX` are named
constants rather than inline literals elsewhere in this codebase: the value
is a product decision (how much doubt is too much doubt to trust a
transcript unexamined) and a call site repeating the literal `0.6` is a call
site that can drift from it silently on the next edit.

```ts
/** Below this, a transcription is presented to the learner as uncertain and,
 *  if left uncorrected and ultimately graded as a miss, maps onto
 *  `practice_attempts.failure_cause = 'misheard'` — the outcome itself
 *  stays whatever grading found. See docs/specs/voice.md §3. */
export const ASR_CONFIDENCE_THRESHOLD = 0.6;
```

**`asr_confidence < ASR_CONFIDENCE_THRESHOLD` is treated as `misheard`** —
but only as a *candidate* signal, never as a verdict written directly: the
learner's confirmation step is what actually decides what gets graded, and
low confidence is what makes the UI show the raw transcript for editing
rather than silently accepting it. See the worked example below for exactly
how the two interact.

### 3.1 Worked example

Question: "Who is in charge of the executive branch?" The learner says "the
President." `POST /api/ai/speech/transcribe` calls
`AiDispatchService.transcribe` (§6), which returns:

```json
{ "text": "the head of the executive ranch", "confidence": 0.41 }
```

`0.41 < 0.6`, so the confirmation screen renders the transcript **flagged as
uncertain** — the confidence value itself is never shown to the learner as a
number (a raw score like "41% confident" is a diagnostic detail, not
something a naturalization-interview learner needs to interpret), but the
screen's copy and affordance change: instead of a plain "Is this right?"
confirmation, it reads as an explicit invitation to correct a likely
mishearing, with the transcript pre-filled and editable, matching
`VISION.md`'s "retry when the system may have misheard them."

Two branches from there:

- **The learner edits it to "the President" and confirms.** The corrected
  text is what reaches grading, and it is also the only text this attempt
  ever stores: `practice_attempts.responseText` **and** `transcript` both
  store "the President" (the CONFIRMED text — see §8), `asr_confidence`
  stores `0.41`, `inputMode` is `spoken`. The raw recogniser guess — "the
  head of the executive ranch" — is never written to any column. It existed
  only in `POST /api/ai/speech/transcribe`'s response, held in memory on the
  confirm-transcript screen until the learner edited it, and is gone the
  instant they submit. **`transcript` holds what the learner CONFIRMED,
  never the raw recogniser output** — storing the unedited guess there
  instead would record words the learner never agreed they said, which
  turns the one column meant to prove a mishearing was corrected into the
  column that disproves it. The grading ladder runs on the corrected text
  like any other spoken answer; since it matches an accepted answer, it
  grades `correct` — the mishearing cost the learner nothing.
- **The learner does not notice, or the recogniser's guess happens to look
  plausible, and confirms "the head of the executive ranch" as-is.** Nothing
  was edited, so `transcript` and `responseText` both hold that string — the
  confirmed text and the raw guess are identical here, which is the ordinary
  case for every attempt that needed no correction. This text does not match
  any accepted answer, so grading runs exactly as it would for any other
  spoken response and reaches whatever verdict the deterministic match (or
  the AI grader, on a miss) actually produces — ordinarily `incorrect`.
  **This is where the confidence threshold acts, and this is the rule that
  must never be violated: a low-confidence transcription never on its own
  gets the LAST WORD on why an answer missed.** The attempt is written with
  the outcome grading produced — `outcome` is not touched — but because
  `asr_confidence < ASR_CONFIDENCE_THRESHOLD` and that outcome is not
  `correct`, `failureCause` is set to `misheard` **on the server, after
  grading, overriding whatever cause the AI grader supplied**: the
  recogniser's own uncertainty about the TEXT is better evidence about WHY
  an answer missed than a grader's guess from the text it produced. **A
  `null` confidence never triggers this** — unknown is not low, and
  collapsing the two would grade every attempt whose confidence could not be
  read (a provider outage, a field a model did not return) as if the
  recogniser had actively struggled, when it may not have run at all. The
  learner is told (again, in `VISION.md`'s own words) that the system may
  have misheard them and is offered a retry, with the low-confidence
  transcript shown so they can see what went wrong.

  If the learner answers again and it is now transcribed correctly (or they
  type it), that second attempt is written as a **new** `practice_attempts`
  row with `retryOfAttemptId` pointing at the first row's `id` (§8), and the
  first row is left exactly as graded: its `outcome` is whatever the ladder
  produced — ordinarily `incorrect`, and honestly so: the transcript genuinely
  did not match an accepted answer. **No `PracticeOutcome` enum change was
  made, deliberately.** The existing `correct`/`partial`/`incorrect`/
  `skipped` set is unchanged — a fifth, retry-specific value was considered
  and rejected, because it would ripple a migration through every reader of
  `outcome` (readiness's `spoken` component, progress, mock interviews) for a
  fact `failureCause` already records with no schema change at all. What
  makes the first row legible as a corrected mishearing rather than a second,
  unrelated failure is `failureCause: 'misheard'` plus the `retryOfAttemptId`
  link on the row that supersedes it (§3.2) — and, more precisely still, the
  guarantee this whole mechanism exists to give is enforced one layer down
  from `outcome` entirely: a `misheard` attempt is excluded from
  `scheduleMastery`'s call (`apps/api/src/practice/practice.service.ts`,
  `recordAttempt`), so `correctStreak`, `lapses`, `state` and `dueAt` never
  see it. `outcome` stays a truthful record of what the grader found;
  `failureCause` says why it's not damning; the scheduler guard is where the
  "never penalised" promise actually lives.

  **A skip can never be `misheard`.** `skipped` together with a `transcript`
  or an `asr_confidence` is rejected by the request schema outright — a 400,
  never silently dropped or silently accepted. A skip is never `correct`, so
  a skipped attempt carrying a low confidence would otherwise satisfy the
  exact condition above and record `misheard` — telling a learner who
  declined to answer that they were misheard, a claim about an answer that
  was never given.

**Why the retry, and not merely relabeling the outcome:** a mishearing
recorded as one attempt with `failureCause: misheard` and left there is
still one item of evidence saying "this learner failed to answer this
question" — exactly the false discouragement `docs/specs/ai-evaluation.md`
§8 names for the taxonomy's `unknown` value, reproduced here for a different
cause. The retry means a mishearing is **one piece of evidence with a
correction**, not two failures and not one manufactured success: the
original row is kept, unmodified, as the honest record that a mishearing
happened, and the retry row is the actual evidence of whether the learner
knew the answer — linked back so neither is read in isolation. §3.2 covers
exactly how each of the two rows is (and is not) counted downstream.

### 3.2 Supersession

An attempt that another attempt points at through `retryOfAttemptId` is
**superseded**. Two rules follow, and both matter for a different reason:

- **A superseded attempt is never deleted.** It stays in `practice_attempts`
  exactly as written — `outcome` whatever grading produced (ordinarily
  `incorrect`, and left that way: it is the honest record that the
  transcript did not match), `failureCause: misheard` (overriding the
  grader, per §3.1), `transcript` holding the confirmed text (which, in the
  branch that leads to a retry, is the unedited recogniser guess the learner
  confirmed as-is — see §3.1). It is real evidence that a mishearing
  happened, and deleting evidence to make a number look better is precisely
  what this product's evidence-ledger design (`schema.prisma`'s own header
  on this table: "readiness has to be reconstructed from repeated,
  timestamped evidence") does not do anywhere else, and does not start doing
  here.
- **A superseded attempt is excluded from the practice session's summary
  counts.** `PracticeSession.summary` (score, per-category breakdown,
  timing — `docs/specs/practice-sessions.md`) is computed once at session
  completion; the summary's question-count and score arithmetic skips any
  attempt with a non-null `retryOfAttemptId` pointing *at* it (i.e. it is
  superseded), so a mishearing and its correction read as **one answered
  question**, not two, in "you answered 5 of 5" or a per-category score. The
  retry attempt itself counts normally.

**The readiness model needs no change for this, and that is worth stating
rather than assuming.** `ReadinessService`'s `spoken` component
(`apps/api/src/readiness/readiness.service.ts`, ~lines 531–540) counts
distinct `questionId` among rows matching `inputMode: 'spoken'` **and**
`outcome: 'correct'`. A superseded attempt reaches `outcome: 'correct'` only
in the branch where the learner's confirmed text actually matched — the
first branch in §3.1's worked example — and a row that is `correct` is
never the one a retry supersedes in the first place: nothing offers a retry
for an attempt that already graded `correct`. The row that *can* be
superseded is the low-confidence one — `isMisheardAttempt` requires a
non-`correct` outcome as one of its own three conditions, so `failureCause:
'misheard'` and `outcome: 'correct'` never co-occur on any row by
construction, not by coincidence. §3.1's protection for this row lands at
the mastery scheduler guard, not at `outcome`, which is why the row was
never counted in `spoken` to begin with: it is excluded there for the
mundane reason every other `incorrect` row is (the component reads
`outcome: 'correct'` only), regardless of how `failureCause` reads. No
filter or exclusion needs to be added to `readiness.service.ts` for §3.2's
supersession rule to hold there; it already only reads the kind of row a
superseded attempt never is.

### 3.3 The one-attempt-per-question rule, relaxed for exactly one case

`PracticeService.recordAttempt` (`apps/api/src/practice/practice.service.ts`)
throws `ConflictException` today when `{ sessionId, userId, questionId }`
already has a `practiceAttempt` row — the guard's own comment states why:
"would let a learner grind the same question five times and call it a Quick
5." A retry (§3.1) is a second, legitimate attempt at the same question in
the same session, so this guard must admit exactly that case without
reopening the grinding loophole it exists to close.

**The relaxation: a second attempt at an already-answered question is
admitted only when its `retryOfAttemptId` names that exact existing
attempt.** Concretely, `recordAttempt`'s existing-attempt check widens from
"any row exists for this question in this session → reject" to "a row
exists for this question in this session, and the incoming attempt is not a
retry naming that row's id → reject; a retry naming it → admit." A caller
cannot retry an arbitrary attempt by guessing an id: it must be the specific
prior row for the same `{ sessionId, userId, questionId }`, so the guard
degrades from "one attempt" to "one attempt, plus one traceable correction
of it" — never to "unlimited attempts." A row can be superseded **once**:
retrying an attempt that is itself already a retry target (or already
superseded) is a second `ConflictException` under the same guard, because
the practice flow only ever offers a retry immediately after a low-confidence
transcription (§3.1) — there is no UI path that asks a learner to retry an
attempt a session has already moved past.

## 4. Audio is never stored

**Transcribe, keep the text, discard the buffer.** This is `Decisions locked`
#5 from issue #58 and it is enforced structurally, not by policy:

- **Nothing reaches `storage_objects`.** `POST /api/ai/speech/transcribe`
  never calls `StorageObjectsService`, never issues an upload-init flow, and
  the audio buffer received by the controller is handed directly to
  `AiDispatchService.transcribe` and then dropped when the request completes
  — there is no code path from the speech controller into the storage
  module at all.
- **No column in the schema can hold audio bytes or reference a stored
  recording.** §8's three new `practice_attempts` columns are `transcript`
  (`String?`, text), `asr_confidence` (`Float?`), and `retry_of_attempt_id`
  (`String? @db.Uuid`, a self-referential FK to another `practice_attempts`
  row — never to a `storage_objects` row). No `bytea` column, no
  `storageObjectId` foreign key, no file path string is added anywhere by
  this epic. A future reviewer checking this claim greps `schema.prisma` for
  a new column referencing `storage_objects` from any table this epic
  touches and finds none.
- **The buffer lives only for the duration of the provider call.** The
  multipart body Fastify parses into memory (or a stream, per §9's size cap)
  is read once, passed to the transcription call, and goes out of scope when
  the request handler returns. There is no intermediate write to disk, to a
  cache, or to a queue.
- **No log line or span attribute carries the bytes or the transcript.**
  `BaseAiProvider`'s spans already carry the rule this epic inherits
  unchanged: model id, role key, token counts, a boolean — never
  content. §7's `AiTranscriptionResult` and `AiSynthesisResult` types are
  built the same way `AiCompletionResult` is: the text and audio fields
  reach the caller's return value, never a `this.logger.warn(...)`
  interpolation or a `span.setAttribute(...)` call. The one place a
  transcript's raw text is genuinely useful in a diagnostic message — "the
  provider returned no transcription" — is the same shape
  `completeStructured`'s own rule already follows for a grader's reply: the
  failure message describes the SHAPE of the problem, never quotes the
  content.

**Nothing is persisted client-side either.** The web client holds the
recorded audio in memory only for the span between "stop recording" and
"receive the transcript," using a `MediaRecorder` `Blob` that is discarded
(no `URL.createObjectURL` retained past the upload, no write to
`IndexedDB`, no `localStorage` entry, and no download link ever offered for
it) the moment the transcription response arrives or the request fails.
There is no "listen back to your answer" feature in this epic — VISION.md's
"patient human coach" framing is served by the confirm-the-transcript step,
not by an audio-replay affordance that would itself be the retained
recording this section rules out.

## 5. Voice is always optional

Every voice surface has a text path, unconditionally:

- Reading a question aloud is an addition to the existing read-the-question
  UI, never a replacement for it — the question text is always rendered.
- Answering aloud is an alternative to typing, never the only way to answer
  a practice question. The picker between the two is per-question, not a
  session-wide mode lock.
- **Switching between voice and text mid-session must not lose the
  session, the answered questions, or the progress counter.** A practice
  session (`practice_sessions`, `docs/specs/practice-sessions.md`) is
  identified by its `id` regardless of which `inputMode` each attempt inside
  it used — `PracticeAttempt.inputMode` is already a per-row column, not a
  per-session one (`schema.prisma`'s own comment: "a readiness model that
  cannot tell a typed/read attempt from a spoken/heard one cannot honor that
  distinction"). This epic adds no session-level "voice session" flag that
  could disagree with a mid-session switch; the practice service's existing
  `POST /api/practice/sessions/{id}/attempts` route accepts an attempt in
  either mode against the same session id, unchanged by this epic beyond the
  new columns §8 adds to what that route can record.
- With `transcribe` unbound (§1), voice mode is unavailable and the session
  runs entirely in text — this is the ordinary optional-voice case, not a
  special one, because voice was never mandatory to begin with.

## 6. All inference through the dispatcher, on the caller's key

Every speech call — transcription and synthesis alike — is dispatched
through `AiDispatchService`, exactly as every other inference call in this
codebase is (`docs/specs/ai-evaluation.md` §3's "no feature ever imports a
provider" rule).

**This document's own contract is narrower than "every call goes through
`AiDispatchService.run`," and the difference is worth stating precisely.**
`AiDispatchService.run(userId, role, request)` takes an `AiRunRequest —
{ messages: AiMessage[]; maxTokens?: number }` — a text-in-text-out shape
that cannot carry an audio buffer in, or audio bytes out. Rather than
overload `run`'s request type with optional audio fields no text caller
ever populates (the same "bag of optional fields" shape
`AiStreamEvent`'s own header rejects for a different reason), this epic adds
two new methods to `AiDispatchService`, mirroring `run`'s four-step
resolution order exactly:

```ts
// apps/api/src/ai/ai-dispatch.service.ts additions
export interface AiTranscribeRunRequest {
  audio: Buffer;
  mimeType: string;
  /** Total seconds of audio, when the caller can supply it. */
  durationSeconds?: number;
}
export type AiTranscribeRunResult =
  | AiRunUnavailable
  | { status: 'ok'; text: string; confidence: number | null; usageEventId: string | null }
  | { status: 'failed'; errorCode: string; error: string; usageEventId: string | null };

export interface AiSynthesizeRunRequest { text: string }
export type AiSynthesizeRunResult =
  | AiRunUnavailable
  | { status: 'ok'; audio: Buffer; contentType: string; usageEventId: string | null }
  | { status: 'failed'; errorCode: string; error: string; usageEventId: string | null };

class AiDispatchService {
  // ...existing run / runStructured / runStream
  transcribe(userId: string, request: AiTranscribeRunRequest): Promise<AiTranscribeRunResult>;
  synthesize(userId: string, request: AiSynthesizeRunRequest): Promise<AiSynthesizeRunResult>;
}
```

Each follows the same check order the shipped `run`/`runStructured`/
`runStream` already use (`ai-dispatch.service.ts`, ~lines 539–592), unchanged
by this epic — master switch, then provider, then capability family, then
binding, then the caller's own key **last**:

1. **`!settings.enabled` → `ai_disabled`.** The deployment-wide master
   switch, cheapest to know (one cached boolean) and checked first for
   exactly that reason.
2. **No provider configured, or the configured provider's capability set
   does not include `'transcribe'`/`'tts'` → `capability_unsupported`.**
   Still deployment-wide, still cache-only. Real today, unlike its role in
   `docs/specs/ai-evaluation.md` §4 for `tutor`/`grader` — that document
   calls this cause "unreachable today, because OpenAI is the only provider
   and it declares all six families." A text-only provider (Anthropic, Kimi,
   Qwen, per `ai-settings.md` §10) has no `'transcribe'`/`'tts'` in its
   `AiCapabilitySet` at all, so `capability_unsupported` is the FIRST cause
   this codebase can actually produce in production, the day a second,
   speech-incapable provider is configured.
3. **No model bound to the role → `role_unbound`.** `settings.models
   ['transcribe']` / `['speak']` is `null`.
4. **No credential at `('ai-user', <caller's id>)` → `no_user_key`.** The
   one caller-specific check, and the one costing an indexed lookup instead
   of a cache hit — checked last for the identical reason
   `docs/specs/ai-evaluation.md` §4 gives: when both an admin-side gap and a
   missing personal key are true at once, the caller is told about the
   admin-side gap first, because that is the one an ordinary caller (not an
   admin) cannot fix by re-entering anything of their own.
5. **Call `AiProvider.transcribe` / `.synthesize` (§7), then record usage**
   and return a result that names what happened — `AiTranscribeRunResult` /
   `AiSynthesizeRunResult`'s `'ok'` / `'failed'` / `'unavailable'`
   discriminated shape, matching `AiRunResult`'s own shape in
   `docs/specs/ai-evaluation.md` §3.

**Only the caller's own key is ever read**, from exactly the address
`docs/specs/ai-evaluation.md` §5 already locks:
`CredentialsService.getSecret(AI_USER_CREDENTIAL_PURPOSE,
aiUserCredentialName(userId))`. **The server credential at
`('ai', 'openai')` is never read on a speech path.** It exists, as
`ai-settings.md` §11 and `CLAUDE.md`'s "Adding an AI feature" section both
state, for the model catalog and the admin's connection test only. The
reason restated for this specific surface: the instant one transcription or
synthesis call runs on the server key instead of the caller's, every
per-user usage figure on `GET /api/ai/usage` becomes wrong from that call
onward, **silently** — `ai_usage_events.userId` still names the caller, but
the tokens (or, for speech, the minutes of audio processed) were actually
billed to the administrator's OpenAI account, with nothing in the result
shape to distinguish a fallback call from a normal one and no compile error
or failing test to catch it. A speech feature is not exempt from this rule
merely because its unit of consumption (audio duration, not tokens) is
different from `AiCompletionResult`'s; the failure is identical either way.

## 7. The provider surface

`AiProvider` gains two methods, following `complete`/`completeStructured`/
`stream`'s existing shape (`base-ai.provider.ts`, `ai-provider.interface.ts`)
exactly: a public method on the interface that never throws, implemented
once in `BaseAiProvider` as a `try`/`catch` around a `protected abstract`
hook that MAY throw freely.

```ts
// apps/api/src/ai/providers/ai-provider.interface.ts additions
transcribe(userId: string, apiKey: string, request: AiTranscriptionRequest): Promise<AiTranscriptionResult>;
synthesize(userId: string, apiKey: string, request: AiSynthesisRequest): Promise<AiSynthesisResult>;
```

```ts
// apps/api/src/ai/base-ai.provider.ts additions — as shipped
protected abstract runTranscription(
  apiKey: string,
  request: AiTranscriptionRequest,
  redact: SecretRedactor,
): Promise<AiTranscriptionResult>;

protected abstract runSynthesis(
  apiKey: string,
  request: AiSynthesisRequest,
  redact: SecretRedactor,
): Promise<AiSynthesisResult>;
```

The hooks are named `run*` rather than after the public methods they serve,
matching `runCompletion` and `runStructuredCompletion` beside them: the
prefix is what tells a subclass author at a glance that they are looking at
the throwing inner half, not the never-throw outer one. They return the
full result type rather than a structural subset, so a provider that
already has an `AiTranscriptionResult` in hand — the fake does — hands it
straight back instead of destructuring and rebuilding it.

`transcribe` and `synthesize` (the public methods) are gated the same way
`AiDispatchService` gates role resolution: called only when
`this.supports('transcribe')` / `this.supports('tts')`, matching the
existing `supports(family: AiCapabilityFamily)` method
`BaseAiProvider` already implements once over `this.capabilities`.

**New result types, in `apps/api/src/ai/ai.types.ts`**, modelled on
`AiCompletionResult`/`AiRecordedCompletionResult`'s existing shape — a
result type, never a thrown exception, and every usage field nullable for
the identical reason `AiUsage`'s own comment states ("a call that fails
mid-stream yields partial or no usage... `null` means unknown"):

```ts
export interface AiTranscriptionResult {
  success: boolean;
  /** The recognised text. Null on failure. */
  text: string | null;
  /**
   * The provider's own confidence, 0–1, when it reports one. NULL means
   * "the provider did not report a confidence score" — NEVER defaulted to 0
   * or 1. A stored 0 would claim total distrust the provider never
   * expressed; a stored 1 would silently exempt an unscored transcription
   * from the ASR_CONFIDENCE_THRESHOLD check in §3, which is the one check
   * this field exists to feed.
   */
  confidence: number | null;
  usage: AiUsage;
  errorCode: string | null;
  /** Redacted, verbatim. Never the transcript — see §4's logging rule. */
  error: string | null;
  usageEventId: string | null;
}

export interface AiSynthesisResult {
  success: boolean;
  /** The synthesized audio, on success. Null on failure. */
  audio: Buffer | null;
  /** e.g. 'audio/mpeg'. Null on failure. */
  contentType: string | null;
  usage: AiUsage;
  errorCode: string | null;
  error: string | null;
  usageEventId: string | null;
}
```

**Why the capability flags are load-bearing here specifically, not just by
inheritance from `ai-settings.md` §10's general argument:** Anthropic, Kimi
and Qwen offer chat but no speech API at all — no transcription endpoint, no
TTS endpoint. Without `AiCapabilitySet` gating `transcribe`/`synthesize`
before a call is attempted, an admin on one of those providers could bind
`speak` (the settings write itself is a separate check — see
`ai-settings.md` §10's "a provider that does not declare a capability
cannot be selected for that role" — but a stale binding from a provider
switch is exactly the gap `AiDispatchService`'s own `capability_unsupported`
cause exists to catch at dispatch time, not only at bind time) and discover
the mistake only when a learner presses the mic and the call fails with a
provider error that says nothing about *why* the provider can't do this.
`capability_unsupported` is a value the caller can render as "your
administrator's configured provider does not support this" rather than a
raw 404 from an API surface that does not exist.

## 8. The schema additions

Three columns on `practice_attempts`, none of them holding audio (§4):

```prisma
model PracticeAttempt {
  // ...existing columns

  // The text the learner CONFIRMED they said, after the confirm-before-grade
  // step (§3) — NOT the raw recogniser output, which this schema does not
  // store at all (§4). Null for a typed attempt — there was no recognition
  // step to record. For a spoken attempt this holds the same string as
  // `responseText` today; the two are still separate columns because they
  // answer different questions that merely happen to share an answer right
  // now — see the prose below the schema block.
  transcript String? @map("transcript") @db.Text

  // The recogniser's own confidence for `transcript`, 0-1. NULL means
  // unknown or not applicable (a typed attempt), NEVER defaulted to 0 or 1
  // — the same reasoning `AiUsage`'s fields are nullable (docs/specs/voice.md
  // §7): a stored 0 would claim the provider expressed total distrust it
  // never reported, and a stored 1 would silently exempt an unscored
  // transcription from the ASR_CONFIDENCE_THRESHOLD check that reads this
  // column.
  asrConfidence Float? @map("asr_confidence")

  // Set when this attempt is a RETRY of a prior attempt this same learner
  // made on the same question, offered after that attempt graded normally
  // but was flagged `failureCause: misheard` because of a low-confidence
  // transcription (docs/specs/voice.md §3.1). Self-referential FK,
  // onDelete: SetNull — NOT Cascade —
  // matching `sessionId`/`mockInterviewId`/`aiUsageEventId` above: Cascade
  // would delete the RETRY the moment the ORIGINAL attempt it points at is
  // removed, which destroys the better of the two pieces of evidence (the
  // corrected answer) to protect the worse one (the mishearing). SetNull
  // instead leaves the retry standing on its own as ordinary evidence, with
  // only the link to its origin gone.
  retryOfAttemptId String? @map("retry_of_attempt_id") @db.Uuid
  retryOfAttempt   PracticeAttempt?  @relation("PracticeAttemptRetry", fields: [retryOfAttemptId], references: [id], onDelete: SetNull)
  retries          PracticeAttempt[] @relation("PracticeAttemptRetry")
}
```

`transcript` is deliberately a separate column from `responseText`, not a
flag on it, even though the two hold the same string on every spoken attempt
today: they answer two different questions that merely happen to share an
answer right now. `responseText` is "what was graded" — read by grading and
by every existing reader of this column, unchanged since before this epic.
`transcript` is "what came back from the recogniser and was confirmed by
the learner" — the CONFIRMED text, never the raw, unedited guess (§3.1),
which this schema does not store at all. A future epic that grades
something other than the confirmed transcript — for example, scoring the
raw recognition separately from the edited answer — must not have to guess
which of the two a historical row meant, which it could not do if the two
facts were collapsed into one column now.

## 9. The endpoints

```
POST /api/ai/speech/transcribe   @Auth(), no permissions
POST /api/ai/speech/synthesize   @Auth(), no permissions
```

**`POST /api/ai/speech/transcribe`** — multipart (Fastify's multipart
plugin, the same mechanism `POST /api/storage/objects`'s `simpleUpload`
already uses via `req.file()`). Request: one audio file field. **Response:
a discriminated union on `status`, always HTTP 200.** On success,
`{ status: 'ok', text: string, confidence: number | null }` and **nothing
else** — no usage event id, no model id, no raw provider metadata. The
success shape is narrow on purpose: the caller (the web client's
confirm-transcript screen) needs exactly those two fields to do its job, and
every additional field returned is one more thing a future change to this
endpoint has to keep compatible or treat as a breaking change. Otherwise,
`{ status: 'unavailable', cause, role }` or `{ status: 'failed', errorCode,
error }` — see the note under `synthesize`, directly below, for why these
are 200s rather than a 404 or a 503.

**The byte cap and the duration cap are both enforced BEFORE dispatching to
`AiDispatchService.transcribe`**, so an oversized file is a 400, not a
billed call. Recommended caps: **10 MB, 120 seconds.** The byte cap is
checked from the multipart stream's own length (Fastify's multipart plugin
exposes a `limits.fileSize` option on the parser itself, rejecting an
oversized part before the full body is even buffered — this must be
configured at the route's multipart options, not left to the storage
module's own upload-size handling, because `POST /api/storage/objects`
today does not demonstrate an enforced cap at the controller layer worth
copying uncritically: see this document's source list note on
`objects.controller.ts`). The duration cap cannot be known from byte size
alone (audio encodings vary enormously in bytes-per-second), so it is
enforced from the codec's own duration metadata where cheaply readable, and
otherwise from a conservative worst-case byte-size-to-duration ratio for the
accepted encoding — the concrete mechanism is an implementation-issue
decision, but the constraint is fixed here: **both caps are checked before
any provider call is made**, never after a partial transcription attempt.

Both are `@Auth()` with **no permissions and no user-id parameter** —
resolved from `@CurrentUser('id')`, exactly as every other learner-owned
route in this codebase (practice, journey, readiness, engagement, mock
interviews). The reasoning is the one `CLAUDE.md` already states for each of
those: every authenticated learner practises with their own voice on their
own key, and gating either route on a permission would leave a Viewer unable
to practise at all — there is no "use voice" privilege in this product's
authorization model, and inventing one here would be the first exception to
a rule every other learner-facing surface in this codebase follows without
exception.

**`POST /api/ai/speech/synthesize`** takes `{ text: string }` and, on
success, streams back audio bytes with the provider's own `Content-Type`
(e.g. `audio/mpeg`). **When there is no audio, the response is
`application/json` — `{ status: 'unavailable', cause, role }` or
`{ status: 'failed', errorCode, error }` — at HTTP 200**, told apart from
the audio case by `Content-Type` alone. An earlier draft of this section
called for a 404-shaped "not available" response instead; what shipped is
`AiDispatchService`'s existing `AiUnavailableCause`, delivered as a value
rather than a status code, for the identical reason `docs/specs/ai-evaluation.md`
§4 already gives for `AiRunResult`'s `unavailable` branch: a non-2xx here is
exactly what `HttpExceptionFilter` (which suppresses detail in production)
and the web client's generic non-2xx handling would discard, and the cause
is the one fact this response exists to carry. The same reasoning applies to
`transcribe`'s `unavailable`/`failed` branches above.

## 10. RBAC

**Voice adds no permission strings**, for the identical reason every other
learner-owned surface in `CLAUDE.md` adds none: `AiDispatchService` resolves
the caller's own key and the request carries no user id, so there is no
"transcribe on someone else's behalf" or "read someone else's speech usage"
action to gate. `apps/api/src/common/constants/roles.constants.ts` today
defines no `storage:*`-shaped `speech:*` or `voice:*` permission, and this
epic does not add one — matching the AI module's own existing rule
(`ai-settings.md` §11: "every authenticated user owns their own
credentials, and gating them would leave a Viewer unable to use the app at
all").

## 11. Decisions locked

All six, from issue #58, restated with the reasoning that makes each one
load-bearing rather than a preference:

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Browser TTS is the default; `speak` is an optional upgrade.** | "Hear the question" must work on a fresh install with zero configuration and zero cost — an admin who has not touched AI settings at all must not be the reason a learner cannot hear a question read aloud. §2. |
| 2 | **Wiring a voice role must not break existing installations.** | `systemReady` was computed over every `wiredModelRoles()` member; wiring `transcribe`/`speak` alone, without narrowing `systemReady` to the text roles in the same commit, would make every deployed installation report not-ready the instant this epic merges — for a capability nobody asked for yet, discovered by an admin who changed nothing. §1. |
| 3 | **The transcript is confirmed by the learner before grading.** | This is the anti-penalty mechanism `VISION.md` line 228 requires. Grading raw ASR output treats a speech-recognition failure as a civics-knowledge failure — the exact conflation this epic exists to prevent. §3. |
| 4 | **A low-confidence miss is flagged `failureCause: misheard` and withheld from mastery scheduling — `outcome` stays whatever grading honestly found.** | Without the scheduling withholding, an accent or a noisy microphone becomes a scheduling penalty (a reset streak, a lapse, a pulled-in `dueAt`) indistinguishable from not knowing the material — the recognizer's own uncertainty about the TEXT says nothing about the learner's recall, so `question_mastery` must never see it. §3, §3.1. |
| 5 | **Audio is not stored.** | An unnecessary recording of someone's voice, made while they practice for a naturalization interview, is a liability this product has no use for and every reason to avoid — retaining it would create a sensitive data store with no corresponding feature need. §4. |
| 6 | **Voice is always optional.** | `VISION.md`'s "type instead when voice is inconvenient" and "switch between voice and text without losing progress" are stated as user-facing requirements, not aspirations; a learner who cannot or does not want to use voice must have the identical practice experience by text. §5. |

## 12. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Leaving `transcribe`/`speak` unwired forever, wiring nothing** | Never actually ships the feature this epic exists to build — nothing would ever dispatch to either role, matching `ai-model-roles.ts`'s own rule that `wired` means "something actually dispatches to it." Worse for THIS document's own purpose: `unboundRoles` is filtered to `wiredModelRoles()`, so an unwired role can never appear in it no matter how unconfigured it is — nothing on the web could ever name `transcribe` or `speak` as the reason a mic is missing, and every voice surface would have to invent a second, parallel source of truth just to ask "is my own role bound?" §1. |
| **A new `boundRoles` field on `GET /api/ai/status`** | Considered and dropped: once `transcribe`/`speak` are wired (this epic's actual design), the EXISTING `unboundRoles` field already answers "is my role bound?" with no change to its meaning — it was never the field that needed fixing, `systemReady`'s formula was. Adding a field on top of that would be pure duplication, and `AiStatusResponseDto`'s own compile-time proof (`ForbiddenFieldNames`, `dto/ai-status.dto.ts`) exists specifically to keep a convenience field off the widest-read payload in the application; its own comment anticipates almost this exact move ("If you are here to add a `ready` boolean because 'the client always checks both'") for the identical class of temptation. §1. |
| **A combined `voiceReady` flag** | Reproduces the exact mistake `ai-settings.md` §5 already rejected once for `systemReady`/`userKeyConfigured`, and `ai-evaluation.md` §4 rejected again for a single `unavailable: boolean`: `transcribe` unbound and `speak` unbound are different facts with different remedies and different urgency (one hides a control, one is invisible by design), and a caller merging them into one flag cannot render either message correctly. §1. |
| **Grading the raw transcript without confirmation** | Directly violates `VISION.md` line 228. A learner who says the right answer and is misheard would be graded exactly as if they had said the wrong thing, with no mechanism to distinguish the two — the precise unfairness this epic's slice exists to remove. §3. |
| **Retaining audio for review** ("in case a learner disputes a grade") | The retry mechanism (§3.1) already gives a learner a correction path with no audio required — the transcript, the confidence score, and the linked retry attempt are sufficient evidence for any dispute this could otherwise justify recording. Storing audio "just in case" is exactly the liability `Decisions locked` #5 exists to foreclose, and a feature built to be able to replay a recording is a feature that has quietly reintroduced storage this epic's own acceptance criteria rule out. §4. |
| **Letting a low-confidence miss flow through with no `failureCause` flag and no mastery-scheduling exclusion** | `outcome` was always going to stay whatever grading found — the design never routes around `incorrect` at that column. What this alternative would have skipped is the two things that actually protect the learner: the `failureCause: 'misheard'` flag that tells a reader why the row missed, and the scheduler guard (§3.1) that keeps the miss out of `question_mastery`. Without them, a good-English-speaker's accent or a noisy room becomes a reset streak, a lapse, and a pulled-in `dueAt`, indistinguishable afterwards from a real gap in learner knowledge. §3, §3.1. |
| **Using the server key (`('ai', 'openai')`) for transcription or synthesis** | Concentrates every speech call's real cost on the administrator's account with no per-user attribution, invisibly — nothing in `AiTranscriptionResult`/`AiSynthesisResult` would ever distinguish a fallback call from a normal one, reproducing `ai-evaluation.md` §5's rejected alternative for a second inference surface. §6. |
| **Storing the audio blob client-side for replay** | Same liability as server-side retention (`Decisions locked` #5), moved to the browser instead of the database, and equally rejected: an `IndexedDB` or `localStorage` recording of a learner's voice, made while practicing for an immigration interview, is retained sensitive data regardless of which machine holds it. §4. |
| **Overloading `AiDispatchService.run`'s request type with optional audio fields** | Reproduces the "bag of optional fields" shape `AiStreamEvent`'s own header already rejects for a different surface: a text caller would compile against fields it never populates, and a compiler asking "did you mean to pass audio here" is better than an incident report asking why a completion request silently carried an empty buffer. Two new methods (`transcribe`, `synthesize`) keep each request type honest about what it actually needs. §6. |
| **Enforcing the duration cap only after transcription completes** | Defeats the entire purpose of a duration cap: the call has already been made and billed by the time an over-length file is detected, so "an oversized file is a 400 rather than a bill" (this epic's own stated goal) would be false. Both caps are checked before dispatch. §9. |

## 13. Out of scope (deliberately)

- **Realtime speech-to-speech was #60 (E11), and has since shipped.** The
  session lifecycle for a live, interruptible spoken conversation, ephemeral
  session tokens, and the tool-call contract that drives a realtime model
  belonged entirely to #60's own design spec
  (`docs/specs/realtime-interview.md`), never to this one — this epic wired
  `transcribe` and `speak`, two request/response speech surfaces, and left
  `realtime` at `wired: false` for E11 to pick up. **That is no longer the
  live state of the registry**: E11 flipped `realtime` to `wired: true` the
  same way this epic flips `transcribe`/`speak` — no schema change, no
  migration, `systemReady` untouched because `realtime`'s capability is not
  a text one (`docs/specs/realtime-interview.md` §1). This paragraph is
  historical, describing this epic's own scope at the time it shipped, not a
  claim about the registry's state today.
- **Reading and writing tests are #59 (E10).** Vocabulary-sourced sentence
  generation, word-error-rate reading scoring, and dictated writing scoring
  are #59's scope; this document's transcription surface is a building block
  E10 depends on (per `ROADMAP.md`'s dependency line), not a feature that
  produces those scores itself.
- **The web components** — audio capture (`MediaRecorder`, push-to-talk,
  every permission state), question playback, the spoken-mode UI, and the
  confirm-transcript screen. This document specifies the API contracts and
  product rules those components must honor; their implementation is a
  frontend-dev concern against this spec, not restated here.
- **Rate limiting or spend caps on speech calls.** Carried over from
  `ai-settings.md` §18 and `ai-evaluation.md` §13 — still nobody's job yet,
  and not special-cased for audio despite its different cost profile
  (duration-based rather than token-based).

## 14. Suggested phasing (non-binding)

Not the actual issue list — the epic owns that — but the dependency order
the modules impose:

1. This document.
2. `AI_MODEL_ROLES`: `transcribe`/`speak` flip to `wired: true`, the array
   reorders, and `textModelRoles()` lands beside `wiredModelRoles()` in
   `ai-model-roles.ts` — landing in the SAME commit as step 3, never split
   across two, per §1's own reasoning for why the two changes cannot ship
   independently.
3. `describeReadiness()`'s `systemReady` narrows to `textModelRoles()` (§1);
   `AiStatusResponseDto`'s doc comments update to state the new meaning of
   `systemReady` and `unboundRoles` — no new field.
4. `AiProvider` interface additions + `OpenAiProvider` and `FakeAiProvider`
   implementations of `transcribe`/`synthesize` (§7), including the
   `AiCapabilitySet` gate.
5. `AiDispatchService.transcribe` / `.synthesize` (§6) and the
   `AiUnavailableCause` reuse.
6. The `practice_attempts` migration — `transcript`, `asr_confidence`,
   `retry_of_attempt_id` (§8) — and `ASR_CONFIDENCE_THRESHOLD` in
   `ai.types.ts` (§3).
7. `POST /api/ai/speech/transcribe` and `.../synthesize` (§9), with the
   byte/duration caps enforced before dispatch.
8. The confirm-before-grade flow, the retry-attempt logic (§3.1), the
   `recordAttempt` guard relaxation (§3.3), and the session-summary
   supersession exclusion (§3.2) in the practice module — depends on 6 and 7.
9. Web: capture and playback components, the spoken-mode practice UI, the
   unbound-role degraded state (§1's table), reading `unboundRoles`.
10. `voice.spec.ts` (Playwright), against the fake provider and a fake media
    stream, per issue #58's end-to-end acceptance criteria.
11. Documentation (issue #118): `CLAUDE.md` gains a note alongside "Adding a
    New AI Model Role" pointing here, `docs/API.md` documents both new
    endpoints, `docs/specs/ai-settings.md` is corrected wherever it still
    described `transcribe`/`speak` as inert, and this document's own §3.1
    and §9 are corrected against what actually shipped. Two audiences this
    document does not serve get their own pages:
    [`docs/runbooks/configuring-voice.md`](../runbooks/configuring-voice.md)
    (an administrator deciding whether to bind either role) and
    [`docs/spoken-practice.md`](../spoken-practice.md) (a learner, in
    `VISION.md`'s tone, on what happens to their voice).
