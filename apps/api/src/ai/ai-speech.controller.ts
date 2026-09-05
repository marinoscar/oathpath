import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AiSpeechService,
  MAX_TRANSCRIBE_BYTES,
  MAX_TRANSCRIBE_SECONDS,
} from './ai-speech.service';
import {
  AiSpeechFailedDto,
  AiSpeechUnavailableDto,
  AiSpeechVoicesResponseDto,
  AiSynthesizeRequestDto,
  AiTranscribeOkDto,
  MAX_SYNTHESIS_TEXT_LENGTH,
} from './dto/ai-speech.dto';

// =============================================================================
// AiSpeechController (issue #95, epic #58 — E9 "Voice foundation")
// =============================================================================
//
//   POST /api/ai/speech/transcribe   @Auth(), no permissions
//   POST /api/ai/speech/synthesize   @Auth(), no permissions
//   GET  /api/ai/speech/voices       @Auth(), no permissions   (#283, epic #280)
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO ROUTE ACCEPTS A USER ID
// -----------------------------------------------------------------------------
//
// Both handlers resolve the learner from `@CurrentUser('id')` and from nowhere
// else: no path parameter, no query parameter, no body field names a user. So
// there is no "transcribe on someone else's behalf" action to gate, and
// widening that is a signature change with a visible diff rather than a
// query-string edit — the identical structural rule the practice, journey,
// readiness, engagement and interview controllers hold to, and that
// `ai-user-key.controller.ts` holds to on this same `/api/ai` path.
//
// VOICE ADDS NO PERMISSION STRING (`docs/specs/voice.md` §10). Every
// authenticated learner practises with their own voice on their own key, and
// gating either route would leave a Viewer — the default role — unable to
// practise at all. There is no "use voice" privilege in this product's
// authorization model, and inventing one here would be the first exception to
// a rule every other learner-facing surface follows without exception.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER FROM `AiUserKeyController`, ON THE SAME PATH PREFIX
// -----------------------------------------------------------------------------
//
// For the reason `AiModule` already gives for splitting the key and usage
// controllers: a controller that both holds credentials and moves a learner's
// recorded voice is a controller where a future "transcribe for user X" route
// looks like it belongs. Two files means the gate and the data each surface
// touches are visible per file.
//
// -----------------------------------------------------------------------------
// NOTHING HERE PERSISTS, LOGS OR ECHOES THE AUDIO
// -----------------------------------------------------------------------------
//
// The upload is read into a buffer, handed to `AiSpeechService`, and dropped
// when the handler returns: no `storage_objects` row, no temp file, no disk
// write, no cache, no queue, and no `Blob` handed back. This controller
// imports nothing from the storage module — `docs/specs/voice.md` §4 is
// enforced by there being no path from here into it.
// =============================================================================

/** The form field carrying the recording. */
const AUDIO_FIELD = 'audio';

/** The form field carrying an optional ISO-639-1 language hint. */
const LANGUAGE_FIELD = 'languageHint';

/** The form field carrying the client's own claimed duration, in seconds. */
const DURATION_FIELD = 'durationSeconds';

/**
 * Multipart parser errors this controller answers as a 400.
 *
 * A MAP RATHER THAN A RETHROW, because every one of these reaches the client
 * as a 413 or a 500 otherwise — statuses that say "the server has a limit"
 * without saying which one, on the endpoint whose entire job is to refuse
 * unusable uploads cheaply and legibly. The messages name the cap and its
 * units so a client can fix the request without reading this file.
 */
const MULTIPART_ERROR_MESSAGES: Record<string, string> = {
  FST_REQ_FILE_TOO_LARGE: `The recording is too large. The limit is ${Math.floor(
    MAX_TRANSCRIBE_BYTES / (1024 * 1024),
  )} MB.`,
  FST_FILES_LIMIT: 'Send exactly one audio file.',
  FST_PARTS_LIMIT: 'The request has too many parts.',
  FST_FIELDS_LIMIT: 'The request has too many fields.',
  FST_INVALID_MULTIPART_CONTENT_TYPE:
    'This endpoint takes a multipart/form-data upload.',
  FST_PROTO_VIOLATION: 'Invalid field name.',
};

