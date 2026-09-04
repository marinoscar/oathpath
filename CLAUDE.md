# CLAUDE.md

This file provides guidance for AI assistants working on this codebase.

## Project Overview

OathPath — a React UI + Node API + PostgreSQL web application with OAuth authentication, RBAC authorization, and a flexible settings framework.

Product scope and vision live in `PRD.md` and `VISION.md`; this file describes the codebase.

## Technology Stack

- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material UI (MUI)
- **CLI**: TypeScript, Commander (subcommands) + ink (interactive menu)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth required)
- **Testing**: Jest + Supertest (backend), React Testing Library + Vitest (frontend), Vitest (CLI)
- **Observability**: OpenTelemetry, Uptrace, Pino structured logging
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Nginx (same-origin routing)

## Repository Structure

```
/
  apps/
    api/                    # Backend API
      src/
      test/
      prisma/
        schema.prisma
        migrations/
      Dockerfile            # API container (near its code)
    web/                    # Frontend React app
      src/
      src/__tests__/
      Dockerfile            # Web container (near its code)
    cli/                    # First-party command-line client (`oathpath`)
      src/
        commands/           # `login`, `api`, `config` subcommands
        tui/                # Interactive ink menu (real terminals only)
      README.md             # CLI usage, install, CI setup
  docs/                     # Documentation
  infra/                    # Infrastructure configuration
    compose/
      base.compose.yml       # Core services: api, web, nginx
      dev.compose.yml        # Development overrides (hot reload, volumes)
      prod.compose.yml       # Production overrides (resource limits)
      otel.compose.yml       # Observability: uptrace, clickhouse, otel-collector
      .env.example           # Environment variables template
    nginx/
      nginx.conf             # Nginx routing configuration
    otel/
      otel-collector-config.yaml   # OTEL Collector config
      uptrace.yml            # Uptrace configuration
  tests/e2e/                # Optional E2E tests
```

## MANDATORY: Issue-Driven Development (Traceability)

Every feature and bug fix MUST be tracked by a GitHub issue, filed **before** implementation planning is finalized (for features) or the fix starts (for bugs). This applies before any worktree or branch is created — traceability starts at the issue, not the code. Running `gh issue create` from inside the repo infers the target repository from the git remote automatically, so no repo owner/URL needs to be specified.

- **New feature**: Before finalizing an implementation plan, create (or confirm an existing) issue with `gh issue create --template feature_request.yml`. Fill in the real problem statement, proposed solution, affected component, and priority — not placeholder text.
- **Larger initiative**: If the work will span multiple features or sessions, file an Epic instead with `gh issue create --template epic.yml`. Child feature issues must reference the epic number in their body or task list.
- **Bug fix**: Before starting the fix, create (or confirm an existing) issue with `gh issue create --template bug_report.yml`. Fill in the description, reproduction steps, expected vs. actual behavior, component, and environment/logs if known. Do not file a duplicate if one already exists for the same bug — reuse it.
- **Link the work**: Reference the issue number in commit messages and/or the PR description (`Fixes #123` / `Relates to #123`), per the `.github/pull_request_template.md` convention.
- **Keep it current**: Update or close the issue as the corresponding PR resolves it, so issue state reflects real progress.
- **Scope**: This applies to feature and bug work specifically. Routine `chore`/`docs`/`refactor` commits don't each need their own tracking issue.

## MANDATORY: Worktree-Based Feature Development

Every feature or fix MUST be developed in a Git worktree. The main checkout stays on `main` at all times.

### Worktree Location & Naming
- All worktrees live under `worktrees/` in the repo root (git-ignored, never committed)
- Use **flat short names**: `worktrees/<short-name>` (e.g., `worktrees/add-export`, `worktrees/fix-auth-bug`)
- The branch name follows conventional format: `feat/<short-name>`, `fix/<short-name>`, etc.

### Workflow (Claude MUST follow)

**Starting feature work:**
0. Ensure a tracking issue exists, per [MANDATORY: Issue-Driven Development (Traceability)](#mandatory-issue-driven-development-traceability) above.
1. From the main checkout, create the worktree:
   ```bash
   git worktree add worktrees/<short-name> -b <type>/<short-name>
   ```
   Example: `git worktree add worktrees/add-export -b feat/add-export`
2. All development happens inside `worktrees/<short-name>/`
3. Commits follow all existing commit rules (see below)

**Finishing feature work:**
1. Ensure all changes are committed inside the worktree
2. Remove the worktree:
   ```bash
   git worktree remove worktrees/<short-name>
   ```
3. The branch remains for PR/merge

### Rules
- NEVER checkout feature branches in the main working directory
- NEVER work on features directly in the main checkout
- One worktree per feature branch (Git enforces this)
- If the worktree already exists for the requested feature, work inside it (don't recreate)

## MANDATORY: Claude Commit-Only Git Rules

Claude: these rules are **MANDATORY**. Follow them exactly.  
Your job is **only** to create clean, frequent commits while implementing the requested work.  
Assume the branch already exists and is checked out. Do **not** create branches or PRs.

---

### Core Commit Rules (MANDATORY)
1. **Commit early, commit often.** Do not leave large uncommitted change sets.
2. Each commit must be **small, coherent, and reviewable**.
3. **One intent per commit** (no “misc fixes” bundles).
4. **Do not include unrelated refactors** unless explicitly requested.
5. If you change behavior, you must add/adjust tests in the same commit or the next immediate commit.

---

### Commit Message Standard (MANDATORY: Conventional Commits)
Use this format:

`<type>(<scope>): <short imperative summary>`

Allowed types:
- `feat:` new functionality
- `fix:` bug fix
- `refactor:` internal change, no behavior change
- `test:` add/adjust tests only
- `docs:` documentation only
- `chore:` tooling, deps, formatting, build, CI

Scopes (pick one relevant area):
- `api`, `web`, `db`, `infra`, `auth`, `chat`, `ui`, `core`, `jobs`, `docs`, `tests`

Examples:
- `feat(chat): add permit search prompt builder`
- `fix(api): handle missing location gracefully`
- `test(api): cover permit filter edge cases`
- `chore(web): run formatter`

---

### Commit Cadence (MANDATORY)
Make commits at these checkpoints:

1) **Scaffold / wiring**
- New files, routes, handlers, basic plumbing (even if incomplete).
- Example: `feat(api): scaffold permit lookup endpoint`

2) **Core functionality**
- Implement the smallest working slice end-to-end.
- Example: `feat(core): implement permit filtering by location radius`

3) **Edge cases + validation**
- Input validation, error handling, fallback behavior.
- Example: `fix(api): validate lat/lng inputs and return 400`

4) **Tests**
- Unit/integration tests for the new behavior and critical edge cases.
- Example: `test(api): add coverage for location filter and empty results`

5) **Cleanup**
- Remove dead code, rename for clarity, small refactors strictly related to the change.
- Example: `refactor(core): extract permit query builder`

6) **Docs (if needed)**
- Only if the task requires it.
- Example: `docs(api): document permit endpoint parameters`

---

### What to Include / Exclude (MANDATORY)
#### Include
- Code + tests for the same feature area
- Minimal config changes needed to run/build/test
- Small, related refactors that reduce complexity for the feature

#### Exclude
- Repo-wide formatting changes unless required
- Dependency upgrades unless required
- Unrelated cleanup in neighboring modules

---

### Commit Command Sequence (MANDATORY)
Before committing:
1. `git status`
2. `git diff`
3. Stage intentionally:
   - `git add -p` (preferred) or `git add <files>`

Commit:
- `git commit -m "<type>(<scope>): <summary>"`

After commit:
- `git status`

Repeat until the next checkpoint is complete, then commit again.

---

### Handling Mixed Changes (MANDATORY)
If you accidentally made unrelated edits:
- Revert them before committing, or
- Split into separate commits (preferred). Only keep the unrelated commit if explicitly requested.

