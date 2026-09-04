import { Injectable, Logger } from '@nestjs/common';

import type { SecretRedactor } from '../../common/crypto/secret-redactor';
import { BaseAiProvider } from '../base-ai.provider';
import type { AiCapabilityFamily } from '../ai-model-roles';
import type { AiProviderKind } from '../ai-settings.schema';
import { AiUsageService } from '../ai-usage.service';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiConnectionTestResult,
  AiModelCatalogResult,
  AiModelDescriptor,
  AiReachabilityRequest,
  AiStructuredCompletionRequest,
  AiSynthesisRequest,
  AiSynthesisResult,
  AiTranscriptionRequest,
  AiTranscriptionResult,
  AiUsage,
} from '../ai.types';
import type { AiCapabilitySet } from './ai-provider.interface';
import { classifyModel, parseGeneration } from './model-classifier';

// =============================================================================
// FakeAiProvider (issue #105, epic #53) — a real provider that never leaves the
// process
// =============================================================================
//
// Everything above a provider — the grading ladder, the tutor's stream, the
// admin settings page, `GET /api/ai-settings/models`, the usage table — needs
// to be exercised end to end without an OpenAI account, an API key, or a
// network. This class is that provider: it extends `BaseAiProvider` exactly as
// `OpenAiProvider` does, implements the same `protected` hooks — the five from
// #105 plus the two speech hooks E9 (#88) added — inherits the same
// never-throw wrappers and the same `SecretRedactor` path, and takes
// the same `AiUsageService` so `ai_usage_events` rows are written FOR REAL. A
// test that asserts a row was recorded is asserting about the same code that
// records one in production.
//
// -----------------------------------------------------------------------------
// IT REGISTERS AS `kind: 'openai'`. IT DOES NOT ADD A `'fake'` PROVIDER KIND.
// -----------------------------------------------------------------------------
//
// `AI_PROVIDER_KINDS` is not a list of implementation classes — it is
// `ai-settings.schema.ts`'s PERSISTED `provider` enum: the value an admin's
// settings row actually stores, the value `describeReadiness` reads to compute
// `providerConfigured`, and the value the admin page's dropdown offers. A
// `'fake'` member would be a value an administrator could select on a
// production deployment, a value every `Record<AiProviderKind, …>` in the
// settings and status paths would need a branch for, and — worst — a value
// that SURVIVES IN THE DATABASE after this class and its flag are deleted,
// leaving a row nothing can parse. See `ai-evaluation.md` §10 and §12; a test
// in `ai-settings.schema.spec.ts` holds the line.
//
// So a deployment running this class stores the real, valid `provider:
// 'openai'`, and the substitution happens where an implementation choice
// belongs: `AiModule`'s registration of the `OpenAiProvider` token. Nothing
// downstream — `AiDispatchService`, the settings row, the admin page, the seed
// — can tell which instance it got, and none of them has a branch to keep
// correct.
//
// -----------------------------------------------------------------------------
// IT IS INERT UNDER `NODE_ENV=production`, AND THE CHECK IS NOT HERE
// -----------------------------------------------------------------------------
//
// `AiModule` decides, once, at registration: non-production AND
// `AI_PROVIDER_FAKE=true`. That is deliberately NOT a runtime branch inside
// these methods — a provider that asked "am I allowed to be me?" on every call
// would be one forgotten check away from answering wrongly, and the answer
// cannot change between calls anyway. `TestEnvironmentGuard`'s runtime
// `nodeEnv` check exists because `POST /auth/test/login` is a ROUTE that is
// reachable in every environment; this class is reachable only if something
// constructed it.
//
// -----------------------------------------------------------------------------
// THE GRADING IS A FIXTURE. IT IS NOT AN ATTEMPT AT SEMANTICS.
// -----------------------------------------------------------------------------
//
// `runStructuredCompletion` reads the grading prompt `ai-evaluation.md` §7
// specifies and returns a real judgement — because a fake that always answered
// `correct` would make every grading-ladder test pass for the wrong reason,
// and one that answered randomly would make them flaky. The rules below (word
// overlap, an explicit paraphrase table, an explicit confusable-set table) are
// TEST FIXTURES STANDING IN FOR A MODEL'S JUDGEMENT. They are not a small
// semantic engine, they will not generalise to a question nobody wrote a table
// entry for, and no product decision should ever be made from them. What they
// buy is that the epic's end-to-end acceptance — "the President" answered as
// "the head of the executive branch" grades correct — is a fact about a
// deterministic function, checkable in CI, on every commit, with no key.
// =============================================================================

/**
 * The families this provider serves.
 *
 * THE SAME SIX `OpenAiProvider` DECLARES, so a deployment running the fake
 * behaves identically at every capability gate: the admin page offers the same
 * roles, `describeReadiness` computes the same answer, and
 * `AiDispatchService`'s `capability_unsupported` cause stays exactly as
 * unreachable as it is in production. A narrower set here would make the fake
 * a different deployment shape, and a test passing against it would prove
 * nothing about the real one.
 */
