import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { AiDispatchService } from '../../ai/ai-dispatch.service';
import type { AiModelRole } from '../../ai/ai-model-roles';
import { PracticeService } from '../practice.service';
import type { PracticeRealtimeSessionResponse } from '../dto/practice-realtime-session.dto';
import { buildPracticeRealtimeInstructions } from './practice-realtime-instructions';
import { decideRealtimeMint } from './practice-realtime-mint';
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
// =============================================================================

@Injectable()
export class PracticeRealtimeService {
  private readonly logger = new Logger(PracticeRealtimeService.name);

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
}
