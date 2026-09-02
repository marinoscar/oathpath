import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  currentAnswerWhere,
  resolveAnswerScope,
  selectAnswers,
  type AnswerResolutionStatus,
  type DynamicScope,
} from '../civics/answer-resolution';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { matchAnswer, type AnswerMatch } from './answer-matching';
import { selectQuestions } from './question-selection';
import type { CreatePracticeSessionInput } from './dto/create-practice-session.dto';
import type { RecordAttemptInput } from './dto/record-attempt.dto';
import type { PracticeSessionQuery } from './dto/practice-session-query.dto';
import type { PracticeQuestion } from './dto/practice-question.dto';
import type {
  PracticeAnswerSnapshot,
  PracticeAttemptResponse,
  PracticeSnapshotAnswer,
} from './dto/practice-attempt.dto';
import type {
  PracticeAttemptResult,
  PracticeSessionDetail,
  PracticeSessionListItem,
  PracticeSessionResponse,
  PracticeSessionState,
  PracticeSessionSummary,
} from './dto/practice-session.dto';

// =============================================================================
// PracticeService (issue #73, epic #52 / E3)
// =============================================================================
//
// The practice loop: open a session, be asked a question, answer it, be graded
// deterministically, and see a summary. Every attempt writes one row into
// `practice_attempts` — the table epic #52 calls "the single evidence table for
// the whole product", which E5 (mastery), E6 (readiness) and E7 (streaks) all
// read and E8 writes into with `source: 'mock_interview'`.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// And every query in this file is filtered by it — not "checked against it
// afterwards", filtered by it, in the `where`. There is no method here that
// reads another learner's session, and none that could be handed one, because
// the controller has no parameter that carries a user id.
//
// **A session belonging to somebody else is a 404, not a 403.** That is a
// deliberate choice, not an accident of using `findFirst`: a 403 confirms the
// id names a real session, which is itself the leak — an attacker enumerating
// uuids learns which ones exist, and a learner who was shown a 403 learns that
// another learner's practice history is there to be asked about. From the
// caller's position the resource genuinely does not exist, and that is what the
// status code should say. `requireSession` is the ONE place a session is loaded
// for any route, so this holds by construction rather than by six correct
// copies of the same check.
//
// -----------------------------------------------------------------------------
// THIS FILE CONSTRUCTS NO `Date` OF ITS OWN
// -----------------------------------------------------------------------------
//
// Every instant — `startedAt`, `completedAt`, `answeredAt`, and the
// `resolvedAt` frozen into every answer snapshot — comes from
// `this.clock.now()`. Grep this module's non-test sources for a bare `Date`
// construction and the result is empty, comments included, exactly as
// `src/journey/` and `src/civics/` already hold.
//
// That is not house style for its own sake here. E5's "correct on 3 or more
// distinct days" rule and E7's streak computation both read `answeredAt` to
// decide which of the learner's local calendar days an attempt falls on, and
// both need a spec that can advance the clock a day through `X-Test-Clock`
// rather than sleeping through one (practice-sessions.md §11).
//
// -----------------------------------------------------------------------------
// NO AUDIT ROWS
// -----------------------------------------------------------------------------
//
// Unlike an admin settings write or a role change, answering a civics question
// is routine product usage — not a privileged or security-relevant act. Same
// reasoning that keeps `ai_usage_events` out of `audit_events` entirely
// (docs/specs/ai-settings.md §9, practice-sessions.md §10): the evidence is
// recorded because a later reader needs the data, not because anyone needs to
// explain who was allowed to produce it. `practice_attempts` IS the record.
// =============================================================================

/** The question columns practice ever reads. Answers are conspicuously absent. */
const QUESTION_SELECT = {
  id: true,
  number: true,
  prompt: true,
  categoryId: true,
  testVersionCode: true,
  dynamicScope: true,
} as const;

/** One question as read for selection and display. */
type QuestionRow = {
  id: string;
  number: number;
  prompt: string;
  categoryId: string;
  testVersionCode: string;
  // The narrowed union, not `string`: `question-selection.ts` reads this field
  // to decide whether a question is answerable at all, and a widened type here
  // would let a typo reach that decision as a silently-always-answerable value.
  dynamicScope: DynamicScope;
};

/** The three learner-profile facts selection and grading depend on. */
interface PracticeProfile {
  stateCode: string | null;
  testVersionCode: string | null;
  seniorExemption: boolean;
}

