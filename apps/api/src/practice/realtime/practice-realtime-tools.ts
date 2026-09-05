import type { AiRealtimeTool } from '../../ai/ai.types';

// =============================================================================
// The realtime practice tool contract (issue #353, epic #345 / E15)
// =============================================================================
//
// The five tools a realtime coach may call, declared to the provider at
// session-creation time. This file is their argument schemas and nothing
// else — **the handlers are issue #354's** and deliberately do not live here,
// exactly as `interviews/realtime/realtime-tools.ts` (#157) kept its own
// handlers out of the way of #158.
//
// That file's header states why a tool contract exists as a FILE rather than
// as a paragraph in a prompt, and the argument is reused here verbatim rather
// than reworded: a JSON schema sent with the session IS the contract, because
// the provider enforces the argument shape, so a field the schema does not
// declare is a field the model has no way to send. The same sentence written
// into the instructions is a request the model complies with most of the time,
// and the times it does not are exactly the times nobody is looking.
//
// -----------------------------------------------------------------------------
// WHY THE STAKES ARE HIGHER HERE THAN THEY WERE FOR THE INTERVIEW
// -----------------------------------------------------------------------------
//
// In E11 the model's opinion of an answer reaches SPEECH and nothing else —
// `OFFICER_VERDICT_PROHIBITION` means the officer gives no per-question verdict
// at all, so a model that formed one has nowhere to put it.
//
// IN PRACTICE THE VERDICT IS THE ROW. `PracticeService.recordAttempt` writes a
// `practice_attempts` row and updates `question_mastery` in the same
// transaction, which sets `dueAt`, which decides whether the learner is ever
// asked that question again, which feeds readiness. A model-authored verdict
// would not merely mis-speak once: it would push a question the learner
// genuinely does not know out of rotation for weeks, silently, with nothing in
// the evidence table to show why.
//
// So `grade_answer` declares neither a verdict-shaped field NOR a confidence,
// and {@link GRADE_ANSWER_DECLARES_NO_VERDICT_OR_CONFIDENCE} below is a
// compile-time proof of both absences.
//
//   * NO VERDICT, for E11's reason (`realtime-tools.ts`'s own header, and
//     §13's rejected "letting `grade_answer`'s verdict be believed" row): a
//     self-reported grade that is merely preferred-against is a grade that
//     gets believed the first time a deterministic match is ambiguous.
//
//   * NO CONFIDENCE, which is the one place this contract is deliberately
//     NARROWER than the interview's. On the request/response voice path
//     (`voice.md` §3) a confidence is the RECOGNISER's, reported by a
//     transcription model about audio it processed, and it feeds
//     `isMisheardAttempt` — which skips mastery scheduling. On this transport
//     there is no separate recogniser: the number would be the same model that
//     heard the answer reporting its own certainty about its own hearing,
//     which is a different quantity wearing the same name. Believing it would
//     let a model suppress a scheduling update by claiming it was unsure.
//
// -----------------------------------------------------------------------------
// `additionalProperties: false` ON EVERY SCHEMA
// -----------------------------------------------------------------------------
//
// Without it, "no verdict field" is a statement about what is DOCUMENTED rather
// than about what can ARRIVE: a model that volunteers one lands it in an
// unvalidated bag a later handler could start reading. With it, the absence is
// enforced by the provider, one layer above any code #354 writes.
// =============================================================================

/**
 * How long a minted client secret should stay usable, in seconds.
 *
 * SHORT, and for the reason `realtime-interview.md` §3 fixes the interview's
 * own: the secret only has to survive the handshake between a browser asking
 * for a session and that browser opening the connection, not the practice
 * conversation itself. A session already under way is not cut off when it
 * expires.
 *
 * IT IS A REQUEST, NOT THE ANSWER. What the provider stamps on the secret is
 * anchored to its own clock at mint time, and that value — not this one — is
 * what a browser is told, all the way up through
 * `AiRealtimeSessionResult.expiresAt`.
 *
 * DECLARED HERE RATHER THAN IMPORTED FROM `interviews/realtime/`, and the
 * reason is structural rather than stylistic: `InterviewsModule` imports
 * `PracticeModule` (for `AttemptGradingService`, so there is one grading
 * ladder in the codebase), so an import in this direction would be the first
 * edge of a cycle between the two features. The number is a handshake window,
 * not a rule the two transports must agree on — unlike a pass threshold, two
 * sessions minted with different lifetimes disagree about nothing a learner
 * can observe.
 */