const FAKE_CAPABILITIES: AiCapabilitySet = new Set<AiCapabilityFamily>([
  'text',
  'realtime',
  'transcribe',
  'tts',
  'embedding',
  'other',
]);

/**
 * A fixed instant the catalog's `createdAt` values are derived from.
 *
 * A CONSTANT RATHER THAN `Date.now()`: `listModels` must return the same
 * catalog on every call forever, and a creation time that moved would make the
 * admin page's ordering — and any snapshot of it — depend on when the test
 * ran. 2026-01-01T00:00:00Z.
 */
const CATALOG_EPOCH_MS = Date.UTC(2026, 0, 1);

/** One day, for spacing the catalog's synthetic creation times. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The model ids this provider offers, NEWEST FIRST.
 *
 * Chosen so the whole admin surface works end to end against the fake:
 *
 *   * the first three clear `DEFAULT_MIN_MODEL_GENERATION` (5.4) and classify
 *     as `text`, so the `tutor` and `grader` dropdowns are populated WITHOUT
 *     an admin having to reach for the show-all escape hatch;
 *   * `o4-mini` is the reasoning line below the floor — it exercises the
 *     filter itself, which an all-passing catalog could not;
 *   * the last four give the four unwired roles a bindable model each, so a
 *     future issue wiring one does not start by editing this list.
 *
 * The families are NOT hardcoded here. They come from `classifyModel`, the
 * same function that sorts a real OpenAI catalog, so a classifier change is
 * reflected by the fake instead of silently disagreeing with it.
 */
const FAKE_MODEL_IDS: readonly string[] = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'o4-mini',
  'gpt-4o-realtime-preview',
  'gpt-4o-transcribe',
  'tts-1-hd',
  'text-embedding-3-large',
];

/**
 * Words carrying no meaning for the overlap test.
 *
 * SMALL AND EXPLICIT. A large stop-word list would start making judgement
 * calls of its own, which is the thing this file is careful not to pretend to
 * do; this one only removes the words that would otherwise let two unrelated
 * answers "overlap" on `the` and `of`.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'one',
  'or',
  'our',
  'that',
  'the',
  'they',
  'think',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
]);

/**
 * Accepted answer -> phrasings a model would credit as meaning it.
 *
 * A HAND-WRITTEN FIXTURE, NOT A THESAURUS. Keys are normalised accepted-answer
 * text; values are normalised phrases that, appearing in a learner's response,
 * mean the same thing for grading purposes. The first entry is the epic's own
 * end-to-end acceptance criterion — accepted answer "the President", learner
 * response "the head of the executive branch" — and every other entry is here
 * for the same reason: some test somewhere needs that specific paraphrase to
 * grade `correct`.
 *
 * This table is what a model's judgement is being STOOD IN FOR, not
 * approximated. A response whose paraphrase nobody wrote down grades
 * `incorrect`, which is the honest behaviour for a lookup table and is why no
 * product decision may be made from this class.
 */
const PARAPHRASES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'president',
    [
      'head of the executive branch',
      'leader of the executive branch',
      'head of the executive',
      'the person who runs the executive branch',
    ],
  ],
  [
    'congress',
    [
      'the one that makes the laws',
      'makes the laws',
      'the law making body',
      'the legislature',
    ],
  ],
  ['legislative', ['makes the laws', 'the law making branch']],
  ['judicial', ['the branch that judges the laws', 'the court system']],
  ['the courts', ['the court system', 'the judges']],
  ['executive', ['the branch the president runs', 'carries out the laws']],
]);

/**
 * Sets of answers a learner plausibly confuses with one another.
 *
 * ALSO A HAND-WRITTEN FIXTURE, and the one that makes `not_recalled`
 * reachable. A response naming a member of a set that ALSO contains one of
 * this question's accepted answers — but is not itself accepted — is the
 * taxonomy's `not_recalled` signal exactly as `ai-evaluation.md` §8 defines
 * it: "a well-formed, real member of the same small confusable category".
 *
 * Without a table like this, a fake has no way to tell "named the wrong branch
 * of government" from "said something unrelated", and every miss would collapse
 * into `not_known` — leaving the two most interesting failure causes untestable
 * for whoever writes the grading ladder.
 */
const CONFUSABLE_SETS: readonly (readonly string[])[] = [
  // The branches of government, and the words for them.
  [
    'congress',
    'legislative',
    'president',
    'executive',
    'the courts',
    'judicial',
    'supreme court',
  ],
  // Officeholders — the classic `not_recalled` case: a real president, just
  // not the current one.
  [
    'donald trump',
    'joe biden',
    'barack obama',
    'george washington',
    'abraham lincoln',
    'thomas jefferson',
  ],
  // Documents a learner mixes up when asked for one of them.
  [
    'the constitution',
    'the declaration of independence',
    'the bill of rights',
    'the articles of confederation',
  ],
];

