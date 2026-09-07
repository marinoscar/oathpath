import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiDispatchService } from '../../ai/ai-dispatch.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { aiSettingsSchema } from '../../ai/ai-settings.schema';
import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { PracticeService } from '../practice.service';
import { PracticeRealtimeService } from './practice-realtime.service';
import { buildPracticeRealtimeInstructions } from './practice-realtime-instructions';
import { PRACTICE_REALTIME_CLOSING_LINE } from './practice-realtime-lines';
import { SPEAK_VERBATIM_INSTRUCTION } from './practice-realtime-tool-calls';
import { PRACTICE_REALTIME_SESSION_TTL_SECONDS } from './practice-realtime-tools';

// =============================================================================
// PracticeRealtimeService — tests (issue #353, epic #345 / E15)
// =============================================================================
//
// The impure half: what it reads before it spends, what it sends the provider,
// what it returns, and — the assertions that are the point of the file — what
// it never writes anywhere.
//
// `PracticeService` is a DOUBLE here rather than the real class, and
// deliberately so: the two properties under test on that seam are that the
// mint route resolves a session through the ONE ownership-scoped door (so a
// 404 is inherited rather than re-implemented) and that the mint never happens
// when that door refuses. Both are about the CALL, which is only observable on
// something that records being called. The behaviour of `getSession` itself is
// `practice.service.spec.ts`'s subject and is not re-tested here.
// =============================================================================

const USER_A = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const MINTED_SECRET = 'ek_fake_realtime_zyxwvutsrqponmlkjihgfedcba';
const SECRET_EXPIRY = new Date('2026-06-01T12:01:00Z');

/** A live session with a question still to ask. */
function liveDetail(overrides: Record<string, unknown> = {}) {
  return {
    session: { id: SESSION_ID, status: 'in_progress', plannedCount: 5 },
    attempts: [],
    nextQuestion: { id: 'q-1', number: 1, prompt: 'A question?' },
    progress: { answered: 0, planned: 5 },
    ...overrides,
  };
}

