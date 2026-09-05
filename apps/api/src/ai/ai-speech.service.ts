import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { AiDispatchService } from './ai-dispatch.service';
import type {
  AiSynthesizeRunResult,
  AiTranscribeRunResult,
} from './ai-dispatch.service';
import { AiSettingsService } from './ai-settings.service';
import type {
  AiSpeechFailedResponse,
  AiSpeechUnavailableResponse,
  AiSpeechVoicesResponse,
  AiSynthesizeRequestInput,
  AiTranscribeResponse,
} from './dto/ai-speech.dto';

// =============================================================================
// AiSpeechService (issue #95, epic #58 — E9 "Voice foundation")
// =============================================================================
//
// The two speech endpoints' logic: bound the upload, refuse what cannot be
// transcribed, dispatch on the CALLER's own key, and shape the answer.
//
// -----------------------------------------------------------------------------
// THE CAPS ARE CHECKED BEFORE DISPATCH, WHICH IS THE WHOLE REASON THEY EXIST
// -----------------------------------------------------------------------------
//
// `docs/specs/voice.md` §9: "an oversized file is a 400, not a billed call."
// Both caps are enforced on the way in, before `AiDispatchService.transcribe`
// is reached, because after it the money is already spent — on a LEARNER's own
// key, for a request the server was always going to refuse. A cap applied to
// the response is not a cap; it is a receipt.
//
// This is also why `POST /api/storage/objects` is not the pattern to copy here
// even though it is the multipart example this codebase already has. That
// route persists what it receives, on purpose, and inherits a 100 MB limit
// from the global plugin registration. Neither property is wanted here: the
// bytes must not be persisted at all (§4), and 100 MB of audio is minutes of
// billed transcription.
//
// -----------------------------------------------------------------------------
// THE AUDIO BUFFER LIVES ONLY FOR THE DURATION OF THE PROVIDER CALL
// -----------------------------------------------------------------------------
//
// This file imports nothing from `../storage`, writes no file, opens no temp
// path and holds no reference past the call it makes. The buffer arrives from
// the controller, goes into the dispatch request, and goes out of scope when
// the handler returns. `docs/specs/voice.md` §4 is enforced by there being no
// code here that could do otherwise.
//
// Nothing logged from this file carries the bytes or the transcript either.
// The recording is a learner's voice and the transcript is what they said; the
// only text emitted here is a byte count and a content type.
// =============================================================================

/**
 * The hard byte cap on one upload: 10 MB, from `docs/specs/voice.md` §9.
 *
 * ENFORCED BY THE MULTIPART PARSER ITSELF (the controller passes it as
 * `limits.fileSize`), so an oversized part is refused mid-stream rather than
 * after the whole body has been read into this process. A cap checked on a
 * fully buffered upload still made the server hold whatever was sent.
 */
export const MAX_TRANSCRIBE_BYTES = 10 * 1024 * 1024;

/** The duration cap on one recording: 120 seconds, from `voice.md` §9. */
export const MAX_TRANSCRIBE_SECONDS = 120;

/**
 * The bitrate ceiling the duration cap is enforced through: 512 kbit/s.
 *
 * -----------------------------------------------------------------------------
 * WHY A BYTE RATIO AND NOT A DECODE
 * -----------------------------------------------------------------------------
 *
 * Knowing a recording's real duration means parsing its container and codec
 * headers — WebM/Matroska, Ogg, MP4, RIFF, MPEG frames — from bytes an
 * anonymous client chose. A codec parser on untrusted input is one of the
 * larger attack surfaces a web application can adopt (the CVE history of every
 * demuxer says so), and it would be adopted here to answer a question a
 * subtraction already answers well enough. A pulled-in media library would be
 * the same trade with someone else's parser.
 *
 * So the check is arithmetic: at a bitrate no accepted encoding exceeds, a
 * recording of at most {@link MAX_TRANSCRIBE_SECONDS} cannot be larger than
 * {@link MAX_TRANSCRIBE_AUDIO_BYTES}. THIS IS AN UPPER BOUND ON DURATION, NOT A
 * MEASUREMENT — it does not know how long the audio is; it knows what it
 * cannot be shorter than at this density.
 *
 * The direction of the error is deliberate and worth stating: a very
 * high-bitrate SHORT recording is rejected as though it were long. That is the
 * safe direction — the caller is told to record at a lower bitrate, and
 * nobody is billed — where the opposite error (accepting a ten-minute
 * low-bitrate file) is the one that produces a charge on a learner's key.
 * 512 kbit/s is far above any speech codec a browser's `MediaRecorder`
 * produces (Opus in WebM runs at 24–32 kbit/s, so two minutes is under 500 kB)
 * and above 16-bit 24 kHz mono PCM, so the rejection is only reached by audio
 * this endpoint has no reason to accept.
 */
