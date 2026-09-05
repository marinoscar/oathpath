# Design Spec: Realtime voice interview (E11, epic #60)

This is the durable design for E11, the epic the whole product points at.
Issue #60's own summary states the aspiration this document exists to make
concrete rather than restate:

> By the time a user walks into their naturalization interview, the
> experience should feel familiar. The user should feel like they are
> speaking with a patient human coach, not operating a voice command
> interface.

E8 (`docs/specs/mock-interview.md`) made the interview real, in text: a
deterministic engine that owns phase order, question selection, grading and
the stop rule, with a model doing nothing but phrasing. E9
(`docs/specs/voice.md`) made speech real: `transcribe` and `speak` wired,
audio captured and played back, a confirm-before-grade step, and the
`misheard`-versus-wrong distinction `VISION.md` requires. This epic joins the
two: the same deterministic engine, driving the same pass rules, over a live,
interruptible, spoken conversation — never a second engine, never a second
truth.

Issue #155, the child issue this document answers, states the risk plainly,
and it is the risk this whole document is organized around:

> This is the epic... where the model is closest to being allowed to run the
> test. A speech-to-speech model asked to conduct a civics interview will
> happily invent a civics question from memory and declare an answer
> correct. `VISION.md` forbids that outright: `OathPath owns the truth. AI
> owns the interaction.` The mechanism that enforces it is a tool contract,
> and a tool contract that lives only in a system prompt is not a contract.

Read `docs/specs/mock-interview.md` and `docs/specs/voice.md` first; this
document extends both of their contracts rather than restating them, and it
assumes `docs/specs/ai-settings.md` and `docs/specs/ai-evaluation.md`'s
provider/dispatch machinery exactly as they already exist.

Source of truth for every claim below, verified against the real repository
state rather than assumed from the epic text:

