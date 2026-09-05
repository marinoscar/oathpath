import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AiUnavailableCause } from '../ai-dispatch.service';

// =============================================================================
// POST /api/ai/speech/* — request and response bodies (issue #95, epic #58)
// =============================================================================
//
// Two endpoints, three shapes: what a synthesis request may say, what a
// transcription answers, and the one JSON envelope both use to report that no
// call was attempted.
//
// -----------------------------------------------------------------------------
// THE TRANSCRIPTION RESPONSE IS A DISCRIMINATED UNION, NOT A BAG OF NULLABLES
// -----------------------------------------------------------------------------
//
// `{ status: 'ok', text, confidence }` and `{ status: 'unavailable', cause,
// role }` have no field in common beyond the discriminant, and flattening them
// into one object with everything nullable would hand every client the same
// four undocumented questions: is a null `text` silence or a refusal? is a null
// `cause` success or a cause the server forgot to set? The union answers them
// in the type. `docs/specs/voice.md` §9 specifies the success body as
// `{ text, confidence }` "and nothing else"; `status` is the discriminant that
// makes "and nothing else" enforceable rather than the start of a slope.
//
// -----------------------------------------------------------------------------
// `unavailable` IS A 200 WITH A CAUSE, NOT A 4xx OR A 5xx
// -----------------------------------------------------------------------------
//
// The four `AiUnavailableCause` values are the whole point of
// `AiDispatchService` returning a value instead of throwing
// (`docs/specs/ai-evaluation.md` §4), and they only reach the learner's screen
// if they survive the wire. `HttpExceptionFilter` suppresses detail in
// production and the web client funnels a non-2xx into generic failure
// handling, so a 404 or a 503 here would discard the one fact the response
// exists to carry — and the learner would get a spinner or "something went
// wrong" for a state an administrator, not they, has to fix. This is the same
// posture `POST /api/ai/key/test` takes (HTTP 200, read `success`) and the same
// one the civics `explain` stream takes (`event: unavailable`, not a 5xx).
//
// `role` is on the payload because a voice surface must say WHICH role is
// unconfigured. `GET /api/ai/status`'s `systemReady` deliberately does not
// answer that question for speech — see `ai-status.dto.ts` — so a client that
// had only the cause would know "AI is not set up" without knowing that
// everything except voice works fine.
// =============================================================================

/**
 * Why no call was attempted, mirroring `AiUnavailableCause` exactly.
 *
 * A LITERAL SET RATHER THAN `z.string()`, so the published document tells a
 * client the four branches it has to handle, and so adding a fifth cause to
 * the dispatcher is a compile error here rather than a value the web silently
 * falls through on. The two are kept in agreement by
 * {@link AiSpeechCauseCoversDispatcher} at the bottom of this file.
 */
export const aiSpeechUnavailableCauseSchema = z.enum([
  'no_user_key',
  'ai_disabled',
  'role_unbound',
  'capability_unsupported',
]);

/**
 * The speech roles a `/api/ai/speech/*` response can name.
 *
 * The strings are `AI_MODEL_ROLES` keys, and they are persisted — they key the
 * admin's `models` map and land in `ai_usage_events.roleKey`. A client reads
 * this to ask `unboundRoles.includes(role)` on `GET /api/ai/status`, which is
 * only meaningful if the spelling is identical on both surfaces.
 */
export const aiSpeechRoleSchema = z.enum(['transcribe', 'speak']);

/**
 * No call was attempted, and why. Shared by both endpoints.
 *
 * Carries no `text`, no `audio`, no model id and no key hint: nothing ran, and
 * the fields a caller would reach for do not exist rather than being null.
 */
export const aiSpeechUnavailableSchema = z.object({
  status: z.literal('unavailable'),

  /** Which of the four states this is. See {@link aiSpeechUnavailableCauseSchema}. */
  cause: aiSpeechUnavailableCauseSchema,

  /** The role that could not be served — `transcribe` or `speak`. */
  role: aiSpeechRoleSchema,
});