describe('PracticeRealtimeService', () => {
  let service: PracticeRealtimeService;
  let practice: { getSession: jest.Mock };
  let dispatch: { createRealtimeSession: jest.Mock };

  beforeEach(async () => {
    practice = { getSession: jest.fn().mockResolvedValue(liveDetail()) };
    dispatch = {
      createRealtimeSession: jest.fn().mockResolvedValue({
        status: 'ok',
        clientSecret: MINTED_SECRET,
        expiresAt: SECRET_EXPIRY,
        modelId: 'gpt-4o-realtime-preview',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PracticeRealtimeService,
        { provide: PracticeService, useValue: practice },
        { provide: AiDispatchService, useValue: dispatch },
      ],
    }).compile();

    service = module.get(PracticeRealtimeService);
  });

  /** The one dispatcher call this route makes. */
  function mintRequest(): {
    instructions: string;
    tools: { name: string; parameters: any }[];
    expiresInSeconds?: number;
    modelId?: string;
    voice?: string;
  } {
    return dispatch.createRealtimeSession.mock.calls[0][1];
  }

  // ---------------------------------------------------------------------------
  // The happy path
  // ---------------------------------------------------------------------------

  it('returns the secret, the provider’s expiry and the model, and nothing else', async () => {
    // The closed list is the point: the browser holds the ephemeral secret and
    // nothing else, and a response that grew a field would be the first step
    // away from that.
    await expect(
      service.createRealtimeSession(USER_A, SESSION_ID),
    ).resolves.toEqual({
      status: 'ok',
      clientSecret: MINTED_SECRET,
      expiresAt: SECRET_EXPIRY.toISOString(),
      modelId: 'gpt-4o-realtime-preview',
    });
  });

  it('echoes the provider’s expiry rather than recomputing one from the TTL', async () => {
    // A value derived here would disagree by the round trip plus the clock
    // skew, in the direction that tells a browser it still has time it does
    // not have.
    const result: any = await service.createRealtimeSession(USER_A, SESSION_ID);

    expect(result.expiresAt).toBe(SECRET_EXPIRY.toISOString());
  });

  it('mints on the caller’s own id, with no model named by this service', async () => {
    await service.createRealtimeSession(USER_A, SESSION_ID);

    expect(dispatch.createRealtimeSession).toHaveBeenCalledWith(
      USER_A,
      expect.any(Object),
    );
    // NO `modelId` FIELD, EVER — `ai-dispatch.service.ts`'s own header rule. A
    // feature that could name its own model could bind itself to whatever the
    // admin configured for a more expensive role, and a realtime session bills
    // by the minute.
    expect(mintRequest().modelId).toBeUndefined();
  });

  it('asks for a bounded session lifetime rather than the provider’s default', async () => {
    await service.createRealtimeSession(USER_A, SESSION_ID);

    expect(mintRequest().expiresInSeconds).toBe(
      PRACTICE_REALTIME_SESSION_TTL_SECONDS,
    );
  });

  it('declares the five tools, and gives the model no field for a verdict', async () => {
    await service.createRealtimeSession(USER_A, SESSION_ID);

    const tools = mintRequest().tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'next_question',
      'grade_answer',
      'repeat_question',
      'skip_question',
      'end_session',
    ]);

    // Restated here, at the layer that actually sends them, rather than only in
    // `practice-realtime-tools.spec.ts`: this is the assertion that the schema
    // the provider is handed is the one with no verdict and no confidence in
    // it.
    const grade = tools.find((tool) => tool.name === 'grade_answer') as any;
    expect(Object.keys(grade.parameters.properties)).toEqual([
      'questionId',
      'transcript',
    ]);
    for (const tool of tools) {
      expect((tool.parameters as any).additionalProperties).toBe(false);
    }
  });

  it('sends the shared instructions, with no question, answer or count in them', async () => {
    await service.createRealtimeSession(USER_A, SESSION_ID);

    expect(mintRequest().instructions).toBe(buildPracticeRealtimeInstructions());
    // The session's own question is right there in the detail this method just
    // read, and none of it reaches the prompt.
    expect(mintRequest().instructions).not.toContain('A question?');
    expect(mintRequest().instructions).not.toMatch(/\d/);
  });

  // ---------------------------------------------------------------------------
  // What the session's own state refuses
  // ---------------------------------------------------------------------------

  it('lets a 404 from the ownership-scoped read through untouched', async () => {
    // `requireSession` filters on `userId` in the `where`, so another
    // learner's session is a 404 and not a 403 — and this method does not
    // catch, translate or soften it.
    practice.getSession.mockRejectedValue(
      new NotFoundException('Practice session "x" not found'),
    );

    await expect(
      service.createRealtimeSession(USER_A, SESSION_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    // AND NOTHING WAS SPENT FINDING OUT.
    expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
  });

  it.each(['completed', 'abandoned'])(
    'refuses to mint for a %s session, before any spend',
    async (status) => {
      practice.getSession.mockResolvedValue(
        liveDetail({
          session: { id: SESSION_ID, status, plannedCount: 5 },
          nextQuestion: null,
        }),
      );

      await expect(
        service.createRealtimeSession(USER_A, SESSION_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
    },
  );

  it('refuses to mint for a session with no question left to ask', async () => {
    // Still `in_progress`, but everything planned has been answered. A session
    // minted here could conduct nothing — its first `next_question` call could
    // only be refused — and it would have cost the learner's key to find out.
    practice.getSession.mockResolvedValue(liveDetail({ nextQuestion: null }));

    await expect(
      service.createRealtimeSession(USER_A, SESSION_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(dispatch.createRealtimeSession).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // The typed AI outcomes
  // ---------------------------------------------------------------------------

  it.each([
    'no_user_key',
    'ai_disabled',
    'role_unbound',
    'capability_unsupported',
  ] as const)(
    'reports %s as a typed payload naming realtime, never a throw',
    async (cause) => {
      dispatch.createRealtimeSession.mockResolvedValue({
        status: 'unavailable',
        cause,
      });

      await expect(
        service.createRealtimeSession(USER_A, SESSION_ID),
      ).resolves.toEqual({ status: 'unavailable', cause, role: 'realtime' });
    },
  );

  it('keeps a provider failure distinct from an unavailable one', async () => {
    // "spoken practice is not set up here" and "that did not work" send a
    // client to two different places: fall back, or offer a retry first.
    dispatch.createRealtimeSession.mockResolvedValue({
      status: 'failed',
      errorCode: 'rate_limited',
      error: 'Too many requests.',
      usageEventId: null,
      modelId: 'gpt-4o-realtime-preview',
    });

    await expect(
      service.createRealtimeSession(USER_A, SESSION_ID),
    ).resolves.toEqual({
      status: 'failed',
      errorCode: 'rate_limited',
      error: 'Too many requests.',
    });
  });

  // ---------------------------------------------------------------------------
  // What this method never writes
  // ---------------------------------------------------------------------------

  it('never writes the minted secret to a log line', async () => {
    // ASSERTED, NOT REVIEWED. The secret is a bearer credential for the minute
    // it is valid, and a log aggregator retains far longer than that. Both
    // levels are captured: the success path logs, and the failure path warns.
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      await service.createRealtimeSession(USER_A, SESSION_ID);

      dispatch.createRealtimeSession.mockResolvedValue({
        status: 'unavailable',
        cause: 'no_user_key',
      });
      await service.createRealtimeSession(USER_A, SESSION_ID);

      const written = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);

      expect(written).not.toContain(MINTED_SECRET);
      // The lines WERE written — otherwise this test would pass against a
      // service that logs nothing at all, which is not the property claimed.
      expect(written).toContain('Realtime practice session minted');
      expect(written).toContain('Realtime practice session could not be minted');
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('opens no span of its own, so the secret cannot become an attribute', () => {
    // The only spans on this path are `BaseAiProvider`'s, whose attributes are
    // the model, the role and a stable code. A source-reading assertion is the
    // honest one here: a behavioural test would have to assert the absence of
    // something nothing in the process emits.
    const source = strippedSource();

    for (const tracing of [
      'setAttribute',
      'startActiveSpan',
      'getActiveSpan',
      '@opentelemetry',
      'trace.',
    ]) {
      expect(source).not.toContain(tracing);
    }
  });

  it('writes nothing at all — no audit row, no session column, no attempt', async () => {
    // THREE ABSENCES IN ONE ASSERTION, and each is a decision:
    //   * no `audit_events` row — `voice.md` §9's posture: this is an
    //     ordinary, per-user, no-permission action on the learner's own
    //     session, not an administrative one;
    //   * no `mode` flip — `conversation-mode.md` §14 rejected a session-level
    //     mode on `practice_sessions` because it could disagree with the
    //     per-row `inputMode` that records what actually happened;
    //   * no attempt row — minting a credential is not evidence of anything.
    //
    // SCOPED TO THE MINT METHOD SINCE #354, and the narrowing is the honest
    // move rather than a weakening. This class gained a second half — the
    // tool-call engine — which DOES call `recordAttempt`, on a different route,
    // for an answer a learner actually gave. A file-wide search would now be
    // asserting something false about the file to keep saying something true
    // about the mint, and the first person to make it pass again would have
    // been tempted to delete a name from the list instead. The list is intact;
    // it is the haystack that shrank to the method the claim is about.
    //
    // Nothing is lost: `practice-realtime-purity.spec.ts` holds the same
    // absences (`prisma`, `PrismaService`, direct table access, the grading
    // ladder) across EVERY file in this directory, and it is a stronger check
    // than this one was.
    await service.createRealtimeSession(USER_A, SESSION_ID);

    const source = mintMethodSource();

    for (const write of [
      'auditEvent',
      'prisma',
      'PrismaService',
      'update(',
      'create(',
      'recordAttempt',
      'completeSession',
      "mode: 'voice'",
    ]) {
      expect(source).not.toContain(write);
    }
  });

  it('reads the session exactly once, through the ownership-scoped door', async () => {
    await service.createRealtimeSession(USER_A, SESSION_ID);

    expect(practice.getSession).toHaveBeenCalledTimes(1);
    expect(practice.getSession).toHaveBeenCalledWith(USER_A, SESSION_ID);
  });
});

/**
 * Just `createRealtimeSession`'s body, with comments removed.
 *
 * The mint runs from its own signature to `handleToolCall`'s, which is the
 * first line of the tool-call half of the class (issue #354). Sliced between
 * two SIGNATURES rather than by brace counting, and deliberately not by a
 * comment marker: comments are stripped before this runs, and a clever brace
 * parser that silently matched the wrong closing one would make the assertion
 * above pass over an empty string. Both bounds are asserted, so a rename makes
 * this fail loudly instead.
 */
function mintMethodSource(): string {
  const source = strippedSource();
  const start = source.indexOf('async createRealtimeSession(');
  const end = source.indexOf('async handleToolCall(');

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

/** This service's own source, with comments removed. */
function strippedSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:fs').readFileSync(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:path').join(__dirname, 'practice-realtime.service.ts'),
    'utf8',
  ) as string)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// =============================================================================
// `systemReady` is unchanged by a `realtime` binding
// =============================================================================
//
// An acceptance criterion of this issue, and it is asserted here — beside the
// feature that depends on the role — rather than only in
// `ai-settings.service.spec.ts`, because it is E15's own regression risk: a
// `realtime` role bound for spoken practice must not decide whether anyone can
// use the application at all.
//
// `systemReady` is computed over the wired roles whose capability is `text`
// (`tutor`, `grader`). `realtime`'s capability is `realtime`, so binding or
// unbinding it moves `unboundRoles` and nothing else. Had it been otherwise,
// every deployment without a realtime binding would hard-block on `AiNotReady`
// the day this epic shipped — learners locked out of typed practice because
// nobody had chosen a model for a voice session they had never been offered.

describe('a realtime binding and system readiness', () => {
  let settings: AiSettingsService;
  let prisma: MockPrismaService;

  function storedSettings(models: Record<string, unknown>) {
    return aiSettingsSchema.parse({
      provider: 'openai',
      enabled: true,
      models,
    });
  }

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiSettingsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CredentialsService,
          useValue: { describe: jest.fn(), setSecret: jest.fn(), getSecret: jest.fn() },
        },
      ],
    }).compile();

    settings = module.get(AiSettingsService);
  });

  async function readiness(models: Record<string, unknown>) {
    prisma.systemSettings.findUnique.mockResolvedValue({
      value: storedSettings(models),
    } as never);

    return settings.describeReadiness();
  }

  it('is ready with the text roles bound and realtime left unbound', async () => {
    const result = await readiness({ tutor: 'gpt-5.4', grader: 'gpt-5.4-mini' });

    expect(result.systemReady).toBe(true);
    // The admin is still told, by name, which model they have not chosen.
    expect(result.unboundRoles).toContain('realtime');
  });

  it('is exactly as ready once realtime IS bound', async () => {
    const before = await readiness({ tutor: 'gpt-5.4', grader: 'gpt-5.4-mini' });
    const after = await readiness({
      tutor: 'gpt-5.4',
      grader: 'gpt-5.4-mini',
      realtime: 'gpt-4o-realtime-preview',
    });

    expect(after.systemReady).toBe(before.systemReady);
    expect(after.systemReady).toBe(true);
    // The ONLY thing that moved is the fine-grained field a voice surface gates
    // on.
    expect(after.unboundRoles).not.toContain('realtime');
  });

  it('stays not-ready for an unbound TEXT role however realtime is set', async () => {
    // The narrowing cuts one way only: binding a realtime model neither
    // creates readiness nor is required for it.
    const result = await readiness({
      grader: 'gpt-5.4-mini',
      realtime: 'gpt-4o-realtime-preview',
    });

    expect(result.systemReady).toBe(false);
    expect(result.unboundRoles).toContain('tutor');
  });
});

