/**
 * `/admin/settings/ai` — page behaviour (issue #33, epic #25).
 *
 * The hook is mocked here; the WIRE contract (blank key omitted, key sent
 * verbatim, If-Match) is asserted against real HTTP in
 * `AiSettingsPage.wire.test.tsx`. What is left for this file is everything the
 * page decides on its own: the read-only treatment, the `testBlockedReason`
 * ladder, per-role test rendering, and the states the catalog can be in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import AiSettingsPage from '../../../pages/Admin/AiSettingsPage';
import type { AiModelCatalog, AiSettings, AiTestResult } from '../../../types';

const hookState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../hooks/useAiSettings', () => ({
  useAiSettings: () => hookState.value,
}));

const settings: AiSettings = {
  provider: 'openai',
  enabled: true,
  models: { tutor: 'gpt-5.4', grader: 'gpt-5.4-mini' },
  minModelGeneration: 5.4,
  apiKeyStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  settingsError: null,
  version: 3,
  updatedAt: '2026-08-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

const catalog: AiModelCatalog = {
  models: [
    { id: 'gpt-5.4', family: 'text', generation: 5.4, createdAt: null },
    { id: 'gpt-5.4-mini', family: 'text', generation: 5.4, createdAt: null },
    { id: 'tts-1-hd', family: 'tts', generation: null, createdAt: null },
  ],
  roles: [
    {
      key: 'tutor',
      label: 'Tutor',
      description: 'Explains civics answers and guides study.',
      capability: 'text',
      wired: true,
    },
    {
      key: 'grader',
      label: 'Grader',
      description: 'Decides whether an answer was right.',
      capability: 'text',
      wired: true,
    },
    {
      key: 'speak',
      label: 'Speech synthesis',
      description: 'Reads questions aloud.',
      capability: 'tts',
      wired: false,
    },
  ],
  notConfigured: false,
  error: null,
  minGeneration: 5.4,
  showAll: false,
};

function setHook(overrides: Record<string, unknown> = {}) {
  hookState.value = {
    settings,
    isLoading: false,
    loadError: null,
    catalog,
    isCatalogLoading: false,
    catalogError: null,
    showAllModels: false,
    setShowAllModels: vi.fn(),
    isSaving: false,
    saveError: null,
    isTesting: false,
    testResult: null,
    save: vi.fn().mockResolvedValue(true),
    test: vi.fn().mockResolvedValue(undefined),
    clearTestResult: vi.fn(),
    clearSaveError: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

function renderPage(user = mockAdminUser) {
  return render(<AiSettingsPage />, { wrapperOptions: { user } });
}

/**
 * The test-result alert, found by text it contains.
 *
 * The page renders several alerts (the key explainer, a settings error), so
 * queries about the RESULT are scoped to the one holding it rather than to the
 * document — otherwise a copy change elsewhere silently makes these assertions
 * about the wrong element.
 */
async function findResultAlert(contains: RegExp): Promise<HTMLElement> {
  const alerts = await screen.findAllByRole('alert');
  const match = alerts.find((alert) => contains.test(alert.textContent ?? ''));
  if (!match) throw new Error(`No alert matched ${contains}`);
  return match;
}

beforeEach(() => setHook());

describe('AiSettingsPage — reachability and read-only', () => {
  it('redirects a caller without system_settings:read', () => {
    // The card and the route both gate on this string; the page repeats it so
    // a direct navigation cannot bypass a missing route guard.
    renderPage(mockUser);

    expect(screen.queryByText(/Server API key/i)).not.toBeInTheDocument();
  });

  it('lets a READ-ONLY admin in, and says so', async () => {
    // The card gate is about reachability: an admin diagnosing "why is AI
    // broken" is worth letting in to look.
    const readOnly = {
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter(
        (p) => p !== 'system_settings:write',
      ),
    };

    renderPage(readOnly);

    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
  });

  it('disables every write control for a read-only admin', async () => {
    const readOnly = {
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter(
        (p) => p !== 'system_settings:write',
      ),
    };

    renderPage(readOnly);

    expect(await screen.findByLabelText(/OpenAI API key/i)).toBeDisabled();
    expect(screen.getByRole('switch', { name: /Enable AI features/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Test connection/i })).toBeDisabled();
  });
});

