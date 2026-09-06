# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release checklist: realtime and voice code

This repository has no separate release-procedure document, so this note
lives here — the place a release's own entry is already written, and
therefore the one place a person compiling that entry cannot miss it.

**Before any release whose diff touches voice or realtime code** —
`apps/api/src/ai/providers/`'s `transcribe`/`synthesize`/`createRealtimeSession`
paths, anything under `apps/api/src/interviews/realtime/` **or
`apps/api/src/practice/realtime/`** (added by E15, epic #345), or
`apps/web/src/services/realtimeConnection.ts` **or
`apps/web/src/hooks/useRealtimePractice.ts`/`useConversationSession.ts`**
— run the manual verification checklist in
[`docs/specs/realtime-interview.md`](docs/specs/realtime-interview.md) §11:
eight numbered items (barge-in in both directions, end-to-end latency, the
end control under load, mid-session device switching, microphone denial,
network loss, and secret expiry), each with its own pass criterion, run by a
person against a real deployment, a real browser, and a real microphone. No
suite in this codebase automates it, by design — §10 of that same document
states why honestly rather than pretending otherwise — so this checklist is
the only thing standing between a barge-in regression and a shipped release.
`docs/specs/realtime-practice.md` §12 confirms this is the identical
physical checklist for practice's own realtime transport, reused rather than
duplicated, plus one practice-specific addition: confirming the
**mid-session fallback** actually speaks its notice and resumes on the same
session id with no lost progress.

**Record the result as a line in that release's own entry below**: pass/fail
per item, who ran it, and when. A release note that changes realtime or
voice code with no corresponding checklist line is incomplete, not merely
undocumented — the identical standard `docs/specs/realtime-interview.md`
§11 already states for this exact rule.

## [Unreleased]

### Added

- **Conversation mode — hands-free spoken practice (E13, epic #304).** A
  session-wide `Text | Voice` control on a practice session: with `Voice`
  selected, tapping **Start hands-free** arms a persistent microphone
  stream, a calibrated voice-activity detector (with barge-in — talking
  over a question cancels it and starts listening), synthesised earcons,
  and a screen wake lock, and the app reads each question, listens for the
  spoken answer, grades it, speaks the accepted answer, and moves on with
  no further taps. `voice.conversationMode` (issue #307, `false` by
  default) is the seventh field on the existing `voice` user-settings
  namespace; turning it on only decides which mode a session *loads* with
  — a learner still taps **Start hands-free** to arm the loop, so the
  preference buys one tap instead of two, never a zero-tap session.
  Fixed as a side effect: `voice.readQuestionsAloud` is now actually
  honoured (`QuestionAudio`'s `autoPlay` prop was resolved but never wired
  to the practice page's mount), and `QuestionAudio` now exposes an
  `onFinished` callback and a `stop()` handle so a caller can tell when
  playback ends and cancel it mid-read. No API route or permission string
  was added. See
  [`docs/specs/conversation-mode.md`](docs/specs/conversation-mode.md).

**Manual microphone checklist: not run, for either E12 or E13.**
`ROADMAP.md`'s own E12 footnote already records that a person has not run
E12's real-microphone verification against a real deployment — that gap
is restated here, not newly discovered. E13 has the identical gap, and
this entry is where issue #315 asked it to be recorded: this environment
has no microphone, no Docker daemon, and no compose stack, so nobody ran
`docs/specs/conversation-mode.md` §16's acoustic checklist for this
release either — what follows is not a defect list but a record of what a
later reader should not assume was verified:

1. Ambient-floor VAD calibration on a quiet room versus a noisy or windy
   one — unverified against real audio.
2. Deliberate barge-in (talking over a question mid-read) versus ambient
   noise not falsely triggering it — unverified against a real speaker and
   a real microphone.
3. The ~8 s onset timeout and the spoken re-listen nudge it triggers on
   silence — unverified end to end.
4. A full one-tap session, start to finish, on a real device — not run.

What *was* run: the state-machine unit tests
(`useConversationSession.test.ts`, `useVoiceActivity.test.ts`,
`useWakeLock.test.ts`, `PracticeSessionPage.conversation.test.tsx`), which
drive the detector and the driver against synthetic level sequences — a
real test of the logic, and, honestly, not a test of whether the
calibration copes with a real windy street, exactly as
`docs/specs/conversation-mode.md` §16 says of itself. Issue #314
(PR #342, commit `ae7821e`) closed the acceptance-journey gap by adding
five conversation-mode scenarios to `tests/e2e/specs/voice.spec.ts`: the
one-tap Quick 5 journey, asserting an instrumented tap count of exactly
one; barge-in over the question cancelling playback and starting
recording; a wrong answer re-listened to exactly once, with a second miss
moving on; "Type instead" reachable from all five phases, parameterised
into five generated tests; and a mic-permission denial exiting the loop
with a spoken and a rendered reason. Like `civics-learn.spec.ts` before it
(`ROADMAP.md` §3's E2 footnote), these five were written and registered
but never executed: this environment has no Docker daemon and no compose
stack, and `tests/e2e` is not run by CI. What was independently verified
is that `tsc --noEmit -p tests/e2e/tsconfig.json` is clean and
`npx playwright test --list` registers all five (57 tests across 13
files).

#314 also added Vitest coverage for cross-hook composition, the retry
budget as a property, and unmount in every state (+28 tests; the web
suite is now 151 files / 3024 passed / 3 skipped, up from a 2996
baseline), and introduced one **test-only** product seam in
`PracticeSessionPage.tsx` for the VAD level source, gated on
`import.meta.env.PROD` exactly as `App.tsx` gates `TestLoginPage` — a
production build eliminates it.

- **A coach whose voice a learner chooses (E14, epic #305).** Four
  personas — `supportive` (the default; exactly today's voice, unchanged
  for anyone who never opens the setting), `academic`, `playful`, and
  `unfiltered` (opt-in only, never suggested) — colour the grader's
  feedback, the tutor's civics explanation, and a new short reaction line
  shown after most practice attempts. `GET /api/ai/coach/personas` lists
  the four voices; `coach.persona` and `coach.reactions` (Settings →
  Coach) are the new user-settings fields. No persona ever changes a
  verdict, an accepted answer, or a readiness figure — a seven-rule
  invariant floor, unchanged across all four voices, forbids commenting on
  a learner's English, their origin or status, or their odds of becoming a
  citizen, on every persona including `unfiltered`. See
  [`docs/specs/coach-personality.md`](docs/specs/coach-personality.md) and
  [Choosing Your Coach](docs/choosing-your-coach.md).

  **On the reaction bank's content review, stated plainly rather than
  implied:** every line in `apps/api/src/ai/coach/reaction-lines.ts`,
  `unfiltered`'s included, was written and read against the invariant floor
  by Claude (Anthropic's coding agent), working at the repository owner's
  direction and under his standing authorization to merge without his own
  review — not by an independent human reviewer. An automated banned-topic
  lint runs over every shipped line as part of the test suite and fails
  the build on a match; that check is real and enforced today. A human
  read of the bank — `unfiltered`'s lines specifically — has not happened
  and is recommended before this feature reaches a public release.

  **The bank was deepened from 123 lines to 648 (issue #352, epic #345),
  and the attestation above covers the new lines exactly as it covers the
  old ones:** all 525 additions were written by Claude and read back by
  Claude against the same invariant floor, with no human review of any of
  them. Every one passes the same automated banned-topic lint, which now
  also enforces a depth floor tied to `MAX_PLANNED_COUNT` (twenty lines per
  `answer.*` cell, so a full twenty-question session can never be forced to
  repeat a line) and global uniqueness across the whole bank. The same
  issue lit up the three `session.complete_*` cells, which had been
  computed and served since #320 and rendered by nothing: a completed
  session's `coachReaction` is now shown on the practice summary and, in
  Voice mode, spoken as the session's closing turn.

- **Live, full-duplex voice practice, and a spoken turn that finally says
  whether you were right (E15, epic #345).** The epic's own acceptance
  sentence: a learner completes a practice session by voice, on a phone or
  a laptop, hearing whether each answer counted and why, in their chosen
  coach's voice.

  - **The spoken turn (issues #351, #352).** `composeSpokenTurn`
    (`apps/api/src/practice/spoken-turn.ts`) replaces the single line the
    hands-free loop used to speak after grading — `acceptedAnswers[0].text`
    and nothing else, which made a right answer and a wrong answer
    byte-identical audio — with an ordered sequence: what was heard (on a
    miss only), the verdict, the grader's reason (only when one ran), the
    accepted answer (on a miss or a skip, never a correct answer), and the
    coach's persona line, with the accepted answer deferred past an armed
    retry so the retry is never a repeat-after-me. Reaches the wire as
    `spokenTurn: string[]` / `retryBoundary: number | null` on an attempt
    and on a completed session's summary. `composeSessionClosingTurn`
    speaks the three `session.complete_*` reaction cells E14 lit up but
    nothing rendered.
  - **A live voice transport (issues #353, #354, #355, #356), alongside
    E13's request/response loop rather than replacing it.** `realtime`
    joins `tutor`/`grader`/`transcribe`/`speak` as a sixth AI model role,
    `wired: true`, capability `'realtime'` — optional, and, like
    `transcribe`/`speak`, never affecting `systemReady`. Bound, the
    session-wide `Voice` control opens a full-duplex conversation over
    `POST /api/practice/sessions/{id}/realtime-session` (a short-lived
    client secret) and `POST /api/practice/sessions/{id}/realtime/tool-calls`
    (`next_question` / `grade_answer` / `repeat_question` /
    `skip_question` / `end_session`); `grade_answer` records the identical
    `practice_attempts` row, column for column, that the ordinary attempt
    route would, verified by an equivalence test that drives both
    transports against one pinned clock and compares the two writes as
    whole objects. Unbound, or a live connection failed or dropped past its
    bounded reconnect attempts, `Voice` falls back to E13's loop instead —
    spoken aloud, with no attempt or progress lost, because none of it was
    ever held in the browser. `VoiceSurface` (#356) replaces roughly 300
    lines of bespoke per-transport markup on `PracticeSessionPage.tsx`
    with one full-screen component shared by both loops: one `h1`, one
    live region, and the two controls a learner must always be able to
    reach (Stop, Type instead) never scrolled off a small viewport.
    `resolveVoiceTransport` is the one function that decides the ladder;
    `useRealtimePractice` is the one hook that opens exactly one
    `getUserMedia` stream for the live transport.
  - **A learner starting Voice from `/practice` no longer has to find
    "Start hands-free" a second time (issue #350).** A fresh start carries
    a one-shot intent across the navigation and arms whichever transport
    the ladder resolves to the moment the session is ready — a genuinely
    zero-tap session from the picker's own tap forward. A **resumed**
    session (Recent sessions, or a reload) still requires the explicit
    Start tap, deliberately: a stored preference is not a fresh gesture.
  - **A preflight before the learner commits, not only a failure after
    (issue #349).** `useMediaReadiness` reads `navigator.permissions` and
    `enumerateDevices()` on mount — observationally, never prompting — so a
    microphone already blocked is shown on the session screen before Start
    is ever tapped, not discovered mid-walk. The honest new `preparing`
    phase (between the tap and the question) replaces a screen that used
    to claim "Asking you the question." while the permission dialogue was
    still open.
  - **Eight earcons on one phase-keyed table, and a learner's own switch
    to turn them off (issue #357).** `apps/web/src/lib/conversationCues.ts`
    derives every cue from the state machine's own transitions — adding a
    phase does not compile until every cell touching it has a decision,
    silence included — replacing three hand-placed calls that had left
    five edges (the tap, the question, the pause, both exits) silent.
    `voice.soundCues` (default `true`) is the eighth field on the `voice`
    namespace.
  - **No permission string, no migration.** Every route E15 adds is
    `@Auth()` with no permissions, for the identical reason every other
    practice route is; every settings field added (`soundCues`) follows
    the existing no-`.default()` namespace pattern. See
    [`docs/specs/realtime-practice.md`](docs/specs/realtime-practice.md),
    [`docs/specs/conversation-mode.md`](docs/specs/conversation-mode.md),
    and [`docs/runbooks/configuring-voice.md`](docs/runbooks/configuring-voice.md).

  **A real, live gap this epic's own closing test pass (issue #360) found
  rather than fixed, tracked as
  [issue #375](https://github.com/marinoscar/oathpath/issues/375):**
  `useConversationSession.ts`'s hands-free loop never adopted
  `attempt.spokenTurn` — it still speaks only the bare accepted answer, on
  every outcome, via the exact pre-#351 line `spoken-turn.ts`'s own header
  names as the original defect. `VoiceSurface`'s visual live region does
  render the full composed turn correctly (so a screen-reader user hears
  it), but the app's own `speechSynthesis` voice — what a learner walking
  with the phone in a pocket actually relies on — does not yet. Filed
  rather than fixed here, per issue #360's own scope (tests and docs only,
  no product code).

**Manual real-microphone checklist (E15, epic #345): not run, on the
identical basis E12's and E13's own footnotes above already state, restated
here rather than newly discovered.** This environment has no microphone, no
Docker daemon, and no compose stack — the same three absences that kept
`tests/e2e` from executing for the past two epics keep it from executing for
this one. Per the release-checklist note at the top of this file and
`docs/specs/realtime-practice.md` §12, what a person must still run against
a real deployment, a real browser, and a real microphone before this epic
ships to production:

1. Live voice's own barge-in and end-to-end latency, and the six other
   items on `docs/specs/realtime-interview.md` §11's checklist, reused
   verbatim (`realtime-practice.md` §12 states why this is the identical
   physical phenomenon, not a second checklist to write) — **not run.**
2. The mid-session fallback (§8 of that document) actually speaking its
   notice, on a real dropped connection, and actually resuming on the same
   session id with no lost progress — the one item that checklist has no
   analogue for — **not run.**
3. Conversation mode's own acoustic checklist (`docs/specs/conversation-mode.md`
   §16, the four items E12/E13's own footnote above already lists:
   ambient-floor calibration, deliberate barge-in versus ambient noise, the
   onset timeout and its spoken nudge, and a full one-tap session on a real
   device) — **still not run**, for the identical reason it was not run for
   E12 or E13; this epic changed no product code that would newly verify
   any of the four.
4. `voice.soundCues`'s eight earcons, actually audible and actually
   distinguishable from each other on a real speaker — **not run.**

**What *was* run for this epic:** the full API suite (`npm test`,
`--maxWorkers=2`) — 207 suites, 5,184 tests passed, 74 skipped, zero
failures — and the full web suite (`vitest run`, sharded) — 174 files,
3,478 tests passed, 3 skipped, zero failures — both against the baseline
this repository already carried, plus `tsc --noEmit` clean on both
workspaces. Issue #360 added: a property test asserting no two outcomes
(including a retry-armed miss) produce the same composed spoken turn; a
test asserting all four coach personas produce four different spoken turns
from an identical verdict; a test asserting the shared `AudioContext`
survives a switch to realtime voice and back as the same single instance;
and five Playwright scenarios extending `voice.spec.ts` — a one-tap
fresh-start journey, "Type instead" reachable from `preparing` (the sixth
of the now-seven `ConversationPhase` values), a microphone already blocked
shown before Start is ever tapped, the voice surface fitting 360×640 with
no document scroll, and (marked `test.fixme`, pending issue #375) a
correct answer and a spent-retry wrong answer NOT being byte-identical
audio. Like every Playwright spec in this repository, none of the five was
executed here — `tsc --noEmit -p tests/e2e/tsconfig.json` is clean, which
is the one thing about them this environment could actually confirm.

### Changed

- **Rebranded to OathPath.** The application, its CLI, its database and its
  observability identity all carried names inherited from the upstream
  template. `APP_NAME` is now `OathPath`, which renames the web wordmark and
  page title, the OpenAPI document and reference page, all email templates and
  the CLI banner from one constant. The CLI binary is `oathpath` (config in
  `~/.oathpath/`, environment variables prefixed `OATHPATH_`), the default
  database is `oathpath`, and the OpenTelemetry service is `oathpath-api`.

### Fixed

- **The installer and the API's own documentation pointed at a different
  repository.** `install.sh` defaulted to cloning `marinoscar/EnterpriseAppBase`
  and the OpenAPI contact and external-docs URLs pointed there too. That
  repository is live and has diverged, so `curl … | bash` installed the
  upstream template rather than this application.
- **Several identifiers had opted out of their own derivation scheme**, so
  renaming the binary would have left them stale with no error: the deploy
  state filename and version field, the journal filename prefix and its
  retention regex, and the nginx vhost ownership marker. All now derive from
  `CLI_NAME`.
- `trace.decorator.ts` hardcoded the OpenTelemetry service name and ignored
  `OTEL_SERVICE_NAME`, so configuring the name renamed the service everywhere
  except that tracer's instrumentation scope.

### Removed

- `apps/web/test-results.json`, a committed Vitest report holding absolute
  paths from another machine and references to deleted test files.

## [1.1.0] - 2026-06-10

### Changed

- **Dependencies**: Major upgrade across the stack — React 19, MUI 9, react-router 7, Vite 8, TypeScript 6 (web); Prisma 7 (now using the `@prisma/adapter-pg` driver adapter), zod 4 + nestjs-zod 5, Jest 30, @fastify/multipart 10, and OpenTelemetry updates (API). class-validator bumped to 0.15.1. NestJS remains on 11.x. Runtime is Node.js 22.

### Removed

- **CLI Tool**: Removed the `tools/app` cross-platform CLI and the `tools/*` workspace.

## [1.0.1] - 2026-01-24

### Added

- **CLI Storage Commands**: New storage commands for interacting with the storage API
  - File upload support with `storage upload` command
  - Interactive storage menu for browsing and managing files
- **CLI Sync Feature**: Full folder synchronization functionality
  - Sync database layer with better-sqlite3 for local state tracking
  - Sync engine for bidirectional folder synchronization
  - Sync commands (`sync push`, `sync pull`, `sync status`)
  - Interactive sync menu for easy sync management
- **API Improvements**: DatabaseSeedException for better seed-related error handling

### Fixed

- **Authentication**: Enhanced OAuth callback error logging for easier debugging
- **Authentication**: Improved error handling for missing database seeds
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in processing service
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in objects service
- **API**: Handle unknown error types in S3 storage provider
- **CLI**: Use ESM import for `existsSync` in sync-database module
- **Tests**: Convert ISO strings to timestamps for date comparison

### Changed

- **Database**: Squashed migrations into single initial migration
- **Infrastructure**: Added AWS environment variables to compose file

### Dependencies

- Added AWS SDK dependencies for S3 storage provider
- Added better-sqlite3 and related dependencies for CLI sync feature

### Documentation

- Added storage and folder sync documentation to CLI README

## [1.0.0] - 2026-01-24

### Initial Release

Enterprise Application Foundation - A production-grade full-stack application foundation built with React, NestJS, and PostgreSQL.

### Features

#### Authentication
- Google OAuth 2.0 with JWT access tokens and refresh token rotation
- Short-lived access tokens (15 min default) with secure refresh rotation
- HttpOnly cookie storage for refresh tokens

#### Device Authorization (RFC 8628)
- Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- Secure device code generation and polling
- Device session management and revocation

#### Authorization
- Role-Based Access Control (RBAC) with three roles:
  - **Admin**: Full access, manage users and system settings
  - **Contributor**: Standard capabilities, manage own settings
  - **Viewer**: Least privilege (default), manage own settings
- Flexible permission system for feature expansion

#### Access Control
- Email allowlist restricts application access to pre-authorized users
- Pending/Claimed status tracking for allowlist entries
- Initial admin bootstrap via `INITIAL_ADMIN_EMAIL` environment variable

#### User Management
- Admin interface for managing users and role assignments
- User activation/deactivation controls
- Allowlist management UI at `/admin/users`

#### Settings Framework
- System-wide settings with type-safe Zod schemas
- Per-user settings with validation
- JSONB storage in PostgreSQL

#### API
- RESTful API built with NestJS and Fastify (2-3x better performance than Express)
- Swagger/OpenAPI documentation at `/api/docs`
- Health check endpoints (liveness and readiness probes)
- Input validation on all endpoints

#### Frontend
- React 18 with TypeScript
- Material-UI (MUI) component library
- Theme support with responsive design
- Protected routes with role-based access
- Vite build tool with hot module replacement

#### CLI Tool
- Cross-platform CLI (`app`) for development and API management
- Device authorization flow for secure CLI authentication
- Interactive menu-driven mode and command-line interface
- Support for multiple server environments (local, staging, production)

#### Infrastructure
- Docker Compose configurations:
  - `base.compose.yml`: Core services (api, web, db, nginx)
  - `dev.compose.yml`: Development overrides with hot reload
  - `prod.compose.yml`: Production overrides with resource limits
  - `otel.compose.yml`: Observability stack
- Nginx reverse proxy for same-origin architecture
- PostgreSQL 16 with Prisma ORM
- Automated database migrations and seeding

#### Observability
- OpenTelemetry instrumentation for traces and metrics
- Uptrace integration for visualization (UI at localhost:14318)
- Pino structured logging
- OTEL Collector configuration included

#### Testing
- Backend: Jest + Supertest for unit and integration tests
- Frontend: Vitest + React Testing Library
- CI pipeline with GitHub Actions

### API Endpoints

#### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `GET /api/auth/me` - Get current user

#### Device Authorization
- `POST /api/auth/device/code` - Generate device code
- `POST /api/auth/device/token` - Poll for authorization
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/:id` - Revoke device session

#### Users (Admin only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/:id` - Get user by ID
- `PATCH /api/users/:id` - Update user

#### Allowlist (Admin only)
- `GET /api/allowlist` - List allowlisted emails
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/:id` - Remove from allowlist

#### Settings
- `GET /api/user-settings` - Get user settings
- `PUT /api/user-settings` - Update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Update system settings (Admin)

#### Health
- `GET /api/health/live` - Liveness probe
- `GET /api/health/ready` - Readiness probe

### Technical Stack
- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material-UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth)
- **Testing**: Jest, Supertest, Vitest, React Testing Library
- **Observability**: OpenTelemetry, Uptrace, Pino
- **Infrastructure**: Docker, Docker Compose, Nginx