// =============================================================================
// PracticeRealtimeService.handleToolCall — tests (issue #354, epic #345 / E15)
// =============================================================================
//
// `PracticeService` is a DOUBLE here, and for this half of the service that is
// not a convenience — it is the only way to assert the property the whole issue
// is about. "This handler calls `recordAttempt` rather than re-implementing its
// ladder" is a statement about a CALL, and a call is only observable on
// something that records being called. What `recordAttempt` then does with the
// arguments is `practice.service.spec.ts`' subject and `practice.integration.
// spec.ts`' equivalence test, not this file's.
//
// So what is asserted here is: which method was called, with exactly which
// arguments, in which situations it was NOT called, and what the model is told
// in each case.
// =============================================================================

const Q1 = 'q1111111-1111-4111-8111-111111111111';

/**
 * A closing coach line, standing in for whatever the bank draws (issue #404).
 *
 * A LITERAL RATHER THAN A REAL BANK LOOKUP, deliberately: this file tests what
 * `endSession` does with the line `completeSession` hands it, not which line
 * the bank picks. `practice.service.spec.ts` already owns the second question
 * ("the closing line is drawn from the curated bank, in the learner's own
 * persona") and asserting it twice would tie this suite to a bank edit that
 * has nothing to do with the transport.
 */
const CLOSING_COACH_LINE = 'That’s a wrap. Come back and beat it.';
const Q2 = 'q2222222-2222-4222-8222-222222222222';

