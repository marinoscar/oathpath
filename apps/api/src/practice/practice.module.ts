import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { EngagementModule } from '../engagement/engagement.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { SettingsModule } from '../settings/settings.module';
import { AttemptGradingService } from './attempt-grading.service';
import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';
import { PracticeRealtimeService } from './realtime/practice-realtime.service';

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
 * What that import buys is `AiDispatchService` and nothing else, and since
 * #133 exactly one class in this module injects it: `AttemptGradingService`.
 * `AiModule` exports the provider token too, and neither of this module's
 * services may ever inject THAT: a caller holding a provider resolves its own
 * model id and its own key, which reopens both holes `ai-evaluation.md` §3 closed — a per-answer grading call
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
 * TWO PROVIDERS ARE EXPORTED, AND THE SECOND IS THE POINT OF #133.
 * `AttemptGradingService` owns the two-rung grading ladder and the
 * `question_mastery` write that follows it — code that used to be four private
 * methods on `PracticeService`, reachable only from `recordAttempt`. E8's mock
 * interview must grade a civics answer by the EXACT same ladder, so
 * `InterviewsModule` imports THIS module and injects that service rather than
 * carrying a second copy of the rules: `mock-interview.md` §6 asks for "one
 * shared injectable so there is only one ladder in the codebase", and an
 * export is what makes that reachable without one.
 *
 * A second ladder is not a hypothetical tidiness concern. The rungs encode
 * product decisions that must not diverge between the two surfaces — the
 * short-circuit that spends no AI credit on a verified match, the refusal to
 * escalate a `state_required` attempt with an empty answer list, and rung 3's
 * rule that an unconfigured or exhausted key degrades to the deterministic
 * verdict instead of a 500. A copy would drift on each of those silently, and
 * a learner would be graded differently depending on which screen they were
 * looking at.
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
 *
 * `SettingsModule` IS imported (issue #319, epic #305 / E14), for exactly one
 * read: `UserSettingsService.readCoachPreferences`, which tells
 * `AttemptGradingService` which voice to write the grader's `feedback`
 * sentence in. The namespace's own service rather than a cast of the JSONB
 * column at the call site — the same posture `SpeechAudioModule` already takes
 * for `voice.preferredVoice`, and for the reason `readCoachPreferences`'s own
 * comment gives: the sparse-namespace contract belongs to that service, and a
 * second reader of the column is the first place it can be interpreted
 * differently.
 *
 * NO CYCLE, and it is worth stating rather than assuming, because this module
 * already imports four others. `SettingsModule` imports NOTHING — its
 * `@Module` has no `imports` array at all — and `UserSettingsService`'s only
 * constructor dependency is `PrismaService`. There is no path back from
 * settings to practice, to AI, to readiness or to engagement, so the edge this
 * line adds is a leaf.
 *
 * `PracticeRealtimeService` (issue #353, epic #345 / E15) is the module's third
 * provider and the only one that injects `AiDispatchService` DIRECTLY. That is
 * worth stating rather than leaving to be noticed, because the paragraph above
 * says neither of this module's services may inject the provider token — and
 * that rule is unchanged: this service asks the dispatcher to mint a credential
 * for the `realtime` ROLE and never names a model, a provider or a key, exactly
 * as `AttemptGradingService` asks for the `grader` role.
 *
 * It is NOT exported. Nothing outside this module mints a practice session's
 * realtime credential, and the day something does, the export should be a
 * deliberate edit rather than a capability that was already sitting there. It
 * is also deliberately a separate class from `PracticeService` rather than a
 * method on it: that class holds no dispatcher at all (see its own header), and
 * E15 does not change it.
 *
 * It buys a TONE and never a grade. `grading.ts`'s
 * `GRADING_PERSONA_SCOPE_NOTICE` says so in the prompt, `gradingVerdictSchema`
 * still has exactly three fields, and `AttemptGradingService.resolvePersona`
 * degrades a failed settings read to the default persona rather than
 * propagating it: a preference must never be able to cost a learner their
 * answer.
 */
@Module({
  imports: [
    PrismaModule,
    AiModule,
    ReadinessModule,
    EngagementModule,
    SettingsModule,
  ],
  controllers: [PracticeController],
  providers: [AttemptGradingService, PracticeService, PracticeRealtimeService],
  exports: [AttemptGradingService, PracticeService],
})
export class PracticeModule {}
