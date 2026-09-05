import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { CredentialsService } from '../../credentials/credentials.service';
import type { SecretRedactor } from '../../common/crypto/secret-redactor';
import { BaseAiProvider } from '../base-ai.provider';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
} from '../ai-credential.constants';
import type { AiCapabilityFamily } from '../ai-model-roles';
import type { AiProviderKind } from '../ai-settings.schema';
import { AiUsageService } from '../ai-usage.service';
import {
  DEFAULT_SPEECH_FORMAT,
  speechContentType,
} from '../speech-format';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiConnectionTestResult,
  AiMessage,
  AiModelCatalogResult,
  AiModelDescriptor,
  AiReachabilityRequest,
  AiReachabilityResult,
  AiRealtimeSessionRequest,
  AiRealtimeSessionResult,
  AiStructuredCompletionRequest,
  AiSynthesisRequest,
  AiSynthesisResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
  AiUsage,
  AiVoiceDescriptor,
} from '../ai.types';
import type { AiCapabilitySet } from './ai-provider.interface';
import { classifyModel, parseGeneration } from './model-classifier';
import { describeModelTraits } from './model-traits';

// =============================================================================
// OpenAiProvider (issue #29, epic #25)
// =============================================================================
//
// The one concrete provider. Two of its jobs belong to the settings surface:
// it fetches and classifies the model catalog on the SERVER key, and it proves
// a given key can reach the models the app is bound to. The rest is inference
// — one completion (#37), one schema-constrained completion and one stream
// (#96, epic #53).
//
// THE SERVER KEY IS READ IN EXACTLY ONE PLACE, `fetchModels`, AND NOWHERE
// ELSE. Epic #25, decision 4: every inference call runs on the CALLING USER's
// own key, which is why all three inference hooks below take `apiKey` as a
// PARAMETER and never touch `this.credentials`. A hook that quietly reached
// for the server key would defeat the entire reason BYOK was chosen — each
// user seeing and paying for their own consumption — and it would do so
// invisibly, because the call would still work.
//
// -----------------------------------------------------------------------------
// THE OFFICIAL SDK RATHER THAN RAW `fetch`
// -----------------------------------------------------------------------------
//
// This module could list models with one `fetch`. The reason to take the
// dependency now is what comes next: streaming usage accounting (#37) and the
// Realtime surface are fiddly to implement correctly by hand, and adopting the
// SDK later would mean rewriting the code that already works. The API has no
// general HTTP client today beyond `nodemailer` and the AWS SDK, so there is
// nothing to reuse.
//
// -----------------------------------------------------------------------------
// THIS CLASS THROWS FREELY. THAT IS CORRECT.
// -----------------------------------------------------------------------------
//
// It extends `BaseAiProvider`, which implements the public never-throw methods
// once and calls the `protected` ones below inside a try/catch. No try/catch in
// this file guards against a throw — one that did would produce a worse message
// than the base class already builds (see base-ai.provider.ts). The few that
// exist all SHAPE A RESULT the base class could not have produced: which of the
// two test steps failed, which role is unreachable, whether an outcome is
// actually a reachable model, and whether to retry once without our own
// optional parameters. Each says so at the catch.
//
// THE KEY IS REGISTERED WITH THE REDACTOR AT THE INSTANT IT IS OBTAINED, on
// the line after the `getSecret` that returns it and before the client is
// constructed. Everything after that point — DNS, TLS, the SDK's own error
// formatting — can raise a string we did not author while holding it.
// =============================================================================

/**
 * How long a fetched catalog stays fresh, in milliseconds.
 *
 * The admin page calls `GET /api/ai-settings/models` on every render and each
 * miss is a round trip on the organisation's key. Minutes rather than seconds
 * because the catalog changes on the order of weeks; minutes rather than hours
 * because an admin who has just been granted access to a new model tier should
 * not have to restart the API to see it.
 */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Request timeout for the reachability probe, in milliseconds.
 *
 * Bounded because this endpoint is synchronous from a user's point of view —
 * they pressed "Test" and are watching a spinner. A key pointed at a
 * black-holed network must fail in seconds with "the request never got there",
 * not hang until the platform's own timeout.
 */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * The probe's prompt.
 *
 * A USER TURN, deliberately — it is the one role every chat shape accepts,
 * from `gpt-3.5-turbo` through `o1-mini` (which rejects both `system` and
 * `developer`) to `gpt-5`. The probe is testing the key, not the model's
 * instruction handling, so it has no reason to send the role that varies.
 */
const PROBE_MESSAGES: AiMessage[] = [{ role: 'user', content: 'ping' }];

/**
 * The families this provider can serve.
 *
 * All six, because OpenAI genuinely offers all of them. A future Anthropic
 * provider declares a strict subset, and that is the whole point of the
 * capability set — see providers/ai-provider.interface.ts.
 */
const OPENAI_CAPABILITIES: AiCapabilitySet = new Set<AiCapabilityFamily>([
  'text',
  'realtime',
  'transcribe',
  'tts',
  'embedding',
  'other',
]);

/**
 * The voice used when a caller names none.
 *
 * `alloy` is OpenAI's neutral default. The choice lives here rather than at
 * each call site so the application does not read questions in one voice and
 * explanations in another — see `AiSynthesisRequest.voice`.
 *
 * EXPORTED SINCE #283, and it is the same constant on both sides of the voice
 * picker: `runSynthesis` below falls back to it, and `defaultSpeechVoice`
 * publishes it through `GET /api/ai/speech/voices` as the option a learner is
 * already hearing. Two constants — one for the synthesiser, one for the picker
 * — would agree today and disagree the first time either moved, and the
 * symptom would be a settings screen confidently naming a voice the
 * application does not use.
 */
export const DEFAULT_SPEECH_VOICE = 'alloy';

/**
 * OpenAI's own text-to-speech voices, and THE ONE PLACE IN THIS REPOSITORY
 * THIS LIST LIVES (#283, epic #280).
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS HERE AND NOWHERE ELSE
 * -----------------------------------------------------------------------------
 *
 * `aiSynthesizeRequestSchema`'s `voice` field validates SHAPE AND NOT
 * MEMBERSHIP, and its own comment says why: "the accepted set belongs to the
 * provider and hard-coding OpenAI's list here would be a second place that list
 * lives — wrong on the day a second provider ships, and stale on the day OpenAI
 * adds a voice." That argument does not stop at the DTO. It rules out a copy in
 * `apps/web/src/config` for the same reason `ai-model-roles.ts` refuses one for
 * the role registry: a duplicate plus a test asserting the two agree is
 * DETECTION rather than prevention — the copies can still disagree in a working
 * tree, in a branch, and in any build where the test is not run.
 *
 * So the web reads this over `GET /api/ai/speech/voices`, and a provider that
 * is not OpenAI publishes its own list from its own file without touching
 * either the DTO or the picker. `openai.provider.spec.ts` asserts these ids
 * appear in exactly one non-test source file.
 *
 * -----------------------------------------------------------------------------
 * THE IDS ARE A WIRE CONTRACT, THE LABELS AND DESCRIPTIONS ARE PRODUCT COPY
 * -----------------------------------------------------------------------------
 *
 * Each `id` is sent verbatim to `client.audio.speech.create` and must satisfy
 * the charset `aiSynthesizeRequestSchema` accepts, or the picker would offer a
 * value the synthesis endpoint answers with a 400 — a failure the learner
 * cannot explain, caused by choosing from a list this application handed them.
 * The descriptions are written for somebody deciding which voice to study with,
 * not for an operator reading a catalog.
 *
 * Alphabetical, which happens to put the default first; nothing reads the
 * order, because {@link DEFAULT_SPEECH_VOICE} names the default explicitly
 * rather than leaving it to position.
 */
