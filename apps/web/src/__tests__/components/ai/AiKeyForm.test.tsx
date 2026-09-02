/**
 * `AiKeyForm` — the one place a user pastes, tests and removes their own key
 * (issue #40, epic #25).
 *
 * Two chromes consume this and neither forks it, so the behaviour asserted
 * here is the behaviour BOTH surfaces get. The tests are weighted towards the
 * failure copy, because epic #25 names it as the requirement most at risk of
 * being skipped — and the specific harm is precise: telling a user their key
 * was rejected when it works fine sends them to replace a good credential,
 * and the replacement fails identically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { AiKeyForm } from '../../../components/ai/AiKeyForm';
import {
  classifyTestFailure,
  hasSurroundingWhitespace,
  looksLikeApiKey,
} from '../../../hooks/useAiKey';
import type { AiKeyStatus, AiTestResult } from '../../../types';

const VALID_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

const noKey: AiKeyStatus = { configured: false, hint: null, updatedAt: null };
const hasKey: AiKeyStatus = {
  configured: true,
  hint: '••••6789',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function mockKey(status: AiKeyStatus) {
  server.use(http.get('*/api/ai/key', () => HttpResponse.json({ data: status })));
}

function mockPut(onBody?: (body: Record<string, unknown>) => void) {
  server.use(
    http.put('*/api/ai/key', async ({ request }) => {
      onBody?.((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ data: hasKey });
    }),
  );
}

function mockTest(result: AiTestResult) {
  server.use(
    http.post('*/api/ai/key/test', () => HttpResponse.json({ data: result })),
  );
}

const SUCCESS: AiTestResult = {
  success: true,
  authenticated: true,
  roles: [
    { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
    { roleKey: 'grader', modelId: 'gpt-5.4-mini', reachable: true, error: null },
  ],
  providerKind: 'openai',
  error: null,
};

beforeEach(() => {
  mockKey(noKey);
  mockPut();
  mockTest(SUCCESS);
});

// ---------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------

describe('looksLikeApiKey', () => {
  it('accepts a plausible key', () => {
    expect(looksLikeApiKey(VALID_KEY)).toBe(true);
  });

  it('rejects a half-copied one', () => {
    // Catching this LOCALLY is the point: sent to the server it comes back as
    // "rejected", which tells the user their key is wrong when what happened
    // is that they missed the end of it.
    expect(looksLikeApiKey('sk-abc')).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('not-a-key-at-all')).toBe(false);
  });

  it('judges the TRIMMED value, because shape and bytes are different questions', () => {
    // The form warns about surrounding whitespace and lets the user keep it if
    // they meant it. Refusing a padded-but-complete key as "malformed" would
    // contradict that, and would tell someone their key is incomplete when it
    // is merely indented. The key is still SAVED verbatim.
    expect(looksLikeApiKey(`  ${VALID_KEY}\n`)).toBe(true);
  });

  it('stays loose about what follows the prefix', () => {
    // OpenAI has changed its project/org key segments more than once. A
    // stricter pattern would start rejecting real keys silently.
    expect(looksLikeApiKey('sk-proj-abcdefghijklmnop_QRSTUV-1234')).toBe(true);
    expect(looksLikeApiKey('sk-svcacct-abcdefghijklmnopqrs')).toBe(true);
  });
});

describe('hasSurroundingWhitespace', () => {
  it('spots a trailing newline from a terminal copy', () => {
    expect(hasSurroundingWhitespace(`${VALID_KEY}\n`)).toBe(true);
    expect(hasSurroundingWhitespace(`  ${VALID_KEY}`)).toBe(true);
  });

  it('is quiet for a clean value', () => {
    expect(hasSurroundingWhitespace(VALID_KEY)).toBe(false);
  });

  it('does not fire on an empty field', () => {
    expect(hasSurroundingWhitespace('   ')).toBe(false);
  });
});

describe('classifyTestFailure', () => {
  it('is null for a success', () => {
    expect(classifyTestFailure(SUCCESS)).toBeNull();
    expect(classifyTestFailure(null)).toBeNull();
  });

  it('reports UNREACHABLE when the key authenticated', () => {
    // The case that must never be reported as a bad key.
    expect(
      classifyTestFailure({
        success: false,
        authenticated: true,
        roles: [],
        providerKind: 'openai',
        error: 'cannot reach grader',
      }),
    ).toBe('unreachable');
  });

  it('reports REJECTED when the provider refused the key', () => {
    expect(
      classifyTestFailure({
        success: false,
        authenticated: false,
        roles: [],
        providerKind: 'openai',
        error: 'OpenAI: 401 Incorrect API key provided',
      }),
    ).toBe('rejected');
  });

  it('reports NETWORK when the request never got there', () => {
    expect(
      classifyTestFailure({
        success: false,
        authenticated: false,
        roles: [],
        providerKind: null,
        error: 'The test could not be sent. Check your connection and try again.',
      }),
    ).toBe('network');
  });
});

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

