// =============================================================================
// OpenAPI tag taxonomy (issue #53)
// =============================================================================
//
// The single declaration of every `@ApiTags(...)` name used in this API, its
// human description, and which sidebar section it belongs to.
//
// The tag NAMES here were already consistent across the ten controllers, so
// unlike the rest of this pass nothing was renamed. What was missing is what
// this file adds: a description for each (an undescribed tag renders as a bare
// heading) and a grouping (an ungrouped tag renders outside every section).
//
// One rule this file exists to enforce: NO undeclared and NO orphaned tags. A
// tag used by a controller but not listed here would render with no description
// and land outside every group; a tag listed here but used by nobody would
// render an empty section. Both are failed assertions in
// `test/openapi/openapi-document.spec.ts` rather than something a reviewer has
// to notice.
//
// Ordering is deliberate: `TAG_GROUPS` is emitted as `x-tagGroups`, and the
// flattened tag order becomes the document's `tags` array, which is what a
// renderer falls back to when it has no group support.
// =============================================================================

export interface OpenApiTag {
  /** Must match the controller's `@ApiTags(...)` argument byte-for-byte. */
  name: string;
  /** One or two sentences. Rendered under the section heading in the sidebar. */
  description: string;
}

export interface OpenApiTagGroup {
  name: string;
  tags: OpenApiTag[];
}

/**
 * Sidebar sections, in render order.
 *
 * A group is a product area rather than a module boundary — `Allowlist` sits
 * with authentication because it gates sign-in, even though it is administered
 * from the same screen as `Users`.
 */
