import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { AiDispatchService } from '../../ai/ai-dispatch.service';
import type { AiModelRole } from '../../ai/ai-model-roles';
import { PracticeService } from '../practice.service';
import type { PracticeRealtimeSessionResponse } from '../dto/practice-realtime-session.dto';
import type { PracticeSessionDetail } from '../dto/practice-session.dto';
import { buildPracticeRealtimeInstructions } from './practice-realtime-instructions';
import {
  PracticeRealtimeAskedLedger,
  type AskedQuestion,
} from './practice-realtime-asked';
import { PRACTICE_REALTIME_CLOSING_LINE } from './practice-realtime-lines';
import { decideRealtimeMint } from './practice-realtime-mint';
import {
  alreadyAnsweredRejection,
  decideEndSession,
  decideGradeAnswer,
  decideNextQuestion,
  decideRepeatQuestion,
  decideSkipQuestion,
  emptyTranscriptRejection,
  noQuestionToServe,
  SPEAK_VERBATIM_INSTRUCTION,
  type PracticeRealtimeRejection,
  type PracticeRealtimeThen,
  type PracticeRealtimeToolCall,
  type PracticeRealtimeToolName,
  type PracticeRealtimeToolResponse,
  type PracticeRealtimeTurnContext,
} from './practice-realtime-tool-calls';
import {
  PRACTICE_REALTIME_SESSION_TTL_SECONDS,
  PRACTICE_REALTIME_TOOLS,
} from './practice-realtime-tools';

/**
 * The role this service mints against. Never a model id, never a provider.
 *
 * `satisfies AiModelRole` for the same reason `InterviewsService` writes it
 * that way: the string is persisted (it keys the admin's `models` map and lands
 * in `ai_usage_events.roleKey`), so it is worth pinning to the registry's own
 * type rather than leaving as a loose literal.
 */
const REALTIME_ROLE = 'realtime' satisfies AiModelRole;

