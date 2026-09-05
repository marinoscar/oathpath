import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Stack,
  Divider,
  useTheme,
} from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { OAuthButton } from '../components/auth/OAuthButton';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

interface LocationState {
  from?: { pathname: string; search: string };
}

export default function LoginPage() {
  const { isAuthenticated, isLoading, providers, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();

  // Get the return URL from location state (set by ProtectedRoute)
  const state = location.state as LocationState | null;
  const returnUrl = state?.from
    ? `${state.from.pathname}${state.from.search || ''}`
    : '/';

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate(returnUrl, { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate, returnUrl]);

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <Box
      sx={{
        // `100dvh` where supported, `100vh` as the fallback (issue #359, epic
        // #345 — the audit of every bare viewport-height rule in this app).
        // Plain `100vh` measures against the LARGEST viewport, i.e. the one
        // with the mobile browser's chrome retracted, so a centred card is
        // pushed partly under the URL bar and the page scrolls even when its
        // content fits. `common/Layout.tsx` models the same guard; this screen
        // sits OUTSIDE the shell, so it owns its own viewport height and has
        // to repeat it.
        minHeight: '100vh',
        '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.background.default,
        p: 2,
      }}
    >
      <Card
        sx={{
          maxWidth: 400,
          width: '100%',
          boxShadow: theme.shadows[10],
        }}
      >
        <CardContent sx={{ p: 4 }}>
          {/* Logo/Header */}
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold' }}>
              Welcome
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Sign in to continue
            </Typography>
          </Box>

          <Divider sx={{ mb: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Sign in with
            </Typography>
          </Divider>

          {/* OAuth Providers */}
          <Stack spacing={2}>
            {providers.length > 0 ? (
              providers.map((provider) => (
                <OAuthButton
                  key={provider.name}
                  provider={provider.name}
                  onClick={() => login(provider.name)}
                />
              ))
            ) : (
              <Typography color="text.secondary" sx={{ textAlign: 'center' }}>
                No authentication providers configured
              </Typography>
            )}
          </Stack>

          {/* Footer */}
          <Box sx={{ mt: 4, textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              By signing in, you agree to our Terms of Service and Privacy Policy
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
