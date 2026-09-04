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
// among the earnable components — a capped learner is told about the
// cap every time, because it is the single most consequential true thing
// this product can say to them, ahead of any smaller headroom optimization.
//
// `path: '/practice/interviews'` since #133 (epic #57 / E8), and it used to
// be `/practice` with a note saying E8 would re-point it once a dedicated
// mock-interview route existed. This is that re-point, and the rule it
// follows is worth stating rather than leaving to the diff: A RECOMMENDATION
// MUST POINT AT THE DESTINATION IT NAMES. This card's copy says "completing
// two mock interviews is the best way to strengthen your readiness now", and
// until this epic there was nowhere to send a learner who acted on it — the
// tap landed on the general practice page, which offers Quick 5 and category
// drills and no mock interview at all. That is the same self-contradiction
// `next-action.ts`'s header forbids for its own kinds ("a learner who taps
// 'Continue' and lands back on the screen the card was on has just watched
// the product contradict itself"), and the reason its `NEXT_ACTION_PATHS`
// only gains a member when the route exists. `/practice/interviews` is a
// real, mounted route from this epic on.
//
// -----------------------------------------------------------------------------
// UNCAPPED: GREATEST `weight * (1 - value)`, TIE-BROKEN BY DECLARED ORDER
// -----------------------------------------------------------------------------
//
// Among the six components a learner can actually move today — never
// `spoken`/`interview`, which have no practice surface of their own to send
// anyone to: recommending them would be recommending a feature that does not
// exist. Ties are broken by §2's declared component order, the same
// stable-tie-break discipline `selector.ts`'s `orderNewByCategoryCoverage`
// already applies, for the identical reason: a comparator that can return a
// genuine tie must not reorder nondeterministically between two calls on
// identical input.
//
// `english` IS THE SIXTH, SINCE #141 (epic #59 / E10), and it joined on this
// file's own stated precondition rather than by exception: `english_attempts`
// is real, `/api/english/*` is mounted, and English practice is something a
// learner can go and do. `english-test.md` §6.4 is the instruction.
//
// -----------------------------------------------------------------------------
// EACH COMPONENT NAMES ITS OWN DESTINATION
// -----------------------------------------------------------------------------
//
// `path` moved into `copyFor` alongside the copy rather than staying a single
// `'/practice'` shared by every branch. Behaviour is unchanged today — all six
// point at `/practice` — but the header's rule above ("A RECOMMENDATION MUST
// POINT AT THE DESTINATION IT NAMES") is only enforceable if the sentence and
// the link are edited in the same three lines. The capped card is the worked
// example of what happens otherwise: it named mock interviews and pointed at
// the general practice page for two whole epics.
//
// `english`'s path is the live instance of that debt, and it is recorded here
// rather than left to be discovered. THE READING AND WRITING SCREENS DO NOT
// EXIST YET — they are issues #144 and #147, later in this same epic, and
// `apps/web/src/App.tsx` today mounts no `/practice/english`,
// `/practice/reading` or `/practice/writing` route. So this card points at
// `/practice`, which is real, and its copy is written not to promise a screen
// that would 404: it says English practice is what would move the number, and
// does not say "tap here to start a reading test". Inventing the future path
// now would ship a recommendation whose one action is a redirect to `/`.
// WHEN #144/#147 LAND, RE-POINT THIS ONE PATH — exactly as #133 re-pointed
// the capped card's — and tighten the copy to name the screen.
// =============================================================================

export interface ReadinessTopRecommendation {
  /** `null` for the capped message — it is not a component pick. */
  componentKey: ReadinessComponentKey | null;
  title: string;
  reason: string;
  path: string;
}

/** The components a learner can actually move today (§8.2), in tie-break order. */
const EARNABLE_COMPONENT_KEYS: readonly ReadinessComponentKey[] = [
  'coverage',
  'recall',
  'retention',
  'consistency',
  'remediation',
  'english',
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
    // The route this epic mounted. See the header: the copy above names mock
    // interviews, so this has to be where mock interviews are.
    path: '/practice/interviews',
  };
}

/** One honest, non-hyped title/reason/destination per earnable component, grounded only in this result's own `evidenceCounts`. */
function copyFor(
  key: ReadinessComponentKey,
  result: ReadinessResult,
): { title: string; reason: string; path: string } {
  const counts = result.evidenceCounts;

  switch (key) {
    case 'coverage': {
      const { distinctQuestionsAttempted, totalQuestionsInVersion } = counts.coverage;
      return {
        title: 'Try questions you haven’t seen yet',
        reason:
          `You've covered ${distinctQuestionsAttempted} of ${totalQuestionsInVersion} questions in ` +
          'the bank — practicing ones you haven’t touched yet broadens what you’re actually being tested on.',
        path: '/practice',
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
        path: '/practice',
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
        path: '/practice',
      };
    }
    case 'consistency': {
      const { distinctPracticeDaysInLast14 } = counts.consistency;
      return {
        title: 'Practice on more days',
        reason:
          `You've practiced on ${distinctPracticeDaysInLast14} of the last 14 days — spreading practice ` +
          'across more days is stronger evidence than one long session.',
        path: '/practice',
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
        path: '/practice',
      };
    }
    case 'english': {
      const { readingSentences, writingSentences } = counts.english;
      const practised = readingSentences + writingSentences;
      return {
        title: 'Practice reading and writing English',
        reason:
          practised > 0
            ? `In the last 30 days you've worked through ${readingSentences} reading ` +
              `sentence${readingSentences === 1 ? '' : 's'} and ${writingSentences} writing ` +
              `sentence${writingSentences === 1 ? '' : 's'} — the interview tests both, and more of ` +
              'whichever you’ve done less of is what moves this the most.'
            : 'You haven’t practiced reading or writing a sentence in the last 30 days — the ' +
              'interview asks for both, and neither takes long to build evidence for.',
        // `/practice`, not a reading or writing screen: those are #144/#147 and
        // do not exist yet. See this file's header — the copy above is written
        // to stay true at this destination until they do.
        path: '/practice',
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
  const { title, reason, path } = copyFor(key, result);

  return { componentKey: key, title, reason, path };
}
