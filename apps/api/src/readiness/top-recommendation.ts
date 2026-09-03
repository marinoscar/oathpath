import type { ReadinessComponentKey, ReadinessResult } from './readiness-engine';

// =============================================================================
// The top recommendation (issue #127, epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
// `docs/specs/readiness-model.md` §8.2. Pure, exactly like `readiness-engine
// .ts` and `readiness-stage-transitions.ts` — no Prisma, no `Clock`, no I/O
// of any kind. Computed from a `ReadinessResult` alone, the same object
// `computeReadiness` already returned, so there is nothing here for a
// caller to get out of sync: the recommendation is arithmetic over numbers
// the engine already produced.
//
// -----------------------------------------------------------------------------
// CAPPED: ALWAYS THE FIXED §3 COPY, EVERY TIME — NOT A COMPETING CHOICE
// -----------------------------------------------------------------------------
//
// When `capReason === 'typed_only'`, the recommendation is always the
// capped-evidence requirement (`componentKey: null`), never a headroom pick
// among the five earnable components — a capped learner is told about the
// cap every time, because it is the single most consequential true thing
// this product can say to them, ahead of any smaller headroom optimization.
// `path: '/practice'` — the same destination `interview_countdown`/`review`/
// `practice` already share (`journey-shell.md`/`memory-model.md` §6); E8
// will re-point this once a dedicated mock-interview route exists.
//
// -----------------------------------------------------------------------------
// UNCAPPED: GREATEST `weight * (1 - value)`, TIE-BROKEN BY DECLARED ORDER
// -----------------------------------------------------------------------------
//
// Among `coverage`, `recall`, `retention`, `consistency`, `remediation` only
// — never `english`/`spoken`/`interview`, which are declared-but-unwired
// (§2.6-§2.8): recommending "go do more spoken/interview practice" would be
// recommending a feature that does not exist yet. Ties are broken by §2's
// declared component order, the same stable-tie-break discipline
// `selector.ts`'s `orderNewByCategoryCoverage` already applies, for the
// identical reason: a comparator that can return a genuine tie must not
// reorder nondeterministically between two calls on identical input.
// =============================================================================

export interface ReadinessTopRecommendation {
  /** `null` for the capped message — it is not a component pick. */
  componentKey: ReadinessComponentKey | null;
  title: string;
  reason: string;
  path: string;
}

/** The five components a learner can actually move today (§8.2), in tie-break order. */
const EARNABLE_COMPONENT_KEYS: readonly ReadinessComponentKey[] = [
  'coverage',
  'recall',
  'retention',
  'consistency',
  'remediation',
];

/**
 * §3's fixed cap message, verbatim, as the product itself already states it
 * (quoted from `PRD.md` by way of §2.8) — split into a title for the card
 * and the full sentence as the body. Never paraphrased, never re-templated
 * with a live count.
 */
function cappedRecommendation(): ReadinessTopRecommendation {
  return {
    componentKey: null,
    title: 'Limited interview practice',
    reason:
      'Your civics knowledge is strong, but you have limited interview practice. ' +
      'Completing two mock interviews is the best way to strengthen your readiness now.',
    path: '/practice',
  };
}

/** One honest, non-hyped title/reason per earnable component, grounded only in this result's own `evidenceCounts`. */
function copyFor(key: ReadinessComponentKey, result: ReadinessResult): { title: string; reason: string } {
  const counts = result.evidenceCounts;

  switch (key) {
    case 'coverage': {
      const { distinctQuestionsAttempted, totalQuestionsInVersion } = counts.coverage;
      return {
        title: 'Try questions you haven’t seen yet',
        reason:
          `You've covered ${distinctQuestionsAttempted} of ${totalQuestionsInVersion} questions in ` +
          'the bank — practicing ones you haven’t touched yet broadens what you’re actually being tested on.',
      };
    }
    case 'recall': {
      const { qualifyingAttempts, correctCount } = counts.recall;
      return {
        title: 'Answer without hints or reveals',
        reason:
          qualifyingAttempts > 0
            ? `Of your last ${qualifyingAttempts} unassisted answers, ${correctCount} were right — ` +
              'more correct answers without a hint or a reveal is the strongest evidence you can add.'
            : 'You don’t have enough unassisted answers yet to measure this — answering a few ' +
              'questions without a hint or a reveal is the fastest way to build that evidence.',
      };
    }
    case 'retention': {
      const { reviewCount } = counts.retention;
      return {
        title: 'Review what you’ve already studied',
        reason:
          reviewCount > 0
            ? `You have ${reviewCount} question${reviewCount === 1 ? '' : 's'} in review that ` +
              'haven’t been verified as mastered yet — a few more correct answers on different days will lock them in.'
            : 'Verifying what you’ve already studied on more than one day is what turns it from ' +
              '"seen once" into something you can rely on in the interview.',
      };
    }
    case 'consistency': {
      const { distinctPracticeDaysInLast14 } = counts.consistency;
      return {
        title: 'Practice on more days',
        reason:
          `You've practiced on ${distinctPracticeDaysInLast14} of the last 14 days — spreading practice ` +
          'across more days is stronger evidence than one long session.',
      };
    }
    case 'remediation': {
      const { everWeakCount, remediatedCount } = counts.remediation;
      const outstanding = everWeakCount - remediatedCount;
      return {
        title: 'Fix questions that have tripped you up',
        reason:
          outstanding > 0
            ? `You have ${outstanding} question${outstanding === 1 ? '' : 's'} that have given you ` +
              'trouble more than once and haven’t recovered yet — getting those right again is worth ' +
              'more right now than new material.'
            : 'You don’t have any struggling questions outstanding right now — keep it that way by ' +
              'catching a slip early the next time one comes up.',
      };
    }
    default:
      // Unreachable: `key` is drawn from `EARNABLE_COMPONENT_KEYS` only.
      throw new Error(`copyFor: no copy declared for "${key}"`);
  }
}

/**
 * The single next action a readiness snapshot recommends (§8.2). PURE: same
 * input, same output, forever.
 */
export function buildTopRecommendation(result: ReadinessResult): ReadinessTopRecommendation {
  if (result.capReason === 'typed_only') {
    return cappedRecommendation();
  }

  let best: { key: ReadinessComponentKey; headroom: number } | null = null;

  for (const key of EARNABLE_COMPONENT_KEYS) {
    const component = result.components[key];
    const headroom = component.weight * (1 - component.value);
    // Strict `>` preserves the FIRST (declared-order) key on a tie — `best`
    // is only ever replaced by a strictly greater headroom.
    if (best === null || headroom > best.headroom) {
      best = { key, headroom };
    }
  }

  // `EARNABLE_COMPONENT_KEYS` is a non-empty constant, so `best` is always set.
  const { key } = best!;
  const { title, reason } = copyFor(key, result);

  return { componentKey: key, title, reason, path: '/practice' };
}
