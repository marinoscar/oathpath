import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { EngagementModule } from '../engagement/engagement.module';
import { PracticeModule } from '../practice/practice.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';

/**
 * The mock interview's API surface (issue #133, epic #57 / E8).
 *
 * `docs/specs/mock-interview.md` in full. Five routes, one controller, one
 * service, and a pure engine (`./engine`) the service consumes as functions.
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `InterviewsService` without an import line here — the same
 * reason `PracticeModule`, `CivicsModule` and `JourneyModule` all omit it. The
 * clock is infrastructure, not a feature dependency. It IS injected, on every
 * path that needs "now" (`CLAUDE.md`'s "Using the Clock"), which matters here
 * because engagement measures an interview's practice time from
 * `mock_interviews.started_at` to each attempt's `answered_at` — two instants a
 * test has to be able to pin with `X-Test-Clock`.
 *
 * ONE CONTROLLER, because every route takes the same posture: `@Auth()` with no
 * permissions, ownership decided per row inside the service through
 * `requireInterview`. There is no admin surface here at all — nobody reads
 * another learner's interview through this module — so there is no second
 * controller with a different gate.
 *
 * ---------------------------------------------------------------------------
 * `PracticeModule` IS IMPORTED, AND THAT IMPORT IS THE POINT OF #133
 * ---------------------------------------------------------------------------
 *
 * What it buys is `AttemptGradingService` and nothing else: the two-rung
 * grading ladder and the `question_mastery` write that follows it. Those used
 * to be private methods on `PracticeService`, reachable only from
 * `recordAttempt`; #133 extracted them precisely so a civics answer given in a
 * mock interview is graded by the EXACT same code a practice answer is
 * (`mock-interview.md` §6: "reached through one shared injectable, so there is
 * exactly one grading ladder in the codebase, never two independently-maintained
 * ones that could silently drift apart on what counts as correct").
 *
 * A second ladder is not a hypothetical tidiness concern. The rungs encode
 * product decisions that must not diverge between the two surfaces — the
 * short-circuit that spends no AI credit on a verified match, the refusal to
 * escalate a `state_required` attempt with an empty answer list, and rung 3's
 * rule that an unconfigured or exhausted key degrades to the deterministic
 * verdict instead of a 500. A copy would drift on each of those silently, and a
 * learner would be graded differently depending on which screen they were
 * looking at — which, in an interview that ends by telling them whether they
 * passed, is the one place that difference would matter most.
 *
 * `PracticeService` itself is exported by that module too and is deliberately
 * NOT injected here. An interview is not a practice session and must not become
 * one: `mock-interview.md` §15 records why a `mock_interview` variant of
 * `practice_sessions` lost, and reaching for `PracticeService` would be that
 * rejected design arriving through the service layer instead of the schema.
 *
 * The dependency runs one way only. `PracticeModule` does not import this one,
 * and must not — nothing in the practice loop needs an interview.
 *
 * ---------------------------------------------------------------------------
 * `AiModule` IS IMPORTED, AND THE IMPORT LINE IS ITSELF THE POINT
 * ---------------------------------------------------------------------------
 *
 * That module is deliberately not `@Global()` — its own header says why: it can
 * reach a plaintext-returning credential service, so the set of modules able to
 * reach it should stay a list a person can read, which means every consumer
 * writes this import and shows up in a diff. This is that diff.
 *
 * What it buys is `AiDispatchService` and nothing else. `AiModule` exports the
 * provider token too, and `InterviewsService` may never inject THAT: a caller
 * holding a provider resolves its own model id and its own key, which reopens
 * both holes `ai-evaluation.md` §3 closed — an officer-phrasing call bound to
 * whatever model an admin configured for a costlier role, and an inference path
 * that could read a credential other than the caller's own. This module asks
 * for a ROLE (`tutor`) and gets whatever the administrator bound to it.
 *
 * ---------------------------------------------------------------------------
 * `ReadinessModule` AND `EngagementModule`
 * ---------------------------------------------------------------------------
 *
 * `ReadinessModule` for `ReadinessService.recomputeSnapshot`, which
 * `completeInterview` calls synchronously, in-request, after its own completion
 * write commits (`readiness-model.md` §7(a): "No job queue... readiness
 * recompute run[s] synchronously, inside the request... that produces the
 * evidence"). This epic is what finally gives the `interview` component
 * something to read: §13's `mockInterviewsPassed` stops being a literal zero.
 *
 * `EngagementModule` for `EngagementService.recordInterviewAttemptActivity` —
 * an interview answer is real practice and must accrue toward the day, exactly
 * as a practice answer does (`habit-streaks.md` §2.1). Called after the
 * attempt's own transaction commits, and wrapped so a failure is logged and
 * swallowed.
 *
 * Both dependencies run one way only, exactly as they do for `PracticeModule`.
 * Neither module imports this one, and `ReadinessModule` in particular must not:
 * it reads `mock_interviews` DIRECTLY through Prisma for §13's count — the same
 * posture it already takes toward `practice_attempts` — so importing back would
 * be a cycle for a dependency it does not have.
 *
 * No `NotificationsModule` and no audit write: rehearsing an interview notifies
 * nobody and is not a privileged act. And no new permission string — §12, and
 * the same reason every learner-owned module in this codebase gives.
 */
@Module({
  imports: [
    PrismaModule,
    AiModule,
    PracticeModule,
    ReadinessModule,
    EngagementModule,
  ],
  controllers: [InterviewsController],
  providers: [InterviewsService],
  exports: [InterviewsService],
})
export class InterviewsModule {}
