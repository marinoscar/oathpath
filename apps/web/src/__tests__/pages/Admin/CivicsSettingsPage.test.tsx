/**
 * `/admin/settings/civics` (issue #126, epic #51).
 *
 * DELIBERATELY NOT MOCKING THE HOOK, unlike the sibling admin page suites. Two
 * of this page's four load-bearing claims are claims about the WIRE — that a
 * national correction omits `stateCode` entirely rather than sending null, and
 * that a blank date omits `effectiveFrom` rather than sending `''` — and a
 * mocked hook would assert them against a function this suite itself wrote.
 * `usePermissions` and `useAuth` are real too (driven by the fixture user), so
 * the read-only case exercises the same code path a real read-only admin does;
 * only the network is faked, with MSW.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import { render, mockAdminUser } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import CivicsSettingsPage from '../../../pages/Admin/CivicsSettingsPage';
import type { CivicsDynamicAnswerItem } from '../../../types';

// -----------------------------------------------------------------------------
// Fixtures — civics-content.md §4.1's worked example, plus a state question
// -----------------------------------------------------------------------------

const SPEAKER: CivicsDynamicAnswerItem = {
  questionId: '11111111-1111-4111-8111-111111111111',
  testVersionCode: 'v2008',
  number: 43,
  prompt: 'Who is the Speaker of the House of Representatives now?',
  categoryId: '99999999-9999-4999-8999-999999999999',
  dynamicScope: 'national',
  answers: [
    {
      id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      text: 'Jane Q. Doe',
      sort: 0,
      stateCode: null,
      verifiedAt: '2026-01-15T00:00:00.000Z',
      effectiveFrom: '2023-01-07T00:00:00.000Z',
      effectiveTo: null,
      sourceNote: 'U.S. House of Representatives, Office of the Clerk, retrieved 2026-01-15',
    },
  ],
  missingStateCodes: [],
};

const GOVERNOR: CivicsDynamicAnswerItem = {
  questionId: '22222222-2222-4222-8222-222222222222',
  testVersionCode: 'v2008',
  number: 44,
  prompt: 'Who is the Governor of your state now?',
  categoryId: '99999999-9999-4999-8999-999999999999',
  dynamicScope: 'state',
  answers: [
    {
      id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      text: 'Chris P. Bacon',
      sort: 0,
      stateCode: 'OH',
      verifiedAt: '2026-02-01T00:00:00.000Z',
      effectiveFrom: '2023-01-09T00:00:00.000Z',
      effectiveTo: null,
      sourceNote: 'Ohio Secretary of State, retrieved 2026-02-01',
    },
    {
      id: 'cccccccc-3333-4333-8333-cccccccccccc',
      text: 'Pat E. O’Furniture',
      sort: 0,
      stateCode: 'TX',
      verifiedAt: '2026-02-01T00:00:00.000Z',
      effectiveFrom: '2023-01-17T00:00:00.000Z',
      effectiveTo: null,
      sourceNote: 'Texas Secretary of State, retrieved 2026-02-01',
    },
  ],
  // The gap list: Wyoming's learners currently have an unanswerable question.
  missingStateCodes: ['WY'],
};

const ITEMS = [SPEAKER, GOVERNOR];

/** The API's own words when a static question is submitted to this surface. */
const STATIC_REFUSAL =
  'Civics question 12 (v2008) has dynamicScope "none" and is not administered here. Only ' +
  '"national" and "state" answers change on their own; a static answer is corrected through a ' +
  'reviewed content change, so that the correction carries provenance and is validated before ' +
  'it reaches a learner.';

/**
 * The same UTC-pinned rendering the page uses, written out independently so the
 * assertion is not a tautology over the page's own helper — and so it is
 * locale-independent on whatever runner this executes on.
 */
function expectedDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** An admin with the read half of the controller's gate and not the write half. */
const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  id: 'read-only-admin-id',
  email: 'readonly@example.com',
  permissions: mockAdminUser.permissions.filter(
    (permission) => permission !== 'system_settings:write',
  ),
};

/** Neither half — the caller `RequirePermission` bounces before this page renders. */
const outsider: MockUser = {
  ...mockAdminUser,
  id: 'outsider-id',
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
};

let putBodies: Record<string, unknown>[] = [];

function mockList(items: CivicsDynamicAnswerItem[] = ITEMS) {
  server.use(
    http.get('*/api/civics/dynamic-answers', () =>
      HttpResponse.json({
        data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
      }),
    ),
  );
}

