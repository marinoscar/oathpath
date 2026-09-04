/**
 * `PushToTalkButton` — six failures, six screens, and never a dead end.
 *
 * Issue #99, epic #58 / E9. What is being defended here is not the button; it
 * is the sentence beside it. A learner who holds the microphone and gets
 * nothing has one of six ordinary, fixable problems, and the difference between
 * this product working for them and being abandoned is whether the screen names
 * which one and what to do about it.
 *
 * So: every code renders its own message AND its own remedy, no state is a
 * silent disabled control, typing is reachable from all of them, and the hold
 * gesture works from a keyboard as well as a pointer.
 */

import { ThemeProvider } from '@mui/material/styles';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PushToTalkButton } from '../../../components/voice/PushToTalkButton';
import {
  describeCaptureProblem,
  type AudioCaptureProblemCode,
  type AudioCaptureState,
  type UseAudioCaptureReturn,
} from '../../../hooks/useAudioCapture';
import { darkTheme, lightTheme } from '../../../theme';
import { resetViewportWidth, setViewportWidth } from '../../setup';

/** The hook's return value, hand-built, so a state can be rendered directly. */
function captureIn(
  state: AudioCaptureState,
  spies: Partial<UseAudioCaptureReturn> = {},
): UseAudioCaptureReturn {
  return {
    state,
    isRecording: state.status === 'recording',
    recording: state.status === 'recorded' ? state.blob : null,
    start: vi.fn(),
    stop: vi.fn(),
    release: vi.fn(),
    ...spies,
  };
}

function failedWith(code: AudioCaptureProblemCode): AudioCaptureState {
  return { status: 'failed', problem: describeCaptureProblem(code) };
}

function renderIt(
  capture: UseAudioCaptureReturn,
  props: { onUseText?: () => void } = {},
  theme = lightTheme,
) {
  return render(
    <ThemeProvider theme={theme}>
      <PushToTalkButton capture={capture} {...props} />
    </ThemeProvider>,
  );
}

const ALL_CODES: AudioCaptureProblemCode[] = [
  'permission_denied',
  'permission_dismissed',
  'no_device',
  'device_in_use',
  'insecure_origin',
  'unsupported',
];

afterEach(() => resetViewportWidth());

describe('each of the six says what happened and what to do', () => {
  it.each(ALL_CODES)('%s', (code) => {
    const problem = describeCaptureProblem(code);
    renderIt(captureIn(failedWith(code)));

    // Not "microphone unavailable". The specific sentence, and the specific
    // next step — see the file header.
    expect(screen.getByText(problem.message)).toBeInTheDocument();
    expect(screen.getByText(problem.remedy)).toBeInTheDocument();

    // ANNOUNCED, not merely rendered: a screen-reader user who pressed the
    // button and heard nothing has no other way to learn why.
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(problem.message)).toBeInTheDocument();
  });

  it('leaves typing reachable from every one of them', () => {
    for (const code of ALL_CODES) {
      const onUseText = vi.fn();
      const { unmount } = renderIt(captureIn(failedWith(code)), { onUseText });

      const textPath = screen.getByRole('button', {
        name: /type your answer instead/i,
      });
      fireEvent.click(textPath);
      expect(onUseText).toHaveBeenCalledTimes(1);

      unmount();
    }
  });

  it('still names the text path when the caller has no switch to offer', () => {
    renderIt(captureIn(failedWith('no_device')));
    // A sentence rather than a button, but NEVER nothing: voice.md §5 makes
    // typing unconditional.
    expect(screen.getByText(/you can type your answer instead/i)).toBeInTheDocument();
  });

  it('offers another attempt only where one could help', () => {
    for (const code of ALL_CODES) {
      const { unmount } = renderIt(captureIn(failedWith(code)));
      const retry = screen.queryByRole('button', { name: /try the microphone again/i });

      if (code === 'insecure_origin' || code === 'unsupported') {
        // A button guaranteed to fail is worse than no button.
        expect(retry).toBeNull();
      } else {
        expect(retry).toBeInTheDocument();
      }
      unmount();
    }
  });

  it('never renders a disabled control with no explanation', () => {
    for (const code of ALL_CODES) {
      const { unmount } = renderIt(captureIn(failedWith(code)));

      const disabledButtons = screen
        .queryAllByRole('button')
        .filter((button) => button.hasAttribute('disabled'));
      expect(disabledButtons).toHaveLength(0);
      expect(screen.getByRole('alert')).toBeInTheDocument();

      unmount();
    }
  });
});

describe('holding the button', () => {
  it('starts on pointer down and stops on pointer up', () => {
    const start = vi.fn();
    const stop = vi.fn();
    renderIt(captureIn({ status: 'idle' }, { start, stop }));

    const button = screen.getByRole('button', { name: /hold to record/i });
    fireEvent.pointerDown(button);
    expect(start).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(button);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('TOGGLES from the keyboard, because a keyboard cannot hold', () => {
    // A hold gesture built only from pointer events excludes keyboard and
    // switch users entirely — there is no "hold" in a keyboard's vocabulary.
    const start = vi.fn();
    const stop = vi.fn();
    const { rerender } = renderIt(captureIn({ status: 'idle' }, { start, stop }));

    const button = screen.getByRole('button', { name: /hold to record/i });
    fireEvent.keyDown(button, { key: ' ' });
    expect(start).toHaveBeenCalledTimes(1);

    rerender(
      <ThemeProvider theme={lightTheme}>
        <PushToTalkButton
          capture={captureIn({ status: 'recording', startedAt: 0 }, { start, stop })}
        />
      </ThemeProvider>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: /recording/i }), {
      key: 'Enter',
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ignores an autorepeating held key', () => {
    // Otherwise a held Space fires start/stop/start… and the recording the
    // learner is making disappears under them.
    const start = vi.fn();
    renderIt(captureIn({ status: 'idle' }, { start }));

    const button = screen.getByRole('button', { name: /hold to record/i });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyDown(button, { key: ' ', repeat: true });
    fireEvent.keyDown(button, { key: ' ', repeat: true });

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('announces that it is recording, in a live region', () => {
    renderIt(captureIn({ status: 'recording', startedAt: Date.now() }));

    const status = screen.getByRole('status');
    expect(within(status).getByText(/recording\. speak your answer/i)).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});

describe('both themes, and a 360px phone', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders the failure and the escape hatch in %s', (_name, theme) => {
    setViewportWidth(360);
    renderIt(captureIn(failedWith('permission_denied')), { onUseText: vi.fn() }, theme);

    expect(
      screen.getByText(describeCaptureProblem('permission_denied').message),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /type your answer instead/i }),
    ).toBeInTheDocument();
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('renders the idle control in %s', (_name, theme) => {
    setViewportWidth(360);
    renderIt(captureIn({ status: 'idle' }), {}, theme);

    expect(screen.getByRole('button', { name: /hold to record/i })).toBeInTheDocument();
  });
});