export const PRACTICE_REALTIME_SESSION_TTL_SECONDS = 60;

/**
 * The reasons `end_session` may name.
 *
 * AN ENUM OF OBSERVATIONS, NEVER A JUDGEMENT. Both values describe something
 * that happened outside the model — the learner asked to stop, or the
 * application said there was nothing left — and neither is an opinion about
 * how the session went. There is deliberately no `learner_struggling`, no
 * `enough_for_today` and no `mastered`: a model that could end a session
 * because it judged the learner had done badly enough would be making the
 * product's most discouraging decision on its own.
 *
 * `no_questions_left` is VERIFIED rather than believed — #354's handler
 * refuses it when the session still has something to ask (see
 * `decideEndSession` in `practice-realtime-tool-calls.ts`).
 */
export const END_SESSION_REASONS = ['no_questions_left', 'learner_asked'] as const;

/** One of {@link END_SESSION_REASONS}. */
export type EndSessionReason = (typeof END_SESSION_REASONS)[number];

/**
 * `grade_answer`'s declared arguments, as their own constant.
 *
 * SEPARATE FROM THE TOOL BELOW so
 * {@link GRADE_ANSWER_DECLARES_NO_VERDICT_OR_CONFIDENCE} can be typed over its
 * keys. Inlined in the tool literal, the proof would have nothing to name.
 */
const GRADE_ANSWER_PROPERTIES = {
  /**
   * WHICH question this answer is for.
   *
   * Named explicitly rather than assumed to be "the current one", so an
   * out-of-order or duplicate call is DETECTABLE: it is COMPARED against the
   * question the session says is outstanding, never trusted as a selection.
   * A model that could pick the question an answer is attributed to could
   * quietly move a correct answer onto a question the learner never heard.
   */
  questionId: {
    type: 'string',
    description:
      'The id of the question this answer was given to, exactly as the tool result that asked it reported.',
  },

  /**
   * What the learner said, as the realtime model heard it.
   *
   * Text, never audio: no recording reaches this application on this transport
   * at all (`docs/specs/voice.md` §4). It is the ONE untrusted string in this
   * contract, and it is evidence about the audio — the one thing the model
   * genuinely is the authority on — rather than a judgement about the answer.
   */
  transcript: {
    type: 'string',
    description:
      'What the learner said, transcribed as faithfully as possible. Do not correct, complete, translate or interpret it.',
  },
} as const;

/** `skip_question`'s declared arguments. Separate for the same reason as above. */
const SKIP_QUESTION_PROPERTIES = {
  /** WHICH question is being skipped — compared, never assumed. */
  questionId: {
    type: 'string',
    description:
      'The id of the question the learner asked to move past, exactly as the tool result that asked it reported.',
  },
} as const;

/**
 * The five tools, in the order a turn uses them.
 *
 * `AiRealtimeTool[]`, so this array is exactly what
 * `AiDispatchService.createRealtimeSession` forwards to the provider — there is
 * no second translation step between what is declared here and what the
 * session is created with.
 */
