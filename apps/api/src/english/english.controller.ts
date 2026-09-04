import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ASR_CONFIDENCE_THRESHOLD } from '../ai/ai.types';
import { EnglishService } from './english.service';
import {
  EnglishNextDto,
  EnglishNextQueryDto,
  type EnglishNextResponse,
} from './dto/english-sentence.dto';
import { RecordEnglishAttemptDto } from './dto/record-english-attempt.dto';
import {
  EnglishAttemptMisheardDto,
  EnglishAttemptScoredDto,
  type EnglishAttemptResult,
} from './dto/english-attempt-result.dto';
import {
  EnglishProgressDto,
  type EnglishProgressResponse,
} from './dto/english-progress.dto';

// =============================================================================
// EnglishController (issue #136, epic #59 / E10 "Reading and writing tests")
// =============================================================================
//
//   GET  /api/english/next?kind=reading|writing   @Auth(), no permissions
//   POST /api/english/attempts                    @Auth(), no permissions
//   GET  /api/english/progress                    @Auth(), no permissions
//
// The surface `docs/specs/english-test.md` §7 fixes, implemented against that
// contract. The DTOs, the selection algorithm and the progress shape are this
// issue's own decisions, made within it.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// §7 states it and this file keeps it: gating English practice behind a
// permission would leave a Viewer — the DEFAULT role every new account gets —
// unable to use a feature every authenticated learner is meant to practise.
// That is the identical reasoning `CLAUDE.md`'s RBAC section already gives, in
// its own words, for Journey ("every authenticated user owns their own learner
// profile"), Practice, Progress, Readiness, Engagement, Interviews and Voice —
// and this module adds nothing to the closed permission set, exactly as none of
// those did.
//
// It is worth being precise about WHY that reasoning transfers rather than just
// noting that it does. There is no "read another learner's English progress"
// and no "submit an attempt on someone else's behalf" ACTION on this surface
// for a permission to gate in the first place: no route here takes a user id by
// path, query or body — `@CurrentUser('id')` is the only source of one, and the
// request DTO carries a compile-time proof that no identity-shaped field crept
// into it. An Admin gets no special path either; `EnglishService` has no "read
// any learner's attempts" method for a future controller to reach for.
//
// -----------------------------------------------------------------------------
// A SENTENCE IS SHARED CONTENT. AN ATTEMPT IS NOT.
// -----------------------------------------------------------------------------
//
// `english_sentences` has no owner — every learner reads the same bank, exactly
// as they read the same `civics_questions` — so `POST /attempts` resolves a
// sentence by id with no owner filter, and an unknown id is a 404 because it
// genuinely does not exist rather than because it belongs to somebody else.
//
// `english_attempts` rows are private, and they are protected structurally
// rather than by a check: NO ROUTE ON THIS MODULE ACCEPTS AN ATTEMPT ID. There
// is no read-one-attempt endpoint, no self-mark, and no update — the only ways
// a row is written or read are `POST /attempts` (which stamps the caller's own
// id) and `GET /progress` (which filters on it in the `where`). Cross-user
// access is not refused here; it has no expressible request.
// =============================================================================