- [Epic #60](https://github.com/marinoscar/oathpath/issues/60) itself — the
  summary quoted above, the four dependencies (E8, E9, E10, E6), the slice
  (wiring `realtime`, the provider surface, the API, the tool contract, web,
  testing), the end-to-end acceptance criteria, and all five **Decisions
  locked**, quoted verbatim at the point each is spent in §12 rather than
  paraphrased.
- [Issue #155](https://github.com/marinoscar/oathpath/issues/155) itself —
  this document's own charter: the tool-contract obligation, the
  ephemeral-secret security boundary framed as "a security boundary, not an
  implementation detail," the honest-manual-checklist obligation, and the
  acceptance criteria this document is checked against (every claim cites a
  real path; each tool specified with arguments/return/rejection rule; all
  five locked decisions present; a numbered, pass-criterion checklist; an
  honest statement that realtime audio is not automated; a
  rejected-alternatives table covering at least four named alternatives).
- `apps/api/src/ai/ai-model-roles.ts` — `AI_MODEL_ROLES`'s `realtime` entry
  (`capability: 'realtime'`, `wired: false` **today**, comment: "Epic #60
  (E11) is what wires it; until something dispatches to it, wiring it here
  would only make every deployment report itself unready for a feature that
  does not exist"), `wiredModelRoles()`, and `textModelRoles()` — the
  function §1 below states is **unchanged** by this epic, because `realtime`'s
  `capability` is `'realtime'`, not a member of `TEXT_CAPABILITY_FAMILIES`
  (`['text']`).
- `apps/api/src/ai/providers/ai-provider.interface.ts` — the "NO METHOD ON
  THIS INTERFACE MAY THROW. Ever." header, `AiCapabilitySet`, and the exact
  doc-comment shape `transcribe`/`synthesize` already carry (never rejects, a
  provider with no capability returns `capability_unsupported` rather than
  throwing, the caller's own key is passed in rather than resolved
  internally) — §2's `createRealtimeSession` is specified as a fourth member
  of that same family, not a new pattern.
- `apps/api/src/ai/base-ai.provider.ts` — `transcribe`/`synthesize`'s
  shipped implementation, read in full: the capability gate that returns
  before any network call and writes no usage row when it fires; the
  `redact.protect(apiKey)` call the instant the key is obtained; `await`
  kept inside the `try` so a rejection cannot escape the catch; the
  malformed-result guard; the single `formatError`/`formatCaught` choke
  point; span status set from the result, never from reaching `return`; one
  `ai_usage_events` row on success and on failure alike, written through the
  same private `recordUsage`. §2 below models `createRealtimeSession` on
  this file's `synthesize` method line for line, exactly as `synthesize`
  itself was modelled on `transcribe`.
- `apps/api/src/ai/providers/openai.provider.ts` — `OPENAI_CAPABILITIES`
  (line ~121), which **already includes `'realtime'`**: OpenAI is declared
  capable of serving this role today, even though nothing has dispatched to
  it yet. §2 states why this matters for `capability_unsupported`'s
  reachability.
- `apps/api/src/ai/ai.types.ts` — `AiTranscriptionRequest`/`AiTranscriptionResult`,
  `AiSynthesisRequest`/`AiSynthesisResult`, and `ASR_CONFIDENCE_THRESHOLD`
  (`0.6`, "the one consumer today is `PracticeService.recordAttempt`") — the
  exact shape and nullability conventions ("every field nullable, and that is
  the point," "never defaulted to 0") §2's new `AiRealtimeSessionResult` type
  reuses rather than reinvents.
- `apps/api/src/ai/ai-dispatch.service.ts` — the full, real `transcribe`/
  `synthesize` methods (lines ~702–832) and the private `resolve` helper
  (lines ~869–937): the five-check order (`ai_disabled` → `capability_unsupported`
  → `role_unbound` → the caller's own key, decrypted last), the file's own
  header rule that no caller may pass a `modelId`, and the test-enforced rule
  that the server credential's two constants "appear anywhere in it" is
  asserted false by `ai-dispatch.service.spec.ts`. §3 below adds
  `createRealtimeSession` as a fifth sibling of `run`/`runStructured`/
  `runStream`/`transcribe`/`synthesize`, resolved through the same private
  `resolve`, not a sixth copy of its checks.
- `apps/api/src/ai/ai-settings.service.ts` — `describeReadiness()`'s real,
  shipped formula: `unboundRoles` over `wiredModelRoles()`, `systemReady`
  over `textModelRoles()` only, exactly as `docs/specs/voice.md` §1 narrowed
  it for `transcribe`/`speak`. §1 below states why wiring `realtime` needs no
  further change to this formula at all.
- `apps/web/src/components/ai/AiNotReady.tsx` — the shipped, role-scoped
  component (`role` prop, `status.unboundRoles.includes(role)`), read in
  full: it already generalizes past `transcribe`/`speak` to any role key, so
  `<AiNotReady role="realtime" feature="the live interview" />` requires no
  change to this file at all — see §1, §7.
- `apps/api/src/interviews/engine/phases.ts` — `INTERVIEW_PHASES`,
  `SKIPPED_PHASES` (`['reading', 'writing']`, "declared and skipped... a
  debrief must be able to say what was NOT covered"), `PHASE_TURNS`, and the
  file's own note that `civics` is deliberately absent from `PHASE_TURNS`
  because its length is never a constant.
- `apps/api/src/interviews/engine/interview-engine.ts` — the full, pure
  engine read in full: `selectPassRule` (the *only* place the senior branch
  is decided), `planCivicsQuestions` (the seeded, reproducible shuffle),
  `civicsStopReason`'s exact three-branch rule (`threshold_reached` →
  `threshold_unreachable` → `all_asked`, in that order), `startState`,
  `nextPrompt` (which throws — a programming error, not an interview outcome
  — if called on a civics state with no question left), `applyAnswer` (which
  throws if `outcome.phase !== state.phase`), and `passedCivics` (a function
  over state, never a stored flag). §4 below is this file's contract,
  unchanged, driven by tool calls instead of HTTP request bodies.
- `apps/api/src/interviews/interviews.service.ts` — `createInterview`
  (lines ~292–321: `mode: 'text'` written explicitly, never by column
  default, "E9/E11 write `voice` through the same rows; a row whose mode was
  never stated would be indistinguishable from one whose mode was
  forgotten") and `recordApplicantTurn` (lines ~881–1040), read in full,
  including its own explicit warning (lines ~966–1014, quoted in §6) that
  its mastery-scheduling guard is "deliberately one condition shorter than
  its sibling" in `PracticeService.recordAttempt`, that wiring E9 voice into
  interviews "makes this guard wrong immediately," and that "issue #245
  tracks the real fix." §6 below is the section that closes exactly that gap.
- `apps/api/src/interviews/dto/create-interview.dto.ts` — the compile-time
  `ForbiddenCreateInterviewFieldNames` proof (lines ~95–109), which already
  lists `'mode'` among the fields a client may never set on `POST
  /api/interviews`. §3 below states the direct consequence: this epic adds
  no `mode` parameter to that request, and a `mock_interviews` row can only
  ever move from `text` to `voice` through a server-side write this document
  specifies, never a client-supplied value.
- `apps/api/src/interviews/interviews.controller.ts` — the shipped,
  hand-written SSE route for `POST /api/interviews/:id/turns` (headers
  written before any byte, an opening `: connected` comment, `event: delta`/
  `done`/`unavailable`/`error` frames, `res.on('close')` teardown), read in
  full as the transport this epic's tool-driven turns do **not** reuse — see
  §3's note on why the realtime transport is WebRTC, not this SSE endpoint.
- `apps/api/prisma/schema.prisma` — `MockInterview.mode`
  (`MockInterviewMode`, `text` \| `voice`, `@default(text)`), `MockInterviewPhase`
  (`reading`/`writing` "declared now even though E8 skips them"),
  `PracticeInputMode` (`typed` \| `spoken`), `PracticePromptMode` (`read` \|
  `heard`), and the `[userId, status, passedCivics]` composite index on
  `mock_interviews` §8 reads through unchanged.
- `apps/api/src/practice/practice.service.ts` — `isMisheardAttempt` (lines
  ~1652–1659: `asrConfidence === null` → `false`; `asrConfidence >=
  ASR_CONFIDENCE_THRESHOLD` → `false`; otherwise `outcome !== 'correct'`) and
  `recordAttempt`'s own guard (`status !== 'state_required' && !misheard`,
  cited by name inside `interviews.service.ts`'s own comment) — the exact
  condition §6 below requires the realtime path to adopt.
- `apps/api/src/readiness/readiness-engine.ts` — `computeReadiness`'s real,
  shipped weights (`READINESS_WEIGHTS`: `spoken: 0.1`, `interview: 0.1`
  among the eight), `computeSpoken` (`min(distinctQuestionsCorrectSpoken /
  20, 1)`), `computeInterview` (`min(mockInterviewsPassed / 2, 1)`, "the `2`
  is `PRD.md`'s own worked example, not this engine's choice"), and the §2.9
  structural-cap comment naming exactly which two `evidenceCounts` paths
  (`spoken.attempts`, `interview.attempts`) decide `capReason`. §8 below is
  built entirely from these read, verified numbers — no weight in this
  document is invented.
- `apps/api/src/readiness/readiness.service.ts` — `assembleEvidence`'s real
  Prisma queries (lines ~677–732): `spokenCorrectRows` (`prisma.practiceAttempt.findMany({
  where: { userId, inputMode: 'spoken', outcome: 'correct' }, select: {
  questionId: true }, distinct: ['questionId'] })`) and `mockInterviewsPassed`
  (`prisma.mockInterview.count({ where: { userId, status: 'completed',
  passedCivics: true } })`) — §8's worked comparison is arithmetic over
  exactly these two queries, run against the same set of `practice_attempts`
  rows a realtime interview would write.
- `docs/specs/voice.md` §1 (the `textModelRoles()` narrowing and its
  reasoning — "wiring a role is a statement about dispatch, not about
  whether the application as a whole can run"), §3/§3.1 (confirm-before-grade,
  the `ASR_CONFIDENCE_THRESHOLD` worked example, and the `misheard`
  scheduler-exclusion mechanism this epic's civics turns inherit), §4 (audio
  is never stored — the rule this epic's own out-of-scope line in issue #60
  restates for a live stream instead of a recorded buffer), §6 (all
  inference through the dispatcher, on the caller's key, the server
  credential never reachable from a speech path).
- `docs/specs/mock-interview.md` §2 (the six-phase sequence, `reading`/
  `writing` declared and skipped), §3–§4 (the seeded, reproducible civics
  ask-list and the three-reason stop rule), §5 (the engine/model boundary —
  "the engine decides, the model speaks" — and its structural enforcement:
  the question text is never in the model's output path), §6 (the shared
  grading ladder, no self-mark, no feedback before completion), §7
  (`practice_attempts` rows, one evidence table, no `UNION`), §8 (the PII
  stance and `transcript_retained`), §10 (no coaching until the debrief),
  §13 (`mockInterviewsPassed`, the readiness grouping key this epic's voice
  interviews feed identically). This epic changes none of these; §4–§6 below
  are this document's account of what stays true when the transport becomes
  a live tool-driven conversation instead of one HTTP request per turn.
- `docs/specs/ai-settings.md` decision 1 ("Six role slots declared, two wired
  at launch... since E9, four wired, two still inert (`realtime`, `embed`)")
  and decision 4 (BYOK is mandatory; there is no server-key fallback) — §1
  and §3 below are this epic cashing in decision 1's own stated promise for
  the fifth role.
- `docs/specs/ai-evaluation.md` §3 (`AiDispatchService` — the one door, "no
  feature ever imports a provider," the four-step resolution order), §4 (the
  four `AiUnavailableCause` values and their checked order — a closed set
  this epic adds no member to), §5 (the one credential address inference may
  touch, and the concrete, silent failure a server-key fallback would cause,
  restated for realtime specifically in §3 below).
- `docs/specs/readiness-model.md` §2.7 (`spoken`, 0.10, real since #104),
  §2.8 (`interview`, 0.10, real since #133, `PRD.md`'s own "completing two
  mock interviews" quoted verbatim), §2.9 (the structural cap, no
  `min(score, N)` clamp anywhere, "the weights table talking, not a leak"),
  §3 (`capReason: 'typed_only'` reads exactly `evidenceCounts.spoken.attempts`
  and `evidenceCounts.interview.attempts`, and lifts on the first *credited*
  piece of evidence of either kind).
- `VISION.md` line 226 ("interrupt naturally during realtime conversations")
  and the surrounding six voice requirements (hear questions aloud, answer
  verbally, type instead, switch without losing progress, interrupt
  naturally, retry when misheard); "OathPath owns the truth. AI owns the
  interaction," quoted in full by `docs/specs/mock-interview.md` §1 and
  restated here as the rule §4's tool contract exists to enforce
  mechanically rather than by prompt discipline.
- `PRD.md` — "Interview Simulator — conduct realistic, neutral mock USCIS
  interview experiences" (the persona this epic's officer inherits
  unchanged from E8) and "Completing two mock interviews is the best way to
  strengthen your readiness now" (the sentence `computeInterview`'s `2` is
  built from, quoted again in §8).
- `ROADMAP.md` §3's epic table (E11's row: "`realtime` wired, ephemeral
  session tokens, the E8 engine driving a realtime model over tool calls —
  closes Milestone B and the MVP," depends on `#25, E8, E9, E10`, `not
  started`, children `#155`–`#162`), and §2's framing of Milestone B ("Voice
  is *inside* the MVP... a learner who has never spoken an answer aloud, and
  never sat a mock interview, has not produced the evidence the readiness
  model requires to lift its cap").

**Nothing described past this line exists yet, verified directly.** `grep
-rn "realtime-session\|createRealtimeSession\|AiRealtimeSession" apps/api/src
apps/web/src` returns nothing; `AI_MODEL_ROLES`'s `realtime` entry is `wired:
false` today; `AiProvider` has no `createRealtimeSession` method;
`AiDispatchService` has no `createRealtimeSession` method; no
`/api/interviews/:id/realtime-session` route exists; and `grep -rn "mode:
'voice'" apps/api/src` returns nothing — no code path has ever written
`mock_interviews.mode = 'voice'`. Every path cited above resolves today
exactly as described; every contract below is what this epic's eight child
issues (#155–#162) build *against*. A child issue is free to find a better
answer to a specific sub-problem as long as it keeps the contracts this
document promises to the pieces around it: the never-throw provider, the
one-dispatch-door rule, the engine/model boundary from `mock-interview.md`
§5, the `misheard`-never-penalizes-mastery rule from `voice.md` §3, and the
degradation rule in §7 below.

---

## 1. Wiring `realtime`

`AI_MODEL_ROLES`'s `realtime` entry (`apps/api/src/ai/ai-model-roles.ts`,
capability `'realtime'`) flips from `wired: false` to `wired: true` in this
epic — the fifth of the six declared roles to be wired, following exactly
the rule the registry's own comment states ("Set `wired: true` only when
something actually dispatches to it," restated from `CLAUDE.md`'s "Adding a
New AI Model Role"): §2/§3 below are what makes something dispatch to it.

**`systemReady` needs no further change, and that is worth stating plainly
rather than assuming it follows from precedent.** `docs/specs/voice.md` §1
narrowed `systemReady`'s formula, once, from "every wired role bound" to
"every wired role whose `capability` is in `TEXT_CAPABILITY_FAMILIES`
bound" — and `TEXT_CAPABILITY_FAMILIES` is `['text']` (`ai-model-roles.ts`).
`realtime`'s capability is `'realtime'`, not `'text'`, so
`textModelRoles()` — the function `describeReadiness()` actually reads —
returns the identical set it returned before this epic: `tutor` and
`grader`. Flipping `realtime` to `wired: true` therefore does to `realtime`
exactly what E9 already did to `transcribe`/`speak`: it joins
`unboundRoles` (computed over `wiredModelRoles()`, which *is* widened by
this flip) the moment no model is bound to it, and it does **not** touch
`systemReady`. An already-deployed installation with `tutor`+`grader` bound
and nothing configured for voice or realtime reports `systemReady: true`
before this epic ships and `systemReady: true` after it ships, with
`unboundRoles` now also naming `realtime` alongside whatever of
`transcribe`/`speak` it may already have named. This is the concrete,
verified instance of `voice.md` §1's own general claim: "wiring a role is a
statement about dispatch, not about whether the application as a whole can
run."

**The realtime screen gates on the role's own binding, read from `GET
/api/ai/status`'s `unboundRoles`, never on `systemReady`.** This is not a
new pattern this epic invents — it is `AiNotReady.tsx`'s existing, shipped
`role` prop, read in full above: the component already renders for
`status.unboundRoles.includes(role)` when `role` is passed, and does not
consult `systemReady` at all in that mode. Mounting
`<AiNotReady role="realtime" feature="the live voice interview" />` on the
realtime screen requires **no change to `AiNotReady.tsx` itself** — the
component already generalized past `transcribe`/`speak` to any role key
when it shipped in E9, and `realtime` is simply the third role it names.
§7 restates this as the degradation contract in full.

## 2. Provider surface

A fourth speech-shaped method joins `transcribe`/`synthesize` on `AiProvider`
(`apps/api/src/ai/providers/ai-provider.interface.ts`), gated by
`supports('realtime')` exactly as they are gated by `supports('transcribe')`/
`supports('tts')`:

```ts
// apps/api/src/ai/providers/ai-provider.interface.ts additions
/**
 * Mint an ephemeral, single-session client secret for a realtime
 * conversation, on the CALLER's key.
 *
 * NEVER REJECTS — the same rule every method on this interface carries.
 * A provider with no realtime capability returns `capability_unsupported`
 * rather than throwing, exactly as {@link transcribe} does for a chat-only
 * provider.
 *
 * @param userId whose `ai_usage_events` row is written for this MINT call
 *        (§9 — the session's own turns are recorded separately, from the
 *        provider's own reported events, not from this call).
 * @param apiKey the caller's own key, passed in for the identical reason
 *        {@link transcribe}/{@link synthesize} take one: nothing under
 *        `providers/` reads the credential store, so no provider method can
 *        reach for the server key when it should be using a learner's.
 * @returns a short-lived client secret scoped to one realtime session, or a
 *        failure. NEVER the caller's own long-lived API key, and never a
 *        secret whose lifetime this method invents — see §3.
 */
createRealtimeSession(
  userId: string,
  apiKey: string,
  request: AiRealtimeSessionRequest,
): Promise<AiRealtimeSessionResult>;
```

Implemented once in `BaseAiProvider`, over a `protected abstract` hook, on
the identical shape `transcribe`/`synthesize` already establish
(`base-ai.provider.ts`, read in full above):

```ts
// apps/api/src/ai/base-ai.provider.ts additions
protected abstract runRealtimeSessionMint(
  apiKey: string,
  request: AiRealtimeSessionRequest,
  redact: SecretRedactor,
): Promise<AiRealtimeSessionResult>;

async createRealtimeSession(
  userId: string,
  apiKey: string,
  request: AiRealtimeSessionRequest,
): Promise<AiRealtimeSessionResult> {
  const redact = new SecretRedactor();
  redact.protect(apiKey);            // BEFORE anything that can throw while holding it

  const span = tracer.startSpan(`${this.providerName}.createRealtimeSession`);
  span.setAttribute('ai.model', request.modelId);
  span.setAttribute('ai.role', request.roleKey);

  if (!this.supports('realtime')) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'capability unsupported' });
    span.end();
    return { ...this.unsupported('realtime voice sessions'), clientSecret: null, expiresAt: null, model: null };
  }

  // ... await INSIDE the try, malformed-result guard, single formatError
  // choke point, span status from the RESULT — line for line what
  // `transcribe`/`synthesize` already do, never reimplemented.

  // ONE ai_usage_events ROW FOR THE MINT ITSELF, success and failure alike —
  // via the same private `recordUsage` every other public method calls.
}
```

The new result type in `ai.types.ts` carries the ephemeral secret, its
expiry, the model id, and a nullable redacted error — and, deliberately,
**nothing that could carry a long-lived key**:

```ts
// apps/api/src/ai/ai.types.ts additions
export interface AiRealtimeSessionRequest {
  /** The model role this call serves: 'realtime'. */
  roleKey: string;
  /** The bound model id. Resolved by the caller from the settings row — see §3. */
  modelId: string;
  /**
   * Which tools the model may call, and their JSON-schema argument shapes
   * (§4). Sent to the provider so it enforces the same tool set the engine
   * expects to receive calls for — never left to a system-prompt
   * description alone, for the identical "a contract that lives only in a
   * prompt is not a contract" reason issue #155 states outright.
   */
  tools: AiRealtimeToolDeclaration[];
  /** The officer's system instructions — tone and persona only, never a question bank. See §4. */
  instructions: string;
}

export interface AiRealtimeSessionResult {
  success: boolean;
  /**
   * The ephemeral, single-session client secret the BROWSER receives, on
   * success. `null` on failure.
   *
   * THIS, AND NOTHING ELSE ON THIS TYPE, MAY EVER REACH A BROWSER RESPONSE
   * BODY. Everything else on this type — `modelId`, `usage`, `error` — is
   * for this process's own bookkeeping. See §3 for the exact HTTP contract.
   */
  clientSecret: string | null;
  /**
   * When {@link clientSecret} stops being usable, as the PROVIDER reported
   * it — never computed locally. `null` on failure.
   *
   * NOT INVENTED HERE. §3 fixes a concrete TTL for THIS APPLICATION's own
   * session bookkeeping (when to consider the interview's realtime attempt
   * abandoned), but the secret's own validity is whatever OpenAI's response
   * says it is — echoing the provider's own value is the same "the caller
   * reports what it was told, never what it assumes" discipline
   * {@link AiTranscriptionResult.confidence} already holds for a different
   * field.
   */
  expiresAt: Date | null;
  /** The realtime model actually bound, echoed back so a caller can log which model a session ran on without a second settings read. Null on failure. */
  model: string | null;
  usage: AiUsage;
  errorCode: string | null;
  /** The provider's verbatim message, redacted. Null on success. */
  error: string | null;
}

/** One tool the realtime model may call — the JSON-schema shape a provider's session-creation call needs. See §4. */
export interface AiRealtimeToolDeclaration {
  name: 'next_question' | 'grade_answer' | 'end_phase';
  description: string;
  parameters: Record<string, unknown>;
}
```

**Why the capability flag is load-bearing here specifically, and why it is
already, today, a non-issue for OpenAI:** `OPENAI_CAPABILITIES`
(`openai.provider.ts`, line ~121) already includes `'realtime'` — OpenAI
declares itself capable of serving this role, exactly as it already declares
`'transcribe'`/`'tts'`, so `capability_unsupported` for `realtime` is
unreachable in production today for the identical reason
`docs/specs/ai-evaluation.md` §4 already states for `tutor`/`grader`:
"unreachable today, because OpenAI is the only provider and it declares all
six families." The gate exists now, before it is load-bearing, for the same
reason `ai-settings.md` decision 3 introduced the capability-set abstraction
before a second provider existed: Anthropic, Kimi and Qwen offer chat but no
realtime speech-to-speech surface at all, and the day one of them is
configured, `capability_unsupported` becomes this codebase's real, correct
answer to "an admin bound `realtime` to a provider that cannot serve it" —
with no new cause to invent and no existing `switch` to re-audit.

## 3. Session lifecycle

```
POST /api/interviews/:id/realtime-session   @Auth(), no permissions
```

**Minting happens through a new `AiDispatchService.createRealtimeSession(userId,
request)`**, a sibling of `transcribe`/`synthesize` resolved through the
identical private `resolve` helper (`ai-dispatch.service.ts`, lines
~869–937) — the same five checks, in the same order, with the caller's own
credential decrypted last:

```ts
// apps/api/src/ai/ai-dispatch.service.ts additions
export interface AiCreateRealtimeSessionRequest {
  tools: AiRealtimeToolDeclaration[];
  instructions: string;
}
export type AiCreateRealtimeSessionResult =
  | AiRunUnavailable
  | { status: 'ok'; clientSecret: string; expiresAt: Date; modelId: string }
  | { status: 'failed'; errorCode: string; error: string };

class AiDispatchService {
  // ...existing run / runStructured / runStream / transcribe / synthesize
  async createRealtimeSession(
    userId: string,
    request: AiCreateRealtimeSessionRequest,
  ): Promise<AiCreateRealtimeSessionResult> {
    const redact = new SecretRedactor();
    try {
      const resolved = await this.resolve(userId, REALTIME_ROLE, redact);
      if ('status' in resolved) return resolved;

      const result = await resolved.provider.createRealtimeSession(userId, resolved.apiKey, {
        roleKey: REALTIME_ROLE,
        modelId: resolved.modelId,
        tools: request.tools,
        instructions: request.instructions,
      });

      if (result.success && result.clientSecret !== null && result.expiresAt !== null) {
        return { status: 'ok', clientSecret: result.clientSecret, expiresAt: result.expiresAt, modelId: resolved.modelId };
      }
      return this.providerFailure(userId, REALTIME_ROLE, resolved.modelId, /* ... */);
    } catch (err) {
      return this.dispatchFailure(userId, REALTIME_ROLE, err, redact);
    }
  }
}
```

**On the CALLER's key, never the server credential at `('ai', 'openai')`.**
This is not a new rule for this surface — it is `docs/specs/ai-evaluation.md`
§5's rule, restated for the third time on a speech surface after
`voice.md` §6 already restated it once for `transcribe`/`synthesize`: the
server key exists for the model catalog and the admin's connection test
only, and the instant a realtime session ever minted on it, every per-user
usage figure on `GET /api/ai/usage` becomes wrong for that call, silently —
the exact failure `ai-dispatch.service.spec.ts` already holds a standing
test against for every other method on this service, and `createRealtimeSession`
inherits that same test rather than needing a new one written from scratch.

**The ephemeral secret's scope and TTL.** OpenAI's realtime session-creation
endpoint returns a client secret whose own validity is short by design — on
the order of a minute, meant to cover exactly the handshake between a
browser requesting a session and that browser opening the realtime
connection, not the conversation itself. This document fixes **60 seconds**
as this application's own bookkeeping TTL for that handshake window: the
concrete number is not invented here — `AiRealtimeSessionResult.expiresAt`
(§2) is the provider's own reported value, echoed rather than computed, the
identical "report what the provider said, never assert a number of our own"
discipline `AiTranscriptionResult.confidence` already holds — but 60 seconds
is squarely inside the range that discipline produces, and it is what a
caller should assume when deciding whether a mint is worth attempting again
without re-checking the actual value. The secret is scoped to **one realtime
session on one interview**: `AiCreateRealtimeSessionRequest`'s `instructions`
and `tools` are built by `InterviewsService` from that one interview's own
resolved phase, question pool and pass rule (§4), so a secret minted for
interview A carries no channel through which it could be replayed against
interview B even if it were somehow reused before expiry — there is no
interview id parameter on the realtime connection itself for a client to
substitute.

**What the browser holds.** Exactly the ephemeral `clientSecret` string and
nothing else — never the caller's own `('ai-user', <their id>)` OpenAI key,
which never leaves this process on any code path today (`ai-evaluation.md`
§5, `ai-settings.md` §4.2) and does not start leaving it on this one. The
browser uses the secret to open its own realtime connection directly to the
provider; this application's API is not in that connection's data path at
all (§13's rejected alternative on proxying audio states why).

**`Cache-Control: no-store` on the response**, for the identical reason a
short-lived bearer credential is never cached anywhere in an HTTP chain: a
cached mint response is a client secret sitting in a shared cache or a
browser's disk cache for longer than the secret itself is valid, which is a
liability with no corresponding benefit — the secret cannot be reused for a
second session even if it were still readable.

**Never logged, never a span attribute, never an audit row.** The mint
call's span (§2) carries the model id and the role key, exactly as
`transcribe`/`synthesize`'s spans do — never the secret itself, for the
identical reason `BaseAiProvider`'s existing spans carry no key: a trace
backend is not a place this application puts anything that authenticates a
request, ephemeral or not. No `audit_events` row is written for a mint
either, matching `voice.md` §9's own posture toward `POST
/api/ai/speech/transcribe`/`synthesize` — this is an ordinary, per-user,
no-permission action a learner takes on their own interview, not an
administrative action `audit_events` exists to record.

**What happens on expiry mid-interview.** If the interview is still
`in_progress` when the client's realtime connection drops (the secret
expired, the connection failed, the model's session ended for a reason
unrelated to the interview being over), the client re-mints: a fresh call to
the same `POST /api/interviews/:id/realtime-session` route, which resolves
the interview's *current* engine state exactly as it did the first time
(§4) — the civics phase resumes at whichever question the engine's own state
says comes next, never at the first question, because the engine's state is
persisted server-side and was never held in the expired session at all. If
re-minting itself fails — `realtime` unbound, the connection cannot be
re-established, the learner declines to retry — the interview **falls back
to the text transport with progress intact**: the same interview id, the
same `mockInterviewId` on every `practice_attempts` row already written, and
`POST /api/interviews/:id/turns` (the existing E8 SSE route) picks up
exactly where the realtime session left off, because both transports drive
the identical engine state. §7 states this as the general degradation rule;
this paragraph is its concrete instance for the one failure mode unique to
an ephemeral secret.

**Teardown.** The client closes its own realtime connection when the
interview reaches `completed` (§4's `end_phase` tool call, honoured only
when the engine's own stop rule agrees) or when the learner ends the
interview manually; this application mints no session-termination call of
its own, because the secret's short TTL (above) is what actually bounds its
usable lifetime — there is nothing left to revoke that outlives the number
already fixed.

**`mock_interviews.mode` records what actually happened, and it is a
server-side write, never a client-supplied value.** `POST /api/interviews`
already writes `mode: 'text'` explicitly today (`interviews.service.ts`,
line ~311), and `create-interview.dto.ts`'s own compile-time
`ForbiddenCreateInterviewFieldNames` proof already forbids a client from
naming `'mode'` on that request — this epic adds no exception to that proof
and no `mode` parameter to `POST /api/interviews`. Instead, the **first
successful realtime-session mint for a given interview** is what flips that
interview's `mode` column from `'text'` to `'voice'`, written by
`InterviewsService` the moment `AiDispatchService.createRealtimeSession`
returns `status: 'ok'` — never earlier, and never reverted if the interview
later falls back to text mid-way (the paragraph above): `mode` is a coarse,
one-way summary of *whether this interview was ever conducted by voice at
all*, not a live transport indicator, and the live, precise truth already
lives one layer down, per turn, on `inputMode`/`promptMode` (§6) — the
identical "a coarse summary column, and the real granular truth on the rows
underneath it" relationship `mock_interviews.civicsAsked`/`civicsCorrect`
already have to the `practice_attempts` rows they summarize.

## 4. The tool contract

Three tools, declared to the realtime model at session-creation time (§3's
`tools` field) and enforced server-side on every call: **the model asks what
the tool call reports and the server decides what happens next — never the
reverse.** Every tool call from the realtime session reaches
`InterviewsService` as an ordinary function invocation (the provider's SDK
delivers tool calls as structured events over the same realtime connection,
not as free text this application would have to parse), and every one of
the three is validated against the interview's own current `InterviewState`
(`interview-engine.ts`, §-cited above) before anything is returned to the
model.

### 4.1 `next_question`

**Arguments:** none. The model calls this when it is ready for the officer's
next line — after the applicant's reply to the previous turn has arrived and
the model has nothing left to say on its own.

**Return:** the exact text the officer should say next, assembled
server-side by the identical mechanism `mock-interview.md` §5.1 already
specifies for the text transport: an AI-authored acknowledgement sentence
(this time asked of the *realtime* model's own text-generation turn, not a
separate `tutor` dispatch — the realtime model is a single always-on
conversational agent, and there is exactly one model in this exchange,
unlike the text transport's separate officer-turn/grading calls) concatenated
with, for a civics-phase question, **the question's `prompt` column read
verbatim from `civics_questions`** — never paraphrased, never generated,
appended by this application's own code before the combined string is
returned as the tool's result. The model then speaks the returned string
aloud; it never composes the question text itself, because the question
text is never a field the tool's return schema gives it room to author —
the identical "no field to put it in" enforcement `mock-interview.md` §5.1
already applies to the text transport, carried over unchanged to a tool
result instead of a server-concatenated HTTP response body.

**Rejection rule:** a call is rejected — the tool returns an error result
the model must report to the learner ("let's move on" / a neutral
transition, never a raw error string spoken aloud) rather than a question —
when:

- the interview is not `in_progress`, or
- the engine's own `nextPrompt(state)` would throw (`interview-engine.ts`'s
  own documented case: the civics phase has no question left in
  `civicsPlan` and the stop rule was bypassed — a programming error, never a
  reachable interview outcome), or
- a `next_question` call arrives while the engine is still waiting on a
  `grade_answer` call for the question just asked — the model may not ask
  a second question before the first one's answer has been graded, because
  the engine's `civicsAsked`/`civicsCorrect` tally (the input to the stop
  rule) would then disagree with how many questions the learner has
  actually answered.

### 4.2 `grade_answer`

**Arguments:** `{ questionId: string; transcript: string; confidence?: number }`
— `questionId` names which question this answer is for (so an out-of-order
or duplicate call is detectable rather than assumed to be "the current
one"), `transcript` is the realtime model's own transcription of what the
learner said (the realtime API surfaces this as part of its normal
turn-taking, distinct from a separate `transcribe` dispatch), and
`confidence`, when the provider reports one, feeds the identical
`ASR_CONFIDENCE_THRESHOLD` (`0.6`, `ai.types.ts`) comparison
`voice.md` §3 already specifies for the request/response transcription
path — **never a second threshold invented for realtime**.

**Return:** an acknowledgement instruction for the model to speak next —
"Thank you," a neutral transition — and, internally to this application,
nothing about the verdict is returned to the model at all. This is the load
-bearing rule of this entire tool, stated as plainly as `mock-interview.md`
§5 states it for the text transport: **the engine's own grading ladder — the
same `AttemptGradingService` `mock-interview.md` §6 already requires be
extracted from `PracticeService` into one shared injectable both the text
and voice interview paths call — decides `correct`/`partial`/`incorrect`,
and any verdict the model's own tool-call arguments might separately imply
(a model that says "Interesting, you got that right!" as its spoken
acknowledgement, or that could in principle be asked to self-report a
verdict as a fourth argument) is DISCARDED, not merely preferred-against.**
There is no `verdict` field on `grade_answer`'s argument schema at all — the
tool's JSON schema, sent to the provider at session-creation time exactly as
`completeStructured`'s schema is sent as a hard constraint
(`ai-evaluation.md` §1), gives the model no field through which a self-
assessed grade could even be expressed, the identical "no field to put it
in" enforcement §4.1 already applies to the question text. The model is
asked to report what it heard; the engine is what decides whether what it
heard was right.

**Rejection rule:** a call is rejected when `questionId` does not match the
question `civicsPlan[civicsAsked]` names as the one currently outstanding
(`interview-engine.ts`'s `InterviewState`) — the identical guard
`applyAnswer`'s own `outcome.phase !== state.phase` check already enforces
one layer up for the text transport, restated here at the finer grain a
tool call needs (which *question*, not merely which *phase*). A rejected
call returns an error result; the model is instructed to ask `next_question`
again rather than retry the same `grade_answer` call, because the engine's
state has not moved and asking it to would only repeat the same rejection.

### 4.3 `end_phase`

**Arguments:** `{ phase: 'smalltalk' | 'n400' | 'civics' | 'reading' |
'writing' }` — which phase the model believes has just finished, named
explicitly rather than left implicit, so a mismatch between what the model
thinks just happened and what the engine's own state says is detectable
rather than silently accepted.

**Return:** the next phase's opening context (§5), or, if the interview is
now complete, an instruction to speak the closing line and end the session.

**Rejection rule, the one that matters most on this tool:** `end_phase` is
**honoured only when the engine's own stop rule independently agrees that
this phase is over.** For `smalltalk`/`n400`/`reading`/`writing`, that means
the phase's fixed turn count (`PHASE_TURNS`, `phases.ts`) has actually been
reached — a model that calls `end_phase` for `n400` after only one exchange,
because the conversation felt like it was winding down, is rejected and told
to continue the phase, because `N400_TURNS = 3` is a fact the engine owns
(§ per `phases.ts`'s own header: "a count of turns, not a threshold"),
not a judgment call the model gets to make early. For `civics` specifically,
`end_phase` is honoured only when `civicsStopReason(state)`
(`interview-engine.ts`) is non-null — `threshold_reached`,
`threshold_unreachable`, or `all_asked` — **never** on the model's own sense
that "the learner seems to know this material" or "we've been at this a
while." A civics phase that could be ended early by the model's own
judgment is exactly the failure `mock-interview.md` §5.3 already names for
the text transport (`"you passed the civics section" becomes unreproducible
and unauditable"`), reopened on a live connection if this tool's rejection
rule were any looser than the stop rule itself.

**Pass rules come from `civics_test_versions` via `selectPassRule` — no
threshold constant anywhere in the realtime path either.** `selectPassRule`
(`interview-engine.ts`) is called exactly once, at interview creation
(unchanged from E8, §3's re-mint paragraph above: re-minting a session reads
the interview's *already-resolved* `InterviewState`, it does not call
`selectPassRule` a second time), and the realtime transport's `grade_answer`/
`end_phase` handlers read the same `state.passRule` the text transport's
`POST /api/interviews/:id/turns` handler reads. There is exactly one place
in this codebase either number is decided, for text or voice alike.

### 4.4 A worked example transcript of the tool exchange

A learner mid-civics-phase, two questions in, one correct so far, on a
version whose pass rule is 6-of-10:

```
[model → server]  next_question()
[server → model]  { text: "Thank you. Next question: What is the supreme
                     law of the land?" }
[model]           (speaks the returned text aloud)
[learner speaks]  "the constitution"
[model → server]  grade_answer({
                     questionId: "q-supreme-law",
                     transcript: "the constitution",
                     confidence: 0.94
                   })
[server]          confidence 0.94 >= ASR_CONFIDENCE_THRESHOLD (0.6) — trusted.
                   AttemptGradingService.resolveAcceptedAnswers + gradeDeterministic
                   match "the constitution" against civics_answers → correct.
                   civicsCorrect: 1 → 2. civicsStopReason(state) → null (not
                   yet 6 correct, not yet unreachable, plan not exhausted).
[server → model]  { ack: "Thank you." }   // NO verdict field. Ever.
[model]           "Thank you." (spoken, neutral, no praise or correction)
[model → server]  next_question()
[server → model]  { text: "Thank you. Next question: Name one branch of the
                     government." }
        ...
[model → server]  end_phase({ phase: "civics" })
[server]          civicsStopReason(state) → "threshold_reached" (civicsCorrect
                   reached 6). HONOURED.
[server → model]  { nextPhase: "reading", context: "..." }
```

A rejected call, for contrast — the model tries to end the phase early:

```
[model → server]  end_phase({ phase: "civics" })
                   // civicsCorrect: 3, civicsAsked: 4, threshold: 6 — the
                   // stop rule has not fired.
[server]          civicsStopReason(state) → null. REJECTED.
[server → model]  { error: "civics phase is not over", instruction:
                     "call next_question and continue the interview" }
[model → server]  next_question()
```

## 5. Phase sequencing with the E10 segments

`INTERVIEW_PHASES` (`phases.ts`) is unchanged: `smalltalk → n400 → civics →
reading → writing → closing`, and this epic reorders none of it — the
sequence is E8's contract, inherited exactly (`mock-interview.md` §1: "every
fact this document settles... is written once, here, and inherited
unchanged by both later epics"). What changes is `SKIPPED_PHASES`'s
membership from this epic's own point of view: `reading` and `writing` are
**no longer skipped in a realtime interview**, because E10 (`docs/specs/
english-test.md`) already supplies real content for both, wired since #144/
#147 into `/practice/reading`/`/practice/writing`. `phases.ts`'s own header
already anticipated this exact moment: "when E10 supplies the content, the
phases are already in the sequence, already in the transcript... the change
is what happens inside the phase, not whether the phase exists."

**Reading**, live in a realtime interview, runs precisely as `/practice/reading`
does today: the officer's tool-mediated turn presents one `english_sentences`
row (`kind: 'reading'`) verbatim, the learner reads it aloud, the realtime
model's own transcription (the same mechanism `grade_answer`'s `transcript`
argument uses for civics, §4.2) is scored by `english-scoring.ts`'s
word-error-rate function exactly as `EnglishService.recordAttempt` already
scores a request/response reading attempt, and one `english_attempts` row
(`kind: 'reading'`) is written — never a `practice_attempts` row, because
reading and writing evidence has always lived in its own table, separate
from civics (`CLAUDE.md`'s Database Tables section, `english_attempts`'
own entry: "One row per scored reading or writing attempt").

**Writing, and the one rule that does not bend for a live connection: the
sentence is dictated and never shown.** `english.service.ts`'s own comment
on a writing attempt's `text` field states the rule this epic inherits
unmodified: "On a writing attempt this is the REVEAL — the first time the
learner sees the sentence they were dictated." A realtime interview's
writing phase therefore has the officer's tool-mediated turn **speak** the
sentence aloud (through the realtime model's own audio output, reading the
sentence's `text` column verbatim — the identical "verbatim from the
database, never generated" rule §4.1 already applies to a civics question)
and never send that text to the client as a rendered string at any point
before scoring, the same DOM-level invariant `CLAUDE.md`'s English section
names as enforced client-side rather than by withholding data over the
network on the request/response transport ("the 'never shown' rule of the
writing screen is a DOM invariant enforced there, not a network one"). On
the realtime transport specifically, the invariant is easier to hold, not
harder: the sentence never needs to reach the browser as text at all —
it is spoken by the model directly from a value this application supplied
at session-creation or tool-call time, so there is no rendered string in
the DOM whose absence has to be separately enforced. The learner types
their answer (an ordinary text input, unaffected by the realtime audio
connection), and the recorded transcript is scored against `sentence.text`
exactly as `EnglishService.recordAttempt` already scores a `kind: 'writing'`
attempt.

## 6. Evidence written

**A `mock_interview_turns` row per turn**, exactly as the text transport
writes one per turn (`interviews.service.ts`'s `recordApplicantTurn`,
§ cited above): `mockInterviewId`, `turnIndex`, `role`, `phase`, and, for a
civics applicant turn, `attemptId` pointing at the `practice_attempts` row
it produced. Realtime adds no new columns to `mock_interview_turns` — the
schema (`MockInterviewTurnRole`, `MockInterviewPhase`) already has
everything a voice turn needs, because a turn's *content* (who spoke, in
which phase) does not depend on how the audio got there.

**A `practice_attempts` row per civics answer, with `source: 'mock_interview'`
and `input_mode: 'spoken'`.** This is the one column value this epic
actually changes on the write `recordApplicantTurn` already performs:
`inputMode` moves from the hardcoded `'typed'` (`interviews.service.ts`,
line ~908, "Text mode. E9 wires `spoken`/`heard` through the same rows") to
`'spoken'` for a realtime-transport civics turn, and `promptMode` moves from
`'read'` to `'heard'` (`PracticePromptMode`'s two declared values,
`schema.prisma`) — the question was spoken by the officer and heard by the
learner, not displayed and read, the identical distinction `promptMode`
already exists to carry for ordinary spoken practice.

**Low ASR confidence is `failure_cause: 'misheard'`, never a wrong answer —
and this is the one place this document requires a real code change to an
existing guard, not merely a new write path.** `interviews.service.ts`'s own
`recordApplicantTurn`, read in full above, contains an extensive, explicit
comment (lines ~966–1014) stating that its mastery-scheduling guard
(`graded.answerResolution !== 'state_required'`) is **"deliberately one
condition shorter than its sibling"** in `PracticeService.recordAttempt`
(`status !== 'state_required' && !misheard`), that this is correct **only**
because the text-mode interview path structurally cannot produce a
`misheard` attempt today (no `asrConfidence` field on the DTO, `inputMode`
hardcoded to `'typed'`, `isMisheardAttempt` never called on this path, and
`failureCause`'s type excluding `'misheard'` from what a grader can supply
on this path), and that **"wiring E9 voice into interviews makes this guard
wrong immediately"** — naming this exact epic by its two names ("E11 / #60
is the epic that will"). The comment further states that issue #245 "tracks
the real fix — moving the skip rule INSIDE `AttemptGradingService
.scheduleMastery`, so it is decided once for both call sites and they cannot
disagree," and warns explicitly that nothing today would force whoever wires
voice in to notice the gap.

This epic is that wiring, so this epic is the one required to close it.
Concretely: once a realtime civics turn can report a `confidence` on
`grade_answer` (§4.2) and therefore can compute `isMisheardAttempt(confidence,
outcome)` (`practice.service.ts`'s own exported function, reused rather than
reimplemented) as `true`, `recordApplicantTurn`'s scheduling guard MUST
exclude that attempt from `AttemptGradingService.scheduleMastery` exactly as
`PracticeService.recordAttempt`'s own guard already excludes a misheard
attempt from `scheduleMastery` on the request/response path (`voice.md`
§3.1's own worked example). Whether this ships as issue #245's own
call-site-unifying refactor (moving the skip rule inside `scheduleMastery`
itself, so both callers inherit it from one place and cannot disagree) or as
a second, explicit `&& !misheard` condition added to `recordApplicantTurn`'s
guard directly is an implementation choice a child issue is free to make —
but the guard must not ship one condition short of its sibling the day a
realtime turn can actually carry a confidence score, because the harm is the
identical one `voice.md` §3.1 already spent a full worked example
preventing on the other transport: a nervous applicant misheard by the
recogniser mid-interview would otherwise take a real mastery penalty —
`correctStreak` reset, `lapses` incremented, `dueAt` pulled in — for an
accent or a noisy connection rather than for anything they got wrong, at
precisely the moment (a live, high-pressure rehearsal) a learner is most
likely to be misheard.

**Audio is never stored — the identical rule `voice.md` §4 already holds for
a recorded buffer, restated here for a live stream that never becomes a
buffer at all.** The realtime connection is browser-to-provider directly
(§3, §13's rejected "proxying audio through the API" row): this
application's API process never receives the audio bytes, so there is no
buffer for it to accidentally retain even transiently — a stronger property
than `voice.md` §4's "the buffer lives only for the duration of the provider
call," because on this transport there is no buffer on this side of the
connection at all. `transcript` and `confidence`, on `grade_answer`'s tool
arguments, are text and a number; nothing about the audio that produced them
ever reaches this codebase.

**Transcript retention is the learner's opt-in from E8, default off,
unchanged.** `mock_interviews.transcript_retained` (`@default(false)` at the
database level, `mock-interview.md` §8.1) governs a realtime interview's
applicant-turn text exactly as it governs a text interview's: with retention
off, `mock_interview_turns.text` is written empty for an applicant turn
(§8.2's retention table, unchanged), and `practice_attempts.response_text`
is `null`. A realtime turn's `transcript` (the realtime model's own
transcription, §4.2) is therefore held only long enough to grade and to
decide whether to persist it — the identical "the learner's real text was
already graded, in memory, before this method ran... retention governs what
is PERSISTED, never what is graded" rule `recordApplicantTurn`'s own doc
comment already states for the text transport.

## 7. Degradation

**Wiring `realtime` does not change `systemReady`** — §1 states the
mechanism (`textModelRoles()` is unaffected because `realtime`'s capability
is not `'text'`) and this section restates the product-facing consequence,
in the identical spirit `voice.md` §1's own table states for `transcribe`/
`speak`: an unbound `realtime` role, a refused microphone, a failed
connection, and an expired secret that cannot be re-minted **all fall back
to the text interview, with the same interview id and no loss of progress**.

- **`realtime` unbound** (no model bound to the role, or `capability_unsupported`
  on the configured provider): the realtime screen never renders a "start
  voice interview" control at all — the identical "hidden, not disabled"
  posture `voice.md` §1's table already specifies for an unbound `transcribe`
  ("the mic is hidden, not disabled — the session runs in text mode with no
  visible affordance for an action that cannot succeed"). `AiNotReady`
  (§1) is what an admin-facing surface renders to explain why, naming
  `realtime` by name.
- **A refused microphone**: the browser's own permission denial is caught
  before a realtime-session mint is even attempted (no `POST
  /api/interviews/:id/realtime-session` call is made without a live audio
  input), and the interview proceeds in text — the same `POST
  /api/interviews/:id/turns` SSE route E8 already ships, driving the
  identical `InterviewState`.
- **A failed connection** (the WebRTC/realtime handshake never completes, or
  drops before the first tool call): the client falls back to text after a
  bounded number of retry attempts, exactly as an expired, unrenewable
  secret does (§3).
- **An expired secret mid-interview**: §3's own paragraph in full — re-mint
  while `in_progress`; fall back to text if re-minting fails.

In every one of these cases, **the engine state that actually matters —
`civicsAsked`, `civicsCorrect`, `stopReason`, which phase the interview is
in — is server-side and untouched by which transport is driving it**, per
`interview-engine.ts`'s own pure, transport-agnostic design (§4's tool calls
and the text transport's HTTP turn bodies are two different ways of calling
the identical `applyAnswer`/`nextPrompt` functions). A learner who falls
back from voice to text mid-interview resumes at exactly the next question
the engine already knew was next; nothing about the interview's `result`,
`passedCivics`, or eventual debrief differs by which transport carried which
turn, the identical guarantee `mock-interview.md` §5.2 already states for
an `unavailable`/`failed` `tutor` dispatch on the text transport, extended
here to a transport failure instead of an AI-call failure.

**`AiNotReady` names the role.** `role="realtime"` (§1) is the only change
this epic makes to how that shared component is used; the component itself,
its copy, its `info` severity, and its admin-only "no model is bound to
realtime" line are all already shipped and unchanged (`AiNotReady.tsx`, read
in full above).

## 8. Readiness weighting

**The actual weights, read from `readiness-engine.ts`'s own
`READINESS_WEIGHTS`:** `spoken` is `0.10` of the total score and `interview`
is `0.10` — together `0.20` of the `1.00` that sums to a score out of 100.
`computeSpoken` is `min(distinctQuestionsCorrectSpoken / 20, 1)`, read from
`practice_attempts` rows where `inputMode: 'spoken'` **and**
`outcome: 'correct'`, counted by distinct `questionId`
(`readiness.service.ts`'s `spokenCorrectRows` query, cited above).
`computeInterview` is `min(mockInterviewsPassed / 2, 1)`, read from
`mock_interviews` rows where `status: 'completed'` **and**
`passedCivics: true` — counted per whole interview, with **no dependency on
`mode` at all**: a passed interview counts toward this component whether it
was conducted in text or in voice.

**This is the exact mechanism by which a voice interview weighs more than a
typed one, and it requires no new readiness code, because it already falls
out of the two components reading two different things.** `interview`
counts *whether an interview was passed*, regardless of transport; `spoken`
counts *distinct questions answered correctly with `inputMode: 'spoken'`* —
and §6 is precisely what makes a realtime interview's civics answers carry
`inputMode: 'spoken'` where a text interview's carry `inputMode: 'typed'`.
A realtime interview that passes therefore credits **both** components; a
text interview that passes credits only `interview`. Nothing in
`computeReadiness`, `computeSpoken`, or `computeInterview` needs to change
for this to be true — §1's §2.7/§2.8 formulas, cited verbatim above, already
read exactly the two facts this epic's evidence-writing choices (§6) supply.

### 8.1 A worked comparison: identical interview, typed vs. spoken

Take a learner with no prior spoken-correct evidence
(`distinctQuestionsCorrectSpoken = 0`) and no prior passed interviews
(`mockInterviewsPassed = 0`), who completes one mock interview and passes
its civics section by correctly answering 8 of the questions asked.

**Typed (text transport, `inputMode: 'typed'` on every civics attempt):**

- `mockInterviewsPassed`: `0 → 1`. `interview = min(1/2, 1) = 0.5`.
  Contribution: `0.5 × 0.10 = 0.05` (5 points on the 0–100 scale).
- `distinctQuestionsCorrectSpoken`: unchanged at `0` — none of these
  attempts carry `inputMode: 'spoken'`. `spoken = min(0/20, 1) = 0`.
  Contribution: `0`.
- **Total added by this interview: `0.05` → 5 points.**

**Spoken (realtime transport, `inputMode: 'spoken'` on every civics attempt,
per §6):**

- `mockInterviewsPassed`: `0 → 1`, identically. `interview` contribution:
  `0.05`, identically — passing is passing, regardless of transport.
- `distinctQuestionsCorrectSpoken`: `0 → 8` (the 8 correct answers, now
  carrying `inputMode: 'spoken'`). `spoken = min(8/20, 1) = 0.4`.
  Contribution: `0.4 × 0.10 = 0.04` (4 points).
- **Total added by this interview: `0.05 + 0.04 = 0.09` → 9 points.**

**The spoken interview scores 9 points higher than the identical typed
interview for the identical performance — nearly double.** The gap is
widest for a learner with little or no prior spoken evidence (as here,
where `spoken` starts at `0`) and narrows as `distinctQuestionsCorrectSpoken`
approaches its own `20`-question ceiling from other spoken practice, exactly
as `readiness-model.md` §2.7 already designs the ceiling to represent "has
demonstrated real spoken fluency across a meaningful slice of the material,"
not "has spoken the entire bank" — a realtime interview is one more source
of that same evidence, not a separately-weighted bonus invented for this
epic.

### 8.2 Why no new snapshot column is needed

`readiness_snapshots.components`/`evidenceCounts` (`readiness-model.md` §4)
already store the full, per-component breakdown for all eight keys on every
snapshot — `spoken`'s and `interview`'s values, weights and contributions
are already there, unconditionally, for every learner, whether their
evidence came from ordinary spoken practice, a realtime interview, or both.
Nothing about *how* a spoken-correct attempt or a passed interview came to
exist is a fact either component's formula reads — `computeSpoken` reads
`inputMode`, not a "was this from an interview" flag, and `computeInterview`
reads `mock_interviews.status`/`passedCivics`, not `mode`. A snapshot
computed after a realtime interview completes therefore already looks
exactly like a snapshot computed after any other source of the same two
kinds of evidence, because — per §6 — a realtime interview writes evidence
into the identical rows every other source writes into, under the identical
column values. This is the same "no second clamp, no second column, ever"
discipline `readiness-engine.ts`'s own file header states for the
structural cap (`readiness-model.md` §2.9): the weights table and the two
components' formulas are the only place either fact needs to be represented,
and both already exist, unchanged, before this epic.

**`capReason` lifts on the identical two paths, unchanged.**
`capReason: 'typed_only'` reads `evidenceCounts.spoken.attempts === 0 &&
evidenceCounts.interview.attempts === 0` (`readiness-engine.ts`,
`readiness-model.md` §3) — a realtime interview lifts the cap through
whichever of the two it credits first (ordinarily both, per §8.1), the
identical mechanism a passed text interview or an ordinary spoken-practice
correct answer already lifts it through today. No new cap logic, no
`realtime`-specific branch, is added anywhere in `readiness-engine.ts`.

## 9. Usage and cost

**Usage is recorded from the session's own events, with `roleKey: 'realtime'`,
into the learner's own `ai_usage_events` — the identical table and the
identical per-user attribution every other AI surface in this codebase
already writes into**, via `BaseAiProvider`'s shared, private `recordUsage`
(§2). Two distinct kinds of usage exist on this surface, and they are
recorded at two different moments, for the same reason `voice.md` §9's
`transcribe`/`synthesize` usage is recorded once per call rather than
streamed:

- **The mint call itself** (`createRealtimeSession`, §2) is one
  `ai_usage_events` row, written exactly as every other `BaseAiProvider`
  public method writes one — on success and on failure alike, `roleKey:
  'realtime'`, `provider: this.kind`, `model: request.modelId`.
- **The realtime session's own reported usage** — the provider's realtime
  API surfaces periodic or end-of-session usage events over the same
  connection the audio runs on, reporting audio-input seconds,
  audio-output seconds, and (when the model also produces text, as it does
  for tool-call arguments) token counts. These arrive at the application
  through whichever mechanism the realtime session's own teardown or
  periodic-update path delivers them — a webhook, a final tool-adjacent
  event, or a poll of the provider's own session-status endpoint at
  completion, an implementation choice a child issue resolves against this
  contract rather than one this document fixes — and each such report
  becomes its own `ai_usage_events` row, `roleKey: 'realtime'`, exactly as
  `AiUsage`'s own "every field nullable, and that is the point" discipline
  already requires: a session that ends abruptly (§7's connection-failure
  case) yields **partial or no** usage report, and the honest response is a
  row with `null` counts, never a zeroed one that claims the session cost
  nothing.

**Why the counts may be null, stated in the identical terms `AiUsage`
already states them in:** a realtime session bills by audio duration and,
separately, by any text tokens the model's tool-call reasoning consumes —
two different units on the identical never-throw, null-means-unknown
contract every other speech surface in this codebase already holds
(`voice.md` §7's `AiTranscriptionResult`/`AiSynthesisResult`, both "all-null
is the ordinary case here, not a failure: the speech APIs bill by audio
duration and report no token usage at all for most models"). A session
ended by a network failure, an expired secret with no successful re-mint, or
a learner closing the tab mid-sentence may report nothing at all about what
was actually spoken or generated before the disconnect — recording `0` in
that case would be the identical false claim `ai_usage_events`' own
null-not-zero convention exists everywhere else in this codebase to forbid.

## 10. What is tested and what is not

**The tool-contract unit suite — no audio, no network, no key.** §4's three
tools are specified entirely in terms of `InterviewState` transitions the
existing, pure `interview-engine.ts` already exposes
(`startState`/`applyAnswer`/`nextPrompt`/`civicsStopReason`/`passedCivics`),
so the tool-handling layer this epic adds (whatever service turns a
`next_question`/`grade_answer`/`end_phase` tool-call event into a call
against that engine) is testable the identical way `interview-engine.spec.ts`
already tests the text transport: construct a state, feed it a scripted
sequence of tool-call-shaped inputs, and assert the exact resulting question
sequence, the exact stop reason, and the exact debrief — table of cases and
all, with no database, no network call, and no AI provider anywhere in the
loop. A rejected out-of-sequence `grade_answer` or an `end_phase` call that
arrives before the stop rule agrees are ordinary test cases in this suite,
not edge cases requiring anything the rest of this codebase's pure-engine
tests do not already exercise.

**Playwright covers session minting and the fallback, against `AI_PROVIDER_FAKE=true`.**
`FakeAiProvider` (`ai-evaluation.md` §10, registered as `kind: 'openai'`
under `resolveAiProvider`'s existing `nodeEnv !== 'production'` guard) grows
a scripted `createRealtimeSession` implementation returning a fabricated
client secret with no outbound network call, exactly as it already scripts
`transcribe`/`synthesize`/`complete`/`stream`. A Playwright spec against this
fake can assert: the mint route returns a well-shaped secret and never the
caller's own long-lived key; the realtime screen renders `AiNotReady` when
`realtime` is unbound (§7); a simulated mint failure falls back to the text
transport with the interview's `id` and progress intact (§7); and a
simulated microphone-denial never attempts a mint at all. None of this
requires a real WebRTC connection or real audio — it is testing this
application's own HTTP and routing behaviour around the mint, not the
realtime conversation itself.

**Realtime audio itself is not automatically tested, and this document
states that honestly rather than implying otherwise.** No suite in this
codebase — unit, integration, or Playwright — opens a real WebRTC connection
to a realtime model, speaks synthetic audio at it, and asserts on what comes
back. Doing so would require either a real OpenAI account and real network
access from CI (expensive, flaky, and a secret this codebase's CI
environment does not hold today) or a fabricated realtime transport
convincing enough to stand in for actual speech recognition, actual
barge-in behaviour, and actual audio-device handling — at which point the
test would be asserting against a fake of the one thing it exists to
verify. §13's rejected-alternatives table names this directly. §11's manual
checklist is what this codebase relies on instead, and it is a deliberate,
documented choice rather than a gap nobody noticed.

## 11. The manual verification checklist

Run once before any release that changes voice or realtime code — not on
every deploy, and not automatically. A numbered list a person executes
against a real deployment, a real browser, and a real microphone; each item
states its own pass criterion.

1. **Barge-in: learner interrupts the officer.** While the officer's spoken
   turn is still playing, speak over it. **Pass:** the officer's audio stops
   within roughly one second of the learner's voice being detected, and the
   realtime session registers the learner's speech as the start of their
   turn rather than discarding it or continuing to talk over them.
2. **Barge-in: officer interrupts the learner.** Pause mid-sentence for
   several seconds while answering, long enough that the model could
   reasonably conclude the turn is over, then resume speaking the same
   answer. **Pass:** if the officer begins speaking during the pause, the
   learner can interrupt it in turn (item 1's criterion applies again); the
   interview does not become stuck in a state where neither party's audio
   can proceed.
3. **End-to-end latency.** From the moment the learner finishes speaking an
   answer to the moment the officer's acknowledgement begins playing.
   **Pass:** under two seconds on an ordinary broadband connection,
   measured across at least five separate exchanges (a single fast sample
   is not sufficient — the criterion is about typical experience, not a
   best case).
4. **The end control under load.** While the officer is mid-utterance and
   the realtime connection is actively streaming audio in both directions,
   press the interview's end/exit control. **Pass:** the interview ends
   within a few seconds, no audio continues playing after the confirmation,
   and the interview's state on reload (or on `GET /api/interviews/:id`)
   correctly reflects wherever the engine actually was when the end control
   was pressed — never a state that implies more of the interview happened
   than actually did.
5. **Audio device switching mid-session.** Start the interview on one audio
   input/output device (e.g. a laptop's built-in mic/speakers), then switch
   to a different device (e.g. a Bluetooth headset) without ending the
   interview. **Pass:** audio continues on the new device with no need to
   restart the interview, and no civics question is skipped or repeated as
   a side effect of the switch.
6. **Microphone denial.** Deny the browser's microphone permission prompt
   when starting a realtime interview (or revoke it mid-session, if the
   browser allows that). **Pass:** the interview falls back to the text
   transport (§7) with no error the learner cannot act on, and no realtime
   session mint is attempted with no microphone available.
7. **Network loss mid-interview.** Disconnect the network (airplane mode,
   unplugging Ethernet) partway through the civics phase, then restore it.
   **Pass:** the client detects the dropped connection, falls back to text
   or offers to reconnect within a reasonable window (§7, §3), and no
   civics question already answered before the drop is asked again — the
   engine's server-side state is what is resumed from, not a client-side
   guess.
8. **Secret expiry mid-interview.** Artificially force the ephemeral secret
   to expire while the interview is still in progress (e.g. by holding a
   realtime connection open past the 60-second mint TTL before the client
   has actually opened it, or by using a test hook that shortens the TTL).
   **Pass:** the client re-mints and resumes without the learner having to
   restart the interview (§3), or, if re-minting fails, falls back to text
   with progress intact rather than the interview appearing to have lost
   its place.

**What "verified" means:** every item above run once, by a person, against
the real compose stack, before any release that changes voice or realtime
code — the identical "a human check, not something CI green implies by
itself" convention `ROADMAP.md`'s own Definition of Done already applies to
each epic's Playwright journey spec. The result — pass/fail per item, and
who ran it, and when — is recorded as a line in `CHANGELOG.md` under the
release it gates, the same place this repository already records what
shipped in a release; a release note that changes realtime-interview code
with no corresponding checklist line is incomplete, not merely undocumented.

## 12. Locked decisions

All five, from epic #60, restated with the reasoning that makes each one
load-bearing rather than a preference — the epic's own wording quoted
first, the reasoning after:

| # | Decision | Reasoning |
|---|---|---|
| 1 | **"The engine owns question selection and pass rules; the model owns conversation."** | §4's entire tool contract is this decision made mechanical: `next_question`/`grade_answer`/`end_phase` give the model no field through which it could supply a question, a verdict, or an early stop the engine's own state does not independently confirm. Without it, "you passed the civics section" becomes unreproducible and unauditable (`mock-interview.md` §5.3) — the single most consequential claim this product makes, decided by a source that cannot be replayed or explained. §4. |
| 2 | **"The browser never sees the learner's API key — only an ephemeral, interview-scoped secret."** | A long-lived key visible to browser JavaScript is a key visible in the network tab, in browser history, and to any script running on the page — a single XSS or a careless copy-paste turns into a stolen credential that keeps working indefinitely. A 60-second, single-session secret minted server-side (§2, §3) is useless the moment it expires and useless outside the one interview it was scoped for. §3. |
| 3 | **"The text interview never goes away. It is the fallback for an unbound role, a refused microphone, a bad network, and any learner who prefers it."** | `VISION.md`'s "type instead when voice is inconvenient" and "switch between voice and text without losing progress" are stated as requirements, not aspirations (`voice.md` §5); this epic's realtime transport is an addition to E8's engine, never a replacement for its text transport, and every fallback path (§7) resumes the identical server-side `InterviewState` regardless of which transport reaches it. §7. |
| 4 | **"Realtime audio is manually verified, and the spec says so."** | An automated suite that opens a real realtime connection and asserts on real speech recognition either costs real money and flakiness in CI or ends up testing a fabrication of the thing it claims to verify (§10, §13). Saying so honestly, and specifying a numbered, pass-criterion checklist instead of pretending automated coverage exists, is the more defensible position — and the one issue #155 explicitly asked for. §10, §11. |
| 5 | **"A voice interview weighs more than a typed one in readiness — it is closer to the real event."** | `PRD.md`'s "Completing two mock interviews is the best way to strengthen your readiness now" and the readiness model's own structural cap (`readiness-model.md` §2.9) already exist because typed evidence alone cannot answer "how do I know I am actually ready for my citizenship interview" — a spoken rehearsal is strictly closer to the real event than a typed one, and §8 shows the two already-shipped components (`spoken`, `interview`) compose to reward that without any new readiness code at all. §8. |

## 13. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Letting the model hold the question bank** (asking it to "conduct a USCIS civics interview" from its own training knowledge, or handing it the full question list up front to choose from) | Directly reproduces `mock-interview.md` §5.3's failure mode: the same interview replayed twice could ask different questions or reach a different verdict, with no way to explain why, and a model "holding" the bank is a model with a channel to introduce a question `civics_questions` never contained or to paraphrase one it did. §4's `next_question` gives the model a single acknowledgement sentence to write and appends the verbatim `prompt` server-side — the model never sees the bank at all, only the one question it is told to ask next. |
| **A long-lived browser key** (giving the client the caller's own `('ai-user', <id>)` key directly, or a server-generated key with no expiry) | The exact security regression §3/§12 decision 2 exist to prevent: a credential visible to browser JavaScript is visible in the network tab and browser history indefinitely, versus a 60-second secret scoped to one session that is useless the moment it expires. It would also collapse the BYOK usage-attribution guarantee `ai-settings.md` decision 4 and `ai-evaluation.md` §5 already protect for every other inference path in this codebase — a leaked long-lived key can run arbitrary further inference on the learner's own account and OpenAI bill, not merely this one interview. §3. |
| **Proxying audio through the API** (the browser streams audio to this application's own backend, which relays it to the realtime provider) | Turns this application's API into a real-time audio relay it has no reason to be: it adds a hop of latency directly to the barge-in behaviour §11's checklist measures, it means this process's own memory briefly holds a learner's raw voice — the exact liability `voice.md` §4 already rules out for a stored buffer, reintroduced here as a transient one — and it buys nothing the direct browser-to-provider WebRTC connection §3 already provides more simply. The ephemeral secret exists specifically so the browser can connect directly without ever holding a long-lived credential. §3, §6. |
| **Asserting realtime audio in Playwright** (recording synthetic speech, feeding it through a real or simulated microphone input, and asserting on the transcribed/graded result) | Either requires a real provider account and real network access from CI — expensive, flaky, and a secret this codebase's CI environment does not hold — or requires fabricating a realtime transport convincing enough to stand in for genuine speech recognition and barge-in behaviour, at which point the test verifies the fake rather than the real thing. §10, §11's manual checklist is the honest alternative issue #155 explicitly asked this document to specify instead. §10. |
| **Letting `grade_answer`'s verdict be believed when the engine is uncertain** (trusting a model-reported "the learner got this right" argument, or falling back to it when the deterministic ladder returns an ambiguous result) | Reproduces `mock-interview.md` §5.3's failure for a live connection instead of a scripted HTTP call: two identical answers, on two different runs, could grade differently with no way to explain why. §4.2 gives `grade_answer`'s argument schema no `verdict` field at all — there is no channel through which a model-supplied grade could even arrive, let alone be trusted over the engine's own ladder. §4.2. |
| **Lowering the pass threshold for a spoken interview** (a slightly more forgiving `passThreshold` on the theory that speech recognition introduces noise a typed answer does not) | `interview-engine.ts`'s own header rule — "NO threshold literal anywhere in this file... not as a default, not as a fallback... not in a comment-shaped constant" — is stated as an absolute for exactly this reason: a pass mark that adjusts itself by transport is a mock interview that tells a learner they are ready for a test it did not actually administer, the identical "most expensive lie this product could tell" `planCivicsQuestions`' own comment already names for a short question pool. §4's `grade_answer`/`end_phase` rejection rules read the identical `selectPassRule`-derived threshold the text transport reads — never a second, transport-specific number. §4.3. |