// =============================================================================
// PracticeRealtimeService — the mint (issue #353, epic #345 / E15)
// =============================================================================
//
// The impure half of `practice/realtime/`: it loads the session, obeys the pure
// mint rule, and spends the learner's own key. Everything it decides is decided
// by `decideRealtimeMint`; everything it says to the model is built by
// `buildPracticeRealtimeInstructions` and `PRACTICE_REALTIME_TOOLS`.
//
// -----------------------------------------------------------------------------
// A SEPARATE SERVICE, NOT A METHOD ON `PracticeService`
// -----------------------------------------------------------------------------
//
// Two reasons, and the second is the one that matters.
//
//   * `PracticeService` deliberately holds NO `AiDispatchService` at all — its
//     own header says so ("no provider, no model id, no `CredentialsService`,
//     no API key in any form"), because the one door to a model from the
//     practice loop is `AttemptGradingService`. Adding a dispatcher to it to
//     mint a credential would reopen that on the class that writes every
//     attempt row.
//   * This issue must not change `PracticeService`'s behaviour, and it does
//     not: nothing in that file is touched. This service is a CONSUMER of its
//     existing public `getSession`.
//
// -----------------------------------------------------------------------------
// THE 404 AND THE 409 COME FROM `getSession`, NOT FROM A SECOND CHECK
// -----------------------------------------------------------------------------
//
// `PracticeService.requireSession` filters on `userId` in the `where` of the
// single query that loads a session, so another learner's session is a **404,
// not a 403** here exactly as it is on every other practice route — and a mint
// route is not the place to start confirming that an id names a real session
// belonging to somebody.
//
// The "nothing left to ask" half is `getSession`'s own `nextQuestion`, which is
// null in exactly the three cases that matter (not `in_progress`, the planned
// count reached, or the bank exhausted for this learner). Asking the same
// question a second way — counting attempts here, or re-running the selector —
// would be a second answer free to disagree with the screen the learner is
// looking at, and the disagreement would show up as a session that mints
// happily and then refuses its own first `next_question`.
//
// -----------------------------------------------------------------------------
// NO `mode` FLIP, AND THAT IS A DECISION RATHER THAN AN OMISSION
// -----------------------------------------------------------------------------
//
// E11 writes `mock_interviews.mode = 'voice'` on the first successful mint.
// `practice_sessions` has no such column and must not gain one: `conversation-
// mode.md` §14 already rejected a session-level mode on that table, because it
// could disagree with the per-row `inputMode`/`promptMode` on
// `practice_attempts` that records what actually happened, answer by answer.
// That rejection stands, so this method writes NOTHING — it is a read plus a
// mint, and the only durable trace it leaves is the `ai_usage_events` row
// `BaseAiProvider` writes for the call.
//
// -----------------------------------------------------------------------------
// NOTHING ABOUT THE SECRET IS LOGGED, SPANNED OR AUDITED
// -----------------------------------------------------------------------------
//
// The log lines below carry the user, the session, the model and the status —
// the same fields every other line in this module carries. The secret is a
// bearer credential for the minute it is valid and a log aggregator retains far
// longer than that.
//
// This service opens NO SPAN of its own (the only spans on this path are
// `BaseAiProvider`'s, whose attributes are the model, the role and a stable
// code), and writes NO `audit_events` row — matching `voice.md` §9's posture
// toward the speech routes: this is an ordinary, per-user, no-permission action
// a learner takes on their own practice session, not an administrative one.
// Both absences are asserted rather than reviewed
// (`practice-realtime.service.spec.ts`, `test/practice-realtime.integration.spec.ts`).
//
// =============================================================================
// AND THE TOOL-CALL ENGINE (issue #354, epic #345 / E15)
// =============================================================================
//
// {@link PracticeRealtimeService.handleToolCall} is the other half: the thing
// that answers the five tools the minted session declared. It is the same
// class because it is the same seam — the impure half of `practice/realtime/`,
// obeying rules that live in `practice-realtime-tool-calls.ts` and touching a
// database that lives behind `PracticeService`.
//
// -----------------------------------------------------------------------------
// IT WRITES NOTHING ITSELF. IT CALLS `PracticeService.recordAttempt`.
// -----------------------------------------------------------------------------
//
// The single most important property in this file, and the reason the issue
// that added it exists. `grade_answer` and `skip_question` call the PUBLIC
// method `POST /api/practice/sessions/{id}/attempts` already calls — not a copy
// of its ladder, not a second assembly of the same facts.
//
// So the row this transport writes is the row that route writes, and every rule
// attached to it holds here for the mundane reason that it is literally the
// same code: the deterministic-then-AI grading ladder, mastery scheduling with
// `mastery-skip.ts`' refusal rule, the one-attempt-per-question guard,
// `requireRetryTarget`'s four conditions, the frozen `answerSnapshot`,
// `dropSuperseded` progress accounting, engagement accrual, the read-time
// `coachReaction`, and readiness's `spoken` component.
//
// E11 is the counter-example this is written against.
// `InterviewsService.gradeCivicsAnswer` re-implements
// `resolveAcceptedAnswers → gradeDeterministic → escalateToGrader` because an
// interview turn writes a differently-shaped row and genuinely cannot make the
// same call. A realtime practice attempt has NO such excuse — its target row is
// byte-for-byte `recordAttempt`'s own — so a second ladder here would be a
// third copy of one rule with nothing to justify it, and every property above
// would become something that has to be KEPT in agreement rather than
// something that is true by construction. `realtime-practice.md` §5, and a
// source-reading test (`practice-realtime-purity.spec.ts`) that fails the build
// if `gradeDeterministic`, `escalateToGrader` or `scheduleMastery` is ever
// named anywhere in this directory.
//
// -----------------------------------------------------------------------------
// THE DEPENDENCY RUNS ONE WAY, AND ONLY ONE
// -----------------------------------------------------------------------------
//
// This service depends on `PracticeService`. `PracticeService` gains no
// realtime import, no realtime branch, and no knowledge that this transport
// exists — asserted by the same source-reading spec. A realtime-shaped `if`
// inside `recordAttempt` would put the thing this issue is preventing
// (transport-specific behaviour on the evidence path) in the one file that must
// not have it.
//
// -----------------------------------------------------------------------------
// `inputMode: 'spoken'`, `promptMode: 'heard'`, AND NO NEW ENUM VALUE
// -----------------------------------------------------------------------------
//
// Identical to the request/response voice transport's own values (`voice.md`
// §8). A `realtime` value would be arithmetic, not taste:
// `readiness.service.ts`' spoken-evidence query filters on `inputMode:
// 'spoken'` and nothing else, so a third value would silently DROP every
// realtime attempt out of it and zero the `spoken` component for a learner who
// practises only this way — with nothing in the response, the logs or a failing
// test to report it (`realtime-practice.md` §9).
//
// `asrConfidence` is written `null` on every attempt from this transport,
// because `grade_answer` carries no confidence argument and never will (§3).
// `null` means UNKNOWN everywhere in this codebase and never triggers the
// `misheard` mapping — unknown is not low.
//
// -----------------------------------------------------------------------------
// A REFUSAL IS A 200. A 404 IS STILL A 404.
// -----------------------------------------------------------------------------
//
// A refused tool call is an ordinary, expected outcome of the contract, so it
// comes back as a typed `status: 'rejected'` body the relay hands to the model
// verbatim. A non-2xx would be flattened into generic failure handling and
// `instruction` — the one field that gets the session moving again — would
// never reach the model. That includes the 409 `recordAttempt` throws for an
// already-answered question, which is caught here and converted: a duplicate
// tool call is routine on this transport, and a 5xx into the middle of a live,
// per-minute-billing connection is not an acceptable answer to it.
//
// An unknown session id, and another learner's session id, stay 404s. Those are
// facts about the SESSION rather than about the contract, and there is no
// model-facing recovery from either.
// =============================================================================

