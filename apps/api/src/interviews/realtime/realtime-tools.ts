import type { AiRealtimeTool } from '../../ai/ai.types';
import { INTERVIEW_PHASES } from '../engine';

// =============================================================================
// The realtime interview's tool contract (issue #157, epic #60 / E11)
// =============================================================================
//
// The three tools a realtime officer may call, declared to the provider at
// session-creation time. `docs/specs/realtime-interview.md` §4 is the design;
// this file is its argument schemas, and nothing else — **the handlers are
// issue #158's** and deliberately do not live here.
//
// Issue #155 states the reason this file exists as a file at all, and it is
// worth quoting rather than paraphrasing:
//
//   > A speech-to-speech model asked to conduct a civics interview will happily
//   > invent a civics question from memory and declare an answer correct.
//   > `VISION.md` forbids that outright: `OathPath owns the truth. AI owns the
//   > interaction.` The mechanism that enforces it is a tool contract, and a
//   > tool contract that lives only in a system prompt is not a contract.
//
// A JSON schema sent with the session IS the contract: the provider enforces
// the argument shape, so a field the schema does not declare is a field the
// model has no way to send. That is a structural guarantee. The same sentence
// written into the instructions is a request the model complies with most of
// the time, and the times it does not are exactly the times nobody is looking.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT ON THESE SCHEMAS IS THE LOAD-BEARING PART
// -----------------------------------------------------------------------------
//
// Two absences, each the mirror of a rule E8 already enforces on the text
// transport by concatenating rather than asking:
//
//   * `next_question` RETURNS the question text and takes no argument that
//     could carry one. The model asks to be told what to say; it never
//     proposes it. `officer-prompt.ts`'s own header calls this "no field to
//     put it in", for the identical reason: a model handed the question as
//     material to restate will paraphrase, translate or simplify it on some
//     fraction of runs, fluently, and no reviewer will ever see the wording.
//
//   * `grade_answer` HAS NO `verdict` FIELD, and {@link GRADE_ANSWER_DECLARES_NO_VERDICT}
//     below is a compile-time proof of the absence. The model reports what it
//     HEARD; the engine's own grading ladder decides whether that was right.
//     §4.2 and §13's rejected "letting `grade_answer`'s verdict be believed"
//     row: a self-reported grade that is merely preferred-against is a grade
//     that gets believed the first time a deterministic match is ambiguous,
//     and then two identical answers on two runs grade differently with no way
//     to explain why.
//
// -----------------------------------------------------------------------------
// `additionalProperties: false` ON EVERY SCHEMA
// -----------------------------------------------------------------------------
//
// Without it, "no `verdict` field" is a statement about what is documented
// rather than about what can arrive: a model that volunteers one lands it in
// an unvalidated bag the handler could later start reading. With it, the
// absence is enforced by the provider, one layer above any code #158 writes.
// =============================================================================

/**
 * How long a minted client secret should stay usable, in seconds.
 *
 * `docs/specs/realtime-interview.md` §3 fixes this number, and fixes it SHORT:
 * the secret only has to survive the handshake between a browser asking for a
 * session and that browser opening the connection, not the conversation
 * itself. A session already under way is not cut off when it expires.
 *
 * IT IS A REQUEST, NOT THE ANSWER. What the provider stamps on the secret is
 * anchored to its own clock at mint time, and that value — not this one — is
 * what a browser is told, all the way up through
 * `AiRealtimeSessionResult.expiresAt`. Re-deriving an expiry from this
 * constant on either side would disagree with the truth by the round trip plus
 * the clock skew, in the direction that matters: telling a browser it still
 * has time it does not have.
 */
export const REALTIME_SESSION_TTL_SECONDS = 60;

/**
 * The phases `end_phase` may name.
 *
 * DERIVED FROM `INTERVIEW_PHASES`, minus `closing`, rather than written out.
 * `phases.ts`'s own header calls that array "the sequence the engine walks"
 * and the only place the shape of a rehearsal is stated; a second hand-written
 * list here would be a phase the engine conducts that the model cannot report,
 * or the reverse, on the day the sequence changes.
 *
 * `closing` is excluded because there is nothing after it: an interview whose
 * closing is over is over, and `end_phase({ phase: 'closing' })` would be the
 * model asking to end the interview — a decision the engine's own stop rule
 * makes, never a tool call. §4.3.
 */
export const END_PHASE_VALUES = INTERVIEW_PHASES.filter(
  (phase) => phase !== 'closing',
);

/**
 * `grade_answer`'s declared arguments, as their own constant.
 *
 * SEPARATE FROM THE TOOL BELOW so {@link GRADE_ANSWER_DECLARES_NO_VERDICT} can
 * be typed over its keys. Inlined in the tool literal, the proof would have
 * nothing to name.
 */