export const MAX_AUDIO_BYTES_PER_SECOND = 64 * 1024;

/**
 * The largest upload that could still be {@link MAX_TRANSCRIBE_SECONDS} or
 * less at {@link MAX_AUDIO_BYTES_PER_SECOND}.
 *
 * DERIVED, NEVER TYPED OUT, so the three numbers above cannot disagree with a
 * fourth written by hand. It is smaller than {@link MAX_TRANSCRIBE_BYTES}, and
 * both are kept: the byte cap is what the parser enforces mid-stream, this is
 * what the duration rule enforces once the length is known, and the two
 * produce different messages because they are different refusals.
 */
export const MAX_TRANSCRIBE_AUDIO_BYTES =
  MAX_TRANSCRIBE_SECONDS * MAX_AUDIO_BYTES_PER_SECOND;

/**
 * The content types this endpoint will forward to a recogniser.
 *
 * AN ALLOWLIST, NOT A `startsWith('audio/')` TEST. "Anything that calls itself
 * audio" includes types no provider accepts, so the request would be billed
 * and then fail — the caller learns the format was wrong one round trip and
 * one charge later than they could have. Listing what browsers actually record
 * (`MediaRecorder` emits `audio/webm` or `audio/mp4` depending on the engine)
 * plus the ordinary upload formats keeps the refusal free.
 *
 * `video/webm` is here because it is not a mistake: Chrome labels an
 * audio-only WebM recording `video/webm` in some configurations, and rejecting
 * it would break the default recording path on a real browser for a reason a
 * user could never diagnose.
 */
export const ACCEPTED_AUDIO_CONTENT_TYPES: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/oga',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
  'video/webm',
];

/**
 * The model role the premium voice path runs on.
 *
 * A CONSTANT RATHER THAN THE LITERAL AT ITS ONE CALL SITE, because the string
 * is persisted — it keys the admin's `models` map and lands in
 * `ai_usage_events.roleKey` — and `unboundRoles` reports it by exactly this
 * spelling. See `ai-model-roles.ts`: renaming a role key is a migration.
 */
const SPEAK_ROLE = 'speak';

/** What the controller hands over once it has read the multipart body. */
export interface TranscribeUpload {
  /**
   * The recording. IN MEMORY AND NOWHERE ELSE — see the file header.
   */
  audio: Buffer;

  /** The part's declared content type, parameters and all (`audio/webm;codecs=opus`). */
  contentType: string;

  /** The part's file name. A wire detail the provider SDK reads; never stored. */
  fileName: string;

  /** An optional ISO-639-1 hint from the form. */
  languageHint?: string;

  /**
   * A duration the CLIENT claims, in seconds, when it sends one.
   *
   * A HINT THAT CAN ONLY RESTRICT. It is unverifiable — the client computed it
   * from its own recorder — so it is used to REJECT (a client that admits to
   * three minutes is refused without arithmetic) and never to admit: a
   * declared `1` does not exempt an 8 MB upload from
   * {@link MAX_TRANSCRIBE_AUDIO_BYTES}. Trusting it the other way would make
   * the duration cap a form field.
   */
  declaredDurationSeconds?: number;
}

/** What `synthesize` produces when there is audio to send. */
export interface SynthesizedSpeech {
  status: 'ok';
  audio: Buffer;
  contentType: string;
}

@Injectable()
export class AiSpeechService {
  private readonly logger = new Logger(AiSpeechService.name);

