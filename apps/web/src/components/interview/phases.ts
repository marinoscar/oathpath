/**
 * What an interview phase is CALLED on screen — in ONE file.
 *
 * Issue #140, epic #57 / E8. Three surfaces name a phase (the progress line,
 * each officer card's eyebrow, and — from #145 — the debrief's phase list), and
 * three inline `phase === 'civics' ? … : …` expressions is how two of them end
 * up disagreeing about what `n400` is called. The same one-named-file argument
 * `components/practice/outcome.ts` makes for the practice vocabulary.
 *
 * =============================================================================
 * EVERY LOOKUP HERE FALLS BACK. NEITHER OF THEM INDEXES A `Record` AND HOPES.
 * =============================================================================
 *
 * `InterviewPhase` is a closed union in TypeScript and an OPEN set on the wire:
 * the server deploys independently of this bundle, and a browser holding an
 * older build will meet a phase it has never heard of the day one is added. A
 * total `Record` lookup returns `undefined` there, and `undefined` rendered as
 * an eyebrow is a blank line above the officer's words.
 *
 * So each function takes a plain `string`, and each ends in a fallback that is
 * honest rather than clever — an unrecognised phase is "This part of the
 * interview", which claims nothing about what happens in it.
 *
 * =============================================================================
 * THE LABELS ARE NOT USCIS'S WORDS, AND `n400` ESPECIALLY IS NOT
 * =============================================================================
 *
 * "Your application" is what that phase is called here because that is what a
 * learner is being asked to rehearse — talking about their own application out
 * loud. It is deliberately NOT "N-400 questions", which reads as though the
 * product is about to ask for real application answers. It is not, and it never
 * will: those prompts name a topic the real interview covers and never ask for
 * a real answer to it (`docs/specs/mock-interview.md` §2.2, §8).
 *
 * `reading` and `writing` are named plainly, even though this rehearsal cannot
 * conduct them. §2.4: a learner who is never told those segments exist may walk
 * into the real interview believing they rehearsed something they never saw.
 * The officer says so out loud in its own turn; this is the label above it.
 */

/**
 * The six phases, in the order they are conducted.
 *
 * Mirrors `INTERVIEW_PHASES` in `apps/api/src/interviews/engine/phases.ts`. It
 * is used for ONE thing — "Part 3 of 6", the learner's sense of where they are
 * — and deliberately never rendered as a list. See `PhaseProgress`.
 */
export const INTERVIEW_PHASE_ORDER: readonly string[] = [
  'smalltalk',
  'n400',
  'civics',
  'reading',
  'writing',
  'closing',
];

const PHASE_LABELS: Record<string, string> = {
  smalltalk: 'Getting started',
  n400: 'Your application',
  civics: 'Civics questions',
  reading: 'Reading test',
  writing: 'Writing test',
  closing: 'Closing',
};

/** What a phase is called on screen. Never throws. */
export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? 'This part of the interview';
}

/**
 * Which part of six this phase is, or null when this bundle does not know.
 *
 * Null rather than a guess, so a caller renders NOTHING instead of "Part 0 of
 * 6" — a position the learner is not actually at.
 */
export function phasePosition(phase: string): number | null {
  const index = INTERVIEW_PHASE_ORDER.indexOf(phase);
  return index === -1 ? null : index + 1;
}
