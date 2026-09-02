/**
 * Civics content fixtures (issue #121, epic #51).
 *
 * Shaped from `apps/api/src/civics/dto/` — `civics-category.dto.ts`,
 * `civics-question.dto.ts`, `civics-question-query.dto.ts` — rather than
 * invented, so a suite that passes here is exercising the payload the server
 * actually sends, including the `{ data: … }` envelope and the `flat`
 * pagination shape.
 *
 * =============================================================================
 * TWO PROPERTIES OF THIS DATA ARE LOAD-BEARING, NOT DECORATION
 * =============================================================================
 *
 *  1. **The categories are NOT in alphabetical order within their section.**
 *     `Colonial Period and Independence` (`sortOrder` 4) precedes `1800s`
 *     (`sortOrder` 5), exactly as the official material does. A component that
 *     sorted locally — the obvious, well-meant `localeCompare` — would put
 *     `1800s` first and silently renumber the exam. That is only catchable if
 *     the fixture disagrees with alphabetical order, so it does.
 *
 *  2. **`STATE_QUESTION_UNRESOLVED` carries answers it must not show.** The
 *     server never sends that combination; the fixture does, so the assertion
 *     "a `state_required` question renders no answer" tests the DISCRIMINATOR
 *     rather than testing that an empty array renders as empty, which would
 *     pass for a component with no such rule at all.
 *
 * The prompts and answers are the real USCIS ones where they are stable
 * (`What is the supreme law of the land?`), and the spec's own placeholder
 * (`Jane Q. Doe`, `civics-content.md` §4.1) where they are not — this repository
 * does not transcribe an officeholder's name into a test fixture.
 *
 * NOTHING HERE CONTAINS THE WORDS THIS SUITE SCANS FOR — `score`, `correct`,
 * `wrong`, `grade` and friends. The flashcard tests assert those strings appear
 * NOWHERE on the study screen, and a fixture carrying one in a category name or
 * an answer would fail a test about the product's design for a reason that had
 * nothing to do with it.
 */

import { http, HttpResponse } from 'msw';

import type {
  CivicsCategory,
  CivicsQuestionDetail,
  CivicsQuestionSummary,
  JourneyProfile,
} from '../../types';
import { profileResponse } from './journey-fixtures';

const API_BASE = '*/api';

/** The instant a reviewer confirmed this content. What "current as of" renders. */
export const VERIFIED_AT = '2026-01-15T09:30:00.000Z';

/** A second, later verification, so a test can tell one date from the other. */
export const VERIFIED_AT_LATER = '2026-03-02T12:00:00.000Z';

export const CATEGORY_DEMOCRACY: CivicsCategory = {
  id: '11111111-1111-4111-8111-111111111111',
  section: 'AMERICAN GOVERNMENT',
  code: 'principles_of_american_democracy',
  name: 'Principles of American Democracy',
  sortOrder: 1,
};

export const CATEGORY_SYSTEM: CivicsCategory = {
  id: '22222222-2222-4222-8222-222222222222',
  section: 'AMERICAN GOVERNMENT',
  code: 'system_of_government',
  name: 'System of Government',
  sortOrder: 2,
};

export const CATEGORY_COLONIAL: CivicsCategory = {
  id: '33333333-3333-4333-8333-333333333333',
  section: 'AMERICAN HISTORY',
  code: 'colonial_period_and_independence',
  name: 'Colonial Period and Independence',
  sortOrder: 4,
};

/** Deliberately after `Colonial Period…` in `sortOrder`, before it alphabetically. */
export const CATEGORY_1800S: CivicsCategory = {
  id: '44444444-4444-4444-8444-444444444444',
  section: 'AMERICAN HISTORY',
  code: 'the_1800s',
  name: '1800s',
  sortOrder: 5,
};

export const CATEGORIES: CivicsCategory[] = [
  CATEGORY_DEMOCRACY,
  CATEGORY_SYSTEM,
  CATEGORY_COLONIAL,
  CATEGORY_1800S,
];

