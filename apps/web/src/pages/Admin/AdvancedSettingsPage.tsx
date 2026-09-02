/**
 * Admin → Settings → Advanced (JSON) (`/admin/settings/advanced`).
 *
 * Issue #92, epic #90. The "Advanced (JSON)" tab of `SystemSettingsPage`, now
 * an addressable route.
 *
 * THIS PAGE GATES ON `system_settings:WRITE`, UNLIKE ITS THREE SIBLINGS, and
 * that asymmetry is deliberate rather than an oversight to be tidied away: the
 * page is a raw editor over the entire settings document, so read-only access
 * to it has no meaning — a user who cannot save has nothing to do here that the
 * typed pages do not do better and more safely. The same string is declared on
 * the card in `config/adminSections.tsx` and enforced on the route in
 * `App.tsx`; all three must agree.
 *
 * `updateSettings` is passed straight through instead of the section's
 * `saveBranch`. `SystemSettingsEditor` renders its own inline error `Alert` and
 * needs the rejection to reach its `catch` — see the note on
 * `SystemSettingsSectionState.updateSettings`.
 */

import { SystemSettingsEditor } from '../../components/admin/SystemSettingsEditor';
import { SystemSettingsSection } from './SystemSettingsSection';

export default function AdvancedSettingsPage() {
  return (
    <SystemSettingsSection
      title="Advanced (JSON)"
      description="Edit the raw system settings document directly, with validation."
      requiredPermission="system_settings:write"
    >
      {({ settings, canWrite, isSaving, updateSettings }) => (
        <SystemSettingsEditor
          settings={settings}
          onSave={updateSettings}
          disabled={!canWrite || isSaving}
        />
      )}
    </SystemSettingsSection>
  );
}
