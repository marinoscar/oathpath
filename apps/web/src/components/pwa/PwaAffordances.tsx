/**
 * The two PWA affordances, mounted once (issue #359, epic #345).
 *
 * Mounted in `App.tsx` INSIDE `ThemeProvider` (so both Snackbars are themed)
 * and OUTSIDE `<Routes>` (so neither unmounts on navigation, and neither is
 * tied to being signed in). An update is equally worth announcing on `/login`
 * as on `/practice`, and the install offer arrives whenever the browser
 * decides it does — not on a route of our choosing.
 */

import { InstallPrompt } from './InstallPrompt';
import { UpdateAvailableSnackbar } from './UpdateAvailableSnackbar';

export function PwaAffordances() {
  return (
    <>
      <UpdateAvailableSnackbar />
      <InstallPrompt />
    </>
  );
}

export default PwaAffordances;
