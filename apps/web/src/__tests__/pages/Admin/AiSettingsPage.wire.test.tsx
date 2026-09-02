/**
 * `/admin/settings/ai` — the blank-key WIRE contract (issue #33, epic #25,
 * restating #30 and #115).
 *
 * Deliberately NOT mocking `useAiSettings`: the key-omission behaviour lives
 * in the page's own submit handler, which the hook forwards unchanged.
 * Asserting it therefore means capturing the ACTUAL HTTP request body a real
 * save produces — `usePermissions` and `useAuth` are real too (via
 * `mockAdminUser`), and only the network is faked, with MSW.
 *
 * The failure this guards is specific and quiet: a page that sent `apiKey: ''`
 * would rely on the API treating empty as "preserve". It does — but relying on
 * that means the request no longer SAYS what it means, and the day someone
 * tightens the DTO with a `.min(1)` (which looks like tidying up), every
 * ordinary save starts 400ing on a field the admin never touched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import AiSettingsPage from '../../../pages/Admin/AiSettingsPage';
import type { AiModelCatalog, AiSettings } from '../../../types';

const storedSettings: AiSettings = {
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
    { id: 'gpt-5.6', family: 'text', generation: 5.6, createdAt: null },
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
      description: 'Decides whether an answer was right, and says why not.',
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

function mockLoad(settings: AiSettings = storedSettings) {
  server.use(
    http.get('*/api/ai-settings/models', () => HttpResponse.json({ data: catalog })),
    http.get('*/api/ai-settings', () => HttpResponse.json({ data: settings })),
  );
}

function mockPut(onBody: (body: Record<string, unknown>) => void) {
  server.use(
    http.put('*/api/ai-settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      onBody(body);
      return HttpResponse.json({
        data: { ...storedSettings, version: storedSettings.version + 1 },
      });
    }),
  );
}

function renderPage() {
  return render(<AiSettingsPage />, {
    wrapperOptions: { user: mockAdminUser },
  });
}

describe('AiSettingsPage — save request wire contract', () => {
  beforeEach(() => {
    mockLoad();
  });

  it('OMITS apiKey entirely when the field was left blank', async () => {
    // Not `apiKey: ''`, not `apiKey: null` — absent. The request then says
    // what it means, and a reviewer reading the network tab on an ordinary
    // save sees no key field at all.
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    mockPut((b) => {
      body = b;
    });

    renderPage();
    await screen.findByText(/Server API key/i);

    // Change something else so the form is dirty and Save enables.
    await user.click(screen.getByRole('switch', { name: /Enable AI features/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).not.toHaveProperty('apiKey');
    expect(body).toMatchObject({ enabled: false });
  });

  it('sends a typed key VERBATIM, untrimmed', async () => {
    // A key whose surrounding whitespace is significant is a real key, and a
    // silent trim produces an authentication failure with no visible cause.
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    mockPut((b) => {
      body = b;
    });

    renderPage();
    const field = await screen.findByLabelText(/OpenAI API key/i);

    await user.type(field, '  sk-typed-key  ');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.apiKey).toBe('  sk-typed-key  ');
  });

  it('sends the version it loaded as If-Match', async () => {
    const user = userEvent.setup();
    let ifMatch: string | null = null;
    server.use(
      http.put('*/api/ai-settings', async ({ request }) => {
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: storedSettings });
      }),
    );

    renderPage();
    await screen.findByText(/Server API key/i);
    await user.click(screen.getByRole('switch', { name: /Enable AI features/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(ifMatch).toBe('3'));
  });

  it('normalises an unbound role to null rather than an empty string', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    mockPut((b) => {
      body = b;
    });

    renderPage();
    await screen.findByText(/Server API key/i);

    // Clear the grader binding through the select.
    await user.click(screen.getByRole('combobox', { name: /Grader/i }));
    await user.click(screen.getByRole('option', { name: /Not bound/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect((body?.models as Record<string, unknown>).grader).toBeNull();
  });

  it('never renders the stored key, only its mask', async () => {
    renderPage();

    const field = await screen.findByLabelText(/OpenAI API key/i);
    expect((field as HTMLInputElement).value).toBe('');
    expect((field as HTMLInputElement).placeholder).toBe('••••ab12');
    expect(field).toHaveAttribute('type', 'password');
    // So a password manager cannot silently re-send a credential.
    expect(field).toHaveAttribute('autocomplete', 'new-password');
  });
});