/**
 * The call was made and did not produce a usable answer.
 *
 * DISTINCT FROM `unavailable`, and the distinction is what a caller renders:
 * "voice is not set up here" is a state a learner can do nothing about, while
 * "that did not work" is worth a retry button. Collapsing them tells one of the
 * two audiences the wrong thing — the reasoning `AiRunFailed` already carries,
 * preserved across the wire rather than flattened at the edge.
 *
 * `error` is the provider's own message, already redacted and truncated by
 * `BaseAiProvider`. It never contains the recording or the transcript.
 */
export const aiSpeechFailedSchema = z.object({
  status: z.literal('failed'),

  /** A short, stable, GROUP-able code. Never a message. */
  errorCode: z.string(),

  /** A diagnosable, redacted sentence. Never the audio and never the transcript. */
  error: z.string(),
});

/** One recording became text. */
export const aiTranscribeOkSchema = z.object({
  status: z.literal('ok'),

  /**
   * What was heard.
   *
   * MAY BE `''`, AND THAT IS A SUCCESS: a learner who pressed record and said
   * nothing really did produce no words. A client showing "we did not hear
   * anything" checks the length itself — the failure of the CALL is
   * `status`, and conflating the two would make silence look like an outage.
   */
  text: z.string(),

  /**
   * How sure the recogniser was, in `[0, 1]`.
   *
   * -------------------------------------------------------------------------
   * `null` MEANS UNKNOWN. IT IS NEVER 0 AND NEVER 1.
   * -------------------------------------------------------------------------
   *
   * Not every model reports a confidence at all (the `gpt-4o-transcribe`
   * family cannot), so `null` is an ordinary value, not an error. A defaulted
   * 0 would assert the recogniser was certain it heard nothing; a defaulted 1
   * would exempt an unscored transcription from the misheard check this field
   * exists to feed (`docs/specs/voice.md` §3). A client that needs a number
   * must decide what to do when there is none — it must not read one that was
   * invented for it.
   */
  confidence: z.number().min(0).max(1).nullable(),
});

/**
 * `POST /api/ai/speech/transcribe`'s response.
 *
 * Discriminated on `status`, so a client's `switch` is exhaustive and a new
 * variant is a compile error at every call site rather than a shape nobody
 * handles.
 */
export const aiTranscribeResponseSchema = z.discriminatedUnion('status', [
  aiTranscribeOkSchema,
  aiSpeechUnavailableSchema,
  aiSpeechFailedSchema,
]);

/**
 * `POST /api/ai/speech/synthesize`'s response WHEN THERE IS NO AUDIO.
 *
 * The success case is not JSON at all — it is the audio bytes, with the
 * provider's own `Content-Type`. A client tells the two apart by that header,
 * which is why this union has no `ok` member: an `ok` JSON body would mean the
 * endpoint had two success shapes and every client had to guess which arrived.
 */
export const aiSynthesizeUnavailableResponseSchema = z.discriminatedUnion(
  'status',
  [aiSpeechUnavailableSchema, aiSpeechFailedSchema],
);

/**
 * The longest text this endpoint will read aloud, in characters.
 *
 * A CIVICS QUESTION, AN OFFICER'S TURN, OR ONE SHORT EXPLANATION — not an
 * essay. The longest question on the 2008 test is under 100 characters and the
 * longest explanation worth hearing in one breath is a short paragraph; 1000
 * characters is roughly 70 seconds of speech, which is already past the point
 * where a learner would rather read. The cap is not really about length: TTS is
 * billed per character, so an unbounded field is an unbounded charge on the
 * CALLER's own key, requested by whatever the client last had in a variable.
 *
 * Exported so the tests and any future caller share one number instead of
 * three that drift.
 */
export const MAX_SYNTHESIS_TEXT_LENGTH = 1000;

