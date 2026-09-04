import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  AiDispatchService,
  type AiUnavailableCause,
} from '../ai/ai-dispatch.service';
import type { AiModelRole } from '../ai/ai-model-roles';
import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { EngagementService } from '../engagement/engagement.service';
import { ReadinessService } from '../readiness/readiness.service';
import { AttemptGradingService } from '../practice/attempt-grading.service';
import { toAttemptOutcome } from '../practice/mastery/outcome-mapping';
import { excludeUnanswerable } from '../practice/question-selection';
import type { DynamicScope } from '../civics/answer-resolution';
import type {
  GradingVerdict,
  PersistableFailureCause,
} from '../practice/grading';
import type { PracticeAnswerSnapshot } from '../practice/dto/practice-attempt.dto';
import {
  applyAnswer,
  FALLBACK_OFFICER_LINES,
  fallbackOfficerLine,
  nextPrompt,
  selectPassRule,
  startState,
  passedCivics as passedCivicsFor,
  type CivicsStopReason,
  type InterviewPassRule,
  type InterviewPhase,
  type InterviewPrompt,
  type InterviewState as EngineState,
} from './engine';
import {
  assembleOfficerTurn,
  buildOfficerPrompt,
  OFFICER_MAX_TOKENS,
  type OfficerAcknowledgedOutcome,
  type OfficerTurnBody,
} from './officer-prompt';
import { buildInterviewDebrief, type DebriefAttempt } from './debrief';
import type { CreateInterviewInput } from './dto/create-interview.dto';
import type { InterviewTurnInput } from './dto/interview-turn.dto';
import type { InterviewQuery } from './dto/interview-query.dto';
import type { InterviewDebrief } from './dto/interview-debrief.dto';
import type {
  InterviewDetail,
  InterviewListItem,
  InterviewProgress,
  InterviewResponse,
  InterviewState,
  InterviewTurnRecord,
} from './dto/interview.dto';

// =============================================================================
// InterviewsService (issue #133, epic #57 / E8 "Mock interview — text mode")
// =============================================================================
//
// The rehearsal loop: start an interview, answer the officer turn by turn, and
// be told once, at the end, how it went. `docs/specs/mock-interview.md` is the
// design; this file is the half of it that touches a database, a clock and a
// model, and every decision it makes it delegates:
//
//   * WHAT HAPPENS NEXT — `interviews/engine/`, pure, already shipped and
//     tested. Phase order, the seeded ask-list, the stop rule, whether the
//     civics section was passed. Nothing in this file re-derives any of it.
//   * WHETHER AN ANSWER WAS RIGHT — `practice/attempt-grading.service.ts`, the
//     ONE ladder, injected rather than copied (§6). A civics answer given here
//     is graded by exactly the code a practice answer is.
//   * HOW THE OFFICER PHRASES IT — `officer-prompt.ts` and the `tutor` role,
//     through `AiDispatchService`. Wording only, never content (§5).
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// And every query is filtered by it — not "checked against it afterwards",
// filtered by it, in the `where`. {@link InterviewsService.requireInterview} is
// the ONE place an interview is loaded for any route, exactly as
// `PracticeService.requireSession` is for a session, so **another learner's
// interview is a 404, not a 403** by construction rather than by five correct
// copies of the same check. There is no "read any learner's interview" method
// here for a future controller to reach for, and the controller has no
// parameter that could carry a user id.
//
// -----------------------------------------------------------------------------
// NOTHING IN THIS FILE CONSTRUCTS A BARE `Date`
// -----------------------------------------------------------------------------
//
// Every notion of "now" comes from the injected `Clock` — `startedAt`,
// `answeredAt`, `completedAt`, and the instant answer resolution is frozen at.
// `CLAUDE.md`'s "Using the Clock" rule, and the reason it matters here in
// particular: engagement's time slice measures from `mock_interviews.startedAt`
// to an attempt's `answeredAt`, so a bare date construction anywhere on this
// path would be a second, unpinned clock inside a measurement a test has to be
// able to pin. `interviews.service.spec.ts` asserts the absence directly, by
// reading every non-spec file in this directory off disk.
//
// -----------------------------------------------------------------------------
// THE INTERVIEW'S STATE IS REBUILT, NOT STORED
// -----------------------------------------------------------------------------
//
// `mock_interviews` has no `phase` column and no `civics_plan` column, on
// purpose — see {@link InterviewsService.rebuildState} for the full argument.
// The short version is that the engine is a pure function of (seed, pool, pass
// rule, answers), all four of which are already durable: the seed IS the row's
// primary key, the pool is `civics_questions`, the pass rule is the
// `civics_test_versions` row, and the answers are the interview's own turns and
// the `practice_attempts` rows they produced. A stored phase would be a second
// account of where the interview is, able to disagree with the transcript.
// =============================================================================

/**
 * The role this feature spends the learner's key on.
 *
 * `tutor`, typed as `AiModelRole` so a registry rename fails this file's build
 * rather than resolving to `capability_unsupported` at runtime — the same
 * constant-with-a-type `attempt-grading.service.ts` declares for `grader`, and
 * for the reason its comment gives.
 *
 * It is the tutor role and not a new `interviewer` one because §5 restricts the
 * model to a single job — one short, neutral sentence of natural language — and
 * that is the tutor capability family exactly. A dedicated role would be a
 * registry entry, a settings slot and a model binding an administrator has to
 * configure, in exchange for nothing the tutor binding does not already
 * provide. `CLAUDE.md`'s "Adding a New AI Model Role" reserves that cost for a
 * genuinely different job.
 */
const TUTOR_ROLE: AiModelRole = 'tutor';

/** The `civics_questions` columns this module reads. */
const QUESTION_SELECT = {
  id: true,
  number: true,
  prompt: true,
  dynamicScope: true,
} as const;

/**
 * One frame on the way to the client, named by the SSE event it becomes.
 *
 * MODELLED ON `CivicsExplainFrame`, deliberately, including the discriminated
 * union rather than `{ event: string; data: unknown }`: a consumer that appends
 * `data.text` on every frame fails to compile instead of appending `undefined`
 * to the officer's sentence.
 *
 * The three terminal frames all carry {@link InterviewTurnOutcome} — the new
 * officer turns, the phase, the progress. That is the difference from the
 * explain stream, and it is §5.2 on the wire: an `unavailable` interview turn is
 * still a complete, correctly-graded turn, so its terminal frame carries
 * everything `done` carries plus the reason the wording is plainer. A client
 * that rendered nothing on `unavailable` would be dropping a turn that really
 * happened.
 */
export type InterviewTurnFrame =
  /** A chunk of the officer's acknowledgement. Never empty. */
  | { event: 'delta'; data: { text: string } }
  /** Terminal. The officer's turn is whole. */
  | { event: 'done'; data: InterviewTurnOutcome }
  /**
   * Terminal. No call was attempted, and why — an administrator's unfinished
   * configuration, or the caller's own missing key. NOT a failure, and NOT a
   * broken interview: the officer's line is the neutral code-owned fallback and
   * the interview continues unchanged (§5.2, §9.2).
   */
  | {
      event: 'unavailable';
      data: InterviewTurnOutcome & { cause: AiUnavailableCause };
    }
  /**
   * Terminal. The call was attempted and did not produce a usable
   * acknowledgement. The interview still advanced, identically to
   * `unavailable`; the distinction exists only so a caller can tell "nothing
   * was attempted" apart from "something was attempted and did not finish"
   * (§12).
   */
  | {
      event: 'error';
      data: InterviewTurnOutcome & { errorCode: string; error: string };
    };

/** What every terminal frame carries: the turn that happened. */
export interface InterviewTurnOutcome {
  /** The officer turns this exchange produced, in order. Usually one. */
  officerTurns: InterviewTurnRecord[];
  /** The phase the interview is in now. */
  phase: InterviewPhase;
  /** The index of the last turn written. */
  turnIndex: number;
  progress: InterviewProgress;
  /** True once the only remaining action is `complete` (§2.5). */
  awaitingCompletion: boolean;
}

/** The three learner-profile facts an interview is created from. */
interface InterviewProfile {
  stateCode: string | null;
  testVersionCode: string | null;
  seniorExemption: boolean;
}

