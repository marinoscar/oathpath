import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { civicsCategorySchema } from './civics-category.dto';

// =============================================================================
// GET /api/civics/questions and .../:id — response bodies (#111, epic #51)
// =============================================================================
//
// Two shapes, because the two routes answer two different questions and only
// one of them is per-caller.
//
// A SUMMARY IS THE SAME FOR EVERY LEARNER. A DETAIL IS NOT. civics-content.md
// §8 splits them for exactly that reason: resolved answers depend on the
// caller's own `state_code` (§5), so a list that carried them would be
// uncacheable, would be N state lookups wide, and would tempt a client into
// treating one learner's answers as everyone's. The list is public exam
// content; the detail is that content resolved for one person.
// =============================================================================

/** The three values of the `CivicsDynamicScope` Postgres enum, on the wire. */
export const civicsDynamicScopeSchema = z.enum(['none', 'national', 'state']);

export const civicsQuestionSummarySchema = z.object({
  id: z.uuid(),

  /** The official question number within its version — `1..100` on `v2008`. */
  number: z.number().int(),

  /** The question text, verbatim from the official source. */
  prompt: z.string(),

  categoryId: z.uuid(),

  /**
   * Which test version this question belongs to.
   *
   * On every item even though the list is normally filtered to one version,
   * because the filter has a fallback (see the query DTO): a caller who has not
   * finished orientation gets the whole bank, and without this field could not
   * tell the two versions apart.
   */
  testVersionCode: z.string(),

  /** Membership in the 65/20 accommodation's subset. Never affects answers. */
  seniorEligible: z.boolean(),

  /**
   * How this question's answers vary — `none`, `national`, or `state`.
   *
   * On the summary so a client can render the "you'll need to set your state"
   * affordance in a LIST, before anybody opens a question and discovers it. It
   * is a property of the question itself, fixed when the content was
   * transcribed (civics-content.md §2.2), so it is safe to cache alongside the
   * prompt in a way the resolved answer never is.
   */
  dynamicScope: civicsDynamicScopeSchema,
});

/**
 * One resolved answer.
 *
 * Only current rows ever appear here — `effective_from <= now < effective_to`,
 * evaluated against the injected `Clock`. A superseded answer is closed, never
 * deleted (civics-content.md §4), and is unreachable through this API.
 */
export const civicsAnswerSchema = z.object({
  id: z.uuid(),

  /** The accepted answer, verbatim. */
  text: z.string(),

  /** Which slot this answer occupies among simultaneously correct ones. */
  sort: z.number().int(),

  /** The state this answer is for, or null for a national or static answer. */
  stateCode: z.string().nullable(),

  /**
   * When a human reviewer last confirmed this exact text against the
   * authoritative source. This is what "current as of …" renders from.
   *
   * NOT when the fact took effect — a reviewer can verify today a change that
   * happened last month (civics-content.md §2.3).
   */
  verifiedAt: z.iso.datetime(),

  /**
   * The citation this row's text and dates come from.
   *
   * Public on purpose. `VISION.md`'s "OathPath owns the truth" is a promise a
   * learner should be able to check, not only an internal one, and unlike a
   * learner's own profile there is nothing private in a civics answer — it is
   * exam content whose whole point is to be shown to everybody (the same
   * reasoning civics-content.md §9 gives for recording the full text diff in
   * the audit log).
   */
  sourceNote: z.string().nullable(),
});

export const civicsQuestionDetailSchema = civicsQuestionSummarySchema.extend({
  /** The question's category, inlined — one screen, one round trip. */
  category: civicsCategorySchema,

  /**
   * Whether the answers below are this caller's answers, and if not, why.
   *
   * **`state_required` is the case a client MUST handle.** It means: this is a
   * `state`-scope question, the caller has no `state_code` on their learner
   * profile, and so `answers` is empty and `verifiedAt` is null. Render the
   * question with a prompt to set their state — never an error, never a blank,
   * and never another state's answer.
   *
   * civics-content.md §5 rejects both alternatives by name. Hiding the question
   * shows a learner fewer questions than their version promises with nothing
   * explaining the gap; guessing a state hands them a specific memorable WRONG
   * answer with no signal it might not apply to them. The status is a
   * discriminator rather than a bare empty array so a client cannot mistake
   * "we don't know yet" for "this question has no answers".
   */
  answerResolution: z.enum(['resolved', 'state_required']),

  /**
   * The state code the answers were resolved against, or null.
   *
   * Null for a `none`- or `national`-scope question (whose answers do not vary
   * by state) AND for an unresolved one. `answerResolution` is what tells those
   * apart; this field exists so a client can show *which* state it is showing —
   * a learner who moved and forgot to update their profile should be able to
   * see that they are reading Ohio's governor.
   */
  resolvedForStateCode: z.string().nullable(),

  /**
   * The most recent `verifiedAt` across the resolved answers, or null when
   * there are none.
   *
   * Derived, not a column. It is here so "current as of …" is one field a
   * client renders rather than a max a client computes — three clients
   * computing it three ways is how two screens end up disagreeing about how
   * fresh the same fact is.
   */
  verifiedAt: z.iso.datetime().nullable(),

  /**
   * Every currently correct answer, in slot order.
   *
   * One entry for a `national`- or `state`-scope question — there is one
   * current President. Possibly several for a `none`-scope question, all
   * simultaneously correct: "name one branch of the government" has three
   * (civics-content.md §3.1). Empty when `answerResolution` is
   * `state_required`.
   */
  answers: z.array(civicsAnswerSchema),
});

export type CivicsQuestionSummary = z.infer<typeof civicsQuestionSummarySchema>;
export type CivicsAnswerResponse = z.infer<typeof civicsAnswerSchema>;
export type CivicsQuestionDetail = z.infer<typeof civicsQuestionDetailSchema>;

export class CivicsQuestionSummaryDto extends createZodDto(
  civicsQuestionSummarySchema,
) {}

export class CivicsQuestionDetailDto extends createZodDto(
  civicsQuestionDetailSchema,
) {}
