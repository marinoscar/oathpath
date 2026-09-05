/**
 * Settings → Voice (`/settings/voice`).
 *
 * Issue #288, epic #280. The home every voice preference in this epic was
 * missing: `QuestionAudio`'s premium opt-in was hard-coded `false` on the
 * practice screen and inverted on the writing screen, with a comment saying
 * where the opt-in is stored was "a later issue's business". This is that
 * issue.
 *
 * A REGISTRY CARD PLUS A ROUTE, NEVER A TAB (`CLAUDE.md`'s Settings UI Pattern,
 * rules 1, 2 and 4). This is a reachability question — its own destination —
 * not a second view of Appearance's content or of the AI key page's, and the
 * two gates are different kinds: a destination gate is about reachability, a
 * tab gate is about content. It reuses the shared `SettingsHub` by declaring
 * itself in `config/userSettingsSections.tsx`; nothing here forks or copies it.
 *
 * NO `permission`, like every card in that file. `GET`/`PATCH /api/user-settings`
 * grant `user_settings:read`/`:write` to all three roles, and
 * `GET /api/ai/speech/voices` is `@Auth()` with no permissions — every
 * authenticated learner owns their own voice preferences, and there is no
 * "may choose a voice" privilege in this product's authorization model to
 * mirror. Inventing one would leave a Viewer, the default role, unable to slow
 * down the voice reading them their questions.
 *
 * THIN, like `UserNotificationsPage`: every line of shared page chrome (the
 * settings fetch, the loading spinner, the fetch-error alert, the
 * success/failure snackbars) lives in `UserSettingsSection`, and the controls
 * live in `components/settings/VoiceSettings.tsx`. What is left here is the
 * wiring and the two reads that section does not do.
 *
 * =============================================================================
 * TWO INDEPENDENT READS, REPORTED SEPARATELY
 * =============================================================================
 *
 * `GET /api/ai/speech/voices` (#283) answers what this deployment can speak in;
 * `AiStatus` answers whether this learner has a key. Neither is the settings
 * document, and neither blocks the page:
 *
 *   - A FAILED voice list is `speakBound: false` in effect — the premium
 *     section says the plain "nothing set up here" sentence, which is the same
 *     thing it says on a fresh install and is TRUE either way from the
 *     learner's side. It is never an error, for the reason
 *     `docs/specs/voice.md` §2 gives: the browser reads everything regardless.
 *   - `useOptionalAiStatus` is the NON-THROWING accessor, so this page renders
 *     with or without an `AiStatusProvider` above it. `null` means "we do not
 *     know", which says nothing rather than claiming a key is missing.
 */

import { useEffect, useState } from 'react';

import { VoiceSettings } from '../components/settings/VoiceSettings';
import { useOptionalAiStatus } from '../contexts/AiStatusContext';
import { useIsMounted } from '../hooks/useIsMounted';
import { listSpeechVoices } from '../services/api';
import type { SpeechVoice, VoiceSettingsPatch } from '../types';
import { UserSettingsSection } from './UserSettingsSection';

/** Mirrors the `Voice` card in `config/userSettingsSections.tsx`, so the hub
 *  card, the compact AppBar title (#95) and this page's `h1` all agree. */
const PAGE_TITLE = 'Voice';
const PAGE_DESCRIPTION =
  'How questions are read to you, and what happens when you answer out loud.';

export default function VoiceSettingsPage() {
  const aiStatus = useOptionalAiStatus();
  const isMounted = useIsMounted();

  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [speakBound, setSpeakBound] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    // NO `catch` BRANCH THAT REPORTS ANYTHING. A voice list that could not be
    // read leaves the page in exactly the state a fresh install is in, which
    // renders correctly and truthfully — see the file header.
    void listSpeechVoices({ signal: controller.signal })
      .then((response) => {
        if (!isMounted()) return;
        setVoices(response.voices);
        setSpeakBound(response.speakBound);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [isMounted]);

  return (
    <UserSettingsSection title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
      {({ settings, isSaving, save }) => (
        <VoiceSettings
          // THE RAW STORED NAMESPACE, passed straight through — `undefined`
          // when the learner has never saved a preference, which is the normal
          // case. Deliberately NOT `?? {}`-ed into a defaulted object here:
          // every control resolves its own value, and the one thing that must
          // never exist is a filled-in local copy that a save would serialise.
          voice={settings.voice}
          voices={voices}
          speakBound={speakBound}
          userKeyConfigured={aiStatus?.status?.userKeyConfigured ?? null}
          isSaving={isSaving}
          onChange={(voice: VoiceSettingsPatch) => {
            // ONE FIELD PER WRITE, and `null` where the learner has returned to
            // the built-in default — the component has already reduced the
            // choice to that shape. `voice` is field-wise merged server-side
            // (like `study` and `navigation`), so the fields this request does
            // not name stay exactly as they were, including staying ABSENT.
            //
            // The promise is intentionally dropped: `save` reports its own
            // failures through the section's snackbar rather than rejecting.
            // On success the section re-renders from the SERVER's response, so
            // what the controls show afterwards is what was actually stored —
            // no optimistic overlay, and therefore no second source of truth.
            void save(
              { voice },
              {
                success: 'Voice preferences updated',
                failure: 'Failed to update voice preferences',
              },
            );
          }}
        />
      )}
    </UserSettingsSection>
  );
}
