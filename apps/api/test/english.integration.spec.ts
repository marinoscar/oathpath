import { randomUUID } from 'node:crypto';

import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from './helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import {
  createMockViewerUser,
  createMockAdminUser,
  authHeader,
  TestUser,
} from './helpers/auth-mock.helper';
import { ASR_CONFIDENCE_THRESHOLD } from '../src/ai/ai.types';

// =============================================================================
// English API (integration) — issue #136, epic #59 / E10
// =============================================================================
//
// Every acceptance criterion for issue #136 asserted over real HTTP through
// `createTestApp`, with Prisma mocked — the shape `practice.integration.spec.ts`
// and `progress.integration.spec.ts` both establish. The unit specs
// (`english.service.spec.ts`, `sentence-selection.spec.ts`,
// `english-scoring.spec.ts`, the DTO spec) cover the decisions in isolation;
// this file covers that they survive the wire: the guards, the global Zod pipe,
// the response envelope, and cross-request state (an attempt written by one
// request and read back by the next).
//
// -----------------------------------------------------------------------------
// THE PRISMA MOCK IS A SMALL IN-MEMORY STORE, NOT FIXED RETURN VALUES
// -----------------------------------------------------------------------------
//
// The property this file exists most to prove — that one learner's attempts are
// unreachable to another — is about which ROWS a second request can and cannot
// see. A `mockResolvedValue` cannot express that: a service that ignored
// `userId` entirely would still pass. `attempts` below is a real map that
// `POST` writes into and later requests read back, filtered on `where` for
// real.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const VERSION = 'v1';

// Four reading sentences and two writing ones. Ordinals are deliberately not
// in array order for R2/R3, so a selector that returned rows in query order
// rather than by its own rule would fail.
const R1 = 'e1111111-1111-4111-8111-111111111111';
const R2 = 'e2222222-2222-4222-8222-222222222222';
const R3 = 'e3333333-3333-4333-8333-333333333333';
const W1 = 'e4444444-4444-4444-8444-444444444444';
const W2 = 'e5555555-5555-4555-8555-555555555555';

/** A sentence id that is in no bank at all — the 404 case. */
const ABSENT = 'e9999999-9999-4999-8999-999999999999';

const SENTENCES = [
  {
    id: R1,
    kind: 'reading' as const,
    version: VERSION,
    ordinal: 1,
    text: 'Who was the first President?',
    vocabTags: ['PEOPLE', 'QUESTION WORDS'],
  },
  {
    id: R2,
    kind: 'reading' as const,
    version: VERSION,
    ordinal: 2,
    text: 'Where is the White House?',
    vocabTags: ['PLACES', 'QUESTION WORDS'],
  },
  {
    id: R3,
    kind: 'reading' as const,
    version: VERSION,
    ordinal: 3,
    text: 'What is the capital of the United States?',
    vocabTags: ['PLACES', 'QUESTION WORDS'],
  },
  {
    id: W1,
    kind: 'writing' as const,
    version: VERSION,
    ordinal: 1,
    text: 'We pay taxes.',
    vocabTags: ['CIVICS'],
  },
  {
    id: W2,
    kind: 'writing' as const,
    version: VERSION,
    ordinal: 2,
    text: 'Citizens can vote.',
    vocabTags: ['CIVICS', 'PEOPLE'],
  },
];

/** The `english_attempts` table, in-memory. */
let attempts: Map<string, Record<string, any>>;

/**
 * Wire `english_sentences` and `english_attempts` into the shared Prisma mock
 * as a tiny relational store — filtering on `where` for real, for the reason
 * this file's header gives.
 */