describe('PracticeRealtimeService.handleToolCall', () => {
  let service: PracticeRealtimeService;
  let practice: {
    getSession: jest.Mock;
    recordAttempt: jest.Mock;
    completeSession: jest.Mock;
  };

  /** A session detail with one question outstanding and `answered` recorded. */
  function detail({
    status = 'in_progress',
    question = { id: Q1, number: 1, prompt: 'Who is the Chief Justice?' },
    answered = 0,
    planned = 5,
  }: {
    status?: string;
    question?: { id: string; number: number; prompt: string } | null;
    answered?: number;
    planned?: number;
  } = {}) {
    return {
      session: { id: SESSION_ID, status, plannedCount: planned },
      attempts: [],
      nextQuestion: question,
      progress: { answered, planned },
    };
  }

  /** What `recordAttempt` hands back: an attempt with its composed turn. */
  function recorded(overrides: Record<string, unknown> = {}) {
    return {
      attempt: {
        id: 'attempt-1',
        outcome: 'correct',
        spokenTurn: ['That’s right.', 'Nice one.'],
        retryBoundary: null,
        ...overrides,
      },
      acceptedAnswers: [{ text: 'John Roberts' }],
      nextQuestion: null,
      progress: { answered: 1, planned: 5 },
    };
  }

  beforeEach(async () => {
    practice = {
      getSession: jest.fn().mockResolvedValue(detail()),
      recordAttempt: jest.fn().mockResolvedValue(recorded()),
      // `spokenTurn` IS PART OF THE CONTRACT THIS DOUBLE STANDS IN FOR (issue
      // #404). `toSessionResponse` always sets it — `composeSessionClosingTurn`'s
      // output, one persona line or `[]` — and `endSession` now speaks it before
      // the code-owned closing. A fixture without the field would have let the
      // regression this fixes reappear as `undefined` spreading to nothing.
      completeSession: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        spokenTurn: [CLOSING_COACH_LINE],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PracticeRealtimeService,
        { provide: PracticeService, useValue: practice },
        {
          provide: AiDispatchService,
          // NEVER REACHED ON THIS PATH, and asserted below. A tool call spends
          // nothing: the connection is already open and already billing, and
          // this application is not in its data path.
          useValue: { createRealtimeSession: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(PracticeRealtimeService);
  });

  const call = (tool: any) => service.handleToolCall(USER_A, SESSION_ID, tool);

  /** Ask for a question, so something is outstanding in the ledger. */
  const ask = () => call({ tool: 'next_question' });

  // ---------------------------------------------------------------------------
  // next_question
  // ---------------------------------------------------------------------------

  it('serves the question’s own prompt, verbatim and alone', async () => {
    await expect(ask()).resolves.toEqual({
      status: 'ok',
      tool: 'next_question',
      say: ['Who is the Chief Justice?'],
      then: 'await_answer',
      questionId: Q1,
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      // THE SCREEN'S COPY OF THE SAME FACT (#402). The browser renders this
      // rather than resolving `nextQuestion` for itself, which is what had it
      // showing one question while the coach asked another.
      question: { id: Q1, number: 1, prompt: 'Who is the Chief Justice?' },
    });
  });

  it('returns no verdict-shaped field, ever', async () => {
    // The runtime half of `OK_RESULT_DECLARES_NO_VERDICT`: a model that cannot
    // SEND a grade must not be TOLD one either.
    const result: any = await ask();

    for (const forbidden of ['outcome', 'correct', 'score', 'failureCause']) {
      expect(result).not.toHaveProperty(forbidden);
    }
  });

  it('names the same question in `question` as in `questionId`, always (#402)', async () => {
    // ONE FACT, TWO SHAPES, and this is what keeps them from becoming two
    // facts. `questionId` is the join key the model quotes back on its next
    // `grade_answer`; `question` is what the browser renders. A result where
    // they disagreed would put the learner back where #402 found them —
    // reading one question and being asked another — with the divergence
    // moved inside a single response instead of between two of them.
    await ask();

    const results: any[] = [
      await call({ tool: 'repeat_question' }),
      await call({ tool: 'grade_answer', questionId: Q1, transcript: 'John Roberts' }),
      await ask(),
      await call({ tool: 'end_session', reason: 'learner_asked' }),
    ];

    for (const result of results) {
      expect(result.status).toBe('ok');
      expect(result.question?.id ?? null).toBe(result.questionId);
    }
  });

  it('tells every honoured result to speak `say` verbatim, in the same words (#403)', async () => {
    // THE INSTRUCTION MUST NOT VARY WITH THE OUTCOME, and this is the runtime
    // half of that rule. A per-result instruction is how the model is told
    // that `say` is to be spoken rather than summarised — the defect #403
    // recorded — but an instruction free to be warmer after a right answer
    // than after a wrong one would be a verdict travelling back to the model
    // in a field `OK_RESULT_DECLARES_NO_VERDICT` does not police.
    await ask();

    const results: any[] = [
      await call({ tool: 'repeat_question' }),
      await call({ tool: 'grade_answer', questionId: Q1, transcript: 'John Roberts' }),
      await ask(),
      await call({ tool: 'end_session', reason: 'learner_asked' }),
    ];

    for (const result of results) {
      expect(result.status).toBe('ok');
      expect(result.instruction).toBe(SPEAK_VERBATIM_INSTRUCTION);
    }
  });

  it('refuses a second question while the first is unanswered', async () => {
    await ask();

    const result: any = await call({ tool: 'next_question' });

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('answer_outstanding');
    expect(result.instruction).toContain('grade_answer');
  });

  it('serves the question again for a connection that never heard it', async () => {
    // THE FORGETFUL CASE, which is what a re-mint after a dropped connection
    // looks like: nothing was recorded, so the same question is served again.
    // Redundant speech, never a lost answer.
    await expect(ask()).resolves.toMatchObject({ questionId: Q1 });
  });

  it('refuses every tool once the session is closed', async () => {
    practice.getSession.mockResolvedValue(
      detail({ status: 'completed', question: null }),
    );

    for (const tool of [
      { tool: 'next_question' },
      { tool: 'repeat_question' },
      { tool: 'grade_answer', questionId: Q1, transcript: 'x' },
      { tool: 'skip_question', questionId: Q1 },
      { tool: 'end_session', reason: 'learner_asked' },
    ]) {
      const result: any = await call(tool);
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('session_not_in_progress');
    }

    expect(practice.recordAttempt).not.toHaveBeenCalled();
    expect(practice.completeSession).not.toHaveBeenCalled();
  });

  it('refuses next_question once the planned count is reached, pointing at end_session', async () => {
    practice.getSession.mockResolvedValue(
      detail({ question: null, answered: 5, planned: 5 }),
    );

    const result: any = await call({ tool: 'next_question' });

    expect(result.reason).toBe('no_questions_left');
    expect(result.instruction).toContain('end_session');
  });

  it('refuses next_question when the bank is exhausted short of the planned count', async () => {
    // The case that would DEADLOCK if `questionsRemaining` were plain
    // arithmetic: nothing left to serve, but four of five answered. Both the
    // refusal here and the honoured `end_session` below depend on the same
    // derivation.
    practice.getSession.mockResolvedValue(
      detail({ question: null, answered: 4, planned: 5 }),
    );

    await expect(call({ tool: 'next_question' })).resolves.toMatchObject({
      reason: 'no_questions_left',
    });
    await expect(
      call({ tool: 'end_session', reason: 'no_questions_left' }),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  // ---------------------------------------------------------------------------
  // repeat_question
  // ---------------------------------------------------------------------------

  it('repeats the SAME words, not a fresh draw', async () => {
    await ask();

    // The selector shuffles, so `getSession` can legitimately name a different
    // question on the next read. A repeat that re-read it would hand the
    // learner a different question while the coach said it was the same one.
    practice.getSession.mockResolvedValue(
      detail({
        question: { id: Q2, number: 2, prompt: 'A completely different one?' },
      }),
    );

    const result: any = await call({ tool: 'repeat_question' });

    expect(result).toEqual({
      status: 'ok',
      tool: 'repeat_question',
      say: ['Who is the Chief Justice?'],
      then: 'await_answer',
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      // THE LEDGER'S OWN ENTRY, not the fresh draw the mock now returns —
      // the same reason `say` is the original words.
      question: { id: Q1, number: 1, prompt: 'Who is the Chief Justice?' },
      questionId: Q1,
    });
    expect(practice.recordAttempt).not.toHaveBeenCalled();
  });

  it('refuses a repeat when nothing has been asked on this connection', async () => {
    // A re-minted connection after a drop: the model has lost the conversation
    // and so has this process. There is genuinely nothing to repeat, and the
    // instruction sends it to `next_question` rather than inventing one.
    const result: any = await call({ tool: 'repeat_question' });

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('no_answer_outstanding');
    expect(result.instruction).toContain('next_question');
  });

  it('a repeat still blocks the next question', async () => {
    await ask();
    await call({ tool: 'repeat_question' });

    await expect(call({ tool: 'next_question' })).resolves.toMatchObject({
      reason: 'answer_outstanding',
    });
  });

  // ---------------------------------------------------------------------------
  // grade_answer
  // ---------------------------------------------------------------------------

  it('records an answer through recordAttempt, spoken and heard', async () => {
    await ask();
    await call({ tool: 'grade_answer', questionId: Q1, transcript: 'John Roberts' });

    expect(practice.recordAttempt).toHaveBeenCalledTimes(1);
    expect(practice.recordAttempt).toHaveBeenCalledWith(USER_A, SESSION_ID, {
      questionId: Q1,
      // BOTH COLUMNS, THE SAME STRING — what was graded, and what came back
      // from recognition.
      responseText: 'John Roberts',
      transcript: 'John Roberts',
      skipped: false,
      // NO NEW ENUM VALUE. A `realtime` input mode would drop every attempt
      // from this transport out of readiness's `spoken` filter.
      inputMode: 'spoken',
      promptMode: 'heard',
      revealed: false,
      hintUsed: false,
    });
  });

  it('passes no confidence, no duration and no retry link', async () => {
    // ABSENT MEANS UNKNOWN. `grade_answer` carries no confidence argument (a
    // model's certainty about its own hearing is not a recogniser's
    // measurement), and this application is not in the connection's data path,
    // so it cannot time an answer either. A zero or a null-as-a-claim would be
    // a specific, false statement.
    await ask();
    await call({ tool: 'grade_answer', questionId: Q1, transcript: 'x' });

    const input = practice.recordAttempt.mock.calls[0][2];

    expect(input).not.toHaveProperty('asrConfidence');
    expect(input).not.toHaveProperty('durationMs');
    expect(input).not.toHaveProperty('retryOfAttemptId');
  });

  it('speaks the composed turn, verbatim and in order', async () => {
    await ask();

    const result: any = await call({
      tool: 'grade_answer',
      questionId: Q1,
      transcript: 'John Roberts',
    });

    expect(result).toEqual({
      status: 'ok',
      tool: 'grade_answer',
      say: ['That’s right.', 'Nice one.'],
      then: 'ask_next_question',
      // Nothing is outstanding now — the next question is served by the next
      // `next_question`, which is the only thing that makes one outstanding.
      questionId: null,
      // THE SAME INSTRUCTION AS EVERY OTHER HONOURED RESULT. It is what tells
      // the model that `say` — which is the only place a verdict ever reaches
      // a learner on this transport — is to be spoken rather than summarised.
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      // NULL FOR THE SAME REASON `questionId` IS: the two never disagree.
      question: null,
    });
  });

  it('says the session is complete when the last question is answered', async () => {
    practice.getSession.mockResolvedValue(detail({ answered: 4, planned: 5 }));

    await ask();

    const result: any = await call({
      tool: 'grade_answer',
      questionId: Q1,
      transcript: 'John Roberts',
    });

    // AN ACTION, NOT AN OUTCOME. It says this because the COUNT ran out, and
    // would say the identical thing for a wrong answer.
    expect(result.then).toBe('session_complete');
  });

  it('refuses an answer naming a question the session is not waiting on', async () => {
    await ask();

    const result: any = await call({
      tool: 'grade_answer',
      questionId: Q2,
      transcript: 'something',
    });

    expect(result.reason).toBe('wrong_question');
    // NEVER SILENTLY ATTRIBUTED. On this path a mis-attribution is not a
    // confusing sentence — it is a row and a mastery update about a question
    // the learner was never asked.
    expect(practice.recordAttempt).not.toHaveBeenCalled();
  });

  it('refuses an answer when nothing is outstanding', async () => {
    practice.getSession.mockResolvedValue(
      detail({ question: null, answered: 5 }),
    );

    const result: any = await call({
      tool: 'grade_answer',
      questionId: Q1,
      transcript: 'something',
    });

    expect(result.reason).toBe('no_answer_outstanding');
    expect(practice.recordAttempt).not.toHaveBeenCalled();
  });

  it('refuses a blank transcript rather than recording a wrong answer', async () => {
    // THE FALSE CLAIM THIS PREVENTS: graded, an empty string is `incorrect` —
    // evidence that the learner answered and missed, about somebody who said
    // nothing — and the question lapses on the strength of it.
    await ask();

    for (const transcript of ['', '   ', '\n\t ']) {
      practice.recordAttempt.mockClear();

      const result: any = await call({
        tool: 'grade_answer',
        questionId: Q1,
        transcript,
      });

      expect(result.reason).toBe('empty_transcript');
      expect(practice.recordAttempt).not.toHaveBeenCalled();
    }
  });

  it('converts the already-answered conflict into a rejection, never a 5xx', async () => {
    // A DUPLICATE TOOL CALL IS ROUTINE HERE — a retry after a slow
    // acknowledgement, two calls racing a connection hiccup, a re-mint
    // replaying the last turn. A non-2xx would be flattened by the relay in
    // the middle of a live, per-minute-billing conversation.
    await ask();

    practice.recordAttempt.mockRejectedValue(
      new ConflictException('Question "x" has already been answered in this session'),
    );

    const result: any = await call({
      tool: 'grade_answer',
      questionId: Q1,
      transcript: 'John Roberts',
    });

    expect(result).toEqual({
      status: 'rejected',
      tool: 'grade_answer',
      reason: 'already_answered',
      error: expect.any(String),
      instruction: expect.stringContaining('next_question'),
    });
  });

  it('lets a NotFound out rather than dressing it up as a refusal', async () => {
    // The question this service derived from the session's own `nextQuestion`
    // not existing is a programming error, not something the model did wrong,
    // and telling it to carry on would hide a broken deployment behind a
    // conversation that keeps going.
    await ask();

    practice.recordAttempt.mockRejectedValue(new NotFoundException('gone'));

    await expect(
      call({ tool: 'grade_answer', questionId: Q1, transcript: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // skip_question
  // ---------------------------------------------------------------------------

  it('records a skip as a skip, with nothing revealed', async () => {
    await ask();
    await call({ tool: 'skip_question', questionId: Q1 });

    expect(practice.recordAttempt).toHaveBeenCalledWith(USER_A, SESSION_ID, {
      questionId: Q1,
      // NO RESPONSE AND NO TRANSCRIPT — the shape that produces
      // `outcome: 'skipped'`. A skip is the learner declining to answer, not an
      // answer that missed.
      responseText: undefined,
      transcript: undefined,
      skipped: true,
      inputMode: 'spoken',
      promptMode: 'heard',
      // FALSE, DELIBERATELY: the accepted answer is spoken AFTER the row is
      // written, so `true` would be a false claim about when they saw it — and
      // `revealed` is the precondition for self-marking.
      revealed: false,
      hintUsed: false,
    });
  });

  it('refuses a skip naming a question that is not outstanding', async () => {
    await ask();

    const result: any = await call({ tool: 'skip_question', questionId: Q2 });

    expect(result.reason).toBe('wrong_question');
    expect(practice.recordAttempt).not.toHaveBeenCalled();
  });

  it('converts an already-answered skip too', async () => {
    await ask();

    practice.recordAttempt.mockRejectedValue(new ConflictException('dup'));

    await expect(
      call({ tool: 'skip_question', questionId: Q1 }),
    ).resolves.toMatchObject({
      status: 'rejected',
      tool: 'skip_question',
      reason: 'already_answered',
    });
  });

  // ---------------------------------------------------------------------------
  // end_session
  // ---------------------------------------------------------------------------

  it('believes the learner and completes the session', async () => {
    const result: any = await call({
      tool: 'end_session',
      reason: 'learner_asked',
    });

    expect(practice.completeSession).toHaveBeenCalledWith(USER_A, SESSION_ID);
    expect(result).toEqual({
      status: 'ok',
      tool: 'end_session',
      say: [
        CLOSING_COACH_LINE,
        expect.stringContaining('end of this practice session'),
      ],
      then: 'session_complete',
      questionId: null,
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      question: null,
    });
  });

  // ---------------------------------------------------------------------------
  // end_session — the coach's closing line (issue #404)
  // ---------------------------------------------------------------------------
  //
  // THE ONE PLACE THIS TRANSPORT USED TO END FLAT. Every other spoken turn on
  // this transport is `composeSpokenTurn`'s output, coach line included; the
  // closing was a lone code-owned constant, so a learner who chose a persona
  // heard it on every answer and then lost it at the one moment a session has
  // a last word. `practice.service.spec.ts` proves `completeSession` composes
  // the line; these prove this transport speaks it.
  // ---------------------------------------------------------------------------

  it('speaks the session’s own closing coach line before the code-owned closing', async () => {
    const result: any = await call({
      tool: 'end_session',
      reason: 'learner_asked',
    });

    // THE COACH FIRST, THE DOOR LAST — the order the return statement argues
    // for. Asserted as positions rather than as `toContain`, because "the
    // closing line is last" is the half `COACH_INVARIANT_FLOOR`'s closing rule
    // actually cares about and a containment check would pass either way round.
    expect(result.say[0]).toBe(CLOSING_COACH_LINE);
    expect(result.say[result.say.length - 1]).toBe(
      PRACTICE_REALTIME_CLOSING_LINE,
    );
  });

  it('composes nothing of its own — the closing line is whatever the session returned', async () => {
    // A DIFFERENT PERSONA'S LINE, and the only thing that changes. If this
    // method ever grew a bank lookup, a persona branch, or a rewrite of the
    // string it is handed, this is the test that fails: the assertion is
    // equality with the exact bytes the double returned, not a shape.
    practice.completeSession.mockResolvedValue({
      id: SESSION_ID,
      spokenTurn: ['You showed up. That counts, and it compounds.'],
    });

    const result: any = await call({
      tool: 'end_session',
      reason: 'learner_asked',
    });

    expect(result.say).toEqual([
      'You showed up. That counts, and it compounds.',
      PRACTICE_REALTIME_CLOSING_LINE,
    ]);
  });

  it('says the closing line alone when the learner has reactions off', async () => {
    // `[]` IS THE ORDINARY ANSWER for `coach.reactions: false`, and it is the
    // shape `toCoachReaction` produces — the preference became `null` once,
    // server-side. Silence here must be silence, never a neutral substitute
    // line standing in for the coach, and the session must still end.
    practice.completeSession.mockResolvedValue({
      id: SESSION_ID,
      spokenTurn: [],
    });

    const result: any = await call({
      tool: 'end_session',
      reason: 'learner_asked',
    });

    expect(result.say).toEqual([PRACTICE_REALTIME_CLOSING_LINE]);
  });

  it('refuses "no questions left" while the session still has questions', async () => {
    // A model deciding the session is over. Believed, it would cut the session
    // short and the summary screen would agree with it.
    const result: any = await call({
      tool: 'end_session',
      reason: 'no_questions_left',
    });

    expect(result.reason).toBe('questions_remain');
    expect(result.instruction).toContain('next_question');
    expect(practice.completeSession).not.toHaveBeenCalled();
  });

  it('is idempotent under a double end_session', async () => {
    // `completeSession` is idempotent by its own contract — the stored summary
    // comes back unchanged and `completedAt` is not re-stamped — so a re-mint
    // racing the original ends the session once however many times it is
    // asked.
    const first: any = await call({ tool: 'end_session', reason: 'learner_asked' });
    const second: any = await call({ tool: 'end_session', reason: 'learner_asked' });

    expect(practice.completeSession).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it('answers a session closed underneath it with a refusal, not an exception', async () => {
    practice.completeSession.mockRejectedValue(
      new ConflictException('Session "x" is abandoned and cannot be completed'),
    );

    const result: any = await call({
      tool: 'end_session',
      reason: 'learner_asked',
    });

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('session_not_in_progress');
  });

  // ---------------------------------------------------------------------------
  // What the whole path never does
  // ---------------------------------------------------------------------------

  it('resolves the session through the one ownership-scoped door, every time', async () => {
    // A 404 for another learner's session is inherited from `getSession`'s own
    // `userId` filter rather than re-implemented here — the same property the
    // mint route above relies on.
    await call({ tool: 'next_question' });

    expect(practice.getSession).toHaveBeenCalledWith(USER_A, SESSION_ID);
  });

  it('spends nothing: no mint, no dispatcher call', async () => {
    await ask();
    await call({ tool: 'grade_answer', questionId: Q1, transcript: 'John Roberts' });
    await call({ tool: 'end_session', reason: 'learner_asked' });

    // The only AI call reachable from this path at all is the grading ladder's
    // own rung 2, which happens INSIDE `recordAttempt` — one layer below the
    // double above — and degrades to the deterministic verdict when nothing is
    // configured.
    expect(
      (service as any).dispatch.createRealtimeSession,
    ).not.toHaveBeenCalled();
  });
});