  constructor(
    private readonly dispatch: AiDispatchService,
    // ADDED FOR THE VOICES ROUTE ONLY (#283). It answers one question —
    // whether an administrator has bound the `speak` role — and it answers it
    // out of `describeReadiness`'s own `unboundRoles`, the same set
    // `GET /api/ai/status` publishes. Recomputing "is `speak` bound" from a
    // settings row here would be a second implementation of a rule that has
    // already moved once (E9 narrowed `systemReady` and left `unboundRoles`
    // alone), and the two would disagree the next time it moves.
    private readonly aiSettings: AiSettingsService,
  ) {}

  /**
   * Turn one uploaded recording into text, on the caller's own key.
   *
   * Validates first and dispatches second, so every rejection below costs
   * nothing. THROWS ONLY `BadRequestException`, and only for a malformed
   * request: an unconfigured deployment and a provider failure are both
   * VALUES on the way back, because neither is something the caller sent
   * wrong.
   */
  async transcribe(
    userId: string,
    upload: TranscribeUpload,
  ): Promise<AiTranscribeResponse> {
    this.assertAcceptable(upload);

    const result = await this.dispatch.transcribe(userId, {
      audio: upload.audio,
      contentType: normalizeContentType(upload.contentType),
      fileName: upload.fileName,
      languageHint: upload.languageHint,
    });

    return describeTranscription(result);
  }

  /**
   * Read one piece of text aloud, on the caller's own key.
   *
   * Returns the bytes on success and a typed envelope otherwise — the caller
   * writes one or the other onto the reply. See the controller for why the
   * two are distinguished by `Content-Type` rather than by status code.
   */
  async synthesize(
    userId: string,
    input: AiSynthesizeRequestInput,
  ): Promise<
    SynthesizedSpeech | AiSpeechUnavailableResponse | AiSpeechFailedResponse
  > {
    const result = await this.dispatch.synthesize(userId, {
      text: input.text,
      voice: input.voice,
      format: input.format,
    });

    return describeSynthesis(result);
  }

