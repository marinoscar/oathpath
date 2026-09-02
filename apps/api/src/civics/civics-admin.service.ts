import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { Clock } from '../common/clock/clock';
import { US_STATE_AND_TERRITORY_CODES } from '../common/constants/us-states.constants';
import { PrismaService } from '../prisma/prisma.service';
import type { CivicsDynamicAnswerQuery } from './dto/civics-dynamic-answer-query.dto';
import type {
  CivicsAdminScope,
  CivicsDynamicAnswerItem,
  CivicsDynamicAnswerResponse,
  CivicsDynamicAnswerUpdateResult,
} from './dto/civics-dynamic-answer.dto';
import {
  realWorldInstantAsDate,
  type UpdateCivicsDynamicAnswer,
} from './dto/update-civics-dynamic-answer.dto';

// =============================================================================
// CivicsAdminService (issue #117, epic #51)
// =============================================================================
//
// The only write path into `civics_answers` that is not a content PR, and the
// read that goes with it. civics-content.md §9 is the contract; §4 is the
// lifecycle it performs.
//
// -----------------------------------------------------------------------------
// A CORRECTION CLOSES A ROW AND OPENS A ROW. IT NEVER EDITS ONE.
// -----------------------------------------------------------------------------
//
// There is no method here that sets `text` on an existing `civics_answers`
// row, and there is no request shape that could ask for one — the correction
// is addressed by SLOT (`questionId` + `stateCode`), not by answer id.
//
// The reason is E3, which does not exist yet: `practice_attempts.answer_snapshot`
// will record, at grading time, the answer a learner was actually graded
// against. An in-place edit would leave that snapshot pointing at a row whose
// text has since changed into something the learner was never shown, so a past
// "you got this right" becomes unexplainable with nothing anywhere recording
// that it happened. Closing and opening keeps every superseded row intact and
// readable; only its `effectiveTo` moves.
//
// -----------------------------------------------------------------------------
// WHY `none` SCOPE IS A 400 AND NOT A CONVENIENCE
// -----------------------------------------------------------------------------
//
// Static content changes through the reviewed content-PR-and-reseed path
// (civics-content.md §6-§7), whose structural validator (#101) is what
// enforces the invariants Postgres cannot see — that a `state` question covers
// all 56 codes, that a dynamic question occupies exactly one slot, that the
// senior-eligible count matches the version's own figure. An admin route that
// wrote a `none`-scope answer would be a second way into the same rows that
// skips every one of those checks, and it would do it with no content diff for
// anybody to review. So the scope is rejected at the door with a message that
// names the path that DOES apply, rather than quietly widened.
//
// -----------------------------------------------------------------------------
// THIS FILE CONSTRUCTS NO `Date` OF ITS OWN
// -----------------------------------------------------------------------------
//
// `verifiedAt` and the `effectiveFrom` fallback both come from
// `this.clock.now()`. A caller-supplied `effectiveFrom` is converted by the
// schema in `update-civics-dynamic-answer.dto.ts` — a parse, not a clock read,
// but routed through zod anyway so the grep civics-content.md §10 asks for
// stays literally empty across this module. An exception "just for parsing" is
// how a grep stops being worth running.
// =============================================================================

/** The two scopes this surface administers. `none` is not addressable here. */
const ADMIN_SCOPES = ['national', 'state'] as const satisfies readonly CivicsAdminScope[];

/**
 * The slot a correction uses when the question has no open answer at all.
 *
 * civics-content.md §3.1: a `national`- or `state`-scope question occupies
 * exactly one slot, and it is `0`. When a row IS already open the correction
 * reuses ITS slot instead of this constant — see {@link CivicsAdminService.updateDynamicAnswer}.
 */
const DEFAULT_SLOT = 0;

/** The audit action every correction records. One string, one place. */
export const CIVICS_DYNAMIC_ANSWER_UPDATE_ACTION = 'civics:dynamic_answer_update';

/**
 * The `audit_events.target_type` a correction is filed under.
 *
 * The QUESTION, not the answer row — deliberately, and unlike
 * `ai_settings:replace`, whose target is the row it wrote. Every correction
 * creates a NEW answer row, so filing under the answer id would give each
 * audit row a target that appears exactly once, and `@@index([targetType,
 * targetId])` could never answer the question a reviewer actually asks: "show
 * me every change to this answer." The question id is stable across the whole
 * lifecycle, so that query works. Both answer ids are in `meta`.
 */
const CIVICS_QUESTION_TARGET_TYPE = 'civics_question';

/** The question columns this surface reads. */
const ADMIN_QUESTION_SELECT = {
  id: true,
  testVersionCode: true,
  number: true,
  prompt: true,
  categoryId: true,
  dynamicScope: true,
} as const;