export const PRACTICE_REALTIME_TOOLS: AiRealtimeTool[] = [
  {
    name: 'next_question',
    description:
      'Call this when you are ready to speak next: at the start of the session, and after ' +
      'every answer you have reported with grade_answer. It returns the exact words to ' +
      'say. Say them as given — do not rephrase, translate, simplify, expand, or ask a ' +
      'question of your own.',
    // NO ARGUMENTS AT ALL. The model asks to be TOLD what to say; there is no
    // field through which it could propose a question, a topic, a category or a
    // difficulty. Selection stays in `mastery/selector.ts`, where the learner's
    // own spaced-repetition state decides it.
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'grade_answer',
    description:
      'Call this once for each answer the learner gives, reporting what you heard. It ' +
      'returns what to say next. It does NOT take your opinion of the answer: the ' +
      'application grades it and tells you what to say about it.',
    parameters: {
      type: 'object',
      properties: GRADE_ANSWER_PROPERTIES,
      required: ['questionId', 'transcript'],
      additionalProperties: false,
    },
  },
  {
    name: 'repeat_question',
    description:
      'Call this when the learner asks to hear the question again, or when you have lost ' +
      'track of what was asked — after a dropped connection, for example. It returns the ' +
      'outstanding question again, word for word. It records nothing and does not count ' +
      'against the learner.',
    // NO ARGUMENTS. There is only ever one outstanding question, and the
    // session knows which it is. A `questionId` here would be a field through
    // which the model could ask for a question that is not the one being
    // answered — which is `next_question`'s job, and the selector's decision.
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'skip_question',
    description:
      'Call this ONLY when the learner has asked to move on without answering. Never call ' +
      'it because you did not hear an answer, and never because you think they do not ' +
      'know it — if you did not hear them, ask them to say it again or call ' +
      'repeat_question.',
    parameters: {
      type: 'object',
      properties: SKIP_QUESTION_PROPERTIES,
      required: ['questionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_session',
    description:
      'Call this when the learner asks to stop, or when the application has told you there ' +
      'is nothing left to ask. The application decides whether the session is really over; ' +
      'if it tells you to continue, carry on without commenting on it.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: END_SESSION_REASONS,
          description:
            'Why you are ending: the learner asked to stop, or there are no questions left. ' +
            'Report what happened, not how you think the session went.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

/** Every tool name, for a caller that needs to name one. */
export const PRACTICE_REALTIME_TOOL_NAMES = PRACTICE_REALTIME_TOOLS.map(
  (tool) => tool.name,
);

// -----------------------------------------------------------------------------
// Compile-time proof that the model has no field to put a grade — or a
// certainty about its own hearing — in
// -----------------------------------------------------------------------------
//
// The same device `interviews/realtime/realtime-tools.ts` and
// `dto/create-practice-session.dto.ts` already use, pointed at the two fields
// whose absence this whole contract exists to guarantee.
//
// If you are here because this line went red: you are adding a field through
// which a speech-to-speech model could decide what lands in
// `practice_attempts` and `question_mastery`. That is not a wording mistake
// that shows up in a transcript — it is a `dueAt` weeks in the future for a
// question the learner cannot answer, invisible on every screen this product
// has, and unattributable afterwards because the row looks exactly like one a
// real answer produced.
//
// `transcript` and `questionId` are deliberately not on the list. The first is
// an observation about the audio, which is the one thing the model genuinely is
// the authority on; the second is a claim the engine COMPARES against what it
// says is outstanding, never acts on.

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
  | 'evaluation'
  | 'failureCause'
  | 'confidence'
  | 'asrConfidence'
  | 'certainty'
  | 'confidenceScore';

export type GradeAnswerDeclaresNoVerdictOrConfidence = Extract<
  keyof typeof GRADE_ANSWER_PROPERTIES,
  ForbiddenGradeAnswerArgumentNames
> extends never
  ? true
  : never;

export const GRADE_ANSWER_DECLARES_NO_VERDICT_OR_CONFIDENCE: GradeAnswerDeclaresNoVerdictOrConfidence =
  true;

/**
 * The same proof for `skip_question`, which is the OTHER tool that writes.
 *
 * A skip is recorded evidence (`practice_attempts.outcome: 'skipped'`) and it
 * schedules, so a field here would reach the same rows by the same route.
 * Stated separately rather than folded into the type above, because the two
 * schemas are separate objects and a proof over one says nothing about the
 * other.
 */
export type SkipQuestionDeclaresNoVerdict = Extract<
  keyof typeof SKIP_QUESTION_PROPERTIES,
  ForbiddenGradeAnswerArgumentNames
> extends never
  ? true
  : never;

export const SKIP_QUESTION_DECLARES_NO_VERDICT: SkipQuestionDeclaresNoVerdict =
  true;
