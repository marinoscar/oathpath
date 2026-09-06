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
 * machinery (`PreviewState`, the in-flight ref, the stale-press token,
 * `releaseAudio`, the always-mounted live region) is reused with it.
 *
 * =============================================================================
 * D2. THE ELEMENT IS UNLOCKED INSIDE THE PRESS, BEFORE THE FIRST `await` (#389)
 * =============================================================================
 *
 * This page shipped the bug #383 fixed on `/settings/voice`, unchanged and for
 * the same reason: `new Audio(url)` was built in the continuation AFTER
 * `await synthesizeSpeech(...)`, so `play()` ran long after the tap that
 * justified it and every mobile autoplay policy correctly refused. Pressing
 * Hear on a phone made no sound and said nothing about why — indistinguishable,
 * to the learner, from a sample that played while the phone was on silent.
 *
 * `lib/gestureAudio.ts` holds the fix once, for all three call sites that had
 * this shape. Its header is where the mechanics live — why the element is
 * claimed and primed synchronously in the handler, why it is the SAME element
 * every press, why the priming clip is silent and muted. What this file has to
 * keep is the ORDER: `primeGestureAudio` is called before the `await` in
 * `hearSample`, and moving it below restores the silence exactly while breaking
 * nothing a desktop test would notice.
 *
 * AND A REFUSAL IS VISIBLE NOW. A rejected `play()` used to be routed into the
 * same `onEnd` as a clip that finished, so a blocked sample and a heard one
 * left this page in identical states. Finishing, being refused, and failing to
 * decode are three messages now, and each says something a learner can act on.
 *
 * =============================================================================
 * D3. THE FEEDBACK BELONGS TO THE PERSONA THAT WAS PRESSED
 * =============================================================================
 *
 * Four cards, not eleven — but each carries a label, a description AND a quoted
 * sample line, and `unfiltered` carries its warning on top of that, so the group
 * is comfortably taller than a phone screen. A single status box after the whole
 * `RadioGroup` is therefore the same defect #383 fixed on the voice page,
 * reached one persona later rather than avoided: press Hear on Supportive and
 * the answer renders three cards below, off screen. So each card shows its own
 * message, the spinner and the inert treatment land on the pressed card alone
 * (`previewRef` was always what protected the key from a second charge), and ONE
 * always-mounted live region — visually hidden, since the words are now on
 * screen beside the button — still announces it.
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
  CircularProgress,
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
import visuallyHidden from '@mui/utils/visuallyHidden';
import { Link as RouterLink } from 'react-router-dom';

import {
  createGestureAudioSlot,
  playPreparedSample,
  primeGestureAudio,
  releaseGestureAudio,
  releaseGestureSample,
  type GestureAudioSlot,
} from '../../lib/gestureAudio';
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

/**
 * What the preview is currently saying, if anything.
 *
 * EVERY NON-IDLE MEMBER CARRIES `persona`, INCLUDING `message` (#389). That is
 * what lets the feedback render in the card of the button that was pressed
 * rather than in one box below all four — see rule D3.
 */
type PreviewState =
  | { kind: 'idle' }
  | { kind: 'preparing'; persona: CoachPersona }
  | { kind: 'playing'; persona: CoachPersona; label: string }
  | {
      kind: 'message';
      persona: CoachPersona;
      text: string;
      needsKey?: boolean;
    };

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

  /**
   * THE ONE `<audio>` ELEMENT, for the life of the component.
   *
   * Never nulled between presses — see rule D2 and `lib/gestureAudio.ts`. The
   * autoplay unlock a tap earns belongs to this element, so replacing it is
   * how the fix undoes itself.
   */
  const gestureSlotRef = useRef<GestureAudioSlot>(createGestureAudioSlot());

  /** Guards a double press: a second press mid-request must not spend twice. */
  const previewRef = useRef(false);

  /**
   * WHICH PRESS THE CURRENTLY INTERESTING ONE IS.
   *
   * `play()`'s rejection and the element's `onerror` both arrive later than the
   * press that caused them, and a learner comparing personas presses Hear again
   * long before either. Without this, a refusal belonging to the sample they
   * abandoned would overwrite the state of the one they are listening to now.
   */
  const previewSeqRef = useRef(0);

  /**
   * Drop the SAMPLE — the bytes, the source and the handlers. **Keeps the
   * element**, which is the whole point (rule D2).
   */
  const releaseAudio = useCallback(() => {
    releaseGestureSample(gestureSlotRef.current);
    previewRef.current = false;
  }, []);

  // Nothing should still be playing after this page unmounts — and the ELEMENT
  // is released here and nowhere else: between presses it is the thing being
  // kept, not the thing being cleaned up.
  useEffect(
    () => () => {
      releaseGestureAudio(gestureSlotRef.current);
      previewRef.current = false;
    },
    [],
  );

  const hearSample = useCallback(
    async (option: CoachPersonaOption) => {
      if (previewRef.current) return;
      releaseAudio();

      // ---------------------------------------------------------------------
      // BEFORE THE FIRST `await`, AND THAT IS NOT AN ACCIDENT OF ORDERING.
      //
      // The synthesis round trip below is the await that closes the user
      // gesture. Anything this function does after it is, to a mobile browser,
      // something the page decided to do on its own — which is exactly why
      // this page made no sound on a phone until #389. So the element is
      // claimed and unlocked HERE, while the tap is still being handled, and
      // the bytes are poured into that already-permitted element when they
      // arrive. See rule D2 and `lib/gestureAudio.ts`.
      // ---------------------------------------------------------------------
      const audio = primeGestureAudio(gestureSlotRef.current);

      previewRef.current = true;
      const token = ++previewSeqRef.current;
      /** Has this press since been superseded by a newer one? */
      const isCurrent = () => previewSeqRef.current === token;
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
          persona: option.key,
          text: 'We couldn\u2019t play that sample just now. Everything else on this page still works.',
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
                persona: option.key,
                needsKey: true,
                text: 'Hearing a sample uses your own AI key, and there is no key saved on your account yet. You can still read every sample above.',
              }
            : {
                kind: 'message',
                persona: option.key,
                text: 'Spoken samples are not available here, so there is nothing to play. Every sample above is still readable, and your coach still writes to you.',
              },
        );
        return;
      }

      if (result.status === 'failed') {
        setPreview({
          kind: 'message',
          persona: option.key,
          text: `We couldn\u2019t play the ${option.label} sample just now. Reading it above works either way.`,
        });
        return;
      }

      // No `Audio` in this environment at all, so the priming call never had an
      // element to make. Nothing was ever going to play, and saying so is more
      // use than a card that goes quiet as though it had worked.
      if (!audio) {
        setPreview({
          kind: 'message',
          persona: option.key,
          text: `We couldn\u2019t play the ${option.label} sample just now. Reading it above works either way.`,
        });
        return;
      }

      const attempt = playPreparedSample(
        audio,
        result.audio,
        gestureSlotRef.current,
        {
          onEnded: () => {
            if (!isCurrent()) return;
            releaseAudio();
            setPreview({ kind: 'idle' });
          },
          // BLOCKED IS NOT FINISHED (#389). Until this branch existed both
          // landed in the same callback, so a learner whose browser refused the
          // sample saw precisely what a learner who heard it saw: the card
          // going quiet. The remedy is theirs, so it is offered — and the
          // reassurance is this page's standing one, because it is true.
          onBlocked: () => {
            if (!isCurrent()) return;
            releaseAudio();
            setPreview({
              kind: 'message',
              persona: option.key,
              text: 'Your browser blocked the sample from playing. Press Hear again, or check that the phone is not muted. Reading it above works either way.',
            });
          },
          // A DIFFERENT FAILURE, SO A DIFFERENT SENTENCE. The bytes arrived and
          // the element could not make sense of them — telling this learner to
          // press the button again, as the blocked message does, would send
          // them round a loop that cannot end.
          onDecodeError: () => {
            if (!isCurrent()) return;
            releaseAudio();
            setPreview({
              kind: 'message',
              persona: option.key,
              text: `The ${option.label} sample arrived, but your browser could not play it. Reading it above works either way.`,
            });
          },
        },
      );

      setPreview(
        attempt
          ? { kind: 'playing', persona: option.key, label: option.label }
          : {
              kind: 'message',
              persona: option.key,
              text: `We couldn\u2019t play the ${option.label} sample just now. Reading it above works either way.`,
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

  /**
   * The current preview state, flattened to the three things the list needs.
   *
   * Read out here rather than narrowed inside the `.map()` below: the card is
   * rendered in a callback, and a discriminated union narrowed in the enclosing
   * scope is not something to make a closure depend on.
   */
  const previewPersona = preview.kind === 'idle' ? null : preview.persona;
  const preparingPersona =
    preview.kind === 'preparing' ? preview.persona : null;
  const previewNeedsKey =
    preview.kind === 'message' && preview.needsKey === true;

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
              {personas.map((option) => {
                // THE FEEDBACK BELONGS TO A CARD, NOT TO THE LIST (#389). See
                // rule D3: four cards each carrying a description, a quoted
                // sample line and (for `unfiltered`) a warning are taller than
                // a phone screen, so a single box under the last of them is a
                // box the learner who pressed the first button never reaches.
                const isPreparing = preparingPersona === option.key;
                const rowText =
                  previewPersona === option.key ? previewStatusText : '';

                return (
                  <Box
                    key={option.key}
                    sx={{
                      py: 1.5,
                      borderTop: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 1,
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
                          // The spinner replaces the speaker icon on THE PRESSED
                          // CARD ONLY, so "something is happening" and "here is
                          // where it is happening" are one piece of information.
                          startIcon={
                            isPreparing ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : (
                              <VolumeUpIcon />
                            )
                          }
                          // ONLY `onClick`. See rule D — focus, hover and arrowing
                          // through the group must never spend the learner's key.
                          onClick={() => {
                            void hearSample(option);
                          }}
                          // ONLY THE PRESSED CARD GOES INERT. What actually
                          // protects the key from a second charge is `previewRef`,
                          // which covers every button and every way of pressing
                          // one; greying out the other three only made the list
                          // look broken for the length of a round trip, and hid
                          // which of them the learner had asked for.
                          disabled={isSaving || isPreparing}
                          // NAMES THE PERSONA: "Hear" alone is four identical
                          // buttons to somebody listening to the page.
                          aria-label={`Hear the ${option.label} sample`}
                        >
                          Hear
                        </Button>
                      )}
                    </Box>

                    {/* `aria-hidden`, because this is the VISIBLE copy of what
                        the live region below already announces — without it
                        every message is read twice. The link is deliberately
                        OUTSIDE that hidden text: focusable content inside an
                        `aria-hidden` subtree is a focus stop assistive
                        technology cannot name, and this is the one remedy on
                        the page a learner can act on, so it stays reachable. */}
                    {rowText && (
                      <Box sx={{ pl: { xs: 0, sm: 4 }, pt: 0.5 }}>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ maxWidth: '62ch' }}
                          aria-hidden="true"
                        >
                          {rowText}
                        </Typography>
                        {previewNeedsKey && (
                          <Link
                            component={RouterLink}
                            to="/settings/ai"
                            variant="body2"
                          >
                            Add a key
                          </Link>
                        )}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </RadioGroup>

            {/* ONE live region for the whole group, always mounted and empty
                when idle: a live region inserted at the same moment as its text
                is frequently never announced at all — and four of them, one per
                card, is a page that announces nothing reliably and everything
                twice.

                VISUALLY HIDDEN SINCE #389, because the same words are now on
                screen beside the button that was pressed. Sighted learners read
                them there; everyone else hears them from here. The remedy is a
                SENTENCE rather than the link, since the link itself lives in the
                card and a second copy here would be a second focus stop saying
                exactly what the first one says. */}
            <Box role="status" aria-live="polite" sx={visuallyHidden}>
              {previewStatusText}
              {previewNeedsKey
                ? ' You can add a key on the AI settings page.'
                : ''}
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
                // that actually carries the checkbox role unlabelled — which
                // is exactly what a name query found when this was written the
                // other way. Same rule, same reason, as `VoiceSettings.tsx`'s
                // own switches.
                slotProps={{
                  input: { 'aria-label': 'Show a line from your coach' },
                }}
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

export default CoachSettings;
