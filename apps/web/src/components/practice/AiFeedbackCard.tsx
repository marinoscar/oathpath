/**
 * The verdict, and — only when a grader actually produced one — why the answer
 * missed and the one line of coaching that goes with it.
 *
 * Issue #125, epic #53. E3 (#79) rendered a bare verdict: a chip, a sentence,
 * and a note saying who decided. This is that same block with the AI grading
 * rung's output folded into it, and it is deliberately ONE component used by
 * both surfaces that show a judgement — the live session screen
 * (`AttemptFeedback`) and the summary's per-question review (`AttemptReview`).
 *
 * =============================================================================
 * ONE COMPONENT, BECAUSE A LEARNER MUST READ THE SAME JUDGEMENT TWICE
 * =============================================================================
 *
 * A learner sees the verdict live, and then again when they revisit the
 * session. If those two screens each assembled the cause and the coaching from
 * the attempt row themselves, they would drift — one would gate on
 * `gradingMethod`, the other on `failureCause != null`, and a learner would
 * come back to a debrief that says something subtly different from what they
 * were told at the time. On a product whose premise is accurate confidence,
 * a judgement that changes when you look at it again is corrosive in a way a
 * missing feature is not.
 *
 * =============================================================================
 * THE RULE THAT MATTERS MOST: A DETERMINISTIC GRADE INVENTS NOTHING
 * =============================================================================
 *
 * **`gradingMethod: 'exact'` and `'self'` render the plain verdict and stop.**
 * No cause, no coaching, no placeholder, no "we couldn't analyse this one".
 *
 * That is not defensive coding — it is the whole point of the ladder. Rung 3 of
 * `ai-evaluation.md` §6 says an unavailable, failed or schema-invalid grading
 * call falls back to the deterministic result and persists
 * `gradingMethod: 'exact'` with all three AI columns NULL. So "graded exactly"
 * covers both "the matcher matched" and "no AI opinion exists", and in neither
 * case has anything diagnosed this learner. Rendering a cause there would be
 * the product telling somebody a specific, memorable, confident story about
 * their own mind that no grader ever told — `ai-evaluation.md` §8 names that
 * the "manufactured diagnosis" and rejects it explicitly, which is also why the
 * taxonomy keeps an honest `unknown` rather than forcing a guess.
 *
 * The gate below is therefore `gradingMethod === 'ai'` FIRST, and the presence
 * of the fields second. Gating on the fields alone would work today and would
 * quietly become wrong the moment any other path writes one of them.
 *
 * =============================================================================
 * NULL AND `unknown` ARE DIFFERENT, AND BOTH ARE RENDERED HONESTLY
 * =============================================================================
 *
 * `failureCause: null` on an `ai`-graded attempt means the grader said
 * `correct` — a correct verdict has nothing to explain, so the API writes no
 * cause (§6 rung 2). `unknown` means the grader ran and could not tell, which
 * has its own copy in `failureCause.ts` and is shown, because "we can't tell
 * from this answer alone" is a true and useful thing to read.
 *
 * =============================================================================
 * THE COACHING LINE IS A SENTENCE, NOT AN ANSWER
 * =============================================================================
 *
 * `aiFeedback.feedback` is capped at 240 characters server-side and its schema
 * has no field that could carry an accepted answer (`ai-evaluation.md` §7). It
 * is rendered as ordinary text — never as HTML, never through
 * `dangerouslySetInnerHTML` — and it is placed BELOW the cause and ABOVE
 * nothing: the accepted answers are `AttemptFeedback`'s to render, from the
 * attempt's own frozen snapshot, and they never come from anything a model
 * said.
 *
 * =============================================================================
 * THE COACH REACTION IS OUTSIDE THE `graded` GATE, AND THAT IS NOT AN EXCEPTION
 * =============================================================================
 *
 * Issue #321, epic #305. `coachReaction` renders regardless of
 * `gradingMethod`, which looks at first glance like a hole in the rule above.
 * It is not, and the difference is worth stating precisely.
 *
 * The `graded` gate exists because a cause and a coaching sentence are a
 * DIAGNOSIS — a specific, memorable, confident story about this learner's own
 * mind. Rendering one where no grader ran would be telling somebody a story
 * nothing told us, which `ai-evaluation.md` §8 names the "manufactured
 * diagnosis" and rejects.
 *
 * A reaction line is not a diagnosis and cannot become one. It comes from a
 * fixed, human-reviewed bank (`apps/api/src/ai/coach/reaction-lines.ts`), it is
 * selected by a pure function from facts the row already carries, it asserts
 * nothing the row does not support, and it names no cause. It is the coach's
 * VOICE, not the coach's verdict.
 *
 * And the deterministically-graded case is exactly the one E14 exists to
 * cover: `gradingMethod: 'exact'` is the common outcome, it produces no AI
 * call, and before this epic it left the card saying nothing but the verdict —
 * so five right answers in a row read as five identical flat sentences. Gating
 * the reaction on `graded` would keep the gap open in precisely the case that
 * is the reason for closing it.
 *
 * WHAT DOES NOT MOVE: `outcomeDisplay`'s `label` and `color`. A learner who
 * chose `unfiltered` reads `Not a match` in the same error colour they always
 * did. `VISION.md` Principle #11 — "Trust Before Delight. A beautiful wrong
 * answer is still wrong." The personality sits BESIDE the verdict; it never
 * wears it.
 *
 * =============================================================================
 * #358: THE VERDICT IS STATED ONCE, AND THE COACH IS THE LINE YOU READ
 * =============================================================================
 *
 * Epic #345. E14 put the coach's line on this card and it still lost, because
 * of what surrounded it. A wrong answer read, top to bottom: the chip, then
 * `outcomeDisplay`'s `detail` sentence saying the same thing in prose, then
 * the persona line, then the provenance note, then the accepted answers, then
 * the self-mark paragraph. ONE persona sentence inside five blocks of neutral
 * system prose, with the two flattest lines immediately above and below it.
 *
 * Three changes, and none of them adds surface:
 *
 *  1. **`detail` is gone from `outcome.ts` entirely.** The chip already says
 *     it. See that file for why deleting beat demoting.
 *  2. **The reaction is `h6`** — the largest text in the block, larger than
 *     the accepted answer itself, and still `component="p"` so the document
 *     outline is untouched.
 *  3. **The provenance note moved behind a disclosure**, together with
 *     whatever fixed prose the host passes as `details`. One toggle, closed on
 *     arrival, unmounting its contents when closed.
 *
 * What did NOT change: the cause block and the grader's coaching sentence.
 * Those are a diagnosis produced by something that actually ran on this
 * attempt, they appear on a minority of attempts, and they are the opposite of
 * the fixed prose this issue was about.
 */

