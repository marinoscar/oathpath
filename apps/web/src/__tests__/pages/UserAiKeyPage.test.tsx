/**
 * `/settings/ai` — the ongoing key and usage page (issue #42, epic #25).
 *
 * Two things get the weight here, and both are about honesty rather than
 * layout:
 *
 *   1. THE PAGE MUST NOT PRESENT RECORDED USAGE AS A BILL. Token counts are
 *      not dollars, this app carries no price table, and some requests record
 *      nothing at all. The caveat sits ABOVE the numbers, and the count of
 *      unaccounted requests is surfaced rather than folded silently into a
 *      total.
 *
 *   2. REMOVING THE KEY RE-ARMS THE GATE. A user left on this page after
 *      removing their key is in an app that no longer works for them, with
 *      nothing to say so.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import UserAiKeyPage from '../../pages/UserAiKeyPage';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import { mockUser } from '../utils/test-utils';
import type { AiKeyStatus, AiStatus, AiUsage } from '../../types';

const KEYED: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const savedKey: AiKeyStatus = {
  configured: true,
  hint: '••••6789',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const usage: AiUsage = {
  since: '2026-08-03T00:00:00.000Z',
  calls: 120,
  successfulCalls: 118,
  promptTokens: 9000,
  completionTokens: 3000,
  totalTokens: 12000,
  callsWithUnknownUsage: 4,
  byModel: [
    { key: 'gpt-5.4', calls: 40, totalTokens: 9000 },
    { key: 'gpt-5.4-mini', calls: 80, totalTokens: 3000 },
  ],
  byRole: [
    { key: 'tutor', calls: 40, totalTokens: 9000 },
    { key: 'grader', calls: 80, totalTokens: 3000 },
  ],
  timeline: [
    { date: '2026-08-01', calls: 60, totalTokens: 6000 },
    { date: '2026-08-02', calls: 0, totalTokens: 0 },
    { date: '2026-08-03', calls: 60, totalTokens: 6000 },
  ],
};

const EMPTY_USAGE: AiUsage = {
  since: '2026-08-03T00:00:00.000Z',
  calls: 0,
  successfulCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  callsWithUnknownUsage: 0,
  byModel: [],
  byRole: [],
  timeline: [{ date: '2026-08-03', calls: 0, totalTokens: 0 }],
};

/** A brand-new account: exactly one day of recorded history. */
const SINGLE_DAY_USAGE: AiUsage = {
  since: '2026-08-03T00:00:00.000Z',
  calls: 3,
  successfulCalls: 3,
  promptTokens: 300,
  completionTokens: 100,
  totalTokens: 400,
  callsWithUnknownUsage: 0,
  byModel: [{ key: 'gpt-5.4', calls: 3, totalTokens: 400 }],
  byRole: [{ key: 'tutor', calls: 3, totalTokens: 400 }],
  timeline: [{ date: '2026-08-03', calls: 3, totalTokens: 400 }],
};

function mockAll(u: AiUsage = usage) {
  server.use(
    http.get('*/api/ai/status', () => HttpResponse.json({ data: KEYED })),
    http.get('*/api/ai/key', () => HttpResponse.json({ data: savedKey })),
    http.get('*/api/ai/usage', () => HttpResponse.json({ data: u })),
  );
}

function renderPage() {
  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <AuthContext.Provider value={auth as never}>
      <MemoryRouter initialEntries={['/settings/ai']}>
        <AiStatusProvider>
          <Routes>
            <Route path="/settings/ai" element={<UserAiKeyPage />} />
            <Route path="/setup/ai-key" element={<div>SETUP SCREEN</div>} />
          </Routes>
        </AiStatusProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => mockAll());