export const aiSynthesizeRequestSchema = z
  .strictObject({
    /**
     * What to say.
     *
     * `.trim()` BEFORE the length check, so trailing whitespace is never what
     * puts a request over the line and `'   '` is the empty request it plainly
     * is — the same ordering `civics-explain.dto.ts` uses for `focus`.
     */
    text: z.string().trim().min(1).max(MAX_SYNTHESIS_TEXT_LENGTH),

    /**
     * The provider's voice id, e.g. `alloy`. Omitted lets the provider choose.
     *
     * SHAPE VALIDATED, MEMBERSHIP NOT. The accepted set belongs to the
     * provider and hard-coding OpenAI's list here would be a second place that
     * list lives — wrong on the day a second provider ships, and stale on the
     * day OpenAI adds a voice. The charset bound is the part this layer can
     * genuinely own: a voice id is an identifier, so anything that is not one
     * is a client bug, and refusing it here keeps arbitrary text out of a
     * provider request field.
     */
    voice: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),

    /**
     * The container to synthesise into, e.g. `mp3`. Same shape-not-membership
     * rule as {@link voice}, for the same reason: an unrecognised format comes
     * back as a provider failure that NAMES it, which is a better message than
     * a 400 from a list this layer would have to keep in sync with a provider
     * it does not import.
     */
    format: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9]+$/)
      .optional(),
  })
  // `.strict()`, so `{ "modelId": "…" }` is a 400 naming the key rather than
  // something silently dropped. There is no model, no voice-model, no user id
  // and no key parameter on this endpoint, and a client that sent one should
  // learn that immediately instead of believing it worked.
  .strict();

// -----------------------------------------------------------------------------
// GET /api/ai/speech/voices — the picker's catalog (issue #283, epic #280)
// -----------------------------------------------------------------------------
//
// A PLAIN 200 JSON BODY, NOT A `status` DISCRIMINATED UNION — the one response
// on this controller that is not one, so it is worth saying why rather than
// leaving a reader to assume an oversight.
//
// The union exists on the other two routes to carry an `AiUnavailableCause`:
// four states in which NO INFERENCE CALL WAS ATTEMPTED, each of which a client
// must render differently ("store a key" vs "your administrator has not
// finished setting this up"). This route attempts no inference in the first
// place. It reads a settings row and an array a provider hard-codes about
// itself; it resolves no credential, spends nobody's key, and writes no
// `ai_usage_events` row. There is no state it can be in that a cause would
// describe.
//
// A provider that cannot speak at all is `voices: []`, NOT
// `capability_unsupported`. That is not the union smuggled in through a
// sentinel — it is the honest answer: a deployment with no premium voices to
// choose from still reads every question aloud through the browser's own
// `speechSynthesis` (`docs/specs/voice.md` §2), so an empty picker offering
// browser voices only is the CORRECT outcome and not a degraded one. Nothing
// renders a warning for it.

/** One voice a learner can pick. Mirrors `AiVoiceDescriptor` in `ai.types.ts`. */
export const aiSpeechVoiceSchema = z.object({
  /**
   * The provider's own id, sent back as `voice` on
   * `POST /api/ai/speech/synthesize`.
   *
   * The same charset {@link aiSynthesizeRequestSchema}'s `voice` accepts — a
   * value this endpoint offered but that one refuses would be a 400 the learner
   * cannot explain. The provider specs assert their lists against that
   * expression; this schema publishes the shape rather than re-deriving the
   * membership rule the DTO deliberately does not own.
   */
  id: z.string(),

  /** User-facing name, e.g. `Alloy`. */
  label: z.string(),

  /** One short user-facing sentence describing how it sounds. */
  description: z.string(),
});

/**
 * The voices this deployment can offer, and whether it can offer any.
 *
 * `speakBound` and an empty `voices` are DIFFERENT FACTS and both are carried,
 * because a picker renders them differently: no `speak` binding means the
 * premium path is switched off for everybody on this deployment, while an empty
 * list means the configured provider has no voices at all. Either way the
 * browser reads the question aloud, and neither is an error.
 */
export const aiSpeechVoicesResponseSchema = z.object({
  /**
   * What the configured provider can speak in. EMPTY IS ORDINARY — see the
   * section header.
   */
  voices: z.array(aiSpeechVoiceSchema),

  /**
   * Has an administrator bound a model to the `speak` role?
   *
   * Read from the same `unboundRoles` set `GET /api/ai/status` publishes, so
   * the two surfaces cannot disagree about it. NOT `systemReady`, which is
   * computed over the text roles only and deliberately says nothing about
   * voice (`docs/specs/voice.md` §1).
   *
   * `false` IS NOT AN ERROR STATE. It means this deployment has no premium
   * voice, which is the state of every fresh install; the picker still has the
   * browser's own voices to offer and must not report anything as broken.
   */
  speakBound: z.boolean(),

  /**
   * The voice used when the learner has expressed no preference, or `null`
   * when there are no voices.
   *
   * A member of {@link voices}, and the SAME constant the provider's own
   * synthesis falls back to — so a picker marking one option "default" is
   * marking the one the learner is actually hearing.
   */
  defaultVoice: z.string().nullable(),
});

