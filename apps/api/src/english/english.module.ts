import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EnglishController } from './english.controller';
import { EnglishService } from './english.service';

/**
 * The English reading and writing tests (issue #136, epic #59 / E10).
 *
 * One controller, three routes, one service, and two pure modules beside it
 * (`english-scoring.ts`, `sentence-selection.ts`) that this module does not
 * need to declare because they are imports, not providers.
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects without an import line here — the same reason `PracticeModule`,
 * `JourneyModule` and `CivicsModule` all omit it. Not moot for this module, as
 * it is for `ProgressModule`: `EnglishService` really does read the clock, to
 * stamp `english_attempts.answeredAt`.
 *
 * `AiModule` is NOT imported, and that absence is worth stating because it
 * looks like it should be there. This module makes no AI call of any kind: a
 * reading attempt's audio is transcribed by `POST /api/ai/speech/transcribe`
 * BEFORE it ever reaches this surface (english-test.md §3 — "this epic is a new
 * caller of the speech surface E9 already shipped, not a second implementation
 * of it"), and dictation for the writing test is the browser's own
 * `speechSynthesis` by default (§4). All this module imports from `ai` is one
 * constant, `ASR_CONFIDENCE_THRESHOLD` — a value, not a provider. Scoring is
 * deterministic (`english-scoring.ts`) and there is no AI grader rung here at
 * all, unlike practice's two-rung ladder.
 *
 * `ReadinessModule` and `EngagementModule` are not imported either, and both
 * omissions are deliberate rather than pending work. §6.5: English attempts add
 * NO new recompute trigger — the nightly pass and the stale-on-read check
 * already pick the evidence up, and "exactly two, and no third" is
 * readiness-model.md §7's own rule. Engagement is not wired for the same reason
 * plus a simpler one: there is no session-completion event here to accrue
 * against (§5's "no session" note).
 *
 * No admin surface: nobody reads another learner's English attempts through
 * this module, so there is no second controller with a different gate.
 *
 * ---------------------------------------------------------------------------
 * `EnglishService` IS EXPORTED (issue #158, epic #60 / E11)
 * ---------------------------------------------------------------------------
 *
 * For one consumer: `InterviewsModule`, whose realtime transport conducts the
 * reading and writing segments for real inside a mock interview
 * (`docs/specs/realtime-interview.md` §5) instead of announcing them as
 * skipped. It calls `getNext` and `recordAttempt` — the same two methods
 * `/practice/reading` posts to — so a sentence read aloud to an officer is
 * chosen by the same selector and scored by the same word-error-rate rule as
 * one read on the practice screen, and lands in the same `english_attempts`
 * table.
 *
 * The alternative was a second scorer inside the interviews module, and it
 * would have drifted on three things that are product decisions rather than
 * implementation details: which sentence comes next, where the misheard gate
 * falls, and what counts as a correct reading. A learner scored differently
 * depending on which screen they were looking at is the exact failure
 * `mock-interview.md` §6 already rejected for civics grading.
 *
 * The dependency runs ONE WAY. This module does not import `InterviewsModule`
 * and must not — nothing in the reading or writing loop needs an interview.
 */
@Module({
  imports: [PrismaModule],
  controllers: [EnglishController],
  providers: [EnglishService],
  exports: [EnglishService],
})
export class EnglishModule {}
