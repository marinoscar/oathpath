import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import {
  currentAnswerWhere,
  resolveAnswerScope,
  selectAnswers,
  type DynamicScope,
} from './answer-resolution';
import type { CivicsCategoryResponse } from './dto/civics-category.dto';
import type { CivicsTestVersionResponse } from './dto/civics-version.dto';
import type { CivicsQuestionQuery } from './dto/civics-question-query.dto';
import type {
  CivicsAnswerResponse,
  CivicsQuestionDetail,
  CivicsQuestionSummary,
} from './dto/civics-question.dto';

// =============================================================================
// CivicsService (issue #111, epic #51)
// =============================================================================
//
// The read side of the civics question bank: versions, categories, a paginated
// question list, and one question with its answers already resolved for the
// caller.
//
// -----------------------------------------------------------------------------
// EVERY METHOD THAT RESOLVES ANYTHING TAKES A `userId` FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// There is no method here that takes a state code, and none that takes a user
// id from anywhere but the authenticated session — because the controller has
// no parameter that could carry either. A "resolve this question for state X"
// method would be the natural thing for a future caller to reach for, and it
// deliberately does not exist: adding one is a signature change with a visible
// diff, not a query-string edit. Same structural argument `JourneyService`
// makes, and civics-content.md §8 states it as a rule for this surface too.
//
// -----------------------------------------------------------------------------
// THE PROFILE READ IS A READ
// -----------------------------------------------------------------------------
//
// `JourneyService.getProfile` upserts, because a learner with no
// `learner_profiles` row has to be able to complete orientation. Nothing here
// does: a `GET` of reference content has no business creating a row, and a
// missing profile already has a correct meaning — no state, no version — which
// is exactly what an un-oriented learner's blank row would have said anyway.
//
// -----------------------------------------------------------------------------
// THIS FILE CONSTRUCTS NO `Date` OF ITS OWN
// -----------------------------------------------------------------------------
//
// The one notion of "now" this module has is `this.clock.now()`, handed to
// `currentAnswerWhere`. civics-content.md §10 restates the rule for this epic;
// grep this module's non-test sources for a bare `Date` construction and the
// result is empty, comments included.
// =============================================================================

/** Prisma `select` for a question summary — the list's row shape, one place. */
const QUESTION_SUMMARY_SELECT = {
  id: true,
  number: true,
  prompt: true,
  categoryId: true,
  testVersionCode: true,
  seniorEligible: true,
  dynamicScope: true,
} as const;

