/**
 * Admin → Settings → Appearance (`/admin/settings/appearance`).
 *
 * Issue #92, epic #90. The "UI Settings" tab of `SystemSettingsPage`, now an
 * addressable route. THIN BY DESIGN: `UISettings` is not touched, not copied,
 * and not re-styled — this issue moves where the component is reached from,
 * nothing about what it renders. Every line of shared page chrome lives in
 * `SystemSettingsSection`.
 *
 * The title and description mirror the `Appearance` card in
 * `config/adminSections.tsx` so the hub card, the rail row (#94), the compact
 * AppBar title (#95) and the page's own `h1` all name the page identically.
 */

import { UISettings } from '../../components/admin/UISettings';
import { SystemSettingsSection } from './SystemSettingsSection';

export default function AppearanceSettingsPage() {
  return (
    <SystemSettingsSection
      title="Appearance"
      description="Set the default theme and the UI defaults new users start with."
      requiredPermission="system_settings:read"
    >
      {({ settings, canWrite, isSaving, saveBranch }) => (
        <UISettings
          settings={settings.ui}
          onSave={(ui) => saveBranch('ui', ui)}
          disabled={!canWrite || isSaving}
        />
      )}
    </SystemSettingsSection>
  );
}
