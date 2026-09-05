// =============================================================================
// Banned-topic lint — TEST INFRASTRUCTURE, not shipped prompt content
// (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// This module ships nothing to a learner and is imported by nothing outside
// `*.spec.ts` files. It exists so `personas.spec.ts` and
// `reaction-lines.spec.ts` can run the identical check over two different
// pieces of learner-facing copy (the persona cards' `description`/`sampleLine`
// and the reaction bank) rather than each inventing its own list — a
// duplicated list is exactly the kind of copy this codebase's own
// `notification-events.ts` / `ai-model-roles.ts` header comments warn can
// drift apart unnoticed.
//
// Modelled on `apps/web/src/__tests__/pages/InterviewDebriefPage.test.tsx`'s
// own vocabulary assertion (see its "The vocabulary a debrief must never use
// about a learner" comment): a flat, explicit, cited list, checked with plain
// substring/regex matching rather than an NLP dependency, because the point
// is that a HUMAN can read the list end to end and agree it is complete.
//
// -----------------------------------------------------------------------------
// WHY REGEXES, AND WHY `\b` WORD BOUNDARIES WHERE SHOWN
// -----------------------------------------------------------------------------
//
// A plain substring match on `race` would flag "embrace"; on `family` it would
// flag nothing extra, but `native` would flag "alternative" were it not
// boundary-checked. `\bWORD\b` matches only at the edges of a WORD-CHARACTER
// run, so `\brace\b` does not match inside "embrace" (there is no boundary
// between the 'b' and the 'r') but does match the standalone word "race" or
// "Race". `deport` and `immigra` are the deliberate exceptions: they are
// matched as bare substrings (no leading/trailing `\b`) so that "deported",
// "deportation", "immigrant" and "immigration" are all caught by one pattern,
// per this issue's own instruction.
// =============================================================================

/** One named family of banned patterns, with its citation. */
export interface BannedTopicFamily {
  /** Short name, used in failure messages so a match names WHICH rule broke. */
  name: string;
  /** Where the rule comes from — quoted in every failure message. */
  citation: string;
  /** Patterns checked case-insensitively; a line matching any one fails. */
  patterns: RegExp[];
}

export const BANNED_TOPIC_FAMILIES: BannedTopicFamily[] = [
  {
    name: 'English / speech ability',
    citation:
      'VISION.md L245 "Never condescending about English ability"; COACH_INVARIANT_FLOOR rule 1 ("Never comment on the learner’s English, accent, grammar or pronunciation")',
    patterns: [
      /\benglish\b/i,
      /\baccents?\b/i,
      /\bgrammar\b/i,
      /\bpronunciations?\b/i,
      /\bpronounce[sd]?\b/i,
      /\bpronouncing\b/i,
      /\bfluent(?:ly)?\b/i,
      /\bfluency\b/i,
      /\bbroken\b/i,
      /\besl\b/i,
    ],
  },
  {
    name: 'Origin, status, identity',
    citation:
      'VISION.md’s will-not-build list; COACH_INVARIANT_FLOOR rule 2 ("Never reference their country of origin, immigration status, religion, race or family")',
    patterns: [
      /\bcountr(?:y|ies)\b/i,
      /\borigins?\b/i,
      // Deliberately a bare substring: covers immigrant/immigrants/
      // immigration/immigrate/immigrated in one pattern.
      /immigra/i,
      /\bvisas?\b/i,
      /\bgreen cards?\b/i,
      // Deliberately a bare substring: covers deport/deported/deportation.
      /deport/i,
      /\breligions?\b/i,
      /\breligious\b/i,
      /\brac(?:e|es|ial)\b/i,
      /\bethnic(?:ity)?\b/i,
      /\bfamil(?:y|ies)\b/i,
      /\bforeign(?:er|ers)?\b/i,
      /\bnative\b/i,
    ],
  },
  {
    name: 'Capability slurs',
    citation:
      'COACH_INVARIANT_FLOOR rule 3 ("Never imply the material should be obvious, or that they are slow") and VISION.md Product Principle #9 ("Never patronize, shame, or underestimate the learner")',
    patterns: [
      /\bstupid\b/i,
      /\bdumb\b/i,
      /\bidiots?\b/i,
      /\bmorons?\b/i,
      /\bslow\b/i,
      /\blazy\b/i,
      /\bincompetent\b/i,
      /\bobvious(?:ly)?\b/i,
      // "simple" and "easy" are legitimately risky (implying the material
      // should be easy is exactly rule 3) — included on purpose. A shipped
      // line tripping these is the lint doing its job, not a false positive
      // to explain away.
      /\bsimple\b/i,
      /\beasy\b/i,
    ],
  },
  {
    name: 'Failure prophecy',
    citation:
      'COACH_INVARIANT_FLOOR rule 4 ("Never say or imply they will fail, or will not become a citizen")',
    patterns: [
      /\bfail(?:s|ed|ing|ure)?\b/i,
      /\bflunk(?:s|ed|ing)?\b/i,
      /won'?t pass/i,
      /will not pass/i,
      /never pass/i,
      /not become a citizen/i,
      /\bdenied\b/i,
      /\brejected\b/i,
    ],
  },
];

/**
 * Every family pattern this line trips, by family name. Empty when the line
 * is clean.
 */
export function bannedFamilyHits(line: string): string[] {
  const hits: string[] = [];
  for (const family of BANNED_TOPIC_FAMILIES) {
    if (family.patterns.some((pattern) => pattern.test(line))) {
      hits.push(family.name);
    }
  }
  return hits;
}