/**
 * The `{ data: … }` envelope, written out by hand around a `oneOf`.
 *
 * `applyDataEnvelope` (src/openapi/data-envelope.ts) wraps every documented 2xx
 * JSON body to match what the global `TransformInterceptor` really sends — but
 * it deliberately SKIPS `oneOf`/`allOf`/`anyOf` schemas rather than guessing at
 * them. Both responses here are unions, so the pass leaves them alone and the
 * document would otherwise promise a bare `{ status, … }` while the server
 * sends `{ data: { status, … } }`. Declaring the envelope explicitly is what
 * keeps the two in agreement; the pass's own `declaresDataProperty` check then
 * recognises it and leaves it untouched, so it is never double-wrapped.
 */
function envelopedOneOf(
  ...models: Parameters<typeof getSchemaPath>[0][]
): SchemaObject {
  return {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        oneOf: models.map((model) => ({ $ref: getSchemaPath(model) })),
        discriminator: { propertyName: 'status' },
      },
      meta: { type: 'object', additionalProperties: true },
    },
  };
}

@ApiTags('AI')
// The three response variants are referenced by `$ref` from hand-written
// `oneOf` schemas below, so nothing else in the document would pull them in.
// Without this they would be dangling references to schemas that were never
// published.
@ApiExtraModels(AiTranscribeOkDto, AiSpeechUnavailableDto, AiSpeechFailedDto)
@Controller('ai/speech')
export class AiSpeechController {
  constructor(private readonly speech: AiSpeechService) {}

