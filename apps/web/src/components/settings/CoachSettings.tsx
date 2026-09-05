/**
 * The controls on Settings → Coach (`/settings/coach`).
 *
 * Issue #322, epic #305. Two choices: which voice the coach speaks in, and
 * whether it says anything beyond the verdict at all.
 *
 * =============================================================================
 * A. THE RAW STORED NAMESPACE, NEVER A DEFAULTED COPY
 * =============================================================================
 *
 * `coach` arrives `undefined` for every account that has never touched it,
 * which is the normal case, and it is NOT defaulted into `{}` by the caller.
 * `resolvePersona` and `resolveReactions` below are the only source of a
 * displayed value. A filled-in local object would be a second source of truth
 * that a save could serialise — turning "this learner has expressed no
 * preference" into "this learner chose today's defaults", which is exactly
 * the staleness the sparse namespace contract exists to prevent.
 *
 * =============================================================================
 * B. NO LOCAL FORM STATE
 * =============================================================================
 *
 * Every control renders from the props and writes immediately. There is no
 * draft, no dirty flag and no Save button, so there is no window in which the
 * screen shows something the server does not have. On success the section
 * re-renders from the SERVER's response, so what a learner sees afterwards is
 * what was actually stored.
 *
 * =============================================================================
 * C. RETURNING TO THE DEFAULT SENDS `null`, NEVER THE DEFAULT VALUE
 * =============================================================================
 *
 * `writeFor(next, builtInDefault)` — shared with the voice page — reduces a
 * choice equal to the built-in default to `null`, which DELETES the field.
 * Writing `'supportive'` explicitly would pin this learner to today's default
 * forever: if the default voice ever changes, everyone who never expressed a
 * preference moves with it and everyone who "chose" the old default by
 * returning to it does not. Only the second group would be wrong, and nothing
 * would say so.
 *
 * =============================================================================
 * D. THE PREVIEW FIRES ON AN EXPLICIT PRESS AND ON NOTHING ELSE
 * =============================================================================
 *
 * Reading a `sampleLine` costs nothing and is always visible, without a press.
 * HEARING one costs a synthesis on the learner's own AI key, so it is a
 * button — never `onFocus`, never `onMouseEnter`, never a key handler, and
 * never fired by arrowing through the radio group. Each of those would spend
 * somebody's money on a gesture that is not a request for audio. This is
 * `VoiceSettings.tsx`'s rule, reused verbatim rather than re-derived, and its
 * machinery (`PreviewState`, the in-flight ref, `releaseAudio`, `playSample`,
 * the always-mounted live region) is reused with it.
 *
 * =============================================================================
 * E. `unfiltered` IS OPT-IN, AND SAYS WHAT IT IS BEFORE IT IS CHOSEN
 * =============================================================================
 *
 * It is one card among four — never preselected, never recommended, never
 * surfaced by a nudge. Its own copy states plainly what it will and will not
 * do, and its warning is rendered where a learner reads it BEFORE selecting,
 * not after. It is not a modal gate: gating a choice behind a dialog treats
 * the learner as somebody to be protected from their own preference, which is
 * the posture `VISION.md` Principle #9 objects to in the first place.
 *
 * No persona relaxes the invariant floor. A blunter joke about a miss is not
 * licence to say anything about the learner, and the copy here says so.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  FormControl,
  FormControlLabel,
  FormLabel,
  Link,
  Radio,
  RadioGroup,
  Switch,
  Typography,
} from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { Link as RouterLink } from 'react-router-dom';

import { synthesizeSpeech } from '../../services/api';
import type {
  CoachPersona,
  CoachPersonaOption,
  CoachSettings as CoachSettingsValue,
  CoachSettingsPatch,
} from '../../types';

/**
 * The persona a learner has when they have expressed no preference.
 *
 * MIRRORS `DEFAULT_COACH_PERSONA` in the API's namespaces schema. Resolved at
 * read time here and never written into storage — see rule C. It is the one
 * value in this file that must agree with the server, and it agrees the way
 * every other built-in default in this app does: by being the same constant
 * on both sides, not by being persisted once and read back.
 */
export const DEFAULT_COACH_PERSONA: CoachPersona = 'supportive';

/** Reactions are on unless a learner turns them off. */
export const DEFAULT_COACH_REACTIONS = true;

/** The persona this learner speaks with, given whatever is stored. */
export function resolvePersona(
  coach: CoachSettingsValue | undefined,
  known: readonly CoachPersonaOption[],
): CoachPersona {
  const stored = coach?.persona;

  // CHECKED AGAINST WHAT THE SERVER ACTUALLY OFFERS, not against a union this
  // bundle declares. The stored value came from a JSONB column a newer build
  // may have written a fifth key into; falling back is how a learner whose
  // choice this build does not recognise still sees a working page rather
  // than an empty radio group.
  if (stored && known.some((option) => option.key === stored)) return stored;

  return DEFAULT_COACH_PERSONA;
}