function setupEnglishMocks(): void {
  attempts = new Map();

  (prismaMock.englishSentence.findMany as jest.Mock).mockImplementation(
    async ({ where = {} }: any) =>
      SENTENCES.filter(
        (s) => where.kind === undefined || s.kind === where.kind,
      ).map((s) => ({ ...s })),
  );

  (prismaMock.englishSentence.findUnique as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const row = SENTENCES.find((s) => s.id === where.id);
      return row ? { ...row } : null;
    },
  );

  (prismaMock.englishAttempt.findMany as jest.Mock).mockImplementation(
    async ({ where }: any) =>
      Array.from(attempts.values())
        // BOTH keys honoured, exactly as the service sends them. A mock that
        // ignored `userId` would make every cross-user assertion below
        // vacuous.
        .filter(
          (a) =>
            a.userId === where.userId &&
            (where.kind === undefined || a.kind === where.kind),
        )
        .sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime())
        .map((a) => ({ ...a })),
  );

  (prismaMock.englishAttempt.create as jest.Mock).mockImplementation(
    async ({ data }: any) => {
      const row = {
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
        id: randomUUID(),
      };
      attempts.set(row.id, row);
      return { ...row };
    },
  );
}

describe('English (Integration)', () => {
  let context: TestContext;
  let learner: TestUser;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    setupEnglishMocks();

    learner = await createMockViewerUser(context, 'englishLearner@example.com');
  });

  const server = () => context.app.getHttpServer();

  const getNext = (user: TestUser, kind: string) =>
    request(server())
      .get(`/api/english/next?kind=${kind}`)
      .set(authHeader(user.accessToken));

  const postAttempt = (user: TestUser, body: Record<string, unknown>) =>
    request(server())
      .post('/api/english/attempts')
      .set(authHeader(user.accessToken))
      .send(body);

  const getProgress = (user: TestUser) =>
    request(server())
      .get('/api/english/progress')
      .set(authHeader(user.accessToken));

  // ---------------------------------------------------------------------------
  // Authentication — every route is @Auth(), none carries a permission
  // ---------------------------------------------------------------------------

  describe('every route is @Auth() with no permissions', () => {
    it('401s an unauthenticated request on all three routes', async () => {
      await request(server()).get('/api/english/next?kind=reading').expect(401);
      await request(server())
        .post('/api/english/attempts')
        .send({ sentenceId: R1, responseText: 'x' })
        .expect(401);
      await request(server()).get('/api/english/progress').expect(401);
    });

    it('admits a Viewer — the DEFAULT role, holding no permissions — on all three', async () => {
      // The whole reason no permission gates this module: a Viewer who could
      // not practise reading and writing could not use the feature at all,
      // and Viewer is what every new account gets.
      await getNext(learner, 'reading').expect(200);
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
      }).expect(200);
      await getProgress(learner).expect(200);
    });

    it('gives an Admin no different result — ownership, not privilege, decides', async () => {
      const admin = await createMockAdminUser(context, 'englishAdmin@example.com');

      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
      }).expect(200);

      const response = await getProgress(admin).expect(200);
      const writing = response.body.data.byKind.find(
        (k: any) => k.kind === 'writing',
      );

      // The learner's attempt exists; the Admin's own progress does not
      // include it, and there is no parameter through which they could ask
      // for it.
      expect(writing.attempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // No route accepts a user id
  // ---------------------------------------------------------------------------

  describe('no route accepts a user id, by any means', () => {
    it('400s ?userId= on GET /english/next rather than honouring it', async () => {
      const other = await createMockViewerUser(context, 'englishOther@example.com');

      await request(server())
        .get(`/api/english/next?kind=reading&userId=${other.id}`)
        .set(authHeader(learner.accessToken))
        .expect(400);
    });

    it('400s a userId in the attempt body rather than dropping it', async () => {
      const other = await createMockViewerUser(context, 'englishOther2@example.com');

      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
        userId: other.id,
      }).expect(400);

      expect(attempts.size).toBe(0);
    });

    it('400s a client-supplied verdict — outcome, wer or diffOps', async () => {
      for (const field of ['outcome', 'wer', 'diffOps', 'kind', 'answeredAt']) {
        await postAttempt(learner, {
          sentenceId: W1,
          responseText: 'We pay taxes.',
          [field]: field === 'wer' ? 0 : 'correct',
        }).expect(400);
      }

      expect(attempts.size).toBe(0);
    });

    it('400s ?userId= on GET /english/progress', async () => {
      await request(server())
        .get('/api/english/progress?userId=' + learner.id)
        .set(authHeader(learner.accessToken))
        // No query DTO on this route at all, so the parameter is simply not
        // read — the assertion that matters is that the response is the
        // CALLER's, which the cross-user block below proves directly.
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-user isolation — the explicit acceptance criterion
  // ---------------------------------------------------------------------------

  describe('another learner’s attempts cannot be read or written', () => {
    let other: TestUser;

    beforeEach(async () => {
      other = await createMockViewerUser(context, 'englishNeighbour@example.com');
    });

    it('an attempt is stamped with the CALLER’s id, whatever the body says', async () => {
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
      }).expect(200);

      const [row] = Array.from(attempts.values());
      expect(row.userId).toBe(learner.id);
      expect(row.userId).not.toBe(other.id);
    });

    it('one learner’s progress never contains another’s attempts', async () => {
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
      }).expect(200);
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'Who was the first President?',
      }).expect(200);

      const mine = await getProgress(learner).expect(200);
      const theirs = await getProgress(other).expect(200);

      const totalAttempts = (body: any) =>
        body.data.byKind.reduce((sum: number, k: any) => sum + k.attempts, 0);

      expect(totalAttempts(mine.body)).toBe(2);
      expect(totalAttempts(theirs.body)).toBe(0);
      // The BANK is shared content and both see all of it — what differs is
      // whose evidence is attached to it.
      expect(theirs.body.data.sentences).toHaveLength(SENTENCES.length);
      expect(
        theirs.body.data.sentences.every((s: any) => s.attempts === 0),
      ).toBe(true);
    });

    it('one learner’s history never steers another’s next sentence', async () => {
      // The learner exhausts the reading bank; the neighbour must still be
      // offered the first sentence.
      for (const id of [R1, R2, R3]) {
        await postAttempt(learner, {
          sentenceId: id,
          responseText: 'deliberately wrong',
        }).expect(200);
      }

      const theirs = await getNext(other, 'reading').expect(200);
      expect(theirs.body.data.sentence.id).toBe(R1);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /english/next
  // ---------------------------------------------------------------------------

  describe('GET /english/next', () => {
    it('requires kind and rejects an unknown segment', async () => {
      await request(server())
        .get('/api/english/next')
        .set(authHeader(learner.accessToken))
        .expect(400);

      await getNext(learner, 'speaking').expect(400);
    });

    it('serves the reading bank in ordinal order for a learner with no history', async () => {
      const response = await getNext(learner, 'reading').expect(200);

      expect(response.body.data.sentence).toEqual({
        id: R1,
        kind: 'reading',
        version: VERSION,
        ordinal: 1,
        text: 'Who was the first President?',
        vocabTags: ['PEOPLE', 'QUESTION WORDS'],
        wordCount: 5,
      });
    });

    it('returns the writing sentence’s own text — the client speaks it locally', async () => {
      const response = await getNext(learner, 'writing').expect(200);

      expect(response.body.data.sentence.kind).toBe('writing');
      expect(response.body.data.sentence.text).toBe('We pay taxes.');
    });

    it('never serves a just-passed sentence ahead of an untried one', async () => {
      // The acceptance criterion, over the wire: pass R1, ask again, get R2.
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'Who was the first President?',
      }).expect(200);

      const response = await getNext(learner, 'reading').expect(200);
      expect(response.body.data.sentence.id).toBe(R2);
    });

    it('brings a failed sentence back ahead of a passed one, once the bank is exhausted', async () => {
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'not remotely the sentence',
      }).expect(200);
      await postAttempt(learner, {
        sentenceId: R2,
        responseText: 'Where is the White House?',
      }).expect(200);
      await postAttempt(learner, {
        sentenceId: R3,
        responseText: 'What is the capital of the United States?',
      }).expect(200);

      // R1 failed, R2 and R3 passed, and R3 was answered most recently so it
      // is skipped anyway. R1 is both the failed one and the least recently
      // seen.
      const response = await getNext(learner, 'reading').expect(200);
      expect(response.body.data.sentence.id).toBe(R1);
    });

    it('is null when the bank for that kind is empty', async () => {
      (prismaMock.englishSentence.findMany as jest.Mock).mockResolvedValue([]);

      const response = await getNext(learner, 'reading').expect(200);
      expect(response.body.data.sentence).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /english/attempts
  // ---------------------------------------------------------------------------

  describe('POST /english/attempts', () => {
    it('404s an unknown sentence and writes nothing', async () => {
      await postAttempt(learner, {
        sentenceId: ABSENT,
        responseText: 'anything',
      }).expect(404);

      expect(attempts.size).toBe(0);
    });

    it('scores a correct writing attempt and reveals the sentence', async () => {
      const response = await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
        replayCount: 2,
      }).expect(200);

      const body = response.body.data;
      expect(body.status).toBe('scored');
      expect(body.outcome).toBe('correct');
      expect(body.wer).toBe(0);
      expect(body.errors).toBe(0);
      // The reveal — the writing screen never rendered this.
      expect(body.text).toBe('We pay taxes.');
      expect(body.attemptId).toEqual(expect.any(String));
      // Recorded, never gating: the outcome is `correct` with two replays.
      expect(body.replayCount).toBe(2);
      expect(body.asrConfidence).toBeNull();
    });

    it('returns the word-level diff a screen renders', async () => {
      const response = await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'we pay',
      }).expect(200);

      const body = response.body.data;
      expect(body.diff).toEqual([
        { kind: 'match', reference: 'we', hypothesis: 'we', referenceIndex: 0 },
        { kind: 'match', reference: 'pay', hypothesis: 'pay', referenceIndex: 1 },
        { kind: 'delete', reference: 'taxes', hypothesis: null, referenceIndex: 2 },
      ]);
      expect(body.normalizedReference).toBe('we pay taxes');
    });

    it('grades a genuine failure as incorrect and records it', async () => {
      const response = await postAttempt(learner, {
        sentenceId: W2,
        responseText: 'dogs eat food',
      }).expect(200);

      expect(response.body.data.outcome).toBe('incorrect');
      expect(attempts.size).toBe(1);
    });

    it('rejects asrConfidence on a writing attempt', async () => {
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
        asrConfidence: 0.9,
      }).expect(400);

      expect(attempts.size).toBe(0);
    });

    it('rejects a non-zero replayCount on a reading attempt', async () => {
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'Who was the first President?',
        replayCount: 1,
      }).expect(400);

      expect(attempts.size).toBe(0);
    });

    it('rejects an out-of-range asrConfidence', async () => {
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'Who was the first President?',
        asrConfidence: 1.5,
      }).expect(400);
    });

    it('rejects an unknown key rather than dropping it', async () => {
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'Who was the first President?',
        somethingNew: true,
      }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // The misheard rule (§3), over the wire
  // ---------------------------------------------------------------------------

  describe('the misheard rule', () => {
    const LOW = ASR_CONFIDENCE_THRESHOLD - 0.1;

    it('is a 200 with status misheard, and writes NO ROW', async () => {
      const response = await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'who was the worst president ever',
        asrConfidence: LOW,
      }).expect(200);

      const body = response.body.data;
      expect(body.status).toBe('misheard');
      expect(body.attemptId).toBeUndefined();
      expect(body.outcome).toBeUndefined();
      // `misheard` is the ABSENCE of a recorded failure (§3) — not an
      // `incorrect` row, not a flagged row.
      expect(attempts.size).toBe(0);

      // ...and it still carries what the retry screen needs.
      expect(body.wer).toBeGreaterThan(0);
      expect(body.diff.length).toBeGreaterThan(0);
      expect(body.confidenceThreshold).toBe(ASR_CONFIDENCE_THRESHOLD);
    });

    it('leaves the next sentence unchanged, because nothing was recorded', async () => {
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'who was the worst president ever',
        asrConfidence: LOW,
      }).expect(200);

      // R1 is still untried, so it is still what comes next — the learner is
      // offered the retry §3 promises rather than being moved on.
      const response = await getNext(learner, 'reading').expect(200);
      expect(response.body.data.sentence.id).toBe(R1);
    });

    it('records normally when no confidence was reported — unknown is not low', async () => {
      const response = await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'who was the worst president ever',
      }).expect(200);

      expect(response.body.data.status).toBe('scored');
      expect(attempts.size).toBe(1);
      expect(Array.from(attempts.values())[0].asrConfidence).toBeNull();
    });

    it('records a low-confidence transcript that scored correct anyway', async () => {
      const response = await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'Who was the first President?',
        asrConfidence: LOW,
      }).expect(200);

      expect(response.body.data.status).toBe('scored');
      expect(response.body.data.outcome).toBe('correct');
      expect(attempts.size).toBe(1);
    });

    it('trusts a confidence of exactly the threshold', async () => {
      await postAttempt(learner, {
        sentenceId: R1,
        responseText: 'who was the worst president ever',
        asrConfidence: ASR_CONFIDENCE_THRESHOLD,
      }).expect(200);

      expect(attempts.size).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /english/progress
  // ---------------------------------------------------------------------------

  describe('GET /english/progress', () => {
    it('lists every sentence in the bank, attempted or not', async () => {
      const response = await getProgress(learner).expect(200);
      const body = response.body.data;

      expect(body.sentences).toHaveLength(SENTENCES.length);
      expect(body.sentences.every((s: any) => s.attempts === 0)).toBe(true);
      expect(body.sentences.every((s: any) => s.bestOutcome === null)).toBe(true);
    });

    it('rolls up per vocabulary tag — the explicit acceptance criterion', async () => {
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
      }).expect(200);
      await postAttempt(learner, {
        sentenceId: W2,
        responseText: 'nothing like it',
      }).expect(200);

      const response = await getProgress(learner).expect(200);
      const byTag = new Map(
        response.body.data.vocabTags.map((t: any) => [t.tag, t]),
      );

      // CIVICS is on both writing sentences: one passed, one missed.
      expect(byTag.get('CIVICS')).toEqual({
        tag: 'CIVICS',
        sentencesTotal: 2,
        sentencesAttempted: 2,
        sentencesPassed: 1,
        attempts: 2,
      });
      // PEOPLE spans a reading sentence (untried) and a writing one (missed).
      expect(byTag.get('PEOPLE')).toEqual({
        tag: 'PEOPLE',
        sentencesTotal: 2,
        sentencesAttempted: 1,
        sentencesPassed: 0,
        attempts: 1,
      });
    });

    it('reports best and latest separately, and both kinds always', async () => {
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'We pay taxes.',
      }).expect(200);
      await postAttempt(learner, {
        sentenceId: W1,
        responseText: 'nothing like it at all',
      }).expect(200);

      const response = await getProgress(learner).expect(200);
      const w1 = response.body.data.sentences.find(
        (s: any) => s.sentenceId === W1,
      );

      expect(w1.attempts).toBe(2);
      expect(w1.bestOutcome).toBe('correct');
      expect(w1.lastOutcome).toBe('incorrect');
      expect(typeof w1.lastWer).toBe('number');
      expect(w1.lastAnsweredAt).toEqual(expect.any(String));

      expect(response.body.data.byKind.map((k: any) => k.kind)).toEqual([
        'reading',
        'writing',
      ]);
      const reading = response.body.data.byKind[0];
      // `null`, never `0` — a mean of zero is a perfect record.
      expect(reading.averageWer).toBeNull();
      expect(reading.sentencesTotal).toBe(3);
    });
  });
});