/** What the grading ladder produced for one civics answer. */
interface GradedCivicsAnswer {
  questionId: string;
  outcome: 'correct' | 'partial' | 'incorrect' | 'skipped';
  gradingMethod: 'exact' | 'ai';
  /** The learner's own words, as the ladder saw them — NOT necessarily as stored. */
  responseText: string | null;
  snapshot: PracticeAnswerSnapshot;
  /** `state_required` skips mastery scheduling, exactly as `recordAttempt` does. */
  answerResolution: string;
  /**
   * Whether rung 2 actually ran and answered.
   *
   * A SEPARATE FLAG RATHER THAN "is `failureCause` non-null", because a
   * `correct` verdict has no failure cause and a usage-write failure leaves
   * `aiUsageEventId` null — so both of the obvious proxies read false on runs
   * where a grader really did look at this answer. The three AI columns are
   * written together or not at all (`AiGradingResult`'s own comment), and this
   * is the fact that decides which.
   */
  graderRan: boolean;
  failureCause: PersistableFailureCause | null;
  aiFeedback: GradingVerdict | null;
  aiUsageEventId: string | null;
  answeredAt: Date;
}

@Injectable()
export class InterviewsService {
  private readonly logger = new Logger(InterviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    // THE ONE LADDER (§6). Not a second copy of "resolve the accepted answers,
    // match, escalate a miss, schedule mastery" — the same injectable
    // `PracticeService` uses, exported by `PracticeModule` for exactly this.
    // A second ladder would drift on the short-circuit that spends no AI credit
    // on a verified match, on the refusal to escalate a `state_required`
    // attempt, and on rung 3's degrade-to-deterministic rule, and a learner
    // would be graded differently depending on which screen they were looking
    // at.
    private readonly grading: AttemptGradingService,
    // THE ONE DOOR TO A MODEL (`ai-evaluation.md` §3). The dispatcher, never a
    // provider token: a caller holding a provider resolves its own model id and
    // its own key, which is both holes that door closed.
    private readonly dispatch: AiDispatchService,
    // Readiness recompute trigger (c) — `readiness-model.md` §7's synchronous,
    // in-request trigger, extended by this epic to a third call site alongside
    // `completeSession` and the nightly cron. Called from
    // {@link completeInterview}, after the completion write commits.
    private readonly readiness: ReadinessService,
    // Accrual — `habit-streaks.md` §2.1. An interview answer is real practice
    // and must count toward the day; called after the attempt's own transaction
    // commits, and never allowed to fail it. See {@link accrueActivity}.
    private readonly engagement: EngagementService,
  ) {}

  // ---------------------------------------------------------------------------
  // Interviews
  // ---------------------------------------------------------------------------

  /**
   * Start an interview and hand back the officer's opening turn.
   *
   * THE TEST VERSION AND THE SENIOR ACCOMMODATION COME FROM THE PROFILE, NEVER
   * FROM THE REQUEST (§12) — `create-interview.dto.ts` carries the
   * compile-time proof that no field could supply either. Both are then FROZEN
   * onto the interview row: `mock_interviews.senior_exemption`'s own schema
   * comment gives the reason, and it is not hypothetical — a learner who edits
   * their profile in another tab mid-interview must not have the pass rule
   * governing the interview they are sitting change underneath them.
   *
   * There is deliberately no "close any open interview first" step, which is
   * where this diverges from `PracticeService.createSession`. A practice
   * session is a disposable batch of five questions and at most one may be open
   * (`practice-sessions.md` §5); an interview is a durable object a learner may
   * genuinely want to resume tomorrow, and silently abandoning it because they
   * tapped "start" on a second device would destroy a rehearsal in progress.
   * `mock_interviews.status` carries `abandoned` for when a learner (or a later
   * epic) decides an interview is over; nothing in this epic writes it.
   */
  async createInterview(
    userId: string,
    input: CreateInterviewInput,
  ): Promise<InterviewState> {
    const profile = await this.requireOrientedProfile(userId);
    // Non-null by `requireOrientedProfile`; narrowed for the type checker.
    const testVersionCode = profile.testVersionCode as string;

    const passRule = await this.loadPassRule(
      testVersionCode,
      profile.seniorExemption,
    );

    const interview = await this.prisma.mockInterview.create({
      data: {
        userId,
        // `text` explicitly rather than by column default. E9/E11 write
        // `voice` through the same rows; a row whose mode was never stated
        // would be indistinguishable from one whose mode was forgotten.
        mode: 'text',
        status: 'in_progress',
        testVersionCode,
        seniorExemption: profile.seniorExemption,
        transcriptRetained: input.transcriptRetained,
        // The clock, not the column default. Engagement's time slice measures
        // from this instant (`sliceSeconds`), so it must be the same clock a
        // test can pin with `X-Test-Clock`.
        startedAt: this.clock.now(),
      },
    });

    // THE ASK-LIST, COMPUTED ONCE FROM THE ROW'S OWN ID. `startState` calls
    // `planCivicsQuestions(pool, seed, passRule)` with `seed = interview.id`,
    // so the sequence is a function of the primary key and the pool — which is
    // what lets a resume re-derive it rather than store it. See
    // {@link rebuildState}.
    const pool = await this.eligibleQuestionIds(testVersionCode, profile);
    const officer = runOfficer(
      startState({ seed: interview.id, passRule, questionPool: pool }),
    );

    // NO AI CALL FOR THE OPENING TURN, and it is not an omission. There is
    // nothing to acknowledge — the applicant has not spoken — and the officer's
    // greeting is code-owned copy (`FALLBACK_OFFICER_LINES.greeting`). Calling
    // a model to rephrase a fixed greeting would spend the learner's key on the
    // one turn whose content is entirely ours, and would make `POST
    // /api/interviews` a streaming endpoint for no product reason.
    const officerTurns = await this.writeOfficerTurns(
      this.prisma,
      interview,
      officer.prompts,
      0,
      null,
    );

    this.logger.log(
      {
        userId,
        interviewId: interview.id,
        testVersionCode,
        seniorExemption: profile.seniorExemption,
        // The CHOICE is logged; nothing the learner types ever is.
        transcriptRetained: input.transcriptRetained,
        civicsPlanned: officer.state.civicsPlan.length,
      },
      'Mock interview started',
    );

    return {
      interview: toInterviewResponse(interview),
      officerTurns,
      progress: progressOf(officer.state),
      awaitingCompletion: officer.state.completed,
    };
  }

  /**
   * The caller's own interviews, newest first.
   *
   * The same `page`/`pageSize` shape and the same `[userId, startedAt]` index
   * `PracticeService.listSessions` uses (§12). No filters — see
   * `dto/interview-query.dto.ts`.
   */
  async listInterviews(
    userId: string,
    query: InterviewQuery,
  ): Promise<{
    items: InterviewListItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize } = query;

    const [rows, total] = await Promise.all([
      this.prisma.mockInterview.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.mockInterview.count({ where: { userId } }),
    ]);

