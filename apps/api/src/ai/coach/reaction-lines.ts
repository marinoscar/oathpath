// =============================================================================
// The curated reaction bank (issue #318, epic #305 "The Coach's personality";
// deepened by issue #352, epic #345 "The conversation the coach has")
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
// AUTHORSHIP AND REVIEW ATTESTATION — READ THIS BEFORE TRUSTING THE BANK
// -----------------------------------------------------------------------------
//
// Stated as a fact about who did what, not as a reassurance:
//
//   * EVERY line in this file — the 123 that shipped with #318 and the 525
//     that #352 added, 648 in total — was WRITTEN BY CLAUDE (Anthropic's
//     coding agent), working at the repository owner's direction and under
//     his standing authorization to merge without his own review. No human
//     wrote any of them.
//   * Every line was read back by that same agent against the seven rules of
//     {@link COACH_INVARIANT_FLOOR}. That is an AI author checking its own
//     output. It is worth something and it is NOT an independent review.
//   * NO HUMAN HAS READ THIS BANK END TO END. `unfiltered`'s cells
//     specifically have not had a human read. A human read is recommended
//     before this feature reaches a public release, and nothing in this
//     comment should be quoted as evidence that one happened.
//   * The MECHANICAL half of the guarantee is real and is enforced on every
//     build: `reaction-lines.spec.ts` runs the banned-topic lint
//     (`banned-topics.ts`) over every shipped line, checks the depth floor
//     below, checks that every wrong-answer line ends on a forward action, and
//     fails the build on a match. That check does not go stale when this
//     comment does, which is precisely why it exists.
//
// `CHANGELOG.md` records the same fact in the same words. If you edit this
// bank, edit this attestation to describe what YOU actually did — carrying it
// forward unchanged is how a comment becomes a false claim.
//
// -----------------------------------------------------------------------------
// THE DEPTH FLOOR, AND THE NUMBER IT COMES FROM
// -----------------------------------------------------------------------------
//
// #318 shipped a floor of three lines per cell. Three rotates visibly: the
// epic's own stated failure was "five identical flat sentences", and three
// sentences on rotation is a smaller version of the same defect — worst of all
// for `playful` and `unfiltered`, whose entire value is not sounding canned.
//
// The floor is now derived from a number the product already fixes rather than
// from taste. `MAX_PLANNED_COUNT` (`practice/dto/create-practice-session.dto.ts`)
// is 20: twenty questions is the largest session this application will create,
// so twenty is the largest number of reactions one session can produce, and
// therefore the largest number of times a single `answer.*` cell can be drawn
// before the learner leaves the screen.
//
//   * {@link COACH_MIN_LINES_PER_ANSWER_CELL} = 20 — every `answer.*` cell.
//     At this depth a full session at the maximum planned count can NEVER BE
//     FORCED to repeat a line: there are always at least as many lines
//     available as there are draws. (An all-correct session splits its draws
//     between `answer.correct` and `answer.correct_run`, so those two are
//     over-provisioned; one number for all seven is a rule a reader can hold,
//     and per-event arithmetic is not.)
//   * FOUR CELLS GO DEEPER THAN THE FLOOR ON PURPOSE, at 24:
//     `playful` and `unfiltered`'s `answer.correct` and `answer.incorrect`.
//     Those are the two events a learner meets most, in the two personas
//     whose entire value is not sounding canned — the floor is a minimum, and
//     the effort is weighted where repetition is felt first.
//   * {@link COACH_MIN_LINES_PER_SESSION_CELL} = 6 — the three
//     `session.complete_*` cells. A session draws one of these EXACTLY ONCE,
//     so depth here buys variety across sessions rather than within one, and
//     six is two weeks of daily practice before a learner meets a repeat.
//
// WHAT THE FLOOR DOES NOT PROMISE, stated plainly so nobody reads more into it
// than it says: `select-line.ts` picks with `hash(seed) % lines.length`, and
// two different attempt ids in the same session can hash to the same index.
// Depth removes the FORCED repeat (the pigeonhole one); it does not make a
// coincidental one impossible, and no bank depth ever could under modular
// hashing. `reaction-lines.spec.ts` asserts both halves separately and says so.
//
// -----------------------------------------------------------------------------
// EDITING THIS BANK CHANGES WHICH LINE AN OLD ATTEMPT SHOWS. THAT IS EXPECTED.
// -----------------------------------------------------------------------------
//
// `reactionLine` reduces the seed's hash modulo the cell's LENGTH, so adding a
// line to a cell re-maps every seed in it. A learner re-reading a session from
// last month may find a different (still in-voice, still linted) line beside
// an attempt than the one they saw live.
//
// This is not the determinism guarantee breaking. `docs/specs/coach-personality.md`
// §7's promise is that the line is stable FOR A FIXED BANK AND A FIXED PERSONA
// — the same reason §9 already accepts that switching persona re-voices past
// attempts, and the direct consequence of computing the reaction at read time
// instead of freezing it into a column. A stored line would survive a bank
// edit and would then be copy no improvement could ever reach. Do not "fix"
// this by persisting the selection.
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
//  * MEET THE DEPTH FLOOR ABOVE. The matrix test fails a short cell, so a
//    persona added without filling every event to the floor is a build
//    failure rather than a blank screen or a visible rotation.
//  * NO LINE APPEARS TWICE ANYWHERE IN THE BANK — not within a cell, not
//    across two cells, not across two personas. A session draws from several
//    cells at once, so a line shared between two of them is a repeat a
//    learner can hear inside one session, which is the whole thing the depth
//    floor exists to prevent.
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
 *
 * ALL TEN ARE REACHABLE TODAY. `answer.partial` was the one open question
 * (#352 asked it directly), and the answer is that it went live with E4:
 * `GRADING_VERDICTS` (`practice/grading.ts`) offers the grader `partial`,
 * `PracticeService.grade` persists `aiGrading?.outcome ?? outcome`, and
 * `coachEventForAttempt` maps a `partial` row straight to this cell. It is
 * dark only on a deployment with no AI configured — where the deterministic
 * matcher is binary by construction, exactly as
 * `apps/web/src/components/practice/outcome.ts` said when E3 was the only
 * grading path — and lit on every deployment that has bound a `grader` model.
 * Its lines are held to the same floor as every other cell for that reason.
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
 * The minimum number of lines in an `answer.*` cell.
 *
 * `MAX_PLANNED_COUNT` — twenty — because that is the largest session this
 * application creates and therefore the largest number of times one session
 * can draw a single cell. See the header's depth-floor section for why this
 * removes the FORCED repeat and not the coincidental one.
 *
 * Deliberately a literal here rather than an import of `MAX_PLANNED_COUNT`
 * itself: this module imports nothing at runtime but a type, the same
 * discipline `select-line.ts` and `attempt-event.ts` each state for
 * themselves, and a content file that reached into a practice DTO would be
 * the first exception. `reaction-lines.spec.ts` imports BOTH and asserts they
 * agree, so raising the session cap fails this bank's test rather than
 * silently shortening its guarantee.
 */
export const COACH_MIN_LINES_PER_ANSWER_CELL = 20;

/**
 * The minimum number of lines in a `session.complete_*` cell.
 *
 * Six, not twenty: a session draws one of these exactly once, so depth here
 * is variety BETWEEN sessions, not within one. Six is roughly two weeks of
 * daily practice landing in the same band before a learner meets a repeat.
 */
export const COACH_MIN_LINES_PER_SESSION_CELL = 6;

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
  //
  // The register is also mechanically pinned: `reaction-lines.spec.ts` fails
  // an exclamation mark anywhere in this persona, and fails the blunt
  // imperative-mock openers `unfiltered` is allowed. Depth was added without
  // reaching for either.
  // ---------------------------------------------------------------------------
  supportive: {
    'answer.correct': [
      'That’s right. That one’s holding.',
      'Correct. You had that ready.',
      'Yes — that matches. Straight on to the next one.',
      'Right answer, no hesitation about it.',
      'Correct. That one is settling in.',
      'That matches. You did not have to reach for it.',
      'Right. That one came back cleanly.',
      'Correct, and steady with it.',
      'That’s the answer. Recorded as correct.',
      'Yes, that’s it. One more the schedule can space out.',
      'Correct. That question is doing less work on you now.',
      'That’s right, and it came quickly.',
      'Right answer. Nothing wobbly about that one.',
      'Correct. You have earned a little confidence on this one.',
      'That matches what the question is asking for.',
      'Right. That is recall, not a lucky guess.',
      'Correct. That one is where you want it.',
      'Yes. You are answering that one from memory now.',
      'That’s right. The next repetition of it moves further out.',
      'Correct. That one no longer needs a second look.',
    ],
    'answer.correct_run': [
      'That’s a few in a row now. This set is becoming reliable.',
      'Another one. You’re building a run here.',
      'Still going. That’s practice showing up, not luck.',
      'Several correct in a row. That is what retention looks like.',
      'That’s another. The run is real at this point.',
      'Another right answer on top of the last. That is a run.',
      'Still holding. Repeated recall is the part that lasts.',
      'You are stringing these together now.',
      'That’s several without a stumble.',
      'The run continues. This is what a good session looks like from the inside.',
      'Another. Repetition is doing its work.',
      'Still correct. Runs like this are how a set stops feeling new.',
      'That’s a steady stretch of right answers.',
      'You have momentum on this set.',
      'Another one held. That’s the pattern worth repeating.',
      'Correct again. The run says more than any single answer does.',
      'Still going, and still from memory.',
      'That is a run you built, not one you fell into.',
      'Several in a row now. Come back tomorrow and it will be longer.',
      'Another. This stretch is the evidence, not the score.',
    ],
    'answer.partial': [
      'Part of that landed. Read the rest and tighten it, and it’s yours.',
      'You’re most of the way there — read the rest and add the missing piece.',
      'The idea is right; the answer isn’t complete yet. Read the rest.',
      'Half of that matched. Read the full answer and see what was left out.',
      'You had part of it. Note the missing piece before you move on.',
      'That’s a start on the answer. Read the whole one now.',
      'Some of that matched. Go and read the rest while it’s in front of you.',
      'Close, but not the whole answer. Read it through once more.',
      'You named part of it. Study the remainder, it is short.',
      'That covers some of the answer. Read what it leaves out.',
      'Partly there. Take a moment and read the complete answer.',
      'One piece of it landed. Note the other and come back to this one.',
      'That’s the right idea, unfinished. Go and finish it.',
      'You are near it. Read the accepted answer and fill the gap.',
      'Part of the answer, not all of it. Review the rest now.',
      'That matched in part. Try it again later with the whole thing.',
      'Something in that was right. Read the answer and keep the rest.',
      'You got some of it back. Study the piece that did not come.',
      'Not complete yet. Read it, and it will be next time.',
      'Part credit on the meaning. Go over the full answer once.',
    ],
    'answer.incorrect': [
      'Not quite right — but you can get it next time. Take the answer with you.',
      'Not that one. Read the accepted answer and come back to it.',
      'That’s not a match. Give the accepted answer a second read before you move on.',
      'Not this time. The answer is right there — read it now while it matters.',
      'That one didn’t land. Read it, and it will be waiting for you again.',
      'Not a match. Take thirty seconds and read the answer properly.',
      'That’s not it. Go and read the accepted answer while the question is fresh.',
      'Missed. This is the moment reading the answer does the most good.',
      'Not right. Note the answer, and we’ll ask you again.',
      'That one got away. Read it, then move on without dwelling.',
      'Not a match this time. Review the answer and come back to it.',
      'That didn’t match. Read the answer; this one is worth a second pass.',
      'Not it. The question returns — read the answer so it’s different next time.',
      'Missed this one. Study the answer for a moment, then keep going.',
      'Not correct. Read the accepted answer once, out loud if that helps.',
      'That’s a miss, and there is nothing wrong with that. Read the answer and carry on.',
      'Not the one. Go and read what the question accepts.',
      'That answer didn’t match. Take the real one with you to tomorrow.',
      'Missed. Read the answer now — that is what turns this one around.',
      'Not this time. Note what the accepted answer says and try it again later.',
    ],
    'answer.skipped': [
      'Skipped. Read the answer now, while it’s in front of you.',
      'No answer this time, and that’s all right. Read it — we’ll ask again.',
      'Moved on. This one goes back in the queue.',
      'Left blank. Read the accepted answer before the next question.',
      'Nothing this time. Take the answer with you and go on.',
      'Skipped, which is allowed. Read what it was asking for.',
      'You passed on that one. Read the answer so the next meeting is not the first.',
      'No response. Study the answer for a moment now.',
      'Skipped. It returns later — read the answer so it lands then.',
      'That one stays unanswered. Note the answer and continue.',
      'Blank for now. Go and read the accepted answer.',
      'Nothing recorded. Read it, and try it again another day.',
      'Skipped this one. Review the answer before you move along.',
      'You let that one go. Read the answer; it’s short.',
      'No answer given. Read the accepted one now rather than later.',
      'Passed over. The answer is on the screen — read it.',
      'Skipped. Come back to this one when the queue offers it again.',
      'Nothing this time, and nothing lost. Read the answer.',
      'Left unanswered. Note it and keep going.',
      'Skipped. Tomorrow it will come round again — read the answer today.',
    ],
    'answer.self_marked': [
      'Marked correct. You knew it; the matcher didn’t.',
      'Counted. The wording differed, the meaning didn’t.',
      'Recorded as correct — your call, and a fair one.',
      'Counted as correct. Matching text is not the same as knowing the answer.',
      'Marked. You are the better judge of what you meant.',
      'Taken as correct. The matcher reads letters, not meaning.',
      'Counted. Your phrasing, the same answer.',
      'Recorded correct on your own reading of it.',
      'Marked correct. That was a wording gap, not a knowledge gap.',
      'Counted. The two answers meant the same thing.',
      'Your call, recorded. That is what self-marking is for.',
      'Marked correct, and the schedule takes it as such.',
      'Counted. A near-miss in words is still the answer.',
      'Recorded as correct. You said it your way.',
      'Marked. The matcher missed the meaning; you did not.',
      'Counted as right. The answer was in there.',
      'Marked correct. Noted and scheduled like any other.',
      'Counted. You knew it, and that is the thing being measured.',
      'Recorded. Say it a little closer to the accepted wording and the matcher will agree next time.',
      'Marked correct on your judgement, and that judgement is the one that counts here.',
    ],
    'answer.misheard': [
      'That may have come out differently than you said it. Try it once more.',
      'The transcript looks off. Say it again and we’ll take that one.',
      'We’re not confident we heard that correctly — give it another go.',
      'The microphone is not sure what it caught. Say it again.',
      'That transcript does not look like a real answer. One more time.',
      'We didn’t catch that cleanly. Nothing has been held against you.',
      'The recording came through unclear. Try it again when you’re ready.',
      'We are not sure what was recorded there. Say it once more.',
      'That did not come through well enough to judge. Again, when you’re ready.',
      'The audio was not clear. Nothing about that was your knowledge.',
      'We heard something, but not clearly enough to count it.',
      'The transcript is unreliable, so nothing was concluded. Try again.',
      'That one is on the recording, not on you. Say it again.',
      'Not enough confidence in what was captured. One more go.',
      'The words did not come through. Repeat it and we’ll take that.',
      'We could not make that out. Nothing was recorded against the question.',
      'That came through garbled. Say it again, a little closer to the microphone.',
      'The recogniser was unsure. That is a microphone problem, not a memory one.',
      'We are setting that one aside — we could not hear it well enough.',
      'That did not land in the transcript. Give it one more try.',
    ],
    'session.complete_strong': [
      'Strong set. Most of that is holding.',
      'That went well. Come back tomorrow and it’ll hold better still.',
      'Good run. You’re not guessing at these any more.',
      'A solid session. That is what prepared looks like on an ordinary day.',
      'That set held up. Space it out and it will keep holding.',
      'Most of that came back cleanly. Good place to stop.',
    ],
    'session.complete_mixed': [
      'Mixed set — some of it landed, some needs another pass.',
      'A few gaps in there. Those are the ones worth practising next.',
      'Half solid, half still forming. That’s what practice is for.',
      'Some held, some didn’t. The ones that didn’t are the useful half.',
      'An uneven set, and an ordinary one. Come back to the misses tomorrow.',
      'Progress with edges. The edges are where the next session goes.',
    ],
    'session.complete_weak': [
      'A hard set. Short sessions are how these turn around — come back tomorrow.',
      'That one was rough. The material is learnable and repetition is what does it.',
      'Not your best set. Five minutes tomorrow is enough to start moving it.',
      'That set did not go your way. It is still early for this material.',
      'A tough round. Nothing here is out of reach; it just needs another pass.',
      'That was heavy going. Come back tomorrow and take a smaller bite.',
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
      'Accepted. The response satisfies the criteria for this item.',
      'Correct. Recall was achieved without prompting.',
      'That is an accepted answer, stated accurately.',
      'Correct. The item is recorded as recalled on this occasion.',
      'Accepted. No material difference from the recorded answer.',
      'Correct. This item’s next repetition will be scheduled at a longer interval.',
      'Accurate. The response contains what the question asks for.',
      'Correct. Retrieval succeeded on the first attempt.',
      'Accepted. The wording differs from the record; the substance does not.',
      'Correct. That is one more successful retrieval for this item.',
      'Accepted, and recorded as evidence of recall.',
      'Correct. The response is complete as stated.',
      'That answer is on the accepted list for this question.',
      'Correct. Nothing in the response conflicts with the record.',
      'Accepted. Recall on this item appears stable.',
      'Correct. The item advances in the schedule.',
      'Accurate and complete. Recorded as correct.',
    ],
    'answer.correct_run': [
      'Several consecutive correct responses. Retention across repetitions is the measure that matters.',
      'A sustained run. Consistency, rather than any single instance, is what indicates recall.',
      'Repeated correct recall recorded. That is the evidence spaced practice is designed to produce.',
      'Consecutive successes. The pattern is more informative than the total.',
      'A continued sequence of accepted responses on distinct items.',
      'Recall is holding across successive items in this session.',
      'Another accepted response in sequence. Interference between items appears low.',
      'Successive retrievals without error. That is the condition under which intervals lengthen.',
      'The run continues. Repetition across varying items is the harder test, and it is being met.',
      'Consecutive accepted responses recorded. Consolidation is proceeding.',
      'Sustained accuracy across the last several items.',
      'Another in an unbroken sequence. A streak in isolation says little; this one is long enough to note.',
      'Recall is consistent across items from differing categories.',
      'A further correct response in an ongoing run. The schedule will reflect it.',
      'Repeated success. The next spacing interval for these items will be longer.',
      'Continued accuracy. Nothing in this sequence suggests guessing.',
      'Another accepted answer in sequence. Performance is stable within this session.',
      'The sequence continues, which is the observation worth recording.',
      'Consecutive correct retrievals. Within-session runs predict later retention only weakly, but they are not nothing.',
      'Still accurate. The measure to watch now is whether it holds tomorrow.',
    ],
    'answer.partial': [
      'Partially correct. The response overlaps the accepted answer without stating it completely; read it in full.',
      'Incomplete. One element of the accepted answer is present; the remainder is not. Note the remainder before the next repetition.',
      'Partial. Review the full formulation and note precisely what was omitted.',
      'Partially accepted. Read the recorded answer and identify the omitted element.',
      'The response is correct as far as it goes. Study the portion that is missing.',
      'Incomplete recall. Read the whole answer, then attempt the item again later.',
      'Part of the accepted answer is present. Note the balance of it now.',
      'Partial match. The omission is the informative part; review it.',
      'Some elements were retrieved; others were not. Read the complete formulation.',
      'Partially correct. Note which component did not come to mind.',
      'Incomplete. Read the recorded answer and compare it with what you produced.',
      'The substance is partly there. Review the remainder before continuing.',
      'Partial answers are recorded as partial. Read the full one now.',
      'One component correct, at least one absent. Note the absent one.',
      'Partially accurate. Study the complete answer, which is short.',
      'Incomplete response. Read it in full; the gap is narrow.',
      'The answer is begun rather than given. Review it and try again later.',
      'Partial. Compare your response with the record and note the difference.',
      'Some of the accepted content is present. Read the rest now.',
      'Partially correct, and recorded as such. Review the whole answer before the next attempt.',
    ],
    'answer.incorrect': [
      'Not accepted. Compare your response with the recorded answer and note where they diverge.',
      'Incorrect. Read the accepted answer, then attempt this question again in a later session.',
      'That response is not on the accepted list. Study the distinction before the next repetition.',
      'Not a match. Read the record; the difference is the thing to learn.',
      'Incorrect on this attempt. Retrieval difficulty at this stage is expected; review the answer.',
      'The response does not correspond to the accepted answer. Read it now.',
      'Not accepted. Note the correct formulation and continue.',
      'Incorrect. This item returns sooner in the schedule; read the answer so the next attempt differs.',
      'That does not match the record. Review the accepted answer carefully.',
      'Not accepted. Corrective reading is most effective immediately after an error, so read it now.',
      'Incorrect. Study the recorded answer, then move on without rehearsing the error.',
      'The response is outside the accepted set. Read the record and note why.',
      'Not a match. Review the answer; this item will be asked again.',
      'Incorrect. Note the accepted formulation before continuing.',
      'That answer is not recorded as acceptable. Read the one that is.',
      'Not accepted. Attempt it again in a later session, after reading the answer.',
      'Incorrect. The gap is specific rather than general; read the answer and see it.',
      'Not on the list of accepted answers. Study it now, while the question is present.',
      'Incorrect. Read the record and note the precise wording it expects.',
      'Not accepted. Review it now; retrieval improves after a corrected reading.',
    ],
    'answer.skipped': [
      'No response recorded. Reading the answer at the moment of not knowing it is when it is most useful.',
      'Unanswered. The item returns to the queue; review the accepted answer now.',
      'Skipped. Note the answer before continuing, so the next encounter is not the first.',
      'No attempt recorded. Read the accepted answer; an unattempted item teaches nothing on its own.',
      'Omitted. Study the answer now, while the question is in front of you.',
      'Unanswered, and recorded as such. Review the record before moving on.',
      'No response. The item is rescheduled; read the answer so the next attempt has something to draw on.',
      'Skipped. Reading the answer now converts a blank into a first exposure.',
      'Nothing recorded for this item. Note the answer and continue.',
      'Omitted rather than incorrect. The distinction is preserved; read the answer.',
      'No attempt. Review the accepted formulation before the next question.',
      'Unanswered. Read the record; the item will return.',
      'Skipped. Study the answer for a moment; the exposure is worth more than the skip cost.',
      'No response given. Note the accepted answer now.',
      'Passed over. Read the record, then continue with the session.',
      'Unattempted. Reading the answer immediately is the standard remedy; go ahead and read it.',
      'No answer recorded. Review it now rather than at the end.',
      'Skipped, and scheduled to return. Read the accepted answer.',
      'Nothing to assess. Read the record so there is something next time.',
      'Omitted. Note the answer, then attempt the item again in a later session.',
    ],
    'answer.self_marked': [
      'Recorded as correct on your own assessment. Automated matching compares text, not meaning.',
      'Marked correct. The discrepancy was in wording rather than in substance.',
      'Self-assessed as correct, and scheduled accordingly.',
      'Accepted on your judgement. The matcher operates on strings; you operate on meaning.',
      'Recorded correct. Text comparison has known limits, and this is one of them.',
      'Marked as correct by you. The item is scheduled as a success.',
      'Your assessment is recorded. Semantic equivalence is not something exact matching can detect.',
      'Counted as correct. The recorded answer and your response are equivalent in substance.',
      'Self-marked. The evidence table records the outcome and the method separately.',
      'Accepted. Your response differed in form from the record, not in content.',
      'Recorded as correct on review. That is a legitimate use of this control.',
      'Marked correct. Note the recorded wording, which may match automatically next time.',
      'Your call, recorded as correct and scheduled as such.',
      'Accepted on self-assessment, with the method noted on the row.',
      'Counted. Exact matching is conservative by design; this control exists for that reason.',
      'Recorded correct. The distinction between knowing and phrasing is the one this control preserves.',
      'Marked. The item advances in the schedule exactly as an exact match would.',
      'Self-assessed correct. The record notes who made the assessment.',
      'Accepted. Consider adopting the recorded phrasing, which the matcher will accept unaided.',
      'Recorded as correct. Nothing about the schedule treats it differently.',
    ],
    'answer.misheard': [
      'Transcription confidence is low. Repeat the response so it can be assessed on what you actually said.',
      'Low recognition confidence. Nothing has been concluded from this attempt.',
      'The recorded transcript is unreliable. Please state the answer again.',
      'The audio did not transcribe with sufficient confidence to be assessed.',
      'No assessment has been made: the transcript is not trustworthy.',
      'Recognition confidence fell below the threshold at which grading is meaningful.',
      'The captured text does not reliably represent what was said. Please repeat it.',
      'Insufficient transcription quality. The item is unaffected by this attempt.',
      'The recogniser reported low confidence. No outcome has been recorded.',
      'This attempt cannot be assessed on the transcript produced. Please try again.',
      'The transcript is not reliable evidence of the response. Nothing was recorded.',
      'Audio capture was inadequate for assessment. Repeat the answer.',
      'Low confidence in the transcription; the attempt has been set aside.',
      'The transcript quality is below what assessment requires. Please state it again.',
      'Recognition was unreliable here. No conclusion has been drawn about recall.',
      'The transcript does not support an assessment. Repeat the response.',
      'Capture quality, not response quality, is the limitation on this attempt.',
      'The recorded text is unreliable, so no outcome has been written.',
      'Transcription did not reach the required confidence. Please repeat the answer.',
      'Nothing has been assessed. The transcript could not be relied on.',
    ],
    'session.complete_strong': [
      'A strong result. Most items in this set are being recalled reliably.',
      'High accuracy across the set. Spacing, rather than volume, consolidates it from here.',
      'Strong performance. The next repetition of these items will be scheduled further out.',
      'Accuracy was high across the session. The schedule will lengthen accordingly.',
      'Most items were retrieved successfully. Consolidation appears to be proceeding.',
      'A strong set, and a useful one: high accuracy with genuine retrieval is the target condition.',
    ],
    'session.complete_mixed': [
      'Mixed accuracy. The missed items are the informative ones.',
      'Uneven across the set. Concentrate the next session on the categories that lagged.',
      'Partial mastery. The distribution across categories matters more than the total.',
      'Accuracy was moderate. Items recalled and items missed are being scheduled differently.',
      'A mixed result, which is the ordinary state part-way through a body of material.',
      'Some items are consolidated and some are not. The schedule now separates them.',
    ],
    'session.complete_weak': [
      'Low accuracy on this set. That is diagnostic information, not a verdict.',
      'Most items here are not yet consolidated. Shorter, more frequent sessions are the established remedy.',
      'Weak recall across the set. Review the accepted answers, then repeat the material tomorrow.',
      'Accuracy was low. Early exposure to unfamiliar material characteristically produces this.',
      'Few items were retrieved. That is a measurement of where the material stands, nothing more.',
      'Low recall across the session. Spacing works from any starting point, including this one.',
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
      'Correct. You made that look routine.',
      'Bang on. Moving right along.',
      'Yes! That answer arrived fully formed.',
      'Correct. The question folded immediately.',
      'That’s it exactly. Well remembered.',
      'Right answer, no drama.',
      'Correct. Somebody has been paying attention.',
      'Yes — that one was in there ready to go.',
      'Spot on. The question is retiring for a while.',
      'Correct, and quickly at that.',
      'That’s right. Chalk one up.',
      'Correct. That question will need a better disguise next time.',
      'Got it. On we go.',
      'Right on the money. Next question, please.',
      'Correct. You had that one loaded and waiting.',
      'Yes. Straight out, no rummaging.',
      'Correct. The question bank concedes this round.',
      'Correct. Filed under: knew that.',
      'Yes. Next question, before the momentum notices.',
      'That’s right, and it didn’t hesitate on the way out.',
      'Correct. The answer was exactly where you left it.',
    ],
    'answer.correct_run': [
      'That’s a streak. Somebody’s been studying.',
      'Another one down. The question bank is getting nervous.',
      'Still going — don’t look directly at it, you’ll break the spell.',
      'Streak intact. Nobody panic.',
      'Another. This is becoming a pattern, and the pattern is good.',
      'Still unbeaten this round.',
      'That’s several in a row. The questions are conferring.',
      'Run continues. Keep the momentum, ignore me.',
      'Another right answer joins the pile.',
      'You’re on a tear. Carry on.',
      'Still going strong. This is fun to watch.',
      'That’s a proper run now, not a fluke.',
      'Another. At this rate the bank will need reinforcements.',
      'Unbroken. Long may it continue.',
      'Streak extended. The schedule is quietly impressed.',
      'Another one. You are making this look choreographed.',
      'Still correct, still quick. Excellent.',
      'That’s the run growing again. No notes.',
      'Another right answer, no hesitation. Splendid.',
      'The run holds. Somebody has clearly done the reading.',
    ],
    'answer.partial': [
      'Half a point. You circled the answer and waved at it. Go and say the rest.',
      'So close it’s almost annoying. One more piece and it’s yours — go read it.',
      'Right neighbourhood, wrong house. Try the door next door.',
      'You got part of it out. Read the rest before it escapes.',
      'That’s half an answer wearing a whole answer’s hat. Go and read the other half.',
      'Partly there! Read the full one and collect the rest.',
      'You brought some of the answer. Go back for the rest of it.',
      'Nearly. Read what you left behind and it’ll stick.',
      'That’s the beginning of the answer. Read the middle and the end too.',
      'Good start, unfinished business. Go and finish it.',
      'Half marks, and half is not the whole. Read it properly.',
      'You had it and stopped for a snack. Go and read the rest.',
      'Close enough to be irritating. Try the full answer next time.',
      'That is the answer with a bite taken out of it. Read it whole.',
      'Partly right — the missing bit is short. Go and read it.',
      'You waved at the answer from a distance. Go and read it up close.',
      'Some of that counted. Read the rest and next time all of it will.',
      'Not quite the full set. Go and read what’s missing.',
      'Nearly there, genuinely. Read the answer once and try again later.',
      'That’s an answer in progress. Read the finished version.',
    ],
    'answer.incorrect': [
      'Nope! Bold answer though. Take the real one and try again later.',
      'That one got away. Read the answer, plot your revenge.',
      'Not it. The correct answer is right there looking smug — go learn it.',
      'Swing and a miss. Read the answer and come back for it.',
      'No, but confidently no. Go and read what it wanted.',
      'That’s a miss. The answer is short — read it now.',
      'Wrong door. Read the answer, then try the right one later.',
      'Not this time. Take the answer, keep the grudge, come back.',
      'Missed. Read the accepted answer before it gets away too.',
      'That one’s not it. Go on, read the answer, nobody’s watching.',
      'Nope. The question wins this round. Read the answer and rematch tomorrow.',
      'Not a match. Read the answer, it’s much less trouble than it looks.',
      'Missed it. Go and read the answer while you’re annoyed enough to remember it.',
      'That answer belonged to a different question. Read this one’s.',
      'No luck there. Read the accepted answer and try it again later.',
      'Not quite. Read it now — future you will be grateful.',
      'That’s a no. Read the answer, then let it go.',
      'Missed. Study the answer for ten seconds; that’s all it needs.',
      'Not it. The answer is on the screen and it is not hiding. Read it.',
      'Wrong one. Read the right one, and come back to this question later.',
      'Not that one, sadly. The real answer is one read away.',
      'Miss. Read the answer and pretend this never happened.',
      'That’s not the one it wanted. Go and read what it did want.',
      'No — but a decent guess. Read the answer and upgrade it.',
    ],
    'answer.skipped': [
      'Skipped! Strategic retreat. Read the answer while you’re back here.',
      'We’ll pretend that didn’t happen. The question won’t — read the answer before it comes back.',
      'Left blank. It’s already queuing up for a rematch, so take the answer now.',
      'Skipped. Bold move. Read the answer to make it worthwhile.',
      'Nothing? Fair enough. Go and read what it wanted.',
      'Passed. The question will be back — read the answer now.',
      'Skipped, noted, forgiven. Read the answer.',
      'A blank. Let’s fix that: read the accepted answer.',
      'You dodged that one. Read the answer so the dodge pays off.',
      'Nothing entered. Go and read the answer; it’s two lines.',
      'Skipped it. The queue is patient — read the answer while you wait.',
      'Left it alone. Read the answer and it won’t be a stranger next time.',
      'That one goes unanswered. Study it for a moment before you move.',
      'Skipped. Nobody’s counting that against you — read the answer, though.',
      'Blank submitted. Read the real answer; it’s more fun than the blank.',
      'You waved it through. Read the answer as it goes past.',
      'Skipped. Come back to this one tomorrow, after reading the answer.',
      'No answer given. Read the answer instead — it’s free.',
      'Skipped. Read what it was after and get on with it.',
      'Nothing this time. Go and read the answer, then carry on.',
    ],
    'answer.self_marked': [
      'Overruled the robot. Fair — it only reads text, and you know what you meant.',
      'Counted! The matcher was being fussy about wording.',
      'Marked correct. Take the point, it’s yours.',
      'You appealed and you won. Point awarded.',
      'The matcher blinked. Marked correct.',
      'Counted. Text matching has no imagination, and you do.',
      'Marked correct. The machine reads letters; you were talking sense.',
      'Your call, and a good one. Recorded as correct.',
      'Counted. The matcher was reading, not listening.',
      'Overturned on appeal. Correct it is.',
      'Marked. The meaning was there even if the words weren’t identical.',
      'Point restored. The matcher will get over it.',
      'Counted as correct. Nicely argued.',
      'Marked right. The wording was different; the answer wasn’t.',
      'You claimed that one and it’s granted.',
      'Counted. Say it the recorded way next time and skip the paperwork.',
      'Marked correct. The robot has been informed.',
      'Yours. The matcher only compares strings, and strings are not the point.',
      'Counted. That is exactly what this button is for.',
      'Marked correct. No further questions.',
    ],
    'answer.misheard': [
      'The microphone may have invented that one. Say it again.',
      'That transcript looks like nonsense, and we’re blaming the mic. One more time.',
      'We’re not confident we heard that. Give it another shot.',
      'The microphone was daydreaming. Try that again.',
      'That came through as gibberish. The mic’s doing, not yours.',
      'We caught roughly nothing there. One more go.',
      'The transcript reads like a poem. Say it again for the record.',
      'Something got lost between you and the microphone. Repeat it.',
      'That did not survive the trip through the mic. Again, please.',
      'We heard a noise and wrote it down. Let’s try that once more.',
      'The recording had other ideas. Say it again.',
      'Nothing usable came through, and nothing was recorded. Go again.',
      'The mic garbled that beyond rescue. One more time.',
      'We are not counting that — we could not hear it. Again.',
      'That transcript is not evidence of anything. Try again.',
      'The microphone dropped it somewhere. Say it once more.',
      'Static wins that round. Repeat the answer.',
      'We could not make head nor tail of that. Say it again.',
      'That one is on the equipment. Nothing recorded. Go again.',
      'The mic missed it entirely. Have another go.',
    ],
    'session.complete_strong': [
      'Big set. You made that look routine.',
      'That went very well. Enjoy it, then do it again tomorrow.',
      'Strong run. The question bank is officially concerned.',
      'That was a good one. Take the win and come back for more.',
      'Excellent set. Whatever you did before this, do it again.',
      'Very tidy. The questions barely got a word in.',
    ],
    'session.complete_mixed': [
      'A little chaotic, a lot of progress. Both things are true.',
      'Some hits, some adventures. The adventures are the useful part.',
      'Mixed bag! The misses just told you exactly what to practise.',
      'Wins and wobbles. Perfectly normal shape for a session.',
      'Half triumph, half homework. Both count.',
      'That had everything in it. The wobbly ones come round again.',
    ],
    'session.complete_weak': [
      'That set fought back. Rematch tomorrow, five minutes.',
      'Rough one! Everybody has these. Come back and take it apart.',
      'That round went to the questions. The answers are all right there — tomorrow.',
      'Bruising set. Nothing lost. Try again tomorrow.',
      'The questions had the upper hand today. Tomorrow you get another go.',
      'That was a tough round. Short session tomorrow and it starts to shift.',
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
  // That rule held through #352's deepening — the ~120 lines added here are
  // blunter, never darker, and none of them acquired a consequence to hint at.
  // ---------------------------------------------------------------------------
  unfiltered: {
    'answer.correct': [
      'Correct. Don’t get comfortable.',
      'Right. That’s one.',
      'Fine. That one was correct.',
      'Correct. Next.',
      'Yes. Moving on.',
      'That one’s right. One down.',
      'Correct. Do it again.',
      'Right answer. Keep going.',
      'That’s correct. No ceremony required.',
      'Yes, that’s the answer. Onward.',
      'Correct. That’s what it should look like.',
      'Right. Now do the next one.',
      'That one landed. Good.',
      'Correct, and about time for that question.',
      'Yes. One question handled.',
      'Right. The bar is doing that consistently, not once.',
      'Correct. Noted.',
      'That’s right. Keep the pace.',
      'Correct. Good work, briefly.',
      'Right. That one is off the problem list for now.',
      'Right. That’s how it is meant to go.',
      'Correct. Say it that cleanly every time.',
      'Yes. Nothing to add.',
      'Right answer. Carry on.',
    ],
    'answer.correct_run': [
      'Several in a row. Now do it again on a day you don’t feel like it.',
      'A streak. Streaks end; the schedule doesn’t.',
      'Good run. Keep it up, or it doesn’t count for much.',
      'Still correct. Fine. Keep going.',
      'That’s a run. Runs are cheap until they’re long.',
      'Another. Don’t admire it, continue.',
      'Unbroken so far. So far is the operative phrase.',
      'Correct again. This is what the work looks like.',
      'Still going. Good. Say nothing and continue.',
      'A run. Now make it a habit instead of a session.',
      'Another one right. Keep your head down.',
      'That’s several. Worth something today, worth nothing if you stop.',
      'Still correct. The streak is not the point; the retention is.',
      'Another. You’re doing the dull part properly, which is the hard part.',
      'Run continues. Fine.',
      'Correct again. Do that tomorrow too.',
      'Still unbeaten. Enjoy it for one second, then continue.',
      'Another right answer. That’s the rhythm — hold it.',
      'Good run. Nothing about it is luck at this length.',
      'Still going. Now find out whether it survives a bad day.',
    ],
    'answer.partial': [
      'Half an answer. Half doesn’t get counted — go finish it.',
      'You had it and stopped early. Go back and say the whole thing.',
      'Partly there. Partly there is not there. Read the rest.',
      'That’s an unfinished answer. Go and read the finished one.',
      'You gave part of it. The rest exists — go read it.',
      'Incomplete. Read the whole answer and say all of it next time.',
      'Nearly. Nearly is not a grade. Read the rest.',
      'Half the answer, none of the credit. Go and read it.',
      'You started well and stopped. Read the rest and finish the job.',
      'That answer has a hole in it. Read the answer and fill it.',
      'Partial. Go and read what you left out; it’s short.',
      'Some of it. Not all of it. Read the record and try again.',
      'You know part of this. Learn the other part — read it now.',
      'Close, incomplete. Read the full answer before you move.',
      'That’s an answer at fifty per cent. Read the other fifty.',
      'Half right. Go and read the rest while it stings.',
      'You gestured at the answer. Go and read the actual one.',
      'Incomplete recall. Read the whole thing and come back later.',
      'Part of it landed. Read the rest, then try the question again.',
      'Not finished. Go and read the answer as it is written.',
    ],
    'answer.incorrect': [
      'That answer was a mess. The right one is on the screen — go read it.',
      'Wrong, and not close. Read the real answer and come back for a rematch.',
      'No. That was a guess wearing a confident face. The answer is right there — read it.',
      'Not it. Read the answer properly this time.',
      'Wrong. Go and read the accepted answer before you move on.',
      'That missed. Read the answer and stop guessing at this one.',
      'No. Read what the question actually wants.',
      'Wrong answer, delivered with conviction. Go and read the right one.',
      'That one is not close. Read the answer and come back tomorrow.',
      'Missed. The answer is short and it is on the screen. Read it.',
      'Not the answer. Read the real one now, while it’s annoying.',
      'Wrong. Nothing tragic about it. Read the answer.',
      'That’s a no. Go and read the accepted answer, twice if it takes twice.',
      'Missed it. Read the answer instead of moving on and hoping.',
      'Not a match. Read it, learn it, try the question again later.',
      'Wrong one. Read the right one and let it stick this time.',
      'That answer was improvised. Read the one that isn’t.',
      'No. Read the answer now — later never happens.',
      'Missed. This question is coming back. Read the answer.',
      'Not it. Go and read the answer before the next question distracts you.',
      'No. Read the answer, then do better on the next one.',
      'That was not it. The answer is short. Read it.',
      'Wrong. Read it, close the gap, move.',
      'Missed. Read the accepted answer before you forget the question.',
    ],
    'answer.skipped': [
      'Nothing? Then read the answer now, while it costs you nothing.',
      'Skipped. That question is coming back and it remembers — go read the answer.',
      'Blank. Fine — read the answer, and stop leaving them blank.',
      'You skipped it. Read the answer so the skip buys you something.',
      'Nothing recorded. Read the answer; that part is not optional.',
      'Passed. Read the accepted answer before you move on.',
      'Blank again is a habit worth breaking. Read the answer.',
      'Skipped. Go and read what it wanted; it takes ten seconds.',
      'No answer. Read the real one and move.',
      'You left it empty. Read the answer and fill the gap.',
      'Skipped. Read the answer. That is the whole assignment right now.',
      'Nothing given. Take the answer, read it, continue.',
      'Blank. The question will not go away. Read the answer.',
      'You passed on it. Read the answer so the next pass is not needed.',
      'Skipped. Read the answer, then come back to this one later.',
      'Nothing. Read the accepted answer and get on with the set.',
      'Empty. Study the answer for a moment. Then move.',
      'Skipped it. Read what you skipped.',
      'No response. Read the answer and try it again another day.',
      'Blank. Go and read the answer; a skip with no reading is wasted.',
    ],
    'answer.self_marked': [
      'You say you knew it. It’s counted — now prove it next time without the reveal.',
      'Marked correct. The matcher reads text; you know what you meant. Say it cleaner next time.',
      'Counted. Now say it that way when it isn’t you keeping score.',
      'Fine, counted. Your wording, the same meaning.',
      'Marked. You are the judge here, so judge honestly.',
      'Counted. Next time make the matcher agree without your help.',
      'Recorded. That’s a legitimate call, not a favour.',
      'Marked correct. Nobody is checking your homework but you.',
      'Counted. If you knew it, you knew it.',
      'Fine. It goes down as correct.',
      'Marked. Say it the recorded way and you won’t need this button.',
      'Counted. Use that button honestly and it stays useful.',
      'Recorded correct. Now do it again without the appeal.',
      'Marked. The meaning was there; the wording wasn’t.',
      'Counted. Good — the matcher is not the point.',
      'Yours. Recorded as correct.',
      'Marked correct. Don’t make a habit of needing it.',
      'Counted. That was a wording gap and nothing more.',
      'Recorded. Now say the accepted phrasing out loud once.',
      'Marked. Take it and keep going.',
    ],
    'answer.misheard': [
      'The transcript is garbage — that’s the microphone, not you. Say it again.',
      'We didn’t hear that properly, and we’re not grading a guess. Again.',
      'Bad audio. Nothing recorded. Repeat it.',
      'That transcript is worthless. The mic’s problem. Go again.',
      'Nothing usable came through. Say it again.',
      'We are not judging that — we could not hear it. Again.',
      'Bad capture. Nothing written down. One more time.',
      'The recording is unusable. Repeat the answer.',
      'That’s a microphone problem. Say it again.',
      'We heard noise. Say it again.',
      'Unreliable transcript, so no verdict. Go again.',
      'The audio dropped it. Repeat.',
      'Nothing recorded, nothing concluded. Try it again.',
      'That did not come through. Again, please.',
      'The mic mangled it. Say it once more.',
      'No usable transcript. Nothing counted. Again.',
      'We could not hear that well enough to say anything about it.',
      'Bad recording. Not your knowledge. Repeat it.',
      'The transcript is nonsense. Say the answer again.',
      'Not enough to judge. Say it again.',
    ],
    'session.complete_strong': [
      'That was a strong set. Say nothing, do it again tomorrow.',
      'Solid. That’s what it looks like when the work has been done.',
      'Good set. One good set is one good set — make it a habit.',
      'Strong. Now repeat it on a day you don’t feel like it.',
      'That went well. Don’t celebrate, schedule.',
      'Good work. Keep the streak dull and it will hold.',
    ],
    'session.complete_mixed': [
      'Some of that was sharp, some was improvised. Work the improvised half.',
      'Mixed. The misses are the only interesting part — go get them.',
      'Half solid. The other half needs an actual answer, not a vibe.',
      'Half of that was real recall. Go and find out about the other half.',
      'Uneven. That is fixable, and you know which ones.',
      'Some good, some guessed. Work on the guessed ones tomorrow.',
    ],
    'session.complete_weak': [
      'That set went badly. It’s fixable, it just isn’t fixed yet — tomorrow, five minutes.',
      'Rough. The answers are all written down and none of them are secret. Go read them.',
      'That round went to the questions. Come back tomorrow and take it apart instead.',
      'Bad set. Not a disaster, just untrained. Read the answers and repeat tomorrow.',
      'That did not go well. Nothing here is beyond you; it is just not learned yet.',
      'Weak round. Short session tomorrow, same material, and it moves.',
    ],
  },
};
