/**
 * The trust footer — `docs/specs/journey-shell.md` §9.3.
 *
 * Issue #74, epic #50.
 *
 * ALWAYS VISIBLE ON HOME. Not behind a disclosure, not in a tooltip, not on a
 * legal page a learner would have to go looking for, and NOT conditional on the
 * page's loading or error state: it is as true while the journey is loading as
 * it is once it has loaded. `VISION.md`'s "Trust is not legal copy buried in
 * settings. It is part of the user experience" and ROADMAP §7's "Trust is UI,
 * not legal copy" are both about this sentence specifically.
 *
 * THE COPY IS THE SPEC'S, CHARACTER FOR CHARACTER — em dash included. It says
 * two separate things and needs both: that this application is not the
 * government agency deciding the learner's case, and that everything it tells
 * them about their readiness is this application's own opinion. Softening
 * either half ("may not reflect", "for guidance only") is the drift this
 * component exists to make visible in one place, and
 * `__tests__/pages/HomePage.test.tsx` reads the sentence out of the spec rather
 * than restating it, so an edit to one without the other fails the build.
 *
 * A `<footer>` element, which is deliberately NOT `role="contentinfo"` here: a
 * `<footer>` nested inside `<main>` is a sectioning footer with no landmark
 * role, which is right — this is the page's note, not the site's.
 */

import { Box, Divider, Typography } from '@mui/material';

/** §9.3, verbatim. */
export const TRUST_FOOTER_TEXT =
  'OathPath is not USCIS. This is our own assessment of your preparation — never an official determination.';

export function TrustFooter() {
  return (
    <Box component="footer" sx={{ mt: { xs: 4, sm: 5 } }}>
      {/* Decorative: it separates the note from the page above it and says
          nothing a screen reader needs, which is what `Divider`'s implicit
          `<hr>` would otherwise announce as a thematic break. */}
      <Divider aria-hidden sx={{ mb: 2 }} />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', maxWidth: '70ch' }}>
        {TRUST_FOOTER_TEXT}
      </Typography>
    </Box>
  );
}

export default TrustFooter;
