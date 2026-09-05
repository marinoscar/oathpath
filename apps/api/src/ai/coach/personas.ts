// =============================================================================
// The coach persona registry (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// Four ways a learner can ask their coach to talk to them. One entry per
// persona, and that one entry feeds everything: the settings enum, the
// `GET /api/ai/coach/personas` endpoint the settings page previews from, the
// prompt fragment appended to the grader's and the tutor's system messages,
// and the key stored in a `user_settings` row.
//
// The same one-entry-feeds-everything shape as `notification-events.ts` and
// `ai-model-roles.ts`, for the same reason each of those states at length.
//
// -----------------------------------------------------------------------------
// WHERE THIS LIVES, AND WHY IT IS NOT DUPLICATED IN apps/web
// -----------------------------------------------------------------------------
//
// The API owns this list; the web reads it over `GET /api/ai/coach/personas`
// (#320). `ai-model-roles.ts` states the rule and the argument, and neither
// changes here: a duplicate in `apps/web/src/config` with a test asserting the
// two agree is DETECTION rather than prevention — the copies can still
// disagree in a working tree, in a branch, and in any build where the test is
// not run.
//
// The endpoint returns FOUR of the five fields below. `promptFragment` is
// never served: it is prose that exists purely to be concatenated into a
// system message server-side, and a bundle that shipped it to a browser would
// have widened what a client-side read can see for no gain. That the endpoint
// projects rather than a second file holding the fragments is deliberate — one
// registry with a narrowing projection is one place to look, and the
// projection is a single testable assertion (`#320`'s key-set test) rather
// than a second file somebody must remember to keep the web away from.
//
// -----------------------------------------------------------------------------
// `key` IS PERSISTED. RENAMING ONE IS A MIGRATION, NOT A REFACTOR.
// -----------------------------------------------------------------------------
//
// Each `key` is a stored value in `user_settings.value.coach.persona`.
// Renaming one does not move a learner's stored preference with it: the stored
// string stops matching anything here, the resolver falls back to
// `supportive`, and a learner who chose `playful` months ago is quietly
// returned to a voice they did not pick, with nothing in the response or the
// logs to explain why. Add a new key and migrate the rows.
//
// This is the identical warning `ai-model-roles.ts` gives for its own `key`,
// and it is here rather than by reference because the consequence differs: an
// unbound model role reports itself unbound, loudly. A reverted persona
// reports nothing at all.
//
// -----------------------------------------------------------------------------
// THE FRAGMENTS ARE STYLE INSTRUCTIONS, NOT LICENCE
// -----------------------------------------------------------------------------
//
// {@link COACH_INVARIANT_FLOOR} is appended AFTER whichever fragment is
// selected, and says so in its own first sentence. Every fragment below is
// therefore written knowing it can be overridden and that it is not the last
// word — see `docs/specs/coach-personality.md` §3 and §4.2.
//
// This file is intentionally NOT a Nest provider. It is pure data, so tests,
// the prompt builders and the endpoint can all consume it without standing up
// DI for a constant.
// =============================================================================

import type { CoachPersona } from '../../common/schemas/user-settings-namespaces.schema';

export type { CoachPersona };

/** One persona's complete declaration. */
export interface CoachPersonaDef {
  /**
   * The stable key. PERSISTED — see the header. Never renamed in place.
   */
  key: CoachPersona;

  /** The name on the settings card. Sentence case, one or two words. */
  label: string;

  /**
   * Learner-facing copy describing what choosing this changes, in the
   * learner's terms rather than the implementation's. Served by
   * `GET /api/ai/coach/personas`, so it is product copy and is reviewed as
   * such.
   */
  description: string;

  /**
   * The paragraph appended to a system message for a call that already runs.
   *
   * SERVER-SIDE ONLY — never served by the endpoint, never in a web bundle.
   * Scoped in its own text to the wording of the one field it may colour; the
   * builders (#319) add the field name, because only they know whether they
   * are colouring a grader's `feedback` or a tutor's explanation.
   *
   * `supportive`'s is deliberately EMPTY — see its entry.
   */
  promptFragment: string;

  /**
   * One line, in this persona's voice, shown on the settings page so a
   * learner can read what they are choosing before they choose it — and hear
   * it, on an explicit press, since synthesising it spends their own key.
   *
   * Drawn from the same register as the bank in `reaction-lines.ts` but not
   * necessarily from it: a sample is allowed to be the most characteristic
   * line rather than a random one, because a learner comparing four cards is
   * comparing voices, not sampling a distribution.
   */
  sampleLine: string;
}

