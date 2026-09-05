import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CivicsService } from '../civics/civics.service';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// TranscriptionContextService (issue #348, epic #345 — E15)
// =============================================================================
//
// The two accuracy levers `POST /api/ai/speech/transcribe` was leaving unpulled:
// the LANGUAGE the audio is in, and the VOCABULARY it is likely to contain.
// Both are resolved here, on the server, from rows this caller already owns.
//
// -----------------------------------------------------------------------------
// EVERYTHING THIS FILE PRODUCES IS A HINT. NOTHING IT PRODUCES IS A RULE.
// -----------------------------------------------------------------------------
//
// A recogniser handed a language and a glossary is more likely to spell
// `Woodrow Wilson` correctly and less likely to decide a heavily-accented
// English answer was Portuguese. It is not any less able to return words that
// appear in neither. That property is the whole reason this file is allowed to
// exist: "help it hear correctly" and "tell it what to hear" are one edit
// apart, and the second one would hand the grading ladder its own answer back
// and call the result evidence.
//
// So, stated once and enforced by there being no code that could do otherwise:
//
//   * nothing here compares a transcript to the prompt it built,
//   * nothing here retries, filters or rewrites a transcript that does not
//     match, and
//   * no caller of this service is given the prompt back to do any of that.
//
// `buildRecognitionPrompt` returns a string and is never handed one to check.
//
// -----------------------------------------------------------------------------
// THE PROMPT IS BUILT FROM ROWS, NEVER FROM A REQUEST FIELD
// -----------------------------------------------------------------------------
//
// The only input a client supplies is a civics question ID, which is RESOLVED
// here — through `CivicsService.getQuestion`, the same method
// `GET /api/civics/questions/{id}` serves that caller, applying that caller's
// own state to a state-scoped answer. Nothing a client typed reaches the
// provider. This is `CLAUDE.md`'s grounding rule ("build the prompt from rows
// your feature already reads") applied to recognition, and it is the identical
// posture `GET /api/ai/speech/audio` takes for synthesis: the request names
// CONTENT, never text.
//
// An unknown question ID is NOT a refusal. See `resolvePrompt` — a learner's
// recording has already been uploaded and paid for by the time this runs, and
// spending it to punish a stale hint would be the worst possible trade.
//
// -----------------------------------------------------------------------------
// WHY THIS LIVES BESIDE THE SPEECH SERVICE INSTEAD OF INSIDE IT
// -----------------------------------------------------------------------------
//
// `AiSpeechService` is provided by `AiModule`, and `AiModule` cannot import
// `CivicsModule` — `CivicsModule` already imports `AiModule`, so the pair would
// be a cycle (`speech-audio.module.ts` documents that in full, and is the
// module that provides this class). `SpeechAudioService` solved the identical
// problem the identical way for `GET /api/ai/speech/audio`; this is the second
// instance of the same shape, not a new one.
// =============================================================================

/**
 * The language sent when nothing better is known: English.
 *
 * The civics interview is conducted in English, the questions are in English
 * and the accepted answers are in English, so an English recording is what this
 * endpoint is overwhelmingly handed. Sending it is a strict improvement on
 * sending nothing — the failure this fixes is a recogniser auto-detecting a
 * strongly-accented English answer as some other language and transcribing it
 * into words the grader has no chance with.
 */
export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'en';

/**
 * The longest biasing prompt this service will build, in characters.
 *
 * OpenAI documents the transcription `prompt` as bounded at 224 TOKENS and
 * silently truncates from the FRONT past that — which would drop the question
 * and keep a tail of the answer list, the opposite of what is wanted. 640
 * characters sits comfortably inside 224 tokens for English text at any
 * plausible ratio, so the truncation this file performs is the only one that
 * happens, and it drops WHOLE TERMS from the end rather than cutting a proper
 * noun in half (a half-spelled `Woodrow Wil` is worse than no hint at all).
 *
 * Reachable with today's content: the "name one state that borders Canada"
 * question carries thirteen answers.
 */
export const MAX_RECOGNITION_PROMPT_CHARS = 640;

/** What a transcription request gets from the server, and never from a client. */
export interface TranscriptionContext {
  /**
   * ISO-639-1, e.g. `'en'`. Always set — see
   * {@link DEFAULT_TRANSCRIPTION_LANGUAGE}.
   */
  languageHint: string;

  /**
   * The glossary, or `undefined` when there is nothing to bias with — no
   * question was named, the id resolved to nothing, or the question has no
   * currently-open answers and a bare prompt was not worth sending.
   */
  prompt?: string;
}

