/**
 * Admin → Settings → System (`/admin/settings/general`).
 *
 * Issue #92, epic #90. The `System` card in `config/adminSections.tsx` — "core
 * system settings, application behavior, and global defaults" — routes here.
 *
 * WHY THIS PAGE SHOWS A SUMMARY RATHER THAN A FORM. The settings document the
 * API actually serves (`SystemSettings` in `types/index.ts`, enforced by
 * `system-settings.controller.ts`) has exactly two editable branches today:
 * `ui` and `features`. Both already have a typed editor, and #92 gives each its
 * own route — Appearance and Feature Flags. There is no third branch, so a
 * "core settings" FORM here would have to invent settings the API does not
 * store, and the epic is explicit that it changes no API, schema, or
 * permission.
 *
 * What is genuinely missing at that route is an at-a-glance answer to "what is
 * this deployment configured to do right now", which today requires opening
 * three tabs. So this page reads the same document its siblings write and
 * states its status: every value below is derived, none is invented, and
 * nothing here is editable. The moment the API grows a core branch, this page
 * is where its editor goes — the route, the card, and the permission are
 * already in place for it.
 *
 * Deliberately NOT a link farm to the sibling pages. The hub at
 * `/admin/settings` (#93) is the navigation surface; duplicating its cards here
 * would give the same links two owners, which is the drift epic #90 exists to
 * remove.
 */

import { Alert, Box, Divider, Stack, Typography } from '@mui/material';
import { SystemSettingsSection } from './SystemSettingsSection';

/** One label/value row. `value` is prose, not a control — this page is read-only. */
function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        // Column on a phone: a label and a right-aligned value on one 360px
        // line collapses into two ragged columns of wrapped text.
        flexDirection: { xs: 'column', sm: 'row' },
        justifyContent: 'space-between',
        gap: { xs: 0.25, sm: 2 },
        py: 1,
      }}
    >
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {value}
      </Typography>
    </Box>
  );
}

export default function GeneralSettingsPage() {
  return (
    <SystemSettingsSection
      title="System"
      description="Configure core system settings, application behavior, and global defaults."
      requiredPermission="system_settings:read"
    >
      {({ settings }) => (
        <Box>
          <Typography variant="h6" gutterBottom>
            Current configuration
          </Typography>

          <Alert severity="info" sx={{ mb: 2 }}>
            These values are read-only here. Change them on the Appearance and
            Feature Flags pages, or edit the whole document on Advanced (JSON).
          </Alert>

          <Stack divider={<Divider flexItem />}>
            <StatusRow label="Settings document version" value={String(settings.version)} />
            <StatusRow
              label="Last updated"
              value={
                settings.updatedBy
                  ? new Date(settings.updatedAt).toLocaleString()
                  : 'Never changed since seeding'
              }
            />
            <StatusRow
              label="Feature flags defined"
              value={String(Object.keys(settings.features).length)}
            />
            <StatusRow
              label="User theme override"
              value={
                settings.ui.allowUserThemeOverride
                  ? 'Allowed'
                  : 'Locked to the system theme'
              }
            />
          </Stack>
        </Box>
      )}
    </SystemSettingsSection>
  );
}
