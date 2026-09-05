import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MAX_RESPONSE_LENGTH } from '../answer-matching';
import {
  END_SESSION_REASONS,
  type EndSessionReason,
} from '../realtime/practice-realtime-tools';
import type {
  PracticeRealtimeRejectionReason,
  PracticeRealtimeToolCall,
  PracticeRealtimeToolName,
} from '../realtime/practice-realtime-tool-calls';

// =============================================================================
// POST /api/practice/sessions/:id/realtime/tool-calls — the wire (issue #354)
// =============================================================================
//
// One route for all five tools, discriminated on `tool` — the identical shape
// `interviews/dto/interview-tool-call.dto.ts` uses for its own three, and for
// the three reasons that file gives, every one of which holds here unchanged:
// the browser is a RELAY that needs no per-tool knowledge, all five refusals
// answer the same question (what does this session's state permit right now),
// and one route means one ownership-scoped `getSession` call rather than five.
//
// -----------------------------------------------------------------------------
// THE REQUEST MIRRORS `practice-realtime-tools.ts`' SCHEMAS AND WIDENS NOTHING
// -----------------------------------------------------------------------------
//
// The provider validates the MODEL's arguments against the JSON Schema the
// session was minted with; this validates what the BROWSER relays. Both layers
// are needed and neither is redundant: the provider's `additionalProperties:
// false` stops the model from expressing a verdict, and this stops anything
// else from being posted to this route at all — a browser is a program a person
// can modify, and a realtime tool result is not the only way to reach an HTTP
// endpoint.
//
// `z.strictObject` plus the per-tool refinement below means the set of bodies
// this route accepts is exactly the union of the five tools' declared arguments
// and nothing else. A `verdict` is a 400 naming the field rather than an
// ignored extra sitting in an unvalidated bag a later handler could start
// reading, and a `transcript` posted with `skip_question` — the shape a
// mis-heard silence would take if a client tried to launder it into a graded
// answer — is a 400 too.
//
// -----------------------------------------------------------------------------
// THERE IS NO USER ID FIELD, AND THERE NEVER WILL BE
// -----------------------------------------------------------------------------
//
// Same rule and same mechanism as `record-attempt.dto.ts`: the learner is
// `@CurrentUser('id')`, the session is resolved by
// `PracticeService.requireSession` filtering on that id in the `where`, and the
// proof at the bottom of this file names every identity-shaped and
// verdict-shaped field that must never appear.
// =============================================================================

/**
 * One tool call: the tool's name, plus the arguments THAT tool declares.
 *
 * A FLAT OBJECT WITH A REFINEMENT, NOT A DISCRIMINATED UNION, for the reason
 * `interview-tool-call.dto.ts` states: `createZodDto` builds a CLASS, a class
 * cannot extend a union (TS2509), and the global `ZodValidationPipe` needs
 * exactly one DTO class to validate against.
 *
 * The refinement is not a weaker substitute for a union — on the property that
 * matters it is stricter. A union accepts each variant's own fields and says
 * nothing about a field belonging to a different variant arriving on this one;
 * this rejects that outright.
 */