// -----------------------------------------------------------------------------
// GET /api/ai/speech/audio — the shared, content-addressed civics clip (#284)
// -----------------------------------------------------------------------------
//
// THE REQUEST NAMES CONTENT, NEVER TEXT. `POST /ai/speech/synthesize` takes a
// `text` field and reads back whatever the client sent; this route takes a
// SCOPE and a civics question id, and resolves the words on the server from the
// same rows `GET /api/civics/questions/{id}` already serves. That is the whole
// reason the cache can be shared: two learners asking for the same question are
// asking for bytes that are identical by construction rather than because they
// happened to send the same string, and a client that could name its own text
// could fill a shared, permanently-retained store with anything it liked.
//
// It is also `CLAUDE.md`'s grounding rule ("build the prompt from rows your
// feature already reads") applied to synthesis: the audio says what the
// database says.
//
// THE RESPONSE ADDS ONE MEMBER TO `synthesize`'s UNION, AND NO MORE. Success is
// still audio bytes told apart by `Content-Type`; `unavailable` and `failed`
// are still the same two envelopes at HTTP 200. The third member,
// `state_required`, exists because this route resolves an ANSWER — and a
// `state`-scope question asked by a learner with no state set has no correct
// answer to read aloud. That is neither a configuration failure
// (`unavailable`'s four causes are all about AI configuration) nor a call that
// went wrong (`failed`), and guessing a state would have this application
// confidently read a wrong governor's name to somebody memorising it. The
// civics explain stream already answers exactly this state with a frame of its
// own (`event: state_required`, `civics.controller.ts`); this is the same fact
// on a non-streaming route.

/** Which civics text a clip reads. Mirrors the `SpeechAudioScope` enum. */
export const speechAudioScopeSchema = z.enum([
  'civics_question',
  'civics_answer',
]);

/**
 * `GET /api/ai/speech/audio`'s query string.
 *
 * `z.strictObject`, so `?text=…` or `?modelId=…` is a 400 that NAMES the key
 * rather than a parameter silently dropped. Both would be the same mistake
 * `aiSynthesizeRequestSchema`'s own `.strict()` guards against, one worse: a
 * `text` this route honoured would put caller-supplied words into a permanently
 * cached, shared object store, and a `modelId` would let a caller bind itself
 * to whatever the admin configured for a costlier role.
 *
 * THERE IS NO `userId` AND NO `stateCode`, for the reason
 * `civics-question-query.dto.ts` states in full: the learner is
 * `@CurrentUser('id')` and their state is their own `learner_profiles` row, so
 * a parameter that could name another learner does not exist and there is
 * nothing to forget to authorise.
 */
export const aiSpeechAudioQuerySchema = z.strictObject({
  /** Read the question's prompt, or its first accepted answer. */
  scope: speechAudioScopeSchema,

  /**
   * The `civics_questions.id` to read.
   *
   * A QUESTION ID FOR BOTH SCOPES, never a `civics_answers.id`: which answer
   * is current is a server-side resolution against the caller's own state and
   * the clock (`docs/specs/civics-content.md` §5), and a client naming an
   * answer row directly could ask for a superseded one by id.
   */
  refId: z.uuid(),

  /**
   * The provider voice id. Omitted falls back to the learner's own
   * `voice.preferredVoice` setting, and then to the provider's default.
   *
   * SHAPE VALIDATED, MEMBERSHIP NOT — the identical rule, for the identical
   * reason, that {@link aiSynthesizeRequestSchema}'s own `voice` states. The
   * two must accept the same charset: a value the voices picker offers and one
   * of these two routes refuses would be a 400 a learner cannot explain.
   */
  voice: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),

  /** The container, e.g. `mp3`. Same shape-not-membership rule as {@link voice}. */
  format: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9]+$/)
    .optional(),
});

