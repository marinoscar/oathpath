/**
 * Admin → Settings → AI (`/admin/settings/ai`).
 *
 * Issue #33, epic #25. A REGISTRY CARD and nothing else, per `CLAUDE.md`'s
 * Settings UI Pattern: one entry in `ADMIN_SECTIONS`, one route in `App.tsx`
 * gated on the same permission string, and no tab anywhere.
 *
 * Modelled closely on `EmailSettingsPage.tsx`, which solved this exact shape —
 * a write-only secret, a save, and a separate non-saving diagnostic — and the
 * chrome is reproduced field for field so the page reads as a sibling.
 *
 * -----------------------------------------------------------------------------
 * THIS PAGE CONFIGURES THE SERVER KEY, WHICH IS NOT WHAT INFERENCE RUNS ON
 * -----------------------------------------------------------------------------
 *
 * Epic #25, decision 4: every inference call runs on the CALLING USER's own
 * key. The key on this page exists to fetch the model catalog and to prove
 * connectivity — nothing else. That is stated on screen, because an admin who
 * assumed otherwise would expect their organisation to be billed for
 * everything and would configure spend limits against the wrong account.
 *
 * -----------------------------------------------------------------------------
 * THE ROLE → MODEL SECTION IS DRIVEN BY THE SERVER'S REGISTRY
 * -----------------------------------------------------------------------------
 *
 * The roles come from `GET /api/ai-settings/models`, never from a copy in
 * `apps/web/src/config` — and `wired` is a per-DEPLOYMENT fact, because the API
 * accounts for what the configured provider can actually serve. A chat-only
 * provider renders `speak` and `transcribe` inert automatically, with no edit
 * here.
 *
 * -----------------------------------------------------------------------------
 * ALERT, NOT SNACKBAR, FOR THE TEST RESULT
 * -----------------------------------------------------------------------------
 *
 * A revoked key, an organisation without access to a bound model and a network
 * failure all fail differently, and the provider's own text is the only thing
 * that tells them apart. A snackbar that slides away in five seconds carrying
 * the one string the admin needed to read twice is the wrong control. Save
 * confirmations are the transient case and do use a snackbar.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import ScienceIcon from '@mui/icons-material/Science';
import { Navigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';
import { useAiSettings } from '../../hooks/useAiSettings';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import type { AiModel, AiModelRole, AiProviderKind } from '../../types';

/** The form's own state. Flat, because every field is edited independently. */
interface AiFormState {
  /** `null` is "no provider chosen", exactly as on the wire. */
  provider: AiProviderKind | null;
  enabled: boolean;
  /** Role key → model id, or `''` for unbound. `''` is normalised at submit. */
  models: Record<string, string>;
  /**
   * The key the admin typed, if they typed one.
   *
   * `''` MEANS "I DID NOT RETYPE IT" and is what the field renders on load,
   * because the stored value is unreadable by design. The submit handler omits
   * the field entirely rather than sending `''` — see `handleSubmit`.
   */
  apiKey: string;
}

