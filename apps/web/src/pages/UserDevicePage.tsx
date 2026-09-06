/**
 * Settings → Device & permissions (`/settings/device`).
 *
 * Issue #384. A REGISTRY CARD PLUS A ROUTE, never a tab on an existing
 * settings page (`CLAUDE.md`'s Settings UI Pattern, rules 1 and 2). This is a
 * reachability question — its own destination — and it is not a second view of
 * Voice's content: `/settings/voice` is what a learner PREFERS (which voice,
 * how fast, whether a spoken answer submits itself), and this page is what
 * their DEVICE and their BROWSER will currently permit. A preference the
 * browser is blocking and a preference the learner has not chosen are
 * different problems with different remedies, and only one of them is settable
 * from inside this application at all.
 *
 * NO `permission`, like every card in `config/userSettingsSections.tsx` — and
 * for a stronger reason than most of them: THIS PAGE MAKES NO AUTHENTICATED
 * API CALL AT ALL. There is no controller behind it and therefore no string a
 * gate here could honestly mirror, and inventing one would gate a learner out
 * of finding out why their own microphone is not working.
 *
 * THE ONE `/settings/*` PAGE BESIDES `/settings/tokens` THAT DOES NOT USE
 * `UserSettingsSection`, and deliberately, on that page's own argument: the
 * wrapper exists to share ONE `useUserSettings()` call and its snackbars
 * between the pages that edit the user settings DOCUMENT. Nothing here is in
 * that document — every fact on this screen is read from the browser, live —
 * so wrapping it anyway would fire a `GET /user-settings` this page never
 * reads and gate a device status behind that unrelated request's spinner.
 *
 * The chrome below is therefore only what the wrapper would have contributed
 * visually: the container, the `h1` and the description, mirroring the
 * `Device & permissions` card in `config/userSettingsSections.tsx` so the hub
 * card, the compact AppBar title (#95) and this `h1` all name the page
 * identically.
 *
 * EVERYTHING ELSE — including the load-bearing "nothing prompts on mount"
 * invariant — is in `components/settings/DevicePermissions.tsx`. Read that
 * file's header before adding anything to this one.
 */

import { Box, Container, Typography } from '@mui/material';

import { DevicePermissions } from '../components/settings/DevicePermissions';

export default function UserDevicePage() {
  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Device &amp; permissions
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          What this browser is allowing OathPath to do on this device, and how
          to change it.
        </Typography>

        {/* The same column layout `UserSettingsSection` gives its children, so
            the three cards sit apart exactly as the cards on every other
            settings page do. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <DevicePermissions />
        </Box>
      </Box>
    </Container>
  );
}