describe('UserAiKeyPage — the key', () => {
  it('reuses the shared form rather than a second one', async () => {
    // Same labels and helper text as the onboarding screen, because it is the
    // same component. A forked copy would drift on the failure copy first.
    renderPage();

    expect(await screen.findByLabelText(/OpenAI API key/i)).toBeInTheDocument();
    expect(screen.getByText(/A key is saved/i)).toBeInTheDocument();
  });

  it('OFFERS REMOVE here, unlike onboarding', async () => {
    renderPage();

    expect(
      await screen.findByRole('button', { name: /Remove key/i }),
    ).toBeInTheDocument();
  });

  it('RE-ARMS THE GATE when the key is removed', async () => {
    // A user left on this page after removing their key is in an app that no
    // longer works for them, with nothing to say so.
    const user = userEvent.setup();
    server.use(
      http.delete('*/api/ai/key', () =>
        HttpResponse.json({
          data: { configured: false, hint: null, updatedAt: null },
        }),
      ),
      // The status flips, as the real endpoint does.
      http.get('*/api/ai/status', () =>
        HttpResponse.json({ data: { ...KEYED, userKeyConfigured: false } }),
      ),
    );

    renderPage();

    await user.click(await screen.findByRole('button', { name: /Remove key/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      // The dialog's own confirm button.
      dialog.querySelector('button:last-of-type') as HTMLElement,
    );

    expect(await screen.findByText('SETUP SCREEN')).toBeInTheDocument();
  });
});

describe('UserAiKeyPage — OpenAiSpendCard, the actual answer to "how much"', () => {
  it('links to the authoritative record, opening in a new tab', async () => {
    renderPage();

    const link = await screen.findByRole('link', { name: /Open OpenAI usage/i });
    expect(link).toHaveAttribute('href', 'https://platform.openai.com/usage');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('renders even in the empty state — a zero-call account still has an OpenAI account worth checking', async () => {
    mockAll(EMPTY_USAGE);
    renderPage();

    expect(await screen.findByText(/Nothing yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open OpenAI usage/i }),
    ).toHaveAttribute('href', 'https://platform.openai.com/usage');
  });
});

describe('UserAiKeyPage — the token trend chart', () => {
  it('renders the chart when there is more than one day of history', async () => {
    renderPage();

    const heading = await screen.findByText('Tokens per day');
    expect(heading).toBeInTheDocument();

    // Accessible labelling: the chart's wrapper points at the heading and the
    // caption underneath via aria-labelledby/aria-describedby, and both ids
    // resolve to real elements in the document.
    const labelledById = heading.getAttribute('id');
    expect(labelledById).toBeTruthy();
    const describedByEl = document.getElementById('ai-usage-trend-desc');
    expect(describedByEl).not.toBeNull();

    const wrapper = document.querySelector(
      `[aria-labelledby="${labelledById}"]`,
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('aria-describedby', 'ai-usage-trend-desc');
  });

  it('renders the single-day sentence, not a chart, when there is exactly one day of history', async () => {
    mockAll(SINGLE_DAY_USAGE);
    renderPage();

    expect(
      await screen.findByText(/tokens across 3 requests\./i),
    ).toBeInTheDocument();
    // The section heading is shared by both renderings; what must NOT appear
    // is the chart itself — its accessible wrapper only exists in the
    // multi-day branch.
    expect(
      document.querySelector('[aria-labelledby="ai-usage-trend-heading"]'),
    ).not.toBeInTheDocument();
  });
});

describe('UserAiKeyPage — usage is not a bill', () => {
  it('states the caveat ABOVE the numbers', async () => {
    // A note under a total is read after the total has already been believed.
    renderPage();

    const caveat = await screen.findByText(/not a bill/i);
    const total = await screen.findByText('12,000');

    // `compareDocumentPosition` returns FOLLOWING when `total` comes after.
    expect(
      caveat.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('states the one remaining caveat concisely, not the old pre-emptive paragraph', async () => {
    // Issue #291: the old alert argued at length against a figure this page
    // never showed. Now that `OpenAiSpendCard` answers "how much have I
    // spent", the alert says only what these counts are NOT.
    renderPage();

    expect(
      await screen.findByText(
        /These are request and token counts OathPath made with your key — not a bill, and not an estimate of one\./i,
      ),
    ).toBeInTheDocument();
  });

  it('shows NO currency figure anywhere', async () => {
    // Presenting an approximate figure as a bill is the failure to avoid, and
    // it would start with someone putting a "$" next to a number here.
    renderPage();

    await screen.findByText('12,000');
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\$|USD|cost|billed|charged you/i);
  });

  it('SURFACES the requests that reported nothing', async () => {
    // A total with 4 unaccounted requests behind it is a different thing from
    // one with none, and only this line lets the reader tell.
    renderPage();

    expect(
      await screen.findByText(/4 of these requests did not report their size/i),
    ).toBeInTheDocument();
  });

  it('omits that line when every request reported', async () => {
    mockAll({ ...usage, callsWithUnknownUsage: 0 });
    renderPage();

    await screen.findByText('12,000');
    expect(screen.queryByText(/did not report their size/i)).not.toBeInTheDocument();
  });
});

describe('UserAiKeyPage — the breakdowns', () => {
  it('breaks usage down by model and by activity', async () => {
    renderPage();

    expect(await screen.findByText('By model')).toBeInTheDocument();
    expect(screen.getByText('By activity')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getByText('grader')).toBeInTheDocument();
  });

  it('lets the user change the window', async () => {
    const user = userEvent.setup();
    let requestedDays: string | null = null;
    server.use(
      http.get('*/api/ai/usage', ({ request }) => {
        requestedDays = new URL(request.url).searchParams.get('days');
        return HttpResponse.json({ data: usage });
      }),
    );

    renderPage();
    await screen.findByText('12,000');

    await user.click(screen.getByRole('combobox', { name: /Period/i }));
    await user.click(screen.getByRole('option', { name: /Last 7 days/i }));

    await waitFor(() => expect(requestedDays).toBe('7'));
  });
});

describe('UserAiKeyPage — empty and failure states', () => {
  it('shows a SENSIBLE EMPTY STATE, not a broken chart', async () => {
    // This is what every user sees on the day they finish onboarding.
    mockAll(EMPTY_USAGE);
    renderPage();

    expect(await screen.findByText(/Nothing yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Once you start practising/i),
    ).toBeInTheDocument();
  });

  it('keeps the key form usable when usage cannot be loaded', async () => {
    // The two answer different questions and fail independently. A usage
    // outage must not cost the user the ability to rotate their key.
    server.use(http.get('*/api/ai/usage', () => HttpResponse.error()));
    renderPage();

    expect(await screen.findByLabelText(/OpenAI API key/i)).toBeInTheDocument();
    expect(await screen.findByText(/Could not load your usage/i)).toBeInTheDocument();
  });
});
