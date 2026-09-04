/**
 * `VoiceUnavailableNotice` — what stands where the microphone would have been.
 *
 * Issue #109, epic #58 / E9. `transcribe` is wired now and `systemReady`
 * deliberately does not depend on it (`docs/specs/voice.md` §1), so a learner
 * can reach a spoken practice session with a good key, a ready system, and no
 * speech recognition on the deployment at all.
 *
 * The failure this suite exists to prevent is a MICROPHONE BUTTON THAT DOES
 * NOTHING, and the three ways it comes back:
 *
 *   1. The mic rendered disabled instead of absent — "a button guaranteed to
 *      fail is worse than no button" (`PushToTalkButton`'s own header).
 *   2. The absence explained by copy written here instead of by `AiNotReady`,
 *      which loses "This is not a problem with your key" — the sentence that
 *      component exists for, and the first one dropped when copy is rewritten
 *      per surface.
 *   3. This state merged with `systemReady === false`, which is a different
 *      problem with a different remedy: it takes every AI feature away rather
 *      than one optional input method.
 */

import { ThemeProvider } from '@mui/material/styles';
import { TextField } from '@mui/material';
import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { AiNotReady } from '../../../components/ai/AiNotReady';
import { PushToTalkButton } from '../../../components/voice/PushToTalkButton';
import { VoiceUnavailableNotice } from '../../../components/voice/VoiceUnavailableNotice';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { AuthContext } from '../../../contexts/AuthContext';
import type { UseAudioCaptureReturn } from '../../../hooks/useAudioCapture';
import { useVoiceAvailability } from '../../../hooks/useVoiceAvailability';
import { darkTheme, lightTheme } from '../../../theme';
import type { AiStatus } from '../../../types';
import { server } from '../../mocks/server';
import { mockAdminUser, mockUser, type MockUser } from '../../utils/test-utils';
import { resetViewportWidth, setViewportWidth } from '../../setup';

const TRANSCRIBE_UNBOUND: Partial<AiStatus> = {
  // A READY SYSTEM. This is the whole point: nothing is wrong with this
  // deployment except that nobody bound a speech-recognition model.
  systemReady: true,
  unboundRoles: ['transcribe'],
};

function mockStatus(overrides: Partial<AiStatus> = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: [],
    ...overrides,
  };
  server.use(http.get('*/api/ai/status', () => HttpResponse.json({ data: status })));
}

function renderIt(
  children: ReactNode,
  { user = mockUser as MockUser | null, theme = lightTheme } = {},
): RenderResult {
  const auth = {
    user,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <AuthContext.Provider value={auth as never}>
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AiStatusProvider>{children}</AiStatusProvider>
        </MemoryRouter>
      </ThemeProvider>
    </AuthContext.Provider>,
  );
}

