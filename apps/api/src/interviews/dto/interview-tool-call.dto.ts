import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ASR_CONFIDENCE_THRESHOLD } from '../../ai/ai.types';
import { END_PHASE_VALUES } from '../realtime/realtime-tools';
import type {
  RealtimeRejectionReason,
  RealtimeToolCall,
  RealtimeToolName,
} from '../realtime/realtime-tool-calls';
import type { InterviewPhase } from '../engine';
import type { InterviewProgress } from './interview.dto';

// =============================================================================
// POST /api/interviews/:id/realtime/tool-calls — the wire (issue #158, E11)
// =============================================================================
//
// One route for all three tools, discriminated on `tool`.
// `docs/specs/realtime-interview.md` §4 describes the tool calls as function
// invocations and prescribes no HTTP shape, so the choice is made here and the
// reasoning is written down in `InterviewsService.handleRealtimeToolCall`'s own
// doc comment rather than repeated.
//
// -----------------------------------------------------------------------------
// THE REQUEST MIRRORS `realtime-tools.ts`' SCHEMAS AND WIDENS NOTHING
// -----------------------------------------------------------------------------
//
// The provider validates the model's arguments against the JSON Schema the
// session was minted with; this validates what the BROWSER relays. Both layers
// are needed and neither is redundant: the provider's schema stops the model
// from expressing something, and this stops anything else from being posted to
// this route at all — a browser is a program a person can modify, and a
// realtime session's tool result is not the only way to reach an HTTP endpoint.
//
// `z.strictObject` throughout, so a `verdict` the provider's own
// `additionalProperties: false` would have refused is a 400 here rather than an
// ignored extra sitting in an unvalidated bag a later handler could start
// reading. The compile-time proof at the bottom of this file is the third
// layer, and it is the one that survives a refactor.
//
// -----------------------------------------------------------------------------
// THERE IS NO USER ID FIELD, AND THERE NEVER WILL BE
// -----------------------------------------------------------------------------
//
// Same rule and same mechanism as `interview-turn.dto.ts`: the learner is
// `@CurrentUser('id')`, the interview is resolved by
// `InterviewsService.requireInterview` filtering on that id in the `where`, and
// the proof below names every identity-shaped field that must never appear.
// =============================================================================

/**
 * The longest transcript accepted on one `grade_answer` call.
 *
 * The same bound and the same reasoning as `MAX_TURN_TEXT_LENGTH` on the text
 * transport: this string is written to `mock_interview_turns.text` (when
 * retention is on) and is the one untrusted input the grading prompt
 * interpolates, paid for on the learner's own key. A spoken answer to a civics
 * question or a read sentence is far inside it.
 */
export const MAX_TRANSCRIPT_LENGTH = 2000;

/**
 * One tool call: the tool's name, plus the arguments THAT tool declares.
 *
 * -----------------------------------------------------------------------------
 * A FLAT OBJECT WITH A REFINEMENT, NOT A DISCRIMINATED UNION, AND WHY
 * -----------------------------------------------------------------------------
 *
 * `createZodDto` builds a CLASS, and a class cannot extend a union (TS2509) —
 * the same limitation `interview-realtime-session.dto.ts` documents on the
 * response side, met here on the request side where the global
 * `ZodValidationPipe` needs exactly one DTO class to validate against.
 *
 * The refinement below is not a weaker substitute for the union; on the one
 * property that matters it is STRICTER. A union accepts each variant's own
 * fields and says nothing about a field belonging to a different variant
 * arriving on this one. This rejects that outright: a `confidence` posted with
 * `end_phase`, or a `phase` posted with `grade_answer`, is a 400 naming the
 * field. Combined with `strictObject`, which rejects any property not declared
 * at all, the set of things this route accepts is exactly the union of the
 * three tools' declared arguments and nothing else — which is the property
 * `realtime-tools.ts`' `additionalProperties: false` holds one layer up, held
 * again here because a browser is a program a person can modify.
 *
 * {@link narrowToolCall} turns the validated flat shape into the discriminated
 * `RealtimeToolCall` the rules take, and its return type is the compiler's
 * proof that the two agree.
 */
