/**
 * `/setup/ai-key` — the first screen every user sees after their first login.
 *
 * Issue #41, epic #25. Until this is finished the product does nothing at all
 * (#39), which makes it the single highest-stakes screen in the application.
 *
 * =============================================================================
 * WHO IS READING THIS, AND WHY A SETTINGS FORM WOULD BE A PRODUCT FAILURE
 * =============================================================================
 *
 * `VISION.md`'s user is preparing for a naturalization interview. They are
 * often an ESL speaker, may understand written English better than spoken, and
 * have almost certainly never heard of an API key. We are asking them, at
 * minute one, to visit a third-party developer console, create a credential,
 * and paste it into an app they have just met.
 *
 * A bare form here is not a styling gap — it is the product failing at the
 * first thing it asks anyone to do. So this screen carries, in order: what is
 * about to happen, why a key is needed in the user's own terms, numbered steps
 * that assume the reader has never seen the OpenAI console, the field, and a
 * celebrated hand-off.
 *
 * =============================================================================
 * TONE
 * =============================================================================
 *
 * Reviewed against `VISION.md`'s AI Personality section: warm but not sugary,
 * encouraging but not dishonest, never condescending about English ability,
 * concise unless more explanation is useful. Sentences are short, the vocabulary
 * is plain, and nothing here congratulates the reader for pasting a string —
 * `VISION.md` is explicit that encouragement must be specific and earned, and
 * "Amazing! You're doing great!" is named as the thing to avoid.
 *
 * The framing is deliberately about CONTROL rather than about cost. "Your usage
 * is yours — you can see it and remove it at any time" is true, is the actual
 * reason for the design, and does not open with a bill.
 *
 * =============================================================================
 * LAYOUT
 * =============================================================================
 *
 * Full-screen and mobile-first per `VISION.md`, deliberately NOT the settings
 * chrome — no rail, no admin furniture, nothing to navigate away into. It is
 * mounted outside `Layout` in `App.tsx` for that reason.
 *
 * Responsive at the `sm` (600px) boundary, the same boundary `CLAUDE.md`'s five
 * coupled gates use — never `md`, which would hand the phone treatment to
 * tablets and landscape phones. Legible at 360px: the only horizontal
 * constraint is the container's `maxWidth`, and the step list wraps.
 *
 * =============================================================================
 * DO NOT TRAP THE USER
 * =============================================================================
 *
 * Sign-out is always reachable, because this is the only screen a blocked user
 * can get to. An administrator additionally gets a link to admin settings —
 * the fresh-install deadlock `RequireAiKey`'s exemption 3 prevents is only
 * half-solved if the first admin cannot find their way there from here.
 */