/**
 * The `{ data: … }` envelope, written out by hand around a `oneOf`.
 *
 * `applyDataEnvelope` (src/openapi/data-envelope.ts) wraps every documented 2xx
 * JSON body to match what the global `TransformInterceptor` really sends, but
 * deliberately SKIPS `oneOf`/`allOf`/`anyOf` schemas rather than guessing at
 * them. The attempt response is a union, so the pass leaves it alone and the
 * document would otherwise promise a bare `{ status, … }` while the server
 * sends `{ data: { status, … } }`. Copied field for field from
 * `ai-speech.controller.ts`, which solves the identical problem for the
 * identical reason.
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

@ApiTags('English')
// The two attempt-response variants are referenced by `$ref` from the
// hand-written `oneOf` below, so nothing else in the document would pull them
// in and they would be dangling references to schemas never published.
@ApiExtraModels(EnglishAttemptScoredDto, EnglishAttemptMisheardDto)
@Controller('english')
export class EnglishController {
  constructor(private readonly englishService: EnglishService) {}

  @Get('next')
  @Auth()
  @ApiQuery({ name: 'kind', required: true, enum: ['reading', 'writing'] })
  @ApiOperation({
    summary: 'The next sentence to read aloud or to write from dictation',
    description:
      "One sentence, chosen for **you**, from the bank for the requested segment.\n\n" +
      '**Selection is deterministic** — no randomness anywhere — and weighted by bucket, ' +
      'in this order: sentences you have **never tried** (by their composed order), then ' +
      'ones whose most recent outcome was **incorrect**, then **partial**, then ' +
      '**correct** — each of the last three least-recently-seen first. So every sentence ' +
      'is seen before any is repeated, and a sentence you missed comes back before one ' +
      'you passed.\n\n' +
      'The sentence you answered **most recently** is skipped, unless it is the only one ' +
      'available: being handed back the sentence you just submitted (and were just shown ' +
      'the answer to) measures nothing.\n\n' +
      'Only the **current vocabulary revision** is drawn from. A future revision of the ' +
      'USCIS vocabulary lists ships as new sentence rows and supersedes the old bank ' +
      'cleanly; `version` tells a client which bank it is holding.\n\n' +
      '`sentence` is `null` when no sentences are loaded for this segment — an honest ' +
      'absence, not a 404: the request was valid and the answer is that the bank is empty.\n\n' +
      '**`text` is returned for both segments, writing included.** Dictation defaults to ' +
      "the browser's own speech synthesis, which needs the string client-side and needs no " +
      'AI key, no admin configuration and no per-call cost. The writing screen must never ' +
      'render it — a learner who can see the sentence is copying it, not writing English ' +
      'they heard — but that is an invariant of the screen, not of the wire.\n\n' +
      "`wordCount` is the **scorer's** own token count (`normalizeAnswer`'s output), not " +
      'a naive space split: "President of the United States" is one token to the scorer, ' +
      'so a client counting words itself would show a number the outcome was not computed ' +
      'against.',
  })
  @ApiDataResponse(EnglishNextDto, {
    description: 'The next sentence, or `{ "sentence": null }` when the bank is empty',
  })
  getNext(
    @Query() query: EnglishNextQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<EnglishNextResponse> {
    return this.englishService.getNext(userId, query.kind);
  }

  @Post('attempts')
  @Auth()
  // 200, not the 201 a POST defaults to. The `misheard` branch creates NOTHING
  // (see below), so a fixed 201 would announce a resource that does not exist
  // — and varying the status by branch would make the client read the code
  // instead of the `status` field the response is discriminated on.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit one reading or writing attempt',
    description:
      'Scores what you produced against the sentence, word by word, and — unless the ' +
      'recording was not trusted — records it.\n\n' +
      '**You never send the verdict.** There is no `outcome`, `wer` or `diffOps` field on ' +
      'this request; scoring runs on the server against the sentence text, and `kind` is ' +
      "read from the sentence rather than from the body. Unknown keys are rejected.\n\n" +
      '**Scoring (both segments, identical rule).** Both sides are normalised the same way ' +
      'civics answers are, then aligned word by word. `errors` is checked **first** and the ' +
      'word-error rate only bounds the single-error case: zero errors, or one error on a ' +
      'sentence long enough that it costs no more than a third of it, is `correct`; ' +
      'anything up to half wrong is `partial`; past that is `incorrect`. One word wrong is ' +
      'not a failure; two words wrong is not reading the sentence.\n\n' +
      '**Read `status`.** `scored` carries the `attemptId` and `outcome` of the row that ' +
      `was written. \`misheard\` means the recogniser reported confidence below ` +
      `${ASR_CONFIDENCE_THRESHOLD} on a reading attempt that did not score correct — and ` +
      '**no attempt row was written at all**. Nothing is recorded as a failure, because a ' +
      'transcript we do not believe is not weak evidence of your reading, it is none; ' +
      're-record or type the sentence instead. **Both are HTTP 200** — a mishearing is not ' +
      'a client error, and the response carries the diff so you can see what was heard.\n\n' +
      '**`asrConfidence` is reading-only, and absent means unknown — never send `0`.** Many ' +
      'transcription models report no confidence at all; a transcript with none is scored ' +
      'and recorded normally. Sending it on a writing attempt is a 400: a typed answer was ' +
      'not transcribed.\n\n' +
      '**`replayCount` is writing-only and gates nothing.** How many times you asked to ' +
      'hear the dictated sentence again is recorded because needing several repeats is ' +
      'itself worth knowing — it never changes your outcome and there is no limit. Sending ' +
      'a non-zero count on a reading attempt is a 400: a reading sentence is shown, not ' +
      'dictated.\n\n' +
      'The response carries the sentence `text` for both segments. On a **writing** ' +
      'attempt this is the reveal — the first time you see the sentence you were dictated, ' +
      'beside your own words and the diff between them.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The score, and whether it was recorded. Read `status`: `scored` wrote a row, ' +
      '`misheard` wrote nothing.',
    schema: envelopedOneOf(EnglishAttemptScoredDto, EnglishAttemptMisheardDto),
  })
  @ApiResponse({
    status: 400,
    description:
      '`asrConfidence` on a writing attempt, a non-zero `replayCount` on a reading ' +
      'attempt, an unknown key, or a response longer than 2000 characters',
  })
  @ApiResponse({ status: 404, description: 'No such sentence' })
  recordAttempt(
    @Body() dto: RecordEnglishAttemptDto,
    @CurrentUser('id') userId: string,
  ): Promise<EnglishAttemptResult> {
    return this.englishService.recordAttempt(userId, dto);
  }

  @Get('progress')
  @Auth()
  @ApiOperation({
    summary: "Your own reading and writing progress",
    description:
      'Your history with the English bank, at three grains.\n\n' +
      '`sentences` — every sentence in the current bank, **attempted or not**, with how ' +
      'many attempts you have made, your **best** outcome ever and your **latest** one. ' +
      'Both are reported because they answer different questions: passing a sentence in ' +
      'March and slipping on it yesterday is not the same as never having passed it.\n\n' +
      '`vocabTags` — the same evidence rolled up by **USCIS vocabulary category** ' +
      '(`PEOPLE`, `CIVICS`, `PLACES`, …). This is the view a single sentence cannot give ' +
      'you: three failed sentences all tagged `PLACES` is a specific gap, not three ' +
      'unrelated misses. A sentence counts toward every category its own words draw on, ' +
      'so these totals deliberately sum to more than the bank size.\n\n' +
      '`byKind` — reading and writing totals, always both, with the mean word-error rate ' +
      'across your attempts. `averageWer` is `null` — never `0` — when you have made none: ' +
      'a mean of zero is a perfect record, the opposite of no record.\n\n' +
      'Scoped to the current vocabulary revision, the same bank `GET /english/next` draws ' +
      'from, so the two can never disagree about which sentences exist.',
  })
  @ApiDataResponse(EnglishProgressDto, {
    description: "The caller's own English progress, by sentence, by vocabulary tag, and by segment",
  })
  getProgress(
    @CurrentUser('id') userId: string,
  ): Promise<EnglishProgressResponse> {
    return this.englishService.getProgress(userId);
  }
}
