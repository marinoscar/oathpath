import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_NAMES,
  findEmailTemplate,
  isEmailTemplateName,
  renderEmailTemplate,
  type EmailTemplateDataMap,
  type EmailTemplateName,
  type RenderedEmail,
} from './index';

// =============================================================================
// Email template registry — contract tests (issue #123, epic #109)
// =============================================================================
//
// #123 requires that EVERY template returns non-empty subject/html/text, and
// that requirement has to survive #128 adding three more templates without
// anybody remembering to extend this file by hand. So this suite loops over
// `EMAIL_TEMPLATE_NAMES` rather than naming `testEmail` directly, and the one
// place a new template *is* named explicitly — `SAMPLE_DATA` below — is typed
// so that registering a template without adding its sample payload here is a
// TypeScript compile error, not a silently-skipped test.
// =============================================================================

/**
 * One representative (and deliberately hostile) payload per registered
 * template. Typed as a total map over `EmailTemplateName`, so #128 adding
 * `'user.welcome'` to the registry without adding an entry here fails to
 * compile — the same "no half-registered template" guarantee `index.ts`
 * gives the registry itself, extended to this test file.
 */
const SAMPLE_DATA: { [K in EmailTemplateName]: EmailTemplateDataMap[K] } = {
  'test-email': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    providerKind: 'smtp',
    sentAt: new Date('2026-01-01T00:00:00.000Z'),
    triggeredBy: '"><img src=x onerror=alert(1)>',
    settingsUrl: 'https://app.example.com/admin/settings/email',
  },
  // #128's three real event templates. Each payload places the hostile
  // `<script>` fragment in a field the template renders into BOTH parts, and
  // the `onerror` fragment in a second escaped field, so the contract loop
  // below exercises escaping on every one of them rather than only on the
  // first field a template happens to interpolate.
  'user-welcome': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    recipientName: '"><img src=x onerror=alert(1)>',
    roles: ['viewer'],
    appUrl: 'https://app.example.com',
  },
  'allowlist-invitation': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    invitedBy: '"><img src=x onerror=alert(1)>',
    signInUrl: 'https://app.example.com/login',
  },
  'role-changed': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    previousRoles: ['admin'],
    currentRoles: ['"><img src=x onerror=alert(1)>'],
    changedAt: new Date('2026-01-01T00:00:00.000Z'),
    appUrl: 'https://app.example.com',
  },
  // Epic #56 / E7's three reminders. Unlike every payload above, these carry
  // NO free-text field at all — a goal in minutes, a question count, a streak
  // length, and an `appUrl` the layout puts through `safeUrl` — so there is no
  // field for a hostile fragment to travel in. That is why the escaping
  // assertion below skips them: it is gated on the payload actually carrying
  // the fragment, so a reminder that later gains a free-text field is covered
  // again the moment its sample payload here does.
  'practice-daily-reminder': {
    dailyGoalMinutes: 5,
    appUrl: 'https://app.example.com',
  },
  'practice-review-due': {
    reviewCount: 4,
    appUrl: 'https://app.example.com',
  },
  'streak-at-risk': {
    streakDays: 12,
    appUrl: 'https://app.example.com',
  },
};

/**
 * The tag-shaped fragment `SAMPLE_DATA` plants in every free-text field.
 *
 * Named once rather than repeated, because two of the assertions below are
 * about the SAME string appearing escaped in one part and raw in the other,
 * and a typo in one of the two copies would silently weaken the check.
 */
const HOSTILE_FRAGMENT = '<script>alert(document.cookie)</script>';

function render(name: EmailTemplateName): RenderedEmail {
  const template = EMAIL_TEMPLATES[name] as (data: unknown) => RenderedEmail;
  return template(SAMPLE_DATA[name]);
}

describe('email template registry — keys and functions agree', () => {
  it('EMAIL_TEMPLATE_NAMES is exactly the key set of EMAIL_TEMPLATES', () => {
    expect([...EMAIL_TEMPLATE_NAMES].sort()).toEqual(Object.keys(EMAIL_TEMPLATES).sort());
  });

  it('has at least one registered template', () => {
    expect(EMAIL_TEMPLATE_NAMES.length).toBeGreaterThan(0);
  });

  it('has no duplicate names', () => {
    expect(new Set(EMAIL_TEMPLATE_NAMES).size).toBe(EMAIL_TEMPLATE_NAMES.length);
  });

  it('every registered name maps to a callable renderer', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(typeof EMAIL_TEMPLATES[name]).toBe('function');
    }
  });

  it('SAMPLE_DATA (this test file) covers every registered name — a name missing here is a compile error, not a skipped test', () => {
    expect(Object.keys(SAMPLE_DATA).sort()).toEqual([...EMAIL_TEMPLATE_NAMES].sort());
  });
});