/**
 * There is no answer to read aloud, because the caller has no state set.
 *
 * NOT `unavailable` AND NOT `failed`. `unavailable` means an administrator has
 * not finished configuring AI — four closed causes, all about configuration —
 * and `failed` means a call was made and produced nothing usable. This is
 * neither: nothing is misconfigured, nothing was attempted, and the remedy
 * belongs to the LEARNER (set your state), which is a different sentence on
 * screen and a different affordance under it.
 *
 * Carries no `role`: no AI role was consulted, so naming one would invite a
 * client to render "your administrator has not set up speech".
 */
export const aiSpeechStateRequiredSchema = z.object({
  status: z.literal('state_required'),
});

/**
 * `GET /api/ai/speech/audio`'s response WHEN THERE IS NO AUDIO.
 *
 * Same shape rule as {@link aiSynthesizeUnavailableResponseSchema}: the success
 * case is not JSON at all, so this union has no `ok` member and a client tells
 * the two apart by `Content-Type`.
 */
export const aiSpeechAudioUnavailableResponseSchema = z.discriminatedUnion(
  'status',
  [
    aiSpeechUnavailableSchema,
    aiSpeechFailedSchema,
    aiSpeechStateRequiredSchema,
  ],
);

export type AiSpeechUnavailableCause = z.infer<
  typeof aiSpeechUnavailableCauseSchema
>;
export type AiSpeechRole = z.infer<typeof aiSpeechRoleSchema>;
export type AiSpeechUnavailableResponse = z.infer<
  typeof aiSpeechUnavailableSchema
>;
export type AiSpeechFailedResponse = z.infer<typeof aiSpeechFailedSchema>;
export type AiTranscribeResponse = z.infer<typeof aiTranscribeResponseSchema>;
export type AiSynthesizeUnavailableResponse = z.infer<
  typeof aiSynthesizeUnavailableResponseSchema
>;
export type AiSynthesizeRequestInput = z.infer<
  typeof aiSynthesizeRequestSchema
>;
export type AiSpeechVoice = z.infer<typeof aiSpeechVoiceSchema>;
export type AiSpeechVoicesResponse = z.infer<
  typeof aiSpeechVoicesResponseSchema
>;
export type SpeechAudioScope = z.infer<typeof speechAudioScopeSchema>;
export type AiSpeechAudioQueryInput = z.infer<typeof aiSpeechAudioQuerySchema>;
export type AiSpeechStateRequiredResponse = z.infer<
  typeof aiSpeechStateRequiredSchema
>;
export type AiSpeechAudioUnavailableResponse = z.infer<
  typeof aiSpeechAudioUnavailableResponseSchema
>;

// -----------------------------------------------------------------------------
// The DTO classes: ONE PER UNION MEMBER, never one per union
// -----------------------------------------------------------------------------
//
// `createZodDto` builds a CLASS, and a class cannot extend a union — TypeScript
// rejects a base constructor whose return type has no statically known members
// (TS2509). That is a real constraint and not a tooling wart: `class X extends
// createZodDto(union)` would have to claim every member's fields at once, which
// is exactly the flattened bag of nullables the header rejects.
//
// So each variant is its own published schema and the controller composes them
// with `oneOf` + a `status` discriminator. The union stays the source of truth
// in TypeScript (the `AiTranscribeResponse` type above is what the service
// returns); these classes are how the same shape reaches the document.

export class AiTranscribeOkDto extends createZodDto(aiTranscribeOkSchema) {}
export class AiSpeechUnavailableDto extends createZodDto(
  aiSpeechUnavailableSchema,
) {}
export class AiSpeechFailedDto extends createZodDto(aiSpeechFailedSchema) {}
export class AiSynthesizeRequestDto extends createZodDto(
  aiSynthesizeRequestSchema,
) {}

/** `GET /api/ai/speech/audio`'s query string (#284). */
export class AiSpeechAudioQueryDto extends createZodDto(
  aiSpeechAudioQuerySchema,
) {}

/**
 * The "set your state first" member of that route's union (#284). Its own
 * class, one per union member, for the reason this section's header gives.
 */
export class AiSpeechStateRequiredDto extends createZodDto(
  aiSpeechStateRequiredSchema,
) {}