  /**
   * The voices a learner may pick from, and whether the premium path is
   * configured at all (#283, epic #280).
   *
   * -------------------------------------------------------------------------
   * NO CALLER, NO KEY, NO COST — WHICH IS WHY IT IS NOT A `status` UNION
   * -------------------------------------------------------------------------
   *
   * The other two methods here take a `userId` because they spend that
   * learner's credential. This one reads a settings row and an array the
   * provider hard-codes about itself: nothing is resolved, nothing is spent,
   * nothing is recorded, and there is no state an `AiUnavailableCause` would
   * describe. See `dto/ai-speech.dto.ts` for the same argument at the wire.
   *
   * -------------------------------------------------------------------------
   * AN EMPTY LIST AND AN UNBOUND ROLE ARE BOTH ORDINARY
   * -------------------------------------------------------------------------
   *
   * Neither is reported as a failure and neither throws. A deployment with no
   * provider, no `tts` capability, or no `speak` binding still reads every
   * question aloud through the browser's own `speechSynthesis`
   * (`docs/specs/voice.md` §2) — the picker simply has nothing premium to
   * offer, which is what `voices: []` / `speakBound: false` say.
   */
  async listVoices(): Promise<AiSpeechVoicesResponse> {
    // In parallel: they read different things and neither depends on the
    // other, and this sits behind a settings screen a learner is waiting on.
    const [catalog, readiness] = await Promise.all([
      this.dispatch.listVoices(),
      this.aiSettings.describeReadiness(),
    ]);

    return {
      voices: catalog.voices,
      // `unboundRoles`, NEVER `systemReady`. `systemReady` is computed over
      // the text roles only and is deliberately silent about voice
      // (`docs/specs/voice.md` §1) — reading it here would report a deployment
      // with a perfectly good `speak` binding as having none whenever its
      // `tutor` model was unbound, and vice versa.
      speakBound: !readiness.unboundRoles.includes(SPEAK_ROLE),
      defaultVoice: catalog.defaultVoice,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Refuse an upload no recogniser should be paid to look at.
   *
   * FOUR SEPARATE MESSAGES, not one "invalid audio". Each of these is a
   * different thing for a client to fix — record something, record less,
   * record smaller, send a format we accept — and a single message would make
   * all four look like the same bug.
   */
  private assertAcceptable(upload: TranscribeUpload): void {
    const bytes = upload.audio.length;

    if (bytes === 0) {
      // A zero-byte part is a client that lost the recording, not silence: a
      // real recording of silence still carries a container. Sending it on
      // would buy an empty transcript at full price.
      throw new BadRequestException('The uploaded recording is empty.');
    }

    const contentType = normalizeContentType(upload.contentType);

    if (!ACCEPTED_AUDIO_CONTENT_TYPES.includes(contentType)) {
      throw new BadRequestException(
        `Unsupported audio content type "${contentType}".`,
      );
    }

    // THE CLIENT'S OWN CLAIM FIRST, because it is free and because a client
    // honest enough to send it deserves the specific answer. It can only make
    // the request more restricted — see `TranscribeUpload.declaredDurationSeconds`.
    if (
      typeof upload.declaredDurationSeconds === 'number' &&
      Number.isFinite(upload.declaredDurationSeconds) &&
      upload.declaredDurationSeconds > MAX_TRANSCRIBE_SECONDS
    ) {
      throw new BadRequestException(
        `Recordings must be ${MAX_TRANSCRIBE_SECONDS} seconds or less.`,
      );
    }

    if (bytes > MAX_TRANSCRIBE_BYTES) {
      // Ordinarily unreachable — the multipart parser refuses this mid-stream
      // — and kept because "the parser was configured with the same constant"
      // is an assumption this method should not make about its caller. A
      // future caller that buffers differently gets the same refusal.
      throw new BadRequestException(
        `Recordings must be ${Math.floor(MAX_TRANSCRIBE_BYTES / (1024 * 1024))} MB or less.`,
      );
    }

    if (bytes > MAX_TRANSCRIBE_AUDIO_BYTES) {
      // NOT A MEASUREMENT — see MAX_AUDIO_BYTES_PER_SECOND. The message says
      // "too long" because that is what is being refused, and names the
      // bitrate escape hatch because a caller hitting this on a short
      // recording has no other way to guess what happened.
      throw new BadRequestException(
        `Recordings must be ${MAX_TRANSCRIBE_SECONDS} seconds or less. ` +
          'This upload is larger than that duration allows; record at a lower bitrate.',
      );
    }

    // SHAPE ONLY. Byte count and content type diagnose "every upload is being
    // rejected" and "the recordings are all 44 bytes"; the recording itself
    // has no diagnostic value and no business in a log.
    this.logger.debug(
      `Accepted a ${bytes}-byte ${contentType} recording for transcription.`,
    );
  }
}

/**
 * Strip the parameters off a content type and lower-case it.
 *
 * `MediaRecorder` sends `audio/webm;codecs=opus`, which is a correct content
 * type and not a member of any allowlist written as whole strings. Comparing
 * the raw header against the list would reject the ordinary browser recording
 * — the single most likely request this endpoint ever receives.
 */
function normalizeContentType(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Turn a dispatch result into the wire shape.
 *
 * A SWITCH ON `status`, not a `try`/`catch`: `AiDispatchService.transcribe`
 * never throws for an AI reason, so the three outcomes are three branches and
 * the compiler checks that all three are handled.
 */
function describeTranscription(
  result: AiTranscribeRunResult,
): AiTranscribeResponse {
  switch (result.status) {
    case 'ok':
      // EXACTLY TWO FIELDS BESIDES THE DISCRIMINANT. No model id, no usage, no
      // usage-event id — `voice.md` §9's "and nothing else", and every field
      // not returned is one this endpoint never has to keep compatible.
      return { status: 'ok', text: result.text, confidence: result.confidence };
    case 'unavailable':
      return { status: 'unavailable', cause: result.cause, role: 'transcribe' };
    case 'failed':
      return {
        status: 'failed',
        errorCode: result.errorCode,
        error: result.error,
      };
  }
}

/** The same three branches for synthesis. */
function describeSynthesis(
  result: AiSynthesizeRunResult,
): SynthesizedSpeech | AiSpeechUnavailableResponse | AiSpeechFailedResponse {
  switch (result.status) {
    case 'ok':
      return {
        status: 'ok',
        audio: result.audio,
        contentType: result.contentType,
      };
    case 'unavailable':
      return { status: 'unavailable', cause: result.cause, role: 'speak' };
    case 'failed':
      return {
        status: 'failed',
        errorCode: result.errorCode,
        error: result.error,
      };
  }
}