/** Whether this learner gets reaction lines. A stored `false` is real. */
export function resolveReactions(coach: CoachSettingsValue | undefined): boolean {
  return typeof coach?.reactions === 'boolean'
    ? coach.reactions
    : DEFAULT_COACH_REACTIONS;
}

/**
 * The null-delete reducer — see rule C.
 *
 * Duplicated from `useVoicePrefs.ts` rather than imported, deliberately: that
 * module is about voice playback and pulls in speech-rate bounds and a voice
 * id pattern this page has no use for. The function is one line and its
 * meaning is in rule C above, where a reader of THIS page will look for it.
 */
function writeFor<T>(next: T, builtInDefault: T): T | null {
  return next === builtInDefault ? null : next;
}

/** What the preview is currently saying, if anything. */
type PreviewState =
  | { kind: 'idle' }
  | { kind: 'preparing'; persona: CoachPersona }
  | { kind: 'playing'; label: string }
  | { kind: 'message'; text: string; needsKey?: boolean };

export interface CoachSettingsProps {
  /** THE RAW STORED NAMESPACE, `undefined` when untouched — see rule A. */
  coach: CoachSettingsValue | undefined;

  /**
   * The personas this deployment offers, from `GET /api/ai/coach/personas`.
   *
   * Empty while loading, and empty if the request failed. An empty list
   * renders the page's own "we could not load these" state rather than four
   * hard-coded cards — the web declares no persona list of its own.
   */
  personas: CoachPersonaOption[];

  /** Did the persona request fail outright? Distinct from "still loading". */
  personasFailed: boolean;

  /**
   * Has an administrator bound a model to the `speak` role?
   *
   * `false` on every fresh install, and it removes the Hear button and
   * nothing else. Never a warning: `docs/specs/voice.md` §2 — the browser
   * reads everything regardless, so an unbound `speak` is the ordinary state
   * of a working install and not a degraded one.
   */
  speakBound: boolean;

  isSaving: boolean;
  onChange: (coach: CoachSettingsPatch) => void;
}

