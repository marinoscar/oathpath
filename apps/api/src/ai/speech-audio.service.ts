import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CivicsService } from '../civics/civics.service';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { AiDispatchService } from './ai-dispatch.service';
import { AiSettingsService } from './ai-settings.service';
import { DEFAULT_SPEECH_FORMAT, speechContentType } from './speech-format';
import {
  MAX_SYNTHESIS_TEXT_LENGTH,
  type AiSpeechAudioQueryInput,
  type AiSpeechFailedResponse,
  type AiSpeechStateRequiredResponse,
  type AiSpeechUnavailableResponse,
  type SpeechAudioScope,
} from './dto/ai-speech.dto';

// =============================================================================
// SpeechAudioService — the shared, content-addressed civics clip (#284, epic #280)
// =============================================================================
//
// `POST /api/ai/speech/synthesize` reads whatever text a client sends, on that
// client's own key, every single time. For civics content that is pure,
// recurring waste: a question's prompt is the same string for every learner on
// the deployment and for every replay by the same learner, TTS is billed per
// CHARACTER, and the hundredth learner to press play on question 1 pays again
// for bytes that are identical to the first ninety-nine. This service is the
// cache in front of that, for civics content only.
//
// -----------------------------------------------------------------------------
// THE TEXT IS RESOLVED FROM THE DATABASE. IT IS NEVER AN INPUT.
// -----------------------------------------------------------------------------
//
// The request names a SCOPE and a `civics_questions.id`; the words come from
// `CivicsService.getQuestion` — the same method `GET /api/civics/questions/{id}`
// serves, including its answer resolution against the caller's own state and
// the clock. Nothing here re-implements that resolution and nothing here trusts
// a caller for a syllable of what gets spoken.
//
// Two rules make that non-negotiable rather than tidy. `CLAUDE.md`'s grounding
// rule ("build the prompt from rows your feature already reads... never from
// what the model might recall") applies to synthesis exactly as it does to a
// grader's prompt: the audio must say what the database says. And the cache is
// SHARED — a client that could name its own text would be filling a permanently
// retained, cross-learner object store with strings of its choosing, addressed
// by a hash it also chose.
//
// -----------------------------------------------------------------------------
// WHY THE HASH IS IN THE KEY (AND WHY THERE IS NO INVALIDATION CODE HERE)
// -----------------------------------------------------------------------------
//
// A dynamic civics answer changes when an admin corrects it
// (`PUT /api/civics/dynamic-answers`, `docs/specs/civics-content.md` §9). The
// lookup key includes `sha256(text)`, so a corrected answer resolves to a
// DIFFERENT row: the read for the new text is unconditionally a miss, and the
// row for the old text simply stops being addressed by anything. There is no
// expiry job, no version counter and no purge to remember, because serving a
// learner a superseded answer is not a bug to be prevented — it is unreachable.
// See `schema.prisma`'s own header on `speech_audio_assets`.
//
// -----------------------------------------------------------------------------
// THE BYTES LIVE BEHIND THE `StorageProvider` PORT, WITH NO `storage_objects` ROW
// -----------------------------------------------------------------------------
//
// The storage module's object service enforces owner-only reads with no admin
// bypass (`apps/api/src/storage/objects/objects.service.ts`), which is exactly
// right for a learner's own upload and exactly wrong for a shared civics clip:
// every learner but the one who happened to generate it would be refused their
// own question's audio. `CLAUDE.md` warns by name against widening that shared
// ownership helper to accommodate a second rule — doing so "would make it a
// read and write bypass in the same edit" — so this cache does what that
// warning points at instead: a genuinely different access rule gets a genuinely
// different code path. It injects the storage PORT directly, which is the plain
// object-storage primitive with none of the ownership logic in between.
//
// No `storage_objects` row is created, read, or referenced from here.
//
// -----------------------------------------------------------------------------
// WHO PAYS
// -----------------------------------------------------------------------------
//
// The first learner to ask for a given clip triggers one synthesis call on
// THEIR OWN key — never the server credential at `('ai', 'openai')`, whose
// use for inference `CLAUDE.md` and `docs/specs/voice.md` §6 both forbid,
// because from that call onward every per-user usage figure is silently wrong.
// Every learner after them reads the cached bytes at no cost to anyone. That
// asymmetry is deliberate and accepted (`docs/specs/voice-hands-free.md` §4);
// `generatedByUserId` records who it was, so it is attributed rather than
// anonymous.
// =============================================================================

