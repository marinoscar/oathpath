/**
 * Presentation-only config for the readiness breakdown — plain-English
 * labels and the "no evidence yet" honesty rule for the three structurally
 * unwired components.
 *
 * Issue #139, epic #55 / E6. Shaped after `components/progress/mastery.ts`:
 * a small, page-local config, not a registry the app disagrees with itself
 * about. THIS IS NOT the kind of registry `CLAUDE.md` requires living in the
 * API (`notification-events.ts`, `ai-model-roles.ts`, the journey stage
 * list): those hold copy and ordering the SERVER decided and a client copy
 * could drift from. `READINESS_COMPONENT_ORDER` restates an order fixed by
 * the closed `ReadinessComponentKey` union itself (`readiness-engine.ts`'s
 * own `READINESS_COMPONENT_KEYS`, §2) rather than by a runtime value the
 * server sends — a re-ordering there is a type change on both sides, not a
 * value this file could silently drift from underneath a passing build. Two
 * copies of a compile-time order carry none of the runtime-drift risk the
 * cited registries exist to prevent. `READINESS_COMPONENT_LABELS` is copy
 * the API has no field for at all —
 * `docs/specs/readiness-model.md` §2's own worked example labels
 * (`coverage` → "Material covered", etc.) are UI's to write, the same way
 * `mastery.ts`'s `masteryStateDisplay` owns `MasteryState`'s labels and
 * colors with no server-sent equivalent to disagree with.
 */

import type {
  ReadinessComponentKey,
  ReadinessEvidenceCounts,
  ReadinessSnapshotResponse,
} from '../../types';

/**
 * The eight components, in `docs/specs/readiness-model.md` §2's declared
 * order — the same order `readiness-engine.ts`'s `READINESS_COMPONENT_KEYS`
 * fixes server-side.
 */
export const READINESS_COMPONENT_ORDER: ReadinessComponentKey[] = [
  'coverage',
  'recall',
  'retention',
  'consistency',
  'remediation',
  'english',
  'spoken',
  'interview',
];

/** Plain-English labels for the breakdown — §2's own worked-example wording. */
export const READINESS_COMPONENT_LABELS: Record<ReadinessComponentKey, string> = {
  coverage: 'Material covered',
  recall: 'Recall without help',
  retention: 'Long-term retention',
  consistency: 'Practice consistency',
  remediation: 'Fixing weak spots',
  english: 'Reading and writing English',
  spoken: 'Spoken practice',
  interview: 'Mock interviews',
};

/**
 * The three components whose `0` means "nothing to measure yet" rather than
 * "measured, and failing" — the set this file's "no evidence yet" honesty
 * rule applies to.
 *
 * The NAME predates E10: `spoken` and `interview` are still structurally `0`
 * for every learner until E9/E8 ship (§2.7-§2.8), but `english` is wired now
 * (`docs/specs/english-test.md` §6) and stays in this set anyway, because
 * membership has never meant "unwired" to the one function that reads it — it
 * means "an unevidenced `0` here is an absence, not a score". `english`'s `0`
 * is still exactly that whenever the learner has attempted no sentences; the
 * moment they attempt one, `readinessHasNoEvidence` reads `false` and a real
 * percentage renders, membership notwithstanding.
 */
export const UNWIRED_READINESS_COMPONENTS: ReadonlySet<ReadinessComponentKey> = new Set([
  'english',
  'spoken',
  'interview',
]);

/**
 * How many distinct English sentences the learner ATTEMPTED in `english`'s
 * 30-day window — the number that separates "no practice yet" from
 * "practised and missed", which earn identical (`0`) credit.
 *
 * THE LEGACY BRANCH IS NOT DEAD CODE — DO NOT DELETE IT. `GET
 * /api/readiness/history` never recomputes a stored snapshot; it casts the
 * row it read rather than re-parsing it. So every snapshot written before E10
 * deployed still serves the retired `distinctQuestionsCorrectSpokenInEnglish`
 * field, and the history list is the one place both shapes arrive together.
 * A legacy row resolves to `0` attempts DELIBERATELY: that field counted
 * civics answers spoken in English and was a literal `0` for every learner
 * ever, so "no evidence" is not a fallback for it — it is what it always
 * meant.
 */
export function readinessEnglishSentencesAttempted(
  english: ReadinessEvidenceCounts['english'],
): number {
  if (!('readingSentences' in english)) return 0;
  return english.readingSentences + english.writingSentences;
}

/**
 * True when a component has no evidence AT ALL — the MANDATORY honesty rule
 * (§2.6-§2.8, `english-test.md` §6.2, and this app's own `ProgressMastery`
 * empty-state convention): render "No evidence yet" for these three, never a
 * `0%` presented as a failing score.
 *
 * Read from `evidenceCounts` directly, per component, rather than assumed
 * from set membership alone — the day E8/E9 ships, a learner's very first
 * piece of real evidence renders a real percentage immediately, with no
 * separate "is this feature live yet" flag for this file to fall behind.
 * `english` is that day already, which is why it counts ATTEMPTS and not
 * credit: a learner who read or wrote sentences and got them wrong has been
 * measured at `0%`, exactly as `recall`'s sub-threshold `0` is a real
 * measurement (`ReadinessBreakdown`'s own header), and answering them "No
 * evidence yet" would deny practice they actually did.
 */
export function readinessHasNoEvidence(
  key: ReadinessComponentKey,
  evidenceCounts: ReadinessEvidenceCounts,
): boolean {
  switch (key) {
    case 'english':
      return readinessEnglishSentencesAttempted(evidenceCounts.english) === 0;
    case 'spoken':
      return evidenceCounts.spoken.attempts === 0;
    case 'interview':
      return evidenceCounts.interview.attempts === 0;
    default:
      return false;
  }
}

/**
 * A short, honest trend sentence from two scores — shared by `/progress`'s
 * trend section and the Home widget so the two can never disagree about
 * what "up" or "down" means.
 *
 * `previousScore: null | undefined` (no prior snapshot exists) returns
 * `null` — DELIBERATELY. A trend needs two points; fabricating one from a
 * single snapshot is exactly the shape of invented confidence
 * `docs/specs/journey-shell.md` §10 already rules out elsewhere in this app.
 */
export function readinessTrendText(
  currentScore: number,
  previousScore: number | null | undefined,
): string | null {
  if (previousScore === null || previousScore === undefined) return null;

  const delta = currentScore - previousScore;
  if (delta === 0) return 'No change since your last check.';
  if (delta > 0) {
    return `Up ${delta} ${delta === 1 ? 'point' : 'points'} since your last check.`;
  }
  const drop = Math.abs(delta);
  return `Down ${drop} ${drop === 1 ? 'point' : 'points'} since your last check.`;
}

/**
 * The most recent PRIOR snapshot's score, or `null` when none exists —
 * shared by `/progress`'s trend section and the Home widget (#142).
 *
 * `history` is newest-first and MAY OR MAY NOT already include the current
 * (possibly freshly-computed) snapshot `useReadiness` returned — `GET
 * /api/readiness` and `GET /api/readiness/history` are two independent
 * reads that can race, or the current snapshot can be one `computeReadiness`
 * call younger than the newest row `GET .../history`'s own page has seen.
 * Rather than assume either shape, this scans for the first row that is not
 * the current snapshot BY ID, so both cases resolve to the same, correct
 * "previous" answer.
 */
export function findPreviousReadinessScore(
  current: ReadinessSnapshotResponse,
  history: ReadinessSnapshotResponse[],
): number | null {
  const previous = history.find((snapshot) => snapshot.id !== current.id);
  return previous ? previous.score : null;
}