export const practiceToolCallSchema = z
  .strictObject({
    /** Which of the five tools this call is. */
    tool: z.enum([
      'next_question',
      'grade_answer',
      'repeat_question',
      'skip_question',
      'end_session',
    ]),

    /**
     * `grade_answer` and `skip_question` only — WHICH question this is about.
     *
     * COMPARED, NEVER TRUSTED AS A SELECTION. `decideGradeAnswer` and
     * `decideSkipQuestion` check it against the question the session is
     * actually waiting on and refuse a mismatch (`wrong_question`), because on
     * this path a mis-attribution is not a confusing sentence — it is a
     * `practice_attempts` row and a `question_mastery` update about a question
     * the learner was never asked.
     */
    questionId: z.uuid().optional(),

    /**
     * `grade_answer` only — what the learner said, as the model heard it.
     *
     * Bounded at {@link MAX_RESPONSE_LENGTH}, the same 2000 characters
     * `responseText` is bounded at on the ordinary attempt route, because this
     * string BECOMES that column: the handler passes it to
     * `PracticeService.recordAttempt` as both `responseText` and `transcript`.
     * A different bound here would let one transport store what the other
     * refuses.
     *
     * A BLANK ONE IS ACCEPTED BY THE SCHEMA AND REFUSED BY THE ENGINE, with
     * `empty_transcript` and an instruction to ask again. That split is
     * deliberate: a 400 would be flattened by the relay into generic failure
     * handling, and the instruction — the sentence that keeps the learner from
     * losing their turn — would never reach the model. See
     * `emptyTranscriptRejection`.
     */
    transcript: z.string().max(MAX_RESPONSE_LENGTH).optional(),

    /**
     * `end_session` only — why the model believes the session is ending.
     *
     * The enum is `END_SESSION_REASONS`, imported from the same constant the
     * session was minted with, so this route and the model's own schema cannot
     * disagree about which reasons exist. `learner_asked` is believed;
     * `no_questions_left` is VERIFIED against the session's own state and
     * refused when it is false (`questions_remain`).
     */
    reason: z.enum(END_SESSION_REASONS).optional(),
  })
  .superRefine((value, ctx) => {
    const required: Record<string, readonly string[]> = {
      next_question: [],
      grade_answer: ['questionId', 'transcript'],
      repeat_question: [],
      skip_question: ['questionId'],
      end_session: ['reason'],
    };

    for (const field of required[value.tool]) {
      if ((value as Record<string, unknown>)[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for the ${value.tool} tool`,
        });
      }
    }

    for (const field of ['questionId', 'transcript', 'reason']) {
      if (
        (value as Record<string, unknown>)[field] !== undefined &&
        !required[value.tool].includes(field)
      ) {
        // REJECTED, NOT IGNORED. A field this tool does not declare is a field
        // the provider's own schema would have refused one layer up, and
        // accepting it here would make the tool contract a statement about one
        // transport rather than about the practice session.
        //
        // `required` is reused as the allow-list rather than a second map:
        // every one of the five tools declares exactly the arguments it
        // requires and no optional ones, so two maps would be two copies of
        // one fact, free to disagree the day a tool gains an optional field.
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} does not belong to the ${value.tool} tool`,
        });
      }
    }
  });

export type PracticeToolCallInput = z.infer<typeof practiceToolCallSchema>;

export class PracticeToolCallDto extends createZodDto(practiceToolCallSchema) {}

/**
 * The validated body, as the discriminated shape the pure rules take.
 *
 * THE RETURN TYPE IS THE PROOF. `PracticeRealtimeToolCall` is
 * `practice-realtime-tool-calls.ts`' own input type, so a field renamed or a
 * sixth tool added on either side of this boundary is a compile error here
 * rather than a runtime surprise on a live connection. The non-null assertions
 * are sound because {@link practiceToolCallSchema}'s refinement has already
 * rejected a call missing its tool's required arguments — this function only
 * ever runs on a body that passed it.
 */
export function narrowPracticeToolCall(
  input: PracticeToolCallInput,
): PracticeRealtimeToolCall {
  switch (input.tool) {
    case 'next_question':
      return { tool: 'next_question' };
    case 'grade_answer':
      return {
        tool: 'grade_answer',
        questionId: input.questionId as string,
        transcript: input.transcript as string,
      };
    case 'repeat_question':
      return { tool: 'repeat_question' };
    case 'skip_question':
      return { tool: 'skip_question', questionId: input.questionId as string };
    case 'end_session':
      return { tool: 'end_session', reason: input.reason as EndSessionReason };
  }
}

// -----------------------------------------------------------------------------
// The results, as OpenAPI shapes
// -----------------------------------------------------------------------------
//
// ONE DTO CLASS PER UNION MEMBER, never one per union — `createZodDto` builds a
// class and a class cannot extend a union, so the controller composes these
// with `oneOf` plus a `status` discriminator, exactly as it already does for
// the mint route's three statuses.
//
// These are documentation shapes only; the service returns
// `PracticeRealtimeToolResponse`'s own interfaces, and the proof at the bottom
// of this file is what keeps the request half honest about the one property
// that matters.