/**
 * The model role this route runs on.
 *
 * A CONSTANT, not the literal at its call sites: the string is persisted (it
 * keys the admin's `models` map, lands in `ai_usage_events.roleKey`, and is
 * stored on every cache row as part of its lookup key). See
 * `ai-model-roles.ts` — renaming a role key is a migration.
 */
const SPEAK_ROLE = 'speak';

/**
 * The object-storage prefix every clip this cache writes lives under.
 *
 * `speech/civics/…` — scoped by content type FIRST, so a future non-civics use
 * of the same mechanism sorts under its own prefix rather than intermingling
 * with this one and making "delete every cached civics clip" a filter instead
 * of a prefix.
 */
export const SPEECH_AUDIO_KEY_PREFIX = 'speech/civics';

/**
 * How long a client may hold a clip whose text cannot change: one year.
 *
 * THIS ROUTE MAY DO WHAT `POST /ai/speech/synthesize` MAY NOT. That one sets
 * `no-store` because it reads back arbitrary text a client sent, synthesized on
 * that caller's own key — bytes with no shared meaning, which a cache holding
 * them would be serving from one learner to another. These bytes are a reading
 * of PUBLIC civics content, identical for every learner on the deployment by
 * construction, addressed server-side by a hash of the very text they contain.
 * There is nothing personal in them to leak and nothing about them that can go
 * stale for a question whose prompt is fixed.
 *
 * `private` all the same: the response requires an `Authorization` header, and
 * a shared cache keying authenticated responses is a trap that pays off exactly
 * once. The learner's own browser is where this saves the round trip.
 *
 * ONLY WHEN THE REQUEST NAMED ITS VOICE. A browser cache is keyed by URL, and
 * a URL that omits `voice` does not determine the bytes: it resolves through
 * the learner's own `voice.preferredVoice` setting, so a learner who changes
 * their voice would keep hearing the old one for a year, from their own cache,
 * with nothing on the deployment able to reach it. Naming the voice makes the
 * URL genuinely address the content — which is the only condition under which
 * `immutable` is a true statement rather than an optimistic one.
 */
const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;

/**
 * How long a client may hold a clip whose URL does not fully determine it:
 * five minutes.
 *
 * TWO WAYS A URL CAN FAIL TO DETERMINE THE BYTES, and both land here. A
 * `national`/`state` scope ANSWER can be corrected by an admin
 * (`PUT /api/civics/dynamic-answers`); a request that named no `voice`
 * resolves one from the learner's own settings. The server-side key contains
 * the text's hash and the voice, so neither can go stale in
 * `speech_audio_assets` — but a BROWSER cache is keyed by URL, so a long
 * `max-age` on either would reintroduce in the client precisely the staleness
 * the content hash makes impossible in the database: a learner rehearsing a
 * superseded answer, or hearing a voice they have since changed, with nothing
 * on the deployment able to reach it.
 *
 * Five minutes is enough to make a replay free within one study session and
 * short enough that a correction reaches every learner the same day. The
 * server-side cache — the one that actually costs money — is unaffected either
 * way: a re-request inside five minutes or after a year is the same free hit.
 */
const DYNAMIC_MAX_AGE_SECONDS = 300;

/** Audio to send, and how long the caller may keep it. */
export interface SpeechAudioOk {
  status: 'ok';

  /** The clip, in memory: a response body on its way out, not a file. */
  audio: Buffer;

  /** e.g. `audio/mpeg`. Derived from the container — see {@link speechContentType}. */
  contentType: string;

  /**
   * Was this served without any AI call at all?
   *
   * FOR THE LOG AND FOR THE TESTS, not for the learner: a client renders the
   * same audio either way. It is carried because "did the second request for
   * this question spend a key" is the single fact this whole service exists to
   * make false, and a property nothing can observe is a property nothing can
   * assert.
   */
  cacheHit: boolean;

  /** `Cache-Control: private, max-age=…` — see the two constants above. */
  maxAgeSeconds: number;
}

