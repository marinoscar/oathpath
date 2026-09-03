import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { MasteryState } from '../practice/mastery/scheduler';
import type { ProgressMasteryResponse } from './dto/progress-mastery.dto';

// =============================================================================
// ProgressService (issue #86, epic #54 / E5 "Memory")
// =============================================================================
//
// One method today: the read aggregate behind `GET /api/progress/mastery`
// (memory-model.md §8). It computes nothing and schedules nothing — it never
// calls `nextSchedule`, and it never writes `question_mastery` — it only
// counts rows that `PracticeService` already wrote.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// Same posture as `JourneyService`, `CivicsService` and `PracticeService`: no
// method here takes a user id or a state code as a parameter, because the
// controller has no parameter that could carry either — the caller's own
// `learner_profiles` row is the only source of "which test version".
//
// -----------------------------------------------------------------------------
// NO SHARED "RESOLVE THE CALLER'S TEST VERSION" HELPER EXISTS TO CALL
// -----------------------------------------------------------------------------
//
// `CivicsService.findProfile`, `PracticeService.loadProfile` and
// `JourneyService.getProfile` each read `learner_profiles.testVersionCode`
// themselves rather than share one function — three small, differently-scoped
// reads (civics needs `stateCode`, practice needs `stateCode` and
// `seniorExemption` too, journey upserts) rather than one over-general helper.
// `requireOrientedProfile` below follows that same precedent instead of
// inventing the shared helper none of the three already extracted: this
// endpoint's own need (one column, and a hard requirement that it be set) is
// narrower still.
// =============================================================================

/** Every `MasteryState` at zero — the shape both the version-wide and each category's `byState` start from. */
function zeroStateCounts(): Record<MasteryState, number> {
  return { new: 0, learning: 0, review: 0, lapsed: 0, mastered: 0 };
}

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Coverage and mastery, by category, for the caller's own resolved test
   * version (memory-model.md §8).
   *
   * Three bounded queries, none of them a join across the whole
   * `question_mastery` table:
   *
   *  1. This version's categories, in render order — the same
   *     `sortOrder`/`code` ordering `CivicsService.listCategories` already
   *     uses, so a category list here and on `GET
   *     /api/civics/versions/{code}/categories` render in the same order.
   *  2. This version's questions — id and category only; no prompt, no
   *     answers, nothing this endpoint does not use.
   *  3. This caller's `question_mastery` rows for exactly those question ids
   *     — bounded by an `id IN (...)` list the same way
   *     `PracticeService.loadMasteryByQuestionId` bounds its own read,
   *     rather than `where: { userId }` alone, which would drag in mastery
   *     rows for every other test version the learner has ever touched.
   *
   * A question with no mastery row counts as `new` — the same "absence is the
   * default" reading `mastery/selector.ts`'s `classifyMasteryBucket` already
   * gives it (memory-model.md §2), computed here directly rather than through
   * that function: this endpoint groups by five states, not five *selector*
   * buckets, and the two are genuinely different shapes (a `review` row not
   * yet due is `steady` to the selector but `review` here — this endpoint
   * reports the stored `state` column verbatim, not "what would a session
   * serve next").
   *
   * `totalQuestions` is the version's full bank, unfiltered by
   * `seniorEligible` — this is coverage of the official bank a learner will
   * be examined on, not of a session's own candidate pool under the 65/20
   * accommodation, which is why it does not read `seniorExemption` off the
   * profile the way `PracticeService.candidateQuestions` does.
   */
  async getMasteryProgress(userId: string): Promise<ProgressMasteryResponse> {
    const testVersionCode = await this.requireOrientedTestVersionCode(userId);

    const [categories, questions] = await Promise.all([
      this.prisma.civicsCategory.findMany({
        where: { testVersionCode },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { id: true, name: true },
      }),
      this.prisma.civicsQuestion.findMany({
        where: { testVersionCode },
        select: { id: true, categoryId: true },
      }),
    ]);

    const stateByQuestionId = await this.loadMasteryStateByQuestionId(
      userId,
      questions.map((question) => question.id),
    );

    const overallByState = zeroStateCounts();
    const categoryStats = new Map(
      categories.map((category) => [
        category.id,
        { totalQuestions: 0, byState: zeroStateCounts() },
      ]),
    );

    for (const question of questions) {
      const state = stateByQuestionId.get(question.id) ?? 'new';
      overallByState[state] += 1;

      const stats = categoryStats.get(question.categoryId);
      if (stats) {
        stats.totalQuestions += 1;
        stats.byState[state] += 1;
      }
    }

    return {
      testVersionCode,
      totalQuestions: questions.length,
      attempted: questions.length - overallByState.new,
      byState: overallByState,
      categories: categories.map((category) => {
        const stats = categoryStats.get(category.id)!;
        return {
          categoryId: category.id,
          categoryName: category.name,
          totalQuestions: stats.totalQuestions,
          byState: stats.byState,
          masteredCount: stats.byState.mastered,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The caller's own resolved test version, or a 400.
   *
   * There is no honest progress report for a learner whose test version has
   * not been resolved yet — the same guard `PracticeService.getQueue` applies
   * before computing its own mastery-derived counts, for the identical
   * reason: `RequireOrientation` (web) blocks an unoriented learner from ever
   * reaching this route in the app's own screens, so this is unreachable
   * through the product itself and exists only to give a direct API caller an
   * actionable 400 rather than a report scoped to nothing.
   */
  private async requireOrientedTestVersionCode(userId: string): Promise<string> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { testVersionCode: true },
    });

    if (!profile?.testVersionCode) {
      throw new BadRequestException(
        'Finish orientation before viewing progress — your civics test version has not been resolved yet',
      );
    }

    return profile.testVersionCode;
  }

  /**
   * This caller's `question_mastery.state` for exactly the given question
   * ids — never the whole snapshot `mastery/selector.ts` reads, because this
   * endpoint groups by the stored state alone and has no use for `dueAt`,
   * `lapses`, `correctStreak` or `lastAttemptAt`.
   */
  private async loadMasteryStateByQuestionId(
    userId: string,
    questionIds: readonly string[],
  ): Promise<ReadonlyMap<string, MasteryState>> {
    if (questionIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.questionMastery.findMany({
      where: { userId, questionId: { in: questionIds as string[] } },
      select: { questionId: true, state: true },
    });

    return new Map(rows.map((row) => [row.questionId, row.state]));
  }
}
