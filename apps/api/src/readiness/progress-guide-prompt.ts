import type { AiMessage } from '../ai/ai.types';
import { RECALL_MIN_QUALIFYING_ATTEMPTS, type ReadinessResult } from './readiness-engine';

// =============================================================================
// The Progress Guide prompt (issue #134, epic #55 / E6 "Readiness and
// Progress")
// =============================================================================
//
// `docs/specs/readiness-model.md` §9. Grounded ONLY in a `ReadinessResult`'s
// own `components`, `evidenceCounts`, and `capReason` — the identical
// grounding rule `explain-prompt.ts`'s own header states for the tutor role,
// applied here to a different shape of evidence. The model is never asked to
// guess anything about this learner it was not handed as a number.
//
// -----------------------------------------------------------------------------
// A PURE FUNCTION IN ITS OWN FILE, FOR THE SAME REASON `explain-prompt.ts` IS
// ONE
// -----------------------------------------------------------------------------
//
// No Nest, no Prisma, no clock, no injection — the input is a `ReadinessResult`
// (already produced by `computeReadiness`, never re-derived here) and the
// output is the two messages that go on the wire. That is what lets
// `progress-guide-prompt.spec.ts` assert, by calling one function, that a
// capped result's prompt actually names the cap and that a component's real
// count actually appears in the text handed to the model — properties that
// would only be reachable through DI and a fake provider if this lived inside
// `ReadinessService` instead.
//
// -----------------------------------------------------------------------------
// THERE IS NO UNTRUSTED INPUT HERE — UNLIKE `explain-prompt.ts`'s `focus`
// -----------------------------------------------------------------------------
//
// Every value threaded into this prompt is a server-computed number or a
// closed-enum string (`capReason`, `ReadinessComponentKey`) — nothing a
// learner ever typed reaches this function. `explain-prompt.ts`'s delimit-
// and-neutralise discipline for `focus` therefore has nothing to apply to
// here; there is no learner text to delimit, label as data, or strip of
// markup. What still applies, unchanged, is the OTHER half of that file's
// discipline: the model is told what the facts ARE, not asked to guess them,
// and it is never invited to invent a fact this prompt does not supply.
// =============================================================================

/**
 * Build the two messages the Progress Guide paragraph is generated from.
 *
 * ONE SYSTEM MESSAGE AND ONE USER MESSAGE, mirroring `buildExplainPrompt`'s
 * own shape: the rules in the system turn, the material in the user turn. No
 * conversation history and no assistant turn — one snapshot in, one paragraph
 * out, with nothing for a follow-up turn to accumulate.
 */
export function buildProgressGuidePrompt(result: ReadinessResult): AiMessage[] {
  return [
    { role: 'system', content: systemMessage() },
    { role: 'user', content: userMessage(result) },
  ];
}

// -----------------------------------------------------------------------------
// The messages
// -----------------------------------------------------------------------------

/**
 * The rules: what the job is, that the numbers are fact, how to write, and
 * that the cap (when set) must be named plainly.
 *
 * WRITTEN OUT AS PROSE RATHER THAN ASSEMBLED FROM SETTINGS, for the identical
 * reason `explain-prompt.ts`'s own `systemMessage` gives: the tone below is
 * `VISION.md`'s AI-personality commitment, not a preference a deployment gets
 * to opt out of. The voice matches `journey/study-coach.ts` and
 * `journey/next-action.ts`'s own copy — encouraging but never hyped, honest
 * about a limitation rather than soft-pedaling it.
 *
 * That claim is about an ADMIN/DEPLOYMENT persona, and it still holds
 * unweakened. E14 (#305)'s learner-chosen coach personality is a different
 * axis, and this file is deliberately not one of the places it is wired in
 * v1 — a scope decision, not a principle: the readiness narrative is a rarer,
 * more consequential paragraph than a per-answer reaction, and E14 ships the
 * two mechanisms that cover the actual coaching-gap surface (see
 * `docs/specs/coach-personality.md` §10) without touching it. If a later
 * epic does wire a persona here, it is appended after this system message as
 * its own fragment, with the same invariant floor appended after that and
 * declared in the prompt text to override it — identically to every other
 * call E14 does reach.
 */
function systemMessage(): string {
  return [
    'You are a calm, encouraging guide helping someone track their progress toward ' +
      'the United States naturalization civics interview. You will be shown one ' +
      "learner's readiness snapshot: a breakdown of the components that make up " +
      'their score, the raw evidence counts behind each one, and whether their ' +
      'score is currently capped. Your job is to write ONE short, personal ' +
      'paragraph — plain English, three to five sentences — explaining what is ' +
      'currently driving their readiness and what is currently limiting it.',

    // The grounding clause, phrased the same way explain-prompt.ts's own
    // grounding clause is: as settled fact to explain, never as something to
    // sanity-check or add to.
    'Every number and fact you are given below comes from OathPath’s own ' +
      'evidence — nothing here is a guess. Base your paragraph ONLY on the ' +
      'components and evidence counts you are given. Do not invent a fact about ' +
      'this learner that is not in the data below, do not mention a component ' +
      'that was not listed, and do not estimate a number you were not given.',

    // The voice. The same list explain-prompt.ts's own voice paragraph draws
    // from, compressed to what a progress paragraph specifically needs: never
    // hype a middling score, never scold a low one.
    'Be warm without being sugary, and encouraging without being dishonest. ' +
      'Name the ONE OR TWO components with the strongest evidence as what is ' +
      'currently working, and the ONE component with the least evidence relative ' +
      'to its weight as the clearest lever to move next — this mirrors how the ' +
      'product itself already picks a top recommendation, and your paragraph ' +
      'should agree with that framing rather than compete with it. Never say the ' +
      'learner is "ready" or "not ready" — that judgment belongs to the score and ' +
      'the stage, not to your paragraph. Never invent a study tip, a technique, ' +
      'or advice this prompt did not already ground in a real number.',

    // The cap clause. Only when there is a cap to name — an unconditional
    // instruction here would ask the model to reconcile a rule against nothing
    // on the (eventual) day the cap has lifted for every learner, the same
    // reason explain-prompt.ts's own focus-block rule is conditional.
    'If the data below says the learner’s score is currently capped, say so ' +
      'plainly and name the real reason in your own words — do not soften it into ' +
      'something vague like "there is room to grow". If the data says there is no ' +
      'cap, do not mention a cap at all.',
  ].join('\n\n');
}

