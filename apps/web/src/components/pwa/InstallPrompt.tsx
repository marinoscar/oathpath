/**
 * The install offer (issue #359, epic #345).
 *
 * OFFERED, NEVER NAGGED, and never an interstitial — the acceptance criterion
 * in the issue's own words. A Snackbar: it does not cover the page, it does not
 * take focus, it cannot be in the way of anything, and one dismissal ends it
 * for good (`useInstallPrompt` persists that to `localStorage`).
 *
 * Top-anchored for the same reason `UpdateAvailableSnackbar` is — see that
 * file's header on why the bottom would add a sixth coupled breakpoint gate.
 */

import { Alert, Button, IconButton, Snackbar } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useInstallPrompt } from '../../hooks/useInstallPrompt';

export function InstallPrompt() {
  const { canInstall, promptInstall, dismiss } = useInstallPrompt();

  return (
    <Snackbar
      open={canInstall}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      sx={{ top: 'calc(24px + env(safe-area-inset-top))' }}
    >
      <Alert
        severity="info"
        variant="outlined"
        sx={{ bgcolor: 'background.paper' }}
        // Both controls through `action`, for the reason spelled out in
        // `UpdateAvailableSnackbar`: MUI drops its own close button the moment
        // `action` is supplied, and an offer with no way to decline it is the
        // nag this component exists not to be.
        action={
          <>
            <Button color="inherit" size="small" onClick={() => void promptInstall()}>
              Install
            </Button>
            <IconButton size="small" color="inherit" aria-label="Close" onClick={dismiss}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      >
        Add to your home screen for a full-screen app.
      </Alert>
    </Snackbar>
  );
}

export default InstallPrompt;