/** The real close-then-open response shape: the row that was closed, and the one opened. */
function mockCorrection() {
  server.use(
    http.put('*/api/civics/dynamic-answers', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      putBodies.push(body);

      const item = ITEMS.find((candidate) => candidate.questionId === body.questionId)!;
      const stateCode = (body.stateCode as string | undefined) ?? null;
      const open = item.answers.find((answer) => answer.stateCode === stateCode) ?? null;
      const effectiveFrom = body.effectiveFrom
        ? `${String(body.effectiveFrom)}T00:00:00.000Z`
        : '2026-09-02T12:00:00.000Z';

      return HttpResponse.json({
        data: {
          questionId: item.questionId,
          testVersionCode: item.testVersionCode,
          number: item.number,
          prompt: item.prompt,
          categoryId: item.categoryId,
          dynamicScope: item.dynamicScope,
          stateCode,
          previous: open ? { ...open, effectiveTo: effectiveFrom } : null,
          current: {
            id: 'dddddddd-4444-4444-8444-dddddddddddd',
            text: body.text,
            sort: 0,
            stateCode,
            verifiedAt: '2026-09-02T12:00:00.000Z',
            effectiveFrom,
            effectiveTo: null,
            sourceNote: body.sourceNote,
          },
        },
      });
    }),
  );
}

function mockRefusal() {
  server.use(
    http.put('*/api/civics/dynamic-answers', async ({ request }) => {
      putBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        { message: STATIC_REFUSAL, statusCode: 400 },
        { status: 400 },
      );
    }),
  );
}

function renderPage(user: MockUser = mockAdminUser, mode: 'light' | 'dark' = 'light') {
  return render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <CivicsSettingsPage />
    </ThemeProvider>,
    { wrapperOptions: { user } },
  );
}

const SPEAKER_EDIT = { name: /correct the national answer for question 43/i } as const;
const OHIO_EDIT = { name: /correct the answer for OH on question 44/i } as const;

/** Open a question's panel — its answer rows are inert until it is expanded. */
async function expand(user: ReturnType<typeof userEvent.setup>, prompt: RegExp) {
  await user.click(await screen.findByRole('button', { name: prompt }));
}

beforeEach(() => {
  putBodies = [];
  setViewportWidth(1440);
  mockList();
  mockCorrection();
});

// -----------------------------------------------------------------------------
// Reading the answers
// -----------------------------------------------------------------------------