interface AdminQuestionRow {
  id: string;
  testVersionCode: string;
  number: number;
  prompt: string;
  categoryId: string;
  dynamicScope: string;
}

interface AnswerRow {
  id: string;
  questionId: string;
  text: string;
  sort: number;
  stateCode: string | null;
  verifiedAt: Date;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceNote: string | null;
}

@Injectable()
export class CivicsAdminService {
  private readonly logger = new Logger(CivicsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/civics/dynamic-answers
  // ---------------------------------------------------------------------------

  /**
   * A page of dynamic questions with their currently OPEN answers.
   *
   * "Open" is `effectiveTo IS NULL` — the row a correction will close. That is
   * deliberately NOT the same predicate the learner-facing read uses
   * (`answer-resolution.ts`'s `currentAnswerWhere`, which is clock-relative):
   * a correction entered ahead of time opens a row that is not yet what a
   * learner is served, while the row it closed stays current until then. An
   * administrator must see the row they can act on, so both `effectiveFrom`
   * and `effectiveTo` are on the wire and the difference is legible rather
   * than hidden.
   *
   * The page is over QUESTIONS. A `state` question's 56 answers are one
   * editable unit and a page boundary through the middle of them would serve
   * nobody.
   */
  async listDynamicAnswers(query: CivicsDynamicAnswerQuery): Promise<{
    items: CivicsDynamicAnswerItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize, testVersionCode, dynamicScope, stateCode } = query;

    const where: Prisma.CivicsQuestionWhereInput = {
      // Either one requested dynamic scope, or both — never `none`. The filter
      // is on the QUERY rather than applied to the results, so `total` counts
      // what this surface administers and pagination is not silently short.
      dynamicScope: dynamicScope ? dynamicScope : { in: [...ADMIN_SCOPES] },
      ...(testVersionCode ? { testVersionCode } : {}),
    };

    const [questions, total] = await Promise.all([
      this.prisma.civicsQuestion.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ testVersionCode: 'asc' }, { number: 'asc' }],
        select: ADMIN_QUESTION_SELECT,
      }),
      this.prisma.civicsQuestion.count({ where }),
    ]);

    const answers = await this.findOpenAnswersFor(
      questions.map((question) => question.id),
      stateCode,
    );

    const byQuestion = new Map<string, AnswerRow[]>();
    for (const answer of answers) {
      const bucket = byQuestion.get(answer.questionId);
      if (bucket) {
        bucket.push(answer);
      } else {
        byQuestion.set(answer.questionId, [answer]);
      }
    }

    return {
      items: questions.map((question) =>
        this.toItem(question, byQuestion.get(question.id) ?? [], stateCode),
      ),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ---------------------------------------------------------------------------
  // PUT /api/civics/dynamic-answers
  // ---------------------------------------------------------------------------

  /**
   * Correct one dynamic answer, by closing the open row and opening a new one.
   *
   * The sequence, all of it inside ONE `$transaction` (civics-content.md §4.1
   * step 3):
   *
   *   1. re-read the open row for the slot, INSIDE the transaction, so the row
   *      that gets closed is the row that was open at write time;
   *   2. `UPDATE` it, setting `effective_to` to this correction's
   *      `effectiveFrom` — the two rows meet exactly there, no gap, no overlap;
   *   3. `INSERT` the new row into the SAME slot, `effective_to` null;
   *   4. `INSERT` the audit row.
   *
   * A reader must never observe zero open rows for the slot (the question
   * would appear to have no current answer, when it manifestly does) nor two
   * (the bug the partial unique index exists to prevent). One transaction is
   * what guarantees both.
   *
   * **`civics_answers_open_slot_unique` is the backstop, not the mechanism.**
   * If step 2 were ever dropped, step 3 collides on
   * `(question_id, COALESCE(state_code,''), sort)` and the whole transaction
   * fails at the database — loudly, instead of silently producing two
   * simultaneously current Speakers. Nothing here works around that index; a
   * violation surfacing means this method is wrong.
   *
   * **The new row reuses the OPEN row's slot rather than hardcoding 0.** §3.3
   * records that the database cannot enforce "a dynamic question uses only
   * slot 0" — an index predicate cannot see the question's `dynamic_scope` —
   * so a mis-loaded row at `sort: 1` is possible. Correcting it in place keeps
   * one open slot; writing to slot 0 while slot 1 stayed open would create the
   * second current answer this whole design exists to prevent, and would do it
   * from the surface meant to fix such things.
   *
   * The audit row is written inside the transaction rather than after it, and
   * that is the one place this differs from `ai_settings:replace` (which has
   * no transaction to be inside). A correction that committed without its
   * audit row would be exactly the change a reviewer cannot explain later: the
   * closed row keeps its own text, but who changed it, when, and on what
   * citation live only here.
   */
  async updateDynamicAnswer(
    actorUserId: string,
    body: UpdateCivicsDynamicAnswer,
  ): Promise<CivicsDynamicAnswerUpdateResult> {
    const question = await this.prisma.civicsQuestion.findUnique({
      where: { id: body.questionId },
      select: ADMIN_QUESTION_SELECT,
    });

    if (!question) {
      throw new NotFoundException(
        `Civics question "${body.questionId}" not found`,
      );
    }

    const scope = this.assertAdministrableScope(question);
    const stateCode = this.resolveTargetState(scope, body.stateCode ?? null);

    const now = this.clock.now();
    const effectiveFrom = body.effectiveFrom
      ? realWorldInstantAsDate.parse(body.effectiveFrom)
      : now;

    const { previous, current } = await this.prisma.$transaction(async (tx) => {
      const open = await tx.civicsAnswer.findFirst({
        where: { questionId: question.id, stateCode, effectiveTo: null },
        orderBy: { sort: 'asc' },
      });

      if (open && open.effectiveFrom.getTime() > effectiveFrom.getTime()) {
        // Closing a row before it opened would give it a negative interval,
        // and E3 could no longer say which answer applied on a given date.
        throw new BadRequestException(
          `effectiveFrom (${effectiveFrom.toISOString()}) is earlier than the current answer's own ` +
            `effectiveFrom (${open.effectiveFrom.toISOString()}); a correction cannot take effect ` +
            'before the answer it replaces did',
        );
      }

      const slot = open?.sort ?? DEFAULT_SLOT;

      const closed = open
        ? await tx.civicsAnswer.update({
            where: { id: open.id },
            data: { effectiveTo: effectiveFrom },
          })
        : null;

      const created = await tx.civicsAnswer.create({
        data: {
          questionId: question.id,
          text: body.text,
          sort: slot,
          stateCode,
          // Always the clock, never the caller: `verifiedAt` records that a
          // HUMAN confirmed this text, and the human is this caller, now.
          verifiedAt: now,
          effectiveFrom,
          effectiveTo: null,
          sourceNote: body.sourceNote,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorUserId,
          action: CIVICS_DYNAMIC_ANSWER_UPDATE_ACTION,
          targetType: CIVICS_QUESTION_TARGET_TYPE,
          targetId: question.id,
          meta: {
            // RECORDED IN FULL, unlike `journey:profile_update`, which redacts
            // every field value because a learner's profile is private. A
            // civics answer is the opposite of private — it is public exam
            // content whose whole purpose is to be shown to every learner — so
            // the diff itself is what belongs here. A reviewer asking "why
            // does this say a different name than it did last month" needs the
            // before and after in the audit row, not a pointer to a row that
            // has since closed and is easy to overlook (civics-content.md §9).
            questionId: question.id,
            testVersionCode: question.testVersionCode,
            questionNumber: question.number,
            prompt: question.prompt,
            dynamicScope: scope,
            stateCode,
            sort: slot,
            previousAnswerId: closed?.id ?? null,
            previousText: closed?.text ?? null,
            previousSourceNote: closed?.sourceNote ?? null,
            previousEffectiveFrom: closed?.effectiveFrom.toISOString() ?? null,
            answerId: created.id,
            newText: created.text,
            newSourceNote: created.sourceNote,
            effectiveFrom: created.effectiveFrom.toISOString(),
            verifiedAt: created.verifiedAt.toISOString(),
            // Whether the caller supplied a real-world date or the clock stood
            // in for one (§4's stated fallback). Without this an auditor cannot
            // tell a sourced date from "whenever the button was pressed".
            effectiveFromSource: body.effectiveFrom ? 'submitted' : 'clock',
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { previous: closed, current: created };
    });

    if (!previous) {
      // Not an error: content may simply never have been loaded for this
      // state, which is what `missingStateCodes` reports on the read side.
      // Worth a line, because "the first answer this slot has ever had" and
      // "a correction" look identical in the response.
      this.logger.warn(
        `Opened the first answer for civics question ${question.id}` +
          `${stateCode ? ` (${stateCode})` : ''} — no open row existed to close`,
      );
    }

    return {
      questionId: question.id,
      testVersionCode: question.testVersionCode,
      number: question.number,
      prompt: question.prompt,
      categoryId: question.categoryId,
      dynamicScope: scope,
      stateCode,
      previous: previous ? toAnswerResponse(previous) : null,
      current: toAnswerResponse(current),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The question's scope, or a 400 naming the path that does apply.
   *
   * A `none`-scope question is rejected rather than edited: allowing it would
   * route around #101's structural validation and the human review a content
   * PR carries, which is the whole provenance guarantee (civics-content.md §9).
   */
  private assertAdministrableScope(question: AdminQuestionRow): CivicsAdminScope {
    const scope = question.dynamicScope;

    if (scope !== 'national' && scope !== 'state') {
      throw new BadRequestException(
        `Civics question ${question.number} (${question.testVersionCode}) has dynamicScope ` +
          `"${scope}" and is not administered here. Only "national" and "state" answers change ` +
          'on their own; a static answer is corrected through a reviewed content change, so that ' +
          'the correction carries provenance and is validated before it reaches a learner.',
      );
    }

    return scope;
  }

  /**
   * The `state_code` this correction writes, or a 400.
   *
   * Both mismatches are rejected rather than tolerated. A `stateCode` ignored
   * on a national question would let an admin believe they had corrected one
   * state's copy of a national fact; a missing one on a state question would
   * have to guess a state, which §5 refuses to do on the learner side for the
   * same reason.
   */
  private resolveTargetState(
    scope: CivicsAdminScope,
    submitted: string | null,
  ): string | null {
    if (scope === 'national') {
      if (submitted) {
        throw new BadRequestException(
          'stateCode must be omitted for a national answer: the answer does not vary by state, ' +
            'and a per-state national row would be unreachable by every learner.',
        );
      }
      return null;
    }

    if (!submitted) {
      throw new BadRequestException(
        'stateCode is required for a state-scoped answer: each state has its own answer, and ' +
          'there is no state this correction could safely be assumed to mean.',
      );
    }

    return submitted;
  }

  /**
   * Every OPEN answer for the given questions, optionally narrowed to one state.
   *
   * The state filter keeps `stateCode: null` rows too, so a `national`
   * question on the same page still carries its answer — its answer does not
   * vary by state and dropping it would make the page look broken. The
   * per-question sorting below is what keeps a null-state row from leaking
   * into a `state` question's list.
   */
  private async findOpenAnswersFor(
    questionIds: string[],
    stateCode: string | undefined,
  ): Promise<AnswerRow[]> {
    if (questionIds.length === 0) {
      return [];
    }

    return this.prisma.civicsAnswer.findMany({
      where: {
        questionId: { in: questionIds },
        effectiveTo: null,
        ...(stateCode ? { OR: [{ stateCode }, { stateCode: null }] } : {}),
      },
      orderBy: [{ stateCode: 'asc' }, { sort: 'asc' }],
    });
  }

  /** One question plus its open answers and its state gaps. */
  private toItem(
    question: AdminQuestionRow,
    rows: AnswerRow[],
    stateCode: string | undefined,
  ): CivicsDynamicAnswerItem {
    const scope = question.dynamicScope as CivicsAdminScope;

    // A `national` answer carries no state; a `state` answer carries one. A row
    // on the wrong side of that is mis-loaded content (#101's validator is what
    // catches it at load time) and is not shown under a question it does not
    // belong to.
    const answers =
      scope === 'national'
        ? rows.filter((row) => row.stateCode === null)
        : rows.filter(
            (row) =>
              row.stateCode !== null &&
              (stateCode === undefined || row.stateCode === stateCode),
          );

    if (answers.length !== rows.length) {
      this.logger.warn(
        `Civics question ${question.id} (${scope}) has open answers whose state does not match ` +
          'its scope; they are excluded from the admin list',
      );
    }

    return {
      questionId: question.id,
      testVersionCode: question.testVersionCode,
      number: question.number,
      prompt: question.prompt,
      categoryId: question.categoryId,
      dynamicScope: scope,
      answers: answers.map(toAnswerResponse),
      missingStateCodes: missingStates(scope, answers, stateCode),
    };
  }
}

/**
 * The states in scope of the request that have no open answer.
 *
 * Empty for a `national` question — it has no per-state rows to be missing.
 * For a `state` question narrowed to one code, either that code or nothing;
 * unnarrowed, every one of the 56 codes with no open row, in the constant's
 * own order so two requests never disagree about the order of the gap list.
 */
function missingStates(
  scope: CivicsAdminScope,
  answers: AnswerRow[],
  stateCode: string | undefined,
): string[] {
  if (scope !== 'state') {
    return [];
  }

  const present = new Set(answers.map((answer) => answer.stateCode));
  const inScope = stateCode ? [stateCode] : US_STATE_AND_TERRITORY_CODES;

  return inScope.filter((code) => !present.has(code));
}

/** `civics_answers` row -> the admin wire shape. */
function toAnswerResponse(row: AnswerRow): CivicsDynamicAnswerResponse {
  return {
    id: row.id,
    text: row.text,
    sort: row.sort,
    stateCode: row.stateCode,
    verifiedAt: row.verifiedAt.toISOString(),
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    sourceNote: row.sourceNote,
  };
}
