import { Component, ErrorInfo, ReactNode } from 'react';
import { Box, Typography, Button } from '@mui/material';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            // `100dvh` where supported, `100vh` as the fallback (issue #359,
            // epic #345 — the audit of every bare viewport-height rule in this
            // app). This boundary wraps the whole route tree, so on a phone it
            // is the only thing sizing the error screen; plain `100vh` measures
            // against the largest viewport and pushes the Reload button under
            // the browser chrome, which is a bad place for the only control on
            // a screen someone reaches when everything else has failed.
            height: '100vh',
            '@supports (height: 100dvh)': { height: '100dvh' },
            gap: 2,
          }}
        >
          <Typography variant="h4">Something went wrong</Typography>
          <Typography color="text.secondary">
            {this.state.error?.message || 'An unexpected error occurred'}
          </Typography>
          <Button
            variant="contained"
            onClick={() => window.location.reload()}
          >
            Reload Page
          </Button>
        </Box>
      );
    }

    return this.props.children;
  }
}
