/**
 * Admin → Settings → Feature Flags (`/admin/settings/feature-flags`).
 *
 * Issue #92, epic #90. The "Feature Flags" tab of `SystemSettingsPage`, now an
 * addressable route — which is the point of the split: a flag rollout can be
 * linked to in a ticket, where `/admin/settings` plus "click the second tab"
 * could not be.
 *
 * `FeatureFlagsList` is unchanged, including its local-first editing (toggles
 * accumulate locally and are pushed in one save). Routing changes nothing about
 * that contract.
 */

import { FeatureFlagsList } from '../../components/admin/FeatureFlagsList';
import { SystemSettingsSection } from './SystemSettingsSection';

export default function FeatureFlagsPage() {
  return (
    <SystemSettingsSection
      title="Feature Flags"
      description="Turn optional application features on or off for everyone."
      requiredPermission="system_settings:read"
    >
      {({ settings, canWrite, isSaving, saveBranch }) => (
        <FeatureFlagsList
          flags={settings.features}
          onSave={(features) => saveBranch('features', features)}
          disabled={!canWrite || isSaving}
        />
      )}
    </SystemSettingsSection>
  );
}
