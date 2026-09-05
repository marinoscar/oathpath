// =============================================================================
// The curated reaction bank (issue #318, epic #305 "The Coach's personality")
// =============================================================================
//
// Every word the coach says about an answer when NO AI CALL HAPPENS — which is
// most answers. `AiFeedbackCard.tsx` gates all coaching prose on
// `gradingMethod === 'ai'`, and the common case is a deterministic exact
// match, graded with no model involved at all. So a learner who gets five in
// a row right reads five identical flat sentences today. This file is what
// they read instead.
//
// -----------------------------------------------------------------------------
// WHY A CURATED BANK RATHER THAN A SECOND AI CALL
// -----------------------------------------------------------------------------
//
// Five reasons, and every one of them was load-bearing in the decision
// (`docs/specs/coach-personality.md` §4.1):
//
//  1. FREE AND INSTANT. A bank lookup is 0 ms and costs nothing. A second
//     model call is seconds and money, on the single highest-volume path in
//     the product.
//  2. IT WORKS WHEN AI DOES NOT. No user key, `systemReady: false`, `tutor`
//     unbound — the reaction still happens. This is the ONLY mechanism that
//     can cover the deterministically-graded majority, because there is no AI
//     call there to colour in the first place.
//  3. NEARLY FREE OUT LOUD. A fixed finite set is content-addressable, so each
//     spoken line is one synthesis across the entire install, ever, in E12's
//     cache — not one per learner per attempt.
//  4. AUDITABLE. This is the decisive one. An unbounded roast generator
//     pointed at people preparing for a naturalization interview is not
//     something this product can ship behind a prompt and hope. A finite bank
//     can be read end to end by a person and linted by a test.
//  5. DETERMINISTIC. See `select-line.ts` — the same attempt shows the same
//     line live and on re-read, which a generator cannot promise without
//     storing its output.
//
// -----------------------------------------------------------------------------
// HUMAN REVIEW ATTESTATION
// -----------------------------------------------------------------------------
//
// Every line below was written and read line by line, `unfiltered` included,
// in the session that authored this file, against the seven rules of
// {@link COACH_INVARIANT_FLOOR}. That review was performed by Claude
// (Anthropic's coding agent) at the repository owner's direction, not by an
// independent human reviewer, and this comment says so plainly rather than
// implying a review that did not happen — `CHANGELOG.md` records the same
// fact in the same words (#324). The banned-topic lint in
// `reaction-lines.spec.ts` is the mechanical half of the same guarantee, and
// it is the half that keeps holding after this comment goes stale.
//
// -----------------------------------------------------------------------------
// RULES FOR ANY LINE ADDED HERE
// -----------------------------------------------------------------------------
//
//  * ENGLISH ONLY, in v1. There is no i18n framework in this repository;
//    `explanationLanguage` colours AI-generated surfaces only and will
//    continue to. This is a stated limitation, not a hidden one.
//  * NO INTERPOLATION, EVER. No question text, no learner response, no name,
//    no score. A line is a constant string. The moment one takes an argument
//    it becomes a template that can be pointed at untrusted text.
//  * NEVER STATES A FACT ABOUT THE ANSWER. The verdict, the accepted answers
//    and the failure cause are rendered elsewhere, from the row. A line that
//    said "the answer is Congress" would be a second source of truth for
//    something `VISION.md` says OathPath owns.
//  * EVERY WRONG-ANSWER LINE ENDS ON A FORWARD ACTION. The floor's seventh
//    rule, and the one most easily lost when writing something funny.
//  * AT LEAST THREE LINES PER CELL. The matrix test fails a missing cell, so
//    a persona added without filling every event is a build failure rather
//    than a blank screen.
// =============================================================================

import type { CoachPersona } from './personas';

/**
 * The things a coach reacts to, v1.
 *
 * A CLOSED SET, and deliberately about what HAPPENED rather than about what
 * was rendered: `answer.self_marked` is a different event from
 * `answer.correct` even though both end with a correct attempt, because the
 * learner did something different and a coach that could not tell them apart
 * would congratulate somebody on a matcher's behalf.
 *
 * `answer.misheard` is the one event that is not about knowledge at all — it
 * says the recogniser is not trusted, which is a statement about the
 * microphone and never about the speaker. See `docs/specs/voice.md` §3.
 */