@Injectable()
export class PracticeService {
  private readonly logger = new Logger(PracticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Open a session and hand back its first question.
   *
   * Three things happen here, in this order and for stated reasons:
   *
   *  1. **Any open session is closed.** practice-sessions.md §5 makes at most
   *     one `in_progress` session per learner an invariant, and a NEW session
   *     start is the one moment "the old one was not going to be finished"
   *     becomes knowable — which is why there is no cron sweeping stale rows
   *     (ROADMAP §7's "No job queue"). The old row becomes `abandoned` with a
   *     `completedAt`, keeping every attempt it already produced: an abandoned
   *     session's answers are real evidence regardless of why the learner left.
   *
   *     **This is an application-level invariant, not a database one.** §2.1
   *     records the gap plainly: the shipped migration has no partial unique
   *     index on `status = 'in_progress'`, so two concurrent starts by the same
   *     learner (two tabs, a double-tap) could each pass through here and both
   *     create a row. The consequence is small and self-healing — the loser
   *     stays `in_progress` and the next session start closes it — and §13
   *     accepts it rather than adding an index for it. The transaction below
   *     makes the close-and-open atomic, which is a different guarantee: it
   *     stops a session being abandoned by a start that then failed.
   *
   *  2. **The question pool is resolved from the learner's own profile**, never
   *     from the request: their test version, their state, their senior
   *     exemption. See {@link candidateQuestions}.
   *
   *  3. **`plannedCount` is clamped to what actually exists.** A category with
   *     three unseen questions cannot plan five. `plannedCount` is what the
   *     summary renders "4 of 5" from, so a count the bank could never supply
   *     would render an unfinishable session as one the learner failed to
   *     finish.
   */
  async createSession(
    userId: string,
    input: CreatePracticeSessionInput,
  ): Promise<PracticeSessionState> {
    const profile = await this.requireOrientedProfile(userId);
    const testVersionCode = profile.testVersionCode as string;

    // A category id is validated against the learner's OWN bank. A real
    // category belonging to the other test version is a 404 and not a 403 for
    // the same reason another learner's session is: from where this caller
    // stands, it is not a thing that exists to be practised.
    if (input.kind === 'category' && input.categoryId) {
      const category = await this.prisma.civicsCategory.findFirst({
        where: { id: input.categoryId, testVersionCode },
        select: { id: true },
      });

      if (!category) {
        throw new NotFoundException(
          `Civics category "${input.categoryId}" not found in test version "${testVersionCode}"`,
        );
      }
    }

    const categoryId = input.kind === 'category' ? (input.categoryId ?? null) : null;

    const ordered = await this.candidateQuestions(
      { testVersionCode, categoryId },
      profile,
      userId,
    );

    if (ordered.length === 0) {
      // Well-formed request, forbidden by the state of the content: 409.
      // Distinguishable from the 400 an invalid body gets, so a client can tell
      // "you asked wrongly" from "there is nothing here to ask you".
      throw new ConflictException(
        'There are no questions available to practise for this selection',
      );
    }

    const plannedCount = Math.min(input.plannedCount, ordered.length);
    const startedAt = this.clock.now();

    const session = await this.prisma.$transaction(async (tx) => {
      await tx.practiceSession.updateMany({
        where: { userId, status: 'in_progress' },
        data: { status: 'abandoned', completedAt: startedAt },
      });

      return tx.practiceSession.create({
        data: {
          userId,
          kind: input.kind,
          status: 'in_progress',
          testVersionCode,
          categoryId,
          plannedCount,
          // Set explicitly from the injected clock rather than left to the
          // column's `DEFAULT now()`. §2.1: the default is a safety net for a
          // row inserted by something other than this service, not the path
          // this service takes — and a row whose `startedAt` ignored
          // `X-Test-Clock` would make a multi-day spec untestable.
          startedAt,
        },
      });
    });

    this.logger.log(
      { userId, sessionId: session.id, kind: session.kind, plannedCount },
      'Practice session started',
    );

    return {
      session: toSessionResponse(session),
      nextQuestion: toQuestion(ordered[0]),
      progress: { answered: 0, planned: session.plannedCount },
    };
  }

  /**
   * The caller's own sessions, newest first.
   *
   * Ordered by `startedAt` desc, which is exactly what the shipped
   * `@@index([userId, startedAt])` serves (§2.1) — the reason that index is the
   * whole index list for this table.
   *
   * The per-session counts come from the attempt rows loaded alongside the
   * page, not from a second query per row and not from the stored `summary`.
   * A `summary` exists only on a `completed` session, and an `in_progress` or
   * `abandoned` one still has real attempts behind it: a learner who answered
   * three of five and walked away should see three, not a blank row. One
   * `include` over a bounded page (at most 100 sessions) is cheaper than the
   * N+1 the alternative implies, and cannot drift from the rows the way a
   * denormalised counter could.
   */
  async listSessions(
    userId: string,
    query: PracticeSessionQuery,
  ): Promise<{
    items: PracticeSessionListItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize } = query;

    const [rows, total] = await Promise.all([
      this.prisma.practiceSession.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { attempts: { select: { outcome: true } } },
      }),
      this.prisma.practiceSession.count({ where: { userId } }),
    ]);