const summary = (
  overrides: Partial<CivicsQuestionSummary> &
    Pick<CivicsQuestionSummary, 'id' | 'number' | 'prompt' | 'categoryId'>,
): CivicsQuestionSummary => ({
  testVersionCode: 'v2008',
  seniorEligible: false,
  dynamicScope: 'none',
  ...overrides,
});

/** One accepted answer, one slot. */
export const SUPREME_LAW = summary({
  id: 'aaaaaaa1-0000-4000-8000-000000000001',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: CATEGORY_DEMOCRACY.id,
});

/** In the 65/20 subset, so the marker has somewhere to render. */
export const RULE_OF_LAW = summary({
  id: 'aaaaaaa1-0000-4000-8000-000000000002',
  number: 12,
  prompt: 'What is the rule of law?',
  categoryId: CATEGORY_DEMOCRACY.id,
  seniorEligible: true,
});

/** Three simultaneously accepted answers — the multi-slot case. */
export const ONE_BRANCH = summary({
  id: 'aaaaaaa1-0000-4000-8000-000000000003',
  number: 13,
  prompt: 'Name one branch or part of the government.',
  categoryId: CATEGORY_SYSTEM.id,
  seniorEligible: true,
});

/** `state` scope — the question the whole `state_required` path hangs on. */
export const YOUR_GOVERNOR = summary({
  id: 'aaaaaaa1-0000-4000-8000-000000000004',
  number: 43,
  prompt: 'Who is the Governor of your state now?',
  categoryId: CATEGORY_SYSTEM.id,
  dynamicScope: 'state',
});

export const COLONIES = summary({
  id: 'aaaaaaa1-0000-4000-8000-000000000005',
  number: 64,
  prompt: 'There were 13 original states. Name three.',
  categoryId: CATEGORY_COLONIAL.id,
});

export const QUESTIONS: CivicsQuestionSummary[] = [
  SUPREME_LAW,
  RULE_OF_LAW,
  ONE_BRANCH,
  YOUR_GOVERNOR,
  COLONIES,
];

const detail = (
  question: CivicsQuestionSummary,
  category: CivicsCategory,
  extra: Partial<CivicsQuestionDetail>,
): CivicsQuestionDetail => ({
  ...question,
  category,
  answerResolution: 'resolved',
  resolvedForStateCode: null,
  verifiedAt: VERIFIED_AT,
  answers: [],
  ...extra,
});

export const SUPREME_LAW_DETAIL = detail(SUPREME_LAW, CATEGORY_DEMOCRACY, {
  answers: [
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000001',
      text: 'the Constitution',
      sort: 0,
      stateCode: null,
      verifiedAt: VERIFIED_AT,
      sourceNote:
        'USCIS, Civics (History and Government) Questions for the Naturalization Test',
    },
  ],
});

export const RULE_OF_LAW_DETAIL = detail(RULE_OF_LAW, CATEGORY_DEMOCRACY, {
  answers: [
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000002',
      text: 'Everyone must follow the law.',
      sort: 0,
      stateCode: null,
      verifiedAt: VERIFIED_AT,
      sourceNote: 'USCIS, Civics (History and Government) Questions',
    },
  ],
});

export const ONE_BRANCH_DETAIL = detail(ONE_BRANCH, CATEGORY_SYSTEM, {
  verifiedAt: VERIFIED_AT_LATER,
  answers: [
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000003',
      text: 'Congress',
      sort: 0,
      stateCode: null,
      verifiedAt: VERIFIED_AT_LATER,
      sourceNote: 'USCIS, Civics (History and Government) Questions',
    },
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000004',
      text: 'the President',
      sort: 1,
      stateCode: null,
      verifiedAt: VERIFIED_AT,
      sourceNote: 'USCIS, Civics (History and Government) Questions',
    },
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000005',
      text: 'the courts',
      sort: 2,
      stateCode: null,
      verifiedAt: VERIFIED_AT,
      sourceNote: 'USCIS, Civics (History and Government) Questions',
    },
  ],
});

