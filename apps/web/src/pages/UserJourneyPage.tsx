/**
 * Settings → Your plan (`/settings/journey`).
 *
 * Issue #77, epic #50. `/setup/journey` (#72) asks the six orientation
 * questions exactly once and is gated on NOT having answered them, so without
 * this page every answer it collects would be frozen for the life of the
 * account — and every one of them changes: an interview gets scheduled or
 * moved, a learner moves state, five minutes a day turns out to be too
 * ambitious, the 65/20 accommodation starts applying after a birthday.
 *
 * =============================================================================
 * THE SAME FORM COMPONENT `/setup/journey` RENDERS, IMPORTED AND NOT COPIED
 * =============================================================================
 *
 * `components/journey/JourneyProfileForm.tsx` was built by #72 as the shared
 * form for exactly these two chromes, which is `components/ai/AiKeyForm.tsx`'s
 * arrangement (`AiKeySetupPage` / `UserAiKeyPage`) and is here for the same
 * reason: the deliverable in that component is the COPY and the failure states,
 * and a second copy of those is written well once and badly the second time.
 * The only differences between the two chromes are props — this one labels its
 * action "Save changes" and passes no `onSaved`, because the learner is already
 * where they want to be.
 *
 * `__tests__/pages/JourneyFormIsShared.test.tsx` asserts the sharing
 * STRUCTURALLY rather than by inspection: it mocks the form module and renders
 * both pages, and a forked copy would not be mocked out of either.
 *
 * =============================================================================
 * SAVING HERE DOES NOT RE-RUN ORIENTATION
 * =============================================================================
 *
 * This page sends the identical `PUT /api/journey/profile` orientation sends,
 * and it carries NO client flag saying which chrome it came from — there is no
 * such field in the DTO, deliberately. The API infers completion from the
 * stored data and guards the inference on `orientationCompletedAt === null`
 * (`apps/api/src/journey/journey.service.ts`), so a second save re-runs neither
 * the timestamp nor the `uncertain` → `oriented` transition: the moment a
 * learner finished setup stays the moment they finished setup, and a learner
 * who has since advanced past `oriented` cannot be dragged backwards by editing
 * their daily goal.
 *
 * That property is the API's to keep, not this page's to arrange, which is
 * exactly why there is nothing here to arrange it with.
 *
 * =============================================================================
 * WHAT HAPPENS ON SUCCESS, AND WHY THERE IS NO `refresh()`
 * =============================================================================
 *
 * The form pushes the server's own response into `LearnerProfileContext`
 * (`applyProfile`) before it reports success, so the rest of the app — the
 * gate, Home's countdown, anything else reading the profile — already agrees
 * with what was just stored. `PUT` answers with exactly the payload `GET`
 * answers with (see the context's header), so calling `refresh()` on top would
 * spend a second round trip to be told the same thing, with a window in which
 * the two answers could differ.
 *
 * The confirmation is the form's own inline success alert, which it renders
 * precisely when no `onSaved` is passed — a polite `role="status"`, announced
 * without interrupting, and NOT a navigation. Nothing takes the learner off
 * this page: they came here to change something and may want to change
 * something else.
 *
 * =============================================================================
 * NO `permission`, ON THE CARD OR THE ROUTE
 * =============================================================================
 *
 * Like every entry in `config/userSettingsSections.tsx`: the endpoint behind
 * this page is `@Auth()` with no permissions and resolves the caller from the
 * token, so there is no string to mirror. A gate here would invent an
 * authorization rule the API does not enforce — and would lock a learner out
 * of their own plan.
 */

import { Box, Container, Paper, Typography } from '@mui/material';

import { JourneyProfileForm } from '../components/journey/JourneyProfileForm';

/**
 * Mirrors the `Your plan` card in `config/userSettingsSections.tsx`, so the hub
 * tile, the compact AppBar title (#95) and this page's `h1` all say the same
 * thing. Same idiom as `UserNotificationsPage`.
 */
const PAGE_TITLE = 'Your plan';
const PAGE_DESCRIPTION =
  'Your filing date, interview date, state, and how much you want to study each day.';

export default function UserJourneyPage() {
  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        {/* The shared form — the same component `/setup/journey` renders,
            unforked. `submitLabel` is the whole of the difference; there is
            deliberately no `onSaved`, which is what makes the form show its own
            confirmation instead of handing off. */}
        <Paper sx={{ p: { xs: 2, sm: 3 } }}>
          <JourneyProfileForm submitLabel="Save changes" />
        </Paper>

        {/* The honest note orientation makes too. A learner who has just been
            told their test version is about to change should be able to read,
            in the same screenful, that changing it back is allowed. */}
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 2 }}
        >
          You can change any of these answers as often as you need to.
        </Typography>
      </Box>
    </Container>
  );
}