/**
 * The feedback sentence for each judgement.
 *
 * ONE WARM SENTENCE, DETERMINISTIC PER OUTCOME. Keyed by the pair the schema
 * carries, so the same input yields the same feedback on every call — a fake
 * whose prose varied would make a snapshot or an equality assertion flaky for
 * no reason, and `feedback` is a field the grading ladder persists.
 *
 * All are comfortably under the schema's 240-character cap.
 */
const FEEDBACK: Readonly<Record<string, string>> = {
  'correct:unknown': 'That is exactly right — nicely done.',
  'correct:expression':
    'Yes, that is the right idea — your meaning came through clearly.',
  'incorrect:not_recalled':
    'That is the right kind of answer, but not the one this question is asking for. You are close.',
  'incorrect:not_known':
    'Not quite — this one is worth another look, and you can come straight back to it.',
  'incorrect:unknown':
    'I could not quite tell from that answer — try saying it once more in your own words.',
};

/** The judgement `runStructuredCompletion` produces for the `grader` role. */
interface FakeJudgement {
  verdict: 'correct' | 'partial' | 'incorrect';
  failureCause:
    | 'not_known'
    | 'not_recalled'
    | 'expression'
    | 'misheard'
    | 'nervous'
    | 'unknown';
  feedback: string;
}

/**
 * The role whose structured replies are graded rather than synthesised.
 */
const GRADER_ROLE_KEY = 'grader';

// -----------------------------------------------------------------------------
// THE AUDIO MARKER CONVENTION (issue #88, epic #58) — READ THIS BEFORE WRITING
// A VOICE TEST
// -----------------------------------------------------------------------------
//
// This provider has no recogniser, so a transcription has to come from
// somewhere, and the only thing a caller can vary is THE BYTES IT UPLOADS. So
// the "recording" is read as UTF-8 and searched for two markers. A test — or
// the #114 e2e spec, which drives this from a real HTTP request — builds an
// audio buffer out of ASCII and gets a transcript and a confidence it chose:
//
//   Buffer.from('TRANSCRIPT:the president')  -> text 'the president',   0.97
//   Buffer.from('LOWCONF')                   -> the misheard fixture,   0.41
//   Buffer.from('TRANSCRIPT:x LOWCONF')      -> text 'x',               0.41
//   anything else (real audio bytes included) -> DEFAULT_TRANSCRIPT,    0.97
//
// WHY MARKERS RATHER THAN A SETTER OR AN ENV VAR: the caller under test is
// usually several layers away — an HTTP request, a controller, a dispatcher —
// and reaching past all of them to poke this instance would test a wiring that
// production does not have. The bytes, by contrast, travel the ENTIRE real
// path: multipart parsing, the size limit, the buffer handed to the provider.
// A test that steers the transcript this way has proved that path works.
//
// THE LOW-CONFIDENCE PATH IS NOT AN AFTERTHOUGHT. "Was that answer wrong, or
// did we mishear it?" is the whole reason `AiTranscriptionResult.confidence`
// exists, and a fake that only ever returned a confident transcript would make
// the misheard branch untestable without a network — which is to say,
// untested.

/** The marker that forces the low-confidence, plausibly-misheard fixture. */
const LOW_CONFIDENCE_MARKER = 'LOWCONF';

/** The marker that dictates the transcript: `TRANSCRIPT:<text>` to end of line. */
const TRANSCRIPT_MARKER = /TRANSCRIPT:([^\r\n]*)/;

/**
 * The confidence a clear recording gets.
 *
 * NOT 1. A recogniser is never certain, and a fixture that said so would let a
 * caller written against `=== 1` pass here and fail on every real call.
 */
const CONFIDENT_SCORE = 0.97;

/**
 * The confidence the `LOWCONF` marker produces.
 *
 * Comfortably below any plausible "this was heard well" threshold, and
 * comfortably above 0 — because 0 is reserved for nothing at all, and this
 * fixture is a recording that WAS heard, just badly.
 */
const LOW_CONFIDENCE_SCORE = 0.41;

/**
 * What a marker-free recording transcribes to.
 *
 * A real civics answer rather than "hello world", so a test that feeds the
 * transcript onward into the grading ladder gets a gradeable string instead of
 * an automatic miss for a reason that has nothing to do with what it is
 * testing.
 */
const DEFAULT_TRANSCRIPT = 'the president';

/**
 * The transcript the `LOWCONF` marker produces when no `TRANSCRIPT:` is given.
 *
 * DELIBERATELY A NEAR-MISS OF `DEFAULT_TRANSCRIPT`'s meaning — the shape of a
 * real mishearing, close enough to be plausibly what the learner said and
 * wrong enough that a grader would mark it. That is exactly the situation the
 * confidence signal exists to disambiguate.
 */
const MISHEARD_TRANSCRIPT = 'the head of the executive ranch';