export function CoachSettings({
  coach,
  personas,
  personasFailed,
  speakBound,
  isSaving,
  onChange,
}: CoachSettingsProps) {
  const persona = resolvePersona(coach, personas);
  const reactions = resolveReactions(coach);

  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  /** Guards a double press: a second press mid-request must not spend twice. */
  const previewRef = useRef(false);

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    previewRef.current = false;
  }, []);

  // Nothing should still be playing after this page unmounts.
  useEffect(() => releaseAudio, [releaseAudio]);

  const hearSample = useCallback(
    async (option: CoachPersonaOption) => {
      if (previewRef.current) return;
      releaseAudio();
      previewRef.current = true;
      setPreview({ kind: 'preparing', persona: option.key });

      let result;
      try {
        result = await synthesizeSpeech(option.sampleLine);
      } catch {
        // Only a genuine transport failure reaches here — `synthesizeSpeech`
        // never rejects for an AI reason.
        previewRef.current = false;
        setPreview({
          kind: 'message',
          text: "We couldn't play that sample just now. Everything else on this page still works.",
        });
        return;
      } finally {
        previewRef.current = false;
      }

      // SWITCHED ON, NEVER ASSUMED (issue #277). `unavailable` and `failed`
      // are ordinary HTTP 200 answers, and reading `result.audio` without
      // checking is the shipped `TypeError` that lesson comes from.
      if (result.status === 'unavailable') {
        setPreview(
          result.cause === 'no_user_key'
            ? {
                kind: 'message',
                needsKey: true,
                text: 'Hearing a sample uses your own AI key, and there is no key saved on your account yet. You can still read every sample above.',
              }
            : {
                kind: 'message',
                text: 'Spoken samples are not available here, so there is nothing to play. Every sample above is still readable, and your coach still writes to you.',
              },
        );
        return;
      }

      if (result.status === 'failed') {
        setPreview({
          kind: 'message',
          text: `We couldn't play the ${option.label} sample just now. Reading it above works either way.`,
        });
        return;
      }

      const played = playSample(result.audio, {
        audioRef,
        objectUrlRef,
        onEnd: () => {
          releaseAudio();
          setPreview({ kind: 'idle' });
        },
      });

      setPreview(
        played
          ? { kind: 'playing', label: option.label }
          : {
              kind: 'message',
              text: `We couldn't play the ${option.label} sample just now. Reading it above works either way.`,
            },
      );
    },
    [releaseAudio],
  );

  const previewStatusText =
    preview.kind === 'preparing'
      ? 'Preparing the sample…'
      : preview.kind === 'playing'
        ? `Playing the ${preview.label} sample.`
        : preview.kind === 'message'
          ? preview.text
          : '';

  return (
    <>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <FormControl component="fieldset" sx={{ width: '100%' }}>
            <FormLabel component="legend" sx={{ mb: 1 }}>
              How your coach talks to you
            </FormLabel>

            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 2, maxWidth: '62ch' }}
            >
              This changes the wording only. It never changes whether an answer
              counts as correct, what the accepted answer is, or your readiness
              score.
            </Typography>

            {personasFailed && personas.length === 0 && (
              <Alert severity="info" sx={{ mb: 2 }}>
                We couldn&rsquo;t load the coach voices just now. Your coach
                still works, and nothing you have already chosen has changed.
              </Alert>
            )}

            <RadioGroup
              aria-label="Coach voice"
              name="coach-persona"
              value={persona}
              onChange={(event) => {
                const next = event.target.value as CoachPersona;
                onChange({ persona: writeFor(next, DEFAULT_COACH_PERSONA) });
              }}
            >
              {personas.map((option) => (
                <Box
                  key={option.key}
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1,
                    py: 1.5,
                    borderTop: 1,
                    borderColor: 'divider',
                  }}
                >
                  <FormControlLabel
                    value={option.key}
                    control={<Radio disabled={isSaving} sx={{ mt: -1 }} />}
                    label={
                      <Box>
                        <Typography variant="subtitle2" component="span">
                          {option.label}
                        </Typography>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mt: 0.5 }}
                        >
                          {option.description}
                        </Typography>
                        {/* ALWAYS VISIBLE, no press required. Reading what you
                            are about to choose should not cost anything, and
                            for `unfiltered` in particular it is the difference
                            between choosing a blunt coach and discovering one
                            mid-session. Quoted and italic so it reads as the
                            coach speaking rather than as more description. */}
                        <Typography
                          variant="body2"
                          component="p"
                          sx={{ mt: 1, fontStyle: 'italic' }}
                        >
                          &ldquo;{option.sampleLine}&rdquo;
                        </Typography>
                      </Box>
                    }
                    sx={{ mr: 0, flexGrow: 1, alignItems: 'flex-start' }}
                  />

                  {/* Absent entirely when `speak` is unbound — a disabled
                      button a learner cannot act on is worse than no button,
                      and the page is complete without it. */}
                  {speakBound && (
                    <Button
                      size="small"
                      variant="text"
                      startIcon={<VolumeUpIcon />}
                      // ONLY `onClick`. See rule D — focus, hover and arrowing
                      // through the group must never spend the learner's key.
                      onClick={() => {
                        void hearSample(option);
                      }}
                      disabled={isSaving || preview.kind === 'preparing'}
                      // NAMES THE PERSONA: "Hear" alone is four identical
                      // buttons to somebody listening to the page.
                      aria-label={`Hear the ${option.label} sample`}
                    >
                      Hear
                    </Button>
                  )}
                </Box>
              ))}
            </RadioGroup>

            {/* Always mounted, empty when idle: a live region inserted at the
                same moment as its text is frequently never announced at all. */}
            <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
              {previewStatusText && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ maxWidth: '62ch' }}
                >
                  {previewStatusText}{' '}
                  {preview.kind === 'message' && preview.needsKey && (
                    <Link component={RouterLink} to="/settings/ai">
                      Add a key
                    </Link>
                  )}
                </Typography>
              )}
            </Box>
          </FormControl>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <FormControlLabel
            control={
              <Switch
                checked={reactions}
                disabled={isSaving}
                onChange={(event) => {
                  onChange({
                    reactions: writeFor(
                      event.target.checked,
                      DEFAULT_COACH_REACTIONS,
                    ),
                  });
                }}
                // `slotProps.input`, never a bare prop on `<Switch>`: MUI
                // forwards unknown props to the ROOT span, leaving the element
                // that actually carries `role="switch"` unlabelled. Same rule,
                // same reason, as `VoiceSettings.tsx`'s own switches.
              />
            }
            label="Show a line from your coach"
          />
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 1, maxWidth: '62ch' }}
          >
            A short remark beside each verdict. Turn this off to keep your
            chosen voice everywhere else — explanations and feedback still read
            the way you picked — while practice stays quiet.
          </Typography>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Play synthesized bytes, returning whether playback was started.
 *
 * Deliberately NOT awaited. `HTMLAudioElement.play()` resolves when playback
 * BEGINS, which in jsdom (and behind an autoplay policy) may be never — so
 * this reports "the element accepted the source and we asked it to play", and
 * `onEnd` reports what actually happened. Same shape, same reasoning, as
 * `VoiceSettings.tsx`'s own.
 */
function playSample(
  blob: Blob,
  ctx: {
    audioRef: { current: HTMLAudioElement | null };
    objectUrlRef: { current: string | null };
    onEnd: () => void;
  },
): boolean {
  if (
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof Audio === 'undefined'
  ) {
    return false;
  }

  const url = URL.createObjectURL(blob);
  ctx.objectUrlRef.current = url;

  const audio = new Audio(url);
  ctx.audioRef.current = audio;
  audio.onended = ctx.onEnd;
  audio.onerror = ctx.onEnd;

  try {
    // Handled rather than dropped: an autoplay policy blocking sound the
    // learner explicitly asked for is not an error state, it just means no
    // sample is coming.
    void Promise.resolve(audio.play()).catch(() => ctx.onEnd());
  } catch {
    ctx.onEnd();
    return false;
  }

  return true;
}

export default CoachSettings;