@Injectable()
export class PracticeRealtimeService {
  private readonly logger = new Logger(PracticeRealtimeService.name);

  /**
   * Which question each live connection was told to say, and in which words.
   *
   * THE ONE FACT THE SESSION'S OWN TABLES CANNOT SUPPLY. `getSession`'s
   * `nextQuestion` is a fresh draw from a deliberately-shuffled selector
   * (`mastery/selector.ts`), so it names A question the session could ask next,
   * never THE question the coach actually spoke — and using it as an identity
   * would refuse a learner's answer whenever the draw moved between two reads.
   * `practice-realtime-asked.ts` carries the full argument, including both ways
   * this map is allowed to be wrong and what each costs.
   *
   * Not injected: it has no dependencies, and making it a provider would invite
   * a second consumer — which is precisely what must not happen to a map whose
   * correctness guarantee is "losing it costs one spoken turn".
   */
  private readonly asked = new PracticeRealtimeAskedLedger();

  constructor(
    private readonly practice: PracticeService,
    private readonly dispatch: AiDispatchService,
  ) {}

  /**
   * Mint one ephemeral realtime session credential for this practice session.
   *
   * What comes back is a short-lived secret the LEARNER'S OWN BROWSER uses to
   * open a realtime connection directly to the provider; this application is
   * not in that connection's data path at all, which is why no recording ever
   * reaches this process.
   *
   * The session is configured entirely server-side — there is no request body
   * on the route, so there is no field through which a caller could ask for a
   * session that is not this practice session's: no model, no instructions, no
   * tool list, no voice and no lifetime.
   */
  async createRealtimeSession(
    userId: string,
    sessionId: string,
  ): Promise<PracticeRealtimeSessionResponse> {
    // THE OWNERSHIP-SCOPED READ, AND THE ONLY ONE. A 404 for another learner's
    // session falls out of the `userId` filter inside it.
    const detail = await this.practice.getSession(userId, sessionId);

    const decision = decideRealtimeMint({
      sessionId,
      sessionStatus: detail.session.status,
      hasQuestionToAsk: detail.nextQuestion !== null,
    });

    if (decision.status === 'refused') {
      // A 409: the request is well-formed and the caller owns the session; the
      // session's own state refuses it. Raised BEFORE any spend, so a session
      // that could conduct nothing never costs the learner a minted credential.
      throw new ConflictException(decision.error);
    }

    const minted = await this.dispatch.createRealtimeSession(userId, {
      instructions: buildPracticeRealtimeInstructions(),
      tools: PRACTICE_REALTIME_TOOLS,
      expiresInSeconds: PRACTICE_REALTIME_SESSION_TTL_SECONDS,
    });

    if (minted.status !== 'ok') {
      this.logger.warn(
        {
          userId,
          sessionId,
          status: minted.status,
          // One of the four causes, or a stable provider code. Both are
          // GROUP-able; neither is a message and neither is a credential.
          reason:
            minted.status === 'unavailable' ? minted.cause : minted.errorCode,
        },
        'Realtime practice session could not be minted',
      );

      return minted.status === 'unavailable'
        ? { status: 'unavailable', cause: minted.cause, role: REALTIME_ROLE }
        : {
            status: 'failed',
            errorCode: minted.errorCode,
            error: minted.error,
          };
    }

    this.logger.log(
      {
        userId,
        sessionId,
        modelId: minted.modelId,
        // NOT THE SECRET, and not its length either — see the header.
        expiresAt: minted.expiresAt.toISOString(),
      },
      'Realtime practice session minted',
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
  // The tool calls (issue #354)
  // ---------------------------------------------------------------------------

  /**
   * Answer one tool call from a realtime practice session.
   *
   * ONE METHOD FOR ALL FIVE TOOLS, and one `getSession` before the switch. The
   * five rules all answer the same question — what does this session's state
   * permit right now — over the same three facts, so five entry points would be
   * five places to derive "is an answer outstanding" and five chances to derive
   * it differently.
   *
   * ---------------------------------------------------------------------------
   * ONE READ, PLUS THE ONE FACT A READ CANNOT SUPPLY
   * ---------------------------------------------------------------------------
   *
   * `PracticeService.getSession` is the ownership-scoped door — another
   * learner's session is a 404 that falls out of the `userId` filter in its
   * single query, exactly as it does for the mint above — and its response
   * carries all but one of the facts the rules read:
   *
   *   * `session.status` is the status.
   *   * `attempts` is what has been recorded, which is what tells a remembered
   *     question that it has since been answered.
   *   * `progress` is the tally, computed there with superseded attempts
   *     dropped, so this transport's arithmetic cannot disagree with the
   *     progress bar on the learner's own screen.
   *   * `nextQuestion` is A question this session could ask next — never THE
   *     question it is waiting on. The selector shuffles, deliberately and
   *     unseeded, so this field is a fresh draw on every read.
   *
   * WHICH QUESTION IS OUTSTANDING therefore comes from {@link asked}, the only
   * thing that knows what was actually handed over. See
   * `practice-realtime-asked.ts`.
   *
   * `questionsRemaining` is `planned - answered`, EXCEPT that it is zero when
   * there is neither a question in the air nor one left to draw. That second
   * clause is not tidiness: without it a session whose bank is exhausted before
   * its planned count is reached would refuse `next_question` (nothing to ask)
   * AND refuse `end_session({ reason: 'no_questions_left' })` (questions
   * remain) — a deadlock a learner could not talk their way out of.
   */
  async handleToolCall(
    userId: string,
    sessionId: string,
    call: PracticeRealtimeToolCall,
  ): Promise<PracticeRealtimeToolResponse> {
    const detail = await this.practice.getSession(userId, sessionId);

    const answeredQuestionIds = new Set(
      detail.attempts.map((attempt) => attempt.questionId),
    );

    const outstanding = this.asked.outstanding(sessionId, answeredQuestionIds);

    const context: PracticeRealtimeTurnContext = {
      sessionStatus: detail.session.status,
      outstandingQuestionId: outstanding?.id ?? null,
      questionsRemaining:
        outstanding === null && detail.nextQuestion === null
          ? 0
          : detail.progress.planned - detail.progress.answered,
    };

    switch (call.tool) {
      case 'next_question':
        return this.serveNextQuestion(
          userId,
          sessionId,
          detail.nextQuestion,
          context,
        );
      case 'repeat_question':
        return this.repeatQuestion(userId, sessionId, outstanding, context);
      case 'grade_answer':
        return this.recordSpokenAnswer(userId, sessionId, context, call);
      case 'skip_question':
        return this.recordSkip(userId, sessionId, context, call);
      case 'end_session':
        return this.endSession(userId, sessionId, context, call);
    }
  }

  /**
   * `next_question`: draw the next question and hand back its exact words.
   *
   * REFUSED WHILE AN ANSWER IS OUTSTANDING, which is the rule that keeps one
   * question in the air at a time. Without it a model that mis-heard a pause as
   * an answer would walk the learner through a run of questions nobody got to
   * answer — spoken out loud, in a conversation the learner cannot rewind.
   *
   * The question comes from `getSession`'s `nextQuestion`, which is the
   * selector's own draw: this service has no say in WHICH question, and there
   * is no argument on the tool through which the model could ask for one. What
   * is served is then REMEMBERED (`asked`), because that draw is random and a
   * later read would not name the same question — see
   * `practice-realtime-asked.ts`.
   */
  private serveNextQuestion(
    userId: string,
    sessionId: string,
    question: PracticeSessionDetail['nextQuestion'],
    context: PracticeRealtimeTurnContext,
  ): PracticeRealtimeToolResponse {
    const decision = decideNextQuestion(context);

    if (decision.status !== 'ok') {
      return this.refuse(userId, sessionId, decision);
    }

    if (question === null) {
      // UNREACHABLE BY CONSTRUCTION: `questionsRemaining` is zero whenever
      // there is neither an outstanding question nor one to draw, and the rule
      // above refuses a zero count. Refused rather than asserted away — see
      // `noQuestionToServe` on why an impossible state should degrade into a
      // sentence rather than into a 500 on a live connection.
      return this.refuse(userId, sessionId, noQuestionToServe('next_question'));
    }

    // THE WHOLE QUESTION, not an id and a prompt (issue #402). It is what the
    // browser renders, and remembering only the two fields the model needs is
    // what left the screen resolving the rest for itself.
    this.asked.record(sessionId, question);

    return {
      status: 'ok',
      tool: 'next_question',
      // VERBATIM, AND ONE ELEMENT. The instructions tell the coach to say what
      // a tool returns exactly as given; anything this application added around
      // the prompt would be a sentence the model then has to decide how to
      // blend with the exam material.
      say: [question.prompt],
      then: 'await_answer',
      questionId: question.id,
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      // THE SAME QUESTION AS `questionId`, IN FULL, FOR THE SCREEN. See the
      // field's own comment on why the browser must not resolve this itself.
      question,
    };
  }

  /**
   * `repeat_question`: say the outstanding question again, word for word.
   *
   * THE SAME WORDS, FROM THE LEDGER, not a fresh draw. This is the whole reason
   * the prompt is remembered alongside the id: `getSession`'s `nextQuestion` is
   * a new sample from a shuffled selector on every read, so "repeating" from it
   * could hand the learner a DIFFERENT question while the model says it is the
   * same one.
   *
   * WRITES NOTHING AND COSTS NOTHING — no row, no scheduling, no count, however
   * many times a learner asks.
   *
   * Refused when nothing is in the air, including after a re-minted connection
   * that lost the conversation: there is genuinely nothing to repeat, and the
   * instruction sends the model to `next_question`.
   */
  private repeatQuestion(
    userId: string,
    sessionId: string,
    outstanding: AskedQuestion | null,
    context: PracticeRealtimeTurnContext,
  ): PracticeRealtimeToolResponse {
    const decision = decideRepeatQuestion(context);

    if (decision.status !== 'ok') {
      return this.refuse(userId, sessionId, decision);
    }

    if (outstanding === null) {
      // UNREACHABLE: `context.outstandingQuestionId` IS this value's id, and
      // the rule above refuses a null one. Same posture as `serveNextQuestion`.
      return this.refuse(
        userId,
        sessionId,
        noQuestionToServe('repeat_question'),
      );
    }

    return {
      status: 'ok',
      tool: 'repeat_question',
      say: [outstanding.prompt],
      then: 'await_answer',
      questionId: outstanding.id,
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      // THE LEDGER'S OWN ENTRY, never a fresh read: the whole reason the
      // question is remembered is that resolving it again could name a
      // different one.
      question: outstanding,
    };
  }

  /**
   * `grade_answer`: record what the learner said, through the one public method.
   *
   * ---------------------------------------------------------------------------
   * NOTHING HERE GRADES ANYTHING
   * ---------------------------------------------------------------------------
   *
   * The transcript goes to `PracticeService.recordAttempt` and the verdict comes
   * back on the row it wrote. This method never sees an accepted answer, never
   * calls the deterministic matcher, never escalates to the grader and never
   * touches `question_mastery` — see this file's header, and the source-reading
   * test that enforces it.
   *
   * `say` is `composeSpokenTurn`'s output, read off the recorded attempt: the
   * verdict, the grader's reason when a grader actually ran, the accepted
   * answer on a miss, and the coach's persona line — already composed by the
   * same pure function the ordinary attempt response uses, so both transports
   * say the same words about the same answer.
   */
  private async recordSpokenAnswer(
    userId: string,
    sessionId: string,
    context: PracticeRealtimeTurnContext,
    call: Extract<PracticeRealtimeToolCall, { tool: 'grade_answer' }>,
  ): Promise<PracticeRealtimeToolResponse> {
    const decision = decideGradeAnswer(context, call);

    if (decision.status !== 'ok') {
      return this.refuse(userId, sessionId, decision);
    }

    // A BLANK TRANSCRIPT IS NOT A WRONG ANSWER. Passed through it would be
    // graded `incorrect` and recorded as evidence that the learner answered and
    // missed — a false claim about somebody who said nothing — and the question
    // would lapse on the strength of it. `realtime-practice.md` §5.
    if (call.transcript.trim() === '') {
      return this.refuse(userId, sessionId, emptyTranscriptRejection());
    }

    return this.record(userId, sessionId, decision, {
      questionId: decision.questionId,
      // BOTH COLUMNS, THE SAME STRING, exactly as the request/response spoken
      // path writes them (`record-attempt.dto.ts`): `responseText` is what was
      // graded and `transcript` is what came back from recognition. They agree
      // today and are two columns because they answer two questions.
      responseText: call.transcript,
      transcript: call.transcript,
      skipped: false,
    });
  }

  /**
   * `skip_question`: record the learner moving on, as a skip and never as a miss.
   *
   * `skipped: true` with no `responseText` and no `transcript` — the shape the
   * DTO's own refinement requires, and the shape that produces `outcome:
   * 'skipped'`. A skip is real evidence ("I have no idea"), it schedules, and
   * it is a different fact from a wrong answer; routing an unheard answer here,
   * or a skip through `grade_answer`, would put the wrong one of the two in the
   * one table this product treats as fact.
   *
   * `revealed` STAYS FALSE, and that is a decision rather than a default. It
   * means the learner had the accepted answer in front of them BEFORE
   * submitting; on this transport the answer is spoken by `composeSpokenTurn`'s
   * output AFTER the skip is already recorded, so `true` would be a false claim
   * about when they saw it — and `revealed` is the precondition for
   * self-marking, so the false claim would be load-bearing.
   */
  private async recordSkip(
    userId: string,
    sessionId: string,
    context: PracticeRealtimeTurnContext,
    call: Extract<PracticeRealtimeToolCall, { tool: 'skip_question' }>,
  ): Promise<PracticeRealtimeToolResponse> {
    const decision = decideSkipQuestion(context, call);

    if (decision.status !== 'ok') {
      return this.refuse(userId, sessionId, decision);
    }

    return this.record(userId, sessionId, decision, {
      questionId: decision.questionId,
      skipped: true,
    });
  }

  /**
   * The one call into `PracticeService.recordAttempt`, shared by both writers.
   *
   * ONE CALL SITE, not two, so the fields neither tool varies — `inputMode`,
   * `promptMode`, `revealed`, `hintUsed`, `durationMs`, `asrConfidence`,
   * `retryOfAttemptId` — are stated once and cannot drift between an answer and
   * a skip. What the two tools differ in is passed in.
   *
   * ---------------------------------------------------------------------------
   * THE ALREADY-ANSWERED CONFLICT IS CAUGHT HERE
   * ---------------------------------------------------------------------------
   *
   * `recordAttempt` throws a `ConflictException` for a question this session has
   * already recorded. On the HTTP attempt route that is a correct 409 to a
   * client that should not have asked twice. On this transport a duplicate is
   * ROUTINE — a retried tool call after a slow acknowledgement, two calls
   * racing a connection hiccup, a re-mint replaying the last turn — and a
   * non-2xx reaching the relay would be flattened into generic failure handling
   * in the middle of a live, per-minute-billing conversation.
   *
   * So it becomes `already_answered`, with the standing continue-instruction.
   * ONLY that exception is caught: a `NotFoundException` or a
   * `BadRequestException` from the same call would mean the question this
   * service just derived from the session is not in that session's scope, which
   * is a programming error and must not be dressed up as a tool-call refusal.
   */
  private async record(
    userId: string,
    sessionId: string,
    // `PracticeRealtimeThen` in full rather than the two values a recorded
    // answer can actually produce. Narrowing it here would be this file
    // restating a guarantee `decideRecorded` already makes — and restating it
    // is how the two come to disagree.
    decision: { questionId: string; then: PracticeRealtimeThen },
    input: {
      questionId: string;
      responseText?: string;
      transcript?: string;
      skipped: boolean;
    },
  ): Promise<PracticeRealtimeToolResponse> {
    const tool: PracticeRealtimeToolName = input.skipped
      ? 'skip_question'
      : 'grade_answer';

    let result;

    try {
      result = await this.practice.recordAttempt(userId, sessionId, {
        questionId: input.questionId,
        responseText: input.responseText,
        transcript: input.transcript,
        skipped: input.skipped,
        // SPOKEN AND HEARD, WITH NO NEW ENUM VALUE — see this file's header on
        // why a `realtime` value would zero the readiness `spoken` component
        // for a learner who practises only this way.
        inputMode: 'spoken',
        promptMode: 'heard',
        // FALSE, DELIBERATELY. See `recordSkip` — the accepted answer is spoken
        // after the row is written, never before it.
        revealed: false,
        hintUsed: false,
        // OMITTED, NEVER ZERO OR NULL-AS-A-CLAIM. There is no confidence
        // argument on this contract and never will be (a model's certainty
        // about its own hearing is not a recogniser's measurement), and this
        // application is not in the connection's data path, so it cannot time
        // the learner's answer either. Absent means unknown.
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        return this.refuse(userId, sessionId, alreadyAnsweredRejection(tool));
      }

      throw error;
    }

    // The question is answered: whatever the ledger remembered about it is
    // spent. Not load-bearing — `outstanding` drops the entry on its own the
    // next time it is read, because the question now appears among the
    // session's recorded attempts — but clearing at the moment the fact becomes
    // false is cheaper than relying on the self-healing path, and it means the
    // very next call reads a map that is already right.
    this.asked.clear(sessionId);

    this.logger.log(
      {
        userId,
        sessionId,
        tool,
        questionId: input.questionId,
        // WHAT WAS RECORDED, NEVER WHAT WAS SAID. The transcript is a person's
        // words and a log line's retention is not this feature's to govern.
        // `outcome` is here because the row is already written and this is the
        // ordinary attempt-level operational line, not something the model sees.
        outcome: result.attempt.outcome,
      },
      'Realtime practice attempt recorded',
    );

    return {
      status: 'ok',
      tool,
      // THE COMPOSED TURN, VERBATIM (issue #351). Read off the attempt the
      // ordinary route returns, so the words spoken here and the words the
      // request/response loop speaks about the same answer are the same words,
      // from the same pure function, with no second composition to drift.
      say: result.attempt.spokenTurn,
      then: decision.then,
      // NOTHING IS OUTSTANDING NOW. The next question is served by the next
      // `next_question` call, which is the only thing that makes one
      // outstanding — handing one back here would ask a question nobody has
      // spoken yet.
      questionId: null,
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      // NULL FOR THE SAME REASON `questionId` IS. The two never disagree.
      question: null,
    };
  }

  /**
   * `end_session`: close the session, or refuse the claim that it is over.
   *
   * `learner_asked` is BELIEVED — it reports something that happened in the
   * room, the model is the only witness, and overruling it would be the product
   * arguing with a learner about their own time. `no_questions_left` is
   * VERIFIED, because it is a claim about this application's own state, and a
   * model that could end a session by asserting it could cut one short and have
   * the summary screen agree.
   *
   * On honour it calls `PracticeService.completeSession` — the same method
   * `POST /api/practice/sessions/{id}/complete` calls, which computes the
   * summary from the persisted attempts, recomputes readiness synchronously and
   * accrues the day's activity. It is IDEMPOTENT: a second `end_session` (a
   * re-mint racing the original, a retried tool call) returns the stored
   * summary and does not re-stamp `completedAt`.
   *
   * The `ConflictException` it can raise for an `abandoned` session is caught
   * for the same reason the already-answered one is: the session's status was
   * `in_progress` when this request read it, so reaching that exception means
   * something closed the session in between, and the model's correct response
   * is to stop talking — not to receive a 5xx.
   *
   * `say` IS THE SESSION'S OWN CLOSING TURN FOLLOWED BY THE CODE-OWNED CLOSING
   * LINE (issue #404). `completeSession`'s return value already carries
   * `spokenTurn` — the coach's closing line, in the learner's chosen persona,
   * from the curated bank — and until #404 this method discarded it and spoke
   * the constant alone, so the one transport where the coach has a voice was
   * the one transport that ended flat. See the return statement.
   */
  private async endSession(
    userId: string,
    sessionId: string,
    context: PracticeRealtimeTurnContext,
    call: Extract<PracticeRealtimeToolCall, { tool: 'end_session' }>,
  ): Promise<PracticeRealtimeToolResponse> {
    const decision = decideEndSession(context, call);

    if (decision.status !== 'ok') {
      return this.refuse(userId, sessionId, decision);
    }

    let completed;

    try {
      completed = await this.practice.completeSession(userId, sessionId);
    } catch (error) {
      if (error instanceof ConflictException) {
        return this.refuse(
          userId,
          sessionId,
          decideEndSession(
            { ...context, sessionStatus: 'abandoned' },
            call,
          ) as PracticeRealtimeRejection,
        );
      }

      throw error;
    }

    this.asked.clear(sessionId);

    this.logger.log(
      { userId, sessionId, reason: decision.reason },
      'Realtime practice session ended',
    );

    return {
      status: 'ok',
      tool: 'end_session',
      // THE COACH FIRST, THEN THE CODE-OWNED CLOSING (issue #404).
      //
      // `completed.spokenTurn` is `composeSessionClosingTurn`'s output, read
      // off the session `completeSession` just returned — the SAME array the
      // request/response transport speaks at the end of a voice session
      // (`PracticeSessionPage.handleFinish`) and the same line the summary
      // screen renders, selected once in `toCoachReaction` and seeded by the
      // session's own id. Not a second selection: this method composes
      // nothing, exactly as `record` above composes nothing.
      //
      // It is ORDINARILY ONE LINE and legitimately `[]` — a learner who turned
      // `coach.reactions` off, or a session with no summary to react to. Empty
      // spreads to nothing and this turn is the closing line alone, which is
      // what every session said before #404. There is no suppression branch
      // here and there must not be one; the preference became `null` once,
      // server-side, in `toCoachReaction`.
      //
      // THE COACH LINE GOES FIRST so `PRACTICE_REALTIME_CLOSING_LINE` stays
      // LAST — that constant is the turn's forward-pointing door
      // (`COACH_INVARIANT_FLOOR`'s closing rule, and the reason
      // `practice-realtime-lines.ts` writes it the way it does), and a
      // persona's parting shot after it would take the door away from the last
      // thing a learner hears.
      say: [...completed.spokenTurn, PRACTICE_REALTIME_CLOSING_LINE],
      then: 'session_complete',
      questionId: null,
      instruction: SPEAK_VERBATIM_INSTRUCTION,
      question: null,
    };
  }

  /**
   * Log a refusal and hand it back unchanged.
   *
   * THE REJECTION IS NOT REBUILT HERE. It is whatever the rules (or the two
   * builders the rules cannot reach) produced, returned verbatim, so `reason`,
   * `error` and `instruction` are decided in one place and this method cannot
   * quietly drop the third.
   *
   * Logged at DEBUG, not WARN: a refused tool call is an ORDINARY outcome of
   * the contract — the model got ahead of itself, or lost its place — and a
   * warning per refusal would train whoever reads these logs to ignore the
   * file. Never the transcript, never the learner's words; the reason and the
   * tool are enough to group by.
   */
  private refuse(
    userId: string,
    sessionId: string,
    rejection: PracticeRealtimeRejection,
  ): PracticeRealtimeRejection {
    this.logger.debug(
      {
        userId,
        sessionId,
        tool: rejection.tool,
        reason: rejection.reason,
      },
      'Realtime practice tool call refused',
    );

    return rejection;
  }
}