/**
 * The bytes {@link FakeAiProvider.runSynthesis} returns.
 *
 * A REAL MP3 FRAME HEADER (`0xFF 0xFB`) followed by filler, not random bytes:
 * a consumer that sniffs the container gets something coherent, and a test
 * asserting on a byte length gets a stable one. Deterministic and tiny — this
 * is a fixture, not an encoder.
 */
const FAKE_SPEECH_BYTES: readonly number[] = [
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

@Injectable()
export class FakeAiProvider extends BaseAiProvider {
  protected readonly logger = new Logger(FakeAiProvider.name);

  /**
   * `'openai'`, and this is the load-bearing line of the file.
   *
   * See the header: this class registers AS the OpenAI kind, in place of
   * `OpenAiProvider`, so that no persisted value, no settings dropdown and no
   * `switch` anywhere learns that a fake exists.
   */
  readonly kind: AiProviderKind = 'openai';

  readonly capabilities = FAKE_CAPABILITIES;

  /**
   * Shown to a human, in log lines and error prefixes.
   *
   * DELIBERATELY SAYS "Fake". `providerName` is not the persisted kind — it is
   * the label on an admin page's error message — and an operator staring at a
   * failing connection test should be told immediately that nothing is
   * reaching OpenAI.
   */
  protected readonly providerName = 'Fake AI';

  constructor(
    // Exposed to the base class through this field exactly as `OpenAiProvider`
    // does, so the never-throw recording wrapper — and therefore the
    // `ai_usage_events` write — is the same code on both providers.
    protected readonly usage: AiUsageService,
  ) {
    super();
  }

  /**
   * Drop the cached catalog.
   *
   * A NO-OP WITH A REASON TO EXIST: `AiModule` wires the settings service's
   * change notification to this method on whichever provider is registered
   * under the `OpenAiProvider` token, and this class's catalog is a constant
   * with nothing to invalidate. Present so the substitution needs no branch in
   * the module's constructor.
   */
  invalidateCatalogCache(): void {
    // Nothing to drop — see the doc comment.
  }

  // ---------------------------------------------------------------------------
  // BaseAiProvider hooks — may throw freely
  // ---------------------------------------------------------------------------

  /**
   * The catalog. Always available, and never a credential read.
   *
   * NO SERVER KEY IS CONSULTED, unlike `OpenAiProvider.fetchModels`. That is
   * the point of the fake on this path: a developer with no OpenAI account
   * must be able to open `/admin/settings/ai`, see a populated dropdown, and
   * bind a model. Returning `null` ("no credential stored") whenever the
   * developer had not pasted a key would leave exactly the screen they need in
   * the state the fake exists to avoid.
   *
   * @param redact unused HERE and only here, because this is the one hook that
   *        obtains no secret to register with it: the real provider's
   *        `fetchModels` reads the server key at this point and this one reads
   *        nothing. Every other hook below registers the key it was handed, on
   *        its first line, exactly as `OpenAiProvider` does.
   */
  protected async fetchModels(
    redact: SecretRedactor,
  ): Promise<AiModelCatalogResult | null> {
    void redact;

    return {
      success: true,
      models: FAKE_MODEL_IDS.map((id, index) => describeFakeModel(id, index)),
      error: null,
      notConfigured: false,
    };
  }

  /**
   * Authenticate a key and report every probe reachable.
   *
   * AN EMPTY KEY FAILS, AND THAT IS THE WHOLE BEHAVIOUR OF THIS METHOD. A fake
   * that accepted anything would make the "no key" path — the one path a
   * keyless user actually hits, and the one `RequireAiKey` and
   * `AiDispatchService`'s `no_user_key` cause both exist for — impossible to
   * test on a fake deployment. Any non-empty string is accepted, because this
   * class has nothing to authenticate against and pretending otherwise would
   * mean inventing a key format for tests to satisfy.
   */
  protected async probeConnection(
    apiKey: string,
    probes: AiReachabilityRequest[],
    redact: SecretRedactor,
  ): Promise<AiConnectionTestResult> {
    redact.protect(apiKey);

    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return {
        success: false,
        authenticated: false,
        roles: [],
        error: 'No API key was supplied.',
      };
    }

    return {
      success: true,
      authenticated: true,
      roles: probes.map((probe) => ({
        roleKey: probe.roleKey,
        modelId: probe.modelId,
        reachable: true,
        error: null,
      })),
      error: null,
    };
  }

  /**
   * One completion, derived from the request and nothing else.
   *
   * DETERMINISTIC BY CONSTRUCTION — no clock, no randomness, no counter. Two
   * identical requests produce byte-identical text and byte-identical token
   * counts, so a test can assert on the answer rather than on its shape.
   *
   * `request.stream` is not branched on. `OpenAiProvider` has two code paths
   * there because the WIRE FORMAT differs; this class has no wire, and the
   * streaming path a consumer actually cares about is {@link openStream},
   * which the base class calls for `stream()`.
   */
  protected async runCompletion(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
  ): Promise<AiCompletionResult> {
    redact.protect(apiKey);

    const text = explanationFor(request);

    return {
      success: true,
      text,
      usage: usageFor(request, text),
      errorCode: null,
      error: null,
    };
  }

  /**
   * One schema-constrained completion.
   *
   * TWO PATHS, AND THE SPLIT IS ON THE ROLE. The `grader` gets a real
   * judgement read out of the grading prompt (see {@link gradeFromPrompt});
   * every other role gets a value SYNTHESISED FROM THE JSON SCHEMA the base
   * class already built, so a future structured caller works against the fake
   * on the day it is written rather than on the day someone extends this file.
   *
   * RETURNS RAW TEXT, exactly as `OpenAiProvider` does. The base class parses
   * and validates it against the caller's zod schema — including everything
   * this method produced — so a bug here surfaces as an ordinary
   * `schema_validation_failed` result rather than as a value that skipped the
   * check every real reply goes through.
   */
  protected async runStructuredCompletion(
    apiKey: string,
    request: AiStructuredCompletionRequest<unknown>,
    jsonSchema: Record<string, unknown>,
    redact: SecretRedactor,
  ): Promise<{ raw: string | null; usage: AiUsage }> {
    redact.protect(apiKey);

    const value =
      request.roleKey === GRADER_ROLE_KEY
        ? gradeFromPrompt(request)
        : synthesiseFromSchema(jsonSchema);

    const raw = JSON.stringify(value);

    return { raw, usage: usageFor(request, raw) };
  }

  /**
   * The same explanation {@link runCompletion} produces, one word at a time,
   * then a usage-only chunk.
   *
   * -------------------------------------------------------------------------
   * SEVERAL DELTAS, NOT ONE
   * -------------------------------------------------------------------------
   *
   * A fake that yielded the whole answer as a single chunk would let a broken
   * SSE consumer — one that overwrites instead of appending, or that renders
   * only the last event — pass every test and fail on the first real stream.
   * Splitting on word boundaries makes "incremental" an observable property of
   * the fake rather than an assumption about the provider.
   *
   * -------------------------------------------------------------------------
   * THE USAGE CHUNK IS LAST, AND SEPARATE
   * -------------------------------------------------------------------------
   *
   * This mirrors what OpenAI does when — and only when — a request sets
   * `stream_options: { include_usage: true }` (`ai-evaluation.md` §9): usage
   * arrives after the final content chunk, in a chunk of its own. Emitting it
   * this way is what exercises `BaseAiProvider.stream`'s "assign usage only
   * from a usage-bearing chunk" rule, which is the rule that keeps a streamed
   * call from recording all-null tokens without anything failing.
   *
   * -------------------------------------------------------------------------
   * `signal` IS HONOURED BETWEEN CHUNKS
   * -------------------------------------------------------------------------
   *
   * A real provider's abort reaches the socket; this one has no socket, so the
   * equivalent is to stop producing and THROW — which is what the SDK does on
   * an aborted request, and what `BaseAiProvider.stream` turns into the single
   * terminal `error` event. Returning quietly instead would emit a `done` for
   * a completion that never completed, and a consumer would render a truncated
   * answer as a whole one.
   */
  protected async *openStream(
    apiKey: string,
    request: AiCompletionRequest,
    redact: SecretRedactor,
    signal?: AbortSignal,
  ): AsyncGenerator<{ delta?: string; usage?: AiUsage }, void, undefined> {
    redact.protect(apiKey);

    const text = explanationFor(request);
    // Split so each chunk keeps its trailing space: a consumer that
    // concatenates the deltas gets the exact string `runCompletion` returns,
    // which is what makes the two paths comparable in a test.
    const chunks = text.match(/\S+\s*/g) ?? [text];

    let emitted = '';

    for (const chunk of chunks) {
      if (signal?.aborted === true) {
        // Named `AbortError` because that is what a caller inspecting a thrown
        // value looks for. The base class does not care — it classifies and
        // yields a terminal `error` event — but a future consumer might.
        const aborted = new Error('The stream was aborted by the caller.');
        aborted.name = 'AbortError';
        throw aborted;
      }

      emitted += chunk;
      yield { delta: chunk };
    }

    // USAGE OVER WHAT WAS ACTUALLY EMITTED, not over the full text: they are
    // the same on a complete stream and different on one that stopped early,
    // and the honest number is the one describing what was produced.
    yield { usage: usageFor(request, emitted) };
  }

  /**
   * A transcript read out of the uploaded bytes themselves.
   *
   * NO NETWORK, NO CLOCK, NO RANDOMNESS — the same recording always
   * transcribes to the same text with the same confidence, exactly as
   * {@link runCompletion} always returns the same explanation. The steering
   * markers, and why they are markers rather than a setter, are documented at
   * {@link LOW_CONFIDENCE_MARKER} above; read that before writing a voice test.
   *
   * USAGE IS ALL-NULL, matching `OpenAiProvider.runTranscription`: the real
   * speech endpoints report no token counts, and a fake that invented some
   * would let a caller be written against numbers production never sends. This
   * is the one place the fake deliberately does NOT report plausible counts —
   * see `usageFor`, whose reason for reporting them does not apply to a
   * surface the provider itself leaves blank.
   */
  protected async runTranscription(
    apiKey: string,
    request: AiTranscriptionRequest,
    redact: SecretRedactor,
  ): Promise<AiTranscriptionResult> {
    redact.protect(apiKey);

    // `latin1`, not `utf8`: real audio bytes are not valid UTF-8 and decoding
    // them as such produces replacement characters, which could in principle
    // eat a marker sitting next to one. Every byte maps to a character here,
    // so an ASCII marker survives being embedded in anything.
    const probe = request.audio?.toString('latin1') ?? '';

    const dictated = TRANSCRIPT_MARKER.exec(probe)?.[1]?.trim();
    const lowConfidence = probe.includes(LOW_CONFIDENCE_MARKER);

    const text =
      dictated !== undefined && dictated.length > 0
        ? dictated
        : lowConfidence
          ? MISHEARD_TRANSCRIPT
          : DEFAULT_TRANSCRIPT;

    return {
      success: true,
      text,
      confidence: lowConfidence ? LOW_CONFIDENCE_SCORE : CONFIDENT_SCORE,
      usage: SPEECH_USAGE,
      errorCode: null,
      error: null,
    };
  }

  /**
   * A small, constant audio payload.
   *
   * The bytes do not depend on the text: a fake encoder that varied its output
   * would invite a test to assert on something it cannot predict, and the
   * property worth exercising here is the PATH — a buffer and a content type
   * reaching a caller that has to stream them — not the encoding.
   */
  protected async runSynthesis(
    apiKey: string,
    request: AiSynthesisRequest,
    redact: SecretRedactor,
  ): Promise<AiSynthesisResult> {
    redact.protect(apiKey);
    void request;

    return {
      success: true,
      audio: Buffer.from(FAKE_SPEECH_BYTES),
      // `audio/mpeg`, matching what `OpenAiProvider` returns for the default
      // `mp3` container — never `audio/mp3`, which a browser may refuse to
      // play with no visible error.
      contentType: 'audio/mpeg',
      usage: SPEECH_USAGE,
      errorCode: null,
      error: null,
    };
  }
}