/**
 * The language to tell the recogniser the audio is in.
 *
 * -----------------------------------------------------------------------------
 * IT DESCRIBES THE AUDIO. IT IS NOT "the learner's preferred language".
 * -----------------------------------------------------------------------------
 *
 * This distinction is the whole function, and getting it backwards is an
 * accuracy REGRESSION rather than a missing feature: `language` tells the
 * decoder what to hear, so pinning `es` for a learner who is speaking English
 * with a Spanish accent asks it to render English audio as Spanish words. That
 * is strictly worse than the auto-detection we have today.
 *
 * `learner_profiles.explanation_language` is not that field. Its own schema doc
 * says so — "Governs AI explanations only; questions stay in English" — so it
 * cannot simply be forwarded.
 *
 * -----------------------------------------------------------------------------
 * THE ONE CASE WHERE IT REALLY IS THE SPOKEN LANGUAGE
 * -----------------------------------------------------------------------------
 *
 * A learner claiming the 65/20 accommodation (`learner_profiles.senior_exemption`)
 * is, by USCIS's own rule, entitled to take the civics test IN THE LANGUAGE OF
 * THEIR CHOICE. For exactly that learner, "which language will I answer in"
 * has already been asked and answered — it is `explanation_language` — and the
 * profile carries no second field to ask it twice. Issue #348 forbids adding
 * one, and rightly: a new setting asking a question the profile already holds
 * the answer to is a worse product, not a more precise one.
 *
 * So the rule is two profile columns, and it is not a constant:
 *
 *   senior_exemption = false                -> `en`
 *   senior_exemption = true, es-MX          -> `es`
 *   senior_exemption = true, en             -> `en`
 *   senior_exemption = true, malformed/none -> `en`
 *
 * NEITHER BRANCH CAN MAKE ANYTHING WORSE THAN TODAY. A non-senior learner is
 * pinned to the language the material is written in, replacing a guess. A
 * senior learner answering in Spanish is already transcribed as Spanish by
 * auto-detection today; naming it only makes that reliable.
 *
 * PURE, and exported, so the rule above is a test rather than a claim.
 */
export function resolveTranscriptionLanguage(profile: {
  explanationLanguage: string | null;
  seniorExemption: boolean;
}): string {
  if (!profile.seniorExemption) return DEFAULT_TRANSCRIPTION_LANGUAGE;

  return primaryLanguageSubtag(profile.explanationLanguage);
}

/**
 * The ISO-639-1 code inside a BCP-47 tag, or the default.
 *
 * `es-MX` -> `es`; `en` -> `en`; `zh-Hant-TW` -> `zh`. Anything that is not two
 * ASCII letters after that — a three-letter ISO-639-3 code, a private-use tag,
 * an empty string, a value written before validation existed — falls back
 * rather than being forwarded: the provider parameter is documented as
 * ISO-639-1, and an unrecognised value is likelier to be rejected or ignored
 * than helpful.
 */
function primaryLanguageSubtag(tag: string | null | undefined): string {
  const primary = (tag ?? '').trim().split('-')[0]?.toLowerCase() ?? '';

  return /^[a-z]{2}$/.test(primary)
    ? primary
    : DEFAULT_TRANSCRIPTION_LANGUAGE;
}

/**
 * Build the glossary one civics question is worth biasing with.
 *
 * -----------------------------------------------------------------------------
 * THE RULE, IN FULL — the construction is the specification
 * -----------------------------------------------------------------------------
 *
 *  1. The terms are the question's own prompt, then each currently-accepted
 *     answer's text, IN THAT ORDER. The question comes first because it is what
 *     survives {@link MAX_RECOGNITION_PROMPT_CHARS}, and because it is the one
 *     term that is never itself an answer — a glossary made only of answers
 *     leans harder on the outcome than one that also carries the words being
 *     asked about.
 *  2. Each term is whitespace-collapsed and stripped of control characters. It
 *     is NOT otherwise rewritten: these are our own rows, and a
 *     "sanitiser" that dropped punctuation would turn `the Bill of Rights`
 *     into a worse hint than the row it came from.
 *  3. Empty terms are dropped; duplicates are dropped case-insensitively,
 *     keeping the first occurrence. Repeating a term does not bias harder, it
 *     only spends the budget twice.
 *  4. Terms are joined with `', '` and the string is closed with `'.'`, which
 *     is the shape providers document for a vocabulary hint — a list, not an
 *     instruction. There is deliberately NO framing sentence ("the answer is
 *     one of the following", "transcribe only these words"): a prompt is prior
 *     context, so a sentence in it can be CONTINUED into the transcript, and an
 *     instruction in it is the constraint this whole file exists not to send.
 *  5. Whole terms are dropped from the END until the result fits
 *     {@link MAX_RECOGNITION_PROMPT_CHARS}. Never a mid-term cut.
 *
 * `undefined` when nothing survives — an empty prompt field is not sent.
 *
 * A QUESTION WITH NO ANSWERS STILL PRODUCES A HINT. A state-scoped question
 * asked by a learner with no state set resolves to zero answers
 * (`answerResolution: 'state_required'`), and the question's own words are
 * still worth biasing with: nothing about that state prevents the learner from
 * speaking.
 *
 * PURE, so the rule above is exercised directly rather than through an upload.
 */
