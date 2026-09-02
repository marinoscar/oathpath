import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// The question shape practice serves BEFORE an answer has been earned (#73)
// =============================================================================
//
// -----------------------------------------------------------------------------
// THIS DTO EXISTS SO THAT ANSWERS CANNOT LEAVE THE SERVER BY ACCIDENT
// -----------------------------------------------------------------------------
//
// `id`, `number`, `prompt`, `categoryId`, `dynamicScope`. Nothing else. No
// `answers`, no `acceptedAnswers`, no `verifiedAt`, no `answerResolution` —
// not even an empty array standing in for "not yet", because an empty array is
// a field a later edit fills in.
//
// It is a SEPARATE TYPE from `PracticeAttemptDto`'s `acceptedAnswers` (and from
// civics' `CivicsQuestionDetailDto`, which does carry answers) rather than the
// same type with the answers left blank. That is the whole point: a handler
// that returns this type CANNOT return an answer, because the type has nowhere
// to put one. Reusing `CivicsQuestionDetailDto` here and remembering to blank
// its `answers` would be a convention, and a convention is one careless spread
// away from shipping the answer key to a learner who has not answered yet.
//
// **This is a product constraint before it is a security one.** `VISION.md` is
// explicit that recognition is not preparation: a learner who reads the
// accepted answer in the same payload that carries the prompt has not
// recalled anything, and the whole of E3 exists to make them PRODUCE an
// answer rather than recognise one. A page that had the answers in its network
// tab would not be a leak of anything secret — the civics answer key is public
// exam content, freely readable at `GET /api/civics/questions/:id` — it would
// be a practice product that quietly stopped measuring practice. That failure
// is invisible in every test that only checks status codes, so it is prevented
// structurally here instead.
//
// The answers become legitimate the instant the attempt is graded: they come
// back on `POST .../attempts` as `acceptedAnswers`, and frozen forever in the
// attempt's own `answerSnapshot`. Earned, then shown — never before.
//
// `testVersionCode` is deliberately absent too, unlike `CivicsQuestionSummary`,
// which carries it. There it exists because that list can span two banks; here
// the enclosing session already names exactly one (`practice_sessions.
// test_version_code`), so repeating it on every question would be a second
// place the same fact is stated, and a second place it could disagree.
// =============================================================================

/** The three values of the `CivicsDynamicScope` Postgres enum, on the wire. */
export const practiceDynamicScopeSchema = z.enum(['none', 'national', 'state']);

export const practiceQuestionSchema = z.object({
  id: z.uuid(),

  /** The official question number within its version — `1..100` on `v2008`. */
  number: z.number().int(),

  /** The question text, verbatim from the official source. */
  prompt: z.string(),

  categoryId: z.uuid(),

  /**
   * How this question's answers vary — `none`, `national`, or `state`.
   *
   * Present so a client can label a dynamic question ("this one changes")
   * without a second round trip. It is a property of the QUESTION, fixed when
   * the content was transcribed (civics-content.md §2.2), so it reveals
   * nothing about the answer itself.
   *
   * A learner with no `state_code` will never see `state` here from a practice
   * route: those questions are removed from the candidate pool before
   * selection (`question-selection.ts`), rather than served and then graded
   * against an answer set that could not be resolved.
   */
  dynamicScope: practiceDynamicScopeSchema,
});

export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;

export class PracticeQuestionDto extends createZodDto(practiceQuestionSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no answer-shaped field crept into this DTO
// -----------------------------------------------------------------------------
//
// The technique is `ai/ai-settings.schema.ts`'s no-secret-fields proof and
// `journey/dto/update-journey-profile.dto.ts`'s no-identity-fields proof, aimed
// at this module's own hazard. Adding any of the names below to the schema
// above makes `PracticeQuestionCarriesNoAnswer` resolve to `never` and this
// file stops compiling — a build break at the moment of the mistake, rather
// than a code review that has to notice one new optional field on a DTO whose
// name does not say it is answer-free.
//
// It is worth a proof rather than a convention because the failure is silent
// and total: the endpoint keeps returning 200, every test keeps passing, and
// the product stops being a practice product. Nothing in a status code says so.
//
// If you are here because this line went red: you are adding the answer key to
// the payload that carries the prompt. The answers belong on the attempt
// response (`acceptedAnswers`) and in `answerSnapshot`, after grading.

type ForbiddenAnswerFieldNames =
  | 'answers'
  | 'acceptedAnswers'
  | 'answer'
  | 'answerText'
  | 'correctAnswer'
  | 'answerSnapshot'
  | 'answerResolution'
  | 'verifiedAt';

export type PracticeQuestionCarriesNoAnswer = Extract<
  keyof PracticeQuestion,
  ForbiddenAnswerFieldNames
> extends never
  ? true
  : never;

export const PRACTICE_QUESTION_CARRIES_NO_ANSWER: PracticeQuestionCarriesNoAnswer =
  true;