const OPENAI_TTS_VOICES: readonly AiVoiceDescriptor[] = [
  {
    id: 'alloy',
    label: 'Alloy',
    description: 'Neutral and even — the easiest to listen to for a long session.',
  },
  {
    id: 'ash',
    label: 'Ash',
    description: 'Low and unhurried, with a steady, matter-of-fact delivery.',
  },
  {
    id: 'ballad',
    label: 'Ballad',
    description: 'Gentle and expressive, with a softer, storytelling rhythm.',
  },
  {
    id: 'coral',
    label: 'Coral',
    description: 'Bright and friendly, with a warm lift at the end of a sentence.',
  },
  {
    id: 'echo',
    label: 'Echo',
    description: 'Calm and level, with little inflection — plain and easy to follow.',
  },
  {
    id: 'fable',
    label: 'Fable',
    description: 'Warm and animated, in the register of someone reading aloud.',
  },
  {
    id: 'nova',
    label: 'Nova',
    description: 'Clear and energetic, crisply articulated at a slightly brisker pace.',
  },
  {
    id: 'onyx',
    label: 'Onyx',
    description: 'Deep and resonant — the most authoritative of the voices.',
  },
  {
    id: 'sage',
    label: 'Sage',
    description: 'Measured and reassuring, at a patient, teacherly pace.',
  },
  {
    id: 'shimmer',
    label: 'Shimmer',
    description: 'Light and airy, soft-edged and gentle on the ear.',
  },
];

// The default container and the container -> MIME map moved to
// `../speech-format.ts` in #284, when a SECOND path started needing the same
// answer: `GET /api/ai/speech/audio` serves cached bytes with no provider call
// to derive a content type from, and a copy of the map there would drift from
// this one. Nothing about the values changed — see that file's header.

/**
 * Usage for a speech call.
 *
 * ALL NULL, AND NOT BECAUSE ANYTHING FAILED: the speech endpoints report no
 * token counts at all. `null` means "we were not told", which is exactly the
 * truth here, and `0` would claim the call consumed nothing — see `AiUsage`.
 */
const EMPTY_SPEECH_USAGE: AiUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

/**
 * The voice a realtime session uses when a caller names none.
 *
 * SEPARATE FROM {@link DEFAULT_SPEECH_VOICE} even though both are `alloy`
 * today, because they answer different questions: one is the voice this
 * application READS TEXT ALOUD in, the other is the voice an interviewing
 * officer SPEAKS in. Collapsing them onto one constant would mean a product
 * decision to give the officer a distinct voice — an obvious thing to want —
 * silently changed every question-playback button in the app as well.
 */
const DEFAULT_REALTIME_VOICE = 'alloy';

/**
 * Usage for a realtime mint.
 *
 * ALL NULL, and not because anything failed or because we were not told:
 * minting a client secret runs no inference. Every token the session goes on
 * to spend is consumed by a conversation between the learner's browser and the
 * provider, which this process never sees. `0` would claim we know the session
 * cost nothing — see `AiUsage`, and `AiRealtimeSessionResult.usage`, where the
 * gap in per-user accounting is stated rather than papered over.
 */
const EMPTY_REALTIME_USAGE: AiUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

/** A cached catalog, together with the key it was fetched under. */
interface CachedCatalog {
  models: AiModelDescriptor[];
  fetchedAt: number;

  /**
   * A fingerprint of the key the catalog was fetched with — NOT the key.
   *
   * The cache must not leak between differing key configurations: an admin who
   * rotates to a key in a different organisation, with a different model tier,
   * must not keep seeing the old organisation's catalog for five minutes. A
   * hash rather than the key itself so the cached entry is not a second place
   * the plaintext lives; length is enough to be wrong, so a real digest is
   * used.
   */
  keyFingerprint: string;
}

@Injectable()
export class OpenAiProvider extends BaseAiProvider {
  protected readonly logger = new Logger(OpenAiProvider.name);
  readonly kind: AiProviderKind = 'openai';
  readonly capabilities = OPENAI_CAPABILITIES;
  protected readonly providerName = 'OpenAI';

  /** See {@link OPENAI_TTS_VOICES} — the base class gates these on `tts`. */
  protected readonly speechVoices = OPENAI_TTS_VOICES;

  /**
   * The same constant `runSynthesis` falls back to, so the picker's "default"
   * and the synthesiser's default are one value. See
   * {@link DEFAULT_SPEECH_VOICE}.
   */
  protected readonly defaultSpeechVoice = DEFAULT_SPEECH_VOICE;

  /**
   * The last fetched catalog. In-process and per-instance, which is the right
   * scope: this is a latency optimisation for one API process's admin page,
   * not a distributed cache with an invalidation protocol to get wrong.
   */
  private cache: CachedCatalog | null = null;

  constructor(
    private readonly credentials: CredentialsService,
    // Exposed to the base class through the `usage` field below, so the
    // never-throw recording wrapper lives in one place rather than at each
    // call site here.
    protected readonly usage: AiUsageService,
  ) {
    super();
  }

  /**
   * Drop the cached catalog.
   *
   * Called by the settings service on every write (#30): the key may have
   * changed, and even when it has not, an admin who just saved and is now
   * looking at the dropdown expects to see the effect.
   */
  invalidateCatalogCache(): void {
    this.cache = null;
  }

  // ---------------------------------------------------------------------------
  // BaseAiProvider hooks — may throw freely
  // ---------------------------------------------------------------------------

