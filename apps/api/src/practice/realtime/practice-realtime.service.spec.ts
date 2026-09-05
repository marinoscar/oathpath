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
    await service.createRealtimeSession(USER_A, SESSION_ID);

    const source = strippedSource();

    for (const write of [
      'auditEvent',
      'prisma',
      'PrismaService',
      'update(',
      'create(',
      'recordAttempt',
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