afterEach(() => {
  resetViewportWidth();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The composition the practice session mounts. This is not a mock of the page:
// it is the arrangement `PracticeSessionPage` is told to copy, exercised here
// so "no microphone renders anywhere" is a tested claim rather than an
// instruction in a report.
// ---------------------------------------------------------------------------

const IDLE_CAPTURE: UseAudioCaptureReturn = {
  state: { status: 'idle' },
  isRecording: false,
  recording: null,
  start: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
};

function SpokenAnswer() {
  const { transcribeBound } = useVoiceAvailability();

  return (
    <div>
      <VoiceUnavailableNotice />
      {transcribeBound && <PushToTalkButton capture={IDLE_CAPTURE} />}
      <TextField label="Your answer" multiline />
    </div>
  );
}

describe('the microphone is ABSENT, not disabled', () => {
  it('renders no microphone control anywhere when `transcribe` is unbound', async () => {
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<SpokenAnswer />);

    // Wait for the notice, so "no mic" is a decision that was made rather than
    // a render that had not happened yet.
    await screen.findByRole('alert');

    expect(screen.queryByRole('button', { name: /record/i })).toBeNull();
    // Not merely absent from the accessible tree — absent including disabled
    // controls, which `queryByRole` would still find.
    expect(
      screen.queryByRole('button', { name: /record/i, hidden: true }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /microphone/i })).toBeNull();
  });

  it('leaves the session fully usable in text', async () => {
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<SpokenAnswer />);
    await screen.findByRole('alert');

    // `voice.md` §5: typing is unconditional. Nothing is lost here except an
    // input method that was never offered.
    const field = screen.getByRole('textbox', { name: /your answer/i });
    field.focus();
    expect(document.activeElement).toBe(field);
  });

  it('leaves no orphaned label and no dangling reference behind the mic', async () => {
    // Removing a control can leave a `<label for>` pointing at nothing, or an
    // `aria-describedby` naming an id that no longer exists — both of which
    // read to a screen reader as a control that is there and broken.
    mockStatus(TRANSCRIBE_UNBOUND);
    const { container } = renderIt(<SpokenAnswer />);
    await screen.findByRole('alert');

    for (const label of Array.from(container.querySelectorAll('label[for]'))) {
      const target = label.getAttribute('for') as string;
      expect(document.getElementById(target)).not.toBeNull();
    }

    for (const el of Array.from(
      container.querySelectorAll('[aria-describedby], [aria-labelledby], [aria-controls]'),
    )) {
      for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        for (const id of value.split(/\s+/)) {
          expect(document.getElementById(id)).not.toBeNull();
        }
      }
    }
  });

  it('renders the microphone when `transcribe` IS bound, and says nothing', async () => {
    // The other half of the claim: this is a real condition, not a control
    // that was quietly deleted.
    mockStatus({ unboundRoles: [] });
    renderIt(<SpokenAnswer />);

    expect(
      await screen.findByRole('button', { name: /hold to record/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('what the notice says', () => {
  it('SAYS THE LEARNER\'S KEY IS FINE', async () => {
    // The sentence `AiNotReady` exists for. A learner whose microphone is
    // missing, who owns a microphone and a key, has no other explanation
    // available to them — and the one they would reach for is wrong.
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />);

    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
  });

  it('names what is gone in the learner\'s words', async () => {
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />);

    expect(
      await screen.findByText(/Answering out loud is not available yet/i),
    ).toBeInTheDocument();
  });

  it('is calm — info, never a warning or an error', async () => {
    // Nothing is broken and nothing is lost: the session continues in text.
    // `VISION.md` tone, inherited from `AiNotReady` rather than re-decided.
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />);

    const alert = await screen.findByRole('alert');
    expect(alert.className).toMatch(/Info|info/);
    expect(alert.className).not.toMatch(/Error|error/);
    expect(alert.className).not.toMatch(/Warning|warning/);
  });

  it('is announced — the notice is in a region assistive technology reads', async () => {
    // The mic did not merely vanish visually. A screen-reader user gets the
    // reason, at the moment it appears, without going looking for it.
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('the admin variant', () => {
  it('NAMES the `transcribe` role to an administrator', async () => {
    // "Which one?" is the question an admin would otherwise have to go and
    // answer for themselves — and `transcribe` is the exact word they will
    // find on /admin/settings/ai.
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />, { user: mockAdminUser });

    expect(await screen.findByText('transcribe')).toBeInTheDocument();
  });

  it('gives an administrator the link that fixes it', async () => {
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />, { user: mockAdminUser });

    const link = await screen.findByRole('link', { name: /Open AI settings/i });
    expect(link).toHaveAttribute('href', '/admin/settings/ai');
  });

  it('names ONLY `transcribe`, not every unbound role', async () => {
    // An admin looking at a missing microphone does not need to be told that
    // `tutor` is unbound. It is true, it is answered by the app-wide alert
    // whose job it is, and here it is noise on top of the actual answer.
    mockStatus({ systemReady: false, unboundRoles: ['tutor', 'grader', 'transcribe'] });
    renderIt(<VoiceUnavailableNotice />, { user: mockAdminUser });

    expect(await screen.findByText('transcribe')).toBeInTheDocument();
    expect(screen.queryByText(/tutor/i)).toBeNull();
    expect(screen.queryByText(/grader/i)).toBeNull();
  });

  it('shows a non-admin neither the link nor the role key', async () => {
    // A non-admin cannot act on it, and which roles a deployment has bound is
    // configuration they have no business seeing.
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />);

    await screen.findByRole('alert');
    expect(screen.queryByRole('link', { name: /Open AI settings/i })).toBeNull();
    expect(screen.queryByText('transcribe')).toBeNull();
  });

  it('still tells a non-admin their key is fine', async () => {
    // The part that is for everyone.
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />);

    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
  });
});

describe('when it says nothing at all', () => {
  it('renders nothing when `transcribe` is bound', async () => {
    mockStatus({ unboundRoles: [] });
    const { container } = renderIt(<VoiceUnavailableNotice />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing while the status is still unknown', () => {
    // Not `!transcribeBound`. A "speech recognition is not set up" message
    // flashing on every page load of a correctly configured deployment would
    // not merely be noisy, it would be false.
    mockStatus(TRANSCRIBE_UNBOUND);
    const { container } = renderIt(<VoiceUnavailableNotice />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the status could not be read', async () => {
    // Claiming a deployment is unconfigured, on no evidence, is a worse guess
    // than saying nothing.
    server.use(http.get('*/api/ai/status', () => HttpResponse.error()));
    const { container } = renderIt(<VoiceUnavailableNotice />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing about an unbound `speak`', async () => {
    // `voice.md` §2: the browser reads the question either way, so nothing is
    // missing and nothing explains itself. This is the state of every fresh
    // install.
    mockStatus({ unboundRoles: ['speak'] });
    const { container } = renderIt(<VoiceUnavailableNotice />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('the voice notice and the system-wide notice are different messages', () => {
  it('does not borrow the app-wide alert\'s subject', async () => {
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<VoiceUnavailableNotice />, { user: mockAdminUser });

    await screen.findByRole('alert');
    // One optional input method, named. Not "AI".
    expect(screen.getByText(/Answering out loud is not available yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/^This is not available yet$/i)).toBeNull();
    expect(screen.queryByText(/master switch/i)).toBeNull();
    expect(screen.queryByText(/no AI provider has been chosen/i)).toBeNull();
  });

  it('leaves `systemReady === false` to `AiNotReady`, unchanged', async () => {
    // The pre-existing condition, unchanged by this epic: a different problem
    // with a different remedy, and it must not be merged into the voice
    // messaging.
    mockStatus({ systemReady: false, unboundRoles: ['tutor', 'grader'] });
    renderIt(
      <>
        <AiNotReady feature="AI explanations" />
        <VoiceUnavailableNotice />
      </>,
      { user: mockAdminUser },
    );

    // Exactly one alert: the app-wide one. The voice notice is silent, because
    // `transcribe` is bound on this deployment.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(screen.getByText(/AI explanations is not available yet/i)).toBeInTheDocument();
    expect(screen.getByText(/tutor and grader/i)).toBeInTheDocument();
    expect(screen.queryByText(/Answering out loud/i)).toBeNull();
    expect(screen.queryByText('transcribe')).toBeNull();
  });
});

describe('it RENDERS `AiNotReady` rather than a copy of it', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../../components/ai/AiNotReady');
    vi.resetModules();
  });

  it('delegates, passing the role it is scoped to', async () => {
    // If this ever stops being a delegation, the copy is being written twice —
    // and "This is not a problem with your key" is the first line to go.
    const seen: Array<Record<string, unknown>> = [];
    vi.doMock('../../../components/ai/AiNotReady', () => ({
      AiNotReady: (props: Record<string, unknown>) => {
        seen.push(props);
        return <div data-testid="delegated-to-ai-not-ready" />;
      },
    }));

    // Both modules are re-imported into the SAME fresh registry, so the
    // provider and the component share one context instance.
    const [{ VoiceUnavailableNotice: Fresh }, { AiStatusProvider: FreshProvider }] =
      await Promise.all([
        import('../../../components/voice/VoiceUnavailableNotice'),
        import('../../../contexts/AiStatusContext'),
      ]);

    mockStatus(TRANSCRIBE_UNBOUND);
    render(
      <MemoryRouter>
        <FreshProvider>
          <Fresh />
        </FreshProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByTestId('delegated-to-ai-not-ready'),
    ).toBeInTheDocument();
    expect(seen[0]).toMatchObject({ role: 'transcribe' });
  });
});

describe('both themes at 360px', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders the learner\'s notice in %s', async (_name, theme) => {
    setViewportWidth(360);
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<SpokenAnswer />, { theme });

    await screen.findByRole('alert');
    expect(
      screen.getByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record/i })).toBeNull();
    // The text path is still there at the narrowest width this app supports.
    expect(screen.getByRole('textbox', { name: /your answer/i })).toBeInTheDocument();
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders the admin variant in %s', async (_name, theme) => {
    setViewportWidth(360);
    mockStatus(TRANSCRIBE_UNBOUND);
    renderIt(<SpokenAnswer />, { user: mockAdminUser, theme });

    await screen.findByRole('alert');
    expect(screen.getByText('transcribe')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open AI settings/i }),
    ).toBeInTheDocument();
  });
});