describe('AiSettingsPage — the key field', () => {
  it('states that this key does NOT run users\' requests', async () => {
    // An admin who assumed otherwise would expect their organisation to be
    // billed for everything and would set spend limits on the wrong account.
    renderPage();

    expect(
      await screen.findByText(/does not run any user's requests/i),
    ).toBeInTheDocument();
  });

  it('says a key is saved, and that blank keeps it', async () => {
    renderPage();

    expect(await screen.findByText(/A key is saved/i)).toBeInTheDocument();
    expect(screen.getByText(/Leave this blank to keep it/i)).toBeInTheDocument();
  });

  it('says plainly when no key is saved', async () => {
    // The two states demand opposite actions, and blank-preserves is unusable
    // if the admin cannot tell them apart.
    setHook({
      settings: {
        ...settings,
        apiKeyStatus: {
          configured: false,
          hint: null,
          updatedAt: null,
          updatedByUserId: null,
        },
      },
    });

    renderPage();

    expect(await screen.findByText(/No key is saved yet/i)).toBeInTheDocument();
  });
});

describe('AiSettingsPage — role bindings', () => {
  it('renders one select per role from the SERVER registry', async () => {
    renderPage();

    expect(await screen.findByRole('combobox', { name: /Tutor/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Grader/i })).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: /Speech synthesis/i }),
    ).toBeInTheDocument();
  });

  it('renders an UNWIRED role inert, with a coming-soon note', async () => {
    // Declared in the IA so an admin can see what is coming, but not
    // configurable, because nothing dispatches to it.
    renderPage();

    expect(
      await screen.findByRole('combobox', { name: /Speech synthesis/i }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('offers a role only models of the family it needs', async () => {
    // A grader select must never offer whisper or a TTS model.
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('combobox', { name: /Grader/i }));

    expect(screen.getByRole('option', { name: 'gpt-5.4' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'tts-1-hd' })).not.toBeInTheDocument();
  });

  it('keeps a stored binding that is no longer in the catalog', async () => {
    // Losing a working binding to a filter is worse than showing one entry the
    // list cannot explain.
    const user = userEvent.setup();
    setHook({
      settings: { ...settings, models: { tutor: 'gpt-retired', grader: null } },
    });
    renderPage();

    await user.click(await screen.findByRole('combobox', { name: /Tutor/i }));

    expect(
      screen.getByRole('option', { name: /gpt-retired \(not in the current list\)/i }),
    ).toBeInTheDocument();
  });
});

describe('AiSettingsPage — the catalog states', () => {
  it('explains a fresh install rather than reporting an error', async () => {
    // `notConfigured` is the state of every new deployment.
    setHook({ catalog: { ...catalog, models: [], notConfigured: true } });
    renderPage();

    expect(
      await screen.findByText(/Save an API key to load the list of models/i),
    ).toBeInTheDocument();
  });

  it('shows a provider refusal verbatim', async () => {
    setHook({
      catalog: {
        ...catalog,
        models: [],
        error: 'OpenAI: 401 Incorrect API key provided',
      },
    });
    renderPage();

    expect(
      await screen.findByText(/401 Incorrect API key provided/),
    ).toBeInTheDocument();
  });

  it('explains what the show-all toggle is for', async () => {
    renderPage();

    expect(
      await screen.findByText(/Turn this on if the model you need is missing/i),
    ).toBeInTheDocument();
  });

  it('surfaces a stored-configuration error without failing to render', async () => {
    // A 500 here would make the broken row take down the one screen capable of
    // repairing it.
    setHook({
      settings: {
        ...settings,
        settingsError: 'The stored AI configuration is invalid at: provider.',
      },
    });
    renderPage();

    expect(await screen.findByText(/invalid at: provider/)).toBeInTheDocument();
    // Still renders the form.
    expect(screen.getByLabelText(/OpenAI API key/i)).toBeInTheDocument();
  });
});

describe('AiSettingsPage — the test button', () => {
  it('states WHY it is disabled rather than greying out silently', async () => {
    setHook({
      settings: {
        ...settings,
        apiKeyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
      },
    });
    renderPage();

    expect(
      await screen.findByText(/No API key is stored\. Enter one and save before testing/i),
    ).toBeInTheDocument();
  });

  it('refuses to test an unsaved form, and says so', async () => {
    // The test runs against the stored configuration, not the form. Testing
    // while dirty would report on something the admin is not looking at.
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-new');

    expect(screen.getByText(/Save your changes first/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Test connection/i })).toBeDisabled();
  });

  it('says the switch is off rather than testing anyway', async () => {
    setHook({ settings: { ...settings, enabled: false } });
    renderPage();

    expect(
      await screen.findByText(/AI is turned off\. Turn it on and save/i),
    ).toBeInTheDocument();
  });

  it('runs the test when nothing blocks it', async () => {
    const test = vi.fn().mockResolvedValue(undefined);
    setHook({ test });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Test connection/i }));

    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
  });
});