/**
 * The voices response. A SINGLE CLASS, not one per union member, because this
 * response is not a union — see the section that declares its schema.
 */
export class AiSpeechVoicesResponseDto extends createZodDto(
  aiSpeechVoicesResponseSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no speech response can carry audio, a path, or a key
// -----------------------------------------------------------------------------
//
// The same device `ai-status.dto.ts` uses, aimed at a different failure.
// `docs/specs/voice.md` §4 is enforced structurally — nothing writes the
// recording anywhere — and the way that guarantee would most plausibly be
// undone is not a `storage_objects` row: it is a convenience field on the way
// back. `audio` ("so the client can play back what it heard"), `url` or `path`
// ("so it can fetch it again") each turn a transient buffer into a retained
// recording of a learner's voice with a stable address, and the FIRST of them
// is the one that makes the second look reasonable.
//
// `modelId` is in the list for the reason §9 gives: every field returned is
// one more thing a future change has to keep compatible, and which model
// transcribed a learner's answer is administrator-facing configuration that
// belongs on the gated settings surface. `apiKey`/`key` are there because this
// is a response type on a path that HOLDS a decrypted credential a few frames
// away.
//
// A build break is a better explanation than a code review.

type ForbiddenFieldNames =
  | 'audio'
  | 'bytes'
  | 'url'
  | 'path'
  | 'filename'
  // ADDED WITH THE AUDIO CACHE (#284). Unlike the recording, a cached clip
  // genuinely HAS a durable object-storage address, so "just send the key and
  // let the client fetch it" is a suggestion somebody will make in good faith.
  // The bytes are served by this API or not at all: an address on the wire is
  // an address that outlives the request, gets logged, and gets shared.
  | 'storageKey'
  | 'storageObjectId'
  | 'modelId'
  | 'apiKey'
  | 'key'
  | 'secret';

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

export type AiSpeechResponsesCarryNoAudioOrSecret =
  Extract<
    KeysOfUnion<
      | AiTranscribeResponse
      | AiSynthesizeUnavailableResponse
      // The cached-audio route's own union (#284). It is the response with the
      // most to gain from a convenience field and the most to lose by one: its
      // bytes really do live at a stable object-storage address, so a `url`,
      // `path`, `storageKey` or `filename` on the way back would hand a client
      // a direct handle to a shared store this API is the only reader of — and
      // `modelId` would publish which model an administrator bound to `speak`
      // to every authenticated learner, including a Viewer.
      | AiSpeechAudioUnavailableResponse
      // The voices response and, separately, ONE ENTRY OF ITS LIST (#283).
      // Both are needed: `KeysOfUnion` sees only the top level, so without
      // `AiSpeechVoice` here a `modelId` or an `apiKey` added to a voice
      // descriptor would sail past this proof while sitting inside the very
      // response it guards. That response is read by every authenticated
      // learner, including a Viewer, so "which model can speak this voice" —
      // administrator-facing configuration — must not reach it either.
      | AiSpeechVoicesResponse
      | AiSpeechVoice
    >,
    ForbiddenFieldNames
  > extends never
    ? true
    : never;

export const AI_SPEECH_RESPONSES_CARRY_NO_AUDIO_OR_SECRET: AiSpeechResponsesCarryNoAudioOrSecret =
  true;

// -----------------------------------------------------------------------------
// Compile-time proof that the published cause set IS the dispatcher's cause set
// -----------------------------------------------------------------------------
//
// The enum above is a hand-written copy of `AiUnavailableCause`, and it is a
// copy on purpose: zod is what publishes the four branches into the OpenAPI
// document, and a `z.string()` would publish nothing a client could switch on.
// A copy that can drift is worthless though — the drift would present as a
// fifth dispatcher cause reaching the wire as a value no client handles, or as
// a removed cause still documented as reachable. Assignability in BOTH
// directions is what makes them the same set rather than merely overlapping.

export type AiSpeechCauseCoversDispatcher =
  AiUnavailableCause extends AiSpeechUnavailableCause
    ? AiSpeechUnavailableCause extends AiUnavailableCause
      ? true
      : never
    : never;

export const AI_SPEECH_CAUSE_COVERS_DISPATCHER: AiSpeechCauseCoversDispatcher =
  true;