  /**
   * Turn one recording into text, on the caller's own key.
   *
   * The response is deliberately narrow — `{ text, confidence }` and nothing
   * else (`docs/specs/voice.md` §9). The confirm-the-transcript screen needs
   * exactly those two, and no attempt is written and nothing is graded here:
   * this endpoint hears, the practice endpoints decide.
   */
  @Post('transcribe')
  @Auth()
  // 200, not the 201 a POST defaults to: nothing is created. Emphatically so
  // on this route — see the file header on what does NOT happen to the bytes.
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Transcribe one recording',
    description:
      'Turns one uploaded recording into text **on your own AI key**, and returns the ' +
      'transcript and the recogniser’s confidence. **Nothing else is returned, and the ' +
      'recording is not stored** — not in object storage, not on disk, not in a log. It ' +
      'exists for the length of the provider call and is then dropped.\n\n' +
      '**Nothing is graded here.** No practice attempt is written. The transcript is ' +
      'meant to be shown to the learner to confirm or correct **before** anything is ' +
      'submitted for grading, which is what keeps a mishearing from being recorded as a ' +
      'wrong answer.\n\n' +
      `**Limits, both enforced before any provider call is made** — an oversized upload ` +
      `costs you nothing: at most ${Math.floor(MAX_TRANSCRIBE_BYTES / (1024 * 1024))} MB ` +
      `and at most ${MAX_TRANSCRIBE_SECONDS} seconds. Duration is bounded from the byte ` +
      'count at a generous bitrate ceiling rather than by decoding the audio, so a very ' +
      'high-bitrate short recording may be refused as too long; record at a lower bitrate.\n\n' +
      '**Read `status`.** `ok` carries the transcript. `unavailable` means no call was ' +
      'attempted — you have stored no AI key, or an administrator has not finished ' +
      'configuring AI — and names the `cause` and the `role` so the client can say which ' +
      'one, rather than showing a spinner. `failed` means the call was made and did not ' +
      'produce a usable answer. **All three are HTTP 200**; a non-2xx here would discard ' +
      'the cause, which is the one fact this response exists to carry.\n\n' +
      '`confidence` is `null` when the model reports none. **That means unknown — it is ' +
      'never 0 and never 1.**',
  })
  @ApiBody({
    description:
      'One audio file in the `audio` field. Optional `languageHint` (ISO-639-1, e.g. ' +
      '`en`) and `durationSeconds` fields may be sent **before** the file part; a ' +
      'declared duration can only make the request more restricted, never less.',
    schema: {
      type: 'object',
      required: [AUDIO_FIELD],
      properties: {
        [AUDIO_FIELD]: { type: 'string', format: 'binary' },
        [LANGUAGE_FIELD]: { type: 'string', example: 'en' },
        [DURATION_FIELD]: { type: 'number', example: 12.5 },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'The transcript, or a typed reason no call was attempted. Read `status`.',
    // `oneOf` OVER THE THREE VARIANTS, with `status` declared as the
    // discriminator, rather than one flattened object with everything
    // optional: a generated client gets three types it can switch on, which is
    // the whole reason the response is shaped this way. See `ai-speech.dto.ts`
    // for why there is no single class to name here.
    schema: envelopedOneOf(
      AiTranscribeOkDto,
      AiSpeechUnavailableDto,
      AiSpeechFailedDto,
    ),
  })
  @ApiResponse({
    status: 400,
    description:
      'The upload was empty, too large, too long, not audio, or not one file. **No ' +
      'provider call was made and nothing was billed.**',
  })
  async transcribe(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    const upload = await this.readUpload(req);

    return this.speech.transcribe(userId, upload);
  }

  /**
   * Read one piece of text aloud, on the caller's own key.
   *
   * -------------------------------------------------------------------------
   * AN UPGRADE PATH, NEVER THE ONLY WAY TO HEAR A QUESTION
   * -------------------------------------------------------------------------
   *
   * The browser's own `speechSynthesis` is the default and ships on every
   * deployment with no admin action, no credential and no per-call cost
   * (`docs/specs/voice.md` §2). This route is the optional premium voice
   * layered on top, for a deployment whose administrator has bound a `speak`
   * model. So an unbound `speak` is NOT a degraded state and must not be
   * rendered as one: a learner hears the question either way, and telling them
   * something is broken when nothing is would send them to check the one thing
   * that is not wrong.
   *
   * -------------------------------------------------------------------------
   * TWO RESPONSE SHAPES, TOLD APART BY `Content-Type`
   * -------------------------------------------------------------------------
   *
   * Success is the audio bytes with the provider's own content type. Anything
   * else is `application/json` carrying the same `{ status, cause, role }` /
   * `{ status, errorCode, error }` envelope `transcribe` returns — at HTTP
   * 200, for the reason `ai-speech.dto.ts` gives: a 404 or a 503 would be
   * flattened into generic failure handling and the cause, which is the whole
   * point, would never reach the screen. `voice.md` §9 sketched a "404-shaped"
   * response for the unbound case; the shape is what it asked for, at the
   * status code that keeps its payload readable.
   *
   * The JSON half is written in the `{ data: … }` envelope by hand, because
   * `@Res()` bypasses the global `TransformInterceptor` — without that, this
   * one endpoint would be the only JSON in the API that is not enveloped, and
   * the published document (which applies the envelope to every documented 2xx
   * JSON body) would be wrong about it.
   */
  @Post('synthesize')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read one piece of text aloud',
    description:
      'Synthesises speech for a short piece of text **on your own AI key** and returns ' +
      'the audio bytes with the provider’s own `Content-Type`.\n\n' +
      '**This is an upgrade, not the only way to hear a question.** The browser’s built-in ' +
      '`speechSynthesis` is the default everywhere and needs no configuration, no ' +
      'credential and no network call. An administrator who has not bound a `speak` model ' +
      'has not broken anything, and a client must not present it that way.\n\n' +
      '**When there is no audio, the response is `application/json`** in the usual ' +
      '`{ data: … }` envelope, carrying `status` `unavailable` (with the `cause` and the ' +
      '`role`) or `failed`. **Still HTTP 200** — tell the two apart by `Content-Type`, ' +
      'not by status code.\n\n' +
      `\`text\` is capped at ${MAX_SYNTHESIS_TEXT_LENGTH} characters: this reads a ` +
      'question, an interview turn or a short explanation aloud, not an essay. There is ' +
      'no model parameter — the model is the one your administrator bound to the `speak` ' +
      'role.',
  })
  @ApiBody({ type: AiSynthesizeRequestDto })
  @ApiOkResponse({
    description:
      'The audio, or — as JSON — a typed reason there is none. Read `Content-Type`.',
    content: {
      'audio/mpeg': { schema: { type: 'string', format: 'binary' } },
      'application/json': {
        schema: envelopedOneOf(AiSpeechUnavailableDto, AiSpeechFailedDto),
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'The body was missing, empty, over the character cap, or carried an unknown key.',
  })
  async synthesize(
    @Body() body: AiSynthesizeRequestDto,
    @CurrentUser('id') userId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.speech.synthesize(userId, body);

    if (result.status === 'ok') {
      // `Content-Length` set explicitly: the body is a Buffer of known size, and
      // a client that knows how much audio is coming can show progress instead
      // of a spinner. `no-store` because this is generated on the caller's own
      // key — a shared cache holding it would serve one learner's paid-for
      // audio to another.
      reply
        .status(HttpStatus.OK)
        .header('Content-Type', result.contentType)
        .header('Content-Length', result.audio.length)
        .header('Cache-Control', 'no-store')
        .send(result.audio);

      return;
    }

    // The envelope by hand — see the doc comment. No `meta`: the envelope
    // documents it as optional, and the only thing this handler could put
    // there is a timestamp it would have to read a clock for.
    reply
      .status(HttpStatus.OK)
      .header('Content-Type', 'application/json; charset=utf-8')
      .send({ data: result });
  }

  /**
   * The voices a learner may pick from (#283, epic #280).
   *
   * -------------------------------------------------------------------------
   * A PLAIN 200 JSON BODY, AND THE ONLY ROUTE HERE THAT IS NOT A `status` UNION
   * -------------------------------------------------------------------------
   *
   * Stated outright because both of its neighbours ARE unions and a reader
   * will assume this one was forgotten. It was not: nothing about this route
   * can be "unavailable" in the `AiUnavailableCause` sense. It makes no
   * inference call, resolves no credential, spends nobody's key and writes no
   * `ai_usage_events` row — it reads a settings row and an array the provider
   * hard-codes about itself. There is no state a cause would describe, so a
   * union here would publish four branches no client could ever receive.
   *
   * A provider that cannot speak is `voices: []`, which is
   * `capability_unsupported` expressed as an empty list rather than an error —
   * and it is the CORRECT outcome, not a failure: the picker then offers the
   * browser's own voices, which is what reads every question aloud on a fresh
   * install anyway (`docs/specs/voice.md` §2). `speakBound: false` is
   * likewise ordinary and renders no warning.
   *
   * -------------------------------------------------------------------------
   * WHY THE WEB READS THIS OVER AN ENDPOINT
   * -------------------------------------------------------------------------
   *
   * The list belongs to the provider. A copy in `apps/web/src/config` with a
   * test asserting the two agree is DETECTION rather than prevention — the
   * copies can still disagree in a working tree, in a branch, and in any build
   * where the test is not run — which is `ai-model-roles.ts`'s own argument for
   * serving the role registry the same way, and `aiSynthesizeRequestSchema`'s
   * for validating a voice id's shape but never its membership.
   */
  @Get('voices')
  @Auth()
  @ApiOperation({
    summary: 'List the voices this deployment can speak in',
    description:
      'The voices the configured AI provider offers for **premium** text-to-speech, so a ' +
      'client can render a picker. **Nothing is spent and nothing is called** — this reads ' +
      'static, provider-authored data and your own AI key is not involved.\n\n' +
      '**Unlike the other two routes here, this is a plain JSON body, not a `status` ' +
      'union.** There is no state it can report that would need one.\n\n' +
      '`voices` is **empty** when the configured provider has no text-to-speech at all, and ' +
      '`speakBound` is `false` when an administrator has not bound a model to the `speak` ' +
      'role. **Neither is an error.** The browser’s own `speechSynthesis` reads questions ' +
      'aloud on every deployment with no configuration at all, so a client should offer ' +
      'browser voices and say nothing about what is missing.\n\n' +
      '`defaultVoice` is the id used when a synthesis request names none — the same value ' +
      'the provider itself falls back to, so a picker can mark it without guessing.',
  })
  @ApiOkResponse({
    description:
      'The voices, whether the `speak` role is bound, and the default voice id.',
    type: AiSpeechVoicesResponseDto,
  })
  async voices() {
    // NO `@CurrentUser`, and that is not an omission: there is no per-caller
    // answer here. Every authenticated learner on this deployment reads the
    // same list, and taking a user id would create the "voices for user X"
    // parameter this controller's header says none of its routes have.
    return this.speech.listVoices();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Read the multipart body into one buffer, or say why it cannot be.
   *
   * -------------------------------------------------------------------------
   * THE BYTE CAP IS PASSED TO THE PARSER, NOT CHECKED AFTERWARDS
   * -------------------------------------------------------------------------
   *
   * `limits.fileSize` makes busboy refuse the part MID-STREAM: the buffered
   * chunks are dropped and the read throws, so an oversized upload never
   * finishes arriving and is never held whole in this process. Checking
   * `buffer.length` after the fact would mean the server had already done the
   * thing the cap exists to prevent.
   *
   * -------------------------------------------------------------------------
   * `files()` RATHER THAN `file()`, TO NOTICE A SECOND FILE
   * -------------------------------------------------------------------------
   *
   * `req.file()` returns the first file and stops looking, so a request
   * carrying two would be silently truncated to one — and, because the global
   * registration sets `files: 1`, truncated to a PARTIAL first one. Iterating
   * the file parts surfaces the parser's own files-limit error instead, which
   * the map above turns into a 400 that says what was wrong. Iterating to the
   * end is also what collects the form fields regardless of the order the
   * client sent them in.
   */
  private async readUpload(req: FastifyRequest) {
    let part: MultipartFile | undefined;
    let audio: Buffer | undefined;

    try {
      // THE ONLY LIMIT OVERRIDDEN IS THE SIZE. `files: 1` and the field limits
      // come from the global registration in `main.ts`; restating them here
      // would be a second place they live.
      for await (const file of req.files({
        limits: { fileSize: MAX_TRANSCRIBE_BYTES },
      })) {
        if (part !== undefined) {
          throw new BadRequestException(MULTIPART_ERROR_MESSAGES.FST_FILES_LIMIT);
        }

        part = file;
        audio = await file.toBuffer();
      }
    } catch (err) {
      // A `BadRequestException` from the loop body is already the answer.
      if (err instanceof BadRequestException) throw err;

      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      const message = MULTIPART_ERROR_MESSAGES[code];

      if (message !== undefined) throw new BadRequestException(message);

      // An unrecognised parser failure is still the client's malformed body —
      // a truncated stream, a broken boundary — and not a server fault. It is
      // reported without the underlying message, which is a parser's internal
      // vocabulary rather than anything a client can act on.
      throw new BadRequestException('The upload could not be read.');
    }

    if (part === undefined || audio === undefined) {
      throw new BadRequestException(
        `Attach one audio file in the "${AUDIO_FIELD}" field.`,
      );
    }

    if (part.fieldname !== AUDIO_FIELD) {
      // NAMED FIELD, NOT "the first file". A client that renamed the field
      // gets told which name this endpoint reads, instead of having its upload
      // accepted under whatever it happened to be called — which is how a
      // second, differently-named field quietly becomes part of the contract.
      throw new BadRequestException(
        `Attach the recording in the "${AUDIO_FIELD}" field.`,
      );
    }

    return {
      audio,
      contentType: part.mimetype,
      // The provider SDK infers the container format from the name. A part
      // with none gets a neutral one rather than an empty string, which is
      // uploaded as an unnamed blob and rejected as an unsupported format.
      fileName:
        typeof part.filename === 'string' && part.filename.length > 0
          ? part.filename
          : 'recording',
      languageHint: readLanguageHint(part),
      declaredDurationSeconds: readDeclaredDuration(part),
    };
  }
}

/** The value of a form field, when it was sent as a single plain field. */
function readField(part: MultipartFile, name: string): string | undefined {
  const field = part.fields[name];

  if (field === undefined || Array.isArray(field) || field.type !== 'field') {
    // AN ARRAY OR A FILE IS IGNORED, NOT GUESSED AT. Picking one of two values
    // a client sent twice is a decision this layer has no basis for making.
    return undefined;
  }

  const value = (field as MultipartValue).value;

  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * The caller's ISO-639-1 hint, validated for shape.
 *
 * REJECTED RATHER THAN DROPPED when it is not a two-letter code: the hint ends
 * up in a provider request, and a client that sent `"English"` should learn
 * that immediately rather than wonder why accuracy did not improve.
 */
function readLanguageHint(part: MultipartFile): string | undefined {
  const raw = readField(part, LANGUAGE_FIELD);

  if (raw === undefined || raw.length === 0) return undefined;

  if (!/^[A-Za-z]{2}$/.test(raw)) {
    throw new BadRequestException(
      `"${LANGUAGE_FIELD}" must be a two-letter ISO-639-1 code, e.g. "en".`,
    );
  }

  return raw.toLowerCase();
}

/**
 * The duration the client claims, in seconds.
 *
 * A HINT THAT CAN ONLY RESTRICT — see `TranscribeUpload.declaredDurationSeconds`.
 * A malformed value is a 400 rather than a silent `undefined`, so a client
 * whose field never worked finds out on the first request instead of believing
 * its recordings were being length-checked.
 */
function readDeclaredDuration(part: MultipartFile): number | undefined {
  const raw = readField(part, DURATION_FIELD);

  if (raw === undefined || raw.length === 0) return undefined;

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestException(
      `"${DURATION_FIELD}" must be a number of seconds.`,
    );
  }

  return parsed;
}
