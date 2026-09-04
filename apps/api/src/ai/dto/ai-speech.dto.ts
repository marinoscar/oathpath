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
  | 'modelId'
  | 'apiKey'
  | 'key'
  | 'secret';

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

export type AiSpeechResponsesCarryNoAudioOrSecret =
  Extract<
    KeysOfUnion<AiTranscribeResponse | AiSynthesizeUnavailableResponse>,
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
