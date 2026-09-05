import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Typography, CircularProgress, Alert } from '@mui/material';
import { api } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const token = searchParams.get('token');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setError(errorParam);
        return;
      }

      if (!token) {
        setError('No authentication token received');
        return;
      }

      try {
        // Store the access token
        api.setAccessToken(token);

        // Fetch user data
        await refreshUser();

        // Get return URL and clear it
        const returnUrl = sessionStorage.getItem('auth_return_url') || '/';
        sessionStorage.removeItem('auth_return_url');

        // Navigate to return URL
        navigate(returnUrl, { replace: true });
      } catch (err) {
        setError('Failed to complete authentication');
        api.setAccessToken(null);
      }
    };

    handleCallback();
  }, [searchParams, navigate, refreshUser]);

  if (error) {
    const isNotAuthorized = error.toLowerCase().includes('not authorized');

    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          // See the note on the loading branch below: `100dvh` where
          // supported, `100vh` as the fallback (issue #359).
          height: '100vh',
          '@supports (height: 100dvh)': { height: '100dvh' },
          gap: 2,
          px: 2,
        }}
      >
        <Alert severity="error" sx={{ maxWidth: 500 }}>
          <Typography variant="body1" gutterBottom>
            {error}
          </Typography>
          {isNotAuthorized && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              If you believe this is an error, please contact your system
              administrator.
            </Typography>
          )}
        </Alert>
        <Typography variant="body2" color="text.secondary">
          <a href="/login" style={{ textDecoration: 'none', color: 'inherit' }}>
            Return to login
          </a>
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // `100dvh` where supported, `100vh` as the fallback (issue #359, epic
        // #345 — the audit of every bare viewport-height rule in this app).
        // Plain `100vh` measures against the largest viewport, so on a phone
        // this "centred" spinner sits partly under the browser chrome.
        // `common/Layout.tsx` models the same guard; this screen renders
        // outside the shell and owns its own viewport height.
        height: '100vh',
        '@supports (height: 100dvh)': { height: '100dvh' },
        gap: 2,
      }}
    >
      <CircularProgress />
      <Typography>Completing authentication...</Typography>
    </Box>
  );
}
