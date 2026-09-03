import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ReadinessService } from '../readiness.service';

// =============================================================================
// The nightly readiness recompute (issue #122, epic #55 / E6 "Readiness
// and Progress")
// =============================================================================
//
// `docs/specs/readiness-model.md` §7(b). Mirrors
// `apps/api/src/auth/tasks/token-cleanup.task.ts`'s exact shape — the same
// `@Cron(CronExpression.EVERY_DAY_AT_3AM)` hour, "a shared, uncontested hour
// with no other cron competing for it" — and lives in `ReadinessModule`'s
// own `providers` array rather than a separate "tasks module", exactly as
// that file does in `AuthModule`.
//
// Recomputes every active user's snapshot so `consistency`'s 14-day window
// (§2.4) and any stage transition decay honestly while a learner is away,
// rather than only ever moving forward on a day they happen to open the app.
//
// **Never calls AI.** `ReadinessService.recomputeSnapshot` writes `score`,
// `stage`, `components`, `evidenceCounts`, `capReason` and
// `topRecommendation` only, leaving `narrative`/`narrativeGeneratedAt`
// untouched on every row it creates — narrative generation is
// request-triggered only (§9), because a user's BYOK key is not available
// outside a request from that user (`ROADMAP.md` §7).
// =============================================================================

@Injectable()
export class ReadinessRecomputeTask {
  private readonly logger = new Logger(ReadinessRecomputeTask.name);

  constructor(private readonly readinessService: ReadinessService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    this.logger.log('Running nightly readiness recompute');

    const { recomputed } = await this.readinessService.recomputeAllActiveUsers();

    this.logger.log(`Nightly readiness recompute completed: ${recomputed} snapshot(s) recomputed`);
  }
}
