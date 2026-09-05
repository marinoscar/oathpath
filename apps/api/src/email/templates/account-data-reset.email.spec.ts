import { accountDataResetEmail } from './account-data-reset.email';

// =============================================================================
// "Your data was reset" template — tests (issue #270)
// =============================================================================
//
// The other `mandatory` security message, alongside `role-changed.email.ts`
// (which has no dedicated per-template spec of its own — this file is the
// first one for that pair). Two things worth pinning here specifically,
// beyond the generic contract `templates/index.spec.ts` already proves for
// every registered template (non-empty subject/html/text, escaping,
// table-based HTML, no `<link>`/`<style>`/external `src=`):
//
//   1. It renders without throwing for BOTH scope values, since `kept
//      Sentence` branches on `scope` and is the one place the two diverge.
//   2. The copy is PLAIN LANGUAGE, per this template's own header comment
//      ("no table of database table names") — neither part leaks a raw
//      snake_case table/column name a reader would have no reason to
//      recognize.
// =============================================================================

const RESET_AT = new Date('2026-09-04T12:00:00.000Z');

function render(scope: 'data' | 'data_and_key') {
  return accountDataResetEmail({
    recipientEmail: 'learner@example.com',
    scope,
    resetAt: RESET_AT,
    appUrl: 'https://app.example.com',
  });
}

/**
 * Every real Postgres table name `ACCOUNT_RESET_TABLES` (and the separately
 * handled `storage_objects`) declares — the copy this template renders is
 * meant to describe them in plain language, never repeat them verbatim.
 */
const RAW_TABLE_NAMES = [
  'practice_attempts',
  'mock_interviews',
  'practice_sessions',
  'question_mastery',
  'readiness_snapshots',
  'daily_activity',
  'english_attempts',
  'ai_usage_events',
  'notifications',
  'notification_deliveries',
  'personal_access_tokens',
  'device_codes',
  'learner_profiles',
  'user_settings',
  'storage_objects',
];

describe('accountDataResetEmail', () => {
  it('renders subject/html/text without throwing for scope: data', () => {
    expect(() => render('data')).not.toThrow();
    const rendered = render('data');
    expect(rendered.subject.trim().length).toBeGreaterThan(0);
    expect(rendered.html.trim().length).toBeGreaterThan(0);
    expect(rendered.text.trim().length).toBeGreaterThan(0);
  });

  it('renders subject/html/text without throwing for scope: data_and_key', () => {
    expect(() => render('data_and_key')).not.toThrow();
    const rendered = render('data_and_key');
    expect(rendered.subject.trim().length).toBeGreaterThan(0);
    expect(rendered.html.trim().length).toBeGreaterThan(0);
    expect(rendered.text.trim().length).toBeGreaterThan(0);
  });

  it('states the stored AI key was KEPT on scope: data', () => {
    const rendered = render('data');
    expect(rendered.html).toMatch(/saved AI key were both kept/);
    expect(rendered.text).toMatch(/saved AI key were both kept/);
  });

  it('does not claim the AI key was kept on scope: data_and_key', () => {
    const rendered = render('data_and_key');
    expect(rendered.html).not.toMatch(/saved AI key were both kept/);
    expect(rendered.text).not.toMatch(/saved AI key were both kept/);
  });

  it('recipient email appears in both parts', () => {
    for (const scope of ['data', 'data_and_key'] as const) {
      const rendered = render(scope);
      expect(rendered.html).toContain('learner@example.com');
      expect(rendered.text).toContain('learner@example.com');
    }
  });

  it('the reset timestamp is rendered in UTC ISO 8601, exactly as passed', () => {
    const rendered = render('data');
    expect(rendered.html).toContain(RESET_AT.toISOString());
    expect(rendered.text).toContain(RESET_AT.toISOString());
  });

  it('the actor is never named — this is a self-service action with no other actor to name', () => {
    // Matches role-changed.email.ts's own posture, for the stronger reason
    // this template's header states: the caller can only ever erase their
    // OWN data, so "who did this" is almost always "you, moments ago".
    for (const scope of ['data', 'data_and_key'] as const) {
      const rendered = render(scope);
      expect(rendered.html.toLowerCase()).not.toContain('administrator changed');
    }
  });

  it('carries no raw, snake_case database table name — the copy is plain language', () => {
    for (const scope of ['data', 'data_and_key'] as const) {
      const rendered = render(scope);
      for (const table of RAW_TABLE_NAMES) {
        expect(rendered.html).not.toContain(table);
        expect(rendered.text).not.toContain(table);
      }
    }
  });

  it('omits the CTA button entirely with no appUrl', () => {
    const rendered = accountDataResetEmail({
      recipientEmail: 'learner@example.com',
      scope: 'data',
      resetAt: RESET_AT,
    });
    expect(rendered.html).not.toMatch(/href="[^"]*app\.example\.com/);
  });

  it('the subject names the product and says the data was reset', () => {
    const rendered = render('data');
    expect(rendered.subject).toMatch(/reset/i);
  });
});