---

### If Tests Cannot Be Run (MANDATORY)
If you cannot run tests for a valid reason (missing env, tool not available):
- Still commit, but include a clear note in the commit body.

Example:
- Subject: `feat(api): implement permit search by address`
- Body: `Notes: tests not run (DB env not available).`

---

### Golden Rule (MANDATORY)
If the diff feels “big,” you waited too long. **Split the work and commit sooner.**

## MANDATORY: Settings UI Pattern

Every settings surface in this app — admin or per-user — is a **registry-driven
hub**, not a tab strip and not an ungoverned route. This was established by
epic #90 (issues #91–#96).

The rules below are self-contained, including the reasoning that makes each one
load-bearing. The worked examples in the codebase are the second half of the
documentation: `apps/web/src/config/adminSections.tsx` and
`userSettingsSections.tsx` (the registries),
`apps/web/src/components/settings/SettingsHub.tsx` (the shared hub), and
`apps/web/src/config/destinations.ts` (whose header explains the
three-gates-three-answers failure this pattern exists to prevent).

### Core Rules (MANDATORY)

1. **Every new settings page MUST be declared in a section registry.**
   Admin cards go in `apps/web/src/config/adminSections.tsx`
   (`ADMIN_SECTIONS`); per-user cards go in
   `apps/web/src/config/userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`).
   A route added without a registry entry is not acceptable — it is a route
   the hub, the Console rail, and the AppBar title resolver all disagree
   about, because none of the three has any way to know it exists.

2. **A settings page MUST NOT be added as a new tab on an existing settings
   page.** Tabs remain legitimate **inside** a single destination, but only
   for genuinely **parallel** content — two views of the same question. The
   live example is `apps/web/src/pages/Admin/UsersPage.tsx`, which keeps its
   two tabs (Users, Allowlist) on purpose: they are two views of one question
   ("who may use this application"), backed by two controllers, not a
   hierarchy. State the distinction precisely:
   - A **destination** gate (which registry card, which route) is about
     **reachability**.
   - A **tab** gate (inside one page) is about **content**.
   Conflating the two is the exact mistake epic #90 fixed:
   `SystemSettingsPage`'s three tabs (UI Settings, Feature Flags, Advanced
   JSON) were hierarchical content wearing a tab strip, not parallel content.

3. **The card's `permission` field MUST be the exact string the API
   controller enforces** — never invented, never approximated. Follow the
   real, verified mapping as the model:
   - `system_settings:read` / `system_settings:write` →
     `system-settings.controller.ts`
   - `users:read` → `users.controller.ts`
   - `allowlist:read` → `allowlist.controller.ts` (gates content **inside**
     the Users & Allowlist page, not the route — see rule 2's
     reachability-vs-content distinction)

4. **New settings surfaces MUST reuse the shared
   `apps/web/src/components/settings/SettingsHub.tsx` component.** Do not
   fork it, do not copy it. The worked example is `/settings`
   (`apps/web/src/pages/UserSettingsHubPage.tsx`): it is a 4-prop binding
   (`sections`, `hubKey`, `title`, `subtitle`) over the exact same component
   `/admin/settings` uses — nothing more.

5. **The five coupled breakpoint gates move together or not at all.** Never
   change one without checking all five:
   1. `Layout.tsx`'s `showRail` (`up('sm')`) — mounts/unmounts `NavigationRail`
   2. `BottomNav`'s own `down('sm')` self-gate
   3. `<main>`'s `pb: { xs: 10, sm: 3 }` in `Layout.tsx`
   4. `SettingsHub.tsx`'s `isCompactWindow` (`down('sm')`)
   5. `AppBar.tsx`'s `isCompactWindow` (`down('sm')`)

   The boundary is `sm` (600px), never `md` (900px) — gating at 900px hands
   the phone treatment to 600–899px tablets, foldables, and landscape
   phones.

   **There is deliberately no shared constant binding these five.** A
   `COMPACT_BREAKPOINT` would make them look coupled while doing nothing to
   keep them so: three of the five are not breakpoint comparisons at all
   (`<main>`'s padding is a responsive value, `BottomNav`'s gate is its own
   `down()`, and `showRail` is an `up()` where the others are `down()`), so a
   constant would cover the two that already agree and leave the three that
   actually drift. The real coupling is this list, and it is enforced by
   reading it.

Accessibility requirements for a settings page are the app-wide ones: a real
`<label>` on every control, a sensible heading order under the page's single
`h1`, visible focus, and any result or error in a region assistive technology
announces. `apps/web/src/pages/Admin/EmailSettingsPage.tsx` and
`AiSettingsPage.tsx` are the worked examples.

## Architecture Principles

1. **Separation of Concerns**: UI handles presentation only; API handles all business logic and authorization
2. **Same-Origin Hosting**: UI at `/`, API at `/api`, API reference at `/api/docs`
3. **Security by Default**: All API endpoints require authentication unless explicitly public
4. **API-First**: All business logic resides in the API layer

## Key Commands

```bash
# Setup: copy environment template
cp infra/compose/.env.example infra/compose/.env

# Start development (from infra/compose folder)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start development with observability (Uptrace UI at http://localhost:14318)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Start production mode
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up

# Run API tests
cd apps/api && npm test

# Run frontend tests
cd apps/web && npm test

# Generate Prisma client after schema changes
cd apps/api && npm run prisma:generate

# Create a new migration (development)
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name>

# Apply migrations (production)
cd apps/api && npm run prisma:migrate

# Note: Use npm scripts (prisma:*) instead of direct npx commands
# They automatically construct DATABASE_URL from individual env vars
```

## Service URLs (Development)

- **Application**: http://localhost:3535 (via Nginx)
- **API Reference (Scalar)**: http://localhost:3535/api/docs
- **Uptrace**: http://localhost:14318 (when otel stack running)

## Command-Line Client (`oathpath`)

