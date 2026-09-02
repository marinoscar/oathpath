import { expect, type Page } from '@playwright/test';

// =============================================================================
// practice-questions.ts — shared with issue #84 (E3) and issue #131 (E4)
// =============================================================================
//
// Two small, plain-`GET` lookups that answer the one question every practice
// spec eventually has to answer: "the server just handed me a question I did
// not choose — what does it actually say, and what does it accept?"
//
// Extracted out of `practice-session.spec.ts` (#84) when `ai-evaluation.spec.ts`
// (#131) needed the exact same lookups for the exact same reason: `PracticeService`'s
// selection is unseen-first with each group SHUFFLED
// (`practice.controller.ts`'s own Swagger description), so no spec can predict
// or pin which question a session serves, or in what order. Two structural
// choices make that a non-issue rather than a source of flakiness, and both
// live here rather than in either spec:
//
//   1. **Ask the server what it is currently asking**, via
//      {@link fetchNextQuestionId} — a plain, idempotent
//      `GET /api/practice/sessions/:id` using the session's own
//      `nextQuestion`. `PracticeSessionPage` renders no question id anywhere in
//      its DOM, so there is no selector that could recover this another way.
//   2. **Read the text to type off the ACTUAL question**, via
//      {@link fetchAcceptedAnswer} — `GET /api/civics/questions/:id`, exactly
//      what a prepared learner already knows. `PracticeQuestionDto` carries no
//      answer-shaped field (see that file's own compile-time proof), so this is
//      not scraping the practice page; it is the same public-exam-content read
//      `civics-learn.spec.ts` treats civics answers as.
//
// Both take `page.request` rather than a bare `fetch`, matching every other
// direct API call in this suite: requests through it read and write the
// BROWSING CONTEXT's cookie jar, so a call made this way behaves exactly like
// one the app itself would have made.
// =============================================================================

interface CivicsQuestionDetailResponse {
  data: {
    answerResolution: 'resolved' | 'state_required';
    answers: { id: string; text: string }[];
  };
}

interface PracticeSessionDetailResponse {
  data: {
    nextQuestion: { id: string } | null;
  };
}

/**
 * The question the session is CURRENTLY asking, straight from the API.
 *
 * A plain GET — `PracticeController.getSession`'s own description says a
 * completed/abandoned session aside, this never mutates anything — so calling
 * it here does not consume or advance the question `PracticeSessionPage` is
 * already showing.
 */
export async function fetchNextQuestionId(
  page: Page,
  authHeaders: Record<string, string>,
  sessionId: string,
): Promise<string> {
  const response = await page.request.get(
    `/api/practice/sessions/${sessionId}`,
    { headers: authHeaders },
  );
  expect(response.ok(), 'GET /api/practice/sessions/:id').toBe(true);
  const body = (await response.json()) as PracticeSessionDetailResponse;
  const questionId = body.data.nextQuestion?.id;
  if (!questionId) {
    throw new Error(
      `fetchNextQuestionId: session ${sessionId} reports no next question — ` +
        'the session finished sooner than the caller expected it to.',
    );
  }
  return questionId;
}

/**
 * That question's first accepted answer, read the way a prepared learner
 * already knows it — the PUBLIC civics content API, never anything a practice
 * page rendered.
 */
export async function fetchAcceptedAnswer(
  page: Page,
  authHeaders: Record<string, string>,
  questionId: string,
): Promise<string> {
  const response = await page.request.get(
    `/api/civics/questions/${questionId}`,
    { headers: authHeaders },
  );
  expect(response.ok(), 'GET /api/civics/questions/:id').toBe(true);
  const body = (await response.json()) as CivicsQuestionDetailResponse;
  const { answerResolution, answers } = body.data;
  if (answerResolution !== 'resolved' || answers.length === 0) {
    // Practice's own question selection (question-selection.ts) removes any
    // question it cannot resolve an answer for from every pool BEFORE a
    // session is created — a state-scope question for a learner with no state
    // set, for instance. Reaching this means that guarantee broke, which is
    // worth failing loudly for rather than silently typing nothing.
    throw new Error(
      `fetchAcceptedAnswer: question ${questionId} is not resolved ` +
        `(answerResolution: ${answerResolution}) — practice should never have ` +
        'selected a question it cannot grade.',
    );
  }
  return answers[0].text;
}