/** The `state`-scope question RESOLVED, for a learner whose plan names California. */
export const GOVERNOR_RESOLVED = detail(YOUR_GOVERNOR, CATEGORY_SYSTEM, {
  resolvedForStateCode: 'CA',
  answers: [
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000006',
      text: 'Jane Q. Doe',
      sort: 0,
      stateCode: 'CA',
      verifiedAt: VERIFIED_AT,
      sourceNote: 'State of California, Office of the Governor',
    },
  ],
});

/**
 * The same question for a learner with NO state on their plan.
 *
 * `answers` is deliberately NON-EMPTY and `verifiedAt` deliberately set — see
 * the file header. The server never sends this; the fixture does, so the test
 * asserts that `answerResolution` wins over whatever else arrived.
 */
export const GOVERNOR_STATE_REQUIRED: CivicsQuestionDetail = {
  ...GOVERNOR_RESOLVED,
  answerResolution: 'state_required',
  resolvedForStateCode: null,
};

export const COLONIES_DETAIL = detail(COLONIES, CATEGORY_COLONIAL, {
  answers: [
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000007',
      text: 'New Hampshire',
      sort: 0,
      stateCode: null,
      verifiedAt: VERIFIED_AT,
      sourceNote: 'USCIS, Civics (History and Government) Questions',
    },
    {
      id: 'bbbbbbb1-0000-4000-8000-000000000008',
      text: 'Massachusetts',
      sort: 1,
      stateCode: null,
      verifiedAt: VERIFIED_AT,
      sourceNote: 'USCIS, Civics (History and Government) Questions',
    },
  ],
});

/** Every detail this suite can serve, by question id. */
export const DETAILS: Record<string, CivicsQuestionDetail> = {
  [SUPREME_LAW.id]: SUPREME_LAW_DETAIL,
  [RULE_OF_LAW.id]: RULE_OF_LAW_DETAIL,
  [ONE_BRANCH.id]: ONE_BRANCH_DETAIL,
  [YOUR_GOVERNOR.id]: GOVERNOR_RESOLVED,
  [COLONIES.id]: COLONIES_DETAIL,
};

export interface CivicsHandlerOptions {
  categories?: CivicsCategory[];
  questions?: CivicsQuestionSummary[];
  details?: Record<string, CivicsQuestionDetail>;
  /** Called with every question-list request, so a test can inspect the query. */
  onListRequest?: (url: URL) => void;
}

/**
 * MSW handlers for the three civics read routes.
 *
 * The list handler PAGINATES AND FILTERS FOR REAL rather than echoing a canned
 * page: `categoryId` and `page`/`pageSize` are the two things the page has to
 * get right, and a handler that ignored them would pass a component that
 * ignored them too.
 */
export function civicsHandlers(options: CivicsHandlerOptions = {}) {
  const categories = options.categories ?? CATEGORIES;
  const questions = options.questions ?? QUESTIONS;
  const details = options.details ?? DETAILS;

  return [
    http.get(`${API_BASE}/civics/versions/:code/categories`, () =>
      HttpResponse.json({ data: categories }),
    ),

    http.get(`${API_BASE}/civics/questions`, ({ request }) => {
      const url = new URL(request.url);
      options.onListRequest?.(url);

      const categoryId = url.searchParams.get('categoryId');
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');

      const matching = categoryId
        ? questions.filter((question) => question.categoryId === categoryId)
        : questions;

      return HttpResponse.json({
        data: {
          items: matching.slice((page - 1) * pageSize, page * pageSize),
          total: matching.length,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(matching.length / pageSize)),
        },
      });
    }),

    http.get(`${API_BASE}/civics/questions/:id`, ({ params }) => {
      const found = details[String(params.id)];
      return found
        ? HttpResponse.json({ data: found })
        : HttpResponse.json({ message: 'Not found' }, { status: 404 });
    }),
  ];
}

/** `GET /api/journey/profile`, which the global handlers deliberately omit. */
export function journeyProfileHandler(profile: JourneyProfile) {
  return http.get(`${API_BASE}/journey/profile`, () =>
    HttpResponse.json({ data: profileResponse(profile) }),
  );
}
