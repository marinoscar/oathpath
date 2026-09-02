/**
 * The empty state every not-yet-built bar destination renders.
 *
 * Issue #69, epic #50, from `docs/specs/journey-shell.md` §8 and its six
 * mockups (`journey-shell/{learn,practice,progress}-empty-{360,600}.svg`).
 *
 * THE RAIL MUST NEVER BE A PROMISE THE ROUTER BREAKS. `/learn`, `/practice`
 * and `/progress` are real destinations in the bar from the day E1 ships, so
 * they are real, mounted routes from the same day — not redirects to `/`, not a
 * 404, and not a blank page. §2.3 of the spec makes that structural rather than
 * merely polite: §4's `nextAction` contract points learners AT these paths, and
 * a stub that bounced to `/` would make every one of those values false.
 *
 * ONE COMPONENT, THREE THIN BINDINGS — the same shape `SettingsHub` and its two
 * hub pages use. The three pages differ only in their two sentences; a copy of
 * this layout per page would be three places to fix every future spacing,
 * heading-order or dark-theme bug, and the three would drift within a release.
 *
 * TWO SENTENCES AND NOTHING ELSE, per §8: what the destination will eventually
 * do, and what the learner can do right now instead. **No date, no "soon", no
 * implied timeline** — that omission is deliberate, and a caller adding a third
 * line promising one is undoing the spec's honesty rule, not extending it.
 *
 * The "Back to Home" action is the only affordance, and it is a real
 * `RouterLink` — focusable, middle-clickable, and correct with the keyboard —
 * never an `onClick` on a button-shaped div.
 */

import { Box, Button, Container, Divider, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink } from 'react-router-dom';

export interface DestinationEmptyStateProps {
  /** The page's single `h1` — the destination's own name, verbatim. */
  title: string;
  /** §8's first sentence: what this destination will eventually do. */
  description: string;
  /** §8's second sentence: what the learner can do right now instead. */
  rightNow: string;
}

export function DestinationEmptyState({
  title,
  description,
  rightNow,
}: DestinationEmptyStateProps) {
  return (
    // `md`, not `lg`: this page is two sentences, and a measure that runs the
    // full width of a desktop window is the one way plain prose becomes hard to
    // read. `maxWidth` on the text below holds the same line length on a wide
    // viewport where the container has room to spare.
    <Container maxWidth="md" disableGutters>
      <Box
        sx={{
          // MOBILE-FIRST, and the step is at `sm` (600px) — never `md`. The
          // whole shell changes class at 600px (see `Layout.tsx`'s five coupled
          // gates); stepping this padding at 900px instead would give a 600px
          // tablet the phone's tight margins under a rail-width layout. This
          // page does not touch any of those five gates — it only agrees with
          // them.
          //
          // `<main>` already supplies `p: 3`, so these are the page's own
          // vertical rhythm on top of it, not its gutters.
          py: { xs: 1, sm: 2 },
        }}
      >
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>

        {/* A rule under the title, as in the mockups. Decorative: it separates
            the heading from the prose visually and says nothing a screen reader
            needs, which is what `Divider`'s implicit `<hr>` would otherwise
            announce as a thematic break between two paragraphs of one thought. */}
        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        <Box sx={{ maxWidth: '60ch' }}>
          <Typography variant="body1" sx={{ mb: 3 }}>
            {description}
          </Typography>

          {/* `text.secondary` is the ONLY visual difference between the two
              sentences: the first describes the destination, the second is the
              honest note about today. Both are ordinary paragraphs in the same
              reading order for assistive technology, and both keep their
              contrast in either theme because the colour is a palette token
              rather than a hex value. */}
          <Typography variant="body1" color="text.secondary">
            {rightNow}
          </Typography>
        </Box>

        <Button
          component={RouterLink}
          to="/"
          variant="outlined"
          startIcon={<ArrowBackIcon />}
          // `mt` only, and deliberately NOT `fullWidth`: at 360px a
          // stretched button reads as the page's primary action rather than
          // as the way out of an empty one.
          sx={{ mt: 4 }}
        >
          Back to Home
        </Button>
      </Box>
    </Container>
  );
}

export default DestinationEmptyState;
