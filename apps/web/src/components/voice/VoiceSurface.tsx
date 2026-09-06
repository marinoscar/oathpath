/**
 * The full-screen surface a hands-free practice session runs on.
 *
 * Issue #356, epic #345. It is ENTERED when a voice session is running and
 * LEFT when it stops — it is not a restyle of `PracticeSessionPage`, which
 * keeps its form, its correction card and its feedback stack for the text path
 * exactly as they were. Nothing about the session lives here: the questions
 * already answered, the attempt rows and the progress counter are all on the
 * server, and this component holds no state but a clock. Leaving it is
 * therefore free, which is what makes "Type instead" a real escape rather than
 * a mode switch with a cost.
 *
 * =============================================================================
 * ONE VIEWPORT, AND THE DOCUMENT NEVER SCROLLS
 * =============================================================================
 *
 * `PracticeSessionPage` stacks roughly 1,500px against a ~700px phone
 * viewport, the document is the scroller (`useScrollRestoration` says so
 * outright), and the loop's own Stop and "Type instead" controls used to sit
 * ABOVE the question card — so they scrolled off first, and nothing scrolled
 * them back. A learner who is not looking at the screen cannot be asked to
 * find a control by scrolling to it.
 *
 * Four things hold the property, and all four are asserted:
 *
 *  1. **The root is `position: fixed`, `inset: 0`, `overflow: hidden`.** It
 *     therefore occupies no document flow at all, so mounting it cannot add a
 *     single pixel of page height.
 *  2. **`100dvh` with a `100vh` fallback**, written with the exact `@supports`
 *     guard `Layout.tsx` models. Plain `100vh` measures against the LARGEST
 *     viewport, so a collapsing URL bar would push the footer under the
 *     browser chrome — which is where the two controls live.
 *  3. **`env(safe-area-inset-*)` on all four sides**, so the timer is not
 *     under a notch and Stop is not under a home indicator. #359 set
 *     `viewport-fit=cover`, which is what makes those insets non-zero and what
 *     makes ignoring them a real overlap rather than a theoretical one.
 *  4. **The body is locked while this is mounted**, and restored on unmount.
 *     Belt and braces over (1): a fixed overlay over a document that is itself
 *     scrolled leaves a learner able to scroll the page behind the surface.
 *
 * Everything that can overflow — a long question, a long verdict — scrolls
 * INSIDE ITS OWN CONTAINER, the pattern `FlashcardStudy.tsx` already uses for
 * a comparable case. Those containers are marked `data-scrollable`, and the
 * two controls are asserted to have no such ancestor: "reachable from every
 * phase without scrolling" is then a STRUCTURAL fact rather than a measured
 * one, which matters because jsdom performs no layout and could never measure
 * it.
 *
 * =============================================================================
 * EXACTLY ONE LIVE REGION
 * =============================================================================
 *
 * The old screen could have four at once. There is one here, it is mounted
 * from the first render, and it holds three things that belong to a single
 * announcement: what the loop is doing (the phase sentence), what was heard,
 * and the verdict. A screen reader user therefore hears "Telling you the
 * answer. We heard 'the Constitution'. That's right — the Constitution." as
 * ONE utterance, in the order the audio says it.
 *
 * The question prompt is deliberately OUTSIDE it. `role="status"` is
 * `aria-atomic` by default, so a question inside would be re-read in full on
 * every phase change — five times per question. It is a heading instead, which
 * is how a screen reader user reaches it on demand, and the loop reads it
 * aloud anyway.
 *
 * The loop's own `QuestionAudio` mount is passed as `children` and rendered
 * inside a visually-hidden, `aria-hidden` box. It carries a live region of its
 * own ("Reading the question aloud.") that would be a second one saying almost
 * exactly what the phase line already says, and a replay button nobody in a
 * hands-free session is going to press.
 *
 * =============================================================================
 * WHAT IT SHOWS ABOUT THE ANSWER COMES FROM `spokenTurn`
 * =============================================================================
 *
 * Not re-derived from `outcome` and `acceptedAnswers`. `spokenTurn` (#351) is
 * the composed turn the coach SAYS, so rendering anything else here would be
 * two descriptions of one verdict, free to disagree with each other — and the
 * one a learner would trust is whichever they noticed second.
 *
 * `retryBoundary` is honoured for the reason its own doc comment gives:
 * everything from that index on is the retry-deferred tail, and the tail is
 * where the accepted answer is. Printing it while a retry is still on the
 * table turns the retry into a repeat-after-me — the second defect #345 names.
 * A screen that ignored the boundary would reopen it in silence, because the
 * AUDIO would still be honouring it.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import StopIcon from '@mui/icons-material/Stop';

import { VoiceStateVisual } from './VoiceStateVisual';
import { voiceVisualState } from './voiceVisualState';
import type { ConversationPhase } from '../../hooks/useConversationSession';

/** The surface's own title, and the accessible name of its region. */
export const VOICE_SURFACE_TITLE = 'Hands-free practice';