describe('AiKeyForm — the field', () => {
  it('has a real label and is a password field', async () => {
    render(<AiKeyForm />);

    const field = await screen.findByLabelText(/OpenAI API key/i);
    expect(field).toHaveAttribute('type', 'password');
    // So a password manager cannot silently re-send a credential.
    expect(field).toHaveAttribute('autocomplete', 'new-password');
  });

  it('explains what happens to the key, for someone who has never pasted one', async () => {
    render(<AiKeyForm />);

    expect(
      await screen.findByText(/stored encrypted and is never shown again/i),
    ).toBeInTheDocument();
  });

  it('says a key is saved and that empty keeps it', async () => {
    mockKey(hasKey);
    render(<AiKeyForm />);

    expect(await screen.findByText(/A key is saved/i)).toBeInTheDocument();
    expect(screen.getByText(/Leave this empty to keep it/i)).toBeInTheDocument();
  });

  it('shows the mask as a placeholder, never the key', async () => {
    mockKey(hasKey);
    render(<AiKeyForm />);

    const field = (await screen.findByLabelText(/OpenAI API key/i)) as HTMLInputElement;
    expect(field.placeholder).toBe('••••6789');
    expect(field.value).toBe('');
  });
});

describe('AiKeyForm — surrounding whitespace', () => {
  it('WARNS rather than silently trimming', async () => {
    // The API stores a key byte-for-byte, and this app must not alter a
    // secret behind the user's back — but a trailing newline is overwhelmingly
    // a copying accident, and saying so beats an authentication failure with
    // no visible cause.
    const user = userEvent.setup();
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), `  ${VALID_KEY}`);

    expect(
      await screen.findByText(/space or a line break around what you pasted/i),
    ).toBeInTheDocument();
  });

  it('sends the value VERBATIM anyway when the user proceeds', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    mockPut((b) => {
      body = b;
    });
    render(<AiKeyForm />);

    const padded = `  ${VALID_KEY}  `;
    await user.type(await screen.findByLabelText(/OpenAI API key/i), padded);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.apiKey).toBe(padded);
  });
});