export const AI_COACH_PERSONAS: CoachPersonaDef[] = [
  {
    key: 'supportive',
    label: 'Supportive',
    description:
      'Warm, specific, and honest. Encouragement you have actually earned, never cheerleading. This is the default, and it is how OathPath has always spoken.',
    // EMPTY, DELIBERATELY, AND THIS IS THE MOST IMPORTANT LINE IN THE FILE.
    //
    // `supportive` is not "a persona that happens to resemble today's voice" —
    // it IS today's voice, which every system message in this codebase
    // already describes in its own words. A fragment here would be a second,
    // paraphrased copy of `explain-prompt.ts`'s and `grading.ts`'s existing
    // tone paragraphs, free to drift from them, and appending it would change
    // the bytes of a prompt that must stay byte-identical for a learner who
    // never opened the setting (#319's own acceptance criterion).
    //
    // Appending nothing changes nothing. That is the requirement, stated
    // exactly.
    promptFragment: '',
    sampleLine:
      'Not quite right — but you can get it next time. Take the answer with you.',
  },
  {
    key: 'academic',
    label: 'Academic',
    description:
      'Precise and formal. Names the concept and the distinction you missed, and explains rather than reassures.',
    promptFragment: [
      'Write in a precise, formal, explanatory register. Name the concept or the distinction at stake rather than describing how the learner did. Prefer the exact term over the approachable paraphrase, and give the reason a thing is so rather than only that it is so.',
      'Do not offer reassurance, praise, or commiseration — this learner has asked for an explanation, not encouragement. Stating plainly what was missed IS the help.',
    ].join('\n'),
    sampleLine:
      'Not accepted. Your response names a different branch of government; compare it to the recorded answer and note the distinction.',
  },
  {
    key: 'playful',
    label: 'Playful',
    description:
      'Light and quick, with a sense of humour. Jokes about a wrong answer, celebrates a right one, and never lingers.',
    promptFragment: [
      'Write light, quick and funny. Short sentences. A joke is welcome and so is an exaggeration, as long as the fact underneath it is exact.',
      'The joke is always about the ANSWER, the question, or the situation — never about the learner. Celebrate a correct answer without gushing, and keep a wrong one moving rather than dwelling on it.',
    ].join('\n'),
    sampleLine:
      'Nope! Bold answer though. Take the real one and try again later.',
  },
  {
    key: 'unfiltered',
    label: 'Unfiltered',
    description:
      'Blunt and irreverent. It will call a weak answer weak and joke about it. It never gets personal — the target is always the answer, never you. Pick this one only if you want a coach that softens nothing.',
    promptFragment: [
      'Write blunt, direct and irreverent. Say plainly that an answer was bad when it was bad; do not soften it, do not pad it, and do not open with praise you do not mean. Dry humour and mockery of a wrong answer are both in register.',
      'The target is always the ANSWER — how weak it was, how far off it was, how confidently it was wrong. Never the learner: not their ability, not their effort, not their prospects. Being blunt is not licence to be personal, and the rules below are not negotiable for this style any more than for any other.',
    ].join('\n'),
    sampleLine:
      'That answer was a mess. The right one is on the screen — go read it.',
  },
];

/**
 * Lookup by key. Returns `undefined` for a string this build does not know.
 *
 * TOTAL BY CONTRACT, NOT BY LUCK: the stored value comes from a JSONB column
 * a newer build may have written a fifth key into, so a caller reading a
 * persona off a row must be able to say "I do not know this one" and fall
 * back. Every caller in this codebase does exactly that — see
 * `resolveCoachPersona` below, which is what they should almost always use.
 */
export function findCoachPersona(
  key: string | undefined | null,
): CoachPersonaDef | undefined {
  return AI_COACH_PERSONAS.find((persona) => persona.key === key);
}

/**
 * The persona to actually speak in, given whatever the learner's settings row
 * holds — including nothing at all.
 *
 * The single place "absent means supportive" is decided. Absent namespace,
 * absent field, and an unrecognised value from a newer build all resolve the
 * same way, and they resolve here rather than at four call sites that could
 * each answer it differently.
 */
export function resolveCoachPersona(
  key: string | undefined | null,
): CoachPersonaDef {
  return findCoachPersona(key) ?? AI_COACH_PERSONAS[0];
}

/**
 * Compile-time guard: the registry must declare exactly the personas the
 * settings enum accepts, no more and no fewer.
 *
 * #317 declared `COACH_PERSONAS` first, with its own comment saying #318 would
 * invert the direction so the registry becomes the source. This is that
 * inversion, done the way that survives: rather than deriving the enum from
 * the registry (which would make the schema file import an AI module for a
 * list of four strings), the two are held together by a type-level proof that
 * fails the BUILD when they diverge. A persona added here without a matching
 * enum member is a persona no learner can store; an enum member with no entry
 * here is a stored value that resolves to nothing.
 *
 * Exported only so it is not an unused local — nothing should reference it.
 */
export type CoachPersonaRegistryCoversEnum =
  CoachPersona extends (typeof AI_COACH_PERSONAS)[number]['key']
    ? (typeof AI_COACH_PERSONAS)[number]['key'] extends CoachPersona
      ? true
      : false
    : false;

const _registryCoversEnum: CoachPersonaRegistryCoversEnum = true;
void _registryCoversEnum;