export default function AiSettingsPage() {
  const { hasPermission } = usePermissions();
  const {
    settings,
    isLoading,
    loadError,
    catalog,
    isCatalogLoading,
    catalogError,
    showAllModels,
    setShowAllModels,
    isSaving,
    saveError,
    isTesting,
    testResult,
    save,
    test,
    clearTestResult,
    clearSaveError,
  } = useAiSettings();

  const [form, setForm] = useState<AiFormState | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);

  // Rebuild the form whenever the server's view changes — on load, and after
  // every successful save. The response is the baseline, never the input.
  useEffect(() => {
    if (!settings) return;

    setForm({
      provider: settings.provider,
      enabled: settings.enabled,
      models: Object.fromEntries(
        Object.entries(settings.models).map(([key, value]) => [key, value ?? '']),
      ),
      // ALWAYS EMPTY after a load. The stored key is unreadable, and a field
      // that appeared to hold it would be a lie about what pressing Save does.
      apiKey: '',
    });
  }, [settings]);

  // -------------------------------------------------------------------------
  // Reachability gate. The CARD is gated on `system_settings:read` so a
  // read-only admin diagnosing "why is AI broken" can get in to look; the
  // write controls below gate themselves.
  // -------------------------------------------------------------------------
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  if (isLoading || !form) {
    return <LoadingSpinner />;
  }

  if (loadError) {
    return (
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Alert severity="error">{loadError}</Alert>
      </Container>
    );
  }

  const keyStatus = settings?.apiKeyStatus;
  const roles: AiModelRole[] = catalog?.roles ?? [];

  /**
   * Is this save meaningfully different from what is stored?
   *
   * A typed key always counts, even when nothing else changed — rotating a key
   * is the whole reason someone opens this page on an otherwise-correct
   * configuration.
   */
  const isDirty =
    form.apiKey !== '' ||
    form.provider !== settings?.provider ||
    form.enabled !== settings?.enabled ||
    Object.entries(form.models).some(
      ([key, value]) => (settings?.models[key] ?? '') !== value,
    );

  /**
   * Why the Test button is disabled, in the admin's terms — or null when it is
   * not.
   *
   * A STATED REASON RATHER THAN A MYSTERIOUSLY GREYED CONTROL. The ladder is
   * ordered by what the admin should fix first, and mirrors the API's own
   * pre-flight refusals so the two can never disagree about which problem is
   * the current one.
   */
  const testBlockedReason: string | null = !canWrite
    ? 'Testing requires permission to change system settings.'
    : isDirty
      ? 'Save your changes first — the test runs against the stored configuration, not the form.'
      : !settings?.provider
        ? 'Choose a provider and save before testing.'
        : !settings.enabled
          ? 'AI is turned off. Turn it on and save before testing.'
          : !keyStatus?.configured
            ? 'No API key is stored. Enter one and save before testing.'
            : null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form || !canWrite) return;

    clearSaveError();
    // Clear a stale diagnosis: it describes the configuration that WAS stored,
    // and leaving it on screen next to a changed one invites the admin to read
    // an old failure as a current one.
    clearTestResult();

    const ok = await save({
      provider: form.provider,
      enabled: form.enabled,
      models: Object.fromEntries(
        Object.entries(form.models).map(([key, value]) => [
          key,
          // `''` from an unselected control is "not bound", which the API
          // expresses as null.
          value === '' ? null : value,
        ]),
      ),
      // THE KEY IS OMITTED ENTIRELY when the admin did not type one. The API
      // treats omitted, null and '' identically, but omitting is what the
      // request visibly says — a reviewer reading the network tab on an
      // ordinary save sees no key field at all.
      ...(form.apiKey !== '' ? { apiKey: form.apiKey } : {}),
    });

    if (ok) setSavedOpen(true);
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" gutterBottom>
        AI
        {!canWrite && ' (read-only)'}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Choose the AI provider, bind a model to each role, and prove the
        connection works.
      </Typography>

      {settings?.settingsError && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <AlertTitle>The stored configuration could not be read</AlertTitle>
          {settings.settingsError}
        </Alert>
      )}

      <Paper sx={{ p: 3 }}>
        <Box component="form" onSubmit={handleSubmit} noValidate>
          {/* ---------------------------------------------------------------
              Provider and master switch
          ---------------------------------------------------------------- */}
          <FormControl fullWidth sx={{ mb: 3 }}>
            <InputLabel id="ai-provider-label">Provider</InputLabel>
            <Select
              labelId="ai-provider-label"
              label="Provider"
              value={form.provider ?? ''}
              disabled={!canWrite}
              onChange={(event) =>
                setForm({
                  ...form,
                  provider: (event.target.value || null) as AiProviderKind | null,
                })
              }
              inputProps={{ 'aria-label': 'Provider' }}
            >
              {/* '' is a real, persisted state: "no provider chosen". */}
              <MenuItem value="">
                <em>Not configured</em>
              </MenuItem>
              <MenuItem value="openai">OpenAI</MenuItem>
            </Select>
            <FormHelperText>
              More providers are planned. Only OpenAI is available today.
            </FormHelperText>
          </FormControl>

          <FormControlLabel
            control={
              <Switch
                checked={form.enabled}
                disabled={!canWrite}
                onChange={(event) =>
                  setForm({ ...form, enabled: event.target.checked })
                }
              />
            }
            label="Enable AI features"
            sx={{ mb: 1 }}
          />
          <FormHelperText sx={{ mb: 3 }}>
            A separate switch from the provider, so you can turn AI off without
            losing this configuration.
          </FormHelperText>

          <Divider sx={{ my: 3 }} />

          {/* ---------------------------------------------------------------
              The server key
          ---------------------------------------------------------------- */}
          <Typography variant="h6" gutterBottom>
            Server API key
          </Typography>
          <Alert severity="info" sx={{ mb: 2 }}>
            This key is used only to list the available models and to test the
            connection. <strong>It does not run any user&apos;s requests</strong>
            {' '}— every person signs in with their own key, so each of them sees
            and pays for their own usage.
          </Alert>

          <TextField
            fullWidth
            type="password"
            label="OpenAI API key"
            value={form.apiKey}
            disabled={!canWrite}
            onChange={(event) =>
              setForm({ ...form, apiKey: event.target.value })
            }
            // So a password manager cannot silently re-send a credential the
            // admin did not mean to change.
            autoComplete="new-password"
            placeholder={keyStatus?.hint ?? 'sk-…'}
            helperText={
              keyStatus?.configured
                ? `A key is saved${
                    keyStatus.updatedAt
                      ? ` (last changed ${new Date(keyStatus.updatedAt).toLocaleString()})`
                      : ''
                  }. Leave this blank to keep it.`
                : 'No key is saved yet. Paste one to configure AI.'
            }
            sx={{ mb: 3 }}
          />

          <Divider sx={{ my: 3 }} />

          {/* ---------------------------------------------------------------
              Role → model bindings
          ---------------------------------------------------------------- */}
          <Typography variant="h6" gutterBottom>
            Models
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Each job gets its own model. The grader runs on every practice
            answer, so it should be fast and cheap; the tutor is what learners
            spend the most time with.
          </Typography>

          <FormControlLabel
            control={
              <Switch
                checked={showAllModels}
                onChange={(event) => setShowAllModels(event.target.checked)}
              />
            }
            label="Show all models"
            sx={{ mb: 1 }}
          />
          <FormHelperText sx={{ mb: 2 }}>
            {catalog
              ? `By default only text models from generation ${catalog.minGeneration} and above are listed. Turn this on if the model you need is missing.`
              : 'Turn this on if the model you need is missing.'}
          </FormHelperText>

          {catalogError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {catalogError}
            </Alert>
          )}

          {catalog?.notConfigured && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Save an API key to load the list of models you can choose from.
            </Alert>
          )}

          {catalog?.error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              <AlertTitle>The model list could not be loaded</AlertTitle>
              <Box
                component="pre"
                sx={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  m: 0,
                }}
              >
                {catalog.error}
              </Box>
            </Alert>
          )}

          {roles.map((role) => (
            <RoleBinding
              key={role.key}
              role={role}
              models={catalog?.models ?? []}
              value={form.models[role.key] ?? ''}
              disabled={!canWrite || !role.wired || isCatalogLoading}
              onChange={(modelId) =>
                setForm({
                  ...form,
                  models: { ...form.models, [role.key]: modelId },
                })
              }
            />
          ))}

          {saveError && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={clearSaveError}>
              {saveError}
            </Alert>
          )}

          {/* ---------------------------------------------------------------
              Actions
          ---------------------------------------------------------------- */}
          <Box sx={{ display: 'flex', gap: 2, mt: 3, flexWrap: 'wrap' }}>
            <Button
              type="submit"
              variant="contained"
              disabled={!canWrite || !isDirty || isSaving || isTesting}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="outlined"
              startIcon={<ScienceIcon />}
              onClick={() => void test()}
              disabled={!!testBlockedReason || isTesting}
            >
              {isTesting ? 'Testing…' : 'Test connection'}
            </Button>
          </Box>
          <FormHelperText sx={{ mt: 1 }}>
            {testBlockedReason ??
              'Checks that the saved key works and can reach each model you have bound.'}
          </FormHelperText>

          {/* A PERSISTENT, DISMISSIBLE ALERT — never a snackbar. See the file
              header: this is a diagnosis, and it has to stay on screen. It is
              driven by `testResult.success` and never by "the call resolved". */}
          {testResult && (
            <Alert
              severity={testResult.success ? 'success' : 'error'}
              sx={{ mt: 2 }}
              onClose={clearTestResult}
            >
              <AlertTitle>
                {testResult.success
                  ? 'The connection works'
                  : testResult.authenticated
                    ? 'The key works, but some models are unreachable'
                    : 'The connection failed'}
              </AlertTitle>

              {!testResult.success && (
                <Box
                  component="pre"
                  sx={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    mt: 1,
                    mb: testResult.roles.length > 0 ? 1 : 0,
                  }}
                >
                  {testResult.error ??
                    'The provider reported a failure with no message.'}
                </Box>
              )}

              {/* PER-ROLE RESULTS, not one boolean. A key can authenticate and
                  still have no access to the grader's model. */}
              {testResult.roles.map((role) => (
                <Box key={role.roleKey} sx={{ mt: 1 }}>
                  <Chip
                    size="small"
                    color={role.reachable ? 'success' : 'error'}
                    label={role.reachable ? 'reachable' : 'unreachable'}
                    sx={{ mr: 1 }}
                  />
                  <Typography variant="body2" component="span">
                    {role.roleKey} → {role.modelId}
                  </Typography>
                  {role.error && (
                    <Typography
                      variant="caption"
                      component="div"
                      sx={{ fontFamily: 'monospace', mt: 0.5 }}
                    >
                      {role.error}
                    </Typography>
                  )}
                </Box>
              ))}
            </Alert>
          )}
        </Box>
      </Paper>

      {settings?.updatedAt && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
          Last updated {new Date(settings.updatedAt).toLocaleString()}
          {settings.updatedBy ? ` by ${settings.updatedBy.email}` : ''}
        </Typography>
      )}

      {/* The transient case: a save succeeded and there is nothing to read. */}
      <Snackbar
        open={savedOpen}
        autoHideDuration={4000}
        onClose={() => setSavedOpen(false)}
        message="AI settings saved"
      />
    </Container>
  );
}

