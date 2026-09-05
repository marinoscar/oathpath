# Design Spec: Realtime practice sessions (E15, epic #345)

This is the durable design for E15. Read `docs/specs/realtime-interview.md`
first — this document reuses that epic's transport (ephemeral secrets,
tool-mediated turns, WebRTC browser↔provider directly) and extends it to
ordinary practice sessions rather than mock interviews; it does not restate
mechanisms `realtime-interview.md` already specifies unless this document
changes them. Read `docs/specs/conversation-mode.md` (the request/response
hands-free loop this epic adds a second transport alongside, never replaces)
and `docs/specs/voice.md`, `docs/specs/voice-hands-free.md`,
`docs/specs/coach-personality.md` next.

Source of truth for every claim below, verified against this repository's
real state (the `feat/e15-346-docs` worktree, tracking `main`) rather than
assumed from an issue's prose:

- [Issue #346](https://github.com/marinoscar/oathpath/issues/346) itself —
  this document's own charter.
- [Issue #351](https://github.com/marinoscar/oathpath/issues/351) — the
  spoken-turn composer (`composeSpokenTurn`), its element order and
  authorship table, and the two live defects it names on the request/response
  loop (`PracticeSessionPage.tsx:1238`, `useConversationSession.ts:735-737`,
  `:210`, `:323-342`) — verified to exist exactly as quoted (`grep -n
  "spokenAnswer\|CONVERSATION_NUDGE_RETRY"
  apps/web/src/pages/PracticeSessionPage.tsx
  apps/web/src/hooks/useConversationSession.ts` returns the four cited
  lines, unchanged).
- [Issue #353](https://github.com/marinoscar/oathpath/issues/353) — the
  five-tool contract and the mint route's HTTP contract.
- [Issue #354](https://github.com/marinoscar/oathpath/issues/354) — the
  tool-call handler, the single-`recordAttempt` rule, and the
  `gradeCivicsAnswer` duplication it names as the pattern not to repeat.
- [Issue #355](https://github.com/marinoscar/oathpath/issues/355) — the web
  relay hook, the degradation ladder, session bounds and cost.
- [Issue #348](https://github.com/marinoscar/oathpath/issues/348) — the
  sibling fix for the always-`null` `asrConfidence` gap this document
  records but does not implement (§9).
- `apps/api/src/practice/practice.service.ts` — `recordAttempt` (the method
  signature at line 693; the `$transaction` block at lines 862-1040, not
  955-995 as one child issue's prose states — see the correction note in
  §1); `scheduleMastery`'s call site and its surrounding comment (lines
  935-995, spanning both the "why the guard moved" explanation and the call
  itself); `requireSession` (line 1340, the 404-not-403 rule); `plannedCount`
  and the `answered >= session.plannedCount` completion check (line 1675,
  inside `nextQuestionFor`); `completeSession` (line 552).
- `apps/api/src/practice/attempt-grading.service.ts` — `AttemptGradingService`
  (the real class name; `PracticeService` calls it as `this.grading`),
  `resolveAcceptedAnswers` → `gradeDeterministic` → `escalateToGrader`, and
  `scheduleMastery` (line 581) — the one ladder both practice and interviews
  are meant to share.
- `apps/api/src/practice/mastery/mastery-skip.ts` — the shared skip rule
  (issue #245, already shipped): `MasteryEvidence` is a **required**
  argument to `scheduleMastery`, so a third call site cannot compile without
  stating the two facts (`answerResolution`, `misheard`) the rule reads.
  This is the mechanism §5 below builds on.
- `apps/api/src/interviews/interviews.service.ts` — `gradeCivicsAnswer`
  (line 2218, confirmed to exist exactly where issue #354 cites it) and its
  own doc comment (lines 2196-2216) stating plainly that it re-runs
  `resolveAcceptedAnswers` → `gradeDeterministic` → `escalateToGrader`
  "against the same injectable" as `PracticeService.recordAttempt`, because
  it "writes a differently-shaped row" (`mock_interview_turns` plus a
  `GradedCivicsAnswer`, not a bare `practice_attempts` row). **The
  "one condition shorter" scar issue #354 cites is real but its location is
  not**: the comment describing it lives at lines 2029-2066 today (inside
  `recordApplicantTurn`'s civics branch), not 1092-1109 — see §5's
  correction note for what changed and why the line drifted (issue #245
  landed with E11 and rewrote that comment from present into past tense).
  `apps/api/src/practice/realtime/` and `apps/api/src/interviews/realtime/`
  are the two directories issue #354 names; only the second exists today
  (`realtime-tools.ts`, `realtime-tool-calls.ts`,
  `realtime-tool-sequences.spec.ts`, `realtime-instructions.ts`, all for
  interviews) — `grep -rn "practice-realtime\|PracticeRealtimeService"
  apps/api/src` returns nothing.
- `apps/api/src/ai/providers/openai.provider.ts` — `wantsVerboseTranscription`
  (line 1437: `return !/transcribe/i.test(modelId)`) and `runTranscription`'s
  two `json`-branch returns (lines 809 and 833), both
  `transcriptionResult(readTranscriptText(plain), null)` — confidence is
  **unconditionally** `null` for the `gpt-4o-transcribe` family, not merely
  "often" or "in one branch." §9 states what this means for the tool
  contract's own `grade_answer` schema.
- `apps/api/src/readiness/readiness.service.ts` — `spokenCorrectRows` (lines
  681-686): `prisma.practiceAttempt.findMany({ where: { userId, inputMode:
  'spoken', outcome: 'correct' }, ... })`, distinct by `questionId`. The
  filter reads `inputMode` alone — nothing about transport, mode, or how the
  attempt was produced. §9 is built on this being exactly as narrow as it
  looks.
- `apps/api/src/ai/coach/invariants.ts` — `COACH_INVARIANT_FLOOR` (line 63),
  the seven-rule floor, its own header stating it is appended **after** a
  persona fragment and declares itself to override everything above it.
- `apps/api/src/interviews/interviews.controller.ts` — the shipped
  `POST /:id/realtime-session` route (line 372: `@Post`, `@HttpCode(200)`,
  `@Header('Cache-Control', 'no-store')`, no request body, its `ApiOperation`
  description stating the `ok`/`unavailable`/`failed` contract in full) and
  `POST /:id/realtime/tool-calls` (line 481) — §2's mint route and §3's
  tool-call route are modelled on these two, decoration for decoration.
- `apps/web/src/pages/PracticeSessionPage.tsx`,
  `apps/web/src/hooks/useConversationSession.ts`,
  `apps/web/src/components/practice/outcome.ts` (`outcomeDisplay`, line 82),
  `apps/web/src/components/practice/failureCause.ts` (`failureCauseDisplay`,
  line 171) — the request/response loop's current spoken-answer defect §5
  documents, and the screen-only display helpers §5 says must **not** be
  reused for a sentence spoken aloud.
- `docs/specs/realtime-interview.md` §2 (the provider surface —
  `createRealtimeSession`, never-throw, the caller's key only), §3 (session
  lifecycle — the 60-second bookkeeping TTL, `Cache-Control: no-store`,
  never logged/audited, re-mint on expiry, teardown on completion) — this
  epic reuses the identical provider method and dispatch path; it does not
  add a second one. §4 (the tool-contract shape and rejection-result idiom —
  `{ error, instruction }` on a 200 — this epic's five tools follow the
  identical idiom). §7 (the degradation table shape §7 below extends to a
  third fallback rung this epic is the first to need). §12/§13 (`Decisions
  locked` / `Rejected alternatives` — several of this document's own entries
  are the identical argument restated for practice sessions rather than
  interviews, cited rather than re-derived where the argument is unchanged).
- `docs/specs/conversation-mode.md` §4 (the request/response state machine,
  quoted here in full in §7 below for the side-by-side comparison it amends
  into that document), §15 ("The realtime transport (E11)... a later epic's
  scope" — the sentence this epic's companion edit to that document
  replaces, per §346's own acceptance criteria).
- `docs/specs/voice.md` §3/§3.1 (`ASR_CONFIDENCE_THRESHOLD`,
  `isMisheardAttempt`, the confirm-or-auto-submit mechanics this epic's
  `grade_answer` tool deliberately does **not** reuse — see §9) and its own
  amendment idiom (a blockquote naming the amending epic, nothing deleted) —
  this document's companion edits to `voice.md` and `conversation-mode.md`
  follow that idiom exactly, not a paraphrase of it.
- `docs/specs/coach-personality.md` (the two-mechanism architecture —
  reaction-line bank plus persona prompt fragment — and why `supportive`'s
  `promptFragment` is the empty string) and `CLAUDE.md`'s "Adding a coach
  persona" section (the fragment-then-floor ordering, restated in §6 below
  for a session instructions string instead of a `messages` array).

**Nothing described past this line exists yet, verified directly.** `grep
-rn "practice-realtime\|PracticeRealtimeService\|composeSpokenTurn\|
useRealtimePractice" apps/api/src apps/web/src` returns nothing but this
document's own citations above. `practice.controller.ts`'s route table
comment lists seven routes, not nine. `ConversationGrade`
(`useConversationSession.ts:323-342`) carries `outcome`, `spokenAnswer`,
`misheard` and no `spokenTurn` field. `apps/api/src/practice/realtime/`
does not exist. Every path cited above resolves today exactly as described;
every contract below is what this epic's child issues (#347-#358, per the
sibling issues read for this document) build *against*. A child issue is
free to find a better answer to a specific sub-problem as long as it keeps
the contracts this document promises to the pieces around it: the
single-`recordAttempt` rule (§5), the never-throw provider (inherited
unchanged from `realtime-interview.md` §2), and the degradation rule (§7).

---

## 1. Why the verdict is the row, not the model's opinion

**The correction this document must make to its own source material, stated
plainly rather than silently fixed:** one sibling issue cites
`practice.service.ts:955-995` for "`recordAttempt` writes `practice_attempts`
and updates `question_mastery` in one transaction." Verified against the
real file, the transaction itself opens at line 862
(`const attempt = await this.prisma.$transaction(async (tx) => {`) and closes
at line 1040. Lines 955-995 are real and are inside that transaction — they
are the comment block explaining *why* the mastery-scheduling call is placed
where it is, plus the `scheduleMastery` call itself at line 981 — but they
are not the transaction's boundaries. The correct citation is
**`practice.service.ts:862-1040`** for the transaction, **`:981-995`** for
the `scheduleMastery` call specifically.

The mechanism, as it actually reads in the shipped code:

1. `recordAttempt` resolves accepted answers, grades deterministically, and
   escalates to the AI grader on a miss (`AttemptGradingService`'s ladder) —
   all of this **before** the transaction opens, because none of it needs to
   be atomic with the write.
2. Inside the transaction: `tx.practiceAttempt.create(...)` writes the row
   (line ~865), then `this.grading.scheduleMastery(tx, userId, questionId,
   ...)` (line 981) updates `question_mastery` — `state`, `dueAt`,
   `intervalDays`, `correctStreak`, `lapses` — **synchronously, in the same
   transaction**, not fire-and-forget and not a second transaction. The
   comment at the call site states why: the very next `nextQuestionFor` call
   in this same session must see this attempt's effect already applied, and
   that only holds if both writes commit together.
3. `dueAt` is what schedules the question's next appearance — `nextSchedule`
   (`apps/api/src/practice/mastery/scheduler.ts`) is the only function that
   sets it, and it is read by every later selection pass, including E5's
   Study Coach recommender and the `GET /api/practice/queue` counts.
4. `readiness.service.ts`'s `spokenCorrectRows` query (§9) reads
   `practice_attempts.inputMode`/`outcome` directly — not a cached tally, not
   a session summary — so what landed in step 2 is also, eventually, what
   readiness's `spoken` component counts.

**This is the entire argument for why a realtime model must never be allowed
to author a verdict.** A verdict is not a sentence spoken once and forgotten
— it is a row that changes `question_mastery.dueAt` for weeks, changes
whether `GET /api/practice/queue` ever surfaces the question again, and
changes a `readiness_snapshots.components.spoken` figure a learner is shown
as evidence of their own readiness. A model that says "great job!" to a
wrong answer, or "not quite" to a right one, on a live audio connection with
no verdict field to correct it through, has just as much power to falsify
that chain as a model that fabricates a civics question from memory has to
falsify a mock interview's pass/fail (`realtime-interview.md` §12, decision
1) — the harm is identical, only the table changed.

## 2. Session lifecycle: the mint route

```
POST /api/practice/sessions/{id}/realtime-session   @Auth(), no permissions
```

Modelled on `interviews.controller.ts`'s `POST /:id/realtime-session`
(line 372) decoration for decoration: `@HttpCode(200)`,
`@Header('Cache-Control', 'no-store')`, **no request body** — instructions,
tools, and the TTL are the server's, resolved from this practice session's
own state, exactly as the interview route resolves them from
`InterviewState`. `status: 'ok' | 'unavailable' | 'failed'`, all three HTTP
200, for the identical reason `realtime-interview.md` §3 already gives: a
non-2xx would be flattened by generic failure handling and the `cause` —
the one fact this response exists to carry — would never reach the caller.

**409** when the session is not `in_progress`, or when nothing is left to
ask (`answered >= session.plannedCount`, the same check `nextQuestionFor`
already makes at `practice.service.ts:1675`) — these are facts about the
*session*, not about AI, and stay exception-shaped for the identical reason
the interview route's 404/409 do.

Minting goes through the **identical** `AiDispatchService.createRealtimeSession`
(`realtime-interview.md` §2-§3) — no second provider method, no second
dispatch path. The only thing this epic's mint call supplies that the
interview's does not is a different `tools` array (§3) and a different
`instructions` string (§6), built from this practice session's own state
instead of an `InterviewState`. The ephemeral secret's scope, its 60-second
bookkeeping TTL, `Cache-Control: no-store`, "never logged, never a span
attribute, never an audit row," and the re-mint-on-expiry behavior are all
`realtime-interview.md` §3 verbatim — restating the mechanism here would be
exactly the kind of duplicate-that-can-drift `CLAUDE.md`'s registry sections
warn against for a different axis.

**No `mode` flip, and no new column on `practice_sessions` at all.**
`mock_interviews.mode` exists because an interview is one bounded event a
learner conducts once, in one transport, and a coarse "was this ever
conducted by voice" summary is useful precisely because there is one such
fact per row worth summarizing. A practice session's `inputMode` truth is
already per-**attempt**, not per-session
(`conversation-mode.md` §7's own rejected alternative: "a session-level
`mode` column... could disagree with the per-row `PracticeAttempt.inputMode`
a learner's actual answering behaviour already records faithfully"), and
this epic's own degradation ladder (§7) makes a mid-session transport switch
an ordinary, expected event rather than an edge case — a session-level
column would need to answer "which transport" for a session that used two,
and there is no good single answer to give it. `PracticeAttempt.inputMode`
stays `'spoken'` regardless of which speech transport produced the row; §9
is where the finer-grained, deferred distinction is recorded as a decision
rather than built.

## 3. The five-tool contract

Five tools, declared to the realtime model at mint time, every one with
`additionalProperties: false` for the identical reason
`realtime-interview.md` §4 already states for its own three: without it,
"no verdict field" describes only the documentation, not what the wire
format can actually carry.

| Tool | Arguments | Notes |
|---|---|---|
| `next_question` | none | The model cannot propose a question, topic, category, or difficulty — selection stays `mastery/selector.ts`, exactly as `realtime-interview.md` §4.1 already holds for the interview's civics phase. Refused while an answer is outstanding. |
| `grade_answer` | `{ questionId: string; transcript: string }` | **No `verdict`. No `confidence`, deliberately different from the interview's own `grade_answer` (`realtime-interview.md` §4.2), which does carry one.** On this transport a `confidence` argument would be the model self-reporting its own certainty about what it heard — a different quantity from the recogniser-measured `avg_logprob`-derived value `ASR_CONFIDENCE_THRESHOLD` is calibrated against (`voice.md` §3) — and feeding a self-reported number into `isMisheardAttempt` would let a confident-sounding model suppress the mastery-scheduling skip for an answer it actually misheard, or trigger it for an answer it heard correctly but hedged on. `questionId` is compared against the engine's own outstanding item, never assumed. |
| `repeat_question` | none | The re-sync path: a session re-minted after a dropped connection (§7) has a model with no memory of what was already asked. Writes nothing. |
| `skip_question` | `{ questionId: string }` | Only when the learner said so. The session instructions must state the negative case explicitly — **never call this because you did not hear an answer**; silence is not a skip (`voice-hands-free.md` §1's identical rule for the request/response loop, restated here for a tool call instead of a client-side auto-submit guard). |
| `end_session` | `{ reason: 'no_questions_left' \| 'learner_asked' }` | An enum of observations, never a judgement — the identical shape `realtime-interview.md` §4.3 already uses for `end_phase`'s `phase` argument. `no_questions_left` is verified against the engine's own completion check and refused if false. |

**A refusal is HTTP 200**, carrying `{ reason, error, instruction }` — never
a non-2xx, for the identical reason the mint route's `unavailable`/`failed`
statuses are 200s (§2): a non-2xx is flattened by the realtime relay and the
`instruction` — the sentence that gets the model moving again — would never
reach it. §4 gives the closed set of `reason` values this route can produce.

## 4. Four mechanisms that make an invented verdict structurally impossible

Restated in full because this is the entire point of the epic, not a detail
to cross-reference away:

1. **No verdict field going in.** `grade_answer`'s JSON-schema argument type
   (sent to the provider at mint time, enforced as a hard constraint, not a
   prose description) has exactly two properties, `questionId` and
   `transcript`. A compile-time proof over its TypeScript property keys
   fails the build the moment a `verdict`-shaped or `confidence` field is
   added — the identical mechanism `aiSettingsSchema`'s own "no
   secret-bearing field" proof already uses for a different axis
   (`CLAUDE.md`'s "Neither API key is ever a setting").
2. **No verdict field coming back.** The tool-call result type declares
   `say: string[]` (what the model should speak next, §6) and `then` (which
   action the engine chose — `'continue' | 'advance' | 'retry' | 'end'`, an
   *action* name, never an outcome name) and nothing named `outcome`,
   `correct`, or `failureCause`. A second compile-time proof over this
   type's keys closes the return path the identical way the first proof
   closes the argument path.
3. **No accepted answers anywhere the model can reach.** The session
   instructions (§6) never contain a question's accepted-answer text, and no
   tool's result ever returns one — the identical "no field to put it in"
   enforcement `realtime-interview.md` §4.1 already applies to a civics
   question's own prompt text. A model that has never been told what counts
   as correct cannot leak that boundary through a self-reported verdict,
   because it was never given the boundary to leak.
4. **The row commits before a word is spoken.** `recordAttempt` (§1) writes
   the `practice_attempts` row and updates `question_mastery` *before*
   `grade_answer`'s tool-call result is returned to the model — so the
   result the model speaks is downstream of the write, never upstream of
   it. Every failure after that point (the model mis-speaking the
   acknowledgement, the connection dropping mid-sentence, a client-side
   audio glitch) is a speech failure, and the evidence table is already
   correct regardless of what the learner actually hears.

## 5. The single-`recordAttempt` rule, and the scar that must not repeat

**`grade_answer` and `skip_question` call `PracticeService.recordAttempt` —
the public method, not a copy of its ladder.** Everything §1 describes —
mastery scheduling, the misheard-skip rule, the one-attempt-per-session
guard, `requireRetryTarget`'s four conditions, the frozen `answerSnapshot`,
`dropSuperseded` progress accounting, engagement accrual, the read-time
`coachReaction`, and readiness's `spoken` component — holds for a realtime
practice attempt for the mundane reason that it is, literally, the same
code path a typed or request/response-spoken attempt already runs through.

**Why this has to be stated as a rule and not assumed:** E11 already has
the counter-example, and it is real, verified against the shipped file
rather than assumed from an issue's prose. `InterviewsService.gradeCivicsAnswer`
(`interviews.service.ts:2218`) genuinely exists and genuinely re-implements
`resolveAcceptedAnswers` → `gradeDeterministic` → `escalateToGrader` — its
own doc comment (lines 2196-2216) says so outright: "the same three calls in
the same order `PracticeService.recordAttempt` makes, against the same
injectable. Nothing here re-derives what counts as correct" — and gives the
honest reason it exists as a separate method rather than a call to
`recordAttempt`: an interview turn writes a `mock_interview_turns` row and a
differently-shaped `GradedCivicsAnswer`, not a bare `practice_attempts` row,
so the two code paths cannot literally be the same call. **A realtime
practice attempt has no such excuse** — its target row is byte-for-byte the
same `practice_attempts` row `POST /api/practice/sessions/{id}/attempts`
already writes, so there is no shape mismatch left to justify a second
ladder.

**The "one condition shorter" scar is real, but its current location needs
a correction.** One sibling issue cites `interviews.service.ts:1092-1109`
for the comment recording that `InterviewsService` once held "a second copy
of the same `if` that was one condition shorter" than
`PracticeService.recordAttempt`'s mastery-scheduling guard. That comment
exists, verified — but at **lines 2029-2066** today, inside
`recordApplicantTurn`'s civics-answer branch, not 1092-1109. The reason for
the drift matters more than the line number: issue #245 (E11, epic #60)
already landed the fix the old comment asked for — "moving the skip rule
INSIDE `AttemptGradingService.scheduleMastery`, so it is decided once for
both call sites and they cannot disagree" — and the comment at 2029-2066 is
that fix's own historical record, written in the past tense ("WHAT USED TO
BE HERE"), not a live warning about a bug still present. `mastery-skip.ts`
now holds the one rule, `scheduleMastery`'s `evidence` parameter is
**required** (so a third call site cannot compile without stating the two
facts the rule reads), and both `PracticeService.recordAttempt` and
`InterviewsService.recordApplicantTurn` already call through it today. **The
mastery-scheduling half of the old scar is closed.** What issue #354
correctly identifies as still open is the *grading-ladder* half —
`gradeCivicsAnswer`'s duplication of the three-call sequence — which
`mastery-skip.ts`'s fix does not touch and was never meant to: that fix
unified *scheduling*, not *grading*.

**The concrete implication for this epic:** `grade_answer`'s handler must
not become a third grading-ladder implementation alongside
`PracticeService.recordAttempt` and `InterviewsService.gradeCivicsAnswer`.
It has *less* excuse than the interview path to duplicate, because its
target row is identical to `recordAttempt`'s own — so the correct shape is
a direct call, not a third copy that happens to agree with the other two
today and silently drifts from one of them tomorrow.

**Structure**, mirroring `apps/api/src/interviews/realtime/` (which exists
today, unlike its practice counterpart — verified above):

| File | Role | Purity |
|---|---|---|
| `apps/api/src/practice/realtime/practice-realtime-tool-calls.ts` | `decideNextQuestion` / `decideGradeAnswer` / `decideRepeat` / `decideSkip` / `decideEndSession`, over a narrowed context struct | pure — no Nest, Prisma, or Clock |
| `apps/api/src/practice/realtime/practice-realtime.service.ts` | the half that touches a database, and the only caller of `PracticeService.recordAttempt`/`completeSession` from this directory | Nest provider |

**Dependency direction is one-way**: `PracticeRealtimeService` depends on
`PracticeService`; never the reverse. `PracticeService` gains no realtime
import and no realtime branch — the identical constraint
`realtime-interview.md` §4 already holds for `InterviewsService`'s
dependency on the pure `interview-engine.ts`, inverted here because the
dependency runs the other direction (a realtime *wrapper* around an
existing service, not a pure engine an existing service already depends on).

**The closed set of rejection reasons**, each HTTP 200 with
`{ reason, error, instruction }` (§3):

| `reason` | Fires when | Instruction to the model |
|---|---|---|
| `answer_outstanding` | `next_question` called while a `grade_answer`/`skip_question` for the current question has not yet arrived | call `grade_answer` or `skip_question` for the outstanding question first |
| `session_complete` | `next_question` called with `answered >= plannedCount`, or the session is no longer `in_progress` | call `end_session` |
| `wrong_item` | `grade_answer` names a `questionId` other than the one currently outstanding | call `next_question` again rather than retry the same `grade_answer` call — the engine's state has not moved, so a retry would only repeat the rejection |
| `session_not_over` | `end_session({ reason: 'no_questions_left' })` when the engine's own completion check disagrees | continue the session; call `next_question` |
| `already_answered` | `grade_answer`/`skip_question` for a question `recordAttempt` has already recorded (the identical `ConflictException` `recordAttempt` throws for a duplicate practice attempt, caught here and converted rather than left to surface as a 500) | proceed — the answer was already recorded; call `next_question` |

**`recordAttempt`'s already-answered `ConflictException` must be caught and
converted, never left to propagate.** A 500 into the middle of a live,
billing realtime connection is not an acceptable outcome for what is, from
the model's side, an ordinary duplicate tool call (a retried call after a
slow acknowledgement, a race between two nearly-simultaneous `grade_answer`
calls after a connection hiccup) — `already_answered` above is what the
handler returns instead, on the identical "never let an AI-adjacent call
throw where a typed result was possible" posture `docs/specs/ai-evaluation.md`
§3 already establishes for every dispatch call.

**`skip_question` maps to**
`recordAttempt({ questionId, skipped: true, inputMode: 'spoken', promptMode:
'heard', revealed: false })`. `revealed` stays `false` deliberately — it
means the learner had the answer in front of them *before* submitting, and a
skip's accepted answer is spoken (§6) only *after* the skip is recorded, so
`revealed: true` would be a false claim about when the learner saw it. An
empty or missing transcript must never be routed to `grade_answer` and
graded `incorrect` in place of a skip — that would be a false claim about
what the learner did (they declined to answer, not that they answered
wrong), the identical distinction `attempt-grading.service.ts`'s own
`state_required`-vs-`incorrect` split already protects for a different gap.

**`end_session({ reason: 'no_questions_left' })`, honoured, calls
`completeSession`** (`practice.service.ts:552`) — the same method
`POST /api/practice/sessions/{id}/complete` calls, which writes the summary
and recomputes readiness synchronously, and is **idempotent**: a duplicate
`end_session` call (a re-mint racing the original) resolves through the same
already-completed-session path `completeSession` already handles for the
text/typed transport.

## 6. The spoken turn

The request/response loop's own defect, verified rather than assumed: after
a spoken answer is graded, `PracticeSessionPage.tsx:1238` sets

```ts
spokenAnswer: graded.acceptedAnswers[0]?.text ?? null,
```

— the raw first accepted-answer string, nothing else — and
`useConversationSession.ts:735-737` speaks exactly that string, or, on a
miss with an unspent retry budget, `CONVERSATION_NUDGE_RETRY`
(`:210`, `'Say that again.'`) instead. A learner who was right and a learner
who was wrong hear byte-identical audio on a miss with no retry left — "the
Constitution" either way — with no verdict, no reason, and no coach voice
anywhere in the loop, because `ConversationGrade` (`:323-342`) has no field
that could carry any of them: it declares `outcome`, `spokenAnswer`,
`misheard`, full stop.

**The fix is a pure composer, `composeSpokenTurn(attemptResult,
coachReaction) → string[]`**, in a new `apps/api/src/practice/realtime/spoken-turn.ts`
— placed in the `practice/realtime/` directory this epic already creates
(§5) even though the function itself is transport-agnostic, because it is
exposed **additively** as `spokenTurn: string[]` on the ordinary
`POST /api/practice/sessions/{id}/attempts` response. Composing it
server-side and shipping it on the existing response is what lands the fix
on **both** transports at once: the request/response loop
(`conversation-mode.md` §4's `speakingAnswer` state) speaks the identical
words from the identical function, so the current gap closes on the loop
that exists today, not only on the realtime one this epic adds.

The turn, in order:

| # | Element | Authored by | When |
|---|---|---|---|
| 1 | Acknowledgement of what was heard | the client/model | on a miss only — echoing back a right answer is padding |
| 2 | **The verdict** | engine, verbatim | always |
| 3 | **The reason** (the grader's `feedback`) | engine, verbatim | only when `gradingMethod === 'ai'` — when no grader ran there is no reason, and the engine says nothing rather than inventing one |
| 4 | **The accepted answer** | engine, verbatim | on a miss or skip; omitted when a retry is armed, and when `answerResolution === 'state_required'` |
| 5 | **The coach's reaction line** | engine, verbatim | unless `coach.reactions` is `false`; last, because the invariant floor's own closing rule (§7 below) wants the forward action last |

**Do not reuse the web's `outcome.ts`/`failureCause.ts` display strings.**
`outcomeDisplay` (`apps/web/src/components/practice/outcome.ts:82`) and
`failureCauseDisplay` (`.../failureCause.ts:171`) produce chip labels and
screen captions ("Not a match") — a different register from a sentence
spoken aloud, and the API cannot import from the web regardless. A new,
code-owned bank in the API, following `apps/api/src/interviews/engine/officer-lines.ts`'s
pattern: pure data, no interpolation of learner text, reviewable in a diff,
and covered by the identical banned-topic lint E14's reaction bank already
runs over (§7).

**`ConversationGrade.spokenAnswer: string | null` becomes
`spokenTurn: string[]`** in the web's own type, once the API response
carries it — an additive field on the wire, but a real (non-additive)
change to the hook's own port, since the old field is what the current
defect lives on.

## 7. Persona as a curated line, not a licence

The realtime session's own instructions string ends with
`COACH_INVARIANT_FLOOR` (`apps/api/src/ai/coach/invariants.ts:63`),
**imported verbatim and appended last** — the identical placement its own
header already documents for every other prompt that takes a persona
fragment ("AFTER the persona fragment, never before it, and its opening
sentence says it overrides everything above it"). The persona's
`promptFragment` (`apps/api/src/ai/coach/personas.ts`) is **deliberately
excluded** from the realtime session instructions, for the identical reason
`docs/specs/coach-personality.md` §10 already excludes the mock-interview
officer's own prompt from every persona: the officer's `OFFICER_VERDICT_PROHIBITION`
gives no per-question verdict, so there is no sentence for a fragment to
colour, and a realtime session's `say` field (§4) is closer kin to the
officer's own turns than to the grader's `feedback` sentence — the model is
speaking words the engine composed, not framing its own judgement of an
answer.

**This does not mean E14's coach never speaks in a realtime session.** The
curated reaction-line bank (`coach-personality.md`'s free, instant,
AI-independent mechanism) still supplies element 5 of the spoken turn (§6),
persona-selected exactly as `toAttemptResponse`
(`practice.service.ts:1813`) already selects it for the request/response
loop — `composeSpokenTurn` reads a pre-computed `coachReaction.text` and
places it, verbatim, as the turn's last element. What is excluded is only
the second E14 mechanism, the *prompt fragment* appended to a live AI call —
because the realtime model's `say` output (§4) is never itself an AI-graded
verdict or a free-text explanation the way the grader's `feedback` or the
tutor's civics explanation are; it is an acknowledgement sentence the engine
tightly constrains, the identical "no field to put it in" enforcement §4
already applies to a verdict.

**Session instructions contain no question, no accepted answer, no planned
count, and no persona fragment** — the identical assertion
`realtime-interview.md` §4 already makes about the officer's own
instructions, restated here because it is a compile/test-time obligation,
not a prose promise: a test asserts each absence, and a second test asserts
`COACH_INVARIANT_FLOOR` is imported and not restated inline (the identical
guard `interviews/realtime/realtime-instructions.spec.ts` already runs for
the interview's own instructions).

## 8. The degradation ladder, and its single decision site

Built on `voice-hands-free.md` §6's and `voice.md` §1's existing rows,
extended by one rung this epic is the first to need — a fallback **mid**
already-realtime-session, never previously possible because
`realtime-interview.md`'s own transport had no request/response sibling to
fall back to at the practice level:

| Condition | Result |
|---|---|
| `realtime` bound | realtime practice (this epic) |
| `realtime` unbound, `transcribe` bound | today's `useConversationSession` request/response loop, unchanged |
| neither bound | text only, no voice control rendered |
| mint returns `unavailable`/`failed` | falls to the request/response loop |
| microphone refused | falls to text, before any mint is attempted |
| handshake fails, or drops past `MAX_RECONNECTS` | falls to the request/response loop **mid-session**, with a **spoken** notice — a walking learner is not reading the screen, the identical rule `conversation-mode.md` §9 already states for every spoken edge case on that transport |

**Decided at one site**: the effect that already seeds `answerMode` in
`PracticeSessionPage.tsx` (`conversation-mode.md`'s own source list cites it
at line 401), extended with a `realtimeBound` check read from
`GET /api/ai/status`'s `unboundRoles`. The picker stays **two-valued** —
`Text | Voice` — never three; which of the two voice mechanisms Voice
resolves to (realtime, or the request/response loop) is this one site's
decision, not a control a learner makes directly. `realtime` unbound
renders **nothing**, not a disabled control — the "hidden, not disabled"
posture `voice.md` §1's table already specifies, reused rather than
reinvented for a third role.

**Progress is never lost across a fallback**, structurally rather than by
care: every `practice_attempts` row §5's single-`recordAttempt` rule
produces is already committed before the fallback decision is ever made, so
resuming on the other transport is resuming the same `PracticeSession.id`
with the same `answered` count `nextQuestionFor` already computes from the
rows on disk — there is no client-held state a fallback could lose, because
none of the state that matters was ever client-held in the first place.

### 8.1 Both state machines, and which transport each governs

`conversation-mode.md` §4's request/response state machine —
`speakingQuestion → listening → processing → speakingAnswer → advancing` —
**governs the request/response transport only.** It has a `processing`
phase because that transport's grading round-trip (transcribe, then
auto-submit, then grade) takes long enough that a silent gap needs an
earcon to cover it (`conversation-mode.md` §5).

**The realtime transport has no `processing` phase, and none should be
added.** A realtime `grade_answer` tool call resolves inside the same live
connection the model is already speaking over — there is no separate
transcription round-trip to wait out, because the model's own turn-taking
*is* the transcription. The realtime loop is better described as
`officer-speaking ⇄ learner-speaking`, mediated by tool calls
(`next_question`, `grade_answer`, `skip_question`, `repeat_question`,
`end_session`) rather than by a driver-owned state machine with named
phases at all — the provider's own `semantic_vad` turn detection
(`realtimeConnection.ts:107`, cited by issue #355) decides when a turn ends,
not a client-side timer or hangover window the way `useVoiceActivity.ts`
decides it for the request/response transport.

This document's companion edit to `conversation-mode.md` (§14's own
acceptance criterion) states this distinction explicitly in that document
too, so a reader of either spec is told which transport the state machine
in front of them describes, rather than left to infer it from which
document they happened to open first.

## 9. `inputMode`/`promptMode` provenance, and the deferred `transport` column

**`inputMode: 'spoken'`, `promptMode: 'heard'`** — identical to the
request/response transport's own values (`voice.md` §8), and **no new enum
value is added for realtime.** `PracticeInputMode` stays the two-value
`typed | spoken` enum it already is. The reason is arithmetic, not taste:
`readiness.service.ts`'s `spokenCorrectRows` query (lines 681-686) filters
on `inputMode: 'spoken'` **and nothing else** — no transport column, no
mode flag. A third enum value (`'realtime'`, say) would silently **drop**
every realtime-practice attempt out of that filter, zeroing the `spoken`
readiness component for a learner who practises exclusively over the
realtime transport, with nothing in the response, the logs, or a test
failure to report the discrepancy — the identical class of silent
regression `docs/specs/realtime-interview.md` §8 already prevents for the
mock-interview `spoken`/`interview` components by insisting `computeSpoken`
reads `inputMode` and nothing about *how* the attempt was produced.

**Because `grade_answer` carries no `confidence` argument (§3),
`asrConfidence` is written `null` on every realtime practice attempt.**
This is not a gap this epic introduces — it is a gap the epic
*deliberately declines to paper over with a fabricated number*. §3 already
gives the reason a model-self-reported confidence would be a different,
untrustworthy quantity; the honest consequence is that `isMisheardAttempt`
(`practice.service.ts`) can never fire `true` for a realtime attempt on
confidence grounds, because `null` confidence is defined, everywhere in
this codebase, as "unknown," never "low" (`voice.md` §3.1: "**A `null`
confidence never triggers this** — unknown is not low"). A realtime
practice attempt that was genuinely misheard is therefore recorded as a
plain `incorrect`, with the same mastery consequence a genuine wrong answer
carries — **the identical unresolved gap issue #348 already names for the
request/response transport's `gpt-4o-transcribe` binding**, verified
directly: `wantsVerboseTranscription` (`openai.provider.ts:1437`) returns
`false` for any model id matching `/transcribe/i`, and both `json`-branch
returns in `runTranscription` (lines 809, 833) hardcode `confidence: null`
unconditionally for that family. Issue #348 is the sibling fix for that gap
on the request/response path; this document does not attempt a second,
realtime-specific fix, because the realtime transport was never going to
have a real confidence figure to restore in the first place — a
provider-reported turn-detection confidence, if OpenAI's realtime API ever
exposes one, is a different signal than `avg_logprob`-derived ASR
confidence and would need its own calibration against
`ASR_CONFIDENCE_THRESHOLD`'s own `0.6`, not an assumption that the two
numbers mean the same amount of doubt.

### 9.1 The deferred, nullable `transport` column

**Not shipped by this epic.** Recorded here, with its exact shape fixed,
so a later issue that wants it does not have to improvise one, and so a
reviewer of that later issue's schema change has this document to check it
against:

```prisma
enum PracticeAttemptTransport {
  request_response
  realtime
}

model PracticeAttempt {
  // ...existing columns
  transport PracticeAttemptTransport? @map("transport")
}
```

**Nullable, no default, read by nothing this epic ships.** `null` means
"typed, or a spoken attempt from before this column existed" — the same
"absent means unknown, never a claim" discipline `asrConfidence` and
`durationMs` already hold on this table. Grading, mastery scheduling, and
every readiness component keep reading `inputMode`/`outcome` alone, exactly
as §9 above requires — `transport` is not consulted by any of them, on
purpose, for the identical reason `mock_interviews.mode` is a one-way
summary column and not an input to `computeInterview`
(`realtime-interview.md` §8.2: "nothing about *how* a spoken-correct
attempt... came to exist is a fact either component's formula reads"). Its
only purpose, whenever a later issue justifies the migration, is
observability: telling apart a request/response-transport spoken attempt
from a realtime one in cost analysis or support debugging, the same way an
admin might one day want to know how many mock interviews were conducted
by voice versus text without that fact changing a single readiness figure.
It is deliberately **per-attempt**, not per-session, matching
`inputMode`'s own placement rather than `mock_interviews.mode`'s: §2 above
already gives the reason a session-level column would face the "which
transport" question badly the moment a session falls back mid-way (§8), and
a per-row column sidesteps that question by never needing to ask it.

## 10. Cost bounds

**Idle disconnect.** A realtime connection with no tool call and no speech
activity for a bounded interval closes itself rather than billing for
silence — the identical reasoning `realtime-interview.md` §9 already gives
for why a connection's own short-lived secret, not a server-side keepalive,
is what bounds an abandoned session's cost.

**Close, never pause, on:**
- `then: 'session_over'` (an honoured `end_session`, §5),
- `visibilitychange` → hidden (a backgrounded tab still billing for audio
  nobody is listening to is the exact liability a pause would not close),
- component unmount,
- the idle timeout above.

A suspended-but-open connection on a backgrounded mobile tab is a connection
still accruing audio-duration cost with no learner present to generate value
from it — `conversation-mode.md` §8 already names the platform reality
(a locked screen suspends timers and audio alike) that makes "pause" an
illusion on mobile regardless; closing outright is the honest response to a
suspension the application cannot prevent.

**Bounded re-mints.** A dropped connection re-mints up to `MAX_RECONNECTS`
attempts (a named constant, following `conversation-mode.md` §3's own "one
tunable, one named constant" rule) before falling back to the
request/response loop (§8) — never an unbounded retry loop against a
provider that may be genuinely unreachable.

**Never mint without a live microphone**, and never mint for a session with
nothing left to ask — the identical 409 condition §2's mint route already
enforces server-side, checked client-side first so a doomed mint is never
attempted at all.

**A visible elapsed timer** on the control that starts the mode, and **the
billing sentence appears once**, on that same control: the learner's own AI
key is billed by the minute for realtime audio, stated plainly rather than
buried in a settings page, with no invented per-minute price this document
does not have a real number for.

## 11. Echo suppression: structural, then probabilistic

E13's anti-echo guarantee (`conversation-mode.md` §2) is **structural**:
`MediaRecorder` simply is not running while the app's own TTS plays, so
there is nothing for the app's own voice to bleed into. **The realtime
transport gives this up by design, and this document states that plainly
rather than implying otherwise.** Full duplex is the entire point of the
transport — the model must be able to hear a barge-in while it is speaking,
which requires the input stream to be live throughout, exactly the
condition that made the request/response transport's structural guarantee
possible to hold in the first place.

**What replaces it is probabilistic, not structural**: `echoCancellation`
requested on the stream's own constraints (the identical constraint
`conversation-mode.md` §2 already adds to `useAudioCapture`'s persistent-stream
mode, reused rather than reinvented), one line of copy recommending
headphones, and the fact that §4's fourth mechanism makes the failure mode
cheap regardless — the attempt row commits *before* the model speaks (§4),
so an echo-cancelled-but-imperfect audio path produces, at worst, a *speech*
failure (the model mishears its own echo as a fresh answer, or a barge-in
misfires), never a *corrupted evidence* failure. **This is the honest price
of full duplex**, not a defect this epic is quietly accepting without
naming: a structural guarantee that cannot coexist with barge-in is not a
guarantee this transport gets to keep, and pretending otherwise would be
worse than stating the trade plainly.

## 12. What is tested and what is not

**The tool-contract and tool-call-handler suites — no audio, no network, no
key.** §3's five tools and §5's rejection table are specified entirely in
terms of the same server-side state `PracticeService` already exposes
(`requireSession`, `plannedCount`, `answered`, the outstanding question), so
the handler this epic adds is testable the identical way
`interviews/realtime/realtime-tool-sequences.spec.ts` already tests the
interview's own three-tool contract: construct a scripted sequence of
tool-call-shaped inputs against a fixture session, and assert the exact
question sequence, the exact rejection reasons, and the exact spoken turns —
with no database, no network call, and no AI provider anywhere in the loop.

**The equivalence test is the load-bearing one.** One transcript driven
through `POST /api/practice/sessions/{id}/attempts` and the identical
transcript driven through `grade_answer` must produce two `practice_attempts`
rows identical on every column except `id` and `answeredAt` — the concrete,
automatable proof that §5's single-`recordAttempt` rule actually holds,
rather than a claim this document makes and nothing checks.

**A source-reading test enforces §5's dependency direction and §4's
absences** — `apps/api/src/practice/realtime/` contains no call to
`gradeDeterministic`, `escalateToGrader`, or a hand-rolled mastery update;
`PracticeService.ts` contains no import from `practice/realtime/`; the
tool-call result type and the `grade_answer` argument type each fail a
compile-time key-name proof if a verdict-shaped field is added (§4).

**Playwright covers session minting and the fallback, against
`AI_PROVIDER_FAKE=true`** — the identical fixture pattern
`realtime-interview.md` §10 already establishes: `FakeAiProvider` grows a
scripted `createRealtimeSession` implementation (already shipped for the
interview surface; this epic's own mint call reuses it with a different
`tools`/`instructions` payload), so a spec can assert the mint route returns
a well-shaped secret and never a long-lived key, the realtime control
renders `AiNotReady` when `realtime` is unbound, a simulated mint failure
falls to the request/response loop with the session's `id` and progress
intact, and a simulated microphone denial never attempts a mint at all.

**Realtime audio itself is not automatically tested, honestly, for the
identical reason `realtime-interview.md` §10 already states.** No suite in
this codebase opens a real WebRTC connection, speaks synthetic audio at a
live model, and asserts on the barge-in or turn-detection behaviour that
comes back — doing so would either cost a real provider account and real
network access from CI, or fabricate a realtime transport convincing enough
to stand in for genuine speech recognition, at which point the test
verifies the fake rather than the real thing. This document does not invent
a second manual checklist independent of `realtime-interview.md` §11's —
the acoustic behaviour this epic's own transport exhibits (barge-in,
end-to-end latency, audio device switching, network loss, secret expiry) is
the identical physical phenomenon that checklist already covers for the
interview surface, and a release that changes realtime code for either
surface should re-run it. What this epic's own manual pass must add, beyond
that checklist verbatim, is narrower: confirming the **mid-session fallback**
(§8) actually speaks its notice and actually resumes on the same session id
with no lost progress, which is a practice-specific behavior the interview
checklist has no analogue for (an interview does not fall back mid-way to a
second practice-shaped surface the way a practice session falls back to its
own request/response sibling).

## 13. Decisions this document locks

Sourced from the sibling issues this document was built against (§ header),
restated with the reasoning that makes each one load-bearing:

| # | Decision | Reasoning | Source |
|---|---|---|---|
| 1 | **The engine owns the verdict; the model owns the acknowledgement.** No field anywhere in the five-tool contract can carry a verdict, in either direction, and the row commits before it is spoken. | §1's whole argument: a verdict is not a spoken sentence, it is a row that moves `dueAt` for weeks and a figure a learner is shown as evidence of readiness. | #353, #354 |
| 2 | **`grade_answer` and `skip_question` call `PracticeService.recordAttempt` — never a third grading-ladder copy.** | `InterviewsService.gradeCivicsAnswer` is the real, verified counter-example: a second ladder that started in agreement with the first and had to be watched for drift ever since. Practice's own target row is identical to `recordAttempt`'s, so it has no shape-mismatch excuse to duplicate at all. | #354 |
| 3 | **`grade_answer` carries no `confidence` argument.** | A model's self-reported certainty is a different, uncalibrated quantity from the recogniser-measured value `ASR_CONFIDENCE_THRESHOLD` is tuned against; accepting it would let a confident-sounding model suppress or trigger the mastery-scheduling skip on grounds this codebase has no way to trust. | #353 |
| 4 | **`inputMode` gains no third value for realtime.** | `readiness.service.ts`'s `spoken` component filters on `inputMode: 'spoken'` alone; a `'realtime'` value would silently zero that component for a realtime-only learner, with nothing reporting the discrepancy. | #354, verified against `readiness.service.ts:681-686` |
| 5 | **A deferred `transport` column, shape fixed now, not built now.** | Naming the shape in advance is what keeps a later, cost-driven issue from inventing an ad hoc field that reads `inputMode` differently than every existing consumer already does. | #346 |
| 6 | **Echo suppression is probabilistic on this transport, stated plainly rather than implied to be as strong as E13's.** | Full duplex requires a live input stream throughout, which is the exact condition that made E13's structural guarantee possible — the two cannot coexist, and pretending otherwise would understate a real, if low-cost, failure mode. | #355 |
| 7 | **A mid-session fallback is spoken, not merely rendered.** | The identical rule `conversation-mode.md` §9 already states for every edge case on the request/response transport, extended to a new edge case (a realtime handshake failure) this epic is the first to introduce. | #355 |

## 14. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Accepting a `confidence` argument on `grade_answer`, mirroring the interview's own tool** | A model's self-reported certainty about what it heard is a different quantity than the recogniser-measured `avg_logprob`-derived value the request/response transport's `ASR_CONFIDENCE_THRESHOLD` is calibrated against — accepting it would mean trusting a number this codebase has no basis for calibrating, on the exact mechanism (`isMisheardAttempt`) that decides whether a mastery penalty lands. §3. |
| **Adding a `'realtime'` value to `PracticeInputMode`** | `readiness.service.ts`'s `spokenCorrectRows` query filters on `inputMode: 'spoken'` alone (verified, lines 681-686) — a third value would silently zero the `spoken` readiness component for any learner who practises exclusively over this transport, with no test or log to catch the regression. §9. |
| **A session-level `mode`/`transport` column on `practice_sessions`, mirroring `mock_interviews.mode`** | An interview is one bounded event with one honest "was this ever voice" summary; a practice session's mid-session fallback ladder (§8) means a single session can legitimately use two transports, and a session-level column has no good single answer to give for that case. `PracticeAttempt.inputMode`, already per-row, already answers the question a session-level column would only answer badly. §2, §9.1. |
| **Building `PracticeRealtimeService` as a second grading path, writing its own `practice_attempts` row directly** | The exact mistake `InterviewsService.gradeCivicsAnswer` already made and is still living with — two implementations of the same ladder that started in agreement and have to be watched for drift forever after. Practice's target row is identical to `recordAttempt`'s own, so there is no shape-mismatch excuse a duplicate could even claim. §5. |
| **Restoring a real ASR confidence for the realtime path by asking the model to self-report one** | Considered and rejected as a mechanism, not merely deferred — a self-reported number is not the same *kind* of signal `ASR_CONFIDENCE_THRESHOLD` is calibrated against, and accepting it would be trusting the model's own opinion of its accuracy on the identical axis (whether an answer should be graded as heard) this whole epic exists to keep out of the model's hands. If OpenAI's realtime API ever surfaces a provider-measured confidence, it would need its own calibration and its own threshold, not a reuse of `0.6` under an assumption the two numbers mean the same doubt. §9. |
| **Pausing the realtime connection on `visibilitychange` instead of closing it** | A suspended mobile tab still bills for an open connection with nobody listening, and `conversation-mode.md` §8 already establishes that a locked screen suspends timers and audio regardless of what this application does — "pause" is an illusion on the one platform this failure mode matters most on. Close, not pause. §10. |
| **A second, epic-specific manual verification checklist, independent of `realtime-interview.md` §11's** | The acoustic phenomena this epic's own transport exhibits — barge-in, latency, device switching, network loss, secret expiry — are the identical physical behaviour that checklist already covers; a second, parallel checklist would be a second document to keep synchronized with the first every time either transport's underlying WebRTC/session mechanics change, for zero additional coverage. §12. |

## 15. Out of scope (deliberately)

- **The full-screen voice surface** (a dedicated realtime-practice screen,
  analogous to `/practice/interviews/:id/voice`) — a sibling issue's scope,
  not this document's; this epic's own web work can mount inside the
  existing `PracticeSessionPage.tsx`, per issue #355's own exclusion.
- **English reading/writing segments, and mock interviews.** This epic's
  slice is ordinary practice sessions only. `/practice/reading`,
  `/practice/writing`, and `/interviews/*` already have their own realtime
  (interview) or non-realtime (English) stories and are untouched by
  anything in this document.
- **A real ASR confidence figure for the request/response transport.**
  Recorded as a real, open gap in §9 and left to issue #348, which this
  document does not restate the fix for beyond naming it.
- **Restoring `asrConfidence` for realtime by any mechanism.** §9/§14 state
  why this is a rejected idea, not a deferred one — there is no provider
  signal today this codebase could calibrate against `ASR_CONFIDENCE_THRESHOLD`
  in good faith.
- **A readiness-model change of any kind.** §9 is explicit that
  `computeSpoken`/`computeInterview` need nothing new to already credit a
  realtime practice attempt correctly, exactly as
  `realtime-interview.md` §8.2 already established for the interview
  surface on the identical mechanism.
