import { Box, CircularProgress } from '@mui/material';

interface LoadingSpinnerProps {
  fullScreen?: boolean;
  size?: number;
}

export function LoadingSpinner({ fullScreen = false, size = 40 }: LoadingSpinnerProps) {
  if (fullScreen) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          // `100dvh` where supported, `100vh` as the fallback (issue #359,
          // epic #345 — the audit of every bare viewport-height rule in this
          // app). `fullScreen` is the `Suspense` fallback for every lazy route
          // in `App.tsx`, so this is the first thing a phone paints on a cold
          // load; sizing it to the retracted-chrome viewport makes the page
          // scrollable for the duration of the spinner.
          //
          // `100vw` is deliberately LEFT ALONE. There is no `dvw` problem to
          // fix — the horizontal viewport does not change with browser chrome —
          // and the one real hazard of `100vw` (it includes the scrollbar
          // width) does not apply to a centring box with no overflow.
          height: '100vh',
          '@supports (height: 100dvh)': { height: '100dvh' },
          width: '100vw',
        }}
      >
        <CircularProgress size={size} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
      <CircularProgress size={size} />
    </Box>
  );
}
