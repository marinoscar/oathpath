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
paths, anything under `apps/api/src/interviews/realtime/`, or
`apps/web/src/services/realtimeConnection.ts` — run the manual verification
checklist in
[`docs/specs/realtime-interview.md`](docs/specs/realtime-interview.md) §11:
eight numbered items (barge-in in both directions, end-to-end latency, the
end control under load, mid-session device switching, microphone denial,
network loss, and secret expiry), each with its own pass criterion, run by a
person against a real deployment, a real browser, and a real microphone. No
suite in this codebase automates it, by design — §10 of that same document
states why honestly rather than pretending otherwise — so this checklist is
the only thing standing between a barge-in regression and a shipped release.

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
