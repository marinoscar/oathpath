import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { EngagementModule } from '../engagement/engagement.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';

/**
 * The practice loop's API surface (issue #73, epic #52 / E3).
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `PracticeService` without an import line here — the same reason
 * `CivicsModule` and `JourneyModule` both omit it. The clock is infrastructure,
 * not a feature dependency, and a per-module import would add a line that tells
 * a reader nothing the constructor does not already say.
 *
 * `CivicsModule` is not imported either, and that is worth stating because this
 * module clearly depends on civics content. What it depends on is
 * `civics/answer-resolution.ts` — a pure, dependency-free module imported as a
 * FUNCTION, not as a provider — plus direct reads of `civics_questions` and
 * `civics_answers` through Prisma. Importing `CivicsModule` to reach
 * `CivicsService` would buy nothing: its `getQuestion` resolves and returns
 * ANSWERS, which is exactly the shape practice must not have in hand while it
 * is choosing a question to ask.
 *
 * One controller, because every route takes the same posture: `@Auth()` with no
 * permissions, ownership decided per row inside the service. There is no admin
 * surface here at all — nobody reads another learner's practice history through
 * this module, so there is no second controller with a different gate the way
 * `CivicsModule` needs one.
 *
 * `AiModule` IS imported, and the import line is the point (issue #116, E4).
 * That module is deliberately not `@Global()` — its own header says why: it can
 * reach a plaintext-returning credential service, so the set of modules able to
 * reach it should stay a list a person can read, which means every consumer
 * writes this import and shows up in a diff. This is that diff.
 *
 * What that import buys is `AiDispatchService` and nothing else. `AiModule`
 * exports the provider token too, and `PracticeService` must never inject it:
 * a caller holding a provider resolves its own model id and its own key, which
 * reopens both holes `ai-evaluation.md` §3 closed — a per-answer grading call
 * bound to whatever model an admin configured for a costlier role, and an
 * inference path that could read a credential other than the caller's own. The
 * grading ladder asks for a ROLE and gets whatever the administrator bound to
 * it.
 *
 * No `NotificationsModule` and no `AuditModule`-equivalent write: answering a
 * civics question notifies nobody and is not a privileged act
 * (practice-sessions.md §10). `PracticeService` is exported because E4 (#53)
 * extends the grading path and E5 reads this module's evidence — both of which
 * are a service injection, not a new copy of the loop.
 *
 * `ReadinessModule` IS imported (issue #122, epic #55 / E6), for
 * `ReadinessService.recomputeSnapshot` — `completeSession` calls it
 * synchronously, in-request, after its own write commits
 * (`docs/specs/readiness-model.md` §7(a): "No job queue... readiness
 * recompute run[s] synchronously, inside the request... that produces the
 * evidence"). The dependency runs one way only: `ReadinessModule` does not
 * import this module back — see its own header.
 *
 * `EngagementModule` IS imported (issue #119, epic #56 / E7), for
 * `EngagementService`'s two accrual methods — `recordAttempt` calls one after
 * its own `$transaction` commits and `completeSession` calls the other after
 * its completion write does (`docs/specs/habit-streaks.md` §2.1: "Both call
 * the accrual service after their own write has committed... accrual is not
 * part of what makes the attempt or the completion valid, so it must not be
 * able to roll either one back"). Unlike the readiness call beside it, each
 * accrual call is wrapped so a failure is logged and swallowed — see both
 * call sites.
 *
 * The dependency runs one way only, exactly as it does for readiness:
 * `EngagementModule` does not import this module back, and must not. It reads
 * `practice_sessions` and `practice_attempts` directly through Prisma for
 * §2.3's time slice rather than through `PracticeService` — the same posture
 * `ProgressService` takes toward `question_mastery` — so importing back would
 * be a cycle for a dependency it does not have.
 */
@Module({
  imports: [PrismaModule, AiModule, ReadinessModule, EngagementModule],
  controllers: [PracticeController],
  providers: [PracticeService],
  exports: [PracticeService],
})
export class PracticeModule {}