@Injectable()
export class CivicsService {
  private readonly logger = new Logger(CivicsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Versions and categories — the same for every caller
  // ---------------------------------------------------------------------------

  /**
   * Every `civics_test_versions` row, in code order.
   *
   * Small, cacheable, and — because it carries `contentHash` — the way to
   * confirm which content is actually live (civics-content.md §7).
   */
  async listVersions(): Promise<CivicsTestVersionResponse[]> {
    const versions = await this.prisma.civicsTestVersion.findMany({
      orderBy: { code: 'asc' },
    });

    // Mapped field by field rather than spread, for the reason
    // `JourneyController.listStages` gives: the response shape is decided here,
    // in code that is about the response shape. A spread would make it a
    // consequence of whatever columns the table happens to grow, so a column
    // added later for an internal consumer would silently become public API.
    return versions.map((version) => ({
      code: version.code,
      label: version.label,
      questionsAsked: version.questionsAsked,
      passThreshold: version.passThreshold,
      seniorQuestionsAsked: version.seniorQuestionsAsked,
      seniorPassThreshold: version.seniorPassThreshold,
      contentHash: version.contentHash,
    }));
  }

  /**
   * One version's categories, in `sortOrder`.
   *
   * An unknown version code is a 404 rather than an empty list: "this version
   * does not exist" and "this version has no categories loaded yet" are
   * different facts, and an empty array would make a typo in a client
   * indistinguishable from content that has not been seeded.
   */
  async listCategories(
    testVersionCode: string,
  ): Promise<CivicsCategoryResponse[]> {
    const version = await this.prisma.civicsTestVersion.findUnique({
      where: { code: testVersionCode },
      select: { code: true },
    });

    if (!version) {
      throw new NotFoundException(
        `Civics test version "${testVersionCode}" not found`,
      );
    }

    const categories = await this.prisma.civicsCategory.findMany({
      where: { testVersionCode },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    return categories.map((category) => toCategoryResponse(category));
  }

  // ---------------------------------------------------------------------------
  // Questions
  // ---------------------------------------------------------------------------

  /**
   * A page of question summaries, filtered for the caller.
   *
   * The version filter falls back to the caller's own resolved test version
   * when the query does not name one — see the query DTO for why that is not
   * "every version". No answers are returned: they are per-caller, and
   * civics-content.md §8 keeps them on the detail route.
   */
  async listQuestions(
    userId: string,
    query: CivicsQuestionQuery,
  ): Promise<{
    items: CivicsQuestionSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize, categoryId, seniorEligible } = query;

    const profile = await this.findProfile(userId);
    const testVersionCode = query.testVersionCode ?? profile.testVersionCode;

    const where: Prisma.CivicsQuestionWhereInput = {
      ...(testVersionCode ? { testVersionCode } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(seniorEligible === undefined ? {} : { seniorEligible }),
    };

    const [items, total] = await Promise.all([
      this.prisma.civicsQuestion.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Stable and meaningful: a learner refers to question 43 by its
        // number, and `(testVersionCode, number)` is unique, so this ordering
        // never has to break a tie arbitrarily across pages.
        orderBy: [{ testVersionCode: 'asc' }, { number: 'asc' }],
        select: QUESTION_SUMMARY_SELECT,
      }),
      this.prisma.civicsQuestion.count({ where }),
    ]);

    return {
      items: items.map((item) => toQuestionSummary(item)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * One question, with its answers resolved against the caller's own state.
   *
   * This is the only place civics-content.md §5's table is applied to real
   * rows. The rules themselves live in `answer-resolution.ts`; this method's
   * job is to hand them the caller's state, the clock, and the rows.
   */
  async getQuestion(
    userId: string,
    questionId: string,
  ): Promise<CivicsQuestionDetail> {
    const [question, profile] = await Promise.all([
      this.prisma.civicsQuestion.findUnique({
        where: { id: questionId },
        include: { category: true },
      }),
      this.findProfile(userId),
    ]);

    if (!question) {
      throw new NotFoundException(`Civics question "${questionId}" not found`);
    }

    const scope = question.dynamicScope as DynamicScope;
    const { status, stateCode } = resolveAnswerScope(scope, profile.stateCode);

    // `state_required`: no query at all. There is no state to query FOR, and
    // running one anyway would mean writing a fallback — which is the guess
    // civics-content.md §5 rejects.
    const rows =
      status === 'state_required'
        ? []
        : await this.prisma.civicsAnswer.findMany({
            where: {
              questionId: question.id,
              stateCode,
              ...currentAnswerWhere(this.clock.now()),
            },
            orderBy: [{ sort: 'asc' }, { effectiveFrom: 'desc' }],
          });

    const answers = selectAnswers(scope, rows).map(
      (answer): CivicsAnswerResponse => ({
        id: answer.id,
        text: answer.text,
        sort: answer.sort,
        stateCode: answer.stateCode,
        verifiedAt: answer.verifiedAt.toISOString(),
        sourceNote: answer.sourceNote,
      }),
    );

    if (status === 'state_required') {
      this.logger.debug(
        `Question ${question.id} is state-scoped and the caller has no state set`,
      );
    }

    return {
      ...toQuestionSummary(question),
      category: toCategoryResponse(question.category),
      answerResolution: status,
      resolvedForStateCode: stateCode,
      verifiedAt: latestVerifiedAt(answers),
      answers,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The two fields of the caller's learner profile that resolution reads.
   *
   * A missing row is not an error and not a 404 — it is a learner who has not
   * been through orientation, whose state and version are both simply unknown.
   * That is the same value a blank row would carry, so returning it directly
   * keeps this a pure read (see the header).
   */
  private async findProfile(
    userId: string,
  ): Promise<{ stateCode: string | null; testVersionCode: string | null }> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { stateCode: true, testVersionCode: true },
    });

    return {
      stateCode: profile?.stateCode ?? null,
      testVersionCode: profile?.testVersionCode ?? null,
    };
  }
}

/** `civics_categories` row → wire shape. */
function toCategoryResponse(category: {
  id: string;
  section: string;
  code: string;
  name: string;
  sortOrder: number;
}): CivicsCategoryResponse {
  return {
    id: category.id,
    section: category.section,
    code: category.code,
    name: category.name,
    sortOrder: category.sortOrder,
  };
}

/** `civics_questions` row → summary wire shape. */
function toQuestionSummary(question: {
  id: string;
  number: number;
  prompt: string;
  categoryId: string;
  testVersionCode: string;
  seniorEligible: boolean;
  dynamicScope: string;
}): CivicsQuestionSummary {
  return {
    id: question.id,
    number: question.number,
    prompt: question.prompt,
    categoryId: question.categoryId,
    testVersionCode: question.testVersionCode,
    seniorEligible: question.seniorEligible,
    dynamicScope: question.dynamicScope as DynamicScope,
  };
}

/**
 * The freshest verification across the resolved answers, or null.
 *
 * A pure max over values already read from the database — it reads no clock of
 * any kind, so it is not a hidden wall-clock read.
 */
function latestVerifiedAt(answers: CivicsAnswerResponse[]): string | null {
  if (answers.length === 0) {
    return null;
  }

  // ISO-8601 UTC strings sort lexicographically in chronological order, which
  // is why no date parsing is needed here.
  return answers.reduce(
    (latest, answer) => (answer.verifiedAt > latest ? answer.verifiedAt : latest),
    answers[0].verifiedAt,
  );
}
