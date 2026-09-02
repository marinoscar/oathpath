/**
 * The eight-stage journey path, with the learner's stage marked.
 *
 * Issue #74, epic #50, from `docs/specs/journey-shell.md` §1 and the "Stage:
 * Oriented" marker in `journey-shell/home-{360,600}.svg`.
 *
 * =============================================================================
 * THE STAGES ARE A PROP, AND THERE IS NO FALLBACK LIST ANYWHERE BELOW
 * =============================================================================
 *
 * Every label, every description and the ORDER all arrive from
 * `GET /api/journey/stages`. This file names no stage key, hardcodes no count
 * — not even "8" — and has no default array to fall back on when the request
 * fails. §6 of the spec is explicit that the API owns the one declaration and
 * the web reads it over an endpoint; a local copy "just for offline" or "just
 * as a fallback" IS the duplicate registry the spec rejects, and it is worse
 * than no fallback because the two can disagree silently in any build where the
 * agreement test does not run.
 *
 * The practical test of that claim: `__tests__/pages/HomePage.test.tsx` serves a
 * deliberately WRONG stage list from MSW — different keys, different labels, a
 * different length — and asserts the page renders that. A hardcoded eight would
 * fail it.
 *
 * =============================================================================
 * A LIST WITH STATE, NOT A ROW OF DOTS
 * =============================================================================
 *
 * Visually this is a progress track. Semantically it is an ordered list, and it
 * has to be: "eight stages with one marked current" is information, and a
 * screen reader that meets eight decorative `<div>`s learns none of it. So:
 *
 *   * `<ol>` / `<li>`, so the count and the position are announced;
 *   * `aria-current="step"` on exactly one item, which is how "you are here"
 *     is expressed for a step in a sequence;
 *   * every stage's NAME in the accessible tree at every width, in a
 *     `visuallyHidden` span — the dots carry no text and the labels do not fit
 *     side by side at 360px, so hiding them from sight is a layout decision
 *     that must not become an information decision;
 *   * the coloured dots themselves `aria-hidden`, because they are the same
 *     information a second time.
 *
 * Position and state are spelled out in words ("Stage 2 of 8: Oriented — you
 * are here") rather than left to colour, which no assistive technology and no
 * colour-blind reader can recover.
 *
 * =============================================================================
 * WIDTH
 * =============================================================================
 *
 * Identical at every width: dots on one line, the current stage named and
 * described underneath. Nothing here is breakpoint-gated, so none of
 * `CLAUDE.md`'s five coupled `sm` gates is touched or duplicated. The dots
 * shrink by flexing, not by a media query, which is what keeps a nine-stage
 * registry — should a later epic ever ship one — from overflowing at 360px.
 */

import { Box, Chip, Typography } from '@mui/material';
import visuallyHidden from '@mui/utils/visuallyHidden';

import type { JourneyStage } from '../../types';

export interface JourneyPathProps {
  /** The registry, in server order. Never a local constant — see the header. */
  stages: JourneyStage[];
  /** The learner's own `stage`, from `GET /api/journey/home`. */
  currentStageKey: string;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function JourneyPath({
  stages,
  currentStageKey,
  headingId,
}: JourneyPathProps) {
  const currentIndex = stages.findIndex((stage) => stage.key === currentStageKey);
  // `-1` is a real possibility, not a defensive nicety: it means the server's
  // registry and the server's profile disagree about a key. The path still
  // renders — with nothing marked and no name claimed — rather than marking an
  // arbitrary stage, because a confidently wrong "you are here" is worse than
  // an unmarked track.
  const current = currentIndex >= 0 ? stages[currentIndex] : null;

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ mb: { xs: 3, sm: 4 } }}>
      <Typography
        id={headingId}
        component="h2"
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: '0.08em' }}
      >
        Where you are
      </Typography>

      <Box
        component="ol"
        // The connector line sits BEHIND the dots as one pseudo-element rather
        // than as seven separate spacer elements, which keeps every child of
        // the `<ol>` a real `<li>` — a stray `<div>` between list items is
        // invalid and some screen readers stop counting at it.
        sx={{
          position: 'relative',
          listStyle: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 0.5,
          m: 0,
          mt: 1.5,
          p: 0,
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: '2px',
            transform: 'translateY(-50%)',
            bgcolor: 'divider',
          },
        }}
      >
        {stages.map((stage, index) => {
          const isCurrent = index === currentIndex;
          const isPassed = currentIndex >= 0 && index < currentIndex;
          const state = isCurrent
            ? 'you are here'
            : isPassed
              ? 'passed'
              : 'still ahead';

          return (
            <Box
              component="li"
              key={stage.key}
              // The one ARIA attribute that says "this step, of these steps".
              // `aria-current="step"` and not `"true"`: the value names what
              // kind of current this is, and a sequence is a step.
              aria-current={isCurrent ? 'step' : undefined}
              sx={{ position: 'relative', display: 'flex', lineHeight: 0 }}
            >
              <Box component="span" sx={visuallyHidden}>
                {`Stage ${index + 1} of ${stages.length}: ${stage.label} — ${state}`}
              </Box>
              <Box
                aria-hidden
                sx={{
                  width: isCurrent ? 18 : 12,
                  height: isCurrent ? 18 : 12,
                  borderRadius: '50%',
                  // Palette tokens only, so both themes are correct without a
                  // second definition: `primary.main` for what has been
                  // reached, `background.paper` behind a `divider` border for
                  // what has not. The paper fill is also what stops the
                  // connector line showing through an unreached dot.
                  bgcolor: isCurrent || isPassed ? 'primary.main' : 'background.paper',
                  border: isCurrent || isPassed ? 'none' : '2px solid',
                  borderColor: 'divider',
                  // Ring around the current dot: a second visual channel beside
                  // size, so "current" is not carried by colour alone.
                  outline: isCurrent ? '3px solid' : 'none',
                  outlineColor: 'background.paper',
                  boxShadow: isCurrent ? 3 : 'none',
                }}
              />
            </Box>
          );
        })}
      </Box>

      {current && (
        <Box sx={{ mt: 2.5 }}>
          {/* The mockup's "Stage: Oriented" pill. `component="p"`-ish semantics
              are not needed — the same words are already in the list above for
              a screen reader, so this repetition is hidden from it rather than
              announced twice. */}
          <Chip
            aria-hidden
            label={`Stage: ${current.label}`}
            color="primary"
            variant="outlined"
            size="small"
            sx={{ fontWeight: 600 }}
          />
          {/* The stage's own sentence, server-written and rendered verbatim.
              This is the one place the registry's `description` is used, and it
              is why the endpoint carries it at all. */}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, maxWidth: '60ch' }}>
            {current.description}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

export default JourneyPath;