/**
 * The material: every component's value/weight and its evidence counts, in
 * §2's declared order, plus the cap.
 *
 * SHAPED AS A PLAIN-TEXT TABLE, not JSON — the same reasoning
 * `explain-prompt.ts`'s `userMessage` gives for its bullet list: a model asked
 * to write prose from a table of already-labeled facts is less likely to
 * quote the table back verbatim than one asked to "explain this JSON".
 */
function userMessage(result: ReadinessResult): string {
  const sections = [
    `Overall score: ${result.score} out of 100.`,
    componentLines(result),
    capLine(result),
  ];

  return sections.join('\n\n');
}

/** One line per component, in `readiness-engine.ts`'s own declared order. */
function componentLines(result: ReadinessResult): string {
  const lines = COMPONENT_ORDER.map((key) => {
    const component = result.components[key];
    const percent = Math.round(component.value * 100);
    return `- ${COMPONENT_LABELS[key]}: ${percent}% (weight ${Math.round(component.weight * 100)}%) — ${evidenceSentence(key, result)}`;
  });

  return ['Readiness components, in order:'].concat(lines).join('\n');
}

/**
 * The cap fact, stated plainly either way — present even when there is no cap,
 * so the model is never left to infer "capped" from silence the way an absent
 * field could invite.
 */
function capLine(result: ReadinessResult): string {
  if (result.capReason === 'typed_only') {
    return (
      'Cap: YES — this learner has no spoken-answer evidence and no completed mock ' +
      'interview yet, so their score cannot exceed 75 out of 100 no matter how ' +
      'strong their typed answers are.'
    );
  }

  return 'Cap: no cap is currently in effect.';
}

// -----------------------------------------------------------------------------
// Component copy — mirrors `top-recommendation.ts`'s own per-component labels
// -----------------------------------------------------------------------------

/** `ReadinessComponentKey`, imported through the result's own component map rather than re-imported, to keep this file's only dependency on the engine's shape. */
type ComponentKey = keyof ReadinessResult['components'];

/** §2's declared order, restated here because `Record` iteration order is not a contract this file should lean on. */
const COMPONENT_ORDER: readonly ComponentKey[] = [
  'coverage',
  'recall',
  'retention',
  'consistency',
  'remediation',
  'english',
  'spoken',
  'interview',
];

const COMPONENT_LABELS: Record<ComponentKey, string> = {
  coverage: 'Coverage (how much of the question bank has been attempted)',
  recall: 'Recall (accuracy on recent unassisted answers)',
  retention: 'Retention (how much of what was studied has actually stuck)',
  consistency: 'Consistency (practice spread across recent days, not crammed into one)',
  remediation: 'Remediation (recovery on questions that were once missed repeatedly)',
  english: 'English reading and writing practice',
  spoken: 'Spoken practice (any language)',
  interview: 'Mock interviews passed',
};

/** One evidence-grounded sentence fragment per component, from `evidenceCounts` alone. */
function evidenceSentence(key: ComponentKey, result: ReadinessResult): string {
  const counts = result.evidenceCounts;

  switch (key) {
    case 'coverage':
      return `${counts.coverage.distinctQuestionsAttempted} of ${counts.coverage.totalQuestionsInVersion} questions attempted.`;
    case 'recall':
      // Mirrors `computeRecall`'s own floor exactly (`RECALL_MIN_QUALIFYING
      // _ATTEMPTS`, imported rather than a second hand-copied `5`) — a count
      // below it is "not enough evidence yet", not a real 0%.
      return counts.recall.qualifyingAttempts >= RECALL_MIN_QUALIFYING_ATTEMPTS
        ? `${counts.recall.correctCount} correct of the last ${counts.recall.qualifyingAttempts} unassisted answers.`
        : 'not enough unassisted answers yet to measure.';
    case 'retention':
      return `${counts.retention.masteredCount} mastered and ${counts.retention.reviewCount} in review, of ${counts.retention.totalAttemptedQuestions} attempted.`;
    case 'consistency':
      return `practiced on ${counts.consistency.distinctPracticeDaysInLast14} of the last 14 days.`;
    case 'remediation':
      return counts.remediation.everWeakCount > 0
        ? `${counts.remediation.remediatedCount} of ${counts.remediation.everWeakCount} once-struggled questions recovered.`
        : 'no questions have ever been struggled on repeatedly.';
    case 'english': {
      // `english-test.md` §6.2's own honesty convention: name the missing
      // evidence rather than narrating a bare 0. "No practice in the window"
      // and "practised and missed" are both `0` for this component and are
      // not the same thing to say to a learner.
      const { readingSentences, writingSentences } = counts.english;
      return readingSentences + writingSentences > 0
        ? `${readingSentences} reading and ${writingSentences} writing sentence(s) practiced in the last 30 days.`
        : 'no reading or writing practice in the last 30 days.';
    }
    case 'spoken':
      return `${counts.spoken.attempts} distinct questions answered correctly aloud.`;
    case 'interview':
      return `${counts.interview.attempts} mock interview(s) passed.`;
  }
}