`apps/cli` is the first-party CLI for this API (epic #110). It is a workspace
package (`--workspace=cli`) that is built from this monorepo and not published;
it logs in through the device authorization flow below, stores the resulting
personal access token, and exposes a single generic `api <method> <path>`
command so it does not go stale as endpoints are added or renamed.

Usage, install, flags, environment variables and CI setup are documented in
[`apps/cli/README.md`](apps/cli/README.md) — that file is the source of truth;
do not restate it here.

### Deploying to a VPS

VPS deployment (epic #168) lives entirely in this CLI as `oathpath deploy
doctor|install|update|status` — there is no separate deploy script or
Ansible playbook anywhere in this repo, and there shouldn't be. The design
(why it runs on the VPS with no SSH client in the CLI, why TLS is terminated
by a shared host proxy instead of per-app, why there's no `db` service, what
was rejected) is documented in full in
[`docs/specs/vps-deploy.md`](docs/specs/vps-deploy.md); the operator-facing
runbook — prerequisites, first login after install, troubleshooting — is
[`docs/deployment/vps.md`](docs/deployment/vps.md). The command reference
(flags, exit codes) is [`apps/cli/README.md`](apps/cli/README.md#deploying-to-a-server)
above. Don't restate any of that here; extend those three instead.

## API Endpoints (MVP)

### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `POST /api/auth/logout-all` - Logout from all devices
- `GET /api/auth/me` - Get current user

### Device Authorization (RFC 8628)
- `POST /api/auth/device/code` - Generate device code (Public)
- `POST /api/auth/device/token` - Poll for authorization (Public)
- `GET /api/auth/device/activate` - Get activation info
- `POST /api/auth/device/authorize` - Approve/deny device
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/{id}` - Revoke device session

### Users (Admin-only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/{id}` - Get user by ID
- `PATCH /api/users/{id}` - Update user (roles, activation)
- `PUT /api/users/{id}/roles` - Update user roles

### Settings
- `GET /api/user-settings` - Get current user's settings
- `PUT /api/user-settings` - Replace user settings
- `PATCH /api/user-settings` - Partial update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Replace system settings (Admin)
- `PATCH /api/system-settings` - Partial update system settings (Admin)

### Allowlist (Admin-only)
- `GET /api/allowlist` - List allowlisted emails (paginated, filterable)
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/{id}` - Remove email from allowlist

### Storage Objects
- `POST /api/storage/objects/upload/init` - Initialize resumable upload
- `GET /api/storage/objects/:id/upload/status` - Get upload progress
- `POST /api/storage/objects/:id/upload/complete` - Complete multipart upload
- `DELETE /api/storage/objects/:id/upload/abort` - Abort upload
- `POST /api/storage/objects` - Simple file upload
- `GET /api/storage/objects` - List objects (paginated)
- `GET /api/storage/objects/:id` - Get object metadata
- `GET /api/storage/objects/:id/download` - Get signed download URL
- `DELETE /api/storage/objects/:id` - Delete object
- `PATCH /api/storage/objects/:id/metadata` - Update metadata

### Personal Access Tokens
- `POST /api/pat` - Create a new personal access token
- `GET /api/pat` - List current user's tokens
- `DELETE /api/pat/{id}` - Revoke a token

### AI Configuration (Admin)
- `GET /api/ai-settings` - Get AI settings and masked server-key status
- `PUT /api/ai-settings` - Replace AI settings (write-only `apiKey`, blank preserves)
- `GET /api/ai-settings/models` - Classified model catalog + the model-role registry
- `POST /api/ai-settings/test` - Test the saved server configuration

### AI (Per User)
- `GET /api/ai/key` - Describe your own stored key (never the key)
- `PUT /api/ai/key` - Save or replace your own key
- `DELETE /api/ai/key` - Remove your own key
- `POST /api/ai/key/test` - Test your key's reachability, per role
- `GET /api/ai/status` - `userKeyConfigured` and `systemReady`, independently
- `GET /api/ai/usage` - Your own recorded usage (not a bill)

### Journey (Per User)
- `GET /api/journey/profile` - Your `learner_profiles` row, the civics test versions, and the state/territory list (lazily creates the row on first call)
- `PUT /api/journey/profile` - Merge-update your profile; orientation completion is server-inferred, never a client flag
- `GET /api/journey/home` - Stage, interview countdown, daily-goal placeholder and the one `nextAction` to render
- `GET /api/journey/stages` - The eight journey stages, in order, with their display copy

On the web, `RequireOrientation` (`apps/web/src/components/common/RequireOrientation.tsx`)
hard-blocks a learner who has not completed orientation. It chains **after**
`RequireAiKey` in `App.tsx` — a keyless, unoriented user is sent to
`/setup/ai-key` first — and shares the same three exemptions (the setup route
itself, logout, and the `/admin/*` subtree for a caller holding
`system_settings:read`). See
[`docs/specs/journey-shell.md`](docs/specs/journey-shell.md) §5.

### Civics (Per User, read-only)
- `GET /api/civics/versions` - Every civics test version (question/threshold counts, `contentHash`)
- `GET /api/civics/versions/{code}/categories` - A version's categories, in render order
- `GET /api/civics/questions` - Paginated question summaries, defaulting to the caller's own test version
- `GET /api/civics/questions/{id}` - One question with its answer(s) resolved for the caller's own state

All four are `@Auth()` with no permissions — civics content is core product
material every authenticated learner reads, and no route accepts a caller-supplied
user id or state code (resolution always reads the caller's own `learner_profiles`
row). See [`docs/specs/civics-content.md`](docs/specs/civics-content.md) §8.

### Civics (Per User, AI-generated)
- `POST /api/civics/questions/{id}/explain` - Stream (SSE) a tutor's explanation of one question's answer, grounded in the caller's own resolved answers, on the caller's own AI key

`@Auth()` with no permissions, for the same reason as the read routes above —
no user id or state code is ever an input. Unlike them it is a `POST` (it
carries an optional `focus` body field) and its response is
`text/event-stream`, not JSON: a `delta` frame per chunk, then exactly one
terminal frame (`done` / `unavailable` / `state_required` / `error`). See
[`docs/API.md`](docs/API.md#post-civicsquestionsidexplain) for the full frame
contract and [`docs/specs/ai-evaluation.md`](docs/specs/ai-evaluation.md) for
the dispatch and grounding design.

### Civics (Admin)
- `GET /api/civics/dynamic-answers` - `system_settings:read` — the `national`/`state` questions and their currently open answer(s)
- `PUT /api/civics/dynamic-answers` - `system_settings:write` — correct one answer slot (closes the open row, opens a new one; never an in-place edit)

Reused permissions, not invented — see [`docs/specs/civics-content.md`](docs/specs/civics-content.md)
§9 and [`docs/runbooks/updating-civics-content.md`](docs/runbooks/updating-civics-content.md).

### Practice (Per User)
- `POST /api/practice/sessions` - Start a session (`quick` or `category`); closes any existing `in_progress` session for the caller first
- `GET /api/practice/sessions` - List the caller's sessions, paginated, newest first
- `GET /api/practice/sessions/{id}` - Resume or review one session: its attempts so far and the next unanswered question
- `POST /api/practice/sessions/{id}/attempts` - Answer a question; graded by a two-rung ladder (deterministic match, then an AI grader on a miss) and recorded as one `practice_attempts` row
- `POST /api/practice/sessions/{id}/attempts/{attemptId}/self-mark` - Flip a recorded `incorrect`/`skipped` attempt to `correct` after revealing the accepted answer
- `POST /api/practice/sessions/{id}/complete` - Finish a session and compute its summary
- `GET /api/practice/queue` - Picker counts (due/weak/new-by-category/learning/mastered) from `mastery/selector.ts`'s own bucket rule, so they can never disagree with what starting a session right now would select

All seven are `@Auth()` with no permissions, and another learner's session
(or an attempt inside it) is a **404, not a 403**. See
[`docs/specs/practice-sessions.md`](docs/specs/practice-sessions.md) §10 and
[`docs/specs/memory-model.md`](docs/specs/memory-model.md) §5 (the queue
endpoint).

### Progress (Per User)
- `GET /api/progress/mastery` - Coverage and mastery by category, for the caller's own resolved test version

`@Auth()` with no permissions, no user-id parameter — every authenticated
learner owns their own mastery data. See
[`docs/specs/memory-model.md`](docs/specs/memory-model.md) §8.

### Readiness (Per User)
- `GET /api/readiness` - The caller's latest readiness snapshot; lazily computed (and persisted) if none exists yet, or if the latest is stale — an existing snapshot older than the caller's most recent `practice_attempts.answeredAt`
- `GET /api/readiness/history` - The caller's past snapshots, paginated, newest first — the trend line's data source

`@Auth()` with no permissions, and no route accepts a user id — every
authenticated learner owns their own readiness data, exactly as they own
their own learner profile, their own practice attempts, and their own
mastery rows. See
[`docs/specs/readiness-model.md`](docs/specs/readiness-model.md) §6.

### Engagement (Per User)
- `GET /api/engagement/summary` - The caller's daily goal, streak and freeze budget: today's counters, `streak.current`/`streak.longest`, and `freezes.remaining`/`freezes.max` — after this request's own settlement pass (freeze replenishment and gap coverage, both persisted, never merely computed)

`@Auth()` with no permissions, adds no permission strings, and for the same
reason as Journey/Practice/Progress/Readiness above: every authenticated
learner owns their own engagement data, exactly as they own their own
learner profile, their own practice attempts, and their own readiness
snapshots, and no route accepts a user id — `@CurrentUser('id')` is the
only source of one, so there is no "read another learner's streak"
permission to add in the first place. This is a **consistency** surface,
not a readiness one: `daily_activity`, streaks and freezes are structurally
not inputs to the readiness engine — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5.6 for what enforces that,
and [`docs/specs/habit-streaks.md`](docs/specs/habit-streaks.md) §4.6 for
the endpoint's full design.

### Interviews (Per User)
- `POST /api/interviews` - Start a mock interview; test version and senior accommodation resolved from `learner_profiles`, never the request; returns the officer's opening turn
- `POST /api/interviews/{id}/turns` - Submit the applicant's reply and stream (SSE) the officer's response; the engine decides the question, grade and stop, the `tutor` role only supplies the acknowledgement wording
- `POST /api/interviews/{id}/complete` - Finish the interview, compute the debrief, and trigger a readiness recompute; idempotent
- `GET /api/interviews` - List the caller's own interviews, newest first, paginated
- `GET /api/interviews/{id}` - Resume an in-progress interview or re-read a completed one's debrief

All five are `@Auth()` with no permissions, and no route accepts a user
id — every authenticated learner owns their own interview history exactly
as they own their own practice attempts, their own learner profile, and
their own readiness snapshots. Another learner's interview id is a **404,
not a 403**. See [`docs/specs/mock-interview.md`](docs/specs/mock-interview.md)
§12 and [`docs/API.md`](docs/API.md#interviews).

### Voice (Per User)
- `POST /api/ai/speech/transcribe` - Turn one recording into text on the caller's own AI key; nothing is graded and nothing is stored (multipart, capped at 10 MB / 120 seconds, both enforced before any provider call)
- `POST /api/ai/speech/synthesize` - Read one short piece of text aloud on the caller's own AI key; an optional premium upgrade over the browser's free `speechSynthesis`, never the only way to hear a question

Both are `@Auth()` with no permissions, and no route accepts a user id —
every authenticated learner practises with their own voice on their own
key, exactly as they own their own practice attempts and their own AI
credentials, and gating either route would leave a Viewer unable to
practise at all. Both responses are typed `ok`/`unavailable`/`failed`
discriminated unions, always HTTP 200 — never a 4xx/5xx for an AI reason,
the same posture every other AI surface in this codebase takes. Binding
either role is optional and never affects `systemReady`, which is a
statement about the `tutor`/`grader` text roles only; see
[`docs/specs/voice.md`](docs/specs/voice.md) §1 for the degradation rule and
[`docs/runbooks/configuring-voice.md`](docs/runbooks/configuring-voice.md)
for the operator-facing walkthrough. See
[`docs/specs/voice.md`](docs/specs/voice.md) §9-§10 and
[`docs/API.md`](docs/API.md#ai-speech).

### Health
- `GET /api/health/live` - Liveness check
- `GET /api/health/ready` - Readiness check (includes DB)

## RBAC Model

### Roles
- **Admin**: Full access, manage users and system settings
- **Contributor**: Standard capabilities, manage own settings
- **Viewer**: Least privilege (default), manage own settings

### Key Permissions
- `system_settings:read/write` - System settings access
- `user_settings:read/write` - User settings access
- `users:read/write` - User management
- `rbac:manage` - Role assignment
- `allowlist:read/write` - Allowlist management (Admin only)
- `storage:read` - Read object metadata, get download URLs (**not enforced**)
- `storage:write` - Upload, update metadata (**not enforced**)
- `storage:delete_any` - Admin: delete any object (enforced, delete only)

**No storage route is gated by a route guard.**
`apps/api/src/storage/objects/objects.controller.ts` is `@Auth()` with no
`permissions`, and that is deliberate: every authenticated user may act on
their own objects, so a `PermissionsGuard` there would reject the ordinary
case. Access control is a per-object decision made in
`apps/api/src/storage/objects/objects.service.ts`.

**Ownership governs read and write.** A user may read, download and update
metadata only on objects they uploaded — the `ForbiddenException` at the "You
do not own this upload" / "You do not have access to this object" checks. There
is **no admin bypass on those paths**, and `storage:read` / `storage:write` are
still **seeded, role-assigned, and read by nothing**: holding or lacking either
changes nothing about what a request can do, and a Viewer can upload today.
Whether those two should gate their routes or be removed is still open
(issue #199).

**`storage:delete_any` is enforced, for delete only.** A caller holding it may
delete an object they did not upload, so an abusive upload or a departed user's
files can be removed through the API. `delete()` takes its own resolver
(`getObjectForDelete`) rather than a flag on the `getObjectWithAuthCheck`
helper that every read and write path shares — threading the permission through
the shared helper would make it a read and write bypass in the same edit.
Widening it must therefore be a deliberate edit, and an integration test named
"storage:delete_any does not widen read or write" holds that line. A cross-user
delete is audited distinctly: the `storage:object:delete` row gains
`ownerUserId` and `overridePermission` in its `meta`, so an admin removing
someone else's data is attributable rather than indistinguishable from a
self-delete. A missing object still 404s for holder and non-holder alike.

**AI adds no permission strings.** Admin AI settings gate on
`system_settings:read`/`:write`; the per-user AI routes are `@Auth()` with no
permissions, because every authenticated user owns their own credentials — and
since a keyless user is hard-blocked, gating them would leave the gated role
unable to use the app at all.

**`AiDispatchService` (E4, epic #53) adds no controller and no permission
string of its own either.** It has no HTTP surface — it is called from inside
other services' code, never from a route it owns — so the grading ladder
inside `POST /api/practice/sessions/{id}/attempts` and
`POST /api/civics/questions/{id}/explain` inherit their own feature's
already-`@Auth()`-with-no-permissions gate rather than adding a second one.
See [`docs/specs/ai-evaluation.md`](docs/specs/ai-evaluation.md) §11.

**Journey adds no permission strings either, for the same reason.** All four
`/api/journey/*` routes are `@Auth()` with no permissions: every authenticated
user owns their own learner profile, and `RequireOrientation` hard-blocks an
unoriented learner, so gating these routes would leave the gated role unable
to clear the gate at all. No route accepts a user id — the caller is always
resolved from the authenticated session — so there is no "read/write any
learner's profile" permission to add in the first place. See
[`docs/specs/journey-shell.md`](docs/specs/journey-shell.md) §4.1 and §5.

**Practice adds no permission strings either, for the same reason.** All
seven `/api/practice/*` routes (including `GET /api/practice/queue`, E5) are
`@Auth()` with no permissions: every authenticated learner owns their own
practice attempts, exactly as they own their own learner profile and their
own AI key, and no route accepts a user id. See
[`docs/specs/practice-sessions.md`](docs/specs/practice-sessions.md) §10 and
[`docs/specs/memory-model.md`](docs/specs/memory-model.md) §5.

**Progress adds no permission strings either, for the same reason.** The one
`/api/progress/*` route, `GET /api/progress/mastery`, is `@Auth()` with no
permissions: every authenticated learner owns their own mastery data,
exactly as they own their own practice attempts, and no route accepts a user
id. See [`docs/specs/memory-model.md`](docs/specs/memory-model.md) §8.

**Readiness adds no permission strings either, for the same reason.** Both
`/api/readiness*` routes are `@Auth()` with no permissions: every
authenticated learner owns their own readiness data, exactly as they own
their own mastery rows and their own practice attempts, and no route accepts
a user id. See [`docs/specs/readiness-model.md`](docs/specs/readiness-model.md) §6.

**Engagement adds no permission strings either, for the same reason.** The
one `/api/engagement/*` route, `GET /api/engagement/summary`, is `@Auth()`
with no permissions: every authenticated learner owns their own engagement
data, exactly as they own their own readiness data and their own practice
attempts, and no route accepts a user id. See
[`docs/specs/habit-streaks.md`](docs/specs/habit-streaks.md) §4.6.

**Mock interview adds no permission strings either, for the same reason.**
All five `/api/interviews*` routes are `@Auth()` with no permissions: every
authenticated learner owns their own interview history, exactly as they
own their own practice attempts and their own readiness snapshots, and no
route accepts a user id — `@CurrentUser('id')` is the only source of one,
so there is no "read another learner's interview" permission to add in the
first place. See [`docs/specs/mock-interview.md`](docs/specs/mock-interview.md) §12.

**Voice adds no permission strings either, for the same reason.** Both
`/api/ai/speech/*` routes are `@Auth()` with no permissions: every
authenticated learner practises with their own voice on their own key,
exactly as they own their own AI credentials and their own practice
attempts, and no route accepts a user id — gating either route would leave
a Viewer, the default role, unable to practise at all. There is no "use
voice" privilege in this product's authorization model. See
[`docs/specs/voice.md`](docs/specs/voice.md) §10.

## Database Tables

- `users` - User accounts with profile info
- `user_identities` - OAuth provider identities (provider + subject)
- `roles` / `permissions` / `role_permissions` - RBAC
- `user_roles` - User-to-role assignments
- `system_settings` - Global app settings (JSONB)
- `user_settings` - Per-user settings (JSONB)
- `audit_events` - Action audit log
- `refresh_tokens` - JWT refresh tokens (hashed)
- `allowed_emails` - Allowlist for access control
- `device_codes` - Device authorization codes (RFC 8628)
- `storage_objects` - File metadata, status, storage references
- `storage_object_chunks` - Multipart upload chunk tracking
- `personal_access_tokens` - User-created long-lived API tokens (hashed)
- `ai_usage_events` - Per-user AI call records (token counts nullable: null means unknown, never zero)
- `learner_profiles` - One row per user: journey stage, interview date, state/test-version selection, daily goal, orientation completion (lazily created on first `GET /api/journey/profile`)
- `civics_test_versions` - Seeded civics test versions (question counts, pass thresholds); `learner_profiles.test_version_code` references it
- `civics_categories` - A test version's sections (e.g. "American Government"), in render order
- `civics_questions` - One version's questions: number, category, prompt, `senior_eligible`, `dynamic_scope` (`none`/`national`/`state`)
- `civics_answers` - Accepted answers per question/state/slot; `effective_to IS NULL` means currently correct (no `is_current` flag — see `docs/specs/civics-content.md` §3)
- `practice_sessions` - One row per practice run (Quick 5 or by-category): kind, status, planned count, cached completion `summary`
- `practice_attempts` - One row per question ever answered, from a session or (from E8) a mock interview — the single evidence table E5/E6/E7 read and E8 writes into. `mock_interview_id` (nullable, E8, epic #57) is set only when `source: mock_interview`, and `response_text` is `null` for either a skip or a `mock_interview` attempt whose interview declined transcript retention — two distinct meanings for the same null, both documented on the column itself. Three columns record the AI grading rung (E4, epic #53), null together on every deterministically-graded attempt: `failure_cause` (why it missed, from a closed six-value enum — `null` means no grader ran, `unknown` means one ran and honestly couldn't tell), `ai_feedback` (the grader's structured verdict, verbatim; omitted entirely, not merely null, for a `mock_interview` attempt with retention off), `ai_usage_event_id` (the `ai_usage_events` row that call wrote). Three more columns (E9, epic #58) hold no audio and never will: `transcript` (the text the learner CONFIRMED after the recogniser's guess — never the raw, unedited output; identical to `response_text` on a spoken attempt today, kept as a separate column because a later epic grading something other than the confirmed transcript must not have to guess which one a historical row meant), `asr_confidence` (the recogniser's own confidence, 0-1; `null` means unknown and never triggers the `misheard` mapping below — unknown is not low), `retry_of_attempt_id` (self-referential FK, `onDelete: SetNull`; set when this attempt is a spoken retry that supersedes an earlier attempt at the same question — the superseding row is excluded from a practice session's summary counts, so a mishearing and its correction read as one answered question). A low-confidence, non-`correct` outcome gets `failure_cause: 'misheard'` set server-side, overriding any cause the AI grader supplied — `outcome` itself is untouched and no `PracticeOutcome` enum value was added for this. See [`docs/specs/voice.md`](docs/specs/voice.md) §3, §8.
- `question_mastery` - One row per `(user, question)` pair once that question first produces a schedulable outcome (E5, epic #54): `state` (`new`/`learning`/`review`/`lapsed`/`mastered`), `due_at`, `interval_days`, `ease`, `correct_streak`, `lapses`, `total_attempts`, `distinct_correct_days` (the column that makes "correct on ≥3 distinct days" enforceable), `last_outcome`, `last_attempt_at`. No row means `new` — never a row that says so. Updated synchronously, inside the same transaction as the `practice_attempts` write that triggers it, by `nextSchedule` (`apps/api/src/practice/mastery/scheduler.ts`); see `docs/specs/memory-model.md` §2-§3
- `readiness_snapshots` - One row per computed readiness score (E6, epic #55): `score` (0-100, structurally capped at 75 for a typed-only learner — `english`/`spoken`/`interview` sum to 0.25 weight and are 0 with no such evidence), the full `components`/`evidenceCounts` breakdown for all eight components, `cap_reason` (`'typed_only'`/`null`), `top_recommendation`, and the learner's `stage` at computation time, all frozen so a past snapshot stays self-explaining after the mastery rows it summarized move on. `narrative`/`narrative_generated_at` are nullable and filled in lazily, on the caller's own AI key, only from the request path (never the nightly cron). See `docs/specs/readiness-model.md` §4-§5
- `daily_activity` - One row per `(user, local calendar day)` (E7, epic #56): `activity_date` (`@db.Date`, the learner's LOCAL day, not an instant), `tz_used` (the IANA zone that day was actually computed in, frozen at write time rather than re-derived from the learner's possibly-since-changed profile), `practice_seconds`/`attempts`/`correct`, `goal_met` (monotonic — once true, never flips back for the same row), `freeze_used` (true only when this row exists to record that a streak freeze covered a day with no practice at all). `@@unique([userId, activityDate])` is both the ordinary-accrual upsert key and the freeze-settlement idempotency key. Has no foreign key, relation, or column reachable from `readiness_snapshots` or the readiness engine — not an input to readiness, structurally, never merely by convention; see `docs/ARCHITECTURE.md` §5.6. See `docs/specs/habit-streaks.md` §2-§4
- `learner_profiles.streak_freezes` / `learner_profiles.streak_freezes_granted_at` - The freeze budget (E7, epic #56): an integer ceiling of 2 (`STREAK_FREEZE_MAX`, `apps/api/src/engagement/streaks/freeze-settlement.ts`), replenished at most once per 7 days, and the timestamp of the last grant. Read and written only by `EngagementService`'s settlement pass (`GET /api/engagement/summary`'s own request path — engagement's sole recompute trigger, deliberately unlike readiness's two). See `docs/specs/habit-streaks.md` §4.3-§4.5
- `mock_interviews` - One row per mock interview run (E8, epic #57): `mode` (`text`/`voice`, only `text` wired), `status` (`in_progress`/`completed`/`abandoned`), `test_version_code` and `senior_exemption` (frozen from `learner_profiles` at creation, never re-read), `civics_asked`/`civics_correct`/`passed_civics` (a derived running tally, not a second source of truth over the `practice_attempts` rows), `result` (the cached debrief JSON, written once at completion), and `transcript_retained` (`@default(false)` **at the database level** — the conservative retention default must survive a bug, not only a correctly-written call site). See `docs/specs/mock-interview.md` §8, §12
- `mock_interview_turns` - One row per line of an interview's conversation, in order (E8, epic #57): `role` (`officer`/`applicant`), `phase`, `question_id` (set only on a civics officer turn), `attempt_id` (set only on a civics applicant turn — the `practice_attempts` row it produced), and `text`, which is written empty (not null) for an applicant turn when the interview's `transcript_retained` is `false` — the turn's structure survives; the learner's words do not. See `docs/specs/mock-interview.md` §8.2

## Access Control: Email Allowlist

The application uses an **email allowlist** to restrict access to pre-authorized users only.

### How It Works
1. Admins add email addresses to the allowlist before users can login
2. During OAuth login, the user's email is checked against the allowlist
3. If the email is not in the allowlist, login is denied with a clear error message
4. Exception: `INITIAL_ADMIN_EMAIL` always bypasses the allowlist check

### Configuration
- `INITIAL_ADMIN_EMAIL` environment variable grants initial admin access
- This email is automatically added to the allowlist during database seeding

### Admin Management
- Access allowlist management at `/admin/settings/users` (Allowlist tab; `/admin/users` still redirects here)
- Two tabs available:
  - **Users**: Manage existing registered users
  - **Allowlist**: Pre-authorize email addresses for future logins

### Status Tracking
- **Pending**: Email added to allowlist but user hasn't logged in yet
- **Claimed**: User has successfully logged in and created an account
- Claimed entries cannot be removed (prevents accidentally removing existing user access)

## Security Guidelines

- Secrets via environment variables only (see `.env.example`)
- JWT access tokens are short-lived (15 min default)
- Refresh tokens in HttpOnly cookies with rotation
- Input validation on all endpoints
- File uploads: images only, size/type limits, randomized filenames
- Email allowlist restricts application access to pre-authorized users

## Testing Requirements

- Unit tests: isolated logic (services, guards, validators)
- Integration tests: API + DB + RBAC flows with test DB
- Mock OAuth in CI (no real Google dependency)
- Frontend: component and hook tests

## Environment Variables

Key variables (see `infra/compose/.env.example` for full list):

**Application:**
- `NODE_ENV` - Environment (development/production)
- `PORT` - API port (default: 3000)
- `APP_URL` - Base URL (default: http://localhost:3535)

**Database (individual connection parameters):**
- `POSTGRES_HOST` - Database hostname (default: localhost)
- `POSTGRES_PORT` - Database port (default: 5432)
- `POSTGRES_USER` - Database user (default: postgres)
- `POSTGRES_PASSWORD` - Database password (default: postgres)
- `POSTGRES_DB` - Database name (default: oathpath)
- `POSTGRES_SSL` - Enable SSL connection (default: false)

Note: `DATABASE_URL` is constructed automatically from these variables at runtime.

**Authentication:**
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `JWT_ACCESS_TTL_MINUTES` - Access token TTL (default: 15)
- `JWT_REFRESH_TTL_DAYS` - Refresh token TTL (default: 14)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
- `INITIAL_ADMIN_EMAIL` - First user with this email becomes Admin
- `DEVICE_CODE_EXPIRY_MINUTES` - Device code lifetime (default: 15)
- `DEVICE_CODE_POLL_INTERVAL` - Device polling interval in seconds (default: 5)
- `DEVICE_TOKEN_EXPIRY_DAYS` - Token lifetime for device sessions in days (default: 7)
- `DEVICE_PAT_EXPIRY_DAYS` - Lifetime of the PAT minted when a device (e.g. the CLI) requests `clientInfo.tokenType: "pat"`, in days; clamped to 1-999 (default: 90)
- `SECRETS_ENCRYPTION_KEY` - Base64-encoded 32-byte AES-256 key (generate with `openssl rand -base64 32`) that encrypts runtime-configured credentials (e.g. an SMTP password an admin enters through the app) before they are stored in the `credentials` table. Optional until a credential is stored; see `docs/runbooks/rotate-secrets-encryption-key.md`. Note: credentials configured at runtime through the UI/API live encrypted in the database, not in the environment — unlike every other secret in this section.

**AI (development/test only):**
- `AI_PROVIDER_FAKE` - Set to exactly `true` to substitute a built-in `FakeAiProvider` for `OpenAiProvider` at the DI layer (`AiModule`'s `resolveAiProvider`), so the grading ladder, the tutor's stream, the admin model dropdowns, the usage table, and (E9, epic #58) transcription/synthesis can all be exercised with no OpenAI account, no API key, and no outbound network call. It does not add a new provider *kind* — `AI_PROVIDER_KINDS` stays `['openai']`, a test settings row still stores `provider: 'openai'`, and the substitution is invisible to every consumer that reads that value. **Inert under `NODE_ENV=production`** — the flag is ignored entirely there, so an inherited or copied `.env` cannot make a real deployment grade learners against a fixture while reporting itself healthy. See `docs/specs/ai-evaluation.md` §10.

**Observability:**
- `OTEL_ENABLED` - Enable OpenTelemetry (default: true)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTEL Collector endpoint
- `UPTRACE_DSN` - Uptrace connection string

## Common Patterns

### Adding a New API Endpoint
1. Create controller method with decorators for auth/RBAC
2. Add service method with business logic
3. Update OpenAPI annotations
4. Add unit + integration tests
5. Update API.md if needed

### Adding a New Setting
1. Update Zod schema for validation
2. Add migration if schema structure changes
3. Update TypeScript types
4. Add frontend UI if user-facing

A new **user-settings namespace** (a top-level key like `dataTables`,
`navigation`, `notifications`, or `study`) is narrower than step 1-3 above
suggests and has its own fixed shape: declare it once in
`apps/api/src/common/schemas/user-settings-namespaces.schema.ts`, never with
a `.default()` (absent must mean "use the built-in default, resolved at
read time" — see that file's header), and no `.default()` means no
migration either. `study` (epic #56 / E7 "Habit") — `reminderHour` and
`reminderEnabled`, read by the hourly `PracticeReminderTask` — is the
newest worked example, alongside the pre-existing `dataTables` and
`navigation`. Do not re-derive the list of files a new namespace touches
here: `docs/specs/habit-streaks.md` §7 names the six explicitly, as a
checklist rather than a count to take on faith, and that document is the
one to extend if a seventh namespace ever needs the same walk-through.

### Using the Clock

Any backend code that needs "now" — a timestamp, a countdown, a day
comparison — MUST inject `Clock` (`apps/api/src/common/clock/clock.ts`) and
call `clock.now()` or `clock.calendarDateIn(timeZone)`, never construct a bare
`new Date()`. `Clock` is what lets a request pin an instant via the
`X-Test-Clock` header (non-production only; see
`apps/api/src/common/clock/test-clock.middleware.ts` and
[`docs/TESTING.md`](docs/TESTING.md)) instead of a test sleeping or asserting
against whatever the real wall clock happens to read. `apps/api/src/journey/`
is the worked example — grep it for `new Date(` and the result is empty,
comments included. Any later epic computing streaks, recency, or elapsed time
(E2 onward) inherits this rule.

### Adding a Notification

Three steps, and no migration — the same "one registry entry" promise the
settings hub makes on its own axis (epic #109, wired end to end by #128).

1. **Declare the event** in `apps/api/src/notifications/notification-events.ts`
   (`NOTIFICATION_EVENTS`): a stable dotted `key` (`billing.invoice_ready`), a
   `label` and `description` written as user-facing copy, the `channels` it can
   genuinely be delivered over (`email`, `browser`), and `defaultEnabled`. Add
   `mandatory: true` only for events a user must not be able to silence — a
   privilege or security change. This one entry feeds the dispatcher, the
   `/settings/notifications` matrix and the docs; there is no second list to
   update, and no preference row is created for anybody (absent means enabled).

2. **Write the template(s)**, one per channel the event declares.
   - *Email*: a new `apps/api/src/email/templates/<name>.email.ts` exporting a
     payload interface and a pure function returning `{ subject, html, text }`.
     Build the body with the `html` tagged literal so every interpolation is
     escaped by construction, pass it to `renderLayout`, put any CTA URL
     through the layout (it applies `safeUrl`), and **hand-write the text
     part** — there is deliberately no HTML-to-text helper. Register it in
     `templates/index.ts` (`EmailTemplateDataMap` **and** `EMAIL_TEMPLATES`;
     the compiler rejects half a registration), then map the event key to the
     template name in `EVENT_EMAIL_TEMPLATES`
     (`notifications/channels/email-notification.channel.ts`). A missing entry
     is a recorded delivery failure, not a silent skip.
   - *Browser*: an entry in `EVENT_BROWSER_TEMPLATES`
     (`notifications/channels/browser-notification.channel.ts`) returning
     `{ title, body, link? }`. Optional — a miss falls back to the registry's
     label and description. `link` must be a root-relative path.
   - `test-email.email.ts` and `role-changed.email.ts` are the worked examples.

3. **Call `notify()` at the real trigger**, from a service whose module
   `imports: [NotificationsModule]`:

   ```ts
   await this.notifications.notify('billing.invoice_ready', userId, payload);
   ```

   Place it **after** the triggering write has committed and **outside** any
   `$transaction`. `notify` is detached — it schedules the dispatch and returns
   before anything is rendered or sent — so it never rejects, never joins your
   transaction, and never delays your response; a send failure becomes a
   `notification_deliveries` row, never an exception. Annotate the payload with
   the template's data type: `notify` takes `data: unknown`, so the call site is
   the only place its shape is checked.

   For a recipient who has **no user account** (an allowlist invitation), use
   `notifyAddress(eventKey, email, payload)`. It resolves the address to an
   account when one exists — so real users' preferences are never skipped — and
   otherwise dispatches through the same gate with no stored preferences, which
   the sparse absent-key contract already defines as "use the event's default".

Live examples of all three steps: `AuthService.handleGoogleLogin`
(`user.welcome`), `AllowlistService.addEmail` (`allowlist.invitation`),
`UsersService.updateUserRoles` (`security.role_changed`, mandatory), and
`PracticeReminderTask` (`apps/api/src/engagement/tasks/practice-reminder.task.ts`,
epic #56 / E7 "Habit"), which raises all three of `practice.daily_reminder`,
`practice.review_due`, and `streak.at_risk` — ordinary preferences, every
one, never `mandatory`: `mandatory` is reserved for a fact a user must not
be able to silence, a privilege or security change, and a study reminder is
neither. `streak.at_risk` is the one `defaultEnabled: false` among the
three, stated as a rule and not left implicit in
`notification-events.ts`'s own comment — it is the only one of the three
that references something the learner could lose, and an unrequested
loss-framed message is exactly the pressure `VISION.md` forbids by name:
"We should never create pressure, shame, fear, or unhealthy compulsion to
increase engagement metrics." `VISION.md`'s own worked example of
acceptable copy, the model these templates follow rather than reuse
verbatim: "Five minutes is enough today. You have four review questions
ready." See [`docs/specs/habit-streaks.md`](docs/specs/habit-streaks.md)
§5 and §8.

### Adding a New AI Model Role

Three steps and no migration, the same "one registry entry" promise the
notification registry makes on its own axis (epic #25, `docs/specs/ai-settings.md`).

A **model role** is one job this application asks a model to do. Six are
declared; `tutor`, `grader`, `transcribe` and `speak` are wired (the last two
since E9, epic #58 — see [`docs/specs/voice.md`](docs/specs/voice.md) §1),
and `realtime`/`embed` are still declared and inert, so that wiring voice
work did not need a settings-schema change or a migration over live admin
configuration, and wiring the next role (realtime interviews, E11) will not
either.

1. **Declare the role** in `apps/api/src/ai/ai-model-roles.ts`
   (`AI_MODEL_ROLES`): a stable `key`, a `label` and `description` written as
   admin-facing copy, the `capability` family a model must belong to to serve
   it, and `wired`.

   That one entry feeds the settings schema, the admin page's selects, the
   connection tests and the usage rows. `AI_MODEL_ROLE_KEYS`,
   `aiSettingsSchema`'s `models` map and `DEFAULT_AI_SETTINGS.models` are all
   **derived** from the array, so the slot appears everywhere in the same edit.
   There is no second list to update.

   `key` is persisted — it is a property name in the `system_settings` row and a
   column value on every `ai_usage_events` row. **Renaming one is a migration,
   not a refactor**: an admin's stored binding becomes unreachable, so the role
   silently reverts to unbound and the feature reports "your administrator
   hasn't finished setting up the AI models" with nothing in the audit trail to
   explain why. Add a new key and migrate the row.

2. **Set `wired: true` only when something actually dispatches to it.**
   `GET /api/ai/status`'s `unboundRoles` is computed over the wired roles
   alone, and both test endpoints probe only wired roles that have a binding.
   Wiring a role nothing uses makes every deployment report the new role
   unbound until an admin binds a model for a feature that does not exist —
   which is informational, not a block, **unless the role is also a `text`
   capability**: `systemReady` (the hard-blocking flag) is computed only over
   the wired roles whose `capability` is `'text'` (`tutor`, `grader` today),
   precisely so that wiring a non-text role like `transcribe`/`speak` cannot
   flip an already-deployed installation's `systemReady` to `false` for a
   capability nobody asked for. See
   [`docs/specs/voice.md`](docs/specs/voice.md) §1 for the mechanism, spelled
   out in full there rather than here.

   An unwired role still renders on `/admin/settings/ai`, inert, using the
   registry's `disabled` card idiom — an admin can see what is coming without
   being able to configure something that does nothing.

3. **Check the provider can serve the capability.** `AiProvider.capabilities`
   declares which families a provider supports, and
   `GET /api/ai-settings/models` reports a role as unwired for **this
   deployment** when the configured provider cannot serve it. That is why the
   web reads `wired` from the endpoint rather than from a constant: it is a
   per-deployment fact, not a static one. OpenAI declares all six; a future
   chat-only provider declares a subset and the voice roles render inert on its
   deployments automatically.

**The registry lives in the API. The web reads it over an endpoint** — never a
duplicated copy in `apps/web/src/config`. This is option 1 of the three
`apps/api/src/notifications/notification-events.ts` weighs, for the same reason:
a duplicate with a test asserting the two agree is *detection* rather than
prevention (the copies can still disagree in a working tree, in a branch, and in
any build where the test is not run), and it breaks the one-registry-entry
promise directly. `wired` makes it worse still, because a static copy would be
wrong on any deployment whose provider differs.

**Neither API key is ever a setting.** The server key lives at
`(purpose 'ai', name 'openai')` and each user's at `('ai-user', <their id>)`, in
the encrypted credential store. `aiSettingsSchema` carries a compile-time proof
that no secret-bearing field is in it; adding `apiKey` there fails the build.

Live examples: `apps/api/src/ai/ai-model-roles.ts` (the registry),
`apps/api/src/ai/ai-settings.schema.ts` (what derives from it),
`apps/api/src/ai/providers/model-classifier.ts` (how a model id is sorted into a
capability family), and `apps/web/src/pages/Admin/AiSettingsPage.tsx` (the
selects it drives). The design record, with the rejected alternatives, is
[`docs/specs/ai-settings.md`](docs/specs/ai-settings.md).

### Adding an AI feature

Three steps, the same "one door" promise `ai-dispatch.service.ts`'s own
header states (epic #53, E4; design in
[`docs/specs/ai-evaluation.md`](docs/specs/ai-evaluation.md)).

1. **Pick the role** from `AI_MODEL_ROLES` (see *Adding a New AI Model Role*
   above) — `tutor` for a free-text or streamed answer, `grader` for a
   machine-checkable verdict, or a new role if neither job fits.

2. **Call `AiDispatchService.run(userId, role, request)`** — or
   `runStructured<T>(userId, role, request)` for a zod-validated shape, or
   `runStream(userId, role, request, signal)` for text as it is produced —
   from a service whose module `imports: [AiModule]`. `request` carries only
   `messages` (and `maxTokens`); there is no `modelId` field to pass, ever.

3. **Handle the typed `unavailable` result — never a thrown exception.** All
   three methods return a discriminated `status`: `'ok'`, `'failed'`, or
   `'unavailable'` with a `cause` that is one of exactly four strings —
   `no_user_key`, `ai_disabled`, `role_unbound`, `capability_unsupported`. A
   `switch` on `status` (and, for `unavailable`, on `cause`) is how a caller
   tells "the admin hasn't finished configuring AI" apart from "this specific
   call failed" apart from "it worked" — wrapping every call site in a
   `try`/`catch` gets none of that, because these methods never throw for an
   AI reason.

Two more rules, load-bearing enough to state outright rather than leave to
the spec:

- **Ground the prompt in content read from the database**, not from the
  model's own knowledge. Build the prompt from rows your feature already
  reads for its ordinary (non-AI) response — the accepted answers a grader
  checks against, the resolved answer a tutor explains — never from what the
  model might recall. `apps/api/src/practice/grading.ts`
  (`buildGradingPrompt`) and `apps/api/src/civics/explain-prompt.ts`
  (`buildExplainPrompt`) are the worked examples, including how each delimits
  and neutralises the one untrusted input in the exchange — the text a
  person typed.

- **No feature resolves a credential or selects a provider.** `messages` and
  `maxTokens` are the only fields a caller supplies; the model id, the
  provider, and the key are resolved *inside* `AiDispatchService`, from the
  admin's settings row and the caller's own credential. A caller that could
  pass its own `modelId` could bind itself to whatever the admin configured
  for a more expensive role — the exact failure the settings layer
  (`docs/specs/ai-settings.md` §1) already closed, reopened one layer up if
  this door had a bypass.

  **And the server key at `('ai', 'openai')` is never used for inference.**
  It exists for the model catalog and the admin's connection test only — see
  `GET /api/ai-settings/models` and `POST /api/ai-settings/test`. The instant
  one inference call runs on it instead of the caller's own key, every
  per-user usage figure on `GET /api/ai/usage` becomes wrong from that call
  onward, **silently**: `ai_usage_events.userId` still names the caller, but
  the tokens were actually billed to the administrator's OpenAI account, with
  nothing in `AiRunOk` to distinguish a fallback call from a normal one and
  no compile error or failing test to catch it. `ai-dispatch.service.ts`'s
  own tests assert this address never appears in that file's source, by name
  — do not defeat that assertion by relocating the fallback elsewhere.

**Render `AiNotReady` (`apps/web/src/components/ai/AiNotReady.tsx`, #43) in
the web whenever `systemReady` is `false`** — the shared point-of-use
component, not a bespoke message. It is what a caller renders for an
`unavailable` result reaching the client (directly, or via an SSE
`unavailable` frame): "AI is not set up here" is a state a learner can do
nothing about, and every feature should say so the same way.

Live examples: `PracticeService.escalateToGrader` (the `grader` role,
`runStructured`) and `CivicsExplainService.explain` (the `tutor` role,
`runStream`, turned into SSE frames by `civics.controller.ts`). Do not
restate the dispatch design, the never-throw contract's mechanics, the
grading ladder, or the failure-cause taxonomy here — all of it is
[`docs/specs/ai-evaluation.md`](docs/specs/ai-evaluation.md).

### Adding a practice session kind

`practice_sessions.kind` is a five-value Postgres enum — `quick`, `category`,
`review`, `weak`, `mixed` — declared all at once so a later kind never needs a
migration over live session rows; `quick` and `category` are wired today.

1. **The enum value must already exist** in `PracticeSessionKind`
   (`apps/api/prisma/schema.prisma`). `review`, `weak`, and `mixed` are — a
   genuinely new sixth kind needs its own migration first; widening from one
   of the three already-declared values needs none.
2. **Widen `createPracticeSessionSchema`'s `kind` enum**
   (`apps/api/src/practice/dto/create-practice-session.dto.ts`) to accept it.
   Until this ships, `POST /api/practice/sessions` rejects the value as a 400
   even though the database enum already allows it.
3. **Add the selector branch** in `PracticeService.createSession`
   (`apps/api/src/practice/practice.service.ts`) — the same place the
   `kind === 'category'` branch picks its questions — that selects the
   question pool for the new kind.
4. **Add the kind's entry to the picker on `/practice`**
   (`apps/web/src/pages/PracticePage.tsx`).

See [`docs/specs/practice-sessions.md`](docs/specs/practice-sessions.md) §4
for which of the five kinds ship today and why the other three are declared
unwired rather than added later.

## Specialized Subagents (MANDATORY)

**CRITICAL REQUIREMENT**: This project uses specialized subagents for all development work. You MUST delegate tasks to the appropriate subagent. Do NOT attempt to perform development tasks directly without using the designated agent.

### Why Subagents Are Mandatory
- Each agent contains domain-specific knowledge from the System Specification
- Agents ensure consistent patterns and conventions across the codebase
- Agents have the full context needed for their specialized area
- Direct implementation without agents risks missing requirements

### Available Agents

| Agent | Domain | MUST Use For |
|-------|--------|--------------|
| `backend-dev` | NestJS API, Fastify, auth, RBAC | **ANY** backend code: endpoints, services, guards, middleware, JWT, OAuth |
| `frontend-dev` | React, MUI, TypeScript | **ANY** frontend code: components, pages, hooks, theming, responsive design |
| `database-dev` | PostgreSQL, Prisma | **ANY** database work: schema changes, migrations, seeds, queries |
| `testing-dev` | Jest/Supertest (API), Vitest/RTL (web) | **ANY** testing: unit tests, integration tests, typecheck, test fixtures |
| `docs-dev` | Technical documentation | **ANY** documentation: ARCHITECTURE.md, SECURITY.md, API.md, README updates |
| `ops-dev` | Routine operations (Haiku) | Rebuilding/restarting containers, running Prisma migrations, running typecheck. NEVER for state-changing git operations |

### Mandatory Delegation Rules

1. **Backend code changes** → ALWAYS use `backend-dev`
2. **Frontend code changes** → ALWAYS use `frontend-dev`
3. **Database/Prisma changes** → ALWAYS use `database-dev`
4. **Writing or updating tests** → ALWAYS use `testing-dev`
5. **Documentation updates** → ALWAYS use `docs-dev`
6. **Routine ops (container rebuilds, migrations, typecheck)** → use `ops-dev`. IMPORTANT: `ops-dev` must NEVER perform state-changing git operations (pull, merge, push, commit, worktree management, branch operations) — those are always handled by the main agent directly, and `ops-dev` is instructed to refuse them

### Multi-Domain Tasks

For tasks spanning multiple domains, you MUST invoke multiple agents sequentially:

**Example: "Add a new user preference setting"**
1. `database-dev` → Add migration for schema change
2. `backend-dev` → Implement API endpoint
3. `frontend-dev` → Build UI component
4. `testing-dev` → Write tests for all layers
5. `docs-dev` → Update API documentation

### Usage Examples
```
# Backend work - MUST use backend-dev
"Use backend-dev to implement the user settings endpoint"

# Frontend work - MUST use frontend-dev
"Use frontend-dev to create the theme toggle component"

# Database work - MUST use database-dev
"Use database-dev to add audit_events table migration"

# Testing work - MUST use testing-dev
"Use testing-dev to write integration tests for auth"

# Documentation work - MUST use docs-dev
"Use docs-dev to update SECURITY.md with new auth flow"

# Routine ops - use ops-dev (never for git operations)
"Use ops-dev to rebuild the api container and run migrations"
```

### What You Should NOT Do Directly
- Do NOT write NestJS controllers, services, or guards without `backend-dev`
- Do NOT create React components or pages without `frontend-dev`
- Do NOT modify Prisma schema or create migrations without `database-dev`
- Do NOT write Jest/Vitest/RTL tests without `testing-dev`
- Do NOT update documentation files without `docs-dev`

The only exceptions are:
- Reading files to understand context
- Answering questions about the codebase
- Planning and coordination between agents
- Running simple commands (git status, npm install, etc.)