  /**
   * Fetch and classify the catalog on the SERVER credential.
   *
   * @returns `null` when no server key is stored. NOT an error — that is the
   *          state of every fresh install, and `getSecret` returns `null` for
   *          an absent credential by design.
   */
  protected async fetchModels(
    redact: SecretRedactor,
  ): Promise<AiModelCatalogResult | null> {
    const apiKey = await this.credentials.getSecret(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );

    // REGISTERED IMMEDIATELY, before the fingerprint, before the client, before
    // anything that can throw while this value is in scope.
    redact.protect(apiKey);

    if (apiKey === null) {
      // The base class turns `null` into `{ notConfigured: true }`.
      return null;
    }

    const fingerprint = fingerprintKey(apiKey);
    const cached = this.readCache(fingerprint);
    if (cached) {
      return { success: true, models: cached, error: null, notConfigured: false };
    }

    const client = new OpenAI({ apiKey });

    // `list()` is paginated by the SDK; `for await` walks every page, so a
    // catalog longer than one page is not silently truncated to its first
    // slice — which would present as "that model does not exist".
    const models: AiModelDescriptor[] = [];
    for await (const model of client.models.list()) {
      models.push(describeModel(model.id, model.created));
    }

    // Newest first within a family is what an admin wants; the endpoint (#31)
    // groups by family and this ordering survives that grouping.
    models.sort(byNewest);

    this.cache = { models, fetchedAt: Date.now(), keyFingerprint: fingerprint };

    return { success: true, models, error: null, notConfigured: false };
  }