export const interviewToolCallSchema = z
  .strictObject({
    /** Which of the three tools this call is. */
    tool: z.enum(['next_question', 'grade_answer', 'end_phase']),

    /**
     * `grade_answer` only — WHICH item this answer is for.
     *
     * A civics question id, or — in a conducted reading or writing segment
     * (§5) — an `english_sentences` id. Both are uuids, and both are compared
     * against what the engine says is outstanding, so an out-of-order or
     * duplicate call is rejected rather than attributed to whatever is current.
     */
    questionId: z.uuid().optional(),

    /**
     * `grade_answer` only — what the applicant said, as the model heard it.
     *
     * MAY BE EMPTY, for the reason `interview-turn.dto.ts` gives for the same
     * decision: an applicant who says nothing has still taken their turn, and
     * rejecting it with a 400 would make "I don't know" the one thing a
     * rehearsal of a high-stakes conversation refuses to let a nervous person
     * say.
     */
    transcript: z.string().max(MAX_TRANSCRIPT_LENGTH).optional(),

    /**
     * `grade_answer` only — the recogniser's own confidence, when the provider
     * reported one.
     *
     * OPTIONAL, AND ABSENT MEANS UNKNOWN — never low. It feeds the identical
     * `ASR_CONFIDENCE_THRESHOLD` comparison the request/response voice path
     * uses (`voice.md` §3), and defaulting it here would turn every interview
     * on a provider that reports no confidence into one where every answer
     * reads as misheard.
     */
    confidence: z.number().min(0).max(1).optional(),

    /**
     * `end_phase` only — which part of the interview the model believes has
     * finished.
     *
     * NAMED EXPLICITLY rather than left implicit, so a mismatch between what
     * the model thinks just happened and what the engine's own state says is
     * detectable rather than silently accepted (§4.3). The enum is
     * `END_PHASE_VALUES`, which `realtime-tools.ts` derives from
     * `INTERVIEW_PHASES` minus `closing` — so this route and the schema the
     * session was minted with cannot disagree about which phases exist.
     */
    phase: z
      .enum(END_PHASE_VALUES as [InterviewPhase, ...InterviewPhase[]])
      .optional(),
  })
  .superRefine((value, ctx) => {
    const required: Record<string, readonly string[]> = {
      next_question: [],
      grade_answer: ['questionId', 'transcript'],
      end_phase: ['phase'],
    };
    const allowed: Record<string, readonly string[]> = {
      next_question: [],
      grade_answer: ['questionId', 'transcript', 'confidence'],
      end_phase: ['phase'],
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

    for (const field of ['questionId', 'transcript', 'confidence', 'phase']) {
      if (
        (value as Record<string, unknown>)[field] !== undefined &&
        !allowed[value.tool].includes(field)
      ) {
        // REJECTED, NOT IGNORED. A field this tool does not declare is a field
        // the provider's own schema would have refused, and accepting it here
        // would make the tool contract a statement about one transport rather
        // than about the interview.
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} does not belong to the ${value.tool} tool`,
        });
      }
    }
  });

export type InterviewToolCallInput = z.infer<typeof interviewToolCallSchema>;

export class InterviewToolCallDto extends createZodDto(
  interviewToolCallSchema,
) {}

/**
 * The validated body, as the discriminated shape the rules take.
 *
 * THE RETURN TYPE IS THE PROOF. `RealtimeToolCall` is
 * `realtime-tool-calls.ts`' own input type, so a field renamed or a tool added
 * on either side of this boundary is a compile error here rather than a
 * runtime surprise on a live connection. The non-null assertions are sound
 * because {@link interviewToolCallSchema}'s refinement has already rejected a
 * call missing its tool's required arguments — this function only runs on a
 * body that passed it.
 */
export function narrowToolCall(input: InterviewToolCallInput): RealtimeToolCall {
  switch (input.tool) {
    case 'next_question':
      return { tool: 'next_question' };
    case 'grade_answer':
      return {
        tool: 'grade_answer',
        questionId: input.questionId as string,
        transcript: input.transcript as string,
        confidence: input.confidence,
      };
    case 'end_phase':
      return { tool: 'end_phase', phase: input.phase as InterviewPhase };
  }
}

// -----------------------------------------------------------------------------
// The results
// -----------------------------------------------------------------------------

/** Fields every honoured result carries: where the interview is now. */
interface RealtimeTurnStatus {
  /** The phase the interview is in NOW, as the engine reports it. */
  phase: InterviewPhase;
  /** The index of the last turn written. */
  turnIndex: number;
  /** How far through the civics section. PACING, never score — see the DTO. */
  progress: InterviewProgress;
  /** True once the only remaining action is `complete`. */
  awaitingCompletion: boolean;
}

/** `next_question`, honoured: the exact words to say. */
export interface RealtimeNextQuestionResult extends RealtimeTurnStatus {
  tool: 'next_question';
  status: 'ok';

  /**
   * The officer's line, assembled server-side and to be spoken AS GIVEN.
   *
   * A civics question is `civics_questions.prompt` verbatim; a reading or
   * writing sentence is `english_sentences.text` verbatim; everything around
   * them is code-owned copy from `engine/officer-lines.ts`. No part of this
   * string was written by a model.
   */
  text: string;

  /**
   * SAY THIS; NEVER RENDER IT. True only for a writing sentence.
   *
   * `english.service.ts`'s own rule, inherited unmodified: "On a writing
   * attempt this is the REVEAL — the first time the learner sees the sentence
   * they were dictated." The writing test is a DICTATION, so a client that
   * printed this string on screen would not be showing the learner the
   * question — it would be showing them the answer.
   *
   * It is a flag rather than a withheld field, and that is a deliberate choice
   * worth stating: on this transport the browser is the RELAY between the model
   * and this API, so the tool result necessarily passes through it. The "never
   * shown" rule is therefore a DOM invariant the realtime screen enforces —
   * exactly as `CLAUDE.md` already states it for the request/response transport
   * ("a DOM invariant enforced there, not a network one") — and this flag is
   * what tells that screen which strings it applies to. The interview
   * TRANSCRIPT is protected differently and structurally: the writing
   * sentence is never written into `mock_interview_turns.text` at all, so
   * `GET /api/interviews/:id` cannot leak it mid-interview.
   */
  speakOnly: boolean;

  /**
   * The id a subsequent `grade_answer` must name, or `null` when this turn
   * produces no scored answer (the closing statement, a skipped segment).
   *
   * Returned so the relay never has to guess and never has to parse the text.
   * It is a join key, and it reveals nothing about the answer.
   */
  itemId: string | null;
}

/** `grade_answer`, honoured: an acknowledgement, and nothing else. */
export interface RealtimeGradeAnswerResult extends RealtimeTurnStatus {
  tool: 'grade_answer';
  status: 'ok';

  /**
   * The neutral sentence for the officer to speak.
   *
   * IDENTICAL WHATEVER THE OUTCOME WAS. §10: the real event gives no
   * per-question feedback, so a rehearsal that does is coaching the applicant
   * to expect reassurance the actual interview will never provide — and on a
   * spoken transport the reassurance would arrive in a warm human voice within
   * a second of them answering.
   */
  ack: string;

  /**
   * Whether evidence was written for this answer.
   *
   * `false` only for a reading attempt whose transcript the recogniser did not
   * trust: `english-test.md` §3 writes NO row in that case, and the segment
   * stays outstanding so the officer can ask for it again. This is a statement
   * about the RECORD, not about the answer — it never correlates with whether
   * the learner was right, because a low-confidence transcript that scored
   * correct anyway is recorded normally.
   */
  recorded: boolean;
}

/** `end_phase`, honoured: where the interview now is. */
export interface RealtimeEndPhaseResult {
  tool: 'end_phase';
  status: 'ok';

  /** The phase the engine has actually moved into. */
  nextPhase: InterviewPhase;

  /** One sentence of orientation for the model. Never a summary of how it went. */
  context: string;

  /** True once the only remaining action is `complete`. */
  awaitingCompletion: boolean;
}

/** Any tool, refused. */
export interface RealtimeToolCallRejected {
  tool: RealtimeToolName;
  status: 'rejected';

  /** A stable, GROUP-able code. Never a message. */
  reason: RealtimeRejectionReason;

  /** What was wrong, as prose the model can act on. */
  error: string;

  /** What to do instead — §4.2 requires the model be told, not left to guess. */
  instruction: string;
}

export type RealtimeToolCallResponse =
  | RealtimeNextQuestionResult
  | RealtimeGradeAnswerResult
  | RealtimeEndPhaseResult
  | RealtimeToolCallRejected;

// -----------------------------------------------------------------------------
// The DTO classes: ONE PER UNION MEMBER, never one per union
// -----------------------------------------------------------------------------
//
// `createZodDto` builds a class and a class cannot extend a union (TS2509), so
// each variant is published on its own and the controller composes them with
// `oneOf` plus a `status` discriminator — the arrangement
// `interview-realtime-session.dto.ts` already explains at length.
//
// These are documentation shapes only; the service returns the interfaces
// above, and the proof at the bottom of this file is what keeps the two honest
// about the one property that matters.

const turnStatusShape = {
  phase: z.string(),
  turnIndex: z.number().int(),
  progress: z.object({
    civicsAsked: z.number().int(),
    civicsPlanned: z.number().int(),
  }),
  awaitingCompletion: z.boolean(),
};

export class RealtimeNextQuestionResultDto extends createZodDto(
  z.object({
    tool: z.literal('next_question'),
    status: z.literal('ok'),
    text: z.string(),
    speakOnly: z.boolean(),
    itemId: z.string().nullable(),
    ...turnStatusShape,
  }),
) {}

export class RealtimeGradeAnswerResultDto extends createZodDto(
  z.object({
    tool: z.literal('grade_answer'),
    status: z.literal('ok'),
    ack: z.string(),
    recorded: z.boolean(),
    ...turnStatusShape,
  }),
) {}

export class RealtimeEndPhaseResultDto extends createZodDto(
  z.object({
    tool: z.literal('end_phase'),
    status: z.literal('ok'),
    nextPhase: z.string(),
    context: z.string(),
    awaitingCompletion: z.boolean(),
  }),
) {}

export class RealtimeToolCallRejectedDto extends createZodDto(
  z.object({
    tool: z.string(),
    status: z.literal('rejected'),
    reason: z.string(),
    error: z.string(),
    instruction: z.string(),
  }),
) {}

/**
 * The threshold a `confidence` argument is compared against, republished for
 * the OpenAPI description.
 *
 * Imported rather than restated, so the number a client reads in the document
 * is the number the server actually compares against — the same discipline
 * `interviews.controller.ts` already applies to `REALTIME_SESSION_TTL_SECONDS`.
 */
export const DOCUMENTED_ASR_CONFIDENCE_THRESHOLD = ASR_CONFIDENCE_THRESHOLD;

// -----------------------------------------------------------------------------
// Compile-time proofs
// -----------------------------------------------------------------------------
//
// Two, and they point in opposite directions across the tool boundary.

/** Every key of every member of a union, distributed. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

// (1) NOTHING THE MODEL SENDS MAY NAME A USER, A PHASE, OR A GRADE.
//
// `realtime-tools.ts` proves the declared SCHEMA has no verdict field; this
// proves the parsed BODY has none either, which is the shape a handler actually
// reads. They are not redundant — a field added to this DTO is not a field
// added to that schema, and this is the one an HTTP request can reach.
//
// `phase` is deliberately absent from the list: `end_phase` exists to carry
// one, and it is a claim the engine independently checks rather than acts on
// (§4.3). `questionId` is absent for the same reason — it is checked against
// what the engine says is outstanding, never trusted as a selection.

type ForbiddenToolCallFieldNames =
  | 'userId'
  | 'user_id'
  | 'learnerId'
  | 'email'
  | 'interviewId'
  | 'mockInterviewId'
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
  | 'testVersionCode'
  | 'passThreshold'
  | 'questionsAsked';

export type ToolCallNamesNoIdentityOrVerdict = Extract<
  KeysOfUnion<InterviewToolCallInput>,
  ForbiddenToolCallFieldNames
> extends never
  ? true
  : never;

export const TOOL_CALL_NAMES_NO_IDENTITY_OR_VERDICT: ToolCallNamesNoIdentityOrVerdict =
  true;

// (2) THE TOOL NAMES ON THE WIRE ARE EXACTLY THE TOOL NAMES THE RULES KNOW.
//
// Assignability in BOTH directions, so the two are the same set rather than
// merely overlapping. A fourth tool declared in `realtime-tools.ts` that this
// route cannot accept, or a name accepted here that no rule handles, are both
// build breaks. {@link narrowToolCall}'s return type covers the arguments; this
// covers the discriminator, which is the one a `switch` would silently fall
// through on.

export type ToolNamesMatchRules =
  InterviewToolCallInput['tool'] extends RealtimeToolName
    ? RealtimeToolName extends InterviewToolCallInput['tool']
      ? true
      : never
    : never;

export const TOOL_NAMES_MATCH_RULES: ToolNamesMatchRules = true;