/**
 * The cost guardrail, in one line (#345).
 *
 * A learner is talking to a model on THEIR OWN key — `docs/specs/voice.md` §10
 * and this repository's whole per-user credential posture — and a session that
 * runs itself is the one place that fact stops being obvious, because nobody
 * is pressing anything. It sits beside the elapsed timer for that reason: the
 * timer says how long, this says whose.
 */
export const VOICE_SURFACE_KEY_NOTE = 'Voice practice runs on your own AI key.';

/**
 * The part of a spoken turn a SCREEN may show right now.
 *
 * Exported and pure so the boundary rule is directly testable rather than
 * inferred from a rendered list. `null` means nothing is deferred; a number
 * `k` means everything from `k` on is the retry-deferred tail. See the file
 * header for why showing the tail early is a real harm and not a nicety.
 */
export function visibleSpokenTurn(
  spokenTurn: string[] | undefined,
  retryBoundary: number | null | undefined,
): string[] {
  const turn = spokenTurn ?? [];
  if (retryBoundary === null || retryBoundary === undefined) return turn;
  return turn.slice(0, Math.max(0, retryBoundary));
}

/** `m:ss`, with a zero-padded seconds field. Pure, and exported for its test. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export interface VoiceSurfaceProps {
  /** Where the loop is. Drives the picture; the sentence is passed separately. */
  phase: ConversationPhase;
  /**
   * The phase sentence, from the host's own `CONVERSATION_PHASE_TEXT`.
   *
   * PASSED IN rather than looked up here, so the screen and the driver's
   * spoken cue keep sharing one table. An empty string renders nothing.
   */
  phaseText: string;
  /** The loop's last word, when it has one. Rendered in the same live region. */
  notice: string | null;
  /** The question's own number, for the label above the prompt. */
  questionNumber: number | null;
  /** The prompt. Rendered as the `h2` under this surface's single `h1`. */
  questionPrompt: string | null;
  /** "Question {position} of {planned}" — the host's own counter, unchanged. */
  position: number;
  planned: number;
  /** `useVoiceActivity.getLevel`. See `VoiceStateVisual`. */
  getLevel: () => number;
  /** What was heard, as it was graded, or `null` before anything is graded. */
  heard: string | null;
  /**
   * When the SESSION started, as an epoch millisecond, or `null`.
   *
   * ISSUE #387, AND MOUNT IS NOT A SAFE PROXY FOR IT. This surface is mounted
   * and unmounted by its host, and the host takes it off the screen for
   * reasons that have nothing to do with the session ending — a re-read of
   * `GET /api/practice/sessions/:id` after every question used to replace the
   * whole page with a spinner, which remounted this component once per
   * question and restarted the clock with it (measured: 0:09 at 12s, 0:04 at
   * 29s, 0:11 at 68s). That remount is fixed at its source, and this prop is
   * why the clock is right even if another one is ever introduced.
   *
   * It matters because the clock is a COST guardrail, not a decoration: voice
   * practice bills the learner's own key by the minute (epic #345, decision 7,
   * and {@link VOICE_SURFACE_KEY_NOTE} directly beside it), so a timer that
   * resets systematically under-reports what a session is spending.
   *
   * `null` falls back to mount time, which is right for a host that genuinely
   * mounts this once per session and has no separate start to hand over.
   */
  startedAt?: number | null;
  /** The composed turn (#351). See the file header. */
  spokenTurn: string[];
  /** Where the retry-deferred tail begins (#351), or `null`. */
  retryBoundary: number | null;
  onStop: () => void;
  onTypeInstead: () => void;
  /**
   * The loop's own audio player. Rendered visually hidden and `aria-hidden`.
   *
   * It has to be in the tree — it is what speaks — and it must not be in the
   * accessibility tree, because its status line is a second live region. See
   * the file header.
   */
  children?: ReactNode;
  /** Anything the host wants under the controls (the wake-lock caption). */
  footnote?: ReactNode;
}