export function buildRecognitionPrompt(input: {
  questionPrompt: string;
  acceptedAnswers: readonly string[];
}): string | undefined {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of [input.questionPrompt, ...input.acceptedAnswers]) {
    const term = normaliseTerm(raw);

    if (term.length === 0) continue;

    const key = term.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    terms.push(term);
  }

  while (terms.length > 0 && joinTerms(terms).length > MAX_RECOGNITION_PROMPT_CHARS) {
    terms.pop();
  }

  return terms.length === 0 ? undefined : joinTerms(terms);
}

/** One term, flattened onto a single line. See rule 2. */
function normaliseTerm(raw: string | null | undefined): string {
  return (
    (raw ?? '')
      // Control characters become SPACES rather than being deleted, so a term
      // carrying one reads as two words rather than as a single run-together
      // token. The collapse below then tidies the result up.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** See rule 4. A list, closed with a full stop — never a sentence. */
function joinTerms(terms: readonly string[]): string {
  return `${terms.join(', ')}.`;
}

@Injectable()
export class TranscriptionContextService {
  private readonly logger = new Logger(TranscriptionContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    // `CivicsService.getQuestion` — the ONE implementation of answer resolution
    // in this codebase (`docs/specs/civics-content.md` §5). The bias is built
    // from what a learner would actually be marked against, resolved for their
    // own state, rather than from a second query written for recognition.
    private readonly civics: CivicsService,
  ) {}

  /**
   * Everything the recogniser should be told about this caller's recording.
   *
   * NEVER THROWS FOR A HINT'S SAKE — see {@link resolvePrompt}. The two halves
   * are resolved in parallel because neither depends on the other and a learner
   * is holding a finished recording while this runs.
   *
   * @param userId the caller. The only source of one — no route on this
   *        controller accepts a user id, and neither does this method.
   * @param questionId the civics question being answered, when the client knows
   *        it. Optional: transcription is a general-purpose route and plenty of
   *        callers (English reading practice, a free-form recording) have no
   *        question at all.
   */
  async resolve(
    userId: string,
    questionId?: string,
  ): Promise<TranscriptionContext> {
    const [languageHint, prompt] = await Promise.all([
      this.resolveLanguage(userId),
      this.resolvePrompt(userId, questionId),
    ]);

    return { languageHint, prompt };
  }

  /**
   * The caller's own two profile columns, run through
   * {@link resolveTranscriptionLanguage}.
   *
   * A MISSING PROFILE IS ORDINARY. The row is created lazily on the first
   * `GET /api/journey/profile`, so a learner can reach a microphone without one
   * existing yet; the default applies, and nothing is written here — pressing
   * record must not create a profile row any more than pressing play may
   * (`SpeechAudioService.resolveVoice`'s own rule).
   */
  private async resolveLanguage(userId: string): Promise<string> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { explanationLanguage: true, seniorExemption: true },
    });

    // FALSY, NOT `=== null`. A learner with no row yet is the ordinary case
    // this handles; a test double or a future client returning `undefined`
    // for the same "no row" is the same fact, and reading two columns off it
    // would be a `TypeError` on a path that must never cost a recording.
    if (!profile) return DEFAULT_TRANSCRIPTION_LANGUAGE;

    return resolveTranscriptionLanguage(profile);
  }

  /**
   * The glossary for one civics question, resolved for this caller.
   *
   * -------------------------------------------------------------------------
   * A HINT THAT CANNOT BE RESOLVED IS DROPPED, NOT REPORTED
   * -------------------------------------------------------------------------
   *
   * By the time this runs the recording is already in memory: the learner has
   * spoken, waited, and uploaded. Refusing the whole request because a question
   * id was stale — a client holding an id from a session the content load has
   * since replaced — would cost them their answer to improve nothing. So a
   * `NotFoundException` from `CivicsService.getQuestion` is swallowed, logged at
   * debug, and the transcription proceeds unbiased, which is exactly the
   * behaviour every caller had before this field existed.
   *
   * EVERYTHING ELSE IS RETHROWN, deliberately. A database outage is not a stale
   * hint, and swallowing it here would turn an incident into a quiet,
   * deployment-wide accuracy regression with nothing in the logs shaped like a
   * cause.
   */
  private async resolvePrompt(
    userId: string,
    questionId?: string,
  ): Promise<string | undefined> {
    if (questionId === undefined) return undefined;

    try {
      const question = await this.civics.getQuestion(userId, questionId);

      return buildRecognitionPrompt({
        questionPrompt: question.prompt,
        acceptedAnswers: question.answers.map((answer) => answer.text),
      });
    } catch (err) {
      if (err instanceof NotFoundException) {
        // THE ID, NEVER THE TRANSCRIPT OR THE AUDIO. Nothing on this path logs
        // a learner's words; a question id is our own content's primary key.
        this.logger.debug(
          `No recognition bias: civics question "${questionId}" was not found`,
        );

        return undefined;
      }

      throw err;
    }
  }
}
