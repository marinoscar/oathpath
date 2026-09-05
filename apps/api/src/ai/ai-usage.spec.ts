import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import {
  AiUsageService,
  DEFAULT_USAGE_WINDOW_DAYS,
  MAX_USAGE_WINDOW_DAYS,
  clampWindow,
  summarise,
} from './ai-usage.service';
import { AiUsageController } from './ai-usage.controller';
import { OpenAiProvider } from './providers/openai.provider';
import { AI_USAGE_MAKES_NO_BILLING_CLAIM } from './dto/ai-usage.dto';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../common/clock/clock';
import type { CredentialsService } from '../credentials/credentials.service';
import { PatService } from '../pat/pat.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// AI usage accounting (issue #37, epic #25)
// =============================================================================
//
// Four claims, and three of them describe silent failures — the kind that
// produce a plausible-looking number rather than an error:
//
//   1. Every streaming request sets `stream_options: { include_usage: true }`.
//      Without it OpenAI reports no usage and every streaming call records
//      zero. Nothing fails. A test is the only thing that can notice.
//   2. A mid-stream failure records NULL, not 0. Zero is a claim, and a false
//      one that understates consumption invisibly.
//   3. A failing usage write never fails the originating request.
//   4. The read is caller-scoped and makes no billing claim.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const KEY = 'sk-alice-abcdefghijklmnopqrstu';

// ---------------------------------------------------------------------------
// The OpenAI SDK, mocked at the module boundary
// ---------------------------------------------------------------------------

const chatCreateMock = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: class FakeOpenAI {
    models = { list: jest.fn(), retrieve: jest.fn() };
    chat = { completions: { create: chatCreateMock } };
    embeddings = { create: jest.fn() };
  },
}));

/** A streamed response: content chunks, then the usage chunk. */
function streamOf(
  chunks: Array<{ text?: string; usage?: Record<string, number> }>,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield {
          choices: chunk.text ? [{ delta: { content: chunk.text } }] : [],
          usage: chunk.usage
            ? {
                prompt_tokens: chunk.usage.prompt,
                completion_tokens: chunk.usage.completion,
                total_tokens: chunk.usage.total,
              }
            : undefined,
        };
      }
    },
  };
}

/** A stream that throws partway, as a dropped connection does. */
function brokenStream(before: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: before } }] };
      throw new Error('stream aborted');
    },
  };
}