    return {
      items: rows.map((row: any) => ({
        ...toSessionResponse(row),
        answeredCount: row.attempts.length,
        correctCount: row.attempts.filter(
          (attempt: { outcome: string }) => attempt.outcome === 'correct',
        ).length,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * One session: resume it, or review it.
   *
   * The same payload serves both, because they are the same facts — what was
   * planned, what has been answered, and what is left — and a second endpoint
   * for "review" would be the identical query with the last field forced to
   * null.
   *
   * `nextQuestion` is populated only while the session is `in_progress` and
   * only while fewer attempts exist than were planned. A completed or abandoned
   * session returns null: it is history, and handing back a question would
   * invite a client to POST an attempt the session no longer accepts.
   *
   * The recorded attempts carry their frozen `answerSnapshot`, which is where
   * the accepted answers legitimately appear — they were earned when the
   * attempt was graded. The next question does not, and cannot: it is the
   * prompt-only shape (`dto/practice-question.dto.ts`).
   */
  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<PracticeSessionDetail> {
    const session = await this.requireSession(userId, sessionId);

    const attempts = await this.prisma.practiceAttempt.findMany({
      where: { sessionId: session.id, userId },
      // Oldest first: the order the learner answered them in, which is the
      // order a review screen replays. `id` breaks the tie for two attempts
      // sharing an instant, which a pinned `X-Test-Clock` makes routine in
      // tests and possible in production.
      orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }],
      include: { question: { select: QUESTION_SELECT } },
    });

    const answeredQuestionIds = new Set<string>(
      attempts.map((attempt: { questionId: string }) => attempt.questionId),
    );

    const nextQuestion = await this.nextQuestionFor(
      session,
      userId,
      attempts.length,
      answeredQuestionIds,
    );

    return {
      session: toSessionResponse(session),
      attempts: attempts.map((attempt: any) => toAttemptResponse(attempt)),
      nextQuestion,
      progress: { answered: attempts.length, planned: session.plannedCount },
    };
  }

  /**
   * Compute and persist the session's summary, and close it.
   *
   * **The counts come from the persisted attempts and from nothing else.** Not
   * from a tally the client kept, not from a running counter on the session
   * row. The client that just answered five questions knows what it thinks
   * happened; the rows know what was recorded. Those can differ — a failed
   * request, a second tab, an attempt graded differently than a client
   * predicted — and when they do, the evidence table is right by definition,
   * because it is the same table E5 and E6 will read. A summary computed from
   * anything else would be a second, quietly divergent account of the session.
   *
   * **Idempotent.** Completing an already-`completed` session returns the
   * stored summary unchanged and does NOT re-stamp `completedAt` — the moment a
   * learner finished has to stay the moment they finished, and a double-tap on
   * "finish" must not move it. This is the same guard shape
   * `JourneyService.updateProfile` uses for `orientationCompletedAt`.
   *
   * An `abandoned` session is a 409: the request is well-formed, but that
   * session was closed by a later session start and there is no completion to
   * record. practice-sessions.md §10 specifies exactly that status for a
   * session that is not `in_progress`; `completed` is carved out of it above
   * because idempotency is worth more than a strict reading of the state
   * machine to every client that retries.
   */
  async completeSession(
    userId: string,
    sessionId: string,
  ): Promise<PracticeSessionResponse> {
    const session = await this.requireSession(userId, sessionId);

    if (session.status === 'completed') {
      return toSessionResponse(session);
    }

    if (session.status !== 'in_progress') {
      throw new ConflictException(
        `Session "${sessionId}" is ${session.status} and cannot be completed`,
      );
    }

    const attempts = await this.prisma.practiceAttempt.findMany({
      where: { sessionId: session.id, userId },
      select: {
        outcome: true,
        gradingMethod: true,
        revealed: true,
        hintUsed: true,
        durationMs: true,
      },
    });

    const summary = computeSummary(attempts, session.plannedCount);

    const completed = await this.prisma.practiceSession.update({
      where: { id: session.id },
      data: {
        status: 'completed',
        completedAt: this.clock.now(),
        summary: summary as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      {
        userId,
        sessionId: session.id,
        answered: summary.answered,
        correct: summary.correct,
      },
      'Practice session completed',
    );

    return toSessionResponse(completed);
  }

  // ---------------------------------------------------------------------------
  // Attempts
  // ---------------------------------------------------------------------------

  /**
   * Grade one response and record it.
   *
   * The grading path is exactly practice-sessions.md §7: resolve the question's
   * currently accepted answers through `civics/answer-resolution.ts` — the same
   * pure functions the civics read API uses, never a second derivation of
   * "which answers are current" — and hand them to `matchAnswer`, which is the
   * ENTIRE grading decision this epic makes. No edit distance, no similarity
   * score, no substring containment; a near miss is `incorrect` here and it is
   * E4's grader that is entitled to overturn that with reasoning (§8).
   *
   * Four columns are written with one value each, and each is a fact that
   * cannot be reconstructed later if it is not captured now (§2.2):
   * `source: 'practice'` (E8 writes `mock_interview` into this same table),
   * `inputMode: 'typed'` and `promptMode: 'read'` (E9 wires spoken and heard —
   * nothing can tell after the fact whether an old typed answer was typed or
   * transcribed), and `gradingMethod: 'exact'`.
   *
   * **`gradingMethod: 'exact'` on a skip deserves its own sentence**, because
   * §9.1's prose says a skip has `gradingMethod: null` and the shipped column
   * is `NOT NULL` — the schema resolves it, and this is where. `exact` records
   * that the deterministic path is what resolved this attempt; `outcome:
   * 'skipped'` is the field that says no response was graded. The two read
   * together give the same fact §9.1 wanted from a null, and unlike a null they
   * cannot be mistaken for "we do not know how this was graded" by a reader
   * that only looks at one column.
   */
  async recordAttempt(
    userId: string,
    sessionId: string,
    input: RecordAttemptInput,
  ): Promise<PracticeAttemptResult> {
    const session = await this.requireSession(userId, sessionId);

    if (session.status !== 'in_progress') {
      throw new ConflictException(
        `Session "${sessionId}" is ${session.status} and accepts no further attempts`,
      );
    }

    const question = await this.prisma.civicsQuestion.findUnique({
      where: { id: input.questionId },
      select: QUESTION_SELECT,
    });

    if (!question) {
      throw new NotFoundException(
        `Civics question "${input.questionId}" not found`,
      );
    }

    // The session's own scope, enforced. An attempt at a question this session
    // was never drawing from would be evidence filed under a session that
    // cannot explain it — a category session whose summary counts a question
    // from another section, or a session whose `testVersionCode` disagrees with
    // the bank its attempts came from.
    if (question.testVersionCode !== session.testVersionCode) {
      throw new BadRequestException(
        `Question "${question.id}" does not belong to this session's test version`,
      );
    }

    if (session.categoryId && question.categoryId !== session.categoryId) {
      throw new BadRequestException(
        `Question "${question.id}" does not belong to this session's category`,
      );
    }

    // One attempt per question per session. A second one would double-count the
    // question in `progress` and in the summary, and would let a learner grind
    // the same question five times and call it a Quick 5. Answering it again is
    // a new session, which is exactly how the product intends repetition to
    // work.
    const existing = await this.prisma.practiceAttempt.findFirst({
      where: { sessionId: session.id, userId, questionId: question.id },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        `Question "${question.id}" has already been answered in this session`,
      );
    }

    const profile = await this.loadProfile(userId);
    const answeredAt = this.clock.now();

    const { status, stateCode, answers } = await this.resolveAcceptedAnswers(
      question,
      profile.stateCode,
      answeredAt,
    );

    const snapshot: PracticeAnswerSnapshot = {
      resolvedAt: answeredAt.toISOString(),
      answerResolution: status,
      resolvedForStateCode: stateCode,
      answers,
    };

    const { outcome, responseText } = this.grade(input, status, answers);

    const attempt = await this.prisma.practiceAttempt.create({
      data: {
        userId,
        questionId: question.id,
        sessionId: session.id,
        source: 'practice',
        inputMode: 'typed',
        promptMode: 'read',
        responseText,
        outcome,
        gradingMethod: 'exact',
        revealed: input.revealed,
        hintUsed: input.hintUsed,
        // Absent stays absent. `0` would be a claim that the learner answered
        // instantly — see the DTO, and `ai_usage_events`' nullable token counts
        // for the same argument applied to a different unknown.
        durationMs: input.durationMs ?? null,
        answeredAt,
        answerSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
      include: { question: { select: QUESTION_SELECT } },
    });

    const answeredQuestionIds = new Set<string>(
      (
        await this.prisma.practiceAttempt.findMany({
          where: { sessionId: session.id, userId },
          select: { questionId: true },
        })
      ).map((row: { questionId: string }) => row.questionId),
    );

    const answered = answeredQuestionIds.size;

    return {
      attempt: toAttemptResponse(attempt),
      // Earned: the attempt is recorded, so showing what was accepted is
      // feedback rather than a hint. The same list that was just frozen into
      // the snapshot, so the screen and the permanent record cannot disagree.
      acceptedAnswers: answers,
      nextQuestion: await this.nextQuestionFor(
        session,
        userId,
        answered,
        answeredQuestionIds,
      ),
      progress: { answered, planned: session.plannedCount },
    };
  }

  /**
   * "I was right, the matcher just didn't recognise it."
   *
   * A DISTINCT ROUTE AND A DISTINCT `gradingMethod`, which is the entire point
   * (practice-sessions.md §9, locked decision #3). `matchAnswer` will never
   * accept a real paraphrase or a synonym the seven normalisation steps do not
   * anticipate — that is what "no edit distance, no similarity score" costs a
   * learner who genuinely knew the answer. Without an escape hatch the product
   * tells a correct learner they are wrong, on an application whose whole
   * premise is building accurate confidence.
   *
   * But a self-mark must never be *indistinguishable* from a verified match.
   * `outcome: 'correct'` with `gradingMethod: 'self'` records both facts
   * separately: it counts as right, and E5 knows exactly how it came to be
   * right so it can weigh it less. A `self_correct` outcome value was rejected
   * for the mirror-image reason — it would force every reader that only asks
   * "was this right" to enumerate two values for one concept (§9, §13).
   *
   * **Revealing first is required**, and it is not a formality. Self-mark is
   * the learner asserting their answer matched the accepted one, and that
   * assertion is only checkable against the actual accepted answer — not
   * against their own memory of what they think it probably was. Without the
   * gate, self-mark degrades into "mark me correct because I want to be", which
   * §13 rejects by name. `revealed` is recorded on the attempt itself, so the
   * client that showed the answer is the client that reported it.
   *
   * **Idempotent**: a second call on an already-self-marked attempt returns the
   * same state rather than erroring, because a retried request must not become
   * a failure the learner has to interpret.
   *
   * An attempt already `correct` by `exact` (or, once E4 ships, by `ai`) is a
   * 400: there is nothing to grant, and silently overwriting `exact` with
   * `self` would DOWNGRADE the evidence — turning a verified match into a
   * learner's own claim, which is the one direction this endpoint must never
   * move the record.
   */
  async selfMarkAttempt(
    userId: string,
    sessionId: string,
    attemptId: string,
  ): Promise<PracticeAttemptResponse> {
    // The session is resolved first, and by owner, so an attempt id cannot be
    // probed through a session the caller does not own.
    const session = await this.requireSession(userId, sessionId);

    const attempt = await this.prisma.practiceAttempt.findFirst({
      where: { id: attemptId, sessionId: session.id, userId },
      include: { question: { select: QUESTION_SELECT } },
    });

    if (!attempt) {
      throw new NotFoundException(`Practice attempt "${attemptId}" not found`);
    }

    if (attempt.outcome === 'correct') {
      if (attempt.gradingMethod === 'self') {
        // Already exactly what this call asks for. Return it unchanged.
        return toAttemptResponse(attempt);
      }

      throw new BadRequestException(
        'This attempt was already graded correct — there is nothing to self-mark',
      );
    }

    if (!attempt.revealed) {
      // Well-formed request, forbidden by the attempt's state: 409, matching
      // §10's own choice of status for this refusal.
      throw new ConflictException(
        'Reveal the accepted answer before self-marking — the claim is only checkable against it',
      );
    }

    const updated = await this.prisma.practiceAttempt.update({
      where: { id: attempt.id },
      data: { outcome: 'correct', gradingMethod: 'self' },
      include: { question: { select: QUESTION_SELECT } },
    });

    this.logger.log(
      { userId, sessionId: session.id, attemptId: attempt.id },
      'Practice attempt self-marked correct',
    );

    return toAttemptResponse(updated);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The caller's session, or a 404.
   *
   * The ONE place any route loads a session, filtered by `userId` in the
   * `where` rather than checked afterwards — see this file's header on why
   * somebody else's session is a 404 and not a 403.
   */
  private async requireSession(userId: string, sessionId: string) {
    const session = await this.prisma.practiceSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException(`Practice session "${sessionId}" not found`);
    }

    return session;
  }

  /**
   * The three profile facts practice reads. A missing row reads as all-unknown.
   *
   * A plain read, never an upsert: `JourneyService.getProfile` is the one place
   * a `learner_profiles` row is created, because orientation is what fills it
   * in. Practice creating one would be a side effect on a path that has no
   * business having one — and the row it created would say nothing more than
   * the nulls below already do.
   */
  private async loadProfile(userId: string): Promise<PracticeProfile> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { stateCode: true, testVersionCode: true, seniorExemption: true },
    });

    return {
      stateCode: profile?.stateCode ?? null,
      testVersionCode: profile?.testVersionCode ?? null,
      seniorExemption: profile?.seniorExemption ?? false,
    };
  }

  /**
   * {@link loadProfile}, refusing a learner with no resolved test version.
   *
   * `practice_sessions.testVersionCode` is `NOT NULL` and there is no honest
   * value to invent: which civics bank a learner sits is resolved from their
   * filing date at orientation (`journey/test-version-resolution.ts`), and
   * defaulting to one here would quietly drill them on the wrong test. A 400
   * naming orientation is actionable; a session against a guessed bank is not
   * discoverable at all.
   *
   * Unreachable through the app's own screens — `RequireOrientation` blocks an
   * unoriented learner from every route but setup — which is why this is a
   * plain 400 rather than a redirect or a special error code.
   */
  private async requireOrientedProfile(userId: string): Promise<PracticeProfile> {
    const profile = await this.loadProfile(userId);

    if (!profile.testVersionCode) {
      throw new BadRequestException(
        'Finish orientation before practising — your civics test version has not been resolved yet',
      );
    }

    return profile;
  }

  /**
   * The learner's selectable questions, ordered unseen-first.
   *
   * Three filters, and the third is the one worth naming:
   *
   *  - the session's test version, so a learner is only ever asked questions
   *    from the bank they will actually sit;
   *  - the session's category, when it has one;
   *  - `seniorEligible: true` when the learner claims the 65/20 accommodation.
   *    That filters the question SET and never an answer — civics-content.md §5
   *    is emphatic about the distinction, and it is the reason the flag lives
   *    on `civics_questions` rather than being applied to answer resolution.
   *
   * Unanswerable questions are then dropped and the rest partitioned
   * unseen-first by `question-selection.ts`; both rules live there, pure and
   * directly testable, rather than inline in a query.
   *
   * **"Seen" is read from `practice_attempts` with a `groupBy`**, which is the
   * query the shipped `[userId, questionId, answeredAt]` index exists to serve
   * (§2.2). A `findMany` of every attempt row would return one row per
   * repetition — a learner who has practised for a month would drag hundreds of
   * rows across the wire to compute a set of at most 128 ids.
   *
   * The pool is re-read on every call rather than persisted with the session.
   * There is no column for a question list (§2.1's table has none), and adding
   * one would be a second place the session's contents are recorded — able to
   * disagree with the attempts that actually happened. Re-selecting, minus what
   * this session has already answered, is stateless, cannot drift, and costs
   * one bounded query over a bank of at most a few hundred rows.
   */
  private async candidateQuestions(
    scope: { testVersionCode: string; categoryId: string | null },
    profile: PracticeProfile,
    userId: string,
    excludeQuestionIds?: ReadonlySet<string>,
  ): Promise<QuestionRow[]> {
    const [questions, seen] = await Promise.all([
      this.prisma.civicsQuestion.findMany({
        where: {
          testVersionCode: scope.testVersionCode,
          ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
          ...(profile.seniorExemption ? { seniorEligible: true } : {}),
        },
        select: QUESTION_SELECT,
        orderBy: [{ number: 'asc' }],
      }),
      this.prisma.practiceAttempt.groupBy({
        by: ['questionId'],
        where: { userId },
      }),
    ]);

    return selectQuestions(questions as unknown as QuestionRow[], {
      learnerStateCode: profile.stateCode,
      seenQuestionIds: new Set<string>(
        (seen as { questionId: string }[]).map((row) => row.questionId),
      ),
      excludeQuestionIds,
    });
  }

  /**
   * The next question to ask in this session, or null.
   *
   * Null in three cases, each meaning something different to a client that only
   * has to check for null: the session is no longer `in_progress`, the planned
   * count has been reached (the session has asked what it set out to ask), or
   * the bank has nothing left that this learner can be asked.
   *
   * Prompt only. See `dto/practice-question.dto.ts`.
   */
  private async nextQuestionFor(
    session: {
      id: string;
      status: string;
      testVersionCode: string;
      categoryId: string | null;
      plannedCount: number;
    },
    userId: string,
    answered: number,
    answeredQuestionIds: ReadonlySet<string>,
  ): Promise<PracticeQuestion | null> {
    if (session.status !== 'in_progress' || answered >= session.plannedCount) {
      return null;
    }

    const profile = await this.loadProfile(userId);

    const ordered = await this.candidateQuestions(
      {
        testVersionCode: session.testVersionCode,
        categoryId: session.categoryId,
      },
      profile,
      userId,
      answeredQuestionIds,
    );

    return ordered.length > 0 ? toQuestion(ordered[0]) : null;
  }

  /**
   * The question's currently accepted answers, for this learner, at this
   * instant.
   *
   * Delegates every rule to `civics/answer-resolution.ts` —
   * `currentAnswerWhere` for "which rows are current as of now",
   * `resolveAnswerScope` for "which state, or none, or `state_required`", and
   * `selectAnswers` for "all simultaneously correct alternatives, or the single
   * current one". Practice does not re-derive any of that: a second place the
   * same fact is computed is a second place it can drift from the first, which
   * is the same argument civics-content.md §3 makes against a redundant
   * `is_current` flag.
   *
   * `state_required` runs NO query at all, exactly as `CivicsService` does:
   * there is no state to query for, and querying anyway would mean writing a
   * fallback — which is the guess civics-content.md §5 rejects outright.
   */
  private async resolveAcceptedAnswers(
    question: { id: string; dynamicScope: string },
    learnerStateCode: string | null,
    now: Date,
  ): Promise<{
    status: AnswerResolutionStatus;
    stateCode: string | null;
    answers: PracticeSnapshotAnswer[];
  }> {
    const scope = question.dynamicScope as DynamicScope;
    const { status, stateCode } = resolveAnswerScope(scope, learnerStateCode);

    const rows =
      status === 'state_required'
        ? []
        : await this.prisma.civicsAnswer.findMany({
            where: {
              questionId: question.id,
              stateCode,
              ...currentAnswerWhere(now),
            },
            orderBy: [{ sort: 'asc' }, { effectiveFrom: 'desc' }],
          });

    const answers = selectAnswers(scope, rows).map(
      (answer: any): PracticeSnapshotAnswer => ({
        id: answer.id,
        text: answer.text,
        sort: answer.sort,
        stateCode: answer.stateCode,
        verifiedAt: answer.verifiedAt.toISOString(),
      }),
    );

    return { status, stateCode, answers };
  }

  /**
   * The verdict, and the response text to store with it.
   *
   * Three branches, and the middle one is the interesting one:
   *
   *  - **Skipped** — `outcome: 'skipped'`, `responseText: null`. Recorded, not
   *    dropped: a skip is what "I have no idea" looks like, and discarding it
   *    would leave the readiness model unable to tell a question a learner
   *    keeps avoiding from one they have never been shown.
   *
   *  - **`state_required`** — also `skipped`, and deliberately NOT `incorrect`.
   *    There were no accepted answers to compare against, so the learner was
   *    not wrong; the product could not resolve what right was. Recording
   *    `incorrect` would enter a wrong answer into the evidence table against a
   *    learner who may well have typed the correct governor, and E5 would later
   *    discount their mastery for it. The snapshot's own
   *    `answerResolution: 'state_required'` is what lets a debrief say "you
   *    hadn't set your state yet" rather than "there was no correct answer to
   *    this question" (§6). Practice never SELECTS such a question
   *    (`question-selection.ts`), so this only fires for a question id a client
   *    posted rather than was handed — and it is recorded rather than rejected
   *    because the attempt did happen.
   *
   *  - **Otherwise** — `matchAnswer`, and nothing else. It is total over its
   *    input: an empty response, whitespace, and a megabyte of noise all get a
   *    verdict rather than an exception, so a malformed body can never turn
   *    into a 500 on a practice screen.
   *
   * Revealing does not change the outcome, and neither does a hint. Both are
   * recorded independently and weighed later (§9.1): a revealed attempt that is
   * then answered correctly grades correct, exactly as an unrevealed one does —
   * it is simply weaker evidence of recall, which is a judgement for E5 and not
   * a discount to apply here.
   */
  private grade(
    input: RecordAttemptInput,
    status: AnswerResolutionStatus,
    answers: readonly PracticeSnapshotAnswer[],
  ): {
    outcome: 'correct' | 'incorrect' | 'skipped';
    responseText: string | null;
  } {
    if (input.skipped) {
      return { outcome: 'skipped', responseText: null };
    }

    const responseText = input.responseText ?? null;

    if (status === 'state_required') {
      this.logger.debug(
        'Attempt against a state-scope question with no state on the profile; recorded as skipped',
      );
      return { outcome: 'skipped', responseText };
    }

    const match: AnswerMatch = matchAnswer(responseText ?? '', answers);

    return { outcome: match.outcome, responseText };
  }
}

// -----------------------------------------------------------------------------
// Row → wire mappers
// -----------------------------------------------------------------------------
//
// Field by field rather than by spread, for the reason `CivicsService` and
// `JourneyController.listStages` both give: the response shape is decided here,
// in code that is about the response shape. A spread would make it a consequence
// of whichever columns the table happens to grow, so a column added later for an
// internal consumer would silently become public API.
//
// That is not a general tidiness argument in this module — it is the specific
// hazard `dto/practice-question.dto.ts` exists to prevent. `civics_questions`
// has no answer columns today, but `practice_attempts` does carry E4's
// `aiFeedback` and `failureCause`, and a spread over an attempt row would put
// whatever E4 stores there on the wire the day it lands, decided by nobody.

/** `civics_questions` row → the PROMPT-ONLY wire shape. No answers, ever. */
function toQuestion(question: QuestionRow): PracticeQuestion {
  return {
    id: question.id,
    number: question.number,
    prompt: question.prompt,
    categoryId: question.categoryId,
    dynamicScope: question.dynamicScope,
  };
}

/** `practice_sessions` row → wire shape. */
function toSessionResponse(session: any): PracticeSessionResponse {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    testVersionCode: session.testVersionCode,
    categoryId: session.categoryId,
    plannedCount: session.plannedCount,
    startedAt: session.startedAt.toISOString(),
    completedAt: session.completedAt ? session.completedAt.toISOString() : null,
    // Null while `in_progress` — there is nothing to summarise yet, and an
    // empty object standing in for "no summary" would be indistinguishable from
    // a genuinely empty completed session (§2.1).
    summary: (session.summary as PracticeSessionSummary | null) ?? null,
  };
}

/** `practice_attempts` row (with its question) → wire shape. */
function toAttemptResponse(attempt: any): PracticeAttemptResponse {
  return {
    id: attempt.id,
    sessionId: attempt.sessionId,
    questionId: attempt.questionId,
    question: toQuestion(attempt.question),
    source: attempt.source,
    inputMode: attempt.inputMode,
    promptMode: attempt.promptMode,
    responseText: attempt.responseText,
    outcome: attempt.outcome,
    gradingMethod: attempt.gradingMethod,
    revealed: attempt.revealed,
    hintUsed: attempt.hintUsed,
    durationMs: attempt.durationMs,
    answeredAt: attempt.answeredAt.toISOString(),
    // Read back whole, exactly as frozen. Never re-resolved, never merged with
    // whatever `civics_answers` says today — that is the entire point of the
    // column (§6).
    answerSnapshot: attempt.answerSnapshot as PracticeAnswerSnapshot,
  };
}

/**
 * The session summary, computed from the persisted attempt rows.
 *
 * A pure function of the rows it is handed — no clock, no database, no client
 * input — so the one thing that could make a summary wrong is the rows being
 * wrong, and the rows are the evidence table itself.
 *
 * `totalDurationMs` is null when NOTHING reported a duration, and `timedAttempts`
 * says how many attempts the total covers, so a partial total can never be read
 * as a complete one. Reporting `0` for an untimed session would be a claim that
 * it took no time, which is the same false claim `durationMs` is nullable to
 * avoid (§2.2).
 */
export function computeSummary(
  attempts: readonly {
    outcome: string;
    gradingMethod: string;
    revealed: boolean;
    hintUsed: boolean;
    durationMs: number | null;
  }[],
  plannedCount: number,
): PracticeSessionSummary {
  const count = (outcome: string) =>
    attempts.filter((attempt) => attempt.outcome === outcome).length;

  const timed = attempts.filter(
    (attempt) => attempt.durationMs !== null && attempt.durationMs !== undefined,
  );

  return {
    plannedCount,
    answered: attempts.length,
    correct: count('correct'),
    partial: count('partial'),
    incorrect: count('incorrect'),
    skipped: count('skipped'),
    // Of the correct ones, how many were the learner's own claim rather than a
    // verified match. "Was it right" and "how do we know" are independent facts
    // (§9); a summary reporting only `correct` would flatten the difference E5
    // exists to weigh.
    selfMarked: attempts.filter(
      (attempt) =>
        attempt.outcome === 'correct' && attempt.gradingMethod === 'self',
    ).length,
    revealed: attempts.filter((attempt) => attempt.revealed).length,
    hintUsed: attempts.filter((attempt) => attempt.hintUsed).length,
    totalDurationMs:
      timed.length === 0
        ? null
        : timed.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0),
    timedAttempts: timed.length,
  };
}