const GRADE_ANSWER_PROPERTIES = {
  /**
   * WHICH question this answer is for.
   *
   * Named explicitly rather than assumed to be "the current one", so an
   * out-of-order or duplicate call is DETECTABLE. §4.2's rejection rule reads
   * it against the question the engine's own state says is outstanding — the
   * finer-grained sibling of the `outcome.phase !== state.phase` guard
   * `applyAnswer` already enforces one layer up.
   */
  questionId: {
    type: 'string',
    description: 'The id of the question this answer was given to, exactly as the tool result that asked it reported.',
  },

  /**
   * What the learner said, as the realtime model heard it.
   *
   * Text, never audio: no recording reaches this application on this transport
   * at all (`docs/specs/voice.md` §4, restated by `realtime-interview.md` §6
   * for a live stream that never becomes a buffer on this side).
   */
  transcript: {
    type: 'string',
    description: "What the applicant said, transcribed as faithfully as possible. Do not correct, complete, or interpret it.",
  },

  /**
   * The recogniser's own confidence, when the provider reports one.
   *
   * FED TO THE SAME `ASR_CONFIDENCE_THRESHOLD` the request/response path
   * already uses (`ai.types.ts`, `voice.md` §3) — never a second threshold
   * invented for realtime. Optional because absent means UNKNOWN, and unknown
   * is not low: defaulting it would turn every mint on a provider that reports
   * no confidence into a interview where every answer reads as misheard.
   */
  confidence: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'How confident you are that the transcript is what was said, 0 to 1. Omit it rather than guessing.',
  },
} as const;

/**
 * The three tools, in the order a turn uses them.
 *
 * `AiRealtimeTool[]`, so this array is exactly what
 * `AiDispatchService.createRealtimeSession` forwards to the provider — there
 * is no second translation step between what is declared here and what the
 * session is created with.
 */
export const INTERVIEW_REALTIME_TOOLS: AiRealtimeTool[] = [
  {
    name: 'next_question',
    description:
      'Call this when you are ready for the officer to speak next: at the start of the ' +
      'interview, and after every answer you have reported with grade_answer. It returns ' +
      'the exact words to say. Say them as given — do not rephrase, translate, simplify, ' +
      'expand, or add a question of your own.',
    // NO ARGUMENTS AT ALL. The model asks to be told what to say; there is no
    // field through which it could propose a question, a topic, or a
    // difficulty. See the header.
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'grade_answer',
    description:
      'Call this once for each answer the applicant gives to a civics question, reporting ' +
      'what you heard. It returns a short acknowledgement to say. It does NOT tell you ' +
      'whether the answer was right, and you must not tell the applicant either — the ' +
      'application decides that and tells them at the end.',
    parameters: {
      type: 'object',
      properties: GRADE_ANSWER_PROPERTIES,
      required: ['questionId', 'transcript'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_phase',
    description:
      'Call this when you believe a part of the interview has finished. The application ' +
      'decides whether it really has; if it has not, you will be told to continue, and ' +
      'you should call next_question and carry on without commenting on it.',
    parameters: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          enum: END_PHASE_VALUES,
          description: 'Which part of the interview you believe has just finished.',
        },
      },
      required: ['phase'],
      additionalProperties: false,
    },
  },
];

/** Every tool name, for a caller that needs to name one. */
export const INTERVIEW_REALTIME_TOOL_NAMES = INTERVIEW_REALTIME_TOOLS.map(
  (tool) => tool.name,
);

// -----------------------------------------------------------------------------
// Compile-time proof that the model has no field to put a grade in
// -----------------------------------------------------------------------------
//
// The same device `create-interview.dto.ts` uses to keep `seniorExemption` off
// the create request, pointed at the same class of failure one layer out: not a
// learner claiming an easier test, but a model claiming it passed one.
//
// If you are here because this line went red: you are adding a field through
// which a speech-to-speech model could report its own opinion of an answer.
// `docs/specs/mock-interview.md` §5.3 names what that costs — "you passed the
// civics section" becomes unreproducible and unauditable, which is the single
// most consequential claim this product makes. The engine's grading ladder
// (`AttemptGradingService`, the same one a typed practice answer goes through)
// is what decides; this tool exists to report what was HEARD.
//
// `transcript` and `confidence` are deliberately not on the list. Both are
// observations about the audio, which is the one thing the model is genuinely
// the authority on; neither is a judgement about the answer.

type ForbiddenGradeAnswerArgumentNames =
  | 'verdict'
  | 'grade'
  | 'outcome'
  | 'correct'
  | 'isCorrect'
  | 'score'
  | 'passed'
  | 'result'
  | 'assessment'
  | 'evaluation';

export type GradeAnswerDeclaresNoVerdict = Extract<
  keyof typeof GRADE_ANSWER_PROPERTIES,
  ForbiddenGradeAnswerArgumentNames
> extends never
  ? true
  : never;

export const GRADE_ANSWER_DECLARES_NO_VERDICT: GradeAnswerDeclaresNoVerdict =
  true;