import { useId, useState, type ReactNode } from 'react';
import { Box, Button, Chip, Collapse, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import type { PracticeAttempt } from '../../types';
import { failureCauseDisplay } from './failureCause';
import { gradingMethodNote, outcomeDisplay } from './outcome';

export interface AiFeedbackCardProps {
  /** The recorded attempt. The only source of everything rendered here. */
  attempt: PracticeAttempt;

  /**
   * Extra fixed prose the host wants folded into the SAME disclosure the
   * provenance note lives behind — never a second toggle beside it.
   *
   * `AttemptFeedback` passes the self-mark explanation ("choose Show me the
   * answer next time…"), which is the other sentence #358 found stacked on
   * every verdict. Two disclosures would have cut the prose and added the
   * surface back, which is precisely what that issue asked not to happen.
   *
   * Undefined on the summary's review rows, which have no such recourse to
   * explain.
   */
  details?: ReactNode;

  /**
   * Render the verdict chip and its sentence.
   *
   * `false` on the summary's review rows, which already carry the chip in
   * their own header line beside the question number — stating the same
   * judgement twice on one card reads as two judgements. Everything below the
   * verdict is unchanged either way, which is what keeps the two surfaces
   * saying the same thing.
   */
  includeVerdict?: boolean;
}

export function AiFeedbackCard({
  attempt,
  includeVerdict = true,
  details,
}: AiFeedbackCardProps) {
  const verdict = outcomeDisplay(attempt.outcome);
  const provenance = gradingMethodNote(attempt.gradingMethod);

  /**
   * The "How this was graded" disclosure — CLOSED on arrival, always.
   *
   * Not remembered between attempts and not stored in a preference: the point
   * of #358 is that this prose is available when it is wanted, and a toggle
   * that stayed open would put it back on every verdict by a different route.
   */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const hasDetails = Boolean(provenance) || Boolean(details);

  /**
   * Did a grader actually run on this attempt?
   *
   * The gate for EVERYTHING below the verdict. See the file header — an
   * `exact` or `self` grade has no diagnosis behind it, and the absence is
   * correct rather than missing.
   */
  const graded = attempt.gradingMethod === 'ai';

  const cause = graded ? failureCauseDisplay(attempt.failureCause) : null;
  // Trimmed and length-checked so a model that returned whitespace produces no
  // empty paragraph with a heading over it.
  const coaching = graded ? (attempt.aiFeedback?.feedback ?? '').trim() : '';

  /**
   * The coach's line, if the learner has reactions on.
   *
   * NOT gated on `graded` — see the file header for why that is consistent
   * with the rule rather than an exception to it. Trimmed for the same reason
   * `coaching` is: an all-whitespace string must render nothing at all rather
   * than an empty region with spacing around it.
   */
  const reaction = (attempt.coachReaction?.text ?? '').trim();

  /**
   * Nothing to contribute at all.
   *
   * The ordinary `exact`-graded case on the summary screen, where the verdict
   * is already in the row's header: no provenance note (the deterministic
   * matcher is the normal case and labelling every normal row is noise), no
   * cause, no coaching. Returning `null` rather than an empty `<Box>` keeps a
   * stray element and its margin out of a layout that has nothing to say.
   *
   * `reaction` JOINS THIS CONDITION rather than sitting outside it. A card
   * whose only content is a reaction line is a card with something to say, and
   * leaving it out here would drop the line silently on the summary review —
   * the exact surface `AiFeedbackCard` is one component in order to keep in
   * step with the live screen.
   */
  if (!includeVerdict && !hasDetails && !cause && !coaching && !reaction)
    return null;

  return (
    <Box sx={{ mt: includeVerdict ? 0 : 2 }}>
      {includeVerdict && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          {/* THE VERDICT, STATED ONCE (#358). The chip is text as well as
              colour — a red chip and a green chip are the same chip to a
              learner who cannot distinguish them — and the sentence that used
              to sit beside it said the same thing again in a second register.
              See `outcome.ts` for why `detail` was deleted rather than made
              smaller. */}
          <Chip label={verdict.label} color={verdict.color} size="small" />
        </Stack>
      )}

      {reaction && (
        // THE MOST PROMINENT SENTENCE IN THE BLOCK (#358), directly under the
        // verdict chip. E14 shipped it as `body1` in the default colour, one
        // step above the `body2` boilerplate it was competing with — and that
        // was not enough: the persona line was indistinguishable from the
        // fixed system prose above and below it, which is a large part of why
        // the personality "did not feel implemented" even though it was.
        //
        //   * `variant="h6"` — the largest text in the feedback block, and
        //     larger than the accepted answer's own `body1`. #358's rule is
        //     that this is the line the learner is MEANT to read, so it must
        //     look like it. The fixed prose it used to be sandwiched between
        //     is gone (`outcome.ts`'s `detail`) or behind a disclosure (the
        //     provenance note), so nothing flat frames it any more.
        //   * NO icon, NO chip, NO coloured surface. Anything that framed it
        //     would make a joke look like a system message, and would give the
        //     personality a visual weight the verdict deliberately keeps.
        //   * `component="p"` — text, not a heading, DESPITE the `h6` size.
        //     The size is design; the level is semantics. The card's heading
        //     order belongs to the cause block below, and a coach's aside must
        //     not insert itself into the document outline a screen-reader user
        //     navigates by.
        //
        // NO `role="status"` OF ITS OWN, SINCE #358, AND THAT IS NOT A LOST
        // ANNOUNCEMENT. On the live session screen this card renders INSIDE
        // `PracticeSessionPage`'s one live region, so the line is announced as
        // that region's change; a live region nested in a live region is how
        // the same sentence gets read twice, which is the hazard that page
        // already documents for `ExplainPanel` and for its own nested alerts.
        // On the summary review there is no arrival to announce — the rows are
        // rendered with the page.
        <Typography
          variant="h6"
          component="p"
          sx={{ mt: 1.5, fontWeight: 500, lineHeight: 1.4 }}
        >
          {reaction}
        </Typography>
      )}

      {cause && (
        // Set apart with a rule down its side rather than a nested box: this is
        // the one part of the card that is about the learner rather than about
        // the answer, and it should read as a remark, not as an alert. `info`
        // colouring would make a diagnosis look like a system message; a plain
        // border in the divider colour is legible in both themes without
        // claiming a severity it does not have.
        <Box
          sx={{
            mt: 2,
            pl: 2,
            borderLeft: 2,
            borderColor: 'divider',
          }}
        >
          <Typography variant="subtitle2" component="p" sx={{ fontWeight: 600 }}>
            {cause.headline}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {cause.detail}
          </Typography>

          {coaching && (
            <Typography variant="body2" sx={{ mt: 1.5 }}>
              {coaching}
            </Typography>
          )}
        </Box>
      )}

      {/* The grader ran, said `correct`, and left a sentence: there is no cause
          to explain (a correct verdict has nothing to explain), but the
          sentence is still worth reading, so it is not lost with the block
          above. */}
      {!cause && coaching && (
        <Typography variant="body2" sx={{ mt: 2 }}>
          {coaching}
        </Typography>
      )}

      {/* THE LOW-VALUE FIXED PROSE, MADE PROGRESSIVE (#358, epic #345).

          Who decided this outcome ("Graded by the assistant." / "You marked
          this one correct yourself.") and, on the session screen, why the
          self-mark is not on offer are both true, both occasionally wanted,
          and neither is what a learner came to this screen to read. Stacked
          under every verdict they were two more flat sentences competing with
          the coach's one; behind a toggle they are one short control that
          answers a question when it is asked.

          `unmountOnExit`, so "collapsed" means ABSENT rather than present and
          hidden. A hidden paragraph is still a paragraph a test can find, a
          search can hit and — depending on how the collapse is implemented —
          a screen reader can reach; the whole claim of this disclosure is that
          the prose is not on the screen until somebody asks for it, and that
          claim should be true in the DOM.

          `aria-controls` only while open, for the same reason: a control that
          points at an id nothing carries is worse than a control that points
          at nothing at all. */}
      {hasDetails && (
        <Box sx={{ mt: 1.5 }}>
          <Button
            // Quiet by construction — text, small, inherited colour. It sits
            // in the same block as the primary "move on" action and must not
            // compete with it.
            variant="text"
            size="small"
            color="inherit"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? detailsId : undefined}
            endIcon={
              <ExpandMoreIcon
                sx={{
                  transition: 'transform 150ms',
                  transform: detailsOpen ? 'rotate(180deg)' : 'none',
                }}
              />
            }
            sx={{ ml: -1 }}
          >
            How this was graded
          </Button>

          <Collapse in={detailsOpen} unmountOnExit>
            <Box id={detailsId} sx={{ mt: 0.5 }}>
              {provenance && (
                <Typography variant="body2" color="text.secondary">
                  {provenance}
                </Typography>
              )}
              {details}
            </Box>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}

export default AiFeedbackCard;
