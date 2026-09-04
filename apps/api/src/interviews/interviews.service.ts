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
import { isMisheardAttempt } from '../practice/mastery/mastery-skip';
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
  ENGLISH_SEGMENT_LINES,
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
  type SkippedPhase,
} from './engine';
import {
  assembleOfficerTurn,
  buildOfficerPrompt,
  OFFICER_MAX_TOKENS,
  OFFICER_TURN_SEPARATOR,
  type OfficerAcknowledgedOutcome,
  type OfficerTurnBody,
} from './officer-prompt';
import { buildInterviewDebrief, type DebriefAttempt } from './debrief';
import {
  buildRealtimeOfficerInstructions,
  realtimePhaseLabel,
} from './realtime/realtime-instructions';
import {
  decideEndPhase,
  decideGradeAnswer,
  decideNextQuestion,
  type OutstandingItem,
  type RealtimeRejection,
  type RealtimeToolCall,
  type RealtimeToolName,
  type RealtimeTurnContext,
} from './realtime/realtime-tool-calls';
import {
  INTERVIEW_REALTIME_TOOLS,
  REALTIME_SESSION_TTL_SECONDS,
} from './realtime/realtime-tools';
import type { CreateInterviewInput } from './dto/create-interview.dto';
import { EnglishService } from '../english/english.service';
import type { RealtimeSessionResponse } from './dto/interview-realtime-session.dto';
import type { RealtimeToolCallResponse } from './dto/interview-tool-call.dto';
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

/**
 * The role the realtime transport spends the learner's key on (#157, E11).
 *
 * `satisfies` RATHER THAN AN ANNOTATION, unlike {@link TUTOR_ROLE} above, and
 * the difference is load-bearing: this string is also the `role` field of the
 * mint response, which `interview-realtime-session.dto.ts` publishes as a
 * LITERAL so a client can match it against `GET /api/ai/status`'s
 * `unboundRoles`. Annotating it `AiModelRole` would widen it to the union and
 * that match would stop compiling; `satisfies` keeps the literal type AND
 * still fails this file's build if the registry ever stops declaring the key.
 */
const REALTIME_ROLE = 'realtime' satisfies AiModelRole;

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
  /**
   * The recogniser's own confidence, or `null` when there was no recogniser.
   *
   * `null` on every text turn — `interview-turn.dto.ts` has no field that could
   * carry one — and set only on a realtime civics turn, from `grade_answer`'s
   * `confidence` argument (`realtime-tools.ts`). It is written to the attempt
   * row AND handed to the mastery skip rule; those are two different
   * consumers of one measurement, which is why it is carried rather than
   * collapsed into {@link GradedCivicsAnswer.misheard} alone.
   */
  asrConfidence: number | null;
  /**
   * Whether the recogniser's own uncertainty is the better explanation of this
   * miss (`isMisheardAttempt`, `practice/mastery/mastery-skip.ts`).
   *
   * Decided SERVER-SIDE, after grading, from the confidence and the outcome —
   * never from anything the model reported about the answer. It overrides any
   * `failureCause` the AI grader supplied, exactly as it does on the practice
   * path, and it leaves `outcome` untouched: the transcript genuinely did not
   * match, and saying otherwise would make a wrong answer count as right.
   */
  misheard: boolean;
  answeredAt: Date;
}

/**
 * How one turn reached this service — the two `practice_attempts` columns that
 * record it, and nothing else.
 *
 * A NAMED PAIR RATHER THAN A `mode` FLAG, because these are the two columns
 * that actually get written and a reader of the attempt row sees exactly them.
 * `mock_interviews.mode` is the coarse, one-way summary one layer up (§3); this
 * is the live, per-turn truth §6 says the summary sits on top of.
 */
interface TurnTransport {
  inputMode: 'typed' | 'spoken';
  promptMode: 'read' | 'heard';
}

/**
 * The text transport's transport (issue #133, E8).
 *
 * Written out explicitly rather than defaulted at the call site: a turn that
 * did not record how the answer was given and how the prompt was delivered has
 * lost both facts permanently — nothing on the server can reconstruct either
 * afterwards.
 */
const TYPED_TURN: TurnTransport = { inputMode: 'typed', promptMode: 'read' };

/**
 * The realtime transport's transport (issue #158, E11, §6).
 *
 * `spoken` because the applicant said it and `heard` because the officer spoke
 * the question rather than displaying it. Both are exactly what
 * `readiness-model.md` §2.7's `spoken` component counts, which is the mechanism
 * by which a voice interview weighs more than a typed one (§8) — with no new
 * readiness code at all.
 */