export const COACH_REACTION_EVENTS = [
  'answer.correct',
  'answer.correct_run',
  'answer.partial',
  'answer.incorrect',
  'answer.skipped',
  'answer.self_marked',
  'answer.misheard',
  'session.complete_strong',
  'session.complete_mixed',
  'session.complete_weak',
] as const;

export type CoachReactionEvent = (typeof COACH_REACTION_EVENTS)[number];

/**
 * What a caller gets for a persona or event this build does not know.
 *
 * Says only what is certainly true, exactly as `outcomeDisplay`'s own
 * fallback does for an unrecognised outcome. Not an empty string: a caller
 * that received `''` would have to decide whether to render an empty region,
 * and this function's contract is that it always returns something sayable.
 */
export const NEUTRAL_REACTION_LINE = 'Recorded. On to the next one.';

export const COACH_REACTION_LINES: Record<
  CoachPersona,
  Record<CoachReactionEvent, string[]>
> = {
  // ---------------------------------------------------------------------------
  // supportive — today's voice, unchanged.
  //
  // The bar for this persona is not "warm". It is that a learner who never
  // opens the settings page cannot tell E14 shipped. Warm without being
  // sugary, encouraging without being dishonest, and specific: `VISION.md`'s
  // own worked example prefers "You remembered this correctly three times this
  // week" to "Amazing! You're doing great!", and every line here is written
  // against that comparison.
  // ---------------------------------------------------------------------------
  supportive: {
    'answer.correct': [
      'That’s right. That one’s holding.',
      'Correct. You had that ready.',
      'Yes — that matches. Straight on to the next one.',
      'Right answer, no hesitation about it.',
    ],
    'answer.correct_run': [
      'That’s a few in a row now. This set is becoming reliable.',
      'Another one. You’re building a run here.',
      'Still going. That’s practice showing up, not luck.',
      'Several correct in a row. That is what retention looks like.',
    ],
    'answer.partial': [
      'Part of that landed. Tighten the rest and it’s yours.',
      'You’re most of the way there — one more piece to add.',
      'The idea is right; the answer isn’t complete yet. Read the rest.',
    ],
    'answer.incorrect': [
      'Not quite right — but you can get it next time. Take the answer with you.',
      'Not that one. Read the accepted answer and come back to it.',
      'That’s not a match. Worth a second look before you move on.',
      'Not this time. The answer is right there — read it now while it matters.',
    ],
    'answer.skipped': [
      'Skipped. Read the answer now, while it’s in front of you.',
      'No answer this time, and that’s fine. Read it — we’ll ask again.',
      'Moved on. This one goes back in the queue.',
    ],
    'answer.self_marked': [
      'Marked correct. You knew it; the matcher didn’t.',
      'Counted. The wording differed, the meaning didn’t.',
      'Recorded as correct — your call, and a fair one.',
    ],
    'answer.misheard': [
      'That may have come out differently than you said it. Try it once more.',
      'The transcript looks off. Say it again and we’ll take that one.',
      'We’re not confident we heard that correctly — give it another go.',
    ],
    'session.complete_strong': [
      'Strong set. Most of that is holding.',
      'That went well. Come back tomorrow and it’ll hold better still.',
      'Good run. You’re not guessing at these any more.',
    ],
    'session.complete_mixed': [
      'Mixed set — some of it landed, some needs another pass.',
      'A few gaps in there. Those are the ones worth practising next.',
      'Half solid, half still forming. That’s what practice is for.',
    ],
    'session.complete_weak': [
      'A hard set. Short sessions are how these turn around — come back tomorrow.',
      'That one was rough. The material is learnable and repetition is what does it.',
      'Not your best set. Five minutes tomorrow is enough to start moving it.',
    ],
  },

  // ---------------------------------------------------------------------------
  // academic — precise, formal, explanatory.
  //
  // Names the thing rather than the feeling. The register to aim for is a
  // careful tutor writing a margin note, not a report card: it describes what
  // the response WAS, in the vocabulary of the material, and stops.
  // ---------------------------------------------------------------------------
  academic: {
    'answer.correct': [
      'Correct. That response matches the accepted formulation.',
      'Accepted. Your answer is equivalent to the one on record.',
      'Correct — the substance matches what this question requires.',
    ],
    'answer.correct_run': [
      'Several consecutive correct responses. Retention across repetitions is the measure that matters.',
      'A sustained run. Consistency, rather than any single instance, is what indicates recall.',
      'Repeated correct recall recorded. That is the evidence spaced practice is designed to produce.',
    ],
    'answer.partial': [
      'Partially correct. The response overlaps the accepted answer without stating it completely.',
      'Incomplete. One element of the accepted answer is present; the remainder is not.',
      'Partial. Review the full formulation and note precisely what was omitted.',
    ],
    'answer.incorrect': [
      'Not accepted. Compare your response with the recorded answer and note where they diverge.',
      'Incorrect. Read the accepted answer, then attempt this question again in a later session.',
      'That response is not on the accepted list. Study the distinction before the next repetition.',
    ],
    'answer.skipped': [
      'No response recorded. Reading the answer at the moment of not knowing it is when it is most useful.',
      'Unanswered. The item returns to the queue; review the accepted answer now.',
      'Skipped. Note the answer before continuing, so the next encounter is not the first.',
    ],
    'answer.self_marked': [
      'Recorded as correct on your own assessment. Automated matching compares text, not meaning.',
      'Marked correct. The discrepancy was in wording rather than in substance.',
      'Self-assessed as correct, and scheduled accordingly.',
    ],
    'answer.misheard': [
      'Transcription confidence is low. Repeat the response so it can be assessed on what you actually said.',
      'Low recognition confidence. Nothing has been concluded from this attempt.',
      'The recorded transcript is unreliable. Please state the answer again.',
    ],
    'session.complete_strong': [
      'A strong result. Most items in this set are being recalled reliably.',
      'High accuracy across the set. Spacing, rather than volume, consolidates it from here.',
      'Strong performance. The next repetition of these items will be scheduled further out.',
    ],
    'session.complete_mixed': [
      'Mixed accuracy. The missed items are the informative ones.',
      'Uneven across the set. Concentrate the next session on the categories that lagged.',
      'Partial mastery. The distribution across categories matters more than the total.',
    ],
    'session.complete_weak': [
      'Low accuracy on this set. That is diagnostic information, not a verdict.',
      'Most items here are not yet consolidated. Shorter, more frequent sessions are the established remedy.',
      'Weak recall across the set. Review the accepted answers, then repeat the material tomorrow.',
    ],
  },

  // ---------------------------------------------------------------------------
  // playful — light, funny, quick.
  //
  // The joke is about the miss, the question, or the situation. Read every
  // line here as if the learner has just got it wrong for the third time and
  // is tired: if it still reads as friendly under that reading, it stays.
  // ---------------------------------------------------------------------------
  playful: {
    'answer.correct': [
      'Nailed it. Next.',
      'Correct, and barely broke a sweat.',
      'That’s the one. The question never stood a chance.',
    ],
    'answer.correct_run': [
      'That’s a streak. Somebody’s been studying.',
      'Another one down. The question bank is getting nervous.',
      'Still going — don’t look directly at it, you’ll break the spell.',
    ],
    'answer.partial': [
      'Half a point. You circled the answer and waved at it.',
      'So close it’s almost annoying. One more piece and it’s yours.',
      'Right neighbourhood, wrong house. Try the door next door.',
    ],
    'answer.incorrect': [
      'Nope! Bold answer though. Take the real one and try again later.',
      'That one got away. Read the answer, plot your revenge.',
      'Not it. The correct answer is right there looking smug — go learn it.',
    ],
    'answer.skipped': [
      'Skipped! Strategic retreat. Read the answer while you’re back here.',
      'We’ll pretend that didn’t happen. The question won’t — it’s coming back.',
      'Left blank. It’s already queuing up for a rematch, so take the answer now.',
    ],
    'answer.self_marked': [
      'Overruled the robot. Fair — it only reads text, and you know what you meant.',
      'Counted! The matcher was being fussy about wording.',
      'Marked correct. Take the point, it’s yours.',
    ],
    'answer.misheard': [
      'The microphone may have invented that one. Say it again.',
      'That transcript looks like nonsense, and we’re blaming the mic. One more time.',
      'We’re not confident we heard that. Give it another shot.',
    ],
    'session.complete_strong': [
      'Big set. You made that look routine.',
      'That went very well. Enjoy it, then do it again tomorrow.',
      'Strong run. The question bank is officially concerned.',
    ],
    'session.complete_mixed': [
      'A little chaotic, a lot of progress. Both things are true.',
      'Some hits, some adventures. The adventures are the useful part.',
      'Mixed bag! The misses just told you exactly what to practise.',
    ],
    'session.complete_weak': [
      'That set fought back. Rematch tomorrow, five minutes.',
      'Rough one! Everybody has these. Come back and take it apart.',
      'That round went to the questions. The answers are all right there — tomorrow.',
    ],
  },

  // ---------------------------------------------------------------------------
  // unfiltered — blunt and irreverent.
  //
  // THE ONE THE LINT EXISTS FOR. The test to apply to every line: does it
  // attack the ANSWER, or the person who gave it? "That was a guess wearing a
  // confident face" is the answer. Anything about ability, effort, speed,
  // background or prospects is the person, and does not ship — no matter that
  // the learner opted in. Consent to a blunter joke about a miss is not
  // consent to a claim about them.
  //
  // Note also what is absent by design: not one line here mentions the
  // interview, passing, or the consequence of getting this wrong for real.
  // Blunt about an answer is the product; ominous about somebody's case is
  // not, and the difference is the whole reason this persona is shippable.
  // ---------------------------------------------------------------------------
  unfiltered: {
    'answer.correct': [
      'Correct. Don’t get comfortable.',
      'Right. That’s one.',
      'Fine. That one was correct.',
    ],
    'answer.correct_run': [
      'Several in a row. Now do it again on a day you don’t feel like it.',
      'A streak. Streaks end; the schedule doesn’t.',
      'Good run. Keep it up, or it doesn’t count for much.',
    ],
    'answer.partial': [
      'Half an answer. Half doesn’t get counted — go finish it.',
      'You had it and stopped early. Go back and say the whole thing.',
      'Partly there. Partly there is not there. Read the rest.',
    ],
    'answer.incorrect': [
      'That answer was a mess. The right one is on the screen — go read it.',
      'Wrong, and not close. Read the real answer and come back for a rematch.',
      'No. That was a guess wearing a confident face. The answer is right there.',
    ],
    'answer.skipped': [
      'Nothing? Then read the answer now, while it costs you nothing.',
      'Skipped. That question is coming back, and it remembers.',
      'Blank. Fine — read the answer, and stop leaving them blank.',
    ],
    'answer.self_marked': [
      'You say you knew it. It’s counted — now prove it next time without the reveal.',
      'Marked correct. The matcher reads text; you know what you meant. Say it cleaner next time.',
      'Counted. Now say it that way when it isn’t you keeping score.',
    ],
    'answer.misheard': [
      'The transcript is garbage — that’s the microphone, not you. Say it again.',
      'We didn’t hear that properly, and we’re not grading a guess. Again.',
      'Bad audio. Nothing recorded. Repeat it.',
    ],
    'session.complete_strong': [
      'That was a strong set. Say nothing, do it again tomorrow.',
      'Solid. That’s what it looks like when the work has been done.',
      'Good set. One good set is one good set — make it a habit.',
    ],
    'session.complete_mixed': [
      'Some of that was sharp, some was improvised. Work the improvised half.',
      'Mixed. The misses are the only interesting part — go get them.',
      'Half solid. The other half needs an actual answer, not a vibe.',
    ],
    'session.complete_weak': [
      'That set went badly. It’s fixable, it just isn’t fixed yet — tomorrow, five minutes.',
      'Rough. The answers are all written down and none of them are secret. Go read them.',
      'That round went to the questions. Come back tomorrow and take it apart instead.',
    ],
  },
};