  /**
   * Authenticate `apiKey`, then probe each requested model on it.
   *
   * TWO STEPS, REPORTED SEPARATELY, because they are different problems with
   * different remedies. A key that fails step 1 is wrong or revoked; a key
   * that passes step 1 and fails step 2 is valid but belongs to an
   * organisation or tier without access to the models this admin bound. Told
   * "the test failed", a user would rotate a perfectly good key.
   */
  protected async probeConnection(
    apiKey: string,
    probes: AiReachabilityRequest[],
    redact: SecretRedactor,
  ): Promise<AiConnectionTestResult> {
    // Re-registered defensively. The base class already did this before
    // calling us, so this is belt and braces on the one value that must never
    // escape — not a substitute for the base class's guarantee.
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey, timeout: PROBE_TIMEOUT_MS });

    // STEP 1: does the key authenticate at all?
    //
    // `models.list()` is the cheapest authenticated call OpenAI offers and it
    // needs no model access, so it separates "bad key" from "no access to that
    // model" cleanly. It is NOT sufficient on its own — see the class header
    // and step 2.
    try {
      await client.models.list();
    } catch (err) {
      // The ONE try/catch in this file, and it is not a never-throw guard: it
      // is how "the key is bad" becomes a reported RESULT rather than a
      // process failure that skips the per-role reporting below. The base
      // class would otherwise turn this into a bare error with
      // `authenticated` defaulting to false and no explanation of which step
      // failed — which is the same information, worse organised.
      return {
        success: false,
        authenticated: false,
        roles: [],
        error: describeError(err),
      };
    }

    // STEP 2: can this key actually reach each bound model?
    const roles: AiReachabilityResult[] = [];
    for (const probe of probes) {
      roles.push(await this.probeModel(client, probe));
    }

    const unreachable = roles.filter((role) => !role.reachable);

    return {
      // A CONJUNCTION. A key that authenticates but cannot reach the `grader`
      // model does not work for this application, and reporting it as success
      // is how a user finishes onboarding into a product that fails on their
      // first practice answer.
      success: unreachable.length === 0,
      authenticated: true,
      roles,
      error:
        unreachable.length === 0
          ? null
          : `This key works, but it cannot reach ${unreachable.length === 1 ? 'the model bound to' : 'the models bound to'} ${unreachable.map((r) => r.roleKey).join(', ')}.`,
    };
  }

  /**
   * Run one completion on the caller's key.
   *
   * -------------------------------------------------------------------------
   * `stream_options: { include_usage: true }` IS NOT OPTIONAL
   * -------------------------------------------------------------------------
   *
   * OpenAI reports `usage` on a completed non-streaming response
   * unconditionally, but on a STREAMED one only when that flag is set. Omit it
   * and every streaming call records nothing — no error, no warning, just a
   * consumption figure that is quietly always zero.
   *
   * That is the most likely way this feature ends up wrong, which is why the
   * flag is set HERE, in the single place a streaming request is constructed,
   * and why a test asserts it rather than trusting a comment.
   *
   * -------------------------------------------------------------------------
   * A MID-STREAM FAILURE RECORDS NULL, NOT ZERO
   * -------------------------------------------------------------------------
   *
   * Throwing out of this method is how that happens: `BaseAiProvider.complete`
   * catches it and records all-null usage. This method therefore does NOT
   * catch a stream error and return partial counts as if they were final — the
   * counts it has mid-stream are not the call's consumption, and reporting
   * them as such would understate what the user was actually billed for by an
   * unknowable amount.
   *
   * -------------------------------------------------------------------------
   * THE REQUEST IS BUILT FROM THE MODEL'S TRAITS, NOT FROM ONE FIXED SHAPE
   * -------------------------------------------------------------------------
   *
   * `system`/`developer`/`user` for the instruction turn, and a floor under the
   * caller's token budget, both come from `model-traits.ts` — see
   * {@link buildChatRequest}. The same builder serves the probe, so the two
   * cannot drift into disagreeing about what a `gpt-5` request looks like.
   *
   * NO `reasoning_effort` HERE. The probe pins the minimum because it is
   * buying proof rather than an answer; a real completion takes the model's own
   * default, which is what the role was bound for.
   */
  protected async runCompletion(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
  ): Promise<AiCompletionResult> {
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey });

    const base = buildChatRequest(request.modelId, request.messages, {
      maxTokens: request.maxTokens,
    });

    if (!request.stream) {
      const response = await client.chat.completions.create({
        ...base,
        stream: false,
      });

      return {
        success: true,
        text: response.choices[0]?.message?.content ?? null,
        usage: readUsage(response.usage),
        errorCode: null,
        error: null,
      };
    }

    const stream = await client.chat.completions.create({
      ...base,
      stream: true,
      // THE FLAG. See the note above — without it, every streamed call records
      // zero tokens and nothing fails.
      stream_options: { include_usage: true },
    });

    let text = '';
    // Assigned only from a usage-bearing chunk. Stays all-null if the stream
    // ends without one, which is honest: we were not told.
    let usage: AiUsage = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };

    // A throw from inside this loop propagates — see the header. It is how a
    // mid-stream failure becomes an all-null row rather than a partial count
    // presented as final.
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';

      // The usage chunk arrives LAST, after the final content chunk, and only
      // because `include_usage` was set.
      if (chunk.usage) {
        usage = readUsage(chunk.usage);
      }
    }

    return {
      success: true,
      text: text.length > 0 ? text : null,
      usage,
      errorCode: null,
      error: null,
    };
  }

  /**
   * Run one completion constrained to a JSON schema, on the caller's key.
   *
   * -------------------------------------------------------------------------
   * `strict: true` IS THE WHOLE POINT
   * -------------------------------------------------------------------------
   *
   * Without it `response_format: { type: 'json_schema' }` is a strong hint:
   * the reply is JSON, and the schema is advice the model may take. With it
   * OpenAI constrains decoding so the reply cannot violate the schema at all.
   * The difference does not show up in testing — a capable model follows the
   * hint most of the time — it shows up as a grader that works for weeks and
   * then returns a field that is not there.
   *
   * `strict` has a cost the caller must know about: OpenAI requires every
   * property to be required and `additionalProperties: false` throughout, so a
   * schema with an `.optional()` field is rejected by the API rather than
   * silently downgraded. `z.toJSONSchema(..., { target: 'draft-7' })` in the
   * base class emits `additionalProperties: false` for an object schema, so
   * the usual shapes pass; an optional field is expressed as a nullable one.
   * That rejection arrives as an ordinary failed result — the base class
   * catches it — which is the right outcome: it is a bug in our schema, and it
   * fails on the first call rather than the thousandth.
   *
   * NEVER STREAMED. A structured reply is parsed as a whole and validated as a
   * whole; there is no useful partial state, and a half-decoded object is not
   * an early draft of a grade.
   */
  protected async runStructuredCompletion(
    apiKey: string,
    request: AiStructuredCompletionRequest<unknown>,
    jsonSchema: Record<string, unknown>,
    redact: SecretRedactor,
  ): Promise<{ raw: string | null; usage: AiUsage }> {
    // Re-registered defensively, as the other hooks do. The base class already
    // did this before calling us.
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey });

    // THE SAME BUILDER as the probe and `runCompletion`. A structured call is
    // an ordinary chat call with one extra field, and giving it its own
    // request shape is how the instruction role and the reasoning-token floor
    // come to disagree between the two — see {@link buildChatRequest}.
    const base = buildChatRequest(request.modelId, request.messages, {
      maxTokens: request.maxTokens,
    });

    const response = await client.chat.completions.create({
      ...base,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: jsonSchema,
        },
      },
    });

    // RAW, UNPARSED. The base class parses and validates once, where the two
    // failure codes are classified and where the rule about not quoting the
    // reply into an error string lives.
    return {
      raw: response.choices[0]?.message?.content ?? null,
      usage: readUsage(response.usage),
    };
  }

  /**
   * Open a streamed completion on the caller's key.
   *
   * -------------------------------------------------------------------------
   * `stream_options: { include_usage: true }` IS MANDATORY
   * -------------------------------------------------------------------------
   *
   * OpenAI reports `usage` on a completed non-streaming response
   * unconditionally, but on a STREAMED one only when this flag is set. Omit it
   * and every streamed call records zero tokens — no error, no warning, no
   * symptom of its own (#37). The only thing that ever notices is somebody
   * eventually asking why the streaming feature appears to be free.
   *
   * That is why the flag is set HERE, in one of the only two places this
   * provider constructs a streaming request, and why a test asserts it rather
   * than trusting this comment.
   *
   * -------------------------------------------------------------------------
   * `signal` REACHES THE SOCKET, NOT JUST THE LOOP
   * -------------------------------------------------------------------------
   *
   * Passed in the SDK's request options rather than merely checked between
   * chunks: an abort that only breaks our loop leaves OpenAI generating — and
   * billing — the rest of a response nobody will read. Handing the signal to
   * the request is what actually stops the work upstream when a learner closes
   * the tab.
   *
   * THROWS FREELY, INCLUDING MID-ITERATION. `BaseAiProvider.stream` turns both
   * into the single terminal `error` event and records the row.
   */
  protected async *openStream(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
    signal?: AbortSignal,
  ): AsyncGenerator<{ delta?: string; usage?: AiUsage }, void, undefined> {
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey });

    const base = buildChatRequest(request.modelId, request.messages, {
      maxTokens: request.maxTokens,
    });

    const stream = await client.chat.completions.create(
      {
        ...base,
        stream: true,
        // THE FLAG. See above — without it every streamed call records zero
        // tokens and nothing fails.
        stream_options: { include_usage: true },
      },
      // The SDK's request options, which is where an abort has to go to reach
      // the underlying request.
      { signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { delta };
      }

      // The usage chunk arrives LAST, after the final content chunk, and only
      // because `include_usage` was set. Yielded separately rather than merged
      // into a delta: it is a fact about the whole call, not about a fragment.
      if (chunk.usage) {
        yield { usage: readUsage(chunk.usage) };
      }
    }
  }

  /**
   * Transcribe one recording on the caller's key (#88, epic #58).
   *
   * -------------------------------------------------------------------------
   * THE BUFFER IS UPLOADED AS A NAMED `File`, AND THE NAME IS LOAD-BEARING
   * -------------------------------------------------------------------------
   *
   * OpenAI infers the container format from the upload's filename extension.
   * An unnamed blob is rejected as an unsupported format — which presents as
   * "transcription is broken for everyone" rather than as the missing piece of
   * metadata it is. `AiTranscriptionRequest.fileName` exists for this and
   * nothing else; it is never written anywhere.
   *
   * -------------------------------------------------------------------------
   * `verbose_json` IS REQUESTED BECAUSE IT IS THE ONLY CONFIDENCE SIGNAL THERE
   * IS
   * -------------------------------------------------------------------------
   *
   * The plain `json` response carries the text and nothing else. `verbose_json`
   * adds per-segment `avg_logprob`, which {@link deriveConfidence} turns into
   * the 0..1 number this application actually needs — "was this answer wrong,
   * or was it misheard?" is a question a transcript alone cannot answer.
   *
   * -------------------------------------------------------------------------
   * AND THE `gpt-4o-transcribe` FAMILY CANNOT PRODUCE IT
   * -------------------------------------------------------------------------
   *
   * Those models accept only `json` (and `text`). A request pinned to
   * `verbose_json` against one of them is a 400 — so the model an admin quite
   * reasonably bound would simply never work. Two mechanisms cover that, and
   * both are wanted:
   *
   *   * {@link wantsVerboseTranscription} skips `verbose_json` for the family
   *     by name, so the ordinary case costs no failed request. A reactive
   *     retry alone would burn a rejected upload — a learner's whole
   *     recording, and the latency of sending it — on EVERY call.
   *   * a single retry covers everything the name check cannot know about: a
   *     renamed line, a new one, a third-party OpenAI-compatible endpoint.
   *     Exactly one retry, for the reason `probeTextModel` gives — a loop here
   *     spends someone's money re-uploading audio that was already refused.
   *
   * Either way the fallback returns `confidence: null`, NEVER a guessed
   * number. See {@link AiTranscriptionResult.confidence}: an invented
   * confidence is indistinguishable from a measured one at every call site
   * that reads it.
   *
   * THROWS FREELY. `BaseAiProvider.transcribe` turns a throw into a recorded
   * failure with null text, null confidence and null token counts.
   */
  protected async runTranscription(
    apiKey: string,
    request: AiTranscriptionRequest,
    redact: SecretRedactor,
  ): Promise<AiTranscriptionResult> {
    // Re-registered defensively, as the other hooks do. The base class already
    // did this before calling us.
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey });

    // A global `File` rather than the SDK's `toFile` helper: the payload is
    // already fully in memory, so there is nothing to read or stream, and this
    // keeps the upload path free of an SDK entry point that a test would then
    // have to stand in for.
    //
    // The bytes are copied into a plain `Uint8Array` because a Node `Buffer`
    // may be backed by a `SharedArrayBuffer` and is therefore not a `BlobPart`
    // to the compiler. A copy of one recording is affordable; reaching for a
    // cast instead would silence a real distinction.
    const file = new File([new Uint8Array(request.audio)], request.fileName, {
      type: request.contentType,
    });

    const base = {
      file,
      model: request.modelId,
      ...(request.languageHint ? { language: request.languageHint } : {}),
    };

    if (!wantsVerboseTranscription(request.modelId)) {
      const plain = await client.audio.transcriptions.create({
        ...base,
        response_format: 'json',
      });

      return transcriptionResult(readTranscriptText(plain), null);
    }

    try {
      const verbose = await client.audio.transcriptions.create({
        ...base,
        response_format: 'verbose_json',
      });

      return transcriptionResult(
        readTranscriptText(verbose),
        deriveConfidence(verbose),
      );
    } catch (err) {
      // NOT a never-throw guard — the base class owns that. This catch makes
      // one decision and rethrows everything else untouched: an expired key, a
      // quota, a network failure must all stay failures.
      if (!isUnsupportedResponseFormatError(err)) throw err;

      const plain = await client.audio.transcriptions.create({
        ...base,
        response_format: 'json',
      });

      return transcriptionResult(readTranscriptText(plain), null);
    }
  }

  /**
   * Synthesise speech on the caller's key (#88, epic #58).
   *
   * THE RESPONSE IS A `Response`, NOT A JSON BODY. The SDK hands back the raw
   * fetch response and the bytes come out of `arrayBuffer()`, which is why
   * this method — unlike every other hook here — has no shape to read fields
   * off. The content type is derived from the format we ASKED for rather than
   * read off the response header, because the header is what a proxy or a
   * mock may or may not set and the format is what we know we requested.
   *
   * NO TOKEN USAGE IS REPORTED, AND ALL-NULL IS THE HONEST ANSWER. The speech
   * endpoints bill by characters and duration and send no usage object at all.
   * Writing `0` would state that this call consumed nothing — see
   * `AiUsage`'s own contract, which is the same rule that keeps a failed
   * completion from recording zero tokens.
   *
   * THROWS FREELY; the base class records the failure.
   */
  protected async runSynthesis(
    apiKey: string,
    request: AiSynthesisRequest,
    redact: SecretRedactor,
  ): Promise<AiSynthesisResult> {
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey });

    const format = request.format ?? DEFAULT_SPEECH_FORMAT;

    const response = await client.audio.speech.create({
      model: request.modelId,
      // The default is a product decision made once, here, rather than at each
      // call site — see `AiSynthesisRequest.voice`.
      voice: request.voice ?? DEFAULT_SPEECH_VOICE,
      input: request.text,
      response_format: format as 'mp3',
    });

    const audio = Buffer.from(await response.arrayBuffer());

    return {
      success: true,
      audio,
      contentType: speechContentType(format),
      usage: EMPTY_SPEECH_USAGE,
      errorCode: null,
      error: null,
    };
  }

  /**
   * Mint one ephemeral realtime client secret on the caller's key (#156,
   * epic #60).
   *
   * `POST /v1/realtime/client_secrets`, through the SDK's own
   * `realtime.clientSecrets.create` — the endpoint whose entire purpose is to
   * produce a credential that CAN be given to a browser, so that the
   * long-lived key never is. The session configuration travels with the mint
   * request rather than being negotiated by the client, which is what makes
   * the officer's instructions and the tool list ours rather than the
   * browser's to choose.
   *
   * NO RAW `fetch` AND NO NEW DEPENDENCY: the installed SDK exposes this
   * surface directly (`openai@7`), so hand-rolling the request would mean
   * hand-rolling its error shapes too — and `classifyThrow` in the base class
   * reads the SDK's messages.
   *
   * THE EXPIRY IS READ BACK, NEVER COMPUTED. The provider anchors it to its
   * own clock at the moment of minting; a `now + expiresInSeconds` computed
   * here would disagree with the truth by the round trip plus clock skew, in
   * the direction that tells a browser it still has time it does not have. A
   * response we cannot read an expiry off is therefore a REFUSAL rather than a
   * session with an unknown deadline — see {@link realtimeExpiry}.
   *
   * NO TOKEN USAGE IS REPORTED, and all-null is the honest answer: minting
   * runs no inference. See {@link EMPTY_REALTIME_USAGE}.
   *
   * THROWS FREELY; `BaseAiProvider.createRealtimeSession` records the failure
   * — and registers the secret below with the redactor the moment this returns
   * it, which is why nothing here has to.
   */
  protected async runRealtimeSession(
    apiKey: string,
    request: AiRealtimeSessionRequest,
    redact: SecretRedactor,
  ): Promise<AiRealtimeSessionResult> {
    redact.protect(apiKey);

    const client = new OpenAI({ apiKey });

    const minted = await client.realtime.clientSecrets.create({
      // Sent only when the caller asked for one, so an omitted lifetime means
      // the provider's own (short) default rather than a number this file
      // invented on its behalf.
      ...(request.expiresInSeconds === undefined
        ? {}
        : {
            expires_after: {
              anchor: 'created_at' as const,
              seconds: request.expiresInSeconds,
            },
          }),
      session: {
        type: 'realtime',
        model: request.modelId,
        instructions: request.instructions,
        audio: {
          // The default is a product decision made once, here, rather than at
          // each call site — see `AiRealtimeSessionRequest.voice`.
          output: { voice: request.voice ?? DEFAULT_REALTIME_VOICE },
        },
        // Always sent, including as `[]`: a session minted with the tools
        // field omitted inherits nothing, which is the same outcome, but
        // sending what the caller declared keeps "this session deliberately
        // has no tools" visible in the request rather than implied by its
        // absence.
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    });

    const expiresAt = realtimeExpiry(minted.expires_at);

    if (expiresAt === null) {
      // A secret with no readable deadline is worse than no secret: the
      // browser would be handed a credential nothing can decide is stale, and
      // every "is it still good?" check downstream would have to invent an
      // answer. Refusing costs one retry; guessing costs a session that dies
      // mid-interview with no explanation.
      return {
        success: false,
        clientSecret: null,
        expiresAt: null,
        modelId: null,
        usage: EMPTY_REALTIME_USAGE,
        errorCode: 'malformed_result',
        error: 'The realtime session was minted without a usable expiry.',
      };
    }

    return {
      success: true,
      clientSecret: minted.value,
      expiresAt,
      // The session the provider actually created, falling back to what we
      // asked for. A transcription-shaped session response carries no model at
      // all, and the request's own id is the honest answer then — never a
      // guess, because it is what this call named.
      modelId: readSessionModel(minted.session) ?? request.modelId,
      usage: EMPTY_REALTIME_USAGE,
      errorCode: null,
      error: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Probe one bound model.
   *
   * THE PROBE IS A REAL REQUEST OF THE KIND THE ROLE MAKES, not a catalog
   * lookup. `GET /v1/models` lists what the account could have access to;
   * only issuing the request proves the key may issue it. The smallest
   * completion THE MODEL CAN ACTUALLY PRODUCE is the cheapest thing that
   * proves it — see {@link probeTextModel} for why "smallest" is not 1.
   *
   * Never throws — every failure becomes `{ reachable: false, error }`, so one
   * unreachable model does not abandon the remaining probes and leave the user
   * with a partial report they cannot tell is partial.
   */
  private async probeModel(
    client: OpenAI,
    probe: AiReachabilityRequest,
  ): Promise<AiReachabilityResult> {
    try {
      if (probe.family === 'text') {
        await this.probeTextModel(client, probe.modelId);
      } else if (probe.family === 'embedding') {
        await client.embeddings.create({
          model: probe.modelId,
          input: 'ping',
        });
      } else {
        // Realtime, transcription and TTS have no cheap, side-effect-free
        // probe: each needs a session, an audio file or a synthesis request.
        // Retrieving the model is a weaker check — it proves the account can
        // SEE the model rather than use it — and saying so is better than
        // either skipping the role silently or claiming a strength we do not
        // have. All three roles are wired now (#88 for the speech pair, #156
        // for `realtime`), so this weaker answer is a real one an admin reads
        // rather than a placeholder: a `realtime` binding that passes here can
        // still fail at mint time on an organisation without realtime access,
        // and the connection test says only what it actually checked.
        await client.models.retrieve(probe.modelId);
      }

      return {
        roleKey: probe.roleKey,
        modelId: probe.modelId,
        reachable: true,
        error: null,
      };
    } catch (err) {
      // AN OUTPUT-LIMIT OUTCOME IS A REACHABLE MODEL (#176).
      //
      // Reachability is the question "may this key issue this request against
      // this model". A model that accepted the request, ran, and stopped
      // against the output ceiling has answered it YES — the error is proof of
      // reach, not a denial of it. Reporting it as unreachable told admins to
      // rotate a working key, and no rotation could have fixed it.
      //
      // Kept here, in the catch, rather than only inside the text branch: it is
      // a property of the OUTCOME, not of how the request was built, so a
      // future probe shape gets the same reading for free.
      if (isOutputLimitOutcome(err)) {
        return {
          roleKey: probe.roleKey,
          modelId: probe.modelId,
          reachable: true,
          error: null,
        };
      }

      return {
        roleKey: probe.roleKey,
        modelId: probe.modelId,
        reachable: false,
        // Verbatim. The base class redacts and truncates every role error on
        // the way out, so this is raw on purpose — categorising it here would
        // discard the difference between "model not found" and "your
        // organisation must be verified to use this model".
        error: describeError(err),
      };
    }
  }

  /**
   * Issue the probe completion, with ONE retry stripped of everything optional.
   *
   * -------------------------------------------------------------------------
   * WHY THE BUDGET IS NOT 1
   * -------------------------------------------------------------------------
   *
   * It was, and that was #176. A reasoning model spends its whole completion
   * budget on hidden reasoning tokens before it can emit a visible one, so
   * `max_completion_tokens: 1` is not a cheap probe but a guaranteed 400. The
   * budget now comes from the model's traits, which know the difference; see
   * model-traits.ts.
   *
   * -------------------------------------------------------------------------
   * THE RETRY, AND WHY THERE IS EXACTLY ONE
   * -------------------------------------------------------------------------
   *
   * Model naming and parameter surfaces are not ours to control. A model that
   * lands in the wrong traits rule — a new line, a renamed one, a third-party
   * OpenAI-compatible endpoint — will reject a flag we sent, and reporting a
   * working key as broken because of OUR request shape is the same class of
   * failure as #176 itself. So on an unsupported-parameter rejection the probe
   * degrades to the request every chat model accepts: a model and messages,
   * nothing else.
   *
   * ONE retry, not a loop. This runs on a real key against a real account, and
   * a loop here is a way to spend someone's money on a diagnostic. The stripped
   * request has nothing left to strip anyway, so a second attempt could only
   * repeat the first.
   *
   * A throw from either attempt propagates to {@link probeModel}, where the
   * output-limit rule reads it — so a retry that ends at the output ceiling is
   * still a reachable model.
   */
  private async probeTextModel(client: OpenAI, modelId: string): Promise<void> {
    const traits = describeModelTraits(modelId);

    try {
      await client.chat.completions.create(
        buildChatRequest(modelId, PROBE_MESSAGES, {
          maxTokens: traits.minCompletionTokens,
          // The probe buys proof, not an answer: the cheapest effort tier the
          // model admits is the one that proves the key may issue the request.
          useMinimumReasoningEffort: true,
        }),
      );
    } catch (err) {
      // NOT a never-throw guard — the base class owns that. This catch exists
      // to make one decision, and it rethrows everything else untouched.
      if (!isUnsupportedParameterError(err)) throw err;

      await client.chat.completions.create({
        model: modelId,
        messages: PROBE_MESSAGES,
      });
    }
  }

  /** The cached catalog, if it is fresh and was fetched under this key. */
  private readCache(fingerprint: string): AiModelDescriptor[] | null {
    if (!this.cache) return null;
    if (this.cache.keyFingerprint !== fingerprint) return null;
    if (Date.now() - this.cache.fetchedAt > CATALOG_CACHE_TTL_MS) return null;
    return this.cache.models;
  }
}

// -----------------------------------------------------------------------------
// Pure helpers — exported for the fixture-driven tests next door
// -----------------------------------------------------------------------------

/**
 * Turn one catalog entry into a classified descriptor.
 *
 * @param created the provider's unix-seconds creation time, when it sends one.
 */
export function describeModel(
  id: string,
  created?: number | null,
): AiModelDescriptor {
  return {
    id,
    family: classifyModel(id),
    generation: parseGeneration(id),
    createdAt:
      typeof created === 'number' && Number.isFinite(created)
        ? new Date(created * 1000)
        : null,
  };
}

/** A chat request body, in the subset of the shape this provider ever sends. */
interface ChatRequestBody {
  model: string;
  messages: Array<{
    role: 'system' | 'developer' | 'user' | 'assistant';
    content: string;
  }>;
  max_completion_tokens?: number;
  reasoning_effort?: 'minimal' | 'low';
}

/**
 * Build a chat request body for one model id.
 *
 * THE ONE PLACE A CHAT REQUEST IS SHAPED, used by both the reachability probe
 * and `runCompletion`. Two builders would drift, and the drift would be
 * invisible: the probe would keep passing on a model the real call cannot use,
 * which is a worse version of #176 rather than a fix for it.
 *
 * What comes from the traits, and why:
 *
 *   * THE INSTRUCTION ROLE. `system` is a 400 on the o-series, which wants
 *     `developer`, and on `o1-mini`/`o1-preview`, which accept neither and want
 *     `user`. `user` and `assistant` turns pass through untouched — only the
 *     instruction turn varies.
 *   * THE TOKEN FLOOR, for reasoning models only. A reasoning model burns its
 *     budget on hidden reasoning before it can emit anything visible, so a
 *     caller's small `maxTokens` is not a cheap call but a silent
 *     empty-completion generator — a successful response, no error, no text.
 *     Raising the ceiling does not raise the bill: only tokens actually used
 *     are charged.
 *
 * NO SAMPLING PARAMETERS ARE SENT. That omission is exactly what makes this
 * request portable across both lines today — reasoning models reject
 * `temperature` and `top_p`. `OpenAiModelTraits.supportsSampling` exists for
 * the request builder that will need them once a feature exposes them, so the
 * knowledge lives with the rest of the model's shape rather than being
 * rediscovered at that call site.
 */
export function buildChatRequest(
  modelId: string,
  messages: AiMessage[],
  options: {
    maxTokens?: number;
    /**
     * Pin `reasoning_effort` to the model's floor.
     *
     * The probe sets this: it is buying proof that the key may issue the
     * request, not an answer worth reading. A real completion leaves it unset
     * and gets the model's own default, which is what the role was bound for.
     */
    useMinimumReasoningEffort?: boolean;
  } = {},
): ChatRequestBody {
  const traits = describeModelTraits(modelId);

  const budget =
    options.maxTokens === undefined
      ? undefined
      : traits.reasoning
        ? Math.max(options.maxTokens, traits.minCompletionTokens)
        : options.maxTokens;

  const effort =
    options.useMinimumReasoningEffort === true &&
    traits.supportsReasoningEffort &&
    traits.minimumReasoningEffort !== null
      ? traits.minimumReasoningEffort
      : undefined;

  return {
    model: modelId,
    messages: messages.map((message) => ({
      role: message.role === 'system' ? traits.instructionRole : message.role,
      content: message.content,
    })),
    ...(budget !== undefined ? { max_completion_tokens: budget } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  };
}

/**
 * Did this failure mean "the model ran and hit its output ceiling"?
 *
 * WHICH IS A REACHABLE MODEL (#176). The request was accepted, authorised,
 * routed to the model and executed; it stopped against a limit WE set. Reading
 * that as "this key cannot reach this model" is how a probe reported a working
 * key as broken and sent admins off to rotate it.
 *
 * The successful-response counterpart needs no code: a completion that returns
 * with `finish_reason: 'length'` and empty content does not throw, and the
 * probe deliberately asserts nothing about the content it got back — proof of
 * reach is the whole question, and a visible token was never part of it.
 *
 * Pure, exported, and matched on signals rather than on an SDK error class, so
 * a test can state the real 400 verbatim.
 */
export function isOutputLimitOutcome(err: unknown): boolean {
  const signals = errorSignals(err);

  // An exact code, not a substring: `content_length_exceeded` is a different
  // failure and must not be read as a reachable model.
  if (signals.codes.has('length')) return true;

  return (
    signals.text.includes('max_tokens or model output limit was reached') ||
    signals.text.includes('could not finish the message because')
  );
}

/**
 * Did this failure mean "I do not know that parameter"?
 *
 * The signal that OUR request shape, not the key, is the problem — a new model
 * line, a rename, a third-party OpenAI-compatible endpoint. See
 * `OpenAiProvider.probeTextModel` for what is done about it and why exactly
 * once.
 */
export function isUnsupportedParameterError(err: unknown): boolean {
  const { text } = errorSignals(err);

  return (
    text.includes('unsupported_parameter') ||
    text.includes('unknown_parameter') ||
    text.includes('unsupported_value') ||
    text.includes('unsupported parameter') ||
    text.includes('unrecognized request argument')
  );
}

/**
 * The strings a thrown value carries, lowercased, for the two predicates above.
 *
 * NAMED FIELDS ONLY, NEVER `JSON.stringify(err)` — an OpenAI SDK error holds a
 * `request` context built from the client's options, which include the API key.
 * Nothing collected here is ever emitted: these strings are read to make a
 * boolean decision and discarded, and `describeError` remains the only path
 * from an error to text this provider returns.
 *
 * @param depth guards a self-referential `error` chain, which the SDK's nested
 *        error shape makes cheap to construct by accident.
 */
function errorSignals(
  err: unknown,
  depth = 0,
): { text: string; codes: Set<string> } {
  if (typeof err === 'string') {
    return { text: err.toLowerCase(), codes: new Set() };
  }

  if (err === null || typeof err !== 'object' || depth > 3) {
    return { text: '', codes: new Set() };
  }

  const source = err as Record<string, unknown>;
  const parts: string[] = [];
  const codes = new Set<string>();

  if (typeof source.message === 'string') parts.push(source.message);

  // The short, machine-readable fields. Collected as exact values too, so a
  // predicate can require equality where a substring would be too loose.
  for (const field of ['code', 'param', 'type', 'finish_reason'] as const) {
    const value = source[field];
    if (typeof value === 'string') {
      parts.push(value);
      codes.add(value.toLowerCase());
    }
  }

  // The SDK nests the provider's own error body under `error`, and a
  // `finish_reason` arrives under `choices[0]`.
  const nested = errorSignals(source.error, depth + 1);
  parts.push(nested.text);
  for (const code of nested.codes) codes.add(code);

  if (Array.isArray(source.choices)) {
    const first = errorSignals(source.choices[0], depth + 1);
    parts.push(first.text);
    for (const code of first.codes) codes.add(code);
  }

  return { text: parts.join(' ').toLowerCase(), codes };
}

/**
 * Newest first, falling back to the id so the order is stable when the
 * provider sends no timestamps — an unstable list reshuffles an admin's
 * dropdown between renders for no reason.
 */
function byNewest(a: AiModelDescriptor, b: AiModelDescriptor): number {
  const at = a.createdAt?.getTime() ?? 0;
  const bt = b.createdAt?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return a.id.localeCompare(b.id);
}

/**
 * A stable, non-reversible fingerprint of a key, for cache scoping only.
 *
 * NOT a security boundary — it never leaves this process and is never logged.
 * It exists so a cached catalog can be invalidated when the key changes
 * without the cache entry becoming a second place the plaintext lives.
 */
function fingerprintKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Extract a message from a thrown value.
 *
 * NEVER `JSON.stringify(err)`: an OpenAI SDK error carries a `request` context
 * built from the client's options, which include the API key. The base class
 * redacts whatever comes out of here, but the first line of defence is not
 * serialising an object we do not control.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return `Non-Error value of type ${typeof err} thrown.`;
}

/**
 * Read a provider usage object into our shape.
 *
 * ABSENT MEANS NULL, NOT ZERO. A response with no `usage` — a streamed one
 * whose request omitted `include_usage`, or a provider that simply did not
 * send it — is one we were not told about, and `0` would state otherwise. The
 * database column is nullable for exactly this.
 */
function readUsage(
  usage:
    | {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
      }
    | null
    | undefined,
): AiUsage {
  return {
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    totalTokens: numberOrNull(usage?.total_tokens),
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Can this model produce `verbose_json`, the only response shape that carries a
 * confidence signal?
 *
 * `whisper-1` can. The `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` line
 * cannot — it accepts `json` and `text` only, and rejects anything else with a
 * 400. Matched on the name because that is the fact OpenAI publishes; the one
 * retry in {@link OpenAiProvider.runTranscription} is what covers the model
 * this rule has not heard of.
 *
 * DEFAULTS TO `true`, i.e. to asking for the richer shape. Getting that wrong
 * costs one retried request; defaulting the other way would silently drop the
 * confidence signal for every model not named here, including every future
 * one — a degradation with no symptom, on the exact field this epic exists to
 * produce.
 */
export function wantsVerboseTranscription(modelId: string): boolean {
  return !/transcribe/i.test(modelId);
}

/**
 * Did this failure mean "that response_format is not available on this model"?
 *
 * Separate from {@link isUnsupportedParameterError} rather than folded into
 * it: the parameter itself is perfectly well known, it is the VALUE that this
 * model will not produce, and OpenAI words that rejection differently
 * ("is not compatible with", `invalid_value`). Folding the two would make the
 * probe's retry fire on transcription errors and this one fire on chat errors,
 * which is how one loosened predicate quietly changes two behaviours.
 *
 * Pure and exported so a test can state the real 400 verbatim.
 */
export function isUnsupportedResponseFormatError(err: unknown): boolean {
  if (isUnsupportedParameterError(err)) return true;

  const { text } = errorSignals(err);

  return (
    text.includes('response_format') &&
    (text.includes('not compatible') ||
      text.includes('not supported') ||
      text.includes('invalid_value') ||
      text.includes('invalid value'))
  );
}

/**
 * The 0..1 confidence for a verbose transcription, or `null` when there is no
 * basis for one.
 *
 * -----------------------------------------------------------------------------
 * THIS IS AN APPROXIMATION, AND SAYING SO IS THE POINT
 * -----------------------------------------------------------------------------
 *
 * OpenAI exposes no confidence field. What it exposes is `avg_logprob` per
 * segment — the mean log-probability of the tokens the model chose there — and
 * `Math.exp` of that is the corresponding probability. Averaging across
 * segments and exponentiating gives a number that ORDERS recordings sensibly
 * (a clear answer scores near 1, a mumbled or half-caught one visibly lower)
 * without being a calibrated probability that the transcript is correct. It is
 * the only signal there is, and it is good enough for the one decision this
 * application makes with it: was an answer wrong, or was it misheard?
 *
 * -----------------------------------------------------------------------------
 * NO SEGMENTS MEANS `null`, NEVER A GUESS
 * -----------------------------------------------------------------------------
 *
 * A model that ignored `verbose_json`, a response shape that changed, an empty
 * recording: all of them arrive here as "no segments", and all of them mean we
 * do not know. Substituting a plausible default — 1 for "probably fine", 0.5
 * for "no opinion" — would be indistinguishable at every call site from a
 * measured value, and the call site's whole job is to treat a low confidence
 * as evidence about the LEARNER. Pretending to a precision we do not have is
 * worse than admitting we have none.
 *
 * Clamped to [0, 1] because `Math.exp` of a positive logprob (which should not
 * happen, and does when a provider sends something unexpected) would otherwise
 * hand a caller a "confidence" above certainty.
 */
export function deriveConfidence(response: unknown): number | null {
  const segments = (response as { segments?: unknown })?.segments;

  if (!Array.isArray(segments) || segments.length === 0) return null;

  const logprobs = segments
    .map((segment) => (segment as { avg_logprob?: unknown })?.avg_logprob)
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value),
    );

  if (logprobs.length === 0) return null;

  const mean = logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length;

  return Math.min(1, Math.max(0, Math.exp(mean)));
}

/**
 * The transcript out of either response shape.
 *
 * `text` is the one field `json` and `verbose_json` share, and it is a string
 * in both. A missing or non-string one is `''` rather than `null`: this helper
 * is only reached on a SUCCESSFUL call, and `null` on that path would collide
 * with the meaning `AiTranscriptionResult.text` reserves for a failure.
 */
function readTranscriptText(response: unknown): string {
  const text = (response as { text?: unknown })?.text;

  return typeof text === 'string' ? text : '';
}

/** A successful transcription result, so the two call paths cannot disagree. */
function transcriptionResult(
  text: string,
  confidence: number | null,
): AiTranscriptionResult {
  return {
    success: true,
    text,
    confidence,
    // The transcription endpoints report no token counts. See
    // `EMPTY_SPEECH_USAGE` — null is the honest reading, not a failure.
    usage: EMPTY_SPEECH_USAGE,
    errorCode: null,
    error: null,
  };
}


/**
 * The model a minted realtime session reports, or `null` when it reports none.
 *
 * DEFENSIVE ON PURPOSE, like {@link readTranscriptText}: the response's
 * `session` is a union — a realtime session or a transcription session — and
 * only one arm of it carries a model at all. Reading it through a narrowing
 * cast would compile and then be `undefined` at runtime on the other arm,
 * which is exactly the class of failure this file's other readers exist to
 * avoid.
 */
export function readSessionModel(session: unknown): string | null {
  const model = (session as { model?: unknown })?.model;

  return typeof model === 'string' && model.length > 0 ? model : null;
}

/**
 * The provider's expiry timestamp as a `Date`, or `null` when it is unusable.
 *
 * SECONDS IN, MILLISECONDS OUT. The realtime API reports unix SECONDS, and
 * `new Date(seconds)` is a date in January 1970 that every comparison
 * downstream would read as "already expired" — a bug that presents as a
 * feature that never works rather than as an error.
 *
 * `null` for anything that is not a finite, positive number, including the
 * `0`/`undefined` a mock or a proxy may produce. The caller turns that into a
 * refusal rather than a session with an unknown deadline; see
 * {@link OpenAiProvider.runRealtimeSession} for why guessing is the worse
 * option.
 */
export function realtimeExpiry(secondsSinceEpoch: unknown): Date | null {
  return typeof secondsSinceEpoch === 'number' &&
    Number.isFinite(secondsSinceEpoch) &&
    secondsSinceEpoch > 0
    ? new Date(secondsSinceEpoch * 1000)
    : null;
}