const REQUEST = {
  roleKey: 'tutor',
  modelId: 'gpt-5.4',
  messages: [{ role: 'user' as const, content: 'why?' }],
};

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('usage recording', () => {
  let provider: OpenAiProvider;
  let record: jest.Mock;

  beforeEach(() => {
    chatCreateMock.mockReset();
    // Returns an id, as `AiUsageService.record` has since #96 — a double that
    // returned nothing would let `usageEventId` be silently dropped.
    record = jest.fn().mockResolvedValue('usage-row-1');

    provider = new OpenAiProvider(
      { getSecret: jest.fn() } as unknown as CredentialsService,
      { record } as unknown as AiUsageService,
    );
  });

  describe('the streaming flag — a silent failure if omitted', () => {
    it('SETS stream_options: { include_usage: true } on every streamed request', async () => {
      // THE test in this file. OpenAI emits usage on a streamed response only
      // when this is set; omit it and every streaming call records zero, with
      // no error and no warning. There is no symptom to notice in production.
      chatCreateMock.mockResolvedValue(
        streamOf([{ text: 'hi' }, { usage: { prompt: 5, completion: 2, total: 7 } }]),
      );

      await provider.complete(ALICE, KEY, { ...REQUEST, stream: true });

      expect(chatCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
        }),
      );
    });

    it('records the usage the flag makes available', async () => {
      chatCreateMock.mockResolvedValue(
        streamOf([{ text: 'hi' }, { usage: { prompt: 5, completion: 2, total: 7 } }]),
      );

      await provider.complete(ALICE, KEY, { ...REQUEST, stream: true });

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ALICE,
          model: 'gpt-5.4',
          roleKey: 'tutor',
          success: true,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        }),
      );
    });

    it('records NULL, not zero, when a stream ends with no usage chunk', async () => {
      // The shape of the bug the flag prevents. Even here the record is
      // honest: we were not told, so we do not claim.
      chatCreateMock.mockResolvedValue(streamOf([{ text: 'hi' }]));

      await provider.complete(ALICE, KEY, { ...REQUEST, stream: true });

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          usage: {
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
          },
        }),
      );
    });

    it('does not set stream_options on a non-streaming request', async () => {
      // Unconditional there; the flag would be meaningless and OpenAI rejects
      // it alongside stream: false.
      chatCreateMock.mockResolvedValue({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      await provider.complete(ALICE, KEY, REQUEST);

      expect(chatCreateMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ stream_options: expect.anything() }),
      );
    });
  });

  describe('a mid-stream failure', () => {
    it('records success:false with NULL token counts, not zeros', async () => {
      // Null means "unknown"; 0 is a claim, and a false one that understates
      // consumption. The counts held mid-stream are not the call's
      // consumption, so reporting them as final would be worse still.
      chatCreateMock.mockResolvedValue(brokenStream('partial'));

      const result = await provider.complete(ALICE, KEY, {
        ...REQUEST,
        stream: true,
      });

      expect(result.success).toBe(false);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          usage: {
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
          },
        }),
      );
    });

    it('records an errorCode that can be grouped by', async () => {
      chatCreateMock.mockResolvedValue(brokenStream('partial'));

      await provider.complete(ALICE, KEY, { ...REQUEST, stream: true });

      const recorded = record.mock.calls[0][0] as { errorCode: string };
      expect(typeof recorded.errorCode).toBe('string');
      expect(recorded.errorCode.length).toBeGreaterThan(0);
    });

    it.each([
      ['429 rate limit exceeded', 'rate_limit'],
      ['Request timeout', 'timeout'],
      ['401 Incorrect API key provided', 'invalid_key'],
      ['The model does not exist', 'model_not_found'],
      ['insufficient_quota', 'quota_exceeded'],
      ['something nobody anticipated', 'error'],
    ])('classifies %p as %p', async (message, code) => {
      chatCreateMock.mockRejectedValue(new Error(message));

      await provider.complete(ALICE, KEY, REQUEST);

      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({ errorCode: code }),
      );
    });
  });

  describe('recording never fails the request', () => {
    it('returns the completion even when the usage write REJECTS', async () => {
      // The user asked for an explanation, not for bookkeeping.
      //
      // `AiUsageService.record` swallows internally, so this exercises the
      // SECOND guard — the one in `complete` itself. That guard is what keeps
      // the promise when the recorder is a different implementation: a test
      // double, a decorator, a future rewrite. Without it the guarantee
      // silently belongs to a collaborator rather than to this method.
      chatCreateMock.mockResolvedValue({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      record.mockRejectedValue(new Error('database is down'));

      const result = await provider.complete(ALICE, KEY, REQUEST);

      expect(result.success).toBe(true);
      expect(result.text).toBe('hi');
      // The completion stands and the link does not: a nullable FK is the
      // caller's half of the same trade.
      expect(result.usageEventId).toBeNull();
    });

    it('hands the recorded row id back to the caller (#96)', async () => {
      // Issue #110 writes this into `practice_attempts.ai_usage_event_id`.
      chatCreateMock.mockResolvedValue({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      const result = await provider.complete(ALICE, KEY, REQUEST);

      expect(result.usageEventId).toBe('usage-row-1');
    });

    it('writes exactly one row per call, success or failure', async () => {
      chatCreateMock.mockResolvedValue({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await provider.complete(ALICE, KEY, REQUEST);
      expect(record).toHaveBeenCalledTimes(1);

      record.mockClear();
      chatCreateMock.mockRejectedValue(new Error('nope'));
      await provider.complete(ALICE, KEY, REQUEST);
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('records no prompt or completion content', async () => {
      chatCreateMock.mockResolvedValue({
        choices: [{ message: { content: 'the secret answer' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await provider.complete(ALICE, KEY, {
        ...REQUEST,
        messages: [{ role: 'user', content: 'my private question' }],
      });

      const recorded = JSON.stringify(record.mock.calls[0][0]);
      expect(recorded).not.toContain('my private question');
      expect(recorded).not.toContain('the secret answer');
      expect(recorded).not.toContain(KEY);
    });

    it('never throws out of complete()', async () => {
      chatCreateMock.mockImplementation(() => {
        throw new Error('exploded');
      });

      await expect(
        provider.complete(ALICE, KEY, REQUEST),
      ).resolves.toMatchObject({ success: false });
    });
  });
});

describe('AiUsageService.record', () => {
  let service: AiUsageService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUsageService,
        { provide: PrismaService, useValue: prisma },
        // `record()` itself never touches the clock — only `describeForUser`
        // does — but the constructor still requires one to resolve.
        { provide: Clock, useValue: { now: jest.fn(), calendarDateIn: jest.fn() } },
      ],
    }).compile();
    service = module.get(AiUsageService);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('SWALLOWS a database failure, reporting it as a null row id', async () => {
    // A usage write that throws would fail the user's request for the sake of
    // an accounting row. `null` rather than `undefined` since #96: it is a
    // VALUE the caller stores in a nullable FK, not an absence it has to
    // interpret — see `practice_attempts.ai_usage_event_id` (#110).
    prisma.aiUsageEvent.create.mockRejectedValue(new Error('db down') as never);

    await expect(
      service.record({
        userId: ALICE,
        provider: 'openai',
        model: 'gpt-5.4',
        roleKey: 'tutor',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 10,
        success: true,
        errorCode: null,
      }),
    ).resolves.toBeNull();
  });

  it('RETURNS THE ROW ID, so a caller can point a foreign key at it', async () => {
    // The whole reason this is no longer `Promise<void>`. Recovering the id
    // afterwards would mean guessing at the most recent row for this user and
    // model, which races the learner's own next answer and is wrong precisely
    // when they are answering quickly.
    prisma.aiUsageEvent.create.mockResolvedValue({ id: 'evt-1' } as never);

    await expect(
      service.record({
        userId: ALICE,
        provider: 'openai',
        model: 'gpt-5.4',
        roleKey: 'grader',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 10,
        success: true,
        errorCode: null,
      }),
    ).resolves.toBe('evt-1');
  });

  it('selects only the id back, and no content column — there are none', async () => {
    prisma.aiUsageEvent.create.mockResolvedValue({ id: 'evt-1' } as never);

    await service.record({
      userId: ALICE,
      provider: 'openai',
      model: 'gpt-5.4',
      roleKey: 'tutor',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 10,
      success: true,
      errorCode: null,
    });

    const written = prisma.aiUsageEvent.create.mock.calls[0][0] as {
      select: Record<string, boolean>;
    };
    expect(written.select).toEqual({ id: true });
  });

  it('passes null counts through as null', async () => {
    prisma.aiUsageEvent.create.mockResolvedValue({ id: 'evt-1' } as never);

    await service.record({
      userId: ALICE,
      provider: 'openai',
      model: 'gpt-5.4',
      roleKey: 'tutor',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      latencyMs: null,
      success: false,
      errorCode: 'timeout',
    });

    const written = prisma.aiUsageEvent.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(written.data.promptTokens).toBeNull();
    expect(written.data.totalTokens).toBeNull();
    expect(written.data.success).toBe(false);
  });
});

describe('AiUsageService.describeForUser', () => {
  let service: AiUsageService;
  let prisma: MockPrismaService;
  let clock: { now: jest.Mock; calendarDateIn: jest.Mock };

  // A fixed instant, well clear of any real "today" this suite might run on,
  // so `timeline`'s upper bound is provably the CLOCK's answer and not
  // whatever `Date.now()` happened to return when the test ran.
  const CLOCK_NOW = new Date('2026-08-15T12:00:00.000Z');

  beforeEach(async () => {
    prisma = createMockPrismaService();
    prisma.aiUsageEvent.findMany.mockResolvedValue([] as never);
    clock = {
      now: jest.fn().mockReturnValue(CLOCK_NOW),
      calendarDateIn: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUsageService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();
    service = module.get(AiUsageService);
  });

  it('passes clock.now() through as the timeline\'s upper bound (#291)', async () => {
    // `summarise`'s `now` parameter used to not exist; `describeForUser` must
    // supply it from the injected `Clock`, never from a bare `Date.now()` —
    // see CLAUDE.md's "Using the Clock" rule. A day-zero-filled timeline whose
    // last entry is anything other than the clock's own day means this call
    // site reached for the wall clock instead.
    const summary = await service.describeForUser(ALICE);

    expect(clock.now).toHaveBeenCalled();
    const lastEntry = summary.timeline[summary.timeline.length - 1];
    expect(lastEntry.date).toBe('2026-08-15');
  });

  it('queries only the calling user\'s rows', async () => {
    await service.describeForUser(ALICE);

    const query = prisma.aiUsageEvent.findMany.mock.calls[0][0] as {
      where: { userId: string };
    };
    expect(query.where.userId).toBe(ALICE);
  });

  it('never returns another user\'s rows', async () => {
    await service.describeForUser(BOB);

    const query = prisma.aiUsageEvent.findMany.mock.calls[0][0] as {
      where: { userId: string };
    };
    expect(query.where.userId).toBe(BOB);
    expect(query.where.userId).not.toBe(ALICE);
  });

  it('selects no content columns — there are none to select', async () => {
    await service.describeForUser(ALICE);

    const query = prisma.aiUsageEvent.findMany.mock.calls[0][0] as {
      select: Record<string, boolean>;
    };
    expect(Object.keys(query.select).sort()).toEqual(
      [
        'completionTokens',
        'createdAt',
        'model',
        'promptTokens',
        'roleKey',
        'success',
        'totalTokens',
      ].sort(),
    );
  });
});

describe('clampWindow', () => {
  it('keeps a sensible window', () => {
    expect(clampWindow(7)).toBe(7);
  });

  it('bounds an absurd one rather than scanning a year of rows', () => {
    expect(clampWindow(100_000)).toBe(MAX_USAGE_WINDOW_DAYS);
    expect(clampWindow(0)).toBe(1);
    expect(clampWindow(-5)).toBe(1);
  });

  it('falls back to the default for a non-finite value', () => {
    // A 400 here would break the page over a query string; this is a display
    // preference, not a contract.
    expect(clampWindow(Number.NaN)).toBe(DEFAULT_USAGE_WINDOW_DAYS);
  });
});

describe('summarise', () => {
  const since = new Date('2026-08-01T00:00:00Z');
  const now = new Date('2026-08-03T12:00:00Z');

  it('EXCLUDES unknown counts from the totals rather than counting them as zero', () => {
    const summary = summarise(
      [
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          success: true,
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          success: false,
          createdAt: new Date('2026-08-01T09:00:00Z'),
        },
      ],
      since,
      now,
    );

    expect(summary.totalTokens).toBe(15);
    expect(summary.calls).toBe(2);
    expect(summary.successfulCalls).toBe(1);
    // The honest caveat on the figure above.
    expect(summary.callsWithUnknownUsage).toBe(1);
  });

  it('breaks down by model and by role', () => {
    const summary = summarise(
      [
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 100,
          success: true,
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
        {
          model: 'gpt-5.4-mini',
          roleKey: 'grader',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 200,
          success: true,
          createdAt: new Date('2026-08-02T08:00:00Z'),
        },
      ],
      since,
      now,
    );

    // Heaviest first, so the expensive thing is at the top.
    expect(summary.byModel.map((b) => b.key)).toEqual([
      'gpt-5.4-mini',
      'gpt-5.4',
    ]);
    expect(summary.byRole.map((b) => b.key)).toEqual(['grader', 'tutor']);
  });

  it('gives an empty window a sensible zero state, not a broken one', () => {
    const summary = summarise([], since, now);

    expect(summary).toMatchObject({
      calls: 0,
      totalTokens: 0,
      byModel: [],
      byRole: [],
    });
  });
});

describe('summarise — timeline (issue #291)', () => {
  it('zero-fills one entry per UTC calendar day from since through now, inclusive, for an empty window', () => {
    const since = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-03T00:00:00Z');

    const summary = summarise([], since, now);

    expect(summary.timeline).toEqual([
      { date: '2026-08-01', calls: 0, totalTokens: 0 },
      { date: '2026-08-02', calls: 0, totalTokens: 0 },
      { date: '2026-08-03', calls: 0, totalTokens: 0 },
    ]);
  });

  it('keeps zero-activity days as explicit entries between days that DO have activity, not omitted', () => {
    const since = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-05T00:00:00Z');

    const summary = summarise(
      [
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 10,
          success: true,
          createdAt: new Date('2026-08-01T08:00:00Z'),
        },
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 20,
          success: true,
          createdAt: new Date('2026-08-04T08:00:00Z'),
        },
      ],
      since,
      now,
    );

    // Five days in the window; only two of them have rows. The gap between
    // the two active days, AND the day after the second one, must still
    // appear — as explicit zero entries, not be skipped.
    expect(summary.timeline).toHaveLength(5);
    const byDate = new Map(summary.timeline.map((point) => [point.date, point]));
    expect(byDate.get('2026-08-01')).toEqual({
      date: '2026-08-01',
      calls: 1,
      totalTokens: 10,
    });
    // THE gap — a day with zero calls present in the array, not omitted.
    expect(byDate.get('2026-08-02')).toEqual({
      date: '2026-08-02',
      calls: 0,
      totalTokens: 0,
    });
    expect(byDate.get('2026-08-03')).toEqual({
      date: '2026-08-03',
      calls: 0,
      totalTokens: 0,
    });
    expect(byDate.get('2026-08-04')).toEqual({
      date: '2026-08-04',
      calls: 1,
      totalTokens: 20,
    });
    expect(byDate.get('2026-08-05')).toEqual({
      date: '2026-08-05',
      calls: 0,
      totalTokens: 0,
    });
  });

  it('is in ascending date order', () => {
    const since = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-06T00:00:00Z');

    // Rows deliberately out of order, to prove the output order comes from
    // the days themselves rather than from row insertion order.
    const summary = summarise(
      [
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 5,
          success: true,
          createdAt: new Date('2026-08-05T08:00:00Z'),
        },
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 5,
          success: true,
          createdAt: new Date('2026-08-02T08:00:00Z'),
        },
      ],
      since,
      now,
    );

    const dates = summary.timeline.map((point) => point.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]);
  });

  it('excludes a null totalTokens from the day\'s total while still counting the call', () => {
    const since = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-01T00:00:00Z');

    const summary = summarise(
      [
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 50,
          success: true,
          createdAt: new Date('2026-08-01T01:00:00Z'),
        },
        {
          model: 'gpt-5.4',
          roleKey: 'tutor',
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          success: false,
          createdAt: new Date('2026-08-01T02:00:00Z'),
        },
      ],
      since,
      now,
    );

    expect(summary.timeline).toEqual([
      // Both calls counted; the null-usage one contributes 0 tokens, not a
      // dropped call and not a claimed count.
      { date: '2026-08-01', calls: 2, totalTokens: 50 },
    ]);
  });

  it('FENCEPOST — since and now on the same UTC calendar day produce exactly one entry', () => {
    const since = new Date('2026-08-01T01:00:00.000Z');
    const now = new Date('2026-08-01T23:00:00.000Z');

    const summary = summarise([], since, now);

    expect(summary.timeline).toEqual([
      { date: '2026-08-01', calls: 0, totalTokens: 0 },
    ]);
  });

  it('FENCEPOST — since and now straddling a UTC calendar-day boundary produce exactly two entries', () => {
    // Under two hours apart, but on different UTC calendar dates.
    const since = new Date('2026-08-01T23:00:00.000Z');
    const now = new Date('2026-08-02T01:00:00.000Z');

    const summary = summarise([], since, now);

    expect(summary.timeline).toEqual([
      { date: '2026-08-01', calls: 0, totalTokens: 0 },
      { date: '2026-08-02', calls: 0, totalTokens: 0 },
    ]);
  });
});

describe('AiUsageController', () => {
  let controller: AiUsageController;
  let usage: { describeForUser: jest.Mock };

  beforeEach(async () => {
    usage = { describeForUser: jest.fn().mockResolvedValue({ calls: 0 }) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiUsageController],
      providers: [
        { provide: AiUsageService, useValue: usage },
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AiUsageController);
  });

  it('passes only the authenticated caller', async () => {
    await controller.getUsage(ALICE, undefined);

    expect(usage.describeForUser).toHaveBeenCalledWith(
      ALICE,
      DEFAULT_USAGE_WINDOW_DAYS,
    );
  });

  it('accepts a numeric window', async () => {
    await controller.getUsage(ALICE, '7');

    expect(usage.describeForUser).toHaveBeenCalledWith(ALICE, 7);
  });

  it('falls back to the default for garbage rather than producing an Invalid Date', async () => {
    // NaN would flow into date arithmetic and silently match nothing — an
    // empty page with no error.
    await controller.getUsage(ALICE, 'not-a-number');

    expect(usage.describeForUser).toHaveBeenCalledWith(
      ALICE,
      DEFAULT_USAGE_WINDOW_DAYS,
    );
  });

  it('makes no billing claim', () => {
    // Token counts are not dollars, this app carries no price table, and some
    // calls record nothing at all.
    expect(AI_USAGE_MAKES_NO_BILLING_CLAIM).toBe(true);
  });
});
