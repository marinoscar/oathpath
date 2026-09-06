/**
 * The picture — idle / listening / thinking / speaking, at arm's length.
 *
 * Issue #356, epic #345. Before this component the entire per-phase UI of
 * conversation mode was one grey `body2` sentence, identical in size, weight,
 * colour and position between "Listening. Answer when you are ready." and
 * "Working out how that went." A learner walking with the phone in one hand
 * could not tell, at a glance, whether it was their turn.
 *
 * =============================================================================
 * `getLevel()` FINALLY HAS A CONSUMER — AND IT IS NOT REACT STATE
 * =============================================================================
 *
 * `useVoiceActivity.getLevel()` has published an RMS level ~40x a second since
 * #347, and its own doc comment has said what it was for the whole time — "a
 * caller that wants a meter reads this from its own animation frame". Nothing
 * ever did. This is that caller, and it obeys the instruction literally: the
 * level is read inside a `requestAnimationFrame` loop and written STRAIGHT TO
 * THE DOM NODE'S `style.transform`. It is never put in state, because state
 * would re-render this component (and, through it, its subtree) forty times a
 * second to move one ring.
 *
 * `getLevel` is held in a ref rather than being an effect dependency for the
 * same reason `useConversationSession` holds its options in one: a host that
 * rebuilds the callback each render would otherwise tear down and restart the
 * animation frame loop on every commit.
 *
 * =============================================================================
 * `prefers-reduced-motion` IS A BRANCH, NOT AN OPACITY
 * =============================================================================
 *
 * A reduced-motion learner gets the same four pictures with the same four
 * labels and the same four shapes, and the meter ring is drawn at a fixed
 * radius rather than a moving one. The animation frame loop DOES NOT RUN AT
 * ALL — it is not started, so there is no polling, no `getLevel` call and no
 * transform being written to a node nobody is watching move.
 *
 * That is the whole reason the state is legible without motion: the motion was
 * never carrying information in the first place. The ring's radius says "how
 * loudly are you talking right now", which is a nicety; "is it my turn" is the
 * question, and the word and the shape answer it whether or not anything moves.
 * There is deliberately no spinner anywhere in this file — a spinner under
 * reduced motion degrades to a static, meaningless circle.
 *
 * =============================================================================
 * IT IS `aria-hidden`, AND THAT IS NOT AN OVERSIGHT
 * =============================================================================
 *
 * Everything this component renders is stated in words in the surface's ONE
 * live region — the phase sentence is more precise than the label, and it is
 * already announced. Exposing the picture as well would announce the coarse
 * word and the precise sentence for one state change, which is the exact
 * double-announcement `CONVERSATION_PHASE_TEXT` already refuses for a
 * different pair of surfaces.
 */

import { useEffect, useRef } from 'react';
import { Box, Typography, useMediaQuery, useTheme } from '@mui/material';
import type { Theme } from '@mui/material';

import {
  VOICE_VISUAL_DISPLAY,
  type VoiceVisualDisplay,
  type VoiceVisualState,
} from './voiceVisualState';

/** The query, spelled once so the test and the component cannot disagree. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface VoiceStateVisualProps {
  state: VoiceVisualState;
  /**
   * `useVoiceActivity`'s own level getter, 0..1.
   *
   * Called only while `state === 'listening'` and only when motion is allowed.
   * A host with no detector may pass a getter that always answers 0; the
   * picture is then simply a still one, which is what an unarmed detector
   * honestly looks like.
   */
  getLevel: () => number;
}

/** A palette role to an actual colour. Roles, never hex — see the display table. */
function resolveColor(theme: Theme, display: VoiceVisualDisplay): string {
  switch (display.color) {
    case 'success':
      return theme.palette.success.main;
    case 'warning':
      return theme.palette.warning.main;
    case 'info':
      return theme.palette.info.main;
    case 'default':
      return theme.palette.text.primary;
  }
}

/**
 * The geometry for one state.
 *
 * Four genuinely different outlines, not one outline in four colours: a ring,
 * a ring around a disc, a diamond and a triangle are distinguishable in a
 * greyscale screenshot at thumbnail size, which is the bar "without colour"
 * actually sets.
 */
function Shape({ display }: { display: VoiceVisualDisplay }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 6,
    strokeLinejoin: 'round' as const,
  };

  return (
    <Box
      component="svg"
      viewBox="0 0 100 100"
      focusable="false"
      data-shape={display.shape}
      data-stroke={display.stroke}
      sx={{ width: { xs: 108, sm: 128 }, height: { xs: 108, sm: 128 }, display: 'block' }}
    >
      {display.shape === 'ring' && (
        <circle cx="50" cy="50" r="36" {...common} strokeDasharray="10 10" />
      )}
      {display.shape === 'rings' && (
        <>
          <circle cx="50" cy="50" r="42" {...common} strokeWidth={4} />
          <circle cx="50" cy="50" r="22" fill="currentColor" />
        </>
      )}
      {display.shape === 'diamond' && (
        <rect
          x="22"
          y="22"
          width="56"
          height="56"
          transform="rotate(45 50 50)"
          {...common}
          strokeDasharray="2 10"
          strokeLinecap="round"
        />
      )}
      {display.shape === 'triangle' && (
        <polygon points="32,20 82,50 32,80" fill="currentColor" />
      )}
    </Box>
  );
}

export function VoiceStateVisual({ state, getLevel }: VoiceStateVisualProps) {
  const theme = useTheme();
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const display = VOICE_VISUAL_DISPLAY[state];
  const color = resolveColor(theme, display);

  const meterRef = useRef<HTMLDivElement | null>(null);
  // Refreshed every commit, depended on by nothing. See the file header.
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;

  useEffect(() => {
    if (reduceMotion || state !== 'listening') return;
    if (typeof requestAnimationFrame !== 'function') return;

    let frame = requestAnimationFrame(function tick() {
      const node = meterRef.current;
      if (node) {
        // Clamped rather than trusted: a level source is a tap on live audio,
        // and a NaN or a spike would otherwise be written straight into a
        // transform.
        const raw = getLevelRef.current();
        const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
        node.style.transform = `scale(${(1 + level * 0.5).toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  }, [reduceMotion, state]);

  return (
    <Box
      // See the file header: every word of this is already in the live region.
      aria-hidden
      data-voice-state={state}
      data-motion={reduceMotion ? 'static' : 'animated'}
      sx={{
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        color,
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
          width: { xs: 148, sm: 176 },
          height: { xs: 148, sm: 176 },
        }}
      >
        {state === 'listening' && (
          <Box
            ref={meterRef}
            data-testid="voice-level-meter"
            // Static under reduced motion, moving otherwise — either way it is
            // the OUTER half of the `rings` shape, so the geometry is the same
            // picture in both.
            style={{ transform: 'scale(1)' }}
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: '2px solid',
              borderColor: 'currentColor',
              opacity: 0.45,
              transformOrigin: 'center',
            }}
          />
        )}
        <Shape display={display} />
      </Box>
      <Typography
        component="p"
        sx={{
          // Large, and large in `rem` rather than a `variant`, because the one
          // requirement is "readable from arm's length" and a heading variant
          // would also claim a place in the document outline it has no business
          // in — the outline is `h1` (this surface) then `h2` (the question).
          fontSize: { xs: '1.5rem', sm: '1.75rem' },
          fontWeight: 700,
          letterSpacing: '0.02em',
          lineHeight: 1.2,
        }}
      >
        {display.label}
      </Typography>
    </Box>
  );
}

export default VoiceStateVisual;
