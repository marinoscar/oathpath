/**
 * Hold to speak, release to submit — and the six ways that can fail.
 *
 * Issue #99, epic #58 / E9. The visible half of `useAudioCapture`: it renders
 * the button, the recording indicator, and — the reason this is a component
 * rather than three lines in a page — the NAMED failure, with its own remedy,
 * every time capture cannot happen.
 *
 * =============================================================================
 * NO STATE HERE IS A DISABLED BUTTON WITH NO EXPLANATION
 * =============================================================================
 *
 * A greyed-out microphone tells a learner nothing except that the product is
 * broken, and there is nothing they can do about it from there. So every
 * failure renders the sentence naming what happened AND the sentence naming
 * what to do, and for the four that a second press can fix, the press is still
 * offered. For the two it cannot (`insecure_origin`, `unsupported`) the control
 * is replaced rather than disabled — a button guaranteed to fail is worse than
 * no button.
 *
 * =============================================================================
 * TYPING IS ALWAYS REACHABLE — `docs/specs/voice.md` §5
 * =============================================================================
 *
 * Voice is optional, unconditionally. The text path is offered from every
 * failure state and from the ordinary one too, so no microphone problem is ever
 * the end of a learner's practice session.
 *
 * =============================================================================
 * KEYBOARD, NOT JUST POINTER
 * =============================================================================
 *
 * "Push to talk" is a hold gesture, and a hold gesture built only from
 * pointerdown/pointerup excludes anybody driving the page from a keyboard or a
 * switch — there is no "hold" in a keyboard's vocabulary at all. So Space and
 * Enter TOGGLE: press once to start, press again to stop, with the button's
 * label saying which of the two the next press will do. `event.repeat` is
 * ignored so a held key does not fire twenty starts, and `preventDefault()`
 * stops the browser synthesising the click that would immediately undo the
 * toggle.
 */

import MicIcon from '@mui/icons-material/Mic';
import StopIcon from '@mui/icons-material/Stop';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Stack,
  Typography,
} from '@mui/material';

import {
  isCaptureProblemRetryable,
  type UseAudioCaptureReturn,
} from '../../hooks/useAudioCapture';

export interface PushToTalkButtonProps {
  /**
   * The capture hook's return value.
   *
   * The PAGE owns the hook, not this component: the recording has to be handed
   * to an upload the page is responsible for, and a blob trapped inside a
   * button is a blob nothing can send.
   */
  capture: UseAudioCaptureReturn;

  /**
   * Switch this question to typing.
   *
   * Optional only because a caller whose text field is already on screen has
   * nothing to switch to. When it is absent the text path is still NAMED in
   * words — see `TextPath` below — never silently dropped.
   */
  onUseText?: () => void;

  /** True while something else owns the turn (an upload in flight, say). */
  disabled?: boolean;

  /** The idle button's label. Defaults to "Hold to record". */
  label?: string;
}

export function PushToTalkButton({
  capture,
  onUseText,
  disabled = false,
  label = 'Hold to record',
}: PushToTalkButtonProps) {
  const { state, isRecording, start, stop } = capture;

  if (state.status === 'failed') {
    const { code, message, remedy } = state.problem;

    return (
      // `Alert` renders `role="alert"`, so the message is announced the moment
      // it appears rather than waiting for a screen-reader user to go looking
      // for why nothing happened. `warning`, not `error`: none of the six is a
      // fault, and every one of them has a next step.
      <Alert severity="warning" sx={{ mt: 1 }}>
        <AlertTitle>{message}</AlertTitle>

        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {remedy}
        </Typography>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          {isCaptureProblemRetryable(code) && (
            <Button
              size="small"
              variant="outlined"
              startIcon={<MicIcon />}
              onClick={start}
              disabled={disabled}
            >
              Try the microphone again
            </Button>
          )}

          <TextPath onUseText={onUseText} />
        </Stack>
      </Alert>
    );
  }

  const isBusy = state.status === 'requesting';

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Button
          variant={isRecording ? 'contained' : 'outlined'}
          color={isRecording ? 'error' : 'primary'}
          size="large"
          disabled={disabled || isBusy}
          startIcon={isRecording ? <StopIcon /> : <MicIcon />}
          // A toggle to assistive technology, which is what it is from the
          // keyboard. The pointer's hold is the same state seen differently.
          aria-pressed={isRecording}
          // Pointer: hold. `pointerup` on the window would be more faithful
          // still, but leaving the button while holding is indistinguishable
          // from letting go as far as the recording is concerned — and a
          // recording that keeps running because the pointer wandered off the
          // control is a microphone nobody asked to leave on.
          onPointerDown={(event) => {
            if (disabled || isBusy) return;
            // Keeps the pointer's events coming to this element even if the
            // finger slides off it, so `onPointerUp` is not lost mid-hold.
            event.currentTarget.setPointerCapture?.(event.pointerId);
            start();
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onPointerLeave={() => {
            // Only relevant when capture is unavailable (older Safari); with
            // capture the pointer never "leaves" mid-hold.
            if (isRecording) stop();
          }}
          // Keyboard: toggle. See the file header.
          onKeyDown={(event) => {
            if (event.key !== ' ' && event.key !== 'Enter') return;
            // An autorepeating held key would otherwise fire start/stop/start…
            if (event.repeat) return;
            event.preventDefault();
            if (disabled || isBusy) return;
            if (isRecording) stop();
            else start();
          }}
          sx={{ minWidth: { sm: 220 } }}
        >
          {isRecording ? 'Recording — press to stop' : isBusy ? 'Waiting for the microphone…' : label}
        </Button>

        <TextPath onUseText={onUseText} />
      </Stack>

      {/*
        THE INDICATOR. `role="status"` with `aria-live="polite"` so a
        screen-reader user is told recording has begun — for a sighted user the
        red dot is the whole message, and without this they would have nothing.
        It is rendered as a live region that is always present (empty when
        idle) rather than mounted on demand, because a live region added to the
        DOM at the same moment as its text is frequently not announced at all.
      */}
      <Box
        role="status"
        aria-live="polite"
        sx={{ mt: 1, minHeight: 24, display: 'flex', alignItems: 'center', gap: 1 }}
      >
        {isRecording && (
          <>
            <Box
              aria-hidden
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: 'error.main',
                animation: 'oathpath-recording-pulse 1.2s ease-in-out infinite',
                '@keyframes oathpath-recording-pulse': {
                  '0%, 100%': { opacity: 1 },
                  '50%': { opacity: 0.25 },
                },
                // A blinking dot is a migraine and a vestibular trigger for
                // some people, and it carries no information the text beside
                // it does not.
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }}
            />
            <Typography variant="body2" color="error.main">
              Recording. Speak your answer, then stop.
            </Typography>
          </>
        )}

        {state.status === 'recorded' && (
          <Typography variant="body2" color="text.secondary">
            Recording finished.
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * The escape hatch, in every state.
 *
 * A button when the caller can act on it, a plain sentence when it cannot —
 * but NEVER nothing. `docs/specs/voice.md` §5 makes typing an unconditional
 * alternative, and a learner reading a microphone failure is precisely the
 * person who needs to be told so.
 */
function TextPath({ onUseText }: { onUseText?: () => void }) {
  if (onUseText) {
    return (
      <Button size="small" onClick={onUseText}>
        Type your answer instead
      </Button>
    );
  }

  return (
    <Typography variant="body2" color="text.secondary">
      You can type your answer instead.
    </Typography>
  );
}

export default PushToTalkButton;