export function VoiceSurface({
  phase,
  phaseText,
  notice,
  questionNumber,
  questionPrompt,
  position,
  planned,
  getLevel,
  heard,
  startedAt = null,
  spokenTurn,
  retryBoundary,
  onStop,
  onTypeInstead,
  children,
  footnote,
}: VoiceSurfaceProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  /**
   * The elapsed timer, measured from the SESSION's start (#387).
   *
   * Mount time is only the fallback, for a host with no start to hand over —
   * see {@link VoiceSurfaceProps.startedAt} for why mount is not a safe proxy
   * for a session that outlives several of this component's lifetimes.
   *
   * IT CANNOT RUN BACKWARDS WHILE THIS IS MOUNTED. The earliest start ever
   * seen is what it measures from, so a host that re-reports a session's start
   * — a re-mint publishing a fresh timestamp, a transport handover — can only
   * ever leave the clock alone, never rewind it. A clock that jumped down is
   * the exact failure this is fixing, and it is worth being unable to express
   * rather than merely careful about.
   */
  const mountedAtRef = useRef<number>(Date.now());
  const earliestStartRef = useRef<number>(startedAt ?? mountedAtRef.current);
  earliestStartRef.current = Math.min(
    earliestStartRef.current,
    startedAt ?? mountedAtRef.current,
  );

  /**
   * A render every second, so the number below is never more than a second
   * stale. The number itself is read at RENDER time rather than stored, so a
   * re-render for any other reason — a phase change, a new question — shows a
   * current clock instead of the last tick's.
   *
   * It is NOT inside the live region: a per-second announcement of a running
   * clock is the single most hostile thing a screen reader could be asked to
   * do, and the number is on screen for whoever wants it.
   */
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = Date.now() - earliestStartRef.current;

  /**
   * Lock the document while this is up, and put it back exactly as it was.
   *
   * The previous value is captured rather than assumed empty, so a host that
   * had its own reason to lock the body does not have it silently cleared by
   * this surface unmounting.
   */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /**
   * Take focus on entry.
   *
   * The surface replaces the whole page, so a keyboard or screen-reader user
   * whose focus was on the Start control is otherwise left focused on a
   * detached node — which browsers reset to `<body>`, at the very top of a
   * document that is no longer the thing on screen. Focusing the region puts
   * the next Tab on Stop.
   */
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const turnLines = visibleSpokenTurn(spokenTurn, retryBoundary);

  /** Focus that is actually visible, on both controls, in both themes. */
  const focusRing = {
    '&:focus-visible': {
      outline: '3px solid',
      outlineColor: 'primary.main',
      outlineOffset: '2px',
    },
  } as const;

  return (
    <Box
      component="section"
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby="voice-surface-title"
      sx={{
        position: 'fixed',
        inset: 0,
        // Above the AppBar (1100) and the BottomNav — this is the whole screen
        // for as long as it is up, and half of it peeking out from behind the
        // shell's chrome would be worse than either.
        zIndex: (theme) => theme.zIndex.modal,
        backgroundColor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        // The property that makes the page body's own scrolling impossible
        // rather than merely unnecessary.
        overflow: 'hidden',
        // `100vh` is the fallback for browsers with no `dvh`; `100dvh` tracks
        // mobile browser chrome as it collapses. Exactly the guard
        // `Layout.tsx` uses, and for exactly the same reason.
        height: '100vh',
        '@supports (height: 100dvh)': { height: '100dvh' },
        // #359 set `viewport-fit=cover`, so these are real numbers on a modern
        // phone and `0px` on every desktop browser.
        paddingTop: 'calc(12px + env(safe-area-inset-top))',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
        paddingLeft: 'calc(16px + env(safe-area-inset-left))',
        paddingRight: 'calc(16px + env(safe-area-inset-right))',
        gap: 1.5,
        '&:focus': { outline: 'none' },
      }}
    >
      {/* --- The header: who, where, how long. Never scrolls. --- */}
      <Box sx={{ flex: '0 0 auto' }}>
        <Typography
          id="voice-surface-title"
          variant="subtitle2"
          component="h1"
          sx={{ fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
        >
          {VOICE_SURFACE_TITLE}
        </Typography>
        <Stack
          direction="row"
          sx={{
            mt: 0.5,
            gap: 2,
            alignItems: 'baseline',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
          }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {`Question ${position} of ${planned}`}
          </Typography>
          {/* The label is part of the text, not an `aria-label`: a bare
              "2:14" is unreadable to everybody, not only to a screen reader. */}
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {`Elapsed ${formatElapsed(elapsedMs)}`}
          </Typography>
        </Stack>
      </Box>

      {/* --- The question. THE region most able to overflow, so it is the one
              that scrolls inside itself. --- */}
      <Box
        data-scrollable="true"
        sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
      >
        {questionNumber !== null && (
          <Typography
            variant="overline"
            component="p"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {`Question ${questionNumber}`}
          </Typography>
        )}
        {questionPrompt && (
          <Typography
            component="h2"
            sx={{
              fontWeight: 600,
              fontSize: { xs: '1.35rem', sm: '1.75rem' },
              lineHeight: 1.25,
            }}
          >
            {questionPrompt}
          </Typography>
        )}
      </Box>

      <VoiceStateVisual state={voiceVisualState(phase)} getLevel={getLevel} />

      {/* --- THE ONE LIVE REGION. Mounted from the first render and only ever
              having its contents changed — a live region inserted at the same
              moment as its content is commonly missed entirely. --- */}
      <Box
        role="status"
        aria-live="polite"
        data-scrollable="true"
        sx={{
          flex: '0 1 auto',
          minHeight: 0,
          maxHeight: '32%',
          overflowY: 'auto',
          textAlign: 'center',
        }}
      >
        {phaseText && (
          <Typography variant="body1" color="text.secondary">
            {phaseText}
          </Typography>
        )}
        {notice && (
          <Typography variant="body1" color="text.secondary">
            {notice}
          </Typography>
        )}
        {heard && (
          <Typography variant="body1" sx={{ mt: 1 }}>
            {`We heard “${heard}”`}
          </Typography>
        )}
        {turnLines.map((line, index) => (
          <Typography key={`${index}-${line}`} variant="body1" sx={{ mt: 1 }}>
            {line}
          </Typography>
        ))}
      </Box>

      {/* --- The controls. `flex: 0 0 auto` in a fixed-height column, outside
              every `data-scrollable` region, so they are on screen at all seven
              phases without anything being scrolled. --- */}
      <Box sx={{ flex: '0 0 auto' }}>
        <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'center' }}>
          <Button
            variant="contained"
            size="large"
            startIcon={<StopIcon />}
            onClick={onStop}
            sx={focusRing}
          >
            Stop
          </Button>
          <Button
            variant="outlined"
            size="large"
            startIcon={<KeyboardIcon />}
            onClick={onTypeInstead}
            sx={focusRing}
          >
            Type instead
          </Button>
        </Stack>
        <Typography
          variant="caption"
          component="p"
          color="text.secondary"
          sx={{ mt: 1, textAlign: 'center' }}
        >
          {VOICE_SURFACE_KEY_NOTE}
        </Typography>
        {footnote}
      </Box>

      {/* --- The loop's voice. In the tree, out of the accessibility tree, off
              the screen. See the file header. --- */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export default VoiceSurface;