export class PracticeToolCallOkDto extends createZodDto(
  z.object({
    status: z.literal('ok'),
    tool: z.string(),
    /** The lines to speak, in order, verbatim. Never a summary of an outcome. */
    say: z.array(z.string()),
    /** The action the engine chose — an action name, never an outcome name. */
    then: z.enum(['await_answer', 'ask_next_question', 'session_complete']),
    /** The question now outstanding, or null. A join key, never a verdict. */
    questionId: z.string().nullable(),
  }),
) {}

export class PracticeToolCallRejectedDto extends createZodDto(
  z.object({
    status: z.literal('rejected'),
    tool: z.string(),
    /** A stable, GROUP-able code from the closed set. Never a message. */
    reason: z.string(),
    /** What was wrong, as prose the model can act on. */
    error: z.string(),
    /** What to do INSTEAD — the field that gets the session moving again. */
    instruction: z.string(),
  }),
) {}

// -----------------------------------------------------------------------------
// Compile-time proofs
// -----------------------------------------------------------------------------
//
// Three, and they point in three different directions across the tool boundary.

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

// (1) NOTHING THE MODEL SENDS MAY NAME A USER OR A GRADE.
//
// `practice-realtime-tools.ts` proves the declared SCHEMA has no verdict and no
// confidence field; this proves the parsed BODY has neither either, which is
// the shape a handler actually reads. They are not redundant — a field added to
// this DTO is not a field added to that schema, and this is the one an HTTP
// request can reach.
//
// `questionId` and `transcript` are deliberately absent from the list: the
// first is compared against what the session says is outstanding rather than
// acted on, and the second is an observation about the audio, which is the one
// thing the model genuinely is the authority on.
//
// `confidence` IS on the list, and its presence here is the whole reason this
// contract is narrower than the interview's: on this transport the number would
// be the model reporting its own certainty about its own hearing, not a
// recogniser's calibrated measurement, and `isMisheardAttempt` would let it
// suppress a mastery-scheduling update (`realtime-practice.md` §3).

type ForbiddenPracticeToolCallFieldNames =
  | 'userId'
  | 'user_id'
  | 'learnerId'
  | 'email'
  | 'sessionId'
  | 'attemptId'
  | 'verdict'
  | 'grade'
  | 'outcome'
  | 'correct'
  | 'isCorrect'
  | 'score'
  | 'passed'
  | 'result'
  | 'assessment'
  | 'evaluation'
  | 'failureCause'
  | 'gradingMethod'
  | 'revealed'
  | 'confidence'
  | 'asrConfidence'
  | 'plannedCount'
  | 'testVersionCode';

export type PracticeToolCallNamesNoIdentityOrVerdict = Extract<
  KeysOfUnion<PracticeToolCallInput>,
  ForbiddenPracticeToolCallFieldNames
> extends never
  ? true
  : never;

export const PRACTICE_TOOL_CALL_NAMES_NO_IDENTITY_OR_VERDICT: PracticeToolCallNamesNoIdentityOrVerdict =
  true;

// (2) THE TOOL NAMES ON THE WIRE ARE EXACTLY THE TOOL NAMES THE RULES KNOW.
//
// Assignability in BOTH directions, so the two are the same set rather than
// merely overlapping. A sixth tool declared in `practice-realtime-tools.ts`
// that this route cannot accept, and a name accepted here that no rule handles,
// are both build breaks. `narrowPracticeToolCall`'s return type covers the
// arguments; this covers the discriminator, which is the one a `switch` would
// silently fall through on.

export type PracticeToolNamesMatchRules =
  PracticeToolCallInput['tool'] extends PracticeRealtimeToolName
    ? PracticeRealtimeToolName extends PracticeToolCallInput['tool']
      ? true
      : never
    : never;

export const PRACTICE_TOOL_NAMES_MATCH_RULES: PracticeToolNamesMatchRules = true;

// (3) THE REJECTION REASON IS THE ENGINE'S OWN TYPE.
//
// A cosmetic-looking alias that is doing real work: it means a reason removed
// from the engine's closed set cannot linger in this file's documentation, and
// a reason added there is documented here without a second edit. The DTO class
// above publishes `reason` as a plain string for OpenAPI (an enum in the
// document would freeze today's set into every generated client), so this is
// the only place the two stay bound.

export type PracticeToolCallRejectionReason = PracticeRealtimeRejectionReason;