/**
 * One role's model select.
 *
 * Extracted so the filtering rule — a role only ever offers models of the
 * family it needs — lives in one place rather than being repeated per role.
 * A `grader` select must never offer `whisper-1`.
 */
function RoleBinding({
  role,
  models,
  value,
  disabled,
  onChange,
}: {
  role: AiModelRole;
  models: AiModel[];
  value: string;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  const options = useMemo(
    () => models.filter((model) => model.family === role.capability),
    [models, role.capability],
  );

  return (
    <FormControl fullWidth sx={{ mb: 2 }} disabled={disabled}>
      <InputLabel id={`ai-role-${role.key}-label`}>{role.label}</InputLabel>
      <Select
        labelId={`ai-role-${role.key}-label`}
        label={role.label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputProps={{ 'aria-label': role.label }}
      >
        <MenuItem value="">
          <em>Not bound</em>
        </MenuItem>
        {/* A stored binding whose model is no longer in the catalog is still
            OFFERED, so an admin editing an unrelated role does not silently
            clear it by saving. Losing a working binding to a filter is worse
            than showing one entry the list cannot explain. */}
        {value !== '' && !options.some((model) => model.id === value) && (
          <MenuItem value={value}>{value} (not in the current list)</MenuItem>
        )}
        {options.map((model) => (
          <MenuItem key={model.id} value={model.id}>
            {model.id}
          </MenuItem>
        ))}
      </Select>
      <FormHelperText>
        {role.wired
          ? role.description
          : `${role.description} — coming soon; nothing uses this yet.`}
      </FormHelperText>
    </FormControl>
  );
}
