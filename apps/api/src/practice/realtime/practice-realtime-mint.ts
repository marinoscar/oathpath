// =============================================================================
// May this practice session be conducted by voice at all? (issue #353, E15)
// =============================================================================
//
// A pure function, in the same split the rest of `practice/realtime/` uses: the
// decision is values in and values out, and `PracticeRealtimeService` is the
// half that loads the session and spends the learner's key.
//
// It exists as its own function rather than as two `if`s inside the service for
// one reason worth the file: the mint is where a learner's AI key gets spent,
// and "when do we refuse before spending anything" is a rule that should be
// readable, testable and scriptable without standing up Nest, Prisma and a
// dispatcher to see it.
// =============================================================================

/** Everything the decision reads. Both facts come from the session itself. */
export interface PracticeRealtimeMintContext {
  /** The session's id, so the refusal can name it. */
  readonly sessionId: string;

  /** `practice_sessions.status`. */
  readonly sessionStatus: string;

  /**
   * Whether the session has a question left to ask.
   *
   * SUPPLIED BY THE CALLER, from `PracticeService.getSession`'s own
   * `nextQuestion` — which is null in exactly three cases (the session is not
   * `in_progress`, its planned count has been reached, or the bank has nothing
   * left this learner can be asked). Re-deriving it here would be a second
   * answer to a question `nextQuestionFor` already answers, free to disagree
   * with the screen the learner is looking at.
   */
  readonly hasQuestionToAsk: boolean;
}

/** Why no session was minted. Both are 409s: the request is fine, the session is not. */
export type PracticeRealtimeMintRefusalReason =
  | 'session_not_in_progress'
  | 'nothing_left_to_ask';

/** {@link decideRealtimeMint}'s answer. */
export type PracticeRealtimeMintDecision =
  | { readonly status: 'ok' }
  | {
      readonly status: 'refused';
      readonly reason: PracticeRealtimeMintRefusalReason;
      readonly error: string;
    };

/**
 * Decide whether a realtime session may be minted for this practice session.
 *
 * BOTH REFUSALS COME BEFORE ANY SPEND, which is the point of deciding it here
 * rather than letting the conversation discover it: a session minted for a
 * completed practice session would bill the learner's own key for a
 * conversation whose first `next_question` call could only be refused.
 *
 * They are 409s rather than 200-with-a-status, and the distinction is the one
 * `InterviewsService.createRealtimeSession` already draws: `unavailable` and
 * `failed` are facts about AI — a deployment with no `realtime` binding, a
 * provider that would not mint — and a client's response to them is to fall
 * back. These two are facts about the SESSION, exactly like the 409 a client
 * gets for answering a completed session, and the client's response is to stop
 * asking.
 */
export function decideRealtimeMint(
  context: PracticeRealtimeMintContext,
): PracticeRealtimeMintDecision {
  if (context.sessionStatus !== 'in_progress') {
    return {
      status: 'refused',
      reason: 'session_not_in_progress',
      error: `Practice session "${context.sessionId}" is ${context.sessionStatus} and accepts no further answers`,
    };
  }

  if (!context.hasQuestionToAsk) {
    return {
      status: 'refused',
      reason: 'nothing_left_to_ask',
      error: `Practice session "${context.sessionId}" has no question left to ask; complete it to see the summary`,
    };
  }

  return { status: 'ok' };
}