describe('email template registry — lookup helpers', () => {
  it('isEmailTemplateName is true for every registered name', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(isEmailTemplateName(name)).toBe(true);
    }
  });

  it('isEmailTemplateName is false for an unregistered or empty string', () => {
    expect(isEmailTemplateName('not-a-real-template')).toBe(false);
    expect(isEmailTemplateName('')).toBe(false);
  });

  it('findEmailTemplate returns the exact registered function for a known name', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(findEmailTemplate(name)).toBe(EMAIL_TEMPLATES[name]);
    }
  });

  it('findEmailTemplate returns undefined for an unknown name (never throws)', () => {
    expect(findEmailTemplate('decommissioned-template')).toBeUndefined();
  });

  it('renderEmailTemplate produces the same output as calling the registered function directly', () => {
    const data = SAMPLE_DATA['test-email'];
    expect(renderEmailTemplate('test-email', data)).toEqual(EMAIL_TEMPLATES['test-email'](data));
  });
});

describe.each(EMAIL_TEMPLATE_NAMES)('template contract: "%s"', (name) => {
  const rendered = render(name);

  it('returns a non-empty subject', () => {
    expect(typeof rendered.subject).toBe('string');
    expect(rendered.subject.trim().length).toBeGreaterThan(0);
  });

  it('returns non-empty html', () => {
    expect(typeof rendered.html).toBe('string');
    expect(rendered.html.trim().length).toBeGreaterThan(0);
  });

  it('returns non-empty text', () => {
    expect(typeof rendered.text).toBe('string');
    expect(rendered.text.trim().length).toBeGreaterThan(0);
  });

  it('subject carries no HTML markup', () => {
    expect(rendered.subject).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  // NOTE: this loop deliberately feeds hostile, tag-shaped data through
  // every template (see SAMPLE_DATA above), so a plain "text contains no
  // HTML tags" assertion here would fail on the raw payload text — and
  // *should* fail: a text/plain MIME part is never parsed as markup by any
  // mail client, so literal "<script>" characters in it are inert data, not
  // an injection, and `plainText` is correct NOT to escape them (see the
  // header comment above `plainText` in layout.ts). The generic
  // "plainText output contains no HTML tags" check belongs with BENIGN
  // content instead — see layout.spec.ts's dedicated `plainText` suite.
  //
  // What IS a genuine contract to pin here: the same hostile value appears
  // ESCAPED in the html part and VERBATIM (raw) in the text part. If a
  // future change accidentally started HTML-escaping the text part (turning
  // "<script>" into "&lt;script&gt;" for a human reading a text-only
  // client), that would be a readability regression this test would catch.
  //
  // GATED ON THE PAYLOAD ACTUALLY CARRYING THE HOSTILE FRAGMENT, and gated on
  // the DATA rather than on a hardcoded list of template names. Epic #56 / E7's
  // three reminders render no free text at all — a goal in minutes, a question
  // count, a streak length — so there is no field for the fragment to travel
  // in, and asserting it appears in their output would be asserting something
  // untrue about a template that is structurally incapable of an injection.
  // Deriving the condition from `SAMPLE_DATA` keeps this automatic: a template
  // that gains a free-text field, and a sample payload that exercises it, is
  // covered again the moment the payload changes, with no edit here.
  const carriesHostileText = JSON.stringify(SAMPLE_DATA[name]).includes(
    HOSTILE_FRAGMENT,
  );

  (carriesHostileText ? it : it.skip)(
    'does not HTML-escape the text part (only the html part escapes; text is plain text, not markup)',
    () => {
      expect(rendered.html).not.toContain(HOSTILE_FRAGMENT);
      expect(rendered.html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
      expect(rendered.text).toContain(HOSTILE_FRAGMENT);
      expect(rendered.text).not.toContain('&lt;script&gt;');
    },
  );

  it('html has no <link>, no <style> block, and no external src=', () => {
    expect(rendered.html).not.toMatch(/<link\b/i);
    expect(rendered.html).not.toMatch(/<style\b/i);
    // Matches `src=` only inside an actual (unescaped) tag — e.g. `<img
    // src=...>` — not the literal substring "src=" that can legitimately
    // appear as ESCAPED text content (see the hostile sample payload above,
    // which contains "src=x" as inert, HTML-escaped text).
    expect(rendered.html).not.toMatch(/<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\bsrc\s*=/i);
  });

  it('html is table-based', () => {
    expect(rendered.html).toMatch(/<table\b/i);
  });

  it('escapes the hostile sample data — no raw <script> or unescaped onerror= handler in the rendered html', () => {
    expect(rendered.html).not.toContain(HOSTILE_FRAGMENT);
    expect(rendered.html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