    return {
      items: rows.map((row: any) => toInterviewResponse(row)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * One interview: resume it, or re-read its debrief.
   *
   * The same payload serves both, for the reason `PracticeService.getSession`
   * gives for its own: they are the same facts. `debrief` is null until the
   * interview is `completed` — §10's rule has to hold for THIS route too, or a
   * client could poll it mid-interview and read the per-question outcomes no
   * turn response is allowed to carry.
   */
  async getInterview(userId: string, interviewId: string): Promise<InterviewDetail> {
    const interview = await this.requireInterview(userId, interviewId);

    const turns = await this.prisma.mockInterviewTurn.findMany({
      where: { mockInterviewId: interview.id },
      orderBy: { turnIndex: 'asc' },
    });

    const passRule = await this.loadPassRule(
      interview.testVersionCode,
      interview.seniorExemption,
    );

    // The engine is re-run ONLY for a live interview, where "which phase am I
    // in" is a live question. A completed or abandoned interview's counters are
    // frozen on the row and its `awaitingCompletion` is meaningless — there is
    // nothing left to await — so replaying its whole transcript to learn what
    // the row already says would be queries spent on a foregone conclusion.
    const awaitingCompletion =
      interview.status === 'in_progress'
        ? (await this.rebuildState(interview)).completed
        : false;

    return {
      interview: toInterviewResponse(interview),
      turns: turns.map((turn: any) => toTurnRecord(turn)),
      progress: {
        civicsAsked: interview.civicsAsked,
        civicsPlanned: passRule.questionsAsked,
      },
      awaitingCompletion,
      debrief: (interview.result as InterviewDebrief | null) ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  /**
   * Take one applicant turn: grade it if it is a civics answer, advance the
   * engine, record everything, and stream the officer's reply.
   *
   * `async` AND RETURNING AN ITERABLE — NOT ITSELF A GENERATOR, exactly like
   * `CivicsExplainService.explain`, and for the same reason. A generator's body
   * does not run until the first `next()`, so an unknown interview id, a
   * completed interview, or an interview with no question left would become a
   * throw AFTER the controller had already written `200 text/event-stream`: a
   * 404 or a 409 delivered as a stream that opened and broke. Awaiting all of
   * it here means `HttpExceptionFilter` can still do its job.
   *
   * **Everything that decides the interview happens before the stream opens.**
   * The grade, the `practice_attempts` row, the mastery schedule, the engine's
   * new state and the interview's counters are all committed by the time the
   * first byte is written. The stream carries the officer's WORDING and nothing
   * else — which is §5's boundary, expressed as the order of operations in one
   * method.
   *
   * @param signal aborts the upstream call when the client goes away. Forwarded
   *        to the dispatcher; this service does not watch the socket.
   */
  async submitTurn(
    userId: string,
    interviewId: string,
    input: InterviewTurnInput,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<InterviewTurnFrame>> {
    const interview = await this.requireInterview(userId, interviewId);

    if (interview.status !== 'in_progress') {
      throw new ConflictException(
        `Interview "${interviewId}" is ${interview.status} and accepts no further turns`,
      );
    }

    const state = await this.rebuildState(interview);
    const prompt = nextPrompt(state);

    // The engine has run out of phases: the closing statement has been said and
    // the only remaining action is `complete` (§2.5). A 409 rather than a 400
    // because the request is well-formed — it is the interview's state that
    // refuses it, which is the same distinction `completeSession` draws for an
    // `abandoned` session.
    if (prompt.kind === 'completed') {
      throw new ConflictException(
        `Interview "${interviewId}" has no further turns; complete it to see the debrief`,
      );
    }

    const answeredPhase = state.phase;

    // GRADED ONLY IN THE CIVICS PHASE (§2.1, §2.2). Small talk and the
    // application-rehearsal prompts are never scored, never written as a
    // `practice_attempts` row, and never read by mastery or readiness — the
    // officer did not ask a question with a right answer, so there is nothing
    // to be right about.
    const graded =
      prompt.kind === 'civics'
        ? await this.gradeCivicsAnswer(userId, interview, prompt, input.text)
        : null;

    const answered = applyAnswer(state, {
      phase: answeredPhase,
      correct: graded?.outcome === 'correct',
    });
    const officer = runOfficer(answered);

    const applicantTurnIndex = await this.nextTurnIndex(interview.id);

    // ONE TRANSACTION: the attempt, its mastery schedule, the applicant's turn,
    // and the interview's own counters. They are one fact — "this answer
    // happened" — and a partial commit would leave the transcript and the
    // evidence table disagreeing about an interview in progress.
    await this.recordApplicantTurn(
      userId,
      interview,
      answeredPhase,
      applicantTurnIndex,
      input.text,
      graded,
      officer.state,
    );

    // ACCRUAL, AFTER THE TRANSACTION HAS COMMITTED — never inside it
    // (`habit-streaks.md` §2.1). Only for a graded civics turn: small talk and
    // the application prompts write no `practice_attempts` row, so there is no
    // attempt for `sliceSeconds` to measure from or to. Wrapped so a failure is
    // logged and swallowed, the same `accrueActivity` shape `PracticeService`
    // uses and for the same reason — the answer is the evidence; the day's
    // tally is a derived convenience on top of it.
    if (graded) {
      await this.accrueActivity(userId, interview.id, () =>
        this.engagement.recordInterviewAttemptActivity(userId, {
          mockInterviewId: interview.id,
          answeredAt: graded.answeredAt,
          outcome: graded.outcome,
        }),
      );
    }

    return this.streamOfficerTurns({
      userId,
      interview,
      answeredPhase,
      applicantText: input.text,
      answerOutcome: toAcknowledgedOutcome(graded),
      prompts: officer.prompts,
      state: officer.state,
      firstOfficerTurnIndex: applicantTurnIndex + 1,
      signal,
    });
  }

  /**
   * Finish the interview: compute the debrief, recompute readiness, persist
   * both.
   *
   * **Idempotent.** A repeat call on a `completed` interview returns the STORED
   * debrief verbatim and recomputes nothing — the same "a repeat call is a
   * read, not a re-run" posture `completeSession` takes (§12). This matters
   * more here than it does for a practice session: a second recompute would
   * write a second `readiness_snapshots` row for an interview that happened
   * once, so a double-tap on "finish" would move the learner's own trend line.
   *
   * An `abandoned` interview is a 409: well-formed request, nothing to
   * complete.
   */
  async completeInterview(
    userId: string,
    interviewId: string,
  ): Promise<InterviewDebrief> {
    const interview = await this.requireInterview(userId, interviewId);

    if (interview.status === 'completed') {
      // Verbatim, out of `mock_interviews.result`. Not rebuilt: the stored
      // debrief was computed against the answer snapshots and the readiness
      // snapshot that existed at completion, and recomputing it would silently
      // re-answer §11's questions with today's data.
      return interview.result as unknown as InterviewDebrief;
    }

    if (interview.status !== 'in_progress') {
      throw new ConflictException(
        `Interview "${interviewId}" is ${interview.status} and cannot be completed`,
      );
    }

    const passRule = await this.loadPassRule(
      interview.testVersionCode,
      interview.seniorExemption,
    );
    const state = await this.rebuildState(interview);

    // `stopReason` is null when the learner completed before the civics phase
    // was reached or resolved — an interview abandoned at small talk and then
    // finished, for instance. `all_asked` is the honest reading of that: the
    // plan was not exhausted by misses and the threshold was not met, the
    // interview simply ended where it ended. It is read off the engine and
    // never inferred from the counters, so the debrief cannot disagree with the
    // rule that produced it.
    const stopReason: CivicsStopReason = state.stopReason ?? 'all_asked';
    const passed = passedCivicsFor(state);

    const completedAt = this.clock.now();

    // The completion write FIRST, so the readiness recompute below counts this
    // interview. `readiness.service.ts` counts `mock_interviews` rows with
    // `status: 'completed'` AND `passed_civics: true`; recomputing before this
    // update would produce a snapshot that missed the very interview it was
    // triggered by, and the debrief would show a delta of zero on the run that
    // earned it.
    await this.prisma.mockInterview.update({
      where: { id: interview.id },
      data: {
        status: 'completed',
        completedAt,
        civicsAsked: state.civicsAsked,
        civicsCorrect: state.civicsCorrect,
        passedCivics: passed,
      },
    });

    // Read BEFORE the recompute, so "the score before this interview" is
    // unambiguous. Reading it afterwards would mean excluding the row just
    // written by id and hoping no two snapshots share a `computedAt` — which a
    // pinned `X-Test-Clock` makes routine.
    const previous = await this.prisma.readinessSnapshot.findFirst({
      where: { userId },
      orderBy: { computedAt: 'desc' },
      select: { score: true },
    });

    // READINESS RECOMPUTE TRIGGER (C) (§13), synchronous, in-request, after the
    // completion write above has committed. `readiness-model.md` §7(a) quotes
    // `ROADMAP.md` §7: "No job queue. Scheduling (E5) and readiness recompute
    // (E6) run synchronously, inside the request... that produces the
    // evidence." This is the request that produces the evidence.
    const snapshot = await this.readiness.recomputeSnapshot(userId);

    const debrief = buildInterviewDebrief({
      passRule,
      civicsAsked: state.civicsAsked,
      civicsCorrect: state.civicsCorrect,
      stopReason,
      passedCivics: passed,
      attempts: await this.loadDebriefAttempts(userId, interview.id),
      readiness: {
        score: snapshot.score,
        previousScore: previous?.score ?? null,
        delta: previous ? snapshot.score - previous.score : null,
        capReason: snapshot.capReason,
        // The fixed cap copy, read back off the snapshot's own recommendation
        // rather than re-typed here — see `dto/interview-debrief.dto.ts`.
        capMessage:
          snapshot.capReason === null ? null : snapshot.topRecommendation.reason,
        interviewComponent: {
          value: snapshot.components.interview.value,
          evidenceCount: snapshot.evidenceCounts.interview.attempts,
        },
      },
    });

    await this.prisma.mockInterview.update({
      where: { id: interview.id },
      data: { result: debrief as unknown as Prisma.InputJsonValue },
    });

    this.logger.log(
      {
        userId,
        interviewId: interview.id,
        civicsAsked: state.civicsAsked,
        civicsCorrect: state.civicsCorrect,
        passedCivics: passed,
        stopReason,
      },
      'Mock interview completed',
    );

    return debrief;
  }

  // ---------------------------------------------------------------------------
  // The officer's stream
  // ---------------------------------------------------------------------------

  /**
   * The officer's acknowledgement, streamed, and the turns it introduces,
   * persisted.
   *
   * ---------------------------------------------------------------------------
   * WHY THE OFFICER TURNS ARE WRITTEN IN A `finally`
   * ---------------------------------------------------------------------------
   *
   * The turn's text is not known until the stream ends — that is what streaming
   * means — so it cannot be written in the same transaction as the applicant's
   * answer. A client that disconnects mid-sentence would then leave a
   * transcript whose last line is the applicant's, with the officer's reply
   * missing forever; on resume the engine would correctly ask for the next
   * answer, to a question the transcript never records having been asked.
   *
   * A `finally` closes that. It runs on the normal path, on a thrown error, AND
   * when the controller calls `return()` on this generator after noticing the
   * socket closed — so the turns are persisted with whatever acknowledgement had
   * arrived, or with the neutral fallback if none had. The learner who
   * reconnects sees a complete transcript.
   *
   * ---------------------------------------------------------------------------
   * `unavailable` AND `error` CHANGE THE WORDING AND NOTHING ELSE (§5.2)
   * ---------------------------------------------------------------------------
   *
   * Both take the same path as `done`: the same turns are written, in the same
   * phases, naming the same questions, and the interview's state is already
   * committed above regardless. Only `assembleOfficerTurn`'s first argument
   * differs — a model's sentence, or the code-owned neutral line. A test drives
   * the identical scripted answers twice, once with the dispatcher succeeding
   * and once forced to `unavailable`, and deep-compares the two debriefs.
   */
  private async *streamOfficerTurns(
    ctx: OfficerStreamContext,
  ): AsyncGenerator<InterviewTurnFrame, void, undefined> {
    let acknowledgement = '';
    let terminal: TerminalReason = { kind: 'done' };
    let officerTurns: InterviewTurnRecord[] = [];

    try {
      const run = await this.dispatch.runStream(
        ctx.userId,
        TUTOR_ROLE,
        {
          messages: buildOfficerPrompt({
            answeredPhase: ctx.answeredPhase,
            nextPhase: ctx.state.phase,
            applicantText: ctx.applicantText,
            answerOutcome: ctx.answerOutcome,
            isClosing: ctx.state.completed,
          }),
          maxTokens: OFFICER_MAX_TOKENS,
        },
        ctx.signal,
      );

      if (run.status === 'unavailable') {
        terminal = { kind: 'unavailable', cause: run.cause };
      } else {
        for await (const event of run.events) {
          switch (event.type) {
            case 'delta':
              acknowledgement += event.text;
              yield { event: 'delta', data: { text: event.text } };
              break;

            case 'done':
              terminal = { kind: 'done' };
              break;

            case 'error':
              terminal = {
                kind: 'error',
                errorCode: event.errorCode,
                error: event.error,
              };
              break;
          }
        }
      }
    } finally {
      // `null` whenever no usable acknowledgement was produced, which
      // `assembleOfficerTurn` renders as the neutral fallback (§9.2). A partial
      // sentence from a stream that failed halfway is discarded for the same
      // reason `AiStructuredRunOk` refuses to salvage a half-parsed reply: half
      // an officer's sentence is not a shorter officer's sentence.
      const spoken =
        terminal.kind === 'done' && acknowledgement.trim().length > 0
          ? acknowledgement
          : fallbackAcknowledgement(ctx.answeredPhase, ctx.prompts[0], ctx.state.phase);

      officerTurns = await this.writeOfficerTurns(
        this.prisma,
        ctx.interview,
        ctx.prompts,
        ctx.firstOfficerTurnIndex,
        spoken,
      );
    }

    const outcome: InterviewTurnOutcome = {
      officerTurns,
      phase: ctx.state.phase,
      turnIndex:
        officerTurns.length > 0
          ? officerTurns[officerTurns.length - 1].turnIndex
          : ctx.firstOfficerTurnIndex - 1,
      progress: progressOf(ctx.state),
      awaitingCompletion: ctx.state.completed,
    };

    switch (terminal.kind) {
      case 'done':
        yield { event: 'done', data: outcome };
        break;

      case 'unavailable':
        yield { event: 'unavailable', data: { ...outcome, cause: terminal.cause } };
        break;

      case 'error':
        yield {
          event: 'error',
          data: {
            ...outcome,
            errorCode: terminal.errorCode,
            // Redacted by the dispatcher already: never the prompt, never the
            // reply, and never anything the applicant typed.
            error: terminal.error,
          },
        };
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * The applicant's turn, the attempt it produced, its mastery schedule, and
   * the interview's counters — one transaction.
   *
   * ---------------------------------------------------------------------------
   * RETENTION IS ENFORCED HERE, AT THE WRITE, AND NOWHERE ELSE (§8.2)
   * ---------------------------------------------------------------------------
   *
   * Three columns, one flag, and the table below is the whole rule:
   *
   *   | column                            | retained: false | retained: true |
   *   |-----------------------------------|-----------------|----------------|
   *   | `mock_interview_turns.text`       | `''`            | the text       |
   *   | `practice_attempts.response_text` | `null`          | the text       |
   *   | `practice_attempts.ai_feedback`   | OMITTED         | the verdict    |
   *
   * `outcome`, `grading_method`, `failure_cause`, `ai_usage_event_id` and
   * `answer_snapshot` are written in BOTH cases. §8.2: "the evidence survives;
   * the learner's own words do not". Everything that records WHAT HAPPENED is
   * what mastery scheduling, readiness and the debrief depend on, and none of it
   * is the learner's own text.
   *
   * `ai_feedback` is omitted rather than nulled, using the same conditional
   * spread `recordAttempt` already uses for the three AI columns — Prisma's
   * nullable `Json` takes `Prisma.DbNull` rather than `null`, and the absence is
   * the meaning anyway. It is withheld with retention off SPECIFICALLY because
   * a grader's `feedback` field is free text a model wrote ABOUT the response
   * and routinely quotes it back ("your answer mentioned 'congress i think'").
   * Storing it would be a second, indirect way to retain the learner's words
   * under a column that looks like it belongs to the product's own judgment.
   * `failure_cause` and `ai_usage_event_id` are kept: a taxonomy value and a row
   * id quote nothing.
   *
   * **The learner's real text was already graded, in memory, before this method
   * ran.** Retention governs what is PERSISTED, never what is graded — a
   * retention-off learner is graded on exactly the words they typed, by exactly
   * the ladder a retention-on learner gets. Reading this method alone, with
   * `responseText: null` on the write, it would be easy to conclude otherwise;
   * see {@link gradeCivicsAnswer}, which took `input.text` and never consulted
   * the flag.
   */
  private async recordApplicantTurn(
    userId: string,
    interview: { id: string; transcriptRetained: boolean },
    answeredPhase: InterviewPhase,
    turnIndex: number,
    text: string,
    graded: GradedCivicsAnswer | null,
    state: EngineState,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      let attemptId: string | null = null;

      if (graded) {
        const attempt = await tx.practiceAttempt.create({
          data: {
            userId,
            questionId: graded.questionId,
            // THE GROUPING KEY §13 WAS WAITING FOR. `sessionId` is null and
            // `mockInterviewId` is set: one evidence table, no `UNION`
            // (§7), and `readiness.service.ts` can finally count discrete
            // interviews instead of guessing at them.
            sessionId: null,
            mockInterviewId: interview.id,
            source: 'mock_interview',
            // Text mode. E9 wires `spoken`/`heard` through the same rows —
            // nothing can tell after the fact whether an old typed answer was
            // typed or transcribed, which is why both are written explicitly.
            inputMode: 'typed',
            promptMode: 'read',
            responseText: interview.transcriptRetained ? graded.responseText : null,
            outcome: graded.outcome,
            gradingMethod: graded.gradingMethod,
            // THE AI COLUMNS ARE OMITTED ENTIRELY WHEN NO GRADER RAN, rather
            // than written as null — the same conditional spread
            // `recordAttempt` uses, for the same reason: a nullable `Json`
            // column takes `Prisma.DbNull` rather than `null`, and the absence
            // IS the meaning. Null in all three says no grader ever looked at
            // this response, which is a different fact from
            // `failureCause: 'unknown'`.
            ...(graded.graderRan
              ? {
                  failureCause: graded.failureCause,
                  aiUsageEventId: graded.aiUsageEventId,
                }
              : {}),
            // RETENTION, HALF TWO. Omitted on a SECOND condition the practice
            // path does not have: with retention off, the grader's verdict is
            // withheld even though it ran and even though its `failureCause`
            // and its usage-row id are kept beside it. §8.2 — the `feedback`
            // field is free text a model wrote ABOUT the response and quotes it
            // back often enough that storing it would retain the learner's own
            // words under a column that looks like the product's own judgment.
            ...(graded.graderRan && graded.aiFeedback !== null && interview.transcriptRetained
              ? {
                  aiFeedback: graded.aiFeedback as unknown as Prisma.InputJsonValue,
                }
              : {}),
            // ALWAYS FALSE INSIDE AN INTERVIEW (§6.1, §10). Neither affordance
            // exists here, which makes an interview answer unusually CLEAN
            // evidence for readiness's `recall` component, whose filter is
            // exactly `hintUsed = false AND revealed = false` (§7).
            revealed: false,
            hintUsed: false,
            // Absent stays absent. There is no client-supplied duration on an
            // interview turn at all — engagement measures the slice from the
            // interview's own `startedAt` and the previous attempt, server-side
            // (`habit-streaks.md` §2.3).
            durationMs: null,
            answeredAt: graded.answeredAt,
            answerSnapshot: graded.snapshot as unknown as Prisma.InputJsonValue,
          },
        });

        attemptId = attempt.id;

        // SYNCHRONOUS MASTERY SCHEDULING, INSIDE THIS SAME TRANSACTION — the
        // identical placement `recordAttempt` uses, including the
        // `state_required` skip. §7: an interview answer is at least as good
        // evidence as a practice attempt, so it advances `question_mastery`
        // exactly as one does. Skipping a `state_required` attempt is the same
        // refusal `recordAttempt` makes: lapsing a question's mastery for a
        // system limitation (no state on the profile) rather than for anything
        // the learner did would be a discount the learner never earned.
        //
        // -------------------------------------------------------------------
        // THIS GUARD IS DELIBERATELY ONE CONDITION SHORTER THAN ITS SIBLING
        // (issue #244, epic #58 / E9)
        // -------------------------------------------------------------------
        //
        // `PracticeService.recordAttempt`'s matching guard now reads
        // `status !== 'state_required' && !misheard`: a misheard attempt is
        // recorded but never scheduled, because the recogniser's own
        // uncertainty about the TEXT makes the row no evidence about recall in
        // either direction, and every `AttemptOutcome` the scheduler accepts
        // is a claim about recall. This one has no `!misheard` half, and that
        // is correct TODAY for one reason only: THE INTERVIEW PATH CANNOT
        // PRODUCE A MISHEARD ATTEMPT. Not "does not in practice" — cannot,
        // four times over:
        //
        //   1. `interview-turn.dto.ts` is `z.strictObject({ text })`. There is
        //      no `asrConfidence` field, and `strictObject` rejects unknown
        //      keys, so a confidence cannot arrive even as a stray property.
        //   2. `inputMode: 'typed'` is hardcoded on the attempt written above
        //      (:908) — an interview turn is never marked spoken.
        //   3. `isMisheardAttempt` is never called on this path. It is
        //      `PracticeService`'s, invoked at exactly one call site, and
        //      nothing here computes the `misheard` flag at all.
        //   4. `PersistableFailureCause` — the type of `graded.failureCause`
        //      — EXCLUDES `'misheard'` at the type level, via
        //      `UNGROUNDED_FAILURE_CAUSES` in `practice/grading.ts`. So the AI
        //      grader cannot supply the cause on this path either, and the
        //      compiler enforces it.
        //
        // WIRING E9 VOICE INTO INTERVIEWS MAKES THIS GUARD WRONG IMMEDIATELY
        // (E11 / #60 is the epic that will). The moment an interview turn
        // carries a real `asrConfidence`, a learner misheard by the recogniser
        // starts being charged a mastery penalty here — `correctStreak` reset,
        // `lapses` incremented, `dueAt` pulled in — which is precisely the harm
        // #244 removed from the practice path, reappearing on the path where a
        // nervous applicant is most likely to be misheard.
        //
        // AND NOTHING WOULD FORCE THE AUTHOR TO NOTICE. Adding the field is a
        // change to the DTO and to the attempt write; this line would keep
        // compiling untouched, no test asserts the condition exists, and the
        // symptom is a slightly-too-low readiness score rather than an error.
        // That is why the evidence above is written out rather than left to be
        // re-derived: whoever wires voice in must read this and add the half.
        //
        // ISSUE #245 TRACKS THE REAL FIX — moving the skip rule INSIDE
        // `AttemptGradingService.scheduleMastery`, so it is decided once for
        // both call sites and they cannot disagree. Prefer that to adding
        // `&& !misheard` here a second time: a rule stated twice is a rule that
        // can be fixed in one place and silently left stale in the other, which
        // is the exact situation this comment exists to describe.
        if (graded.answerResolution !== 'state_required') {
          await this.grading.scheduleMastery(
            tx,
            userId,
            graded.questionId,
            toAttemptOutcome(graded.outcome, graded.gradingMethod),
            graded.answeredAt,
          );
        }
      }

      await tx.mockInterviewTurn.create({
        data: {
          mockInterviewId: interview.id,
          turnIndex,
          role: 'applicant',
          phase: answeredPhase,
          attemptId,
          // RETENTION, HALF ONE. Empty is meaningful, not a bug —
          // `mock_interview_turns.text`'s own schema comment says so. The turn
          // still exists, in this phase, in this order, pointing at the attempt
          // it produced; only the words are gone.
          text: interview.transcriptRetained ? text : '',
        },
      });

      // The derived running tally (`mock_interviews`' own schema comment calls
      // it that): kept in step on every turn so the readiness query and a live
      // screen can read a count by primary key instead of re-aggregating
      // attempts. The `practice_attempts` rows remain the evidence; if these
      // ever disagreed, the attempts are right.
      await tx.mockInterview.update({
        where: { id: interview.id },
        data: {
          civicsAsked: state.civicsAsked,
          civicsCorrect: state.civicsCorrect,
          passedCivics: passedCivicsFor(state),
        },
      });
    });
  }

  /**
   * Write the officer turns for one exchange and return them in wire shape.
   *
   * The acknowledgement is attached to the FIRST turn only. When one exchange
   * produces three (the last civics answer is followed by the reading skip, the
   * writing skip and the closing), the officer thanks the applicant once and
   * then reads three code-owned lines — which is how a person would do it, and
   * the alternative would have them say "Thank you." three times for one
   * sentence.
   *
   * The question prompts are read here, from `civics_questions`, and handed to
   * {@link assembleOfficerTurn} as strings. That is §5.1's mechanism: the model
   * never saw them and has no field they could have come back in.
   */
  private async writeOfficerTurns(
    db: Pick<PrismaService, 'mockInterviewTurn' | 'civicsQuestion'>,
    interview: { id: string },
    prompts: readonly InterviewPrompt[],
    firstTurnIndex: number,
    acknowledgement: string | null,
  ): Promise<InterviewTurnRecord[]> {
    if (prompts.length === 0) return [];

    const questionIds = prompts
      .filter((prompt): prompt is Extract<InterviewPrompt, { kind: 'civics' }> =>
        prompt.kind === 'civics',
      )
      .map((prompt) => prompt.questionId);

    const questions =
      questionIds.length > 0
        ? await db.civicsQuestion.findMany({
            where: { id: { in: questionIds } },
            select: { id: true, prompt: true },
          })
        : [];

    const promptById = new Map<string, string>(
      questions.map((question: { id: string; prompt: string }) => [
        question.id,
        question.prompt,
      ]),
    );

    const written: InterviewTurnRecord[] = [];

    for (const [offset, prompt] of prompts.entries()) {
      const body = toOfficerTurnBody(prompt, promptById, firstTurnIndex + offset === 0);

      const row = await db.mockInterviewTurn.create({
        data: {
          mockInterviewId: interview.id,
          turnIndex: firstTurnIndex + offset,
          role: 'officer',
          phase: phaseOfPrompt(prompt),
          // Set only on a civics officer turn — which question was read aloud.
          // Nullable and INDEPENDENT of the turn's text on purpose: it is what
          // lets a transcript still name which question was asked for a learner
          // whose own words were not kept.
          questionId: prompt.kind === 'civics' ? prompt.questionId : null,
          // The officer's words are stored in BOTH retention cases (§8.2).
          // They are product copy plus database question text — never anything
          // the learner produced — and keeping them is what lets a debrief say
          // what was actually asked to a learner who declined to keep their own
          // answers.
          text: assembleOfficerTurn(offset === 0 ? acknowledgement : null, body),
        },
      });

      written.push(toTurnRecord(row));
    }

    return written;
  }

  // ---------------------------------------------------------------------------
  // Grading
  // ---------------------------------------------------------------------------

  /**
   * One civics answer, through the ONE ladder (§6).
   *
   * `resolveAcceptedAnswers` -> `gradeDeterministic` -> `escalateToGrader`, the
   * same three calls in the same order `PracticeService.recordAttempt` makes,
   * against the same injectable. Nothing here re-derives what counts as
   * correct.
   *
   * **The learner's real text is what is graded**, unconditionally. The
   * retention flag is not read in this method and must never be: withholding
   * the words from the GRADER would mean a retention-off learner was graded on
   * an empty string, which would fail every question they answered correctly
   * and record that failure permanently in the one evidence table the whole
   * product reads. Retention governs storage, and only storage — see
   * {@link recordApplicantTurn}, which is where the flag is honoured.
   *
   * `skipped: false` is passed to the deterministic rung unconditionally, and
   * that is the interview's one difference from practice: there is no skip
   * button in a rehearsal (§6.1, §10). An applicant who types nothing has still
   * answered, and `matchAnswer` grades an empty string `incorrect` — which is
   * what the real event would conclude too.
   */
  private async gradeCivicsAnswer(
    userId: string,
    interview: { testVersionCode: string },
    prompt: Extract<InterviewPrompt, { kind: 'civics' }>,
    text: string,
  ): Promise<GradedCivicsAnswer> {
    const question = await this.prisma.civicsQuestion.findUnique({
      where: { id: prompt.questionId },
      select: QUESTION_SELECT,
    });

    if (!question) {
      // The ask-list is derived from the live bank, so a question deleted
      // between two turns of one interview can genuinely reach here. It is a
      // content event, not a client error, which is why it is logged as one and
      // surfaces as a 404 naming the question rather than a 500.
      throw new NotFoundException(
        `Civics question "${prompt.questionId}" not found`,
      );
    }

    const profile = await this.loadProfile(userId);
    const answeredAt = this.clock.now();

    const { status, stateCode, answers } = await this.grading.resolveAcceptedAnswers(
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

    const { outcome, responseText } = this.grading.gradeDeterministic(
      { skipped: false, responseText: text },
      status,
      answers,
    );

    // RUNG 2, AND ONLY ON A MISS. Returns null for a match (the short-circuit
    // that spends no AI credit on a right answer) and null for every way the
    // call can fail (rung 3, which keeps the deterministic verdict). Either way
    // the interview continues at a 200 — `ai-evaluation.md` §6's reason applies
    // with more force here than in practice: a learner mid-rehearsal of the
    // most consequential conversation of their life is not the audience for a
    // billing event.
    const aiGrading = await this.grading.escalateToGrader(
      userId,
      question.prompt,
      answers,
      { status, outcome, responseText },
    );

    return {
      questionId: question.id,
      outcome: aiGrading?.outcome ?? outcome,
      gradingMethod: aiGrading ? 'ai' : 'exact',
      responseText,
      snapshot,
      answerResolution: status,
      graderRan: aiGrading !== null,
      failureCause: aiGrading?.failureCause ?? null,
      aiFeedback: aiGrading?.aiFeedback ?? null,
      aiUsageEventId: aiGrading?.aiUsageEventId ?? null,
      answeredAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The interview, or a 404.
   *
   * The ONE place any route loads an interview, filtered by `userId` in the
   * `where` rather than checked afterwards. **Another learner's interview is a
   * 404, not a 403** — the exact rule `PracticeService.requireSession` already
   * enforces, copied deliberately (§12).
   *
   * The reasoning is worth restating rather than cross-referencing, because it
   * is a security decision and not a style one: naming a resource the caller may
   * not see is itself a leak. A 403 confirms that this uuid is a real interview
   * belonging to somebody; a 404 says what is actually true from this caller's
   * position, which is that no such interview exists for them. An Admin gets no
   * special path either — this is a structural property, not a permission check
   * a refactor could relax, because there is no method here that could load an
   * interview without a `userId` to filter on.
   */
  private async requireInterview(userId: string, interviewId: string) {
    const interview = await this.prisma.mockInterview.findFirst({
      where: { id: interviewId, userId },
    });

    if (!interview) {
      throw new NotFoundException(`Mock interview "${interviewId}" not found`);
    }

    return interview;
  }

  /**
   * Rebuild the engine's state for an interview, by replay.
   *
   * ---------------------------------------------------------------------------
   * WHY REPLAY, AND NOT A `phase` COLUMN
   * ---------------------------------------------------------------------------
   *
   * `mock_interviews` has no `phase`, no `phase_turn_index` and no `civics_plan`
   * column, and this method is why that is a design rather than an omission.
   * The engine is a pure function of four things, and all four are already
   * durable and already the authority on themselves:
   *
   *   * the SEED is the interview's own primary key (`seeded-random.ts`'s
   *     header calls this "a genuinely load-bearing second use of the primary
   *     key");
   *   * the POOL is `civics_questions`, filtered by the same three rules
   *     {@link eligibleQuestionIds} applies at creation;
   *   * the PASS RULE is the `civics_test_versions` row plus the interview's own
   *     frozen `senior_exemption`;
   *   * the ANSWERS are the interview's own applicant turns and the
   *     `practice_attempts` rows they produced.
   *
   * A stored phase would be a fifth account of the same fact, able to disagree
   * with the transcript — and the first time it did, an interview would be
   * asking civics questions while its turn log said it was still on small talk,
   * with no way to tell which was right.
   *
   * ---------------------------------------------------------------------------
   * THE ONE HONEST LIMITATION, STATED RATHER THAN HIDDEN
   * ---------------------------------------------------------------------------
   *
   * The pool is re-read live, so a change to the eligible set BETWEEN two turns
   * of one interview changes the derived ask-list from that point on: a question
   * added to the bank, a `senior_eligible` flag corrected, or — the reachable
   * one — the learner setting their `state_code` mid-interview, which makes
   * `state`-scope questions answerable and widens the pool.
   *
   * §3.3 scopes the reproducibility claim to exactly this: "same seed, same
   * pool, same sequence" is a property of the ENGINE, verified against a pool
   * its own tests control, and not a promise about a bank that changed
   * underneath a running interview. The consequence is bounded — the questions
   * already asked are already recorded as turns and as attempts, and the
   * counters they produced are on the row — so the interview stays gradeable
   * and its debrief stays true; only the questions not yet asked can differ from
   * the ones the original plan would have chosen.
   */
  private async rebuildState(interview: {
    id: string;
    userId: string;
    testVersionCode: string;
    seniorExemption: boolean;
  }): Promise<EngineState> {
    const [passRule, profile] = await Promise.all([
      this.loadPassRule(interview.testVersionCode, interview.seniorExemption),
      this.loadProfile(interview.userId),
    ]);

    const pool = await this.eligibleQuestionIds(interview.testVersionCode, {
      ...profile,
      // The interview's OWN frozen flag, never the profile's current one — see
      // `createInterview`. A learner who claimed the senior accommodation
      // halfway through must not have the pool they are being asked from change
      // underneath them.
      seniorExemption: interview.seniorExemption,
    });

    let state = runOfficer(
      startState({ seed: interview.id, passRule, questionPool: pool }),
    ).state;

    const applicantTurns = await this.prisma.mockInterviewTurn.findMany({
      where: { mockInterviewId: interview.id, role: 'applicant' },
      orderBy: { turnIndex: 'asc' },
      include: { attempt: { select: { outcome: true } } },
    });

    for (const turn of applicantTurns) {
      // The turn's own phase is deliberately NOT passed to `applyAnswer` —
      // `state.phase` is. The engine throws on a phase disagreement, and a
      // transcript row is not the authority on where the engine is: if the two
      // ever diverged (a bank change under a resumed interview), replaying from
      // the row would abort the whole request rather than continue from the
      // state the engine can actually justify.
      state = applyAnswer(state, {
        phase: state.phase,
        correct: (turn as any).attempt?.outcome === 'correct',
      });

      // The officer's own turns — the skipped segments and the closing — consume
      // no applicant answer, so replay has to walk past them exactly as the live
      // path does. Sharing `runOfficer` between the two is what makes a resumed
      // interview land in the state the live one was in, rather than in a state
      // a second implementation happened to compute.
      state = runOfficer(state).state;
    }

    return state;
  }

  /**
   * N and T for this interview, from the `civics_test_versions` ROW.
   *
   * NO THRESHOLD LITERAL EXISTS ANYWHERE IN THIS MODULE, which is
   * `CivicsTestVersion`'s own schema comment cashed in: "E8's interview engine
   * reads pass rules FROM A ROW, not from a constant duplicated at each call
   * site". `selectPassRule` is the one place the senior branch is decided, and
   * it decides it by choosing two of four columns — it never learns what
   * numbers are in them. A missing row is a 404 rather than a default, because
   * there is no honest N to invent: an interview graded against a guessed pass
   * mark would be the "tells a learner they are ready for a test it did not
   * administer" failure the engine's own comment calls the most expensive lie
   * this product could tell.
   */
  private async loadPassRule(
    testVersionCode: string,
    seniorExemption: boolean,
  ): Promise<InterviewPassRule> {
    const version = await this.prisma.civicsTestVersion.findUnique({
      where: { code: testVersionCode },
      select: {
        questionsAsked: true,
        passThreshold: true,
        seniorQuestionsAsked: true,
        seniorPassThreshold: true,
      },
    });

    if (!version) {
      throw new NotFoundException(
        `Civics test version "${testVersionCode}" not found`,
      );
    }

    return selectPassRule(version, seniorExemption);
  }

  /**
   * The question ids this interview may draw from, in a stable base order.
   *
   * §3.2's three filters, and the third is imported rather than re-derived:
   *
   *  1. THE LEARNER'S OWN BANK. There is no second test version an interview
   *     could honestly draw from — the pass rule it is graded against belongs to
   *     this one.
   *  2. `seniorEligible` ONLY WITH THE EXEMPTION. A learner who has not claimed
   *     it is never asked one of the senior-eligible questions BECAUSE they are
   *     senior-eligible and easier; that would be grading them against a bank
   *     they are not entitled to use.
   *  3. `excludeUnanswerable` from `practice/question-selection.ts`, verbatim.
   *     A `state`-scope question with no `stateCode` on the profile has no
   *     honest accepted answer to grade against, and that file's own comment
   *     states the reason this module inherits rather than restates: "there is
   *     no honest grade available... Serving it would spend one of the
   *     [ask-list's] questions on an exercise that cannot teach or measure
   *     anything." This is not a new rule invented for interviews; it is the
   *     existing one applied to a second selector.
   *
   * The base order is `(categoryId, number)` — deterministic and stable, which
   * is what makes the seeded shuffle over it reproducible. Any stable order
   * would do; what must never happen is an unordered read, which would make the
   * ask-list depend on whatever order Postgres felt like returning rows in.
   */
  private async eligibleQuestionIds(
    testVersionCode: string,
    profile: InterviewProfile,
  ): Promise<string[]> {
    const questions = await this.prisma.civicsQuestion.findMany({
      where: {
        testVersionCode,
        ...(profile.seniorExemption ? { seniorEligible: true } : {}),
      },
      select: { id: true, dynamicScope: true },
      orderBy: [{ categoryId: 'asc' }, { number: 'asc' }],
    });

    return excludeUnanswerable(
      questions as unknown as { id: string; dynamicScope: DynamicScope }[],
      profile.stateCode,
    ).map((question) => question.id);
  }

  /**
   * This interview's graded attempts, joined to their questions and categories,
   * in the order they were answered.
   *
   * `acceptedAnswers` is read out of each attempt's FROZEN `answer_snapshot` —
   * never a live re-query (§11). `practice-sessions.md` §6 is the argument this
   * inherits: a `national`- or `state`-scope answer changes by design, and
   * re-resolving at read time would tell a learner who answered "who is the
   * Speaker of the House" correctly that they were wrong, because somebody else
   * holds the office now.
   */
  private async loadDebriefAttempts(
    userId: string,
    interviewId: string,
  ): Promise<DebriefAttempt[]> {
    const attempts = await this.prisma.practiceAttempt.findMany({
      where: { mockInterviewId: interviewId, userId },
      // Oldest first: the order the learner answered them in, which is the
      // order the debrief replays. `id` breaks the tie for two attempts sharing
      // an instant, which a pinned `X-Test-Clock` makes routine.
      orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }],
      include: {
        question: {
          select: {
            id: true,
            number: true,
            prompt: true,
            category: { select: { name: true } },
          },
        },
      },
    });

    return attempts.map((attempt: any) => ({
      questionId: attempt.questionId,
      number: attempt.question?.number ?? 0,
      prompt: attempt.question?.prompt ?? '',
      categoryName: attempt.question?.category?.name ?? '',
      outcome: attempt.outcome,
      acceptedAnswers: snapshotAnswerTexts(attempt.answerSnapshot),
    }));
  }

  /** The next free `turn_index` for this interview. */
  private async nextTurnIndex(interviewId: string): Promise<number> {
    const last = await this.prisma.mockInterviewTurn.findFirst({
      where: { mockInterviewId: interviewId },
      orderBy: { turnIndex: 'desc' },
      select: { turnIndex: true },
    });

    return last ? last.turnIndex + 1 : 0;
  }

  /**
   * The three profile facts an interview reads. A missing row reads as
   * all-unknown.
   *
   * A plain read, never an upsert — `JourneyService.getProfile` is the one place
   * a `learner_profiles` row is created, because orientation is what fills it
   * in. The identical posture `PracticeService.loadProfile` takes, and for the
   * identical reason.
   */
  private async loadProfile(userId: string): Promise<InterviewProfile> {
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
   * `mock_interviews.testVersionCode` is `NOT NULL` and there is no honest value
   * to invent: which civics bank a learner sits is resolved from their filing
   * date at orientation (`journey/test-version-resolution.ts`). A 400 naming
   * orientation is actionable; an interview against a guessed bank is not
   * discoverable at all — and, unlike a practice session, it ends by telling the
   * learner whether they passed.
   *
   * Unreachable through the app's own screens: `RequireOrientation` blocks an
   * unoriented learner from every route but setup. That is why this is a plain
   * 400 rather than a redirect or a special error code — the same call
   * `PracticeService.requireOrientedProfile` makes.
   */
  private async requireOrientedProfile(userId: string): Promise<InterviewProfile> {
    const profile = await this.loadProfile(userId);

    if (!profile.testVersionCode) {
      throw new BadRequestException(
        'Finish orientation before starting a mock interview — your civics test version has not been resolved yet',
      );
    }

    return profile;
  }

  /**
   * Run one accrual call, and never let it fail the turn that triggered it.
   *
   * The same rule and the same shape `PracticeService.accrueActivity` states:
   * an answer that was graded and recorded must never become a 500 because a
   * rollup table had a transient write failure. The attempt is the EVIDENCE;
   * the day's tally is a derived convenience on top of it, and a missed
   * increment is recoverable in a way a lost attempt never would be.
   *
   * Note what is NOT accrued: the gap between an interview's last answer and the
   * moment the learner tapped "finish". `PracticeService` closes the equivalent
   * gap for a session through `recordSessionCompletionActivity`; this epic
   * deliberately adds no second accrual event, because unlike a practice
   * summary an interview's closing turns are read, not answered, and crediting
   * unmeasured reading time to a streak is exactly what
   * `ATTEMPT_SECONDS_CAP` exists to bound. The gap is small and undercounts
   * rather than overcounts, which is the direction `habit-streaks.md` §2.3
   * prefers.
   */
  private async accrueActivity(
    userId: string,
    interviewId: string,
    accrue: () => Promise<void>,
  ): Promise<void> {
    try {
      await accrue();
    } catch (error) {
      this.logger.error(
        { userId, interviewId, err: error },
        'Daily activity accrual failed; the interview turn it followed still stands',
      );
    }
  }
}

// -----------------------------------------------------------------------------
// The engine driver
// -----------------------------------------------------------------------------

/** What {@link runOfficer} produces: the state to persist, and what to say. */
interface OfficerRun {
  state: EngineState;
  prompts: InterviewPrompt[];
}

/**
 * Walk the engine forward until it needs an applicant answer, collecting the
 * officer prompts it passes through.
 *
 * PURE, and shared by the live path and by {@link InterviewsService.rebuildState}'s
 * replay — which is the whole reason it is a function rather than a loop inlined
 * into `submitTurn`. A resumed interview must land in the state the live one was
 * in, and the cheapest way to guarantee that is for both to walk the engine with
 * the same code rather than with two implementations that agree today.
 *
 * Two prompt kinds consume no applicant answer, and both are the engine's own
 * design rather than this function's:
 *
 *   * `skipped_segment` — §2.4's one honest line per phase ("this rehearsal does
 *     not include the reading test"). There is nothing to reply to.
 *   * `closing` — §2.5's closing statement, after which the interview awaits
 *     `complete`. A real officer does not wait for an answer to "thank you for
 *     your time".
 *
 * So one exchange can produce three officer turns: the last civics answer of an
 * interview is followed by both skips and the closing, and the learner sees all
 * three at once, which is what the real event's pacing looks like.
 */
function runOfficer(state: EngineState): OfficerRun {
  const prompts: InterviewPrompt[] = [];
  let current = state;

  // Bounded by construction: every iteration either returns or advances a phase,
  // and `INTERVIEW_PHASES` is finite. `applyAnswer` on a non-civics phase
  // increments that phase's turn counter and moves on when the phase has had its
  // turns, so no phase can be walked twice.
  for (;;) {
    const prompt = nextPrompt(current);

    if (prompt.kind === 'completed') return { state: current, prompts };

    prompts.push(prompt);

    if (prompt.kind !== 'skipped_segment' && prompt.kind !== 'closing') {
      // This one needs an answer. Stop here; the state is not advanced past a
      // question nobody has answered yet.
      return { state: current, prompts };
    }

    // `correct: false` is not a grade — the phase is not graded at all (`applyAnswer`
    // reads `correct` only in the civics phase). It is the value the type
    // requires for a turn nobody answered.
    current = applyAnswer(current, { phase: current.phase, correct: false });
  }
}

/** Which enum value a prompt's turn is recorded under. */
function phaseOfPrompt(prompt: InterviewPrompt): InterviewPhase {
  switch (prompt.kind) {
    case 'smalltalk':
      return 'smalltalk';
    case 'n400':
      return 'n400';
    case 'civics':
      return 'civics';
    case 'skipped_segment':
      return prompt.phase;
    case 'closing':
      return 'closing';
    case 'completed':
      // Unreachable: `runOfficer` never emits a `completed` prompt, and this
      // function is only ever called on what it emitted. Throwing beats
      // returning a plausible phase, which would file a turn that does not exist
      // under one that does.
      throw new Error('phaseOfPrompt: a completed interview has no turn to record');
  }
}

/**
 * The CONTENT half of an officer turn, resolved from the engine's prompt.
 *
 * The `civics` branch is §5.1's structural enforcement at its narrowest point:
 * the question's `prompt` string, read from the database by the caller, handed
 * to `assembleOfficerTurn` to be appended verbatim. There is no path here on
 * which a model contributed the question text.
 */
function toOfficerTurnBody(
  prompt: InterviewPrompt,
  promptById: ReadonlyMap<string, string>,
  isOpeningTurn: boolean,
): OfficerTurnBody {
  switch (prompt.kind) {
    case 'smalltalk':
      // The opening turn is a greeting plus the non-scored opener (§2). Any
      // later small-talk turn — which `SMALLTALK_TURNS = 1` makes unreachable
      // today, but the engine's phase-turn machinery would allow — gets the
      // opener alone rather than a second "good morning".
      return isOpeningTurn
        ? { kind: 'greeting' }
        : { kind: 'n400', promptText: FALLBACK_OFFICER_LINES.smalltalk };

    case 'n400':
      return { kind: 'n400', promptText: prompt.promptText };

    case 'civics':
      return {
        kind: 'civics',
        // Empty only if the question vanished between the ask-list being derived
        // and this read — `gradeCivicsAnswer` 404s on the same condition, so a
        // turn written with an empty prompt is a transcript row nobody can
        // answer rather than a silently wrong question.
        questionPrompt: promptById.get(prompt.questionId) ?? '',
      };

    case 'skipped_segment':
      return { kind: 'skipped_segment', phase: prompt.phase };

    case 'closing':
      return { kind: 'closing' };

    case 'completed':
      throw new Error('toOfficerTurnBody: a completed interview has no turn to say');
  }
}

/**
 * The code-owned line used in place of a model's acknowledgement (§9.2).
 *
 * Two cases, and the split exists to stop the officer saying the same sentence
 * twice in one turn:
 *
 *   * ENTERING a phase whose body is NOT itself a phase line — `n400` and
 *     `civics` — takes `fallbackOfficerLine`, the engine's own transition
 *     sentence ("I am now going to ask you the civics questions"), which then
 *     introduces the prompt or the question.
 *   * EVERYTHING ELSE takes the neutral `Thank you.` — including every turn
 *     within a phase (an officer who announced the civics section before each
 *     of ten questions would be absurd) and every skipped segment and closing,
 *     whose bodies ARE the phase lines and would otherwise be printed twice.
 *
 * Note what the neutral line does not do: reveal anything. `FALLBACK_OFFICER_LINES`'
 * own comment makes the point — a fallback that said "correct" would be a
 * verdict delivered by the wording layer, which is exactly the boundary §5 and
 * §10 draw.
 */
function fallbackAcknowledgement(
  answeredPhase: InterviewPhase,
  firstPrompt: InterviewPrompt | undefined,
  nextPhase: InterviewPhase,
): string {
  const introducesNewPhase =
    nextPhase !== answeredPhase &&
    (firstPrompt?.kind === 'n400' || firstPrompt?.kind === 'civics');

  return introducesNewPhase
    ? fallbackOfficerLine(nextPhase, false)
    : FALLBACK_OFFICER_LINES.acknowledgement;
}

// -----------------------------------------------------------------------------
// Wire shapes
// -----------------------------------------------------------------------------

/** Everything {@link InterviewsService.streamOfficerTurns} needs, in one object. */
interface OfficerStreamContext {
  userId: string;
  interview: { id: string };
  answeredPhase: InterviewPhase;
  applicantText: string;
  answerOutcome: OfficerAcknowledgedOutcome | null;
  prompts: InterviewPrompt[];
  state: EngineState;
  firstOfficerTurnIndex: number;
  signal?: AbortSignal;
}

/** Why the stream ended, before the terminal frame is built. */
type TerminalReason =
  | { kind: 'done' }
  | { kind: 'unavailable'; cause: AiUnavailableCause }
  | { kind: 'error'; errorCode: string; error: string };

/**
 * The grade, narrowed to the three values the officer's TONE may reflect, or
 * null for an ungraded phase.
 *
 * `partial` collapses to `incorrect` here and nowhere else — the attempt row
 * keeps whatever the ladder wrote. This is a tone input (`officer-prompt.ts`),
 * and there is no courteous acknowledgement that is pitched differently for a
 * partially-correct answer than for a wrong one; offering the distinction would
 * be offering the model one more thing it must not reveal.
 */
function toAcknowledgedOutcome(
  graded: GradedCivicsAnswer | null,
): OfficerAcknowledgedOutcome | null {
  if (!graded) return null;

  switch (graded.outcome) {
    case 'correct':
      return 'correct';
    case 'skipped':
      return 'skipped';
    default:
      return 'incorrect';
  }
}

/** How far through the civics section — pacing, never score. See the DTO. */
function progressOf(state: EngineState): InterviewProgress {
  return {
    civicsAsked: state.civicsAsked,
    civicsPlanned: state.passRule.questionsAsked,
  };
}

/** A `mock_interviews` row on the wire. */
function toInterviewResponse(row: any): InterviewResponse {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    testVersionCode: row.testVersionCode,
    seniorExemption: row.seniorExemption,
    transcriptRetained: row.transcriptRetained,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    civicsAsked: row.civicsAsked,
    civicsCorrect: row.civicsCorrect,
    passedCivics: row.passedCivics,
  };
}

/**
 * A `mock_interview_turns` row on the wire.
 *
 * `attemptId` is deliberately NOT exposed. It is the join to the graded
 * `practice_attempts` row, and publishing it would hand a client the id of the
 * one row that carries this turn's outcome — §10's rule is about what the
 * learner can see, and an id that resolves to a verdict through another route
 * is a verdict with an extra step.
 */
function toTurnRecord(row: any): InterviewTurnRecord {
  return {
    id: row.id,
    turnIndex: row.turnIndex,
    role: row.role,
    phase: row.phase,
    questionId: row.questionId ?? null,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The accepted-answer TEXTS out of a frozen `answer_snapshot`.
 *
 * Defensive about the JSON's shape because it is exactly that — JSON, on a
 * column whose contents were written by whatever version of this application
 * was running at the time. A debrief that threw on an old row would make an
 * interview from last year unreadable; an empty list says "no accepted answers
 * were recorded", which is the honest reading of a snapshot that carries none.
 */
function snapshotAnswerTexts(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object') return [];

  const answers = (snapshot as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return [];

  return answers
    .map((answer) => (answer as { text?: unknown })?.text)
    .filter((text): text is string => typeof text === 'string');
}