describe('AiKeyForm — the four failure classes', () => {
  it('catches a malformed paste BEFORE sending it', async () => {
    // Sending it would come back as "rejected", which is the wrong diagnosis.
    const user = userEvent.setup();
    let requested = false;
    server.use(
      http.put('*/api/ai/key', () => {
        requested = true;
        return HttpResponse.json({ data: hasKey });
      }),
    );
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-abc');
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(
      await screen.findByText(/doesn't look like a complete key/i),
    ).toBeInTheDocument();
    expect(requested).toBe(false);
  });

  it('names a REJECTED key as the provider refusing it', async () => {
    const user = userEvent.setup();
    mockTest({
      success: false,
      authenticated: false,
      roles: [],
      providerKind: 'openai',
      error: 'OpenAI: 401 Incorrect API key provided',
    });
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(
      await screen.findByText(/OpenAI did not accept this key/i),
    ).toBeInTheDocument();
  });

  it('tells a user with a WORKING key that their key is fine', async () => {
    // THE test in this file. Reporting this as a bad key sends the user to
    // replace a good credential, and the replacement fails identically —
    // because the real problem is on the administrator's side.
    const user = userEvent.setup();
    mockTest({
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
      error: 'OpenAI: cannot reach the model bound to grader',
    });
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(await screen.findByText(/Your key is fine/i)).toBeInTheDocument();
    // And it is a warning, not an error — nothing the user did is wrong.
    const alerts = screen.getAllByRole('alert');
    const warning = alerts.find((a) => /Your key is fine/.test(a.textContent ?? ''));
    expect(warning?.className).toMatch(/Warning|warning/);
  });

  it('names a NETWORK failure as not the key\'s fault', async () => {
    const user = userEvent.setup();
    server.use(http.post('*/api/ai/key/test', () => HttpResponse.error()));
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(
      await screen.findByText(/Nothing is wrong with your key/i),
    ).toBeInTheDocument();
  });

  it('shows the raw provider text IN ADDITION, never instead', async () => {
    const user = userEvent.setup();
    mockTest({
      success: false,
      authenticated: false,
      roles: [],
      providerKind: 'openai',
      error: 'OpenAI: 401 Incorrect API key provided',
    });
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    // The plain-language message…
    expect(
      await screen.findByText(/OpenAI did not accept this key/i),
    ).toBeInTheDocument();
    // …and the verbatim text beneath it.
    expect(
      screen.getByText(/401 Incorrect API key provided/),
    ).toBeInTheDocument();
  });

  it('renders per-role results, not one boolean', async () => {
    const user = userEvent.setup();
    mockTest({
      success: false,
      authenticated: true,
      roles: [
        { roleKey: 'tutor', modelId: 'gpt-5.4', reachable: true, error: null },
        { roleKey: 'grader', modelId: 'gpt-5.4-mini', reachable: false, error: 'no access' },
      ],
      providerKind: 'openai',
      error: 'summary',
    });
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    const alert = (await screen.findAllByRole('alert')).find((a) =>
      /Your key is fine/.test(a.textContent ?? ''),
    ) as HTMLElement;

    expect(within(alert).getByText('working')).toBeInTheDocument();
    expect(within(alert).getByText('not available')).toBeInTheDocument();
    expect(within(alert).getByText('gpt-5.4-mini')).toBeInTheDocument();
  });
});

describe('AiKeyForm — success', () => {
  it('celebrates unambiguously', async () => {
    const user = userEvent.setup();
    render(<AiKeyForm />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    expect(await screen.findByText(/Your key is working/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Everything this app needs is ready to go/i),
    ).toBeInTheDocument();
  });

  it('clears the field, so no secret sits in the DOM after it was needed', async () => {
    const user = userEvent.setup();
    render(<AiKeyForm />);

    const field = await screen.findByLabelText(/OpenAI API key/i);
    await user.type(field, VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    await screen.findByText(/Your key is working/i);
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('hands off to the consumer after a moment', async () => {
    // Deferred so the success state paints first — a hand-off on the same
    // frame reads as "nothing happened, and then I was somewhere else".
    const onVerified = vi.fn();
    const user = userEvent.setup();
    render(<AiKeyForm onVerified={onVerified} />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    await screen.findByText(/Your key is working/i);
    expect(onVerified).not.toHaveBeenCalled();

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  });

  it('does not hand off on a FAILED test', async () => {
    const onVerified = vi.fn();
    const user = userEvent.setup();
    mockTest({
      success: false,
      authenticated: false,
      roles: [],
      providerKind: 'openai',
      error: 'nope',
    });
    render(<AiKeyForm onVerified={onVerified} />);

    await user.type(await screen.findByLabelText(/OpenAI API key/i), VALID_KEY);
    await user.click(screen.getByRole('button', { name: /Save and test/i }));

    await screen.findByText(/OpenAI did not accept this key/i);
    expect(onVerified).not.toHaveBeenCalled();
  });
});

describe('AiKeyForm — remove', () => {
  it('is not offered when the chrome does not ask for it', async () => {
    // Meaningless during first-run onboarding: there is nothing to remove.
    mockKey(hasKey);
    render(<AiKeyForm />);

    await screen.findByLabelText(/OpenAI API key/i);
    expect(screen.queryByRole('button', { name: /Remove key/i })).not.toBeInTheDocument();
  });

  it('is not offered when no key is stored', async () => {
    render(<AiKeyForm showRemove />);

    await screen.findByLabelText(/OpenAI API key/i);
    expect(screen.queryByRole('button', { name: /Remove key/i })).not.toBeInTheDocument();
  });

  it('is a DISTINCT, CONFIRMED action that states the consequence', async () => {
    // Never "clear the field and save". And the consequence is not obvious:
    // the user is put back to the setup screen.
    const user = userEvent.setup();
    mockKey(hasKey);
    render(<AiKeyForm showRemove />);

    await user.click(await screen.findByRole('button', { name: /Remove key/i }));

    expect(
      await screen.findByText(/taken back to the setup screen/i),
    ).toBeInTheDocument();
    // And reassures: the key still exists at OpenAI.
    expect(screen.getByText(/not deleted at OpenAI/i)).toBeInTheDocument();
  });

  it('can be cancelled without removing anything', async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockKey(hasKey);
    server.use(
      http.delete('*/api/ai/key', () => {
        deleted = true;
        return HttpResponse.json({ data: noKey });
      }),
    );
    render(<AiKeyForm showRemove />);

    await user.click(await screen.findByRole('button', { name: /Remove key/i }));
    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(deleted).toBe(false);
  });

  it('removes and notifies the consumer on confirmation', async () => {
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    mockKey(hasKey);
    server.use(
      http.delete('*/api/ai/key', () => HttpResponse.json({ data: noKey })),
    );
    render(<AiKeyForm showRemove onRemoved={onRemoved} />);

    await user.click(await screen.findByRole('button', { name: /Remove key/i }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Remove key/i }));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  });
});

describe('AiKeyForm — the two chromes', () => {
  it('takes its heading level from the consumer', async () => {
    // So the consuming page keeps a sensible document outline.
    render(<AiKeyForm headingLevel="h2" />);

    expect(
      await screen.findByRole('heading', { level: 2, name: /Your OpenAI key/i }),
    ).toBeInTheDocument();
  });

  it('offers "Test my key" rather than "Save and test" when nothing was typed', async () => {
    mockKey(hasKey);
    render(<AiKeyForm />);

    expect(
      await screen.findByRole('button', { name: /Test my key/i }),
    ).toBeInTheDocument();
  });
});
