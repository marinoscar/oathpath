import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  SecretRedactor,
  truncateProviderError,
} from '../common/crypto/secret-redactor';
import { CredentialsService } from '../credentials/credentials.service';
import {
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';
import { capabilityForRole } from './ai-model-roles';
import type { AiModelRole } from './ai-model-roles';
import { AiSettingsService } from './ai-settings.service';
import type { AiProviderKind } from './ai-settings.schema';
import type { AiMessage, AiStreamEvent, AiUsage } from './ai.types';
import type { AiProvider } from './providers/ai-provider.interface';
import { OpenAiProvider } from './providers/openai.provider';

// =============================================================================
// AiDispatchService — the one door a feature calls through (issue #100, epic #53)
// =============================================================================
//
// Every feature that wants a model to do something calls this service, hands
// it a ROLE and a set of MESSAGES, and gets back a value that names what
// happened. Nothing above this file imports a provider, resolves a model id,
// or touches the credential store; see docs/specs/ai-evaluation.md §3.
//
// -----------------------------------------------------------------------------
// A CALLER MAY NOT NAME ITS OWN MODEL. THAT IS THE POINT OF THE DOOR.
// -----------------------------------------------------------------------------
//
// `AiRunRequest` carries messages and a token cap and nothing else. The model
// id, the provider and the key are resolved HERE, from the admin's settings row
// and the caller's own credential. A `modelId` parameter would let a grading
// service bind itself to whatever the admin configured for the `tutor` — the
// grader runs on every practice answer, the tutor is the expensive model, and
// the failure presents as a bill rather than as an error. `ai-settings.md` §1
// closed that hole at the settings layer; this file is where it stays closed
// one layer up.
//
// -----------------------------------------------------------------------------
// THE SERVER KEY IS NOT REACHABLE FROM THIS FILE, AND A TEST ENFORCES IT
// -----------------------------------------------------------------------------
//
// Inference runs on the CALLING USER's own key, from exactly one credential
// address: `('ai-user', <their id>)`. There is no second address to fall back
// to when a caller has none — a `no_user_key` result is this service refusing
// to run, not a hint to try something else.
//
// The organisation-wide key exists for the model catalog and the admin's
// connection test, and `ai-evaluation.md` §5 spells out what breaks the first
// time an inference call reaches for it: per-user usage accounting silently
// becomes a fiction (the row names the caller, the money came out of the
// admin's account), and nothing in `AiRunOk` distinguishes a fallback call
// from a normal one, so every already-shipped caller inherits the change with
// no compile error and no failing test.
//
// `ai-dispatch.service.spec.ts` therefore reads THIS FILE'S OWN SOURCE and
// asserts that neither of the two constants naming that address — nor their
// literal string values — appears anywhere in it. That is an assertion a
// refactor cannot quietly relax: adding the fallback means deleting a test
// whose name says why it exists.
//
// The two constants are deliberately NOT SPELLED OUT in this comment for the
// same reason. Naming them here would fail that test on a file that does
// nothing wrong, and the fix would be to weaken the test.
//
// -----------------------------------------------------------------------------
// NOTHING A LEARNER TYPED, AND NOTHING A MODEL SAID, LEAVES THIS FILE
// -----------------------------------------------------------------------------
//
// No prompt, no completion, no schema, no delta reaches a log line, an error
// string or a span attribute. What is diagnosable — the user id, the role, the
// model id and a stable error code — is all that is ever emitted. On this
// surface the content is a model's commentary on what a person said during
// interview practice, which is exactly the material `ai_usage_events` was
// designed to have no column for.
//
// -----------------------------------------------------------------------------
// WHY USAGE IS STILL RECORDED IN THE PROVIDER, NOT HERE
// -----------------------------------------------------------------------------
//
// `docs/specs/ai-evaluation.md` §3.1 anticipated that the `ai_usage_events`
// write would move up into this service, because `AiRunOk.usageEventId` needs
// the row id reported to a caller three layers above the provider and
// `AiUsageService.record` returned `void` when that section was written.
//
// It returns the row id now (#96), and `BaseAiProvider`'s three public methods
// return it as `usageEventId`, so the contract §3.1 was reaching for is
// already satisfied without moving the call — and moving it would cost a
// guarantee this layer CANNOT reproduce. `runStream` returns an
// `AsyncIterable` and never iterates it; the consumer does. A stream that is
// ABANDONED — a closed tab, a `break` out of a `for await` — is visible only
// in the generator's own `finally`, inside `BaseAiProvider.stream`. Recording
// from here would mean that exit writes no row at all, and the symptom of a
// missing usage row is nothing: no error, no warning, just consumption that is
// quietly absent. So the write stays where it can see every exit.
// =============================================================================

/**
 * Why a run could not be attempted.
 *
 * FOUR NAMED CAUSES RATHER THAN ONE BOOLEAN, because the remedies differ and a
 * point-of-use message has to name one: the first three are an administrator's
 * unfinished configuration, true for every caller; the fourth is the caller's
 * own missing key, which only they can fix. See `ai-evaluation.md` §4.
 */
export type AiUnavailableCause =
  /** The caller has no personal key stored. */
  | 'no_user_key'
  /** The `ai` settings row has `enabled: false`. */
  | 'ai_disabled'
  /** No model id is bound to this role. */
  | 'role_unbound'
  /**
   * The configured provider cannot serve the role's capability family — or no
   * provider is configured at all, which is the same fact from the caller's
   * seat. See {@link AiDispatchService.resolve}.
   */
  | 'capability_unsupported';

/**
 * The run was not attempted, and why.
 *
 * A VALUE, NEVER A THROWN EXCEPTION. A feature branching on `result.status`
 * gets an exhaustive compile-time check; a feature wrapping every call site in
 * a `try`/`catch` to tell "the admin has not finished configuring AI" apart
 * from "the model refused this request" gets neither.
 */
export interface AiRunUnavailable {
  status: 'unavailable';
  cause: AiUnavailableCause;
}

/** The model answered. */
export interface AiRunOk {
  status: 'ok';
  text: string;
  usage: AiUsage;
  /**
   * The `ai_usage_events` row this call wrote, for a caller that stores a
   * foreign key to it (issue #110's `practice_attempts.ai_usage_event_id`).
   *
   * `null` means the WRITE failed, never that no row was owed: every call
   * writes one.
   */
  usageEventId: string | null;
  modelId: string;
}

/**
 * The run was attempted and did not produce a usable answer.
 *
 * DISTINCT FROM `unavailable`, and the distinction is what a caller renders:
 * "AI is not set up here" is a state a learner can do nothing about and should
 * not be alarmed by, while "that did not work" is a transient failure worth
 * retrying. Collapsing them tells one of the two audiences the wrong thing.
 */
export interface AiRunFailed {
  status: 'failed';
  /** A short, stable, GROUP-able code. Never a message. */
  errorCode: string;
  /** A diagnosable, redacted sentence. Never the prompt and never the reply. */
  error: string;
  usageEventId: string | null;
  /** The model that was tried, or `''` when resolution itself failed. */
  modelId: string;
}

export type AiRunResult = AiRunOk | AiRunFailed | AiRunUnavailable;

/** A structured run that produced a schema-validated value. */
export interface AiStructuredRunOk<T> {
  status: 'ok';
  /**
   * Parsed AND validated against the caller's schema. Never partial: a reply
   * that parsed but did not satisfy the schema is an {@link AiRunFailed}, not
   * a half-answer to be salvaged.
   */
  data: T;
  usage: AiUsage;
  usageEventId: string | null;
  modelId: string;
}

export type AiStructuredRunResult<T> =
  | AiStructuredRunOk<T>
  | AiRunFailed
  | AiRunUnavailable;

/**
 * A streamed run.
 *
 * NO `failed` VARIANT, DELIBERATELY. A stream reports its own failure as the
 * terminal `error` event `AiStreamEvent` already defines, so a caller has
 * exactly one place to handle a failure rather than two that can disagree. A
 * dispatch-level failure therefore arrives the same way — see
 * {@link AiDispatchService.runStream}.
 */
export type AiStreamRunResult =
  | AiRunUnavailable
  | { status: 'ok'; modelId: string; events: AsyncIterable<AiStreamEvent> };

/**
 * What a caller supplies: the conversation, and at most a token cap.
 *
 * NO MODEL, NO PROVIDER, NO KEY, NO ROLE-OVERRIDE FIELD. See the header.
 */
export interface AiRunRequest {
  messages: AiMessage[];
  maxTokens?: number;
}

/** The same, plus the shape the reply must satisfy. */
export interface AiStructuredRunRequest<T> extends AiRunRequest {
  /** The JSON-schema name sent to the provider. A stable id for the SHAPE. */
  schemaName: string;
  /** The zod schema. Sent as a constraint AND used to validate the reply. */
  schema: z.ZodType<T>;
}

/**
 * What a caller supplies to {@link AiDispatchService.transcribe}: one
 * recording, and what it is.
 *
 * NO MODEL, NO PROVIDER, NO KEY, NO ROLE-OVERRIDE FIELD — the header's rule,
 * restated because this is a second door into the same room. A speech caller
 * that could name its own model would bind itself to whatever the admin
 * configured for a more expensive role exactly as a text caller could; the
 * unit of consumption differs, the failure does not.
 */
export interface AiTranscribeRunRequest {
  /**
   * The recording itself, IN MEMORY. See `AiTranscriptionRequest.audio`: a
   * recording exists to become text and then to be dropped, and a temp file is
   * a copy that outlives the request and that somebody has to remember to
   * delete. The size limit belongs at the edge — `AiSpeechService` — not here.
   */
  audio: Buffer;

  /** The recording's MIME type, e.g. `'audio/webm'`. */
  contentType: string;

  /**
   * A file name for the upload.
   *
   * A WIRE DETAIL, NOT A STORED FILENAME: provider SDKs infer the container
   * format from it, and an unnamed blob is rejected as an unsupported format —
   * which presents as "transcription is broken" rather than as the missing
   * metadata it is. Nothing writes it anywhere.
   */
  fileName: string;

  /** An optional ISO-639-1 hint, e.g. `'en'`. A hint, never a constraint. */
  languageHint?: string;
}

/** What a caller supplies to {@link AiDispatchService.synthesize}. */
export interface AiSynthesizeRunRequest {
  /** What to say. Ours, not a learner's — a question, an explanation. */
  text: string;

  /** The provider's voice id. Omitted lets the provider choose. */
  voice?: string;

  /** The container to synthesise into, e.g. `'mp3'`. Provider-defined. */
  format?: string;
}

/**
 * One recording became text.
 *
 * NO `usageEventId`, UNLIKE {@link AiRunOk}, and that is not an oversight.
 * `BaseAiProvider.transcribe` writes the `ai_usage_events` row and does not
 * return its id, because no caller stores a foreign key to a speech call
 * today. Inventing a `usageEventId` here would mean either always-`null` —
 * indistinguishable from the "the write failed" meaning {@link AiRunOk} gives
 * that value — or threading a new field through the provider surface for
 * nobody. Add it when a caller needs the FK.
 */
export interface AiTranscribeRunOk {
  status: 'ok';

  /**
   * What was heard.
   *
   * MAY BE `''`, AND THAT IS A SUCCESS. A recording of silence — a learner who
   * pressed record and said nothing — really did transcribe to nothing, and
   * `run` treating an empty completion as a failure does not carry over: an
   * empty tutor explanation is a bug, an empty transcript is a fact about the
   * audio. A caller that wants to prompt "we did not hear anything" checks the
   * length itself, on a result that says the call succeeded.
   */
  text: string;

  /**
   * The recogniser's own confidence in `[0, 1]`, or `null` for "not reported".
   *
   * NEVER DEFAULTED TO 0 OR 1 anywhere on the way up. See
   * `AiTranscriptionResult.confidence`: a defaulted 0 asserts the recogniser
   * was certain it heard nothing, on the one signal a caller uses to decide an
   * answer was MISHEARD rather than wrong.
   */
  confidence: number | null;

  usage: AiUsage;
  modelId: string;
}

/** One piece of text became audio. Same no-`usageEventId` reasoning as above. */
export interface AiSynthesizeRunOk {
  status: 'ok';

  /** The audio, in memory: a response body on its way out, not a file. */
  audio: Buffer;

  /**
   * The MIME type of {@link audio}, e.g. `'audio/mpeg'`.
   *
   * REPORTED BY THE PROVIDER, NOT DERIVED FROM THE REQUESTED `format`. A
   * caller streaming these bytes has to set a `Content-Type`, and deriving it
   * at each call site is how the header and the bytes come to disagree.
   */
  contentType: string;

  usage: AiUsage;
  modelId: string;
}

/**
 * The outcome of one transcription.
 *
 * `AiRunFailed` AND `AiRunUnavailable` ARE REUSED VERBATIM rather than copied
 * into speech-shaped twins. The four `AiUnavailableCause` members mean exactly
 * what they mean for `run` — this method resolves through the same five steps
 * in the same order — and a parallel copy would be a second union every
 * point-of-use `switch` has to be re-audited against for no new information.
 */
export type AiTranscribeRunResult =
  | AiTranscribeRunOk
  | AiRunFailed
  | AiRunUnavailable;

/** The outcome of one synthesis. Same reuse, same reason. */
export type AiSynthesizeRunResult =
  | AiSynthesizeRunOk
  | AiRunFailed
  | AiRunUnavailable;

/** Everything a run needs, once resolution has succeeded. */
interface ResolvedTarget {
  apiKey: string;
  provider: AiProvider;
  modelId: string;
}

/**
 * The code for a failure in this service's own resolution path.
 *
 * A SEPARATE CODE FROM ANY PROVIDER'S. A provider failure says the call was
 * made and went wrong; this one says the call was never made because something
 * upstream of it broke — an unreadable settings row, a credential that will
 * not decrypt. Grouping the two in `ai_usage_events`-shaped reporting would
 * hide an operator problem inside a provider outage.
 */
const DISPATCH_ERROR_CODE = 'dispatch_error';

/**
 * The code for a call that succeeded and returned nothing to show.
 *
 * `AiRunOk.text` is a `string`, not `string | null`: a caller rendering an
 * explanation has nothing to do with an empty one, and making every call site
 * check for it is how an empty tutor bubble ships. So an empty completion is a
 * FAILURE here even though the provider reported success — and it keeps its
 * own code, because "the model returned no content" and "the request was
 * refused" have different causes.
 */
const EMPTY_COMPLETION_CODE = 'empty_completion';

/**
 * The code for a synthesis that succeeded and produced nothing playable.
 *
 * ITS OWN CODE, alongside {@link EMPTY_COMPLETION_CODE} rather than folded
 * into it, because the two are different operator problems: an empty
 * completion is usually a prompt or a token cap, while empty audio is a voice
 * id or a container the bound model will not produce. Grouped reporting that
 * cannot tell them apart sends whoever is on call to read the wrong thing.
 *
 * There is deliberately no transcription counterpart for an empty STRING: a
 * recording of silence transcribes to `''` and that is a success — see
 * {@link AiTranscribeRunOk.text}.
 */
const EMPTY_SYNTHESIS_CODE = 'empty_synthesis';

/**
 * The code for a transcription that reported success and returned no text at
 * all — `null`, not `''`. A provider contract violation, not silence.
 */
const EMPTY_TRANSCRIPTION_CODE = 'empty_transcription';

/**
 * The two speech roles, named once.
 *
 * CONSTANTS RATHER THAN LITERALS AT FOUR CALL SITES (the `resolve` call, the
 * provider request's `roleKey`, and both failure paths, per method). These
 * strings are persisted — they key the admin's `models` map and land in
 * `ai_usage_events.roleKey` — so a typo in one of the four would resolve one
 * binding and record usage under a different, invented role, with no error
 * anywhere. `AI_MODEL_ROLES` is where they are declared; this is where this
 * file agrees with it exactly once.
 */
const TRANSCRIBE_ROLE = 'transcribe';
const SPEAK_ROLE = 'speak';

/** Usage for a call that never reached a provider. ALL NULL, NEVER ZERO. */
const EMPTY_USAGE: AiUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

/** No model was resolved. Empty rather than an invented name a log could quote. */
const NO_MODEL = '';

@Injectable()
export class AiDispatchService {
  private readonly logger = new Logger(AiDispatchService.name);

  /**
   * Provider kind -> provider.
   *
   * A `Record<AiProviderKind, AiProvider>` RATHER THAN A `switch`, the same
   * shape `EmailTestSendService`, `AiConnectionTestService` and
   * `AiUserKeyService` already use: adding a member to `AI_PROVIDER_KINDS`
   * makes this object fail to compile until the new provider is wired, where a
   * `switch` would fall through and report "nothing happened" with no error to
   * explain it.
   *
   * Built in the constructor rather than resolved per call: providers are
   * singletons that touch the network only when asked to, so this costs
   * nothing and keeps the mapping in one readable place.
   */
  private readonly providers: Record<AiProviderKind, AiProvider>;

  constructor(
    private readonly aiSettings: AiSettingsService,
    private readonly credentials: CredentialsService,
    // ADDRESSED BY THE `OpenAiProvider` TOKEN, TYPED AS `AiProvider`.
    //
    // Under `AI_PROVIDER_FAKE` that token resolves to a `FakeAiProvider`
    // instead (see `AiModule`), and THIS FILE CONTAINS NO BRANCH ON WHICH ONE
    // IT GOT — which is the entire point of substituting at the DI layer
    // rather than reading a flag here. The parameter type is the INTERFACE for
    // the same reason: typing it as the concrete class would be a claim this
    // file cannot check and, on a fake-provider deployment, a false one. The
    // explicit `@Inject` is what keeps the token unambiguous once the declared
    // type is no longer the class — `emitDecoratorMetadata` would otherwise
    // emit `Object` for an interface and Nest would have nothing to resolve.
    @Inject(OpenAiProvider) openai: AiProvider,
  ) {
    this.providers = { openai };
  }

  /**
   * Run one completion for `userId` in `role`. NEVER THROWS.
   *
   * @param userId the caller, ALWAYS PASSED EXPLICITLY. This service reads no
   *        "current user" from a request context, an async-local store or a
   *        decorator: the id decides whose key is spent and whose usage row is
   *        written, and an implicit one is how a background job or a queued
   *        retry ends up billing whoever happened to be in scope.
   */
  async run(
    userId: string,
    role: AiModelRole,
    request: AiRunRequest,
  ): Promise<AiRunResult> {
    const redact = new SecretRedactor();

    try {
      const resolved = await this.resolve(userId, role, redact);
      if ('status' in resolved) return resolved;

      const result = await resolved.provider.complete(userId, resolved.apiKey, {
        roleKey: role,
        modelId: resolved.modelId,
        messages: request.messages,
        maxTokens: request.maxTokens,
      });

      if (result.success && typeof result.text === 'string' && result.text.length > 0) {
        return {
          status: 'ok',
          text: result.text,
          usage: result.usage,
          usageEventId: result.usageEventId,
          modelId: resolved.modelId,
        };
      }

      return this.providerFailure(
        userId,
        role,
        resolved.modelId,
        result.success ? EMPTY_COMPLETION_CODE : (result.errorCode ?? 'error'),
        result.success
          ? 'The model returned no content.'
          : (result.error ?? 'The provider reported a failure with no message.'),
        result.usageEventId,
      );
    } catch (err) {
      return this.dispatchFailure(userId, role, err, redact);
    }
  }

  /**
   * Run one completion whose reply must satisfy `request.schema`. NEVER THROWS.
   *
   * The schema is sent to the provider as a hard constraint and re-validated
   * on the way back, both from the single `schema` field — see
   * `AiStructuredCompletionRequest`. `data` is therefore `T`, never `unknown`
   * and never a partial object: a reply that failed either step is a
   * {@link AiRunFailed}, which is what the grading ladder's rung 3 falls back
   * on (`ai-evaluation.md` §6).
   */
  async runStructured<T>(
    userId: string,
    role: AiModelRole,
    request: AiStructuredRunRequest<T>,
  ): Promise<AiStructuredRunResult<T>> {
    const redact = new SecretRedactor();

    try {
      const resolved = await this.resolve(userId, role, redact);
      if ('status' in resolved) return resolved;

      const result = await resolved.provider.completeStructured<T>(
        userId,
        resolved.apiKey,
        {
          roleKey: role,
          modelId: resolved.modelId,
          messages: request.messages,
          maxTokens: request.maxTokens,
          schemaName: request.schemaName,
          schema: request.schema,
        },
      );

      // `data !== null` AS WELL AS `success`, and not as paranoia: the two are
      // set together by the base provider, and reading only one of them is how
      // a `null` reaches a caller whose type says it cannot be null.
      if (result.success && result.data !== null) {
        return {
          status: 'ok',
          data: result.data,
          usage: result.usage,
          usageEventId: result.usageEventId,
          modelId: resolved.modelId,
        };
      }

      return this.providerFailure(
        userId,
        role,
        resolved.modelId,
        result.errorCode ?? 'error',
        result.error ?? 'The provider reported a failure with no message.',
        result.usageEventId,
      );
    } catch (err) {
      return this.dispatchFailure(userId, role, err, redact);
    }
  }

  /**
   * Open a streamed completion. NEVER THROWS, AND THE ITERATOR NEVER THROWS.
   *
   * -------------------------------------------------------------------------
   * A DISPATCH FAILURE ARRIVES AS A ONE-EVENT STREAM, NOT AS A SECOND SHAPE
   * -------------------------------------------------------------------------
   *
   * {@link AiStreamRunResult} has no `failed` variant on purpose. A consumer
   * of this method is an SSE endpoint whose whole job is to forward events
   * until a terminal one arrives; giving it a second, differently-shaped way
   * to learn about a failure means one of the two paths gets written and the
   * other gets written badly. So when resolution itself throws — an unreadable
   * settings row, a credential that will not decrypt — the result is still
   * `status: 'ok'` with an `events` iterable that yields exactly one terminal
   * `error` event and ends. The consumer's existing terminal-event handling is
   * the failure handling, and there is nothing new to remember.
   *
   * `unavailable` stays a separate value because it is NOT a failure: no call
   * was attempted, no tokens were spent, and the caller is expected to render
   * a configuration message rather than a broken answer.
   *
   * -------------------------------------------------------------------------
   * THIS METHOD BUILDS NO STREAMING REQUEST OF ITS OWN
   * -------------------------------------------------------------------------
   *
   * `ai-evaluation.md` §9 warns that `runStream` is a second place a streaming
   * request could be constructed, and that one built without
   * `stream_options: { include_usage: true }` records all-null usage for every
   * streamed call with nothing failing to announce it. The answer here is that
   * there is no second construction: this method passes `messages` and
   * `maxTokens` and nothing else. `BaseAiProvider.stream` sets `stream: true`;
   * the provider's `openStream` sets `stream_options`. Neither is reachable
   * from here, so neither can be forgotten here.
   *
   * @param signal aborts the upstream request. A consumer that stops iterating
   *        must still leave a usage row behind — the tokens were spent whether
   *        or not anyone read them — which is why that row is written inside
   *        the generator rather than by this service. See the file header.
   */
  async runStream(
    userId: string,
    role: AiModelRole,
    request: AiRunRequest,
    signal?: AbortSignal,
  ): Promise<AiStreamRunResult> {
    const redact = new SecretRedactor();

    try {
      const resolved = await this.resolve(userId, role, redact);
      if ('status' in resolved) return resolved;

      return {
        status: 'ok',
        modelId: resolved.modelId,
        events: resolved.provider.stream(
          userId,
          resolved.apiKey,
          {
            roleKey: role,
            modelId: resolved.modelId,
            messages: request.messages,
            maxTokens: request.maxTokens,
          },
          signal,
        ),
      };
    } catch (err) {
      const failure = this.dispatchFailure(userId, role, err, redact);

      return {
        status: 'ok',
        modelId: NO_MODEL,
        events: singleErrorStream(failure.errorCode, failure.error),
      };
    }
  }

  /**
   * Turn one recording into text for `userId`, in the `transcribe` role.
   * NEVER THROWS.
   *
   * -------------------------------------------------------------------------
   * A SIBLING OF `run`, NOT AN OVERLOAD OF IT
   * -------------------------------------------------------------------------
   *
   * `AiRunRequest` is `{ messages, maxTokens }` — text in, text out. It cannot
   * carry a buffer in or bytes out, and widening it with optional `audio` /
   * `mimeType` fields no text caller ever populates would make every caller of
   * `run` read a request type that is mostly not about them, with the
   * compiler unable to say which combination is valid. So speech gets its own
   * request and result types and its own method, and shares the ONE thing that
   * must not be duplicated: {@link resolve}.
   *
   * -------------------------------------------------------------------------
   * THE SAME FIVE CHECKS, IN THE SAME ORDER, WITH THE KEY LAST
   * -------------------------------------------------------------------------
   *
   * Master switch, then provider, then capability family, then binding, then
   * the caller's own credential — because this method calls the same private
   * {@link resolve} the other three do rather than repeating its checks. The
   * cause set stays CLOSED at four members: `capability_unsupported` already
   * covers "the configured provider has no speech API", which is the first
   * cause in this codebase that a real production deployment can produce, on
   * the day a second, text-only provider is configured.
   *
   * THE CALLER SUPPLIES AUDIO AND NOTHING ELSE — no `modelId` field, ever. See
   * the file header: a caller able to name its own model can bind itself to
   * whatever the admin configured for a more expensive role, and the failure
   * arrives as a bill rather than as an error.
   *
   * THE SERVER CREDENTIAL IS NOT REACHABLE FROM HERE either, for the reason
   * the header gives and which speech makes concrete: the unit billed is
   * minutes of audio rather than tokens, but a call that silently ran on the
   * organisation's key still writes `ai_usage_events.userId = <the learner>`
   * while the money came out of the administrator's account.
   *
   * NOTHING ABOUT THE RECORDING OR THE TRANSCRIPT IS LOGGED HERE. The bytes
   * are a learner's voice and the text is what they said; what this method
   * emits, through the same {@link providerFailure} and
   * {@link dispatchFailure} helpers every other path uses, is a user id, a
   * role, a model id and a stable code.
   *
   * @param userId the caller, ALWAYS PASSED EXPLICITLY — see {@link run}.
   */
  async transcribe(
    userId: string,
    request: AiTranscribeRunRequest,
  ): Promise<AiTranscribeRunResult> {
    const redact = new SecretRedactor();

    try {
      const resolved = await this.resolve(userId, TRANSCRIBE_ROLE, redact);
      if ('status' in resolved) return resolved;

      const result = await resolved.provider.transcribe(userId, resolved.apiKey, {
        roleKey: TRANSCRIBE_ROLE,
        modelId: resolved.modelId,
        audio: request.audio,
        contentType: request.contentType,
        fileName: request.fileName,
        languageHint: request.languageHint,
      });

      // `typeof text === 'string'` AND NOT `text.length > 0`, deliberately
      // unlike `run`. An empty transcript is a real answer about a real
      // recording (silence), while an empty completion is a tutor bubble with
      // nothing in it — see {@link AiTranscribeRunOk.text}. `null` is the
      // failure this check is actually for.
      if (result.success && typeof result.text === 'string') {
        return {
          status: 'ok',
          text: result.text,
          // PASSED THROUGH, NEVER COALESCED. `?? 0` here would be the exact
          // false claim `AiTranscriptionResult.confidence` exists to forbid.
          confidence: result.confidence,
          usage: result.usage,
          modelId: resolved.modelId,
        };
      }

      return this.providerFailure(
        userId,
        TRANSCRIBE_ROLE,
        resolved.modelId,
        result.success ? EMPTY_TRANSCRIPTION_CODE : (result.errorCode ?? 'error'),
        result.success
          ? 'The provider reported success and returned no transcription.'
          : (result.error ?? 'The provider reported a failure with no message.'),
        // NO ROW ID TO REPORT. The provider wrote the `ai_usage_events` row and
        // does not hand back its id on this surface — see
        // {@link AiTranscribeRunOk}. `null` here therefore means "not
        // surfaced", not "the write failed"; a speech caller has no FK to
        // store, so nothing reads it.
        null,
      );
    } catch (err) {
      return this.dispatchFailure(userId, TRANSCRIBE_ROLE, err, redact);
    }
  }

  /**
   * Read one piece of text aloud for `userId`, in the `speak` role. NEVER
   * THROWS.
   *
   * A sibling of {@link run} for the same reason {@link transcribe} is, and
   * resolved through the same {@link resolve}: same five checks, same order,
   * the caller's own key last, the same four `unavailable` causes. THE CALLER
   * SUPPLIES TEXT AND NOTHING ELSE — no `modelId` field, ever, and no reach
   * for the organisation's credential.
   *
   * The text on this surface is ours rather than a learner's, and it is still
   * not logged: length is diagnosable, content is not.
   */
  async synthesize(
    userId: string,
    request: AiSynthesizeRunRequest,
  ): Promise<AiSynthesizeRunResult> {
    const redact = new SecretRedactor();

    try {
      const resolved = await this.resolve(userId, SPEAK_ROLE, redact);
      if ('status' in resolved) return resolved;

      const result = await resolved.provider.synthesize(userId, resolved.apiKey, {
        roleKey: SPEAK_ROLE,
        modelId: resolved.modelId,
        text: request.text,
        voice: request.voice,
        format: request.format,
      });

      // BOTH HALVES CHECKED, because a caller cannot use either without the
      // other: bytes with no content type reach a browser as a download it
      // will not play, and a content type with no bytes is silence the client
      // renders as a working player. Zero-length audio is a failure here even
      // on a `success` result, unlike an empty transcript above — there is no
      // recording whose honest synthesis is no sound.
      if (
        result.success &&
        result.audio !== null &&
        result.audio.length > 0 &&
        typeof result.contentType === 'string' &&
        result.contentType.length > 0
      ) {
        return {
          status: 'ok',
          audio: result.audio,
          contentType: result.contentType,
          usage: result.usage,
          modelId: resolved.modelId,
        };
      }

      return this.providerFailure(
        userId,
        SPEAK_ROLE,
        resolved.modelId,
        result.success ? EMPTY_SYNTHESIS_CODE : (result.errorCode ?? 'error'),
        result.success
          ? // THE SHAPE OF THE PROBLEM, NEVER THE CONTENT. Which half was
            // missing is what an operator needs; the sentence being read is
            // not.
            `The provider reported success and returned ${
              result.audio === null || result.audio.length === 0
                ? 'no audio'
                : 'no content type'
            }.`
          : (result.error ?? 'The provider reported a failure with no message.'),
        // Not surfaced on this surface either — see {@link transcribe}.
        null,
      );
    } catch (err) {
      return this.dispatchFailure(userId, SPEAK_ROLE, err, redact);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Resolve the deployment's configuration and the caller's key, or say why
   * the run cannot happen.
   *
   * ONE HELPER FOR ALL THREE PUBLIC METHODS, and that is the reason it exists.
   * Three copies of these five checks would drift — in WHICH checks they make
   * and, worse, in what ORDER — and the drift would present as a learner told
   * "you have no key" on one screen and "AI is switched off" on the next, for
   * the same deployment in the same second.
   *
   * -------------------------------------------------------------------------
   * THE KEY LOOKUP IS LAST, AND THAT IS A DECISION
   * -------------------------------------------------------------------------
   *
   * The first four checks read a settings row and some in-process constants.
   * The fifth DECRYPTS A SECRET — it is the only step on this path that takes
   * a ciphertext out of Postgres and runs it through the cipher — and there is
   * no reason to decrypt a user's API key for a call that a disabled master
   * switch or an unbound role was always going to refuse. Ordering it last
   * means the refusal costs one indexed settings read.
   *
   * It also produces the message the caller most needs. The first four causes
   * are deployment-wide facts an ADMINISTRATOR fixes; `no_user_key` is the one
   * the caller fixes themselves. When both are true at once, telling the caller
   * about their own missing key would send them to store a key that still would
   * not work. See `ai-evaluation.md` §4.
   *
   * @param redact the caller's redactor. The key is registered with it THE
   *        INSTANT it is obtained, before this method returns and therefore
   *        before anything downstream can throw while holding it.
   */
  private async resolve(
    userId: string,
    role: AiModelRole,
    redact: SecretRedactor,
  ): Promise<AiRunUnavailable | ResolvedTarget> {
    // 1. THE MASTER SWITCH. Cheapest of the five to know, and true for every
    //    caller when it is false. `get()` THROWS on a stored-but-invalid row
    //    rather than substituting defaults (see `AiSettingsService.get`), and
    //    that throw is caught by the public method as a `failed` result — an
    //    unreadable configuration is a fault, not a tidy "AI is off".
    const settings = await this.aiSettings.get();

    if (!settings.enabled) return unavailable('ai_disabled');

    // 2. THE PROVIDER. From the persisted `provider` value through the
    //    exhaustive record above, never a `switch`.
    //
    //    A `null` provider — no provider chosen, the state of every fresh
    //    install — lands on `capability_unsupported` rather than on a fifth
    //    cause of its own. The cause set is deliberately CLOSED (four members,
    //    `ai-evaluation.md` §4 and §12), because every consumer branches on it
    //    exhaustively and each new member is a re-audit of every one of those
    //    branches. From a caller's seat "no provider is configured" and "the
    //    configured provider cannot do this" are the same sentence — an
    //    administrator has not finished setting this deployment up — and the
    //    fine-grained fact is not lost: `describeReadiness` reports
    //    `providerConfigured` separately, for the admin page that can act on it.
    const provider =
      settings.provider === null ? null : this.providers[settings.provider];

    // 3. THE CAPABILITY FAMILY. Unreachable today — OpenAI declares all six —
    //    and present now so that a provider which declares a subset slots in
    //    without a new cause being invented and every caller's `switch`
    //    re-checked on that day.
    //
    //    An UNKNOWN role key lands here too: a role this registry does not
    //    declare has no capability family, and nothing can serve it. It arrives
    //    as a persisted string (a settings row or a queued job written before a
    //    role was removed), so it must be a result and not a throw.
    const family = capabilityForRole(role);

    if (provider === null || family === undefined || !provider.supports(family)) {
      return unavailable('capability_unsupported');
    }

    // 4. THE BINDING. `null` means the admin has not bound a model to this
    //    role; a blank string is the same fact written by an older client.
    const modelId = settings.models[role];

    if (typeof modelId !== 'string' || modelId.trim().length === 0) {
      return unavailable('role_unbound');
    }

    // 5. THE CALLER'S OWN KEY, from the one address inference may read.
    const apiKey = await this.credentials.getSecret(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
    );

    // REGISTERED IMMEDIATELY, on the line after the call that returned it and
    // before any branch that can throw while it is in scope. Everything after
    // this point — the provider's client construction, DNS, TLS, an SDK's own
    // error formatting — can raise a string we did not author.
    redact.protect(apiKey);

    if (apiKey === null || apiKey.length === 0) return unavailable('no_user_key');

    return { apiKey, provider, modelId: modelId.trim() };
  }

  /**
   * Shape a provider-reported failure, and log the diagnosable half of it.
   *
   * The log line carries the user, the role, the model and the CODE. Not the
   * messages, not the reply, not the schema — see the file header.
   */
  private providerFailure(
    userId: string,
    role: AiModelRole,
    modelId: string,
    errorCode: string,
    error: string,
    usageEventId: string | null,
  ): AiRunFailed {
    this.logger.warn(
      `AI dispatch failed for user ${userId} (${role}/${modelId}): ${errorCode}`,
    );

    return { status: 'failed', errorCode, error, usageEventId, modelId };
  }

  /**
   * Turn a throw from this service's OWN path into a `failed` result.
   *
   * -------------------------------------------------------------------------
   * A BUG IS NOT `unavailable`, AND FLATTENING IT INTO ONE WOULD BE WORSE THAN
   * A 500
   * -------------------------------------------------------------------------
   *
   * It is tempting to catch everything here and return
   * `{ status: 'unavailable', cause: 'ai_disabled' }` — every caller already
   * handles that path, nothing crashes, the learner sees a calm message. It is
   * also a lie with no symptom: "an administrator has switched AI off" and
   * "the settings row will not parse" would look identical in the product AND
   * in the logs, so a deployment whose AI has been broken since a bad migration
   * reports itself as deliberately configured that way, indefinitely, and the
   * one person who could fix it is never told there is anything to fix.
   *
   * So a genuine fault keeps its own status. `failed` is the shape a caller
   * already handles for a provider error, it carries a code an operator can
   * GROUP by, and the grading ladder treats it exactly as it treats every other
   * failure — keep the deterministic result, stay a 200 (`ai-evaluation.md`
   * §6). Nothing about the learner's experience is worse for being honest here;
   * only the diagnosis is better.
   *
   * The message is redacted through the caller's redactor and truncated, in
   * that ORDER: truncating first could cut a secret in half and leave the tail
   * intact.
   */
  private dispatchFailure(
    userId: string,
    role: AiModelRole,
    err: unknown,
    redact: SecretRedactor,
  ): AiRunFailed {
    const raw =
      err instanceof Error
        ? err.message || err.name
        : typeof err === 'string'
          ? err
          : `Non-Error value of type ${typeof err} thrown.`;

    const error = truncateProviderError(redact.apply(raw));

    // `error`, not `warn`: this is a fault in our own resolution path, not a
    // provider having a bad day.
    this.logger.error(
      `AI dispatch could not resolve a call for user ${userId} (${role}): ${error}`,
    );

    return {
      status: 'failed',
      errorCode: DISPATCH_ERROR_CODE,
      error,
      // No provider was reached, so no row was owed and none was written.
      usageEventId: null,
      modelId: NO_MODEL,
    };
  }
}

/** One place an `unavailable` result is built, so the four causes stay four. */
function unavailable(cause: AiUnavailableCause): AiRunUnavailable {
  return { status: 'unavailable', cause };
}

/**
 * A stream that yields one terminal `error` event and ends.
 *
 * The failure shape a consumer already handles, for a failure that happened
 * before a provider was ever reached — see {@link AiDispatchService.runStream}.
 * `usage` is all-null because nothing was spent, and `usageEventId` is null
 * because no row was owed.
 */
async function* singleErrorStream(
  errorCode: string,
  error: string,
): AsyncGenerator<AiStreamEvent, void, undefined> {
  yield { type: 'error', errorCode, error, usage: EMPTY_USAGE, usageEventId: null };
}