export const TAG_GROUPS: OpenApiTagGroup[] = [
  {
    name: 'Authentication & Access',
    tags: [
      {
        name: 'Authentication',
        description:
          'Google OAuth sign-in, access-token refresh, logout, and the current-user lookup. ' +
          'Start here: every other section assumes a bearer token obtained through one of these routes.',
      },
      {
        name: 'Device Authorization',
        description:
          'RFC 8628 device authorization grant — how a CLI or other browserless client obtains a ' +
          'token by showing the user a code to approve elsewhere, plus management of the resulting ' +
          'device sessions.',
      },
      {
        name: 'Personal Access Tokens',
        description:
          'Long-lived `pat_` bearer credentials for scripts and automation. A PAT carries the full ' +
          'permission set of the user that minted it and is accepted on every authenticated route.',
      },
      {
        name: 'Allowlist',
        description:
          'Pre-authorized email addresses. Access is allowlist-gated: an email absent from this list ' +
          'cannot complete OAuth sign-in at all. Admin only.',
      },
      {
        name: 'Test Authentication',
        description:
          'Token minting for automated tests. The module is registered only when ' +
          '`NODE_ENV !== "production"`, so these routes are absent from a production document entirely.',
      },
    ],
  },
  {
    name: 'Account & Settings',
    tags: [
      {
        name: 'Users',
        description:
          'User administration: listing, inspecting, activating and deactivating accounts, and ' +
          'assigning system roles. Admin only.',
      },
      {
        name: 'User Settings',
        description:
          'The calling user\'s own preferences, stored as a JSON document. Supports full replacement ' +
          '(`PUT`) and JSON Merge Patch (`PATCH`).',
      },
      {
        name: 'System Settings',
        description:
          'Deployment-wide configuration, stored as a JSON document. Readable by any signed-in user; ' +
          'writable only with `system_settings:write`.',
      },
      {
        name: 'Email Settings',
        description:
          'Mail transport configuration (SES or SMTP), the sender identity, and a test send that ' +
          'reports the provider\'s actual error so a misconfiguration can be diagnosed. Gated on ' +
          '`system_settings:read`/`:write`. The SMTP password is write-only: it is held in the ' +
          'encrypted credential store, is never returned, and submitting it empty preserves it.',
      },
      {
        name: 'AI',
        description:
          'Each user\'s **own** OpenAI key, and the availability gate the app reads on every ' +
          'navigation. All inference runs on the calling user\'s key, so each user sees and ' +
          'pays for their own consumption. Every route here resolves the credential from the ' +
          'authenticated session and **takes no user id** — nobody, administrators included, ' +
          'can read another user\'s key through this API.',
      },
      {
        name: 'AI Settings',
        description:
          'Server-side AI configuration: which provider, the master switch, and which model serves ' +
          'each role (`tutor`, `grader`, …). Gated on `system_settings:read`/`:write`. The server ' +
          'API key is write-only — it is held in the encrypted credential store, is never returned, ' +
          'and submitting it empty preserves it. This key populates the model catalog and proves ' +
          'connectivity; **inference runs on each user\'s own key**, under `AI`.',
      },
      {
        name: 'Notifications',
        description:
          'The registry of events this application can raise, and which channels each supports. ' +
          'Readable by any signed-in user, because every user renders their own notification ' +
          'preferences against it.',
      },
      {
        name: 'Civics Admin',
        description:
          'The dynamic civics answers an administrator maintains — the officeholder facts that ' +
          "change without the question changing (who is Speaker of the House, who is your state's " +
          'governor). Gated on `system_settings:read`/`:write`, reusing the settings permissions ' +
          'rather than adding a pair. A correction never edits an answer in place: the current ' +
          'row is closed and a new one opened, so an answer a learner was already graded against ' +
          'stays readable. Static answers are not administered here — they change through a ' +
          'reviewed content change. The learner-facing side of the same content is under ' +
          '`Civics`.',
      },
    ],
  },
  {
    name: 'Journey',
    tags: [
      {
        name: 'Journey',
        description:
          "The learner's own path to readiness: their profile (which civics test applies, " +
          'which state, when the interview is, what the daily goal is), the home screen\'s ' +
          'deterministic next action, and the eight-stage registry the UI renders progress ' +
          'against. Every route here resolves the learner from the authenticated session and ' +
          '**takes no user id** — nobody, administrators included, can read or write another ' +
          "learner's profile through this API. No permission gates any of it, because every " +
          'signed-in user owns their own journey.',
      },
      {
        name: 'Civics',
        description:
          'The versioned USCIS civics question bank a learner studies from: the two test ' +
          'versions, their categories, and the questions — each served with the answers that ' +
          'are correct **now** and **for this caller**, since some answers depend on which ' +
          "state they live in. Resolution reads the caller's own state from their learner " +
          'profile; **no route takes a state or a user id**, so nobody can be served another ' +
          "learner's answers. Read-only, and no permission gates it: this is the core study " +
          'material every signed-in learner needs.',
      },
      {
        name: 'Practice',
        description:
          'The practice loop: start a session, answer one question at a time without seeing ' +
          'the options, get an immediate verdict, and finish with a summary. Grading here is ' +
          '**deterministic** — exact match plus normalisation, with a self-mark escape hatch ' +
          'recorded distinctly so "I was right" is never indistinguishable from a real match. ' +
          'The question shape these routes return **carries no accepted answers**: they arrive ' +
          'only in the response to the attempt itself, because an answer already on the page ' +
          'turns recall into recognition. Every route resolves the learner from the ' +
          'authenticated session and takes no user id; another learner\'s session is a **404**, ' +
          'not a 403. No permission gates any of it — every signed-in learner owns their own ' +
          'attempts.',
      },
      {
        name: 'Progress',
        description:
          "Coverage and mastery, by category, for the caller's own resolved test version — " +
          "how much of the bank has been touched and how well each section is known, as " +
          "opposed to Practice's queue counts, which say what a session started right now " +
          'would select next. Read-only, and no permission gates it: every signed-in learner ' +
          'owns their own mastery data.',
      },
      {
        name: 'Interviews',
        description:
          'The mock interview: a rehearsal of the real USCIS interview, conducted turn by ' +
          'turn by an officer who greets the applicant, goes over the shape of their ' +
          'application without ever asking for a real answer to it, asks the civics ' +
          'questions, and closes. **The application decides; the model only speaks** — which ' +
          'question comes next, whether an answer was right, when the civics section stops ' +
          'and whether the learner passed are all computed from the caller\'s own test ' +
          'version row and the same grading ladder Practice uses; the model supplies only ' +
          'the officer\'s phrasing, and the question text is appended verbatim from the ' +
          'database so it can never be paraphrased or invented. **No feedback is returned ' +
          'until the interview is completed**: the real interview gives no per-question ' +
          'signal, and a rehearsal that does is coaching the learner to expect reassurance ' +
          'the actual event will never provide. **OathPath never asks for, collects, or ' +
          'stores real application answers**, and keeping the transcript of what the learner ' +
          'said is a per-interview choice that defaults to off. Every route resolves the ' +
          'learner from the authenticated session and takes no user id; another learner\'s ' +
          'interview is a **404**, not a 403. No permission gates any of it.',
      },
      {
        name: 'Readiness',
        description:
          'The eight-component readiness score: how ready the caller actually is for the ' +
          'interview, one number 0-100, a plain-English reason it may be structurally capped ' +
          "(no spoken-answer or mock-interview evidence yet), and the single next action " +
          'worth taking. Snapshots are computed lazily and persisted, never re-derived from ' +
          "underlying evidence that has since moved on, so a caller's history stays exactly " +
          'what it meant on the day it was written. Read-only, and no permission gates it: ' +
          'every signed-in learner owns their own readiness data.',
      },
      {
        name: 'Engagement',
        description:
          "The habit side of the product: the caller's daily goal, what they have actually " +
          'done today, their streak, and the freeze budget that protects it. A day counts ' +
          'when the goal was met **or** a freeze covered it, and every date here is a ' +
          "**local** calendar day in the learner's own timezone, not a UTC one. Streaks and " +
          'freezes answer "am I consistently doing the work" — they are **structurally not ' +
          'inputs to Readiness**, which answers the different question of whether the evidence ' +
          'shows the caller becoming prepared, and nothing here carries a score. Read-only ' +
          'from the caller\'s point of view, and no permission gates it: every signed-in ' +
          'learner owns their own engagement data.',
      },
    ],
  },
  {
    name: 'Storage',
    tags: [
      {
        name: 'Storage',
        description:
          'File objects: simple upload, resumable multipart upload, signed download URLs, metadata, ' +
          'and deletion. A caller sees only the objects they uploaded.',
      },
    ],
  },
  {
    name: 'Operations',
    tags: [
      {
        name: 'Health',
        description:
          'Liveness and readiness probes for orchestrators and load balancers. Public — a probe that ' +
          'needed a token could not report that authentication is down.',
      },
    ],
  },
];

/** Flattened, in group order. Emitted as the document's `tags` array. */
export const OPENAPI_TAGS: OpenApiTag[] = TAG_GROUPS.flatMap((group) => group.tags);

/** Emitted as `x-tagGroups`, the extension Scalar and Redoc read. */
export const OPENAPI_TAG_GROUPS = TAG_GROUPS.map((group) => ({
  name: group.name,
  tags: group.tags.map((tag) => tag.name),
}));