// -----------------------------------------------------------------------------
// Deterministic content
// -----------------------------------------------------------------------------

/**
 * One catalog entry, classified by the SAME functions a real catalog is.
 *
 * `createdAt` is derived from the id's position so the ordering is stable and
 * the newest id is the newest model — see {@link CATALOG_EPOCH_MS}.
 */
function describeFakeModel(id: string, index: number): AiModelDescriptor {
  return {
    id,
    family: classifyModel(id),
    generation: parseGeneration(id),
    createdAt: new Date(CATALOG_EPOCH_MS - index * ONE_DAY_MS),
  };
}

/**
 * The text every non-structured call returns.
 *
 * DERIVED FROM THE REQUEST, so a test can tell two different prompts apart,
 * and PURE, so it returns the same thing every time. The topic is taken from
 * the last user turn because that is the turn a caller varies; a request with
 * no user turn still gets a well-formed answer rather than an empty one, which
 * would trip `AiDispatchService`'s `empty_completion` failure and hide
 * whatever the test was actually about.
 */
function explanationFor(request: AiCompletionRequest): string {
  const lastUserTurn = [...(request.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');

  const topic = contentWords(normalise(lastUserTurn?.content ?? ''))
    .slice(0, 6)
    .join(' ');

  const subject = topic.length > 0 ? topic : 'this question';

  return `Here is a short practice explanation about ${subject}. This answer comes from the fake AI provider, so it is the same every time and no request left this process.`;
}

/**
 * Token counts for one call: plausible, deterministic, and never null.
 *
 * FOUR CHARACTERS PER TOKEN is the rough English rule of thumb, and it is
 * enough — the number has to be stable and roughly proportional to the work,
 * not accurate. NEVER NULL ON SUCCESS, because the whole `ai_usage_events`
 * path (`GET /api/ai/usage`, its totals, its null-not-zero contract) is only
 * exercised end to end if a successful fake call reports real counts.
 */
function usageFor(request: AiCompletionRequest, completion: string): AiUsage {
  const promptChars = (request.messages ?? []).reduce(
    (total, message) => total + (message.content?.length ?? 0),
    0,
  );

  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(completion.length);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/**
 * Usage for a speech call: all null.
 *
 * DELIBERATELY UNLIKE {@link usageFor}. That helper reports plausible counts
 * because the `ai_usage_events` path is only exercised end to end if a
 * successful fake call reports some; the speech endpoints report NONE, on
 * either provider, so inventing counts here would fake a field production
 * always leaves blank and let a caller be written against it.
 */
const SPEECH_USAGE: AiUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

/** Characters to tokens, with a floor of 1 for anything non-empty. */
function estimateTokens(characters: number): number {
  if (characters <= 0) return 0;

  return Math.max(1, Math.ceil(characters / 4));
}

// -----------------------------------------------------------------------------
// Grading — a fixture standing in for a model's judgement. See the header.
// -----------------------------------------------------------------------------

/**
 * Read the §7 grading prompt and return a judgement.
 *
 * PARSES THE PROMPT `ai-evaluation.md` §7 SPECIFIES, and only that one: the
 * `Accepted answers (any one is sufficient):` bullet list, and the learner's
 * text inside the `<learner_response>` delimiters. Inventing a second format
 * for the fake to read would mean the grading ladder's prompt could drift away
 * from what any test exercises, and the drift would show up as a fake that
 * grades everything the same way rather than as a failure.
 *
 * A prompt this parser cannot read grades `incorrect` with `unknown` rather
 * than `correct`: a grader that cannot see the accepted answers has no basis
 * to award credit, and defaulting the other way would turn a broken prompt
 * into a suite of passing tests.
 */
function gradeFromPrompt(
  request: AiStructuredCompletionRequest<unknown>,
): FakeJudgement {
  // Joined across turns because §7 splits the material between the system
  // message (the rules) and the user message (the data), and the delimiters
  // are unambiguous either way.
  const prompt = (request.messages ?? [])
    .map((message) => message.content ?? '')
    .join('\n');

  const accepted = parseAcceptedAnswers(prompt);
  const response = parseLearnerResponse(prompt);

  if (accepted.length === 0 || response === null || response.length === 0) {
    return judgement('incorrect', 'unknown');
  }

  return judge(accepted, response);
}

/**
 * The accepted answers, verbatim from the prompt's bullet list.
 *
 * Anchored on the heading rather than on "any line starting with a dash", so a
 * hyphen inside the learner's own response cannot be read as an accepted
 * answer — which would let a learner supply their own correct answer, the
 * exact injection §7's delimiters exist to prevent.
 */
function parseAcceptedAnswers(prompt: string): string[] {
  const lines = prompt.split('\n');
  const heading = lines.findIndex((line) => /^\s*Accepted answers\b.*:\s*$/i.test(line));

  if (heading === -1) return [];

  const answers: string[] = [];

  for (const line of lines.slice(heading + 1)) {
    const bullet = /^\s*-\s+(.*\S)\s*$/.exec(line);

    // The list ends at the first line that is not a bullet — a blank line, or
    // the `<learner_response>` block that follows it.
    if (!bullet) {
      if (line.trim().length === 0) continue;
      break;
    }

    answers.push(bullet[1]);
  }

  return answers;
}

/** The learner's text, from between the §7 delimiters. `null` when absent. */
function parseLearnerResponse(prompt: string): string | null {
  const match = /<learner_response>([\s\S]*?)<\/learner_response>/i.exec(prompt);

  return match ? match[1].trim() : null;
}

/**
 * The judgement itself, from the fixture tables and a word-overlap test.
 *
 * THE ORDER OF THESE CHECKS IS THE RULE SET, and it runs from the most
 * defensible signal to the least:
 *
 *   1. the response CONTAINS an accepted answer verbatim — the only case where
 *      no judgement is really being made at all;
 *   2. it contains every meaningful word of an accepted answer, in some other
 *      arrangement — `expression`, the cause this product exists for;
 *   3. it matches a written-down paraphrase of an accepted answer —
 *      `expression` again, and the case the epic's acceptance criterion names;
 *   4. it names a different member of a confusable set — `not_recalled`;
 *   5. anything else — `not_known`.
 *
 * `partial`, `misheard` and `nervous` are NEVER PRODUCED. The last two are
 * declared for E8/E9 and require signals (interview timing, transcription
 * confidence) that do not exist yet, and `ai-evaluation.md` §8 is explicit
 * that producing them from text alone is the "manufactured diagnosis" failure
 * the taxonomy's honest `unknown` exists to prevent. A fixture that emitted
 * them would be manufacturing exactly that, in the one place nobody would
 * think to look for it.
 */
function judge(accepted: string[], response: string): FakeJudgement {
  const responseText = normalise(response);
  const responseWords = new Set(contentWords(responseText));

  for (const answer of accepted) {
    const answerText = normalise(answer);
    if (answerText.length === 0) continue;

    // 1 & 2 — the response carries the accepted answer's own words.
    const verbatim = containsPhrase(responseText, answerText);
    const answerWords = contentWords(answerText);
    const meaningful = answerWords.filter((word) => word.length > 3);
    const allMeaningfulPresent =
      meaningful.length > 0 &&
      meaningful.every((word) => responseWords.has(word));

    if (verbatim || allMeaningfulPresent) {
      // EXTRA WORDS MEAN THE MATCH WAS NOT THE WHOLE ANSWER — a hedge, a
      // restatement, broken English around the right words. §7's own worked
      // example ("the one that makes the laws, congress i think") is this
      // case, and the epic's acceptance list asks for `expression` on it.
      //
      // Nothing downstream is misled by the choice either way: `ai-evaluation
      // .md` §6 persists `failure_cause` only when the verdict is NOT
      // `correct`, so this value is read by tests and by nothing else.
      const clean =
        verbatim && responseWords.size <= new Set(answerWords).size;

      return judgement('correct', clean ? 'unknown' : 'expression');
    }

    // 3 — a written-down paraphrase.
    //
    // Looked up under BOTH the whole normalised answer and its content words
    // alone, so one table entry serves "President", "the President" and "the
    // president" — three spellings of one accepted answer that a question bank
    // genuinely contains, and three table entries nobody would keep in step.
    const paraphrases =
      PARAPHRASES.get(answerText) ??
      PARAPHRASES.get(answerWords.join(' ')) ??
      [];
    if (paraphrases.some((phrase) => containsPhrase(responseText, phrase))) {
      return judgement('correct', 'expression');
    }
  }

  // 4 — a real member of a set one of the accepted answers also belongs to.
  if (namesAConfusableSibling(accepted.map(normalise), responseText)) {
    return judgement('incorrect', 'not_recalled');
  }

  // 5 — nothing recognisable.
  return judgement('incorrect', 'not_known');
}

/**
 * Does the response name a sibling of an accepted answer?
 *
 * Sibling = a member of a {@link CONFUSABLE_SETS} entry that also contains one
 * of this question's accepted answers, and that is not itself accepted. The
 * longest match wins so `supreme court` is not read as `the courts`' sibling
 * by way of a shorter overlap.
 */
function namesAConfusableSibling(
  acceptedTexts: string[],
  responseText: string,
): boolean {
  const accepted = new Set(acceptedTexts);

  for (const set of CONFUSABLE_SETS) {
    const overlapsThisQuestion = set.some((member) => accepted.has(member));
    if (!overlapsThisQuestion) continue;

    const named = [...set]
      .sort((a, b) => b.length - a.length)
      .find((member) => containsPhrase(responseText, member));

    if (named !== undefined && !accepted.has(named)) return true;
  }

  return false;
}

/** One judgement, with the feedback sentence its outcome always carries. */
function judgement(
  verdict: FakeJudgement['verdict'],
  failureCause: FakeJudgement['failureCause'],
): FakeJudgement {
  return {
    verdict,
    failureCause,
    feedback:
      FEEDBACK[`${verdict}:${failureCause}`] ??
      'Thanks — that one has been recorded.',
  };
}

/**
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * Punctuation becomes a SPACE rather than nothing, so `laws,congress` does not
 * become the single word `lawscongress` and stop matching anything.
 */
function normalise(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of an already-normalised string that carry meaning. */
function contentWords(normalised: string): string[] {
  return normalised
    .split(' ')
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/**
 * Does `haystack` contain `needle` as a WHOLE-WORD phrase?
 *
 * Padded with spaces rather than a bare `includes`, so `congress` does not
 * match inside `congressional district` — a different answer to a different
 * question. Both arguments are expected to be normalised already.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;

  return ` ${haystack} `.includes(` ${needle} `);
}

// -----------------------------------------------------------------------------
// Structured replies for every role that is not the grader
// -----------------------------------------------------------------------------

/**
 * Build the smallest value satisfying `schema`.
 *
 * WHY THIS EXISTS AT ALL: `completeStructured` is a general surface, and the
 * grader is only its first caller. A fake that answered nothing but the
 * grading schema would force the NEXT structured feature to edit this file
 * before it could have a single test — which is the friction issue #105 exists
 * to remove.
 *
 * DELIBERATELY MINIMAL. It understands the shapes `z.toJSONSchema(...,
 * { target: 'draft-7' })` emits for ordinary object schemas — objects,
 * enums, strings, numbers, booleans, arrays, `null` — and nothing more. An
 * unsupported shape produces a value the caller's own zod schema will reject,
 * which surfaces as an ordinary `schema_validation_failed` result: visible,
 * named, and pointing at the right file. Guessing harder would produce
 * something that validates and means nothing.
 */
function synthesiseFromSchema(schema: Record<string, unknown>): unknown {
  const enumValues = schema.enum;
  // First member, not a random one: determinism is the property this whole
  // file is built around.
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];

  // `const` is a legitimate JSON-Schema value of `null` or `false`, so
  // membership is the test rather than truthiness.
  if ('const' in schema) return schema.const;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;

      return Object.fromEntries(
        Object.entries(properties).map(([name, property]) => [
          name,
          synthesiseFromSchema(property),
        ]),
      );
    }
    case 'array':
      // EMPTY, not a one-element sample. An array schema with a `minItems` of
      // zero is satisfied, and inventing a member would mean synthesising a
      // value for a shape the caller never described.
      return [];
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'string':
    default:
      return 'fake';
  }
}