describe('AiSettingsPage — the test result', () => {
  it('renders a success', async () => {
    const result: AiTestResult = {
      success: true,
      authenticated: true,
      roles: [
        { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
      ],
      providerKind: 'openai',
      error: null,
    };
    setHook({ testResult: result });
    renderPage();

    // Scoped to the alert: the page's own subtitle also says "prove the
    // connection works", which is the right copy and stays.
    const alert = await findResultAlert(/The connection works/i);
    expect(within(alert).getByText(/The connection works/i)).toBeInTheDocument();
  });

  it('DISTINGUISHES a bad key from a key that cannot reach a model', async () => {
    // The whole reason `authenticated` is reported separately: told only "the
    // test failed", an admin would replace a perfectly good key.
    const result: AiTestResult = {
      success: false,
      authenticated: true,
      roles: [
        { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
        {
          roleKey: 'grader',
          modelId: 'gpt-5.4-mini',
          reachable: false,
          error: 'OpenAI: you do not have access to this model',
        },
      ],
      providerKind: 'openai',
      error: 'OpenAI: This key works, but it cannot reach the model bound to grader.',
    };
    setHook({ testResult: result });
    renderPage();

    expect(
      await screen.findByText(/The key works, but some models are unreachable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/you do not have access to this model/),
    ).toBeInTheDocument();
  });

  it('renders PER-ROLE results, not one boolean', async () => {
    const result: AiTestResult = {
      success: false,
      authenticated: true,
      roles: [
        { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
        { roleKey: 'grader', modelId: 'gpt-5.4-mini', reachable: false, error: 'nope' },
      ],
      providerKind: 'openai',
      // Realistic summary text. Deliberately does not contain the word the
      // chips use, so the assertions below are about the chips.
      error: 'OpenAI: This key works, but it cannot reach the model bound to grader.',
    };
    setHook({ testResult: result });
    renderPage();

    const alert = await findResultAlert(/tutor/);
    expect(within(alert).getByText(/tutor → gpt-5\.4$/)).toBeInTheDocument();
    expect(within(alert).getByText(/grader → gpt-5\.4-mini/)).toBeInTheDocument();
    // Two chips, one per role, with opposite verdicts — not one boolean.
    expect(within(alert).getByText('reachable')).toBeInTheDocument();
    expect(within(alert).getByText('unreachable')).toBeInTheDocument();
  });

  it('shows a full failure verbatim', async () => {
    const result: AiTestResult = {
      success: false,
      authenticated: false,
      roles: [],
      providerKind: 'openai',
      error: 'OpenAI: 401 Incorrect API key provided',
    };
    setHook({ testResult: result });
    renderPage();

    expect(await screen.findByText(/The connection failed/i)).toBeInTheDocument();
    expect(
      screen.getByText(/401 Incorrect API key provided/),
    ).toBeInTheDocument();
  });

  it('is DISMISSIBLE and persistent, not a snackbar', async () => {
    // A diagnosis has to stay on screen long enough to act on.
    const clearTestResult = vi.fn();
    setHook({
      testResult: {
        success: false,
        authenticated: false,
        roles: [],
        providerKind: 'openai',
        error: 'boom',
      },
      clearTestResult,
    });
    const user = userEvent.setup();
    renderPage();

    const alerts = await screen.findAllByRole('alert');
    const failure = alerts.find((a) => a.textContent?.includes('boom'));
    expect(failure).toBeDefined();

    await user.click(
      // The Alert's own close button.
      within(failure as HTMLElement).getByRole('button'),
    );
    expect(clearTestResult).toHaveBeenCalled();
  });
});

describe('AiSettingsPage — saving', () => {
  it('reports a 409 by explaining that the form was reloaded', async () => {
    setHook({
      saveError:
        'Someone else changed the AI settings while you were editing. ' +
        'The form has been reloaded with the current configuration — review it and save again.',
    });
    renderPage();

    expect(
      await screen.findByText(/Someone else changed the AI settings/i),
    ).toBeInTheDocument();
  });

  it('disables Save until something changed', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: /^Save$/i })).toBeDisabled();
  });

  it('enables Save once a key is typed, even with nothing else changed', async () => {
    // Rotating a key is the whole reason someone opens this page on an
    // otherwise-correct configuration.
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-new');

    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });
});
