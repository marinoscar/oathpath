/**
 * "A new version is available — reload" (issue #359, epic #345).
 *
 * The visible half of the update flow whose mechanism lives in
 * `sw/registerServiceWorker.ts`. It exists because the alternative — a worker
 * that calls `skipWaiting()` on install — replaces the bundle under a learner
 * mid-question, and the alternative to THAT is a tab that runs last month's
 * JavaScript against this month's API until somebody thinks to clear site data.
 *
 * ANCHORED AT THE TOP, deliberately. A bottom-anchored Snackbar would sit over
 * `BottomNav` below `sm`, and dodging it would mean a sixth member of the
 * coupled breakpoint set `common/Layout.tsx` documents — a gate that would then
 * have to be checked every time the other five move. The top is unoccupied by
 * anything fixed, at every width.
 *
 * NOT auto-dismissed (`autoHideDuration` unset): this is an offer the learner
 * should be able to act on when they finish what they are doing, and a banner
 * that disappears after six seconds is one they will never catch.
 */

import { Alert, Button, IconButton, Snackbar } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useState } from 'react';
import { useServiceWorkerUpdate } from '../../hooks/useServiceWorkerUpdate';

export function UpdateAvailableSnackbar() {
  const { updateReady, applyUpdate } = useServiceWorkerUpdate();
  const [dismissed, setDismissed] = useState(false);

  return (
    <Snackbar
      open={updateReady && !dismissed}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      // Nothing bottom-anchored here, but a standalone window can still have a
      // top inset (a notch in landscape), and the Snackbar is fixed-position.
      sx={{ top: 'calc(24px + env(safe-area-inset-top))' }}
    >
      <Alert
        severity="info"
        variant="filled"
        // BOTH controls are supplied through `action`. MUI renders `action`
        // INSTEAD of its built-in close button when the prop is present, so an
        // `onClose` alone here would silently produce an alert with no way to
        // dismiss it.
        action={
          <>
            <Button color="inherit" size="small" onClick={applyUpdate}>
              Reload
            </Button>
            <IconButton
              size="small"
              color="inherit"
              aria-label="Close"
              onClick={() => setDismissed(true)}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      >
        A new version is available.
      </Alert>
    </Snackbar>
  );
}

export default UpdateAvailableSnackbar;