import {
  Alert,
  Box,
  Button,
  Container,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import LaunchIcon from '@mui/icons-material/Launch';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';

import { AiKeyForm } from '../components/ai/AiKeyForm';
import { useAiStatus } from '../contexts/AiStatusContext';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../hooks/usePermissions';

/** Where a user goes to create a key. */
const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

/**
 * The steps, as data.
 *
 * A list rather than prose because the reader is following along in another
 * tab, and because a numbered list survives translation and screen readers
 * better than a paragraph describing a sequence.
 */
const STEPS: Array<{ primary: string; secondary: string }> = [
  {
    primary: 'Open the OpenAI website and sign in',
    secondary:
      'Use the link below. If you do not have an account yet, you can create one there — it is free to sign up.',
  },
  {
    primary: 'Choose "Create new secret key"',
    secondary:
      'You can give it any name. "OathPath" is a good one, so you remember later what it was for.',
  },
  {
    primary: 'Copy the whole key',
    secondary:
      'It starts with "sk-" and is long. OpenAI shows it only once, so copy all of it before you close the window.',
  },
  {
    primary: 'Come back here and paste it below',
    secondary:
      'We will check that it works straight away, and tell you plainly if something is wrong.',
  },
];

export default function AiKeySetupPage() {
  const { refresh } = useAiStatus();
  const { logout } = useAuth();
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Where to go once a key verifies.
   *
   * `RequireAiKey` records the route the user was heading for, so finishing
   * setup RESUMES what they were doing rather than dropping them on the home
   * page — which for someone who arrived from a shared link is the difference
   * between "I got there" and "it lost my place".
   */
  const destination =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ??
    '/';

  async function handleVerified() {
    // Refresh FIRST, then navigate. Navigating on a stale status sends the
    // user back through the gate, which bounces them straight to this screen —
    // and the failure looks exactly like the save did not work.
    await refresh();
    navigate(destination, { replace: true });
  }

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 3, sm: 6 } }}>
      {/* 1. WELCOME FRAMING. Who this is for and what happens next, in one or
             two short sentences. */}
      <Typography variant="h4" component="h1" gutterBottom>
        Welcome to OathPath
      </Typography>
      <Typography variant="body1" sx={{ mb: 3 }}>
        There is one thing to set up before you start. It takes a few minutes,
        and you only do it once.
      </Typography>

      {/* 2. WHY A KEY IS NEEDED — in the user's terms, not the architecture's.
             Framed around control rather than cost. */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Why OathPath asks for a key
        </Typography>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          OathPath uses AI to explain civics answers, listen to you practice,
          and run mock interviews. That AI comes from a company called OpenAI,
          and it needs a key — a long password that connects OathPath to your
          own OpenAI account.
        </Typography>
        <Typography variant="body2">
          You bring your own key so the usage is yours. You can see what you
          have used, and you can remove your key from OathPath whenever you
          like.
        </Typography>
      </Paper>

      {/* 3. HOW TO GET ONE. Numbered, and assuming the reader has never seen
             that console. */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          How to get your key
        </Typography>
        <List component="ol" sx={{ pl: 0, listStyle: 'decimal', ml: 3 }}>
          {STEPS.map((step) => (
            <ListItem
              key={step.primary}
              sx={{ display: 'list-item', pl: 0.5, py: 0.5 }}
              disableGutters
            >
              <ListItemText
                primary={step.primary}
                secondary={step.secondary}
                slotProps={{
                  primary: { variant: 'subtitle2' },
                  secondary: { variant: 'body2' },
                }}
              />
            </ListItem>
          ))}
        </List>

        <Button
          component="a"
          href={OPENAI_KEYS_URL}
          target="_blank"
          // `noopener` because the linked page gets a `window.opener` handle
          // otherwise; `noreferrer` because this app's URL is not OpenAI's
          // business.
          rel="noopener noreferrer"
          variant="outlined"
          endIcon={<LaunchIcon />}
          sx={{ mt: 1 }}
        >
          Open OpenAI to get a key
        </Button>
        <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>
          Opens in a new tab, so you do not lose this page.
        </Typography>
      </Paper>

      {/* 4. THE FIELD AND THE TEST — the shared component, unforked. */}
      <Paper sx={{ p: { xs: 2, sm: 3 } }}>
        <AiKeyForm headingLevel="h2" onVerified={handleVerified} />
      </Paper>

      <Alert severity="info" sx={{ mt: 3 }}>
        Your key is stored encrypted, and OathPath never shows it again — not
        even to you. If you ever lose it, you can create a new one and paste it
        here.
      </Alert>

      {/* DO NOT TRAP THE USER. */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mt: 3, justifyContent: 'center', alignItems: 'center' }}
      >
        <Button size="small" color="inherit" onClick={() => void logout()}>
          Sign out
        </Button>

        {/* An administrator can reach admin settings from here. The
            fresh-install deadlock `RequireAiKey`'s exemption 3 prevents is only
            half-solved if the first admin cannot find their way there. */}
        {hasPermission('system_settings:read') && (
          <Button
            size="small"
            color="inherit"
            component={RouterLink}
            to="/admin/settings/ai"
          >
            Administrator settings
          </Button>
        )}
      </Stack>

      <Box sx={{ mt: 2, textAlign: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          Having trouble? The{' '}
          <Link href={OPENAI_KEYS_URL} target="_blank" rel="noopener noreferrer">
            OpenAI key page
          </Link>{' '}
          is where keys are created and deleted.
        </Typography>
      </Box>
    </Container>
  );
}
