/**
 * Settings → Coach (`/settings/coach`).
 *
 * Issue #322, epic #305. The home for the choice E14 exists to give a learner:
 * how their coach talks to them.
 *
 * A REGISTRY CARD PLUS A ROUTE, NEVER A TAB (`CLAUDE.md`'s Settings UI
 * Pattern, rules 1, 2 and 4). This is a reachability question — its own
 * destination — not a second view of Voice's content. The two are genuinely
 * different axes: `voice` governs how spoken practice SOUNDS, `coach` governs
 * how an answer is FRAMED, in text as much as in speech, and a learner who
 * never presses play still has a coach. Folding this into the Voice page
 * would put the whole coach configuration behind a heading whose other
 * controls do nothing for them.
 *
 * NO `permission`, like every card in `config/userSettingsSections.tsx`.
 * `GET`/`PATCH /api/user-settings` grant `user_settings:read`/`:write` to all
 * three roles, and `GET /api/ai/coach/personas` is `@Auth()` with no
 * permissions. There is no "may choose a coach" privilege in this product's
 * authorization model to mirror, and inventing one would leave a Viewer — the
 * default role — unable to change how the application talks to them.
 *
 * THIN, like `VoiceSettingsPage`: the settings fetch, the spinner, the
 * fetch-error alert and the save snackbars all live in `UserSettingsSection`,
 * and the controls live in `components/settings/CoachSettings.tsx`. What is
 * left here is the wiring and the two reads that section does not do.
 *
 * =============================================================================
 * TWO INDEPENDENT READS, NEITHER OF WHICH BLOCKS THE PAGE
 * =============================================================================
 *
 * `GET /api/ai/coach/personas` answers what a learner may choose between;
 * `GET /api/ai/speech/voices` answers whether anything can be SPOKEN here.
 * Neither is the settings document, and they fail differently:
 *
 *   - A failed persona list is reported, because without it there is nothing
 *     to choose from — and the web deliberately declares no persona list of
 *     its own to fall back on (`ai-model-roles.ts`'s registry rule). The page
 *     says so plainly and the learner's stored choice is untouched.
 *   - A failed voice list is `speakBound: false` in effect, which removes the
 *     Hear buttons and nothing else. Never an error: `docs/specs/voice.md` §2
 *     — every sample is still readable, and an unbound `speak` role is the
 *     ordinary state of a working install.
 */

import { useEffect, useState } from 'react';

import { CoachSettings } from '../components/settings/CoachSettings';
import { useIsMounted } from '../hooks/useIsMounted';
import { listCoachPersonas, listSpeechVoices } from '../services/api';
import type { CoachPersonaOption, CoachSettingsPatch } from '../types';
import { UserSettingsSection } from './UserSettingsSection';

/** Mirrors the `Coach` card in `config/userSettingsSections.tsx`, so the hub
 *  card, the compact AppBar title and this page's `h1` all agree. */
const PAGE_TITLE = 'Coach';
const PAGE_DESCRIPTION =
  'How your coach talks to you about your answers, and whether it says anything beyond the verdict.';

export default function CoachSettingsPage() {
  const isMounted = useIsMounted();

  const [personas, setPersonas] = useState<CoachPersonaOption[]>([]);
  const [personasFailed, setPersonasFailed] = useState(false);
  const [speakBound, setSpeakBound] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void listCoachPersonas({ signal: controller.signal })
      .then((response) => {
        if (!isMounted()) return;
        setPersonas(response.personas);
        setPersonasFailed(false);
      })
      .catch(() => {
        // REPORTED, unlike the voice list below: with no personas there is
        // nothing to render a choice from, and silently showing an empty
        // group would read as "this account has no options" rather than "we
        // could not load them".
        if (!isMounted()) return;
        setPersonasFailed(true);
      });

    // NO `catch` BRANCH THAT REPORTS ANYTHING. A voice list that could not be
    // read leaves the page exactly where a fresh install is: readable samples,
    // no Hear buttons — which renders correctly and truthfully.
    void listSpeechVoices({ signal: controller.signal })
      .then((response) => {
        if (!isMounted()) return;
        setSpeakBound(response.speakBound);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [isMounted]);

  return (
    <UserSettingsSection title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
      {({ settings, isSaving, save }) => (
        <CoachSettings
          // THE RAW STORED NAMESPACE, passed straight through — `undefined`
          // when the learner has never saved a preference, which is the
          // normal case. Deliberately not `?? {}`-ed here: the component
          // resolves each value itself, and the one thing that must never
          // exist is a filled-in local copy a save could serialise.
          coach={settings.coach}
          personas={personas}
          personasFailed={personasFailed}
          speakBound={speakBound}
          isSaving={isSaving}
          onChange={(coach: CoachSettingsPatch) => {
            // ONE FIELD PER WRITE, and `null` where the learner has returned
            // to the built-in default — the component has already reduced the
            // choice to that shape. `coach` is field-wise merged server-side,
            // so the field this request does not name stays exactly as it
            // was, including staying ABSENT.
            //
            // The promise is intentionally dropped: `save` reports its own
            // failures through the section's snackbar rather than rejecting.
            void save(
              { coach },
              {
                success: 'Coach preferences updated',
                failure: 'Failed to update coach preferences',
              },
            );
          }}
        />
      )}
    </UserSettingsSection>
  );
}
