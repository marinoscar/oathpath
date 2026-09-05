import { decideRealtimeMint } from './practice-realtime-mint';

// =============================================================================
// The mint rule — tests (issue #353, epic #345 / E15)
// =============================================================================
//
// Two refusals, and both exist to happen BEFORE anything is spent: a session
// minted for a practice session that can conduct nothing would bill the
// learner's own key for a conversation whose first `next_question` call could
// only be refused.
// =============================================================================

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const context = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID,
  sessionStatus: 'in_progress',
  hasQuestionToAsk: true,
  ...overrides,
}) as Parameters<typeof decideRealtimeMint>[0];

describe('decideRealtimeMint', () => {
  it('mints for an in-progress session with a question left to ask', () => {
    expect(decideRealtimeMint(context())).toEqual({ status: 'ok' });
  });

  it.each(['completed', 'abandoned'])('refuses a %s session', (status) => {
    const decision = decideRealtimeMint(context({ sessionStatus: status }));

    expect(decision).toEqual({
      status: 'refused',
      reason: 'session_not_in_progress',
      error: expect.stringContaining(status),
    });
  });

  it('names the session in the refusal, so a client can tell which one', () => {
    const decision: any = decideRealtimeMint(context({ sessionStatus: 'completed' }));

    expect(decision.error).toContain(SESSION_ID);
  });

  it('refuses an in-progress session with nothing left to ask', () => {
    // `getSession`'s own `nextQuestion` is null in exactly three cases, and
    // this is the one that is not a status: everything planned has been
    // answered, or the bank has nothing left this learner can be asked.
    expect(
      decideRealtimeMint(context({ hasQuestionToAsk: false })),
    ).toEqual({
      status: 'refused',
      reason: 'nothing_left_to_ask',
      error: expect.stringContaining(SESSION_ID),
    });
  });

  it('checks the status before the question, so a closed session says so', () => {
    // Both conditions hold on a completed session (its `nextQuestion` is null
    // too). The status is the more specific fact and the one a client can act
    // on, so it is the one reported.
    expect(
      decideRealtimeMint(
        context({ sessionStatus: 'completed', hasQuestionToAsk: false }),
      ),
    ).toMatchObject({ reason: 'session_not_in_progress' });
  });
});