/**
 * Everything this route can answer with.
 *
 * FOUR MEMBERS, ONE DISCRIMINANT. `state_required` is the one
 * `POST /ai/speech/synthesize` has no need of, because that route is handed its
 * text rather than resolving an answer. See `ai-speech.dto.ts`.
 */
export type SpeechAudioResult =
  | SpeechAudioOk
  | AiSpeechUnavailableResponse
  | AiSpeechFailedResponse
  | AiSpeechStateRequiredResponse;

@Injectable()
export class SpeechAudioService {
  private readonly logger = new Logger(SpeechAudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: AiDispatchService,
    private readonly aiSettings: AiSettingsService,
    // The SAME method the civics read route serves, never a second answer
    // resolution written for audio. `docs/specs/civics-content.md` §5's table
    // is applied in exactly one place in this codebase and this is not it.
    private readonly civics: CivicsService,
    // Read-only, and through `readVoicePreferences` rather than `getSettings`:
    // pressing play must not create a `user_settings` row. See that method.
    private readonly userSettings: UserSettingsService,
    // THE PORT, NOT THE OBJECT SERVICE — see the file header.
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Read one civics question — or its first accepted answer — aloud, serving
   * cached bytes when this deployment has already paid to synthesize them.
   *
   * NEVER THROWS FOR AN AI REASON, and never for a storage one either: the
   * three non-`ok` members are values, exactly as they are on this controller's
   * two POST routes. The one exception is an unknown `refId`, which
   * `CivicsService.getQuestion` reports as a `NotFoundException` — and that
   * stays a 404, because the question genuinely does not exist. Turning it into
   * a `status` member would put "you asked for something that is not there" in
   * the same union as "your administrator has not configured this", which are
   * different bugs with different owners.
   */
  async getCivicsAudio(
    userId: string,
    query: AiSpeechAudioQueryInput,
  ): Promise<SpeechAudioResult> {
    // Throws `NotFoundException` for an unknown id — see the doc comment.
    const question = await this.civics.getQuestion(userId, query.refId);

    if (
      query.scope === 'civics_answer' &&
      question.answerResolution === 'state_required'
    ) {
      // NOTHING IS SYNTHESIZED AND NOTHING IS CACHED. There is no correct
      // answer for this learner yet, and reading another state's would teach a
      // confident, memorable, wrong one — the same refusal
      // `POST /api/civics/questions/{id}/explain` makes with its own
      // `state_required` frame.
      return { status: 'state_required' };
    }

    const text = resolveText(question, query.scope);

    if (text === null || text.length === 0) {
      // A question with no currently-open answer row: content that is being
      // corrected, or a load that has not finished. `failed`, not
      // `unavailable` — the four `unavailable` causes are all statements about
      // AI CONFIGURATION, and nothing about AI is wrong here.
      return {
        status: 'failed',
        errorCode: 'no_resolved_text',
        error: 'There is nothing to read aloud for that question yet.',
      };
    }

    if (text.length > MAX_SYNTHESIS_TEXT_LENGTH) {
      // THE SAME CAP `POST /ai/speech/synthesize` APPLIES, not a second number.
      // Unreachable with today's content (the longest civics prompt is under
      // 100 characters) and cheap to keep: the cap exists because TTS is billed
      // per character, and "the text came from our own database" is a reason to
      // trust it, not a reason to stop bounding it.
      return {
        status: 'failed',
        errorCode: 'text_too_long',
        error: `That text is longer than ${MAX_SYNTHESIS_TEXT_LENGTH} characters.`,
      };
    }

    const format = query.format ?? DEFAULT_SPEECH_FORMAT;
    const contentType = speechContentType(format);
    // BOTH CONDITIONS, because both are ways the URL could stop naming these
    // exact bytes — see the two constants.
    const maxAgeSeconds =
      question.dynamicScope === 'none' && query.voice !== undefined
        ? IMMUTABLE_MAX_AGE_SECONDS
        : DYNAMIC_MAX_AGE_SECONDS;

    const voice = await this.resolveVoice(userId, query.voice);
    const modelId = await this.boundSpeakModel();

    if (voice === null || modelId === null) {
      // NOT CACHEABLE, SO NOT CACHED. Both halves of the lookup key are
      // missing-or-unknowable here: no voice means the provider offers none
      // (or cannot speak at all), and no model means an administrator has not
      // bound `speak`. Rather than invent a placeholder that would key a row
      // nothing could ever match again, the request goes straight to the
      // dispatcher — which answers `unavailable` with the precise cause, which
      // is the answer the caller actually needs.
      return this.synthesizeUncached(userId, text, query.voice, format, {
        contentType,
        maxAgeSeconds,
      });
    }

    const contentSha256 = sha256(text);
    const storageKey = buildStorageKey({
      scope: query.scope,
      refId: query.refId,
      voice,
      modelId,
      format,
      contentSha256,
    });

    const existing = await this.prisma.speechAudioAsset.findUnique({
      where: {
        scope_refId_voice_modelId_format_contentSha256: {
          scope: query.scope,
          refId: query.refId,
          voice,
          modelId,
          format,
          contentSha256,
        },
      },
      select: { storageKey: true },
    });

    if (existing) {
      const cached = await this.readObject(existing.storageKey);

      if (cached !== null) {
        // THE WHOLE POINT: no dispatch call, no provider request, and no
        // `ai_usage_events` row. Nobody's key was touched to answer this.
        return {
          status: 'ok',
          audio: cached,
          contentType,
          cacheHit: true,
          maxAgeSeconds,
        };
      }

      // The row exists and its object does not — a bucket emptied by hand, a
      // failed upload from an older deployment. Falling through to synthesize
      // repairs it (the same key is rewritten below) rather than failing a
      // request over a state this service can fix.
      this.logger.warn(
        `Cached speech asset ${existing.storageKey} is missing from storage; re-synthesizing.`,
      );
    }

    const result = await this.dispatch.synthesize(userId, {
      text,
      voice,
      format,
    });

    if (result.status === 'unavailable') {
      // NO ROW AND NO OBJECT. A failed or refused synthesis must leave nothing
      // behind that a later lookup could hit: a cache entry pointing at bytes
      // that were never written is worse than no entry at all, because the
      // second learner gets an error where the first got a clear cause.
      return { status: 'unavailable', cause: result.cause, role: SPEAK_ROLE };
    }

    if (result.status === 'failed') {
      return {
        status: 'failed',
        errorCode: result.errorCode,
        error: result.error,
      };
    }

    await this.store({
      scope: query.scope,
      refId: query.refId,
      voice,
      modelId,
      format,
      contentSha256,
      storageKey,
      audio: result.audio,
      contentType: result.contentType,
      charCount: text.length,
      userId,
      // A row already existed (its object had gone missing): the upload above
      // is a repair, and there is nothing to insert.
      rowExists: existing !== null,
    });

    return {
      status: 'ok',
      audio: result.audio,
      contentType,
      cacheHit: false,
      maxAgeSeconds,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Which voice this learner hears: the request, then their own preference,
   * then the provider's default.
   *
   * `null` when the configured provider offers no voices at all — a deployment
   * with no text-to-speech, where `voices: []` is the ordinary answer
   * (`GET /api/ai/speech/voices`) and the browser reads the question aloud
   * instead. There is no invented fallback string: a placeholder would become
   * part of a cache key nothing could ever match, and would be sent to a
   * provider as a voice id it does not know.
   */
  private async resolveVoice(
    userId: string,
    requested: string | undefined,
  ): Promise<string | null> {
    if (requested !== undefined) return requested;

    const preferences = await this.userSettings.readVoicePreferences(userId);

    // ABSENT MEANS "USE THE DEFAULT", never "no voice" — the sparse-namespace
    // contract `user-settings-namespaces.schema.ts` states for every namespace,
    // which is why none of them carries a `.default()`.
    if (preferences?.preferredVoice) return preferences.preferredVoice;

    const catalog = await this.dispatch.listVoices();

    return catalog.defaultVoice;
  }

  /**
   * The model an administrator bound to `speak`, or `null`.
   *
   * READ THE SAME WAY `AiDispatchService.synthesize` RESOLVES IT — off the
   * settings row's `models` map — because it has to be the same string the call
   * will actually run on: the model is part of the cache key, and a row written
   * under one model id but synthesized by another would serve a clip from a
   * model an admin has since replaced.
   *
   * There is deliberately no way for a caller to name a model, here or on the
   * query string. `null` sends the request down the uncached path, where the
   * dispatcher reports `role_unbound` with the cause a client can render.
   */
  private async boundSpeakModel(): Promise<string | null> {
    try {
      const settings = await this.aiSettings.get();
      const modelId = settings.models[SPEAK_ROLE];

      // THE SAME TWO-PART CHECK `AiDispatchService.resolve` MAKES (step 4):
      // `null` is an unbound role and a blank string is the same fact written
      // by an older client. The `models` map is typed loosely by construction
      // — its shape is derived from the role registry at runtime — so the
      // narrowing is the check rather than a cast.
      return typeof modelId === 'string' && modelId.trim().length > 0
        ? modelId
        : null;
    } catch {
      // `get()` throws on a stored-but-invalid row. Nothing can be bound in a
      // configuration nothing can read; the dispatcher reports the same
      // situation as a `failed` result on the uncached path.
      return null;
    }
  }

  /** Dispatch with no cache read and no cache write. See the one call site. */
  private async synthesizeUncached(
    userId: string,
    text: string,
    voice: string | undefined,
    format: string,
    envelope: { contentType: string; maxAgeSeconds: number },
  ): Promise<SpeechAudioResult> {
    const result = await this.dispatch.synthesize(userId, {
      text,
      voice,
      format,
    });

    switch (result.status) {
      case 'ok':
        return {
          status: 'ok',
          audio: result.audio,
          contentType: envelope.contentType,
          cacheHit: false,
          maxAgeSeconds: envelope.maxAgeSeconds,
        };
      case 'unavailable':
        return { status: 'unavailable', cause: result.cause, role: SPEAK_ROLE };
      case 'failed':
        return {
          status: 'failed',
          errorCode: result.errorCode,
          error: result.error,
        };
    }
  }

  /**
   * Read a cached object back, or `null` if it is not there.
   *
   * A STORAGE FAULT NEVER FAILS THE REQUEST. The caller falls through to a
   * fresh synthesis, which costs the learner one call and leaves the cache
   * repaired — strictly better than a 500 on a question they can already read
   * on screen.
   */
  private async readObject(key: string): Promise<Buffer | null> {
    try {
      const stream = await this.storage.download(key);
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const audio = Buffer.concat(chunks);

      return audio.length > 0 ? audio : null;
    } catch (err) {
      // The MESSAGE, never the bytes. A missing object is an ordinary state
      // here (see the caller), so this is a warning and not an error.
      this.logger.warn(
        `Could not read cached speech asset ${key}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      return null;
    }
  }

  /**
   * Upload the bytes and record the row.
   *
   * ---------------------------------------------------------------------------
   * THE DOUBLE-MISS RACE, AND WHY THE LOSER STILL GETS ITS AUDIO
   * ---------------------------------------------------------------------------
   *
   * Two learners can ask for the same never-before-heard clip within the same
   * few hundred milliseconds. Both miss, both synthesize (each on their OWN
   * key, so there is no double-billing to guard against — only a double write),
   * and both upload to the same object key, which is a pure function of the
   * cache key: the second upload overwrites the first with byte-identical
   * content, so there is nothing distinct to clean up. Both then try to insert
   * the row, and the unique constraint on
   * `(scope, refId, voice, modelId, format, contentSha256)` admits exactly one.
   *
   * The loser catches Prisma's `P2002`, DISCARDS ITS OWN ROW, AND SERVES THE
   * AUDIO ANYWAY. It already has the winner's bytes — literally the same
   * bytes, at the same key — so re-reading them from storage would be a round
   * trip to fetch what is already in hand. The synthesis is paid for either
   * way; failing the request on top of that would take a learner's money and
   * their question.
   *
   * ---------------------------------------------------------------------------
   * A STORAGE OR DATABASE FAILURE HERE IS NOT THE LEARNER'S PROBLEM EITHER
   * ---------------------------------------------------------------------------
   *
   * Everything in this method is an optimisation for the NEXT request. If the
   * upload or the insert fails, the caller still returns the audio it
   * synthesized — the cache simply misses again next time, which is the state
   * the deployment was in a moment ago.
   */
  private async store(entry: {
    scope: SpeechAudioScope;
    refId: string;
    voice: string;
    modelId: string;
    format: string;
    contentSha256: string;
    storageKey: string;
    audio: Buffer;
    contentType: string;
    charCount: number;
    userId: string;
    rowExists: boolean;
  }): Promise<void> {
    try {
      await this.storage.upload(entry.storageKey, Readable.from(entry.audio), {
        mimeType: entry.contentType,
        contentLength: entry.audio.length,
      });
    } catch (err) {
      this.logger.warn(
        `Could not cache speech audio at ${entry.storageKey}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      // NO ROW WITHOUT ITS BYTES. A row pointing at an object that was never
      // written would turn every later request for this clip into a miss that
      // first pays for a failed download.
      return;
    }

    if (entry.rowExists) return;

    try {
      await this.prisma.speechAudioAsset.create({
        data: {
          scope: entry.scope,
          refId: entry.refId,
          voice: entry.voice,
          modelId: entry.modelId,
          format: entry.format,
          contentSha256: entry.contentSha256,
          storageKey: entry.storageKey,
          byteSize: entry.audio.length,
          charCount: entry.charCount,
          // ATTRIBUTION, NOT OWNERSHIP. Nothing reads this to decide who may
          // hear the clip — every learner may — and its `onDelete: SetNull`
          // is what lets the asset outlive the account that paid for it.
          generatedByUserId: entry.userId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The race above. The winner's row names this exact key, holding these
        // exact bytes; there is nothing to repair and nothing to report.
        this.logger.debug(
          `Another request cached ${entry.storageKey} first; discarding this row.`,
        );

        return;
      }

      this.logger.warn(
        `Could not record a speech asset row for ${entry.storageKey}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}

/**
 * Which words this scope reads.
 *
 * `civics_answer` takes THE FIRST accepted answer, not all of them joined.
 * `CivicsService.getQuestion` returns every simultaneously-correct alternative
 * in slot order ("Name one branch of the government" resolves to three), and
 * the first is the one the UI presents as canonical. Reading the whole list
 * aloud would produce a paragraph nobody asked to hear, on a per-character
 * bill, and would teach a learner that the answer is a list when any one member
 * of it is a pass.
 */
function resolveText(
  question: { prompt: string; answers: Array<{ text: string }> },
  scope: SpeechAudioScope,
): string | null {
  if (scope === 'civics_question') return question.prompt.trim();

  return question.answers[0]?.text.trim() ?? null;
}

/** The lookup hash: sha256 of the EXACT text synthesized. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Where a clip's bytes live.
 *
 * A PURE FUNCTION OF THE CACHE KEY, which is what makes the double-miss race
 * harmless: two requests that miss simultaneously compute the identical key and
 * write identical bytes to it.
 *
 * THE MODEL ID IS A PATH SEGMENT, even though `docs/specs/voice-hands-free.md`
 * §4's sketch of the layout omits it. `speech_audio_assets.storage_key` is
 * `@unique` while the row's lookup key includes `model_id`, so a layout without
 * the model would make two legitimately different rows — the same sentence in
 * the same voice from two different models — collide on a constraint that has
 * nothing to do with either of them, and the second would fail to insert with a
 * `P2002` the race handler would read as "somebody else already cached this"
 * while serving the wrong model's audio.
 */
function buildStorageKey(entry: {
  scope: SpeechAudioScope;
  refId: string;
  voice: string;
  modelId: string;
  format: string;
  contentSha256: string;
}): string {
  return [
    SPEECH_AUDIO_KEY_PREFIX,
    entry.scope,
    entry.refId,
    slug(entry.voice),
    slug(entry.modelId),
    `${entry.contentSha256}.${slug(entry.format)}`,
  ].join('/');
}

/**
 * Make one path segment out of a provider-authored identifier.
 *
 * A model id is whatever an administrator typed into the settings row, so it
 * reaches this function as untrusted-ish text on its way into an object key.
 * Anything outside `[A-Za-z0-9._-]` becomes `_` — no `/` to invent a directory,
 * no `..` segment, and no empty segment. The result is not required to be
 * reversible: the database row, not the key, is what records what was
 * synthesized.
 */
function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');

  return cleaned.length > 0 ? cleaned : '_';
}

/** Prisma's "a unique constraint would have been violated". */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