const SPOKEN_TURN: TurnTransport = { inputMode: 'spoken', promptMode: 'heard' };

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
    // THE E10 SEGMENTS, CONDUCTED FOR REAL ON THE REALTIME TRANSPORT (#158,
    // §5). `EnglishService` is what `/practice/reading` and `/practice/writing`
    // already post to; a realtime interview is one more caller of it, the same
    // relationship it has to `AttemptGradingService` for civics. A second
    // reading scorer would drift on the misheard gate, on which sentence comes
    // next, and on the word-error-rate rule itself — and a learner would be
    // scored differently depending on which screen they were looking at.
    private readonly english: EnglishService,
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
        ? await this.gradeCivicsAnswer(
            userId,
            interview,
            prompt.questionId,
            input.text,
          )
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
  // The realtime transport (issue #157, epic #60 / E11)
  // ---------------------------------------------------------------------------

  /**
   * Mint one ephemeral realtime session credential for this interview.
   *
   * `docs/specs/realtime-interview.md` §3 in full. What comes back is a
   * short-lived secret the LEARNER'S OWN BROWSER uses to open a realtime
   * connection directly to the provider; this application is not in that
   * connection's data path at all, which is why §13 rejected proxying the audio
   * and why nothing about the recording ever reaches this process.
   *
   * ---------------------------------------------------------------------------
   * THE SAME 404, THE SAME 409, THROUGH THE SAME TWO CHECKS AS A TURN
   * ---------------------------------------------------------------------------
   *
   * {@link requireInterview} filters on `userId` in the `where`, so another
   * learner's interview is a **404, not a 403** here exactly as it is
   * everywhere else on this service — a mint route is not a place to start
   * confirming that an id names a real interview belonging to somebody.
   *
   * A completed or abandoned interview mints nothing, and neither does one the
   * engine says has no turn left to take: a realtime session exists to conduct
   * the rest of an interview, and there is no rest of it. Both are the 409
   * `submitTurn` already raises for the identical states, in the identical
   * shape — the request is well-formed, the interview's own state refuses it.
   * Minting anyway would spend the learner's key on a session whose first
   * `next_question` call could only be rejected.
   *
   * ---------------------------------------------------------------------------
   * THE SESSION IS BUILT SERVER-SIDE, FROM THIS INTERVIEW
   * ---------------------------------------------------------------------------
   *
   * The instructions and the tool schemas are this application's, assembled
   * here (`realtime/`), and the request carries no client-supplied field at
   * all — there is no body on this route. The prompt is grounded in the
   * engine's own current phase and in nothing else: no question, no accepted
   * answer, no pass mark and no question count reaches the model, for the
   * reasons `realtime-instructions.ts` sets out one by one.
   *
   * ---------------------------------------------------------------------------
   * NOTHING ABOUT THE SECRET IS LOGGED
   * ---------------------------------------------------------------------------
   *
   * The log line below carries the user, the interview, the model and the
   * status — the same fields every other line in this file carries. The secret
   * is a bearer credential for the minutes it is valid, and a log aggregator
   * retains far longer than that; `AiRealtimeSessionResult`'s own header makes
   * the same argument for spans. No `audit_events` row is written either,
   * matching `voice.md` §9's posture toward the speech routes: this is an
   * ordinary, per-user, no-permission action a learner takes on their own
   * interview, not an administrative one.
   */
  async createRealtimeSession(
    userId: string,
    interviewId: string,
  ): Promise<RealtimeSessionResponse> {
    const interview = await this.requireInterview(userId, interviewId);

    if (interview.status !== 'in_progress') {
      throw new ConflictException(
        `Interview "${interviewId}" is ${interview.status} and accepts no further turns`,
      );
    }

    const state = await this.rebuildState(interview);

    if (nextPrompt(state).kind === 'completed') {
      throw new ConflictException(
        `Interview "${interviewId}" has no further turns; complete it to see the debrief`,
      );
    }

    const minted = await this.dispatch.createRealtimeSession(userId, {
      instructions: buildRealtimeOfficerInstructions({ phase: state.phase }),
      tools: INTERVIEW_REALTIME_TOOLS,
      expiresInSeconds: REALTIME_SESSION_TTL_SECONDS,
    });

    if (minted.status !== 'ok') {
      this.logger.warn(
        {
          userId,
          interviewId,
          status: minted.status,
          // One of the four causes, or a stable provider code. Both are
          // GROUP-able; neither is a message and neither is a credential.
          reason: minted.status === 'unavailable' ? minted.cause : minted.errorCode,
        },
        'Realtime interview session could not be minted',
      );

      return minted.status === 'unavailable'
        ? { status: 'unavailable', cause: minted.cause, role: REALTIME_ROLE }
        : {
            status: 'failed',
            errorCode: minted.errorCode,
            error: minted.error,
          };
    }

    // MODE IS FLIPPED HERE, ON THE FIRST SUCCESSFUL MINT, AND ONLY HERE (§3).
    // `create-interview.dto.ts`'s `ForbiddenCreateInterviewFieldNames` already
    // forbids a client from naming `mode` on `POST /api/interviews`, and this
    // epic adds no exception to it: a `mock_interviews` row moves from `text`
    // to `voice` through this server-side write or not at all.
    //
    // It is a ONE-WAY, COARSE SUMMARY — "was this interview ever conducted by
    // voice" — and it is deliberately not reverted when a session later falls
    // back to text (§7). The live, per-turn truth lives one layer down on
    // `practice_attempts.input_mode`/`prompt_mode`, the same relationship
    // `civicsAsked`/`civicsCorrect` already have to the rows they summarise.
    //
    // Guarded on the current value so a re-mint mid-interview — §3's ordinary
    // case, not an edge one — is not a second write of a value that is already
    // there.
    if (interview.mode !== 'voice') {
      await this.prisma.mockInterview.update({
        where: { id: interview.id },
        data: { mode: 'voice' },
      });
    }

    this.logger.log(
      {
        userId,
        interviewId,
        phase: state.phase,
        modelId: minted.modelId,
        // NOT THE SECRET, and not its length either — see the doc comment.
        expiresAt: minted.expiresAt.toISOString(),
      },
      'Realtime interview session minted',
    );

    return {
      status: 'ok',
      clientSecret: minted.clientSecret,
      // The PROVIDER's own expiry, serialised. Never recomputed from the TTL
      // this application asked for.
      expiresAt: minted.expiresAt.toISOString(),
      modelId: minted.modelId,
    };
  }

  // ---------------------------------------------------------------------------
  // The realtime tool contract (issue #158, epic #60 / E11)
  // ---------------------------------------------------------------------------

  /**
   * Handle one tool call from a realtime session.
   *
   * `docs/specs/realtime-interview.md` §4 is the contract and
   * `realtime/realtime-tool-calls.ts` is its rules, as pure functions over the
   * engine's state. This method is the half that touches a database: it
   * assembles the context those rules read, obeys their answer, and — when a
   * call is honoured — writes the evidence §6 requires.
   *
   * ---------------------------------------------------------------------------
   * ONE ROUTE FOR THREE TOOLS, AND WHY
   * ---------------------------------------------------------------------------
   *
   * §4 does not prescribe an HTTP shape (it describes the tool calls as
   * "an ordinary function invocation"), so this is a choice, and it is written
   * down rather than left to be inferred:
   *
   *   * **The browser is a relay, not a participant.** It forwards whatever
   *     tool call the model emitted and hands the result back over the same
   *     data channel. One endpoint taking a discriminated `tool` field means
   *     the relay needs no per-tool knowledge at all and cannot route a call to
   *     the wrong handler — three routes would put a mapping in the client, and
   *     a client-side mapping is a place the model's intent can be changed
   *     between the model and the engine.
   *   * **All three refusals are answers to the same question** — what does the
   *     interview's own state permit right now — and all three read the same
   *     rebuilt state and the same outstanding item. Three handlers would be
   *     three places to get "is an answer still outstanding" right.
   *   * **One `requireInterview` call.** Another learner's interview is a 404
   *     structurally, at one query, exactly as it is for every other route on
   *     this service.
   *
   * ---------------------------------------------------------------------------
   * A REJECTION IS A 200. A 404 AND A 409 ARE STILL EXCEPTIONS.
   * ---------------------------------------------------------------------------
   *
   * A rejected tool call is an ordinary, expected outcome of the contract — the
   * model asked for something the engine does not permit and must be told to
   * carry on — so it comes back as a typed `status: 'rejected'` body the relay
   * hands to the model verbatim. A non-2xx would be flattened into generic
   * failure handling by the relay, and the `instruction` field, which is the
   * one thing that gets the interview moving again, would never reach the
   * model. This is the posture `POST /api/interviews/:id/realtime-session` and
   * `POST /api/ai/speech/*` already take, for the same reason.
   *
   * An unknown interview id stays a 404 and an interview that is not this
   * caller's stays a 404: those are facts about the INTERVIEW, not about the
   * contract, and there is no model-facing recovery from either.
   *
   * ---------------------------------------------------------------------------
   * DRIVABLE BY A SCRIPTED LIST OF TOOL CALLS, WITH NO AUDIO AND NO NETWORK
   * ---------------------------------------------------------------------------
   *
   * Nothing on this path touches audio — a realtime connection is
   * browser-to-provider and this process is not in its data path (§3, §6) — and
   * the only AI call it can make is the grading ladder's rung 2, which degrades
   * to the deterministic verdict when no model is configured
   * (`ai-evaluation.md` §6 rung 3). So the whole contract is exercisable by
   * calling this method with a list of `RealtimeToolCall` values, which is what
   * issue #161's scripted-sequence suite is built on and what
   * `interviews.service.spec.ts` already does below.
   */
  async handleRealtimeToolCall(
    userId: string,
    interviewId: string,
    call: RealtimeToolCall,
  ): Promise<RealtimeToolCallResponse> {
    const interview = await this.requireInterview(userId, interviewId);
    const state = await this.rebuildState(interview);
    const ctx = await this.realtimeContext(userId, interview, state);

    switch (call.tool) {
      case 'next_question':
        return this.realtimeNextQuestion(userId, interview, ctx);
      case 'grade_answer':
        return this.realtimeGradeAnswer(userId, interview, ctx, call);
      case 'end_phase':
        return this.realtimeEndPhase(userId, interview, ctx, call);
    }
  }

  /**
   * What the tool rules read: the interview's status, the engine's state, and
   * what the officer has asked that nobody has answered.
   *
   * ---------------------------------------------------------------------------
   * "OUTSTANDING" IS DERIVED, NEVER STORED
   * ---------------------------------------------------------------------------
   *
   * There is no `awaiting_answer` column and there must not be, for the reason
   * {@link InterviewsService.rebuildState} gives for there being no `phase`
   * column: a stored flag is a second account of a fact the transcript already
   * carries, able to disagree with it. The fact is "the last turn is an officer
   * turn, in the phase the engine is still in" — the officer has spoken and the
   * applicant has not.
   *
   * WHICH item is outstanding is derived too, and differently for the two kinds:
   *
   *   * A civics question comes from the ENGINE (`nextPrompt`), not from the
   *     turn row, because `civicsPlan[civicsAsked]` is what §4.2's rejection
   *     rule is written against and the engine is its author.
   *   * A reading or writing sentence comes from `EnglishService.getNext`,
   *     re-derived rather than remembered. That is sound precisely because
   *     `sentence-selection.ts` is DETERMINISTIC and deliberately so ("no
   *     randomness anywhere", its own header) and because no
   *     `english_attempts` row is written until the answer is graded — so
   *     asking twice before an answer arrives returns the same sentence both
   *     times. It also means `mock_interview_turns` needs no new column, which
   *     §6 requires ("Realtime adds no new columns"): `questionId` there is a
   *     foreign key into `civics_questions` and could never have held a
   *     sentence id anyway.
   */
  private async realtimeContext(
    userId: string,
    interview: { id: string; status: string },
    state: EngineState,
  ): Promise<RealtimeTurnContext> {
    const base = {
      interviewStatus: interview.status,
      state,
      outstanding: null,
      ungradedTurnPending: false,
    } satisfies RealtimeTurnContext;

    if (interview.status !== 'in_progress' || state.completed) return base;

    const last = await this.prisma.mockInterviewTurn.findFirst({
      where: { mockInterviewId: interview.id },
      orderBy: { turnIndex: 'desc' },
      select: { role: true, phase: true },
    });

    // The officer has spoken in the phase the engine is still in, and no
    // applicant turn has followed. Anything else — an applicant turn last, or
    // an officer turn in a phase the engine has already left — means nothing is
    // outstanding.
    const spokenAndUnanswered =
      last?.role === 'officer' && last.phase === state.phase;

    if (!spokenAndUnanswered) return base;

    if (state.phase === 'civics') {
      const prompt = nextPrompt(state);
      return prompt.kind === 'civics'
        ? { ...base, outstanding: { kind: 'civics', questionId: prompt.questionId } }
        : base;
    }

    if (state.phase === 'reading' || state.phase === 'writing') {
      const { sentence } = await this.english.getNext(userId, state.phase);

      // No sentence means the segment was never conducted — the officer turn
      // above was the honest "this rehearsal does not include that test" line,
      // which consumes no answer. Nothing is outstanding.
      return sentence === null
        ? base
        : {
            ...base,
            outstanding: {
              kind: 'english',
              segment: state.phase,
              sentenceId: sentence.id,
            },
          };
    }

    // Small talk and the application review: a real turn the applicant answers
    // aloud, that nothing scores. See `RealtimeTurnContext.ungradedTurnPending`
    // for why it is consumed by the next `next_question` rather than by a tool
    // of its own.
    return { ...base, ungradedTurnPending: true };
  }

  /**
   * `next_question` — the officer's next line, assembled server-side.
   *
   * ---------------------------------------------------------------------------
   * THE MODEL NEVER AUTHORS A WORD OF WHAT COMES BACK
   * ---------------------------------------------------------------------------
   *
   * Every branch below produces either a code-owned line from
   * `engine/officer-lines.ts` or a string read verbatim out of the database —
   * `civics_questions.prompt`, `english_sentences.text` — concatenated by
   * {@link assembleOfficerTurn}, the same function the text transport's officer
   * turns go through. §4.1's "the question text is never a field the tool's
   * return schema gives it room to author" is that: there is no input to this
   * method through which the model could propose a question, and the tool it
   * called takes no arguments at all.
   *
   * ---------------------------------------------------------------------------
   * THE OPENING TURN IS NOT THIS ROUTE'S, AND THAT IS DELIBERATE
   * ---------------------------------------------------------------------------
   *
   * `POST /api/interviews` already writes the officer's greeting and small-talk
   * opener and RETURNS them in its own response, before any realtime session is
   * minted. A client therefore has the opening line in hand and hands it to the
   * model to speak; this route serves every turn after it. Re-serving it here
   * would write the greeting into the transcript twice, and the second copy
   * would be indistinguishable from the officer greeting the applicant again
   * mid-interview.
   */
  private async realtimeNextQuestion(
    userId: string,
    interview: InterviewRow,
    ctx: RealtimeTurnContext,
  ): Promise<RealtimeToolCallResponse> {
    const decision = decideNextQuestion(ctx);

    if (decision.status === 'rejected') {
      return this.rejectRealtimeToolCall('next_question', userId, interview.id, decision);
    }

    let current = ctx.state;
    let turnIndex = await this.nextTurnIndex(interview.id);

    if (decision.consumeUngradedTurn) {
      // The applicant answered an ungraded prompt aloud. The turn happened, so
      // it is written; nothing scored it, so it carries no attempt and its text
      // is empty — there is no tool through which the words could have reached
      // this application. See `RealtimeTurnContext.ungradedTurnPending`.
      const answered = applyAnswer(current, {
        phase: current.phase,
        correct: false,
      });

      await this.recordApplicantTurn(
        userId,
        interview,
        current.phase,
        turnIndex,
        '',
        null,
        answered,
        SPOKEN_TURN,
      );

      current = answered;
      turnIndex += 1;
    }

    const lines = await this.resolveRealtimeOfficerLines(userId, current, turnIndex);

    if (lines.spoken.length === 0) {
      // The engine ran out of turns while this call was being served — only
      // reachable if the ungraded turn above completed the interview.
      return this.rejectRealtimeToolCall('next_question', userId, interview.id, {
        status: 'rejected',
        reason: 'interview_complete',
        error: 'There is nothing further to ask; the interview is over.',
        instruction: 'Say a brief closing line and end the session.',
      });
    }

    const written = await this.writeRealtimeOfficerTurns(interview, lines.turns, turnIndex);

    return {
      tool: 'next_question',
      status: 'ok',
      text: lines.spoken.join(OFFICER_TURN_SEPARATOR),
      // TRUE ONLY FOR THE WRITING SENTENCE (§5). Say it; never render it.
      speakOnly: lines.speakOnly,
      itemId: lines.itemId,
      phase: lines.state.phase,
      turnIndex: written,
      progress: progressOf(lines.state),
      awaitingCompletion: lines.state.completed,
    };
  }

  /**
   * `grade_answer` — what the model heard, put through the engine's own ladder.
   *
   * ---------------------------------------------------------------------------
   * ANY VERDICT THE MODEL IMPLIED IS DISCARDED, AND NONE IS RETURNED
   * ---------------------------------------------------------------------------
   *
   * §4.2's load-bearing rule, in both directions. The call carries no verdict
   * field — `realtime-tools.ts` and `interview-tool-call.dto.ts` each hold a
   * compile-time proof of that, and the request schema is strict, so a model
   * that volunteers one gets a 400 rather than an ignored extra. And nothing
   * about the outcome comes back: the result is an acknowledgement to speak,
   * and `realtime-tool-calls.ts`' `END_PHASE_DECLARES_NO_VERDICT` is the
   * matching proof for the other side.
   *
   * The transcript is graded by `AttemptGradingService` — the same injectable a
   * typed practice answer goes through — for a civics question, and by
   * `EnglishService` — the same service `/practice/reading` posts to — for a
   * reading or writing sentence. There is no third grader in this codebase and
   * this method does not become one.
   *
   * ---------------------------------------------------------------------------
   * A MISHEARD READING ATTEMPT WRITES NOTHING AND DOES NOT ADVANCE
   * ---------------------------------------------------------------------------
   *
   * `english-test.md` §3's rule, inherited exactly: a reading attempt records
   * whether the learner produced an exact sequence of words, computed over the
   * transcript itself, so a transcript we do not believe is not weak evidence
   * of a reading skill — it is none. `EnglishService.recordAttempt` returns
   * `status: 'misheard'` and writes no row, and this method leaves the segment
   * outstanding so the officer can ask for it again. That is the one place this
   * transport's two graded item kinds genuinely differ: a misheard CIVICS
   * answer IS recorded, with `failure_cause: 'misheard'`, because it is still
   * evidence an attempt happened.
   */
  private async realtimeGradeAnswer(
    userId: string,
    interview: InterviewRow,
    ctx: RealtimeTurnContext,
    call: Extract<RealtimeToolCall, { tool: 'grade_answer' }>,
  ): Promise<RealtimeToolCallResponse> {
    const decision = decideGradeAnswer(ctx, call);

    if (decision.status === 'rejected') {
      return this.rejectRealtimeToolCall('grade_answer', userId, interview.id, decision, {
        // WHAT WAS NAMED, NEVER WHAT WAS SAID. An id is a join key; the
        // transcript is a person's words, and a rejected call is not a reason
        // to put them in a log line retention never governs.
        namedItemId: call.questionId,
      });
    }

    const confidence = call.confidence ?? null;

    return decision.item.kind === 'civics'
      ? this.realtimeGradeCivics(userId, interview, ctx.state, decision.item, call, confidence)
      : this.realtimeGradeEnglish(userId, interview, ctx.state, decision.item, call, confidence);
  }

  /** One realtime civics answer: the ladder, the attempt row, the turn. */
  private async realtimeGradeCivics(
    userId: string,
    interview: InterviewRow,
    state: EngineState,
    item: Extract<OutstandingItem, { kind: 'civics' }>,
    call: Extract<RealtimeToolCall, { tool: 'grade_answer' }>,
    confidence: number | null,
  ): Promise<RealtimeToolCallResponse> {
    const graded = await this.gradeCivicsAnswer(
      userId,
      interview,
      item.questionId,
      call.transcript,
      confidence,
    );

    const answered = applyAnswer(state, {
      phase: 'civics',
      correct: graded.outcome === 'correct',
    });

    const turnIndex = await this.nextTurnIndex(interview.id);

    await this.recordApplicantTurn(
      userId,
      interview,
      'civics',
      turnIndex,
      call.transcript,
      graded,
      answered,
      // §6: `input_mode: 'spoken'`, `prompt_mode: 'heard'`. This is the whole
      // of §8's "a voice interview weighs more than a typed one" — the
      // readiness engine's `spoken` component already counts exactly this.
      SPOKEN_TURN,
    );

    await this.accrueActivity(userId, interview.id, () =>
      this.engagement.recordInterviewAttemptActivity(userId, {
        mockInterviewId: interview.id,
        answeredAt: graded.answeredAt,
        outcome: graded.outcome,
      }),
    );

    return {
      tool: 'grade_answer',
      status: 'ok',
      // NEUTRAL, AND THE SAME SENTENCE WHATEVER THE OUTCOME WAS. §10: the real
      // event gives no per-question feedback, so a rehearsal that does is
      // coaching the applicant to expect reassurance the actual interview will
      // never provide.
      ack: FALLBACK_OFFICER_LINES.acknowledgement,
      recorded: true,
      phase: answered.phase,
      turnIndex,
      progress: progressOf(answered),
      awaitingCompletion: answered.completed,
    };
  }

  /** One realtime reading or writing answer: the E10 scorer, and its own table. */
  private async realtimeGradeEnglish(
    userId: string,
    interview: InterviewRow,
    state: EngineState,
    item: Extract<OutstandingItem, { kind: 'english' }>,
    call: Extract<RealtimeToolCall, { tool: 'grade_answer' }>,
    confidence: number | null,
  ): Promise<RealtimeToolCallResponse> {
    // THE E10 SERVICE, NOT A SECOND SCORER. `EnglishService.recordAttempt` is
    // what `/practice/reading` and `/practice/writing` post to, and a realtime
    // interview is one more caller of it — the same relationship the interview
    // has to `AttemptGradingService` for civics (§6, and `mock-interview.md`
    // §6's "one shared injectable so there is only one ladder in the
    // codebase").
    const result = await this.english.recordAttempt(userId, {
      sentenceId: item.sentenceId,
      responseText: call.transcript,
      // A CONFIDENCE ONLY ON READING. Writing is typed even in a spoken
      // interview — the learner types into an ordinary input while the audio
      // connection carries the conversation — and `EnglishService` rejects a
      // confidence on a writing attempt outright, because a low value there
      // would suppress the row entirely and attribute it to a recognition step
      // that never ran.
      ...(item.segment === 'reading' && confidence !== null
        ? { asrConfidence: confidence }
        : {}),
      // NO REPLAY COUNTER ON THIS TRANSPORT. `english_attempts.replay_count`
      // counts presses of a replay button; a realtime officer repeats a
      // sentence by being asked to, in conversation, and nothing observes that.
      // `0` is the honest value for "not measured here", and it is also the
      // value the column's own comment requires on a reading row.
      replayCount: 0,
    });

    if (result.status === 'misheard') {
      // NO ROW, NO ADVANCE, AND THE SEGMENT STAYS OUTSTANDING. See this
      // method's sibling's doc comment; `english-test.md` §3 is the argument.
      return {
        tool: 'grade_answer',
        status: 'ok',
        ack: ENGLISH_RETRY_ACK[item.segment],
        recorded: false,
        phase: state.phase,
        turnIndex: (await this.nextTurnIndex(interview.id)) - 1,
        progress: progressOf(state),
        awaitingCompletion: false,
      };
    }

    const answered = applyAnswer(state, { phase: item.segment, correct: false });
    const turnIndex = await this.nextTurnIndex(interview.id);

    await this.recordApplicantTurn(
      userId,
      interview,
      item.segment,
      turnIndex,
      call.transcript,
      // NO `practice_attempts` ROW. §5: "never a `practice_attempts` row,
      // because reading and writing evidence has always lived in its own
      // table". The turn still records that the applicant answered, in this
      // phase, in this order — the structure survives even when the words do
      // not.
      null,
      answered,
      SPOKEN_TURN,
    );

    return {
      tool: 'grade_answer',
      status: 'ok',
      ack: FALLBACK_OFFICER_LINES.acknowledgement,
      recorded: true,
      phase: answered.phase,
      turnIndex,
      progress: progressOf(answered),
      awaitingCompletion: answered.completed,
    };
  }

  /**
   * `end_phase` — honoured only when the engine's own stop rule agrees (§4.3).
   *
   * The decision is `decideEndPhase`'s and reads no number; this method only
   * turns it into words. Note that an honoured call writes NOTHING: the engine
   * has already left the phase, of its own accord, at the moment the rule
   * fired. `end_phase` is the model asking to be told where it now is, and the
   * value of the tool is entirely in the rejection — a phase the model could
   * end early is a pass mark the model could reach early.
   */
  private async realtimeEndPhase(
    userId: string,
    interview: InterviewRow,
    ctx: RealtimeTurnContext,
    call: Extract<RealtimeToolCall, { tool: 'end_phase' }>,
  ): Promise<RealtimeToolCallResponse> {
    const decision = decideEndPhase(ctx, call);

    if (decision.status === 'rejected') {
      return this.rejectRealtimeToolCall('end_phase', userId, interview.id, decision, {
        namedPhase: call.phase,
      });
    }

    return {
      tool: 'end_phase',
      status: 'ok',
      nextPhase: decision.nextPhase,
      // CONTEXT, NEVER A SUMMARY OF HOW IT WENT. The phase label the session's
      // own instructions already use, so the model is told where it is in the
      // same words it was told at the start.
      context: decision.completed
        ? 'The interview is over. Say a brief closing line and end the session.'
        : `The interview is now in the ${realtimePhaseLabel(decision.nextPhase)} part. Call next_question.`,
      awaitingCompletion: decision.completed,
    };
  }

  /**
   * Record a refused tool call, and hand the model its recovery.
   *
   * **RECORDED, which §4.2 asks for by name** — "A rejected call returns an
   * error result" and the model is told to move on, but a call that named a
   * question the engine did not ask is the exact symptom of a model drifting
   * out of the contract, and an interview where that happened silently is an
   * interview nobody can explain afterwards.
   *
   * It is a LOG LINE and not an `audit_events` row, matching the mint's own
   * posture (§3, `voice.md` §9): `audit_events` exists for privileged and
   * administrative actions, and a model calling a tool out of order inside a
   * learner's own rehearsal is neither. It is not a `mock_interview_turns` row
   * either — nothing was said and nobody answered, so there is no turn.
   *
   * The learner's transcript is never in it. `context` carries ids and enum
   * values; the words a person spoke are governed by retention and a log
   * aggregator honours no retention flag.
   */
  private rejectRealtimeToolCall(
    tool: RealtimeToolName,
    userId: string,
    interviewId: string,
    rejection: RealtimeRejection,
    context: Record<string, string> = {},
  ): RealtimeToolCallResponse {
    this.logger.warn(
      { userId, interviewId, tool, reason: rejection.reason, ...context },
      'Realtime interview tool call rejected',
    );

    return { tool, ...rejection };
  }

  /**
   * The officer's line(s) for one `next_question`, and the state they leave
   * behind.
   *
   * A LOOP, not a single prompt, for the same reason `runOfficer` collects
   * several: a phase that consumes no applicant answer is walked through in
   * the same call. On this transport that is at most the two skipped segments
   * and the closing — a conducted segment stops the walk exactly as a civics
   * question does.
   *
   * Every string it produces is either code-owned copy or a verbatim database
   * read, concatenated by {@link assembleOfficerTurn}. Nothing a model wrote
   * reaches it.
   */
  private async resolveRealtimeOfficerLines(
    userId: string,
    state: EngineState,
    firstTurnIndex: number,
  ): Promise<RealtimeOfficerLines> {
    const spoken: string[] = [];
    const turns: RealtimeTurnDraft[] = [];
    const enteredPhase = state.phase;

    let speakOnly = false;
    let itemId: string | null = null;
    let current = state;

    for (;;) {
      let prompt: InterviewPrompt;

      try {
        prompt = nextPrompt(current);
      } catch (error) {
        // The engine's one documented throw: the civics phase with no question
        // left and the stop rule bypassed, which its own comment calls "a
        // programming error rather than an interview outcome". Logged as the
        // fault it is; the caller turns an empty result into a refusal rather
        // than a 500 in the middle of a spoken rehearsal.
        this.logger.error(
          { userId, phase: current.phase, err: error },
          'Realtime interview engine refused to serve a prompt',
        );
        break;
      }

      if (prompt.kind === 'completed') break;

      // THE PHASE TRANSITION LINE, ON THE FIRST LINE OF THIS CALL ONLY.
      // `fallbackOfficerLine` is a reader over the engine's own line table, so
      // "I am now going to ask you the civics questions" is code-owned copy;
      // the model adds its own acknowledgement conversationally, which is the
      // one thing it is for on this transport.
      const opener =
        turns.length === 0 &&
        current.phase !== enteredPhase &&
        (prompt.kind === 'n400' || prompt.kind === 'civics')
          ? fallbackOfficerLine(current.phase, false)
          : null;

      if (prompt.kind === 'civics') {
        const question = await this.prisma.civicsQuestion.findUnique({
          where: { id: prompt.questionId },
          select: { prompt: true },
        });

        const text = assembleOfficerTurn(opener, {
          kind: 'civics',
          // VERBATIM FROM `civics_questions`. §4.1's whole mechanism: the model
          // is handed a finished string to say, and has no field it could have
          // proposed one in.
          questionPrompt: question?.prompt ?? '',
        });

        spoken.push(text);
        turns.push({ phase: 'civics', questionId: prompt.questionId, text });
        itemId = prompt.questionId;
        break;
      }

      if (prompt.kind === 'smalltalk' || prompt.kind === 'n400') {
        const text = assembleOfficerTurn(
          opener,
          toOfficerTurnBody(prompt, EMPTY_PROMPTS, firstTurnIndex + turns.length === 0),
        );

        spoken.push(text);
        turns.push({ phase: prompt.kind, questionId: null, text });
        break;
      }

      if (prompt.kind === 'skipped_segment') {
        const { sentence } = await this.english.getNext(userId, prompt.phase);

        if (sentence !== null) {
          const intro = ENGLISH_SEGMENT_LINES[prompt.phase];
          const said = `${intro}${OFFICER_TURN_SEPARATOR}${sentence.text}`;

          spoken.push(said);
          turns.push({
            phase: prompt.phase,
            questionId: null,
            // ------------------------------------------------------------
            // THE WRITING SENTENCE IS NEVER WRITTEN INTO THE TRANSCRIPT
            // ------------------------------------------------------------
            //
            // §5's "dictated and never shown" rule, held where it cannot be
            // undone by a client: `GET /api/interviews/:id` returns every turn
            // of a LIVE interview, so a writing sentence stored here would be
            // readable by the learner before they had written it — the reveal,
            // delivered by the transcript route. The turn still records that
            // the officer dictated a sentence, in this phase, in this order;
            // only the sentence itself is absent, which is exactly the shape
            // retention already gives an applicant turn.
            //
            // A reading sentence IS stored: the learner is looking at it.
            text: prompt.phase === 'reading' ? said : intro,
          });

          speakOnly = prompt.phase === 'writing';
          itemId = sentence.id;
          break;
        }

        // NO SENTENCE IN THE BANK. The segment is skipped, with the same honest
        // line the text transport uses — a rehearsal with no content for a test
        // genuinely does not include that test — and the walk continues.
        const text = assembleOfficerTurn(null, {
          kind: 'skipped_segment',
          phase: prompt.phase,
        });

        spoken.push(text);
        turns.push({ phase: prompt.phase, questionId: null, text });
        current = applyAnswer(current, { phase: current.phase, correct: false });
        continue;
      }

      // `closing` — said, then walked past. It consumes no applicant answer,
      // exactly as it does on the text transport.
      const text = assembleOfficerTurn(null, { kind: 'closing' });
      spoken.push(text);
      turns.push({ phase: 'closing', questionId: null, text });
      current = applyAnswer(current, { phase: current.phase, correct: false });
    }

    return { spoken, turns, speakOnly, itemId, state: current };
  }

  /**
   * Write one `next_question`'s officer turns and return the last turn index.
   *
   * A sibling of {@link InterviewsService.writeOfficerTurns} rather than a
   * reuse of it, and the difference is one field: the text is already
   * assembled here, because a conducted segment's line has no
   * `OfficerTurnBody` variant and adding one would put the writing sentence
   * into `officer-prompt.ts`, whose whole job is building the string a learner
   * READS.
   */
  private async writeRealtimeOfficerTurns(
    interview: { id: string },
    drafts: readonly RealtimeTurnDraft[],
    firstTurnIndex: number,
  ): Promise<number> {
    for (const [offset, draft] of drafts.entries()) {
      await this.prisma.mockInterviewTurn.create({
        data: {
          mockInterviewId: interview.id,
          turnIndex: firstTurnIndex + offset,
          role: 'officer',
          phase: draft.phase,
          questionId: draft.questionId,
          text: draft.text,
        },
      });
    }

    return firstTurnIndex + drafts.length - 1;
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
    /**
     * How this turn reached us. Defaulted to the text transport so E8's own
     * call sites read exactly as they did; the realtime handler passes
     * {@link SPOKEN_TURN} (§6).
     */
    transport: TurnTransport = TYPED_TURN,
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
            // FROM THE TRANSPORT, no longer hardcoded (issue #158, E11 §6).
            // Nothing on the server can reconstruct either after the fact —
            // on the realtime transport the audio never reaches this process
            // at all — so a row that did not record how the answer was given
            // and how the prompt was delivered has lost both facts
            // permanently. `spoken`/`heard` here is also exactly what
            // `readiness-model.md` §2.7's `spoken` component counts, which is
            // the whole of §8's "a voice interview weighs more than a typed
            // one" — no readiness code changes for it.
            inputMode: transport.inputMode,
            promptMode: transport.promptMode,
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
            // ---------------------------------------------------------------
            // THE `misheard` OVERRIDE, DELIBERATELY SPREAD LAST (issue #158)
            // ---------------------------------------------------------------
            //
            // Character for character the rule `PracticeService.recordAttempt`
            // applies, in the same position and for the same reason: it
            // overwrites whatever cause the grader supplied, and the ORDER of
            // these spreads is the whole mechanism — reversing them would
            // silently restore the grader's guess. The recogniser's own
            // uncertainty about the TEXT is better evidence about why an
            // answer missed than a model's inference from the text it
            // produced.
            //
            // `outcome` above is untouched. A mishearing is not a right
            // answer; it is a miss whose cause we can name honestly.
            ...(graded.misheard ? { failureCause: 'misheard' as const } : {}),
            // THE RECOGNISER'S OWN NUMBER, so a reader of this row can see
            // what the cause above was concluded from. Null on every text
            // turn.
            asrConfidence: graded.asrConfidence,
            // DELIBERATELY NOT WRITTEN, and the absence is a decision rather
            // than an omission. `practice_attempts.transcript` means "the text
            // the learner CONFIRMED after the recogniser's guess"
            // (`voice.md` §3, and the column's own schema comment). A live
            // realtime turn has no confirm step — that is what makes it a
            // conversation rather than a form — so writing the heard text here
            // would claim a confirmation that never happened, and a later
            // epic grading "whatever the learner confirmed" would silently
            // grade something else. What was heard is `responseText`, subject
            // to retention exactly as a typed answer is.
            transcript: null,
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
        // identical placement `recordAttempt` uses. §7: an interview answer is
        // at least as good evidence as a practice attempt, so it advances
        // `question_mastery` exactly as one does.
        //
        // -------------------------------------------------------------------
        // THE SKIP RULE IS NO LONGER THIS METHOD'S, AND THAT IS THE POINT
        // (issue #245, epic #60 / E11)
        // -------------------------------------------------------------------
        //
        // WHAT USED TO BE HERE: a guard reading
        // `graded.answerResolution !== 'state_required'`, deliberately ONE
        // CONDITION SHORTER than `PracticeService.recordAttempt`'s
        // `status !== 'state_required' && !misheard`. The comment that stood
        // here explained at length that the shorter guard was correct only
        // because the text interview path could not produce a misheard attempt
        // — no `asrConfidence` on the DTO, `inputMode` hardcoded to `'typed'`,
        // `isMisheardAttempt` never called on this path, and
        // `PersistableFailureCause` excluding `'misheard'` at the type level —
        // and it named the epic that would break every one of those four:
        // "WIRING E9 VOICE INTO INTERVIEWS MAKES THIS GUARD WRONG IMMEDIATELY
        // (E11 / #60 is the epic that will)".
        //
        // THIS IS THAT EPIC. A realtime civics turn carries the recogniser's
        // own `confidence` (`realtime-tools.ts`'s `grade_answer` schema), so
        // `isMisheardAttempt` can now return `true` on this path, and the old
        // guard would have charged a nervous applicant a real mastery penalty
        // — `correctStreak` reset, `lapses` incremented, `dueAt` pulled in —
        // for an accent or a noisy connection, mid-rehearsal, at the moment a
        // learner is most likely to be misheard.
        //
        // The comment also named the RIGHT fix and asked for it by number:
        // issue #245, "moving the skip rule INSIDE
        // `AttemptGradingService.scheduleMastery`, so it is decided once for
        // both call sites and they cannot disagree. Prefer that to adding
        // `&& !misheard` here a second time: a rule stated twice is a rule
        // that can be fixed in one place and silently left stale in the
        // other." That is what shipped. `practice/mastery/mastery-skip.ts` is
        // the rule; this call states the facts it reads and decides nothing.
        //
        // AND THE OLD COMMENT'S LAST WARNING IS CLOSED TOO — "nothing would
        // force the author to notice". `scheduleMastery`'s `evidence`
        // parameter is REQUIRED, so a future call site that forgets the rule
        // does not compile, and `interviews.service.spec.ts` asserts that a
        // low-confidence spoken interview answer writes no mastery row.
        await this.grading.scheduleMastery(
          tx,
          userId,
          graded.questionId,
          toAttemptOutcome(graded.outcome, graded.gradingMethod),
          graded.answeredAt,
          {
            answerResolution: graded.answerResolution as 'resolved' | 'state_required',
            outcome: graded.outcome,
            // `null` on every text turn, because `interview-turn.dto.ts` has
            // no field that could carry one. Non-null only on a realtime
            // civics turn, where the provider reported one.
            asrConfidence: graded.asrConfidence,
          },
        );
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
    /**
     * WHICH question, and nothing else about the prompt.
     *
     * Narrowed from the engine's whole `civics` prompt in #158: this method
     * only ever read `questionId` off it, and stating that lets the realtime
     * handler grade an answer without fabricating a prompt object (with a
     * plan position and a planned count it has no use for) to pass in.
     */
    questionId: string,
    text: string,
    /**
     * The recogniser's confidence, on a spoken turn only.
     *
     * `null` from the text transport, which has no field that could carry one.
     * It plays NO part in grading — the ladder below never sees it — and is
     * read once, at the end, to decide {@link GradedCivicsAnswer.misheard}. A
     * confidence that changed a verdict would be the recogniser voting on
     * whether an answer was right.
     */
    asrConfidence: number | null = null,
  ): Promise<GradedCivicsAnswer> {
    const question = await this.prisma.civicsQuestion.findUnique({
      where: { id: questionId },
      select: QUESTION_SELECT,
    });

    if (!question) {
      // The ask-list is derived from the live bank, so a question deleted
      // between two turns of one interview can genuinely reach here. It is a
      // content event, not a client error, which is why it is logged as one and
      // surfaces as a 404 naming the question rather than a 500.
      throw new NotFoundException(`Civics question "${questionId}" not found`);
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

    const finalOutcome = aiGrading?.outcome ?? outcome;

    return {
      questionId: question.id,
      outcome: finalOutcome,
      gradingMethod: aiGrading ? 'ai' : 'exact',
      responseText,
      snapshot,
      answerResolution: status,
      graderRan: aiGrading !== null,
      failureCause: aiGrading?.failureCause ?? null,
      aiFeedback: aiGrading?.aiFeedback ?? null,
      aiUsageEventId: aiGrading?.aiUsageEventId ?? null,
      asrConfidence,
      // THE SAME FUNCTION AND THE SAME THRESHOLD THE PRACTICE PATH USES, never
      // a second rule invented for realtime (`realtime-interview.md` §4.2:
      // "the identical `ASR_CONFIDENCE_THRESHOLD` comparison `voice.md` §3
      // already specifies... never a second threshold invented for realtime").
      // Computed AFTER grading, because condition 3 reads the final outcome: a
      // right answer is right however it was heard.
      misheard: isMisheardAttempt(asrConfidence, finalOutcome),
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
    mode: string;
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

    // THE TRANSCRIPT DECIDES WHICH SEGMENTS WERE CONDUCTED (#158, §5).
    //
    // Both reads are of the SAME turn table and both answer questions the walk
    // cannot answer from the engine alone: whether the reading/writing segment
    // ahead was conducted (an applicant answered it) or skipped (nobody did),
    // and whether the closing has already been said. Deriving either from
    // `mock_interviews.mode` instead would be wrong for §7's fallback case —
    // an interview whose civics phase ran by voice and whose reading segment
    // was then skipped by the text transport carries `mode: 'voice'` forever,
    // and replay would sit waiting for a reading answer that will never come.
    const turns = await this.prisma.mockInterviewTurn.findMany({
      where: { mockInterviewId: interview.id },
      orderBy: { turnIndex: 'asc' },
      include: { attempt: { select: { outcome: true } } },
    });

    const applicantTurns = turns.filter((turn: any) => turn.role === 'applicant');
    const officerPhases = new Set<string>(
      turns
        .filter((turn: any) => turn.role === 'officer')
        .map((turn: any) => turn.phase),
    );

    // Whether a reading/writing segment can be conducted AT THE FRONTIER — the
    // point replay runs out of applicant turns and the live interview takes
    // over. Behind the frontier the transcript answers it (a conducted segment
    // has an applicant answer; a skipped one does not); at the frontier nothing
    // has happened yet, so it is a question about the TRANSPORT and the
    // content, and both are read here:
    //
    //   * `mode === 'voice'` — §5 makes the segments real "in a realtime
    //     interview", and `mock_interviews.mode` is the durable record of
    //     whether this interview is one. A text interview keeps skipping them,
    //     unchanged, which is what E8 already ships.
    //   * a sentence exists — through `EnglishService.getNext`, the SAME call
    //     the serving path makes, so the two can never disagree about whether
    //     this rehearsal has content for that segment. An empty bank is a
    //     rehearsal that genuinely does not include that test, and it skips
    //     with the honest line on both transports.
    const conductable = await this.conductableSegments(interview);

    // The phase of the next applicant turn replay has not consumed yet.
    let consumed = 0;
    const pendingPhase = (): InterviewPhase | null =>
      consumed < applicantTurns.length
        ? (applicantTurns[consumed].phase as InterviewPhase)
        : null;

    const options: OfficerRunOptions = {
      conductsSegment: (phase) =>
        pendingPhase() === phase ||
        (pendingPhase() === null && conductable[phase]),
      stopBeforeUnsaid: (phase) => !officerPhases.has(phase),
    };

    let state = runOfficer(
      startState({ seed: interview.id, passRule, questionPool: pool }),
      options,
    ).state;

    while (consumed < applicantTurns.length) {
      const turn = applicantTurns[consumed];
      consumed += 1;

      // The turn's own phase is deliberately NOT passed to `applyAnswer` —
      // `state.phase` is. The engine throws on a phase disagreement, and a
      // transcript row is not the authority on where the engine is: if the two
      // ever diverged (a bank change under a resumed interview), replaying from
      // the row would abort the whole request rather than continue from the
      // state the engine can actually justify.
      //
      // The predicate above DOES read the row's phase, and that is a different
      // question with a different authority: not "where is the engine" but
      // "did a person answer this segment", which only the transcript records.
      state = applyAnswer(state, {
        phase: state.phase,
        // `attempt` is null for a reading or writing turn — that evidence is an
        // `english_attempts` row, not a `practice_attempts` one — and
        // `applyAnswer` reads `correct` only in the civics phase, so `false`
        // here is the value the type requires and never a grade.
        correct: (turn as any).attempt?.outcome === 'correct',
      });

      // The officer's own turns — the skipped segments and the closing — consume
      // no applicant answer, so replay has to walk past them exactly as the live
      // path does. Sharing `runOfficer` between the two is what makes a resumed
      // interview land in the state the live one was in, rather than in a state
      // a second implementation happened to compute.
      state = runOfficer(state, options).state;
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

  /**
   * Which E10 segments this interview can actually conduct at the frontier.
   *
   * TWO CONDITIONS, and {@link InterviewsService.rebuildState}'s own comment
   * gives both. Read together here so the answer is computed once per rebuild
   * rather than once per phase the walk happens to reach.
   *
   * The `getNext` calls are skipped entirely for a text interview, which is
   * every interview until a realtime session is minted for it — so E8's own
   * path costs exactly what it always did.
   */
  private async conductableSegments(interview: {
    userId: string;
    mode: string;
  }): Promise<Record<SkippedPhase, boolean>> {
    if (interview.mode !== 'voice') return { reading: false, writing: false };

    const [reading, writing] = await Promise.all([
      this.english.getNext(interview.userId, 'reading'),
      this.english.getNext(interview.userId, 'writing'),
    ]);

    return {
      reading: reading.sentence !== null,
      writing: writing.sentence !== null,
    };
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

/**
 * The interview columns the realtime handlers read.
 *
 * NARROWER THAN THE ROW, deliberately: these four are what the handlers below
 * actually consult, and stating that as a type is what keeps a Prisma row from
 * being threaded through code that has no business reading the rest of it.
 */
interface InterviewRow {
  id: string;
  status: string;
  testVersionCode: string;
  transcriptRetained: boolean;
}

/** One officer turn to write, with its text already assembled. */
interface RealtimeTurnDraft {
  phase: InterviewPhase;
  /** Set only on a civics turn — an FK into `civics_questions`. */
  questionId: string | null;
  /** What goes into `mock_interview_turns.text`. NOT always what is spoken. */
  text: string;
}

/** What one `next_question` produces. */
interface RealtimeOfficerLines {
  /** The strings the officer says, in order. */
  spoken: string[];
  /** The rows to write. A writing segment's draft omits the sentence. */
  turns: RealtimeTurnDraft[];
  /** True when the spoken text must never be rendered — the writing sentence. */
  speakOnly: boolean;
  /** The id a subsequent `grade_answer` must name, or null. */
  itemId: string | null;
  /** The engine's state after these lines. */
  state: EngineState;
}

/**
 * What the officer says when a reading transcript was not trusted.
 *
 * `english-test.md` §3 writes no row at all in that case, so the officer asks
 * again rather than moving on. NEUTRAL, and specifically not "that was wrong":
 * a low-confidence transcript says the recogniser was unsure of the words, not
 * that the learner read them badly, and `VISION.md`'s promise that a learner
 * may "practice without being unfairly penalized for accent or
 * speech-recognition errors" is a promise about what they are TOLD as much as
 * about what is recorded.
 *
 * Only `reading` can reach it — a writing attempt is typed, so there is no
 * recogniser to distrust — but both are declared so the map is total over the
 * two segments rather than partial with a cast.
 */
const ENGLISH_RETRY_ACK: Record<'reading' | 'writing', string> = {
  reading: 'I did not catch that clearly. Could you read it once more, please?',
  writing: 'Could you write that once more, please?',
};

/**
 * An empty prompt map, for {@link toOfficerTurnBody} on a branch that reads no
 * question.
 *
 * Named rather than an inline `new Map()` at the call site so it is obvious the
 * absence is intended: the small-talk and application-review branches have no
 * `civics_questions` row to look up, and passing an empty map is how that is
 * stated to a function whose civics branch would need one.
 */
const EMPTY_PROMPTS: ReadonlyMap<string, string> = new Map();

/** What {@link runOfficer} produces: the state to persist, and what to say. */
interface OfficerRun {
  state: EngineState;
  prompts: InterviewPrompt[];
}

/**
 * How the officer walk treats the two phases whose behaviour differs by
 * transport.
 *
 * BOTH DEFAULT TO E8'S BEHAVIOUR, so every pre-#158 call site reads exactly as
 * it did and a caller that passes nothing gets the text transport.
 */
interface OfficerRunOptions {
  /**
   * Whether the reading/writing segment named is CONDUCTED (it awaits an
   * applicant answer) rather than skipped with one honest line.
   *
   * `docs/specs/realtime-interview.md` §5 makes both segments real on the
   * realtime transport, and `phases.ts`' own header anticipated exactly this:
   * "the change is what happens inside the phase, not whether the phase
   * exists." The engine is untouched — it still emits `skipped_segment`; this
   * predicate decides whether the walk stops there.
   *
   * A PREDICATE RATHER THAN A BOOLEAN because {@link
   * InterviewsService.rebuildState} answers it FROM THE TRANSCRIPT — a segment
   * was conducted if and only if an applicant answered it — which is what keeps
   * a resumed interview landing where the live one was regardless of which
   * transport conducted which phase. A `mode === 'voice'` flag would be wrong
   * for the one case §7 requires to work: a learner who conducts the civics
   * phase by voice and then falls back to text, whose reading segment is
   * therefore skipped on an interview whose `mode` says `voice` forever.
   */
  conductsSegment?: (phase: SkippedPhase) => boolean;

  /**
   * Whether to stop BEFORE emitting an officer line for this phase, because the
   * transcript does not contain one yet.
   *
   * REPLAY SETS THIS; the live path never does. Two prompt kinds consume no
   * applicant answer — a skipped segment and the closing — so replay has no
   * turn that would stop the walk at either, and walking past one the
   * transcript does not contain would leave the engine positioned after a line
   * nobody ever said.
   *
   * On the text transport that could not happen: one exchange writes the
   * skipped segments and the closing and completes, all in the same call, so
   * the turns always exist before replay next runs. On the realtime transport
   * the officer's next line comes from a separate `next_question`, so the state
   * has to be able to sit at an unsaid line and wait to be asked for it.
   */
  stopBeforeUnsaid?: (phase: InterviewPhase) => boolean;
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
 *     not include the reading test"). There is nothing to reply to — unless the
 *     segment is being CONDUCTED, which is E11's one change here; see
 *     {@link OfficerRunOptions.conductsSegment}.
 *   * `closing` — §2.5's closing statement, after which the interview awaits
 *     `complete`. A real officer does not wait for an answer to "thank you for
 *     your time".
 *
 * So one exchange can produce three officer turns: the last civics answer of an
 * interview is followed by both skips and the closing, and the learner sees all
 * three at once, which is what the real event's pacing looks like.
 */
function runOfficer(
  state: EngineState,
  options: OfficerRunOptions = {},
): OfficerRun {
  const prompts: InterviewPrompt[] = [];
  let current = state;

  // Bounded by construction: every iteration either returns or advances a phase,
  // and `INTERVIEW_PHASES` is finite. `applyAnswer` on a non-civics phase
  // increments that phase's turn counter and moves on when the phase has had its
  // turns, so no phase can be walked twice.
  for (;;) {
    const prompt = nextPrompt(current);

    if (prompt.kind === 'completed') return { state: current, prompts };

    if (
      prompt.kind === 'skipped_segment' &&
      options.conductsSegment?.(prompt.phase) === true
    ) {
      // CONDUCTED. It awaits an applicant answer exactly as a civics question
      // does, so the walk stops here and the state is not advanced past a
      // segment nobody has produced yet.
      prompts.push(prompt);
      return { state: current, prompts };
    }

    if (
      (prompt.kind === 'skipped_segment' || prompt.kind === 'closing') &&
      options.stopBeforeUnsaid?.(phaseOfPrompt(prompt)) === true
    ) {
      // Not written yet, and this walk is a replay with no turn to stop it.
      // Leave the state sitting here so the next live call can say the line.
      return { state: current, prompts };
    }

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
