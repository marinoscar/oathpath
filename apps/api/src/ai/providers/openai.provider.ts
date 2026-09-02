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
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiConnectionTestResult,
  AiMessage,
  AiModelCatalogResult,
  AiModelDescriptor,
  AiReachabilityRequest,
  AiReachabilityResult,
  AiUsage,
} from '../ai.types';
import type { AiCapabilitySet } from './ai-provider.interface';
import { classifyModel, parseGeneration } from './model-classifier';
import { describeModelTraits } from './model-traits';

// =============================================================================
// OpenAiProvider (issue #29, epic #25)
// =============================================================================
//
// The one concrete provider. It does exactly two things, and deliberately no
// third: it fetches and classifies the model catalog on the SERVER key, and it
// proves a given key can reach the models the app is bound to.
//
// IT RUNS NO INFERENCE. Epic #25, decision 4: every inference call runs on the
// CALLING USER's own key, so a provider method that quietly used the server
// key for real work would defeat the entire reason BYOK was chosen — each user
// seeing and paying for their own consumption.
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
        // have. These roles are unwired today (#27), so nothing depends on the
        // stronger guarantee yet.
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
