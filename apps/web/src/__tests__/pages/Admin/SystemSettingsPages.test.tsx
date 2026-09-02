/**
 * The four routed system-settings pages introduced by issue #92, epic #90.
 *
 * These are THIN wrappers, so the suite deliberately does not re-test
 * `UISettings`, `FeatureFlagsList` or `SystemSettingsEditor` — each already has
 * its own file, and duplicating them here would move the maintenance cost
 * without moving the coverage. The three presentational components are stubbed
 * so that what remains under test is exactly what #92 wrote: which component
 * each route mounts, which permission each page demands, which branch of the
 * settings document each save touches, and whether `disabled` reaches the
 * editor when the user cannot write.
 *
 * The stubs expose `disabled` as text and a button that fires `onSave`, because
 * a prop is only meaningfully "wired" if something can observe it arriving.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';

vi.mock('../../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../components/admin/UISettings', () => ({
  UISettings: vi.fn(({ onSave, disabled }) => (
    <div data-testid="ui-settings">
      <span>disabled:{String(disabled)}</span>
      <button onClick={() => onSave({ allowUserThemeOverride: false })}>save-ui</button>
    </div>
  )),
}));

vi.mock('../../../components/admin/FeatureFlagsList', () => ({
  FeatureFlagsList: vi.fn(({ onSave, disabled }) => (
    <div data-testid="feature-flags">
      <span>disabled:{String(disabled)}</span>
      <button onClick={() => onSave({ beta: true })}>save-flags</button>
    </div>
  )),
}));

vi.mock('../../../components/admin/SystemSettingsEditor', () => ({
  SystemSettingsEditor: vi.fn(({ onSave, disabled }) => (
    <div data-testid="json-editor">
      <span>disabled:{String(disabled)}</span>
      <button onClick={() => onSave({ features: { beta: true } })}>save-json</button>
    </div>
  )),
}));

import { useSystemSettings } from '../../../hooks/useSystemSettings';
import { usePermissions } from '../../../hooks/usePermissions';
import GeneralSettingsPage from '../../../pages/Admin/GeneralSettingsPage';
import AppearanceSettingsPage from '../../../pages/Admin/AppearanceSettingsPage';
import FeatureFlagsPage from '../../../pages/Admin/FeatureFlagsPage';
import AdvancedSettingsPage from '../../../pages/Admin/AdvancedSettingsPage';

const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUsePermissions = vi.mocked(usePermissions);

const ADMIN_PERMISSIONS = ['system_settings:read', 'system_settings:write'];

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

function setSettings(overrides: Partial<ReturnType<typeof useSystemSettings>> = {}) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  mockUseSystemSettings.mockReturnValue({
    settings: {
      ui: { allowUserThemeOverride: true },
      features: { beta: false, newDashboard: true },
      updatedAt: '2024-01-15T10:30:00Z',
      updatedBy: null,
      version: 7,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings,
    replaceSettings: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  });
  return updateSettings;
}

const renderAsAdmin = (ui: React.ReactElement) =>
  render(ui, { wrapperOptions: { user: mockAdminUser } });

describe('Console settings pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(ADMIN_PERMISSIONS);
    setSettings();
  });

  describe('Appearance', () => {
    it('mounts UISettings under its own heading', () => {
      renderAsAdmin(<AppearanceSettingsPage />);

      expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
      expect(screen.getByTestId('ui-settings')).toBeInTheDocument();
      // The neighbouring pages' components must NOT come along for the ride —
      // the whole point of splitting the tab strip.
      expect(screen.queryByTestId('feature-flags')).not.toBeInTheDocument();
      expect(screen.queryByTestId('json-editor')).not.toBeInTheDocument();
    });

    it('PATCHes only the ui branch when its editor saves', async () => {
      const user = userEvent.setup();
      const updateSettings = setSettings();

      renderAsAdmin(<AppearanceSettingsPage />);
      await user.click(screen.getByRole('button', { name: 'save-ui' }));

      expect(updateSettings).toHaveBeenCalledWith({ ui: { allowUserThemeOverride: false } });
    });
  });

  describe('Feature Flags', () => {
    it('mounts FeatureFlagsList under its own heading', () => {
      renderAsAdmin(<FeatureFlagsPage />);

      expect(screen.getByRole('heading', { name: 'Feature Flags' })).toBeInTheDocument();
      expect(screen.getByTestId('feature-flags')).toBeInTheDocument();
      expect(screen.queryByTestId('ui-settings')).not.toBeInTheDocument();
    });

    it('PATCHes only the features branch when its editor saves', async () => {
      const user = userEvent.setup();
      const updateSettings = setSettings();

      renderAsAdmin(<FeatureFlagsPage />);
      await user.click(screen.getByRole('button', { name: 'save-flags' }));

      expect(updateSettings).toHaveBeenCalledWith({ features: { beta: true } });
    });
  });

  describe('Advanced (JSON)', () => {
    it('mounts the raw editor for a user holding system_settings:write', () => {
      renderAsAdmin(<AdvancedSettingsPage />);

      expect(screen.getByRole('heading', { name: 'Advanced (JSON)' })).toBeInTheDocument();
      expect(screen.getByTestId('json-editor')).toBeInTheDocument();
    });

    it('refuses a user holding only system_settings:read', () => {
      // NOT the same gate as its three siblings, and deliberately so: a raw
      // editor over the whole document has no read-only meaning. The route in
      // `App.tsx` enforces the same string; this is the page's own defence.
      setPermissions(['system_settings:read']);

      renderAsAdmin(<AdvancedSettingsPage />);

      expect(screen.queryByTestId('json-editor')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Advanced (JSON)' })).not.toBeInTheDocument();
    });

    it('passes the rethrowing save through, so the editor can show its own error', async () => {
      // The editor renders an inline `Alert` from its own `catch`, so it needs
      // the raw hook function rather than the snackbar path that swallows the
      // rejection.
      const user = userEvent.setup();
      const updateSettings = setSettings();

      renderAsAdmin(<AdvancedSettingsPage />);
      await user.click(screen.getByRole('button', { name: 'save-json' }));

      expect(updateSettings).toHaveBeenCalledWith({ features: { beta: true } });
    });
  });

  describe('System (general)', () => {
    it('summarises the settings document without offering to edit it', () => {
      renderAsAdmin(<GeneralSettingsPage />);

      expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument();
      expect(screen.getByText('7')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('Allowed')).toBeInTheDocument();
      expect(screen.getByText(/never changed since seeding/i)).toBeInTheDocument();
    });

    it('reports a locked theme when the override is off', () => {
      setSettings({
        settings: {
          ui: { allowUserThemeOverride: false },
          features: {},
          updatedAt: '2024-01-15T10:30:00Z',
          updatedBy: { id: 'admin-id', email: 'admin@example.com' },
          version: 2,
        },
      });

      renderAsAdmin(<GeneralSettingsPage />);

      expect(screen.getByText(/locked to the system theme/i)).toBeInTheDocument();
      expect(screen.getByText(/last updated by admin@example\.com/i)).toBeInTheDocument();
    });
  });

  describe('Shared page chrome', () => {
    it('marks itself read-only and disables the editor without write access', async () => {
      setPermissions(['system_settings:read']);

      renderAsAdmin(<AppearanceSettingsPage />);

      await waitFor(() => expect(screen.getByText(/\(read-only\)/i)).toBeInTheDocument());
      // Said out loud in the subtitle, not left to be discovered by clicking a
      // dead Save button.
      expect(screen.getByText('disabled:true')).toBeInTheDocument();
    });

    it('disables the editor mid-save even for a writer', () => {
      setSettings({ isSaving: true });

      renderAsAdmin(<AppearanceSettingsPage />);

      expect(screen.getByText('disabled:true')).toBeInTheDocument();
    });

    it('shows a spinner while the document is loading', () => {
      setSettings({ settings: null, isLoading: true });

      renderAsAdmin(<FeatureFlagsPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByTestId('feature-flags')).not.toBeInTheDocument();
    });

    it('shows the fetch error and mounts no editor over a null document', () => {
      setSettings({ settings: null, error: 'Failed to load system settings' });

      renderAsAdmin(<FeatureFlagsPage />);

      expect(screen.getByText(/failed to load system settings/i)).toBeInTheDocument();
      expect(screen.queryByTestId('feature-flags')).not.toBeInTheDocument();
    });

    it('confirms a successful save in a snackbar', async () => {
      const user = userEvent.setup();
      setSettings();

      renderAsAdmin(<AppearanceSettingsPage />);
      await user.click(screen.getByRole('button', { name: 'save-ui' }));

      await waitFor(() => expect(screen.getByText('Settings saved')).toBeInTheDocument());
    });

    it('reports a rejected save in a snackbar instead of rethrowing at the editor', async () => {
      const user = userEvent.setup();
      setSettings({
        updateSettings: vi.fn().mockRejectedValue(new Error('Settings were updated elsewhere')),
      });

      renderAsAdmin(<AppearanceSettingsPage />);
      await user.click(screen.getByRole('button', { name: 'save-ui' }));

      await waitFor(() =>
        expect(screen.getByText(/settings were updated elsewhere/i)).toBeInTheDocument(),
      );
    });

    it('redirects a user with no system settings permission at all', () => {
      setPermissions([]);

      renderAsAdmin(<AppearanceSettingsPage />);

      expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
    });
  });
});