describe('/admin/settings/civics — reading the answers', () => {
  it('lists every dynamic question under one h1', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Civics Answers' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: /#43 \(v2008\) Who is the Speaker of the House/i,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: /#44 \(v2008\) Who is the Governor/i }),
    ).toBeVisible();
  });

  it('shows the current answer and when it was verified', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);

    expect(await screen.findByText('Jane Q. Doe')).toBeVisible();
    expect(
      screen.getByText(
        new RegExp(`Verified ${expectedDay('2026-01-15T00:00:00.000Z')}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ),
    ).toBeVisible();
  });

  it('names the states with no recorded answer, which nothing else surfaces', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    // Visible before the panel is even opened, because a gap is the thing an
    // administrator most needs to be told about.
    expect(screen.getByText('1 state with no answer')).toBeVisible();

    await expand(user, /Who is the Governor/i);

    expect(await screen.findByText(/No answer is recorded for WY/i)).toBeVisible();
  });
});

// -----------------------------------------------------------------------------
// Reachability versus content — the two halves of the controller's gate
// -----------------------------------------------------------------------------

describe('/admin/settings/civics — permission gating', () => {
  it('lets a read-only admin read every answer with every correction disabled', async () => {
    const user = userEvent.setup();
    renderPage(readOnlyAdmin);
    await screen.findByRole('heading', { level: 1, name: 'Civics Answers' });

    // Said up front, not left to be discovered by finding controls dead.
    expect(screen.getByText(/\(read-only\)/)).toBeVisible();
    expect(
      screen.getByText(/Recording a correction needs permission to change system settings/i),
    ).toBeVisible();

    await expand(user, /Who is the Speaker of the House/i);

    expect(await screen.findByText('Jane Q. Doe')).toBeVisible();
    expect(screen.getByRole('button', SPEAKER_EDIT)).toBeDisabled();
  });

  it('lets a write-capable admin open the correction dialog', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));

    expect(await screen.findByRole('dialog', { name: /correct this answer/i })).toBeVisible();
    expect(screen.getByLabelText(/new answer/i)).toBeEnabled();
  });

  it('renders nothing for a caller holding neither permission, rather than a 403 wall of controls', async () => {
    renderPage(outsider);

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Civics Answers' })).not.toBeInTheDocument(),
    );
  });
});

// -----------------------------------------------------------------------------
// The confirmation names the change
// -----------------------------------------------------------------------------

describe('/admin/settings/civics — the confirmation names the change', () => {
  it('names the question, the state, the old value and the new value', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Governor/i);
    await user.click(await screen.findByRole('button', OHIO_EDIT));

    await user.type(screen.getByLabelText(/new answer/i), 'Ann Chovie');
    await user.type(screen.getByLabelText(/^source/i), 'Ohio Secretary of State, 2027-01-11');
    await user.click(screen.getByRole('button', { name: /review correction/i }));

    const dialog = await screen.findByRole('dialog', { name: /review this correction/i });

    // WHICH QUESTION, WHICH STATE, OLD VALUE, NEW VALUE — a generic
    // "are you sure?" would confirm none of them.
    expect(within(dialog).getByText(/#44 \(v2008\) Who is the Governor of your state now\?/i)).toBeVisible();
    expect(within(dialog).getByText('OH')).toBeVisible();
    expect(within(dialog).getByText('Chris P. Bacon')).toBeVisible();
    expect(within(dialog).getByText('Ann Chovie')).toBeVisible();
    // And that the old value is not being destroyed.
    expect(
      within(dialog).getByText(/does not overwrite the current answer/i),
    ).toBeVisible();
  });

  it('says a national answer does not vary by state, rather than showing an empty state', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk, 2027-01-03');
    await user.click(screen.getByRole('button', { name: /review correction/i }));

    const dialog = await screen.findByRole('dialog', { name: /review this correction/i });
    expect(
      within(dialog).getByText(/National — this answer does not vary by state/i),
    ).toBeVisible();
  });

  it('writes nothing until the correction is confirmed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk, 2027-01-03');
    await user.click(screen.getByRole('button', { name: /review correction/i }));

    await screen.findByRole('dialog', { name: /review this correction/i });
    expect(putBodies).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Recording a correction
// -----------------------------------------------------------------------------

describe('/admin/settings/civics — recording a correction', () => {
  it('refuses to move on without a source note, and writes nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.click(screen.getByRole('button', { name: /review correction/i }));

    expect(
      await screen.findByText(/a source is required for every correction/i),
    ).toBeVisible();
    expect(
      screen.queryByRole('dialog', { name: /review this correction/i }),
    ).not.toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it('shows the new effective date and says the previous answer was closed, not overwritten', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk, 2027-01-03');
    await user.type(screen.getByLabelText(/effective from/i), '2027-01-03');
    await user.click(screen.getByRole('button', { name: /review correction/i }));
    await user.click(await screen.findByRole('button', { name: /record correction/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(
      new RegExp(`effective from ${expectedDay('2027-01-03T00:00:00.000Z')}`, 'i'),
    );
    expect(status).toHaveTextContent(/John R\. Roe/);
    expect(status).toHaveTextContent(/previous answer, “Jane Q\. Doe”, was closed/i);
    expect(status).toHaveTextContent(/stays on record/i);
  });

  it('updates the answer in place so the list shows what a learner now sees', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk, 2027-01-03');
    await user.click(screen.getByRole('button', { name: /review correction/i }));
    await user.click(await screen.findByRole('button', { name: /record correction/i }));

    await screen.findByRole('status');
    expect(screen.getByText('Currently: John R. Roe')).toBeVisible();
  });

  it('sends the state code for a state answer, and the source note the API requires', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Governor/i);
    await user.click(await screen.findByRole('button', OHIO_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'Ann Chovie');
    await user.type(screen.getByLabelText(/^source/i), 'Ohio Secretary of State, 2027-01-11');
    await user.click(screen.getByRole('button', { name: /review correction/i }));
    await user.click(await screen.findByRole('button', { name: /record correction/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({
      questionId: GOVERNOR.questionId,
      stateCode: 'OH',
      text: 'Ann Chovie',
      sourceNote: 'Ohio Secretary of State, 2027-01-11',
    });
  });

  it('omits stateCode entirely for a national answer, and effectiveFrom when no date was given', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk');
    await user.click(screen.getByRole('button', { name: /review correction/i }));
    await user.click(await screen.findByRole('button', { name: /record correction/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    // Not `stateCode: null` — the API rejects a stateCode on a national
    // question outright — and not `effectiveFrom: ''`, which is not a date.
    expect(Object.keys(putBodies[0]).sort()).toEqual(['questionId', 'sourceNote', 'text']);
  });

  it('fills a gap for a state that had no answer at all', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Governor/i);
    await user.click(
      await screen.findByRole('button', { name: /correct the answer for WY on question 44/i }),
    );

    const dialog = await screen.findByRole('dialog', { name: /correct this answer/i });
    expect(within(dialog).getByText(/No answer is recorded for this slot yet/i)).toBeVisible();

    await user.type(screen.getByLabelText(/new answer/i), 'Sal Monella');
    await user.type(screen.getByLabelText(/^source/i), 'Wyoming Secretary of State, 2027-01-04');
    await user.click(screen.getByRole('button', { name: /review correction/i }));
    await user.click(await screen.findByRole('button', { name: /record correction/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/no answer before, so nothing was closed/i);
    // The gap is gone from the page, because the gap is filled.
    expect(screen.queryByText('1 state with no answer')).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// A question this surface does not administer
// -----------------------------------------------------------------------------

describe('/admin/settings/civics — a refused correction', () => {
  it('surfaces the API refusal of a static question verbatim, and changes nothing', async () => {
    mockRefusal();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await expand(user, /Who is the Speaker of the House/i);
    await user.click(await screen.findByRole('button', SPEAKER_EDIT));
    await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
    await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk');
    await user.click(screen.getByRole('button', { name: /review correction/i }));
    await user.click(await screen.findByRole('button', { name: /record correction/i }));

    // The sentence that says what to do instead, not a flattened "could not save".
    expect(await screen.findByText(STATIC_REFUSAL)).toBeVisible();
    expect(screen.getByText(/the correction was not recorded/i)).toBeVisible();
    // The dialog stays open over the values the admin typed, and nothing on the
    // page claims a correction happened.
    expect(screen.getByRole('dialog', { name: /review this correction/i })).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// 360px and both themes
// -----------------------------------------------------------------------------

describe('/admin/settings/civics — 360px and both themes', () => {
  it('renders the answers and their correction controls at 360px', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Civics Answers' });

    await expand(user, /Who is the Governor/i);

    expect(await screen.findByText('Chris P. Bacon')).toBeVisible();
    expect(screen.getByRole('button', OHIO_EDIT)).toBeVisible();
  });

  it.each(['light', 'dark'] as const)(
    'records a correction in the %s theme',
    async (mode) => {
      const user = userEvent.setup();
      renderPage(mockAdminUser, mode);
      await screen.findByRole('heading', { level: 1 });

      await expand(user, /Who is the Speaker of the House/i);
      await user.click(await screen.findByRole('button', SPEAKER_EDIT));
      await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
      await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk');
      await user.click(screen.getByRole('button', { name: /review correction/i }));
      await user.click(await screen.findByRole('button', { name: /record correction/i }));

      expect(await screen.findByRole('status')).toHaveTextContent(/John R\. Roe/);
    },
  );

  it.each(['light', 'dark'] as const)(
    'shows a refusal at 360px in the %s theme',
    async (mode) => {
      mockRefusal();
      setViewportWidth(360);
      const user = userEvent.setup();
      renderPage(mockAdminUser, mode);
      await screen.findByRole('heading', { level: 1 });

      await expand(user, /Who is the Speaker of the House/i);
      await user.click(await screen.findByRole('button', SPEAKER_EDIT));
      await user.type(screen.getByLabelText(/new answer/i), 'John R. Roe');
      await user.type(screen.getByLabelText(/^source/i), 'Office of the Clerk');
      await user.click(screen.getByRole('button', { name: /review correction/i }));
      await user.click(await screen.findByRole('button', { name: /record correction/i }));

      expect(await screen.findByText(STATIC_REFUSAL)).toBeVisible();
    },
  );

  it.each(['light', 'dark'] as const)(
    'keeps a read-only admin read-only at 360px in the %s theme',
    async (mode) => {
      setViewportWidth(360);
      const user = userEvent.setup();
      renderPage(readOnlyAdmin, mode);
      await screen.findByRole('heading', { level: 1 });

      await expand(user, /Who is the Speaker of the House/i);

      expect(await screen.findByRole('button', SPEAKER_EDIT)).toBeDisabled();
    },
  );
});
