# System Architecture

**OathPath**
**Version:** 1.0
**Last Updated:** January 2026

This document provides a comprehensive architectural overview of OathPath, designed for AI-assisted development with specialized coding agents.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture Principles](#3-architecture-principles)
4. [Technology Stack](#4-technology-stack)
5. [Component Architecture](#5-component-architecture)
6. [Data Architecture](#6-data-architecture)
7. [Security Architecture](#7-security-architecture)
8. [API Architecture](#8-api-architecture)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Infrastructure Architecture](#10-infrastructure-architecture)
11. [Observability Architecture](#11-observability-architecture)
12. [Testing Architecture](#12-testing-architecture)
13. [Agent-Based Development Model](#13-agent-based-development-model)
14. [Development Workflows](#14-development-workflows)
15. [Appendices](#15-appendices)

---

## 1. Executive Summary

### Purpose

OathPath is a production-grade web application that establishes:

- **Secure Authentication**: OAuth 2.0 with Google (extensible to other providers)
- **Fine-Grained Authorization**: Role-Based Access Control (RBAC) with permissions
- **Flexible Configuration**: JSONB-based settings framework for system and user preferences
- **Enterprise Observability**: OpenTelemetry instrumentation with traces, metrics, and structured logs
- **Agent-Friendly Development**: Modular architecture designed for AI coding agent collaboration

### Key Characteristics

| Aspect | Description |
|--------|-------------|
| **Architecture Style** | Monorepo with API-first design |
| **Hosting Model** | Same-origin (UI and API share base URL) |
| **Auth Strategy** | OAuth 2.0 + JWT with refresh token rotation |
| **Access Control** | Email allowlist + RBAC (Admin/Contributor/Viewer) |
| **Data Storage** | PostgreSQL with Prisma ORM |
| **Extensibility** | JSONB settings, modular NestJS structure |

### Target Audience

- **AI Coding Agents**: Primary consumers for automated development tasks
- **Backend Developers**: NestJS/Node.js engineers
- **Frontend Developers**: React/TypeScript engineers
- **DevOps Engineers**: Infrastructure and deployment specialists
- **Security Teams**: Security review and compliance

---

## 2. System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NGINX REVERSE PROXY                             │
│                           (Security Headers, Routing)                        │
│                              http://localhost:3535                           │
├────────────────────────────────────┬────────────────────────────────────────┤
│         /* → Frontend (Web)        │           /api/* → Backend (API)       │
├────────────────────────────────────┼────────────────────────────────────────┤
│                                    │                                        │
│  ┌──────────────────────────────┐  │  ┌──────────────────────────────────┐  │
│  │       REACT FRONTEND         │  │  │       NESTJS + FASTIFY           │  │
│  │                              │  │  │                                  │  │
│  │  ┌────────────────────────┐  │  │  │  ┌────────────────────────────┐  │  │
│  │  │      Pages/Routes      │  │  │  │  │    Controllers/Guards      │  │  │
│  │  │  • Login               │  │  │  │  │  • AuthController          │  │  │
│  │  │  • Home                │  │  │  │  │  • UsersController         │  │  │
│  │  │  • User Settings       │  │  │  │  │  • SettingsController      │  │  │
│  │  │  • System Settings     │  │  │  │  │  • HealthController        │  │  │
│  │  │  • Device Activation   │  │  │  │  └────────────────────────────┘  │  │
│  │  └────────────────────────┘  │  │  │                                  │  │
│  │                              │  │  │  ┌────────────────────────────┐  │  │
│  │  ┌────────────────────────┐  │  │  │  │    Services/Business       │  │  │
│  │  │  Contexts/State        │  │  │  │  │    Logic Layer             │  │  │
│  │  │  • AuthContext         │  │  │  │  │  • AuthService             │  │  │
│  │  │  • ThemeContext        │  │  │  │  │  • UsersService            │  │  │
│  │  │  • SettingsContext     │  │  │  │  │  • SettingsService         │  │  │
│  │  └────────────────────────┘  │  │  │  │  • AllowlistService        │  │  │
│  │                              │  │  │  └────────────────────────────┘  │  │
│  │  ┌────────────────────────┐  │  │  │                                  │  │
│  │  │  Material UI (MUI)     │  │  │  │  ┌────────────────────────────┐  │  │
│  │  │  • Components          │  │  │  │  │    Prisma ORM              │  │  │
│  │  │  • Theming             │  │  │  │  │  • Database Access         │  │  │
│  │  │  • Responsive Design   │  │  │  │  │  • Query Building          │  │  │
│  │  └────────────────────────┘  │  │  │  │  • Migrations              │  │  │
│  │                              │  │  │  └────────────────────────────┘  │  │
│  └──────────────────────────────┘  │  └──────────────────────────────────┘  │
│                                    │                │                       │
│              Port 5173             │                │      Port 3000        │
└────────────────────────────────────┴────────────────┼───────────────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │        POSTGRESQL              │
                                     │                                │
                                     │  Tables:                       │
                                     │  • users, user_identities      │
                                     │  • roles, permissions          │
                                     │  • user_roles, role_permissions│
                                     │  • user_settings               │
                                     │  • system_settings             │
                                     │  • refresh_tokens              │
                                     │  • device_codes                │
                                     │  • allowed_emails              │
                                     │  • audit_events                │
                                     │                                │
                                     │           Port 5432            │
                                     └────────────────────────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │    OBSERVABILITY STACK         │
                                     │                                │
                                     │  • OTEL Collector              │
                                     │  • Uptrace (Traces/Metrics)    │
                                     │  • ClickHouse (Storage)        │
                                     │                                │
                                     │        Port 14318 (UI)         │
                                     └────────────────────────────────┘
```

### Request Flow

```
┌──────┐    ┌───────┐    ┌─────────────┐    ┌──────────────┐    ┌────────────┐
│Client│───▶│ Nginx │───▶│ JwtAuthGuard│───▶│ RolesGuard   │───▶│ Controller │
└──────┘    └───────┘    └─────────────┘    └──────────────┘    └────────────┘
                              │                    │                   │
                              ▼                    ▼                   ▼
                         Validate JWT       Check Roles/        Business Logic
                         Load User          Permissions         Response
```

---

## 3. Architecture Principles

### 3.1 Separation of Concerns

| Layer | Responsibility | Location |
|-------|---------------|----------|
| **Presentation** | User interaction, rendering, UX | `apps/web/` |
| **API Gateway** | HTTP handling, validation, auth | `apps/api/src/*/controllers/` |
| **Business Logic** | Domain rules, orchestration | `apps/api/src/*/services/` |
| **Data Access** | Database operations, queries | Prisma via services |
| **Infrastructure** | Routing, containers, config | `infra/` |

**Rule**: Frontend handles presentation only. All business logic resides in the API.

### 3.2 Same-Origin Hosting

All components served from the same base URL via Nginx reverse proxy:

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | Frontend (React) | User interface |
| `/api/*` | Backend (NestJS) | REST API |
| `/api/docs` | Scalar API reference | Interactive API documentation |
| `/api/openapi.json` | OpenAPI spec | Machine-readable API schema |

**Benefits**: No CORS complexity, simplified cookie handling, unified deployment.

### 3.3 Security by Default

- **Authentication Required**: All API endpoints require JWT unless explicitly marked `@Public()`
- **Authorization Enforced**: RBAC guards verify roles/permissions before controller execution
- **Input Validated**: Zod schemas validate all request payloads
- **Secrets Protected**: Environment variables only, never committed to source

### 3.4 API-First Design

- **Contract-Driven**: OpenAPI specification generated from code annotations
- **Versioned**: API paths support future versioning (`/api/v1/`)
- **Consistent**: Standardized response format for success and errors
- **Documented**: Every endpoint documented with OpenAPI decorators; the published
  document is assembled in `apps/api/src/openapi/` and linted by Spectral in CI
  (see [`docs/specs/api-documentation.md`](specs/api-documentation.md))

### 3.5 Observable by Design

- **Traced**: OpenTelemetry auto-instrumentation for all HTTP and DB operations
- **Metered**: Request counts, durations, error rates exposed as metrics
- **Logged**: Structured JSON logging with correlation IDs
- **Health-Checked**: Liveness and readiness endpoints for orchestration

---

## 4. Technology Stack

### 4.1 Core Technologies

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| **Runtime** | Node.js | 24+ (LTS) | Server runtime |
| **Language** | TypeScript | 6.x | Type safety |
| **Backend Framework** | NestJS | 11.x | API structure |
| **HTTP Adapter** | Fastify | 5.x | High-performance HTTP |
| **Frontend Framework** | React | 19.x | UI rendering |
| **UI Library** | Material UI (MUI) | 9.x | Component library |
| **Database** | PostgreSQL | 16+ | Data persistence |
| **ORM** | Prisma | 7.x | Database access |

### 4.2 Authentication & Security

| Component | Technology | Purpose |
|-----------|------------|---------|
| **OAuth Strategy** | Passport.js | OAuth flow handling |
| **OAuth Provider** | Google OAuth 2.0 | Primary identity provider |
| **Token Format** | JWT (HS256) | Stateless authentication |
| **Validation** | Zod | Runtime schema validation |
| **Security Headers** | Helmet (via Nginx) | HTTP security headers |

### 4.3 Infrastructure

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Containerization** | Docker | Application packaging |
| **Orchestration** | Docker Compose | Local development environment |
| **Reverse Proxy** | Nginx | Routing, SSL termination, headers |
| **Observability** | OpenTelemetry + Uptrace | Traces, metrics, logs |
| **Logging** | Pino | Structured JSON logging |

### 4.4 Testing

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Backend Unit Tests** | Jest + jest-mock-extended | Service/guard testing with mocked Prisma |
| **Backend Integration** | Jest + Supertest | HTTP endpoint testing with mocked database |
| **Prisma Mocking** | jest-mock-extended (DeepMockProxy) | Type-safe database mocking |
| **Frontend Tests** | Vitest + React Testing Library | Component and context testing |
| **Frontend API Mocking** | MSW (Mock Service Worker) | Network request interception |
| **E2E (Optional)** | Playwright | Full system testing |

**Key Testing Characteristics:**
- Backend tests use **mocked PrismaService** by default (no real database required)
- Integration tests verify full HTTP request/response cycle with mocked data layer
- Frontend tests run in jsdom environment with MSW intercepting API calls
- Coverage thresholds: 70% minimum for frontend (enforced in vitest.config.ts)

---

## 5. Component Architecture

### 5.1 Repository Structure

```
oathpath/
├── apps/
│   ├── api/                          # Backend API (NestJS + Fastify)
│   │   ├── src/
│   │   │   ├── auth/                 # Authentication module
│   │   │   │   ├── controllers/
│   │   │   │   ├── services/
│   │   │   │   ├── guards/
│   │   │   │   ├── strategies/
│   │   │   │   └── decorators/
│   │   │   ├── users/                # User management module
│   │   │   ├── settings/             # Settings module (user + system)
│   │   │   ├── allowlist/            # Email allowlist module
│   │   │   ├── health/               # Health check module
│   │   │   ├── prisma/               # Prisma service
│   │   │   ├── common/               # Shared utilities
│   │   │   │   ├── constants/
│   │   │   │   ├── filters/
│   │   │   │   └── interceptors/
│   │   │   ├── config/               # Configuration module
│   │   │   └── main.ts               # Application entry
│   │   ├── prisma/
│   │   │   ├── schema.prisma         # Database schema
│   │   │   ├── migrations/           # Migration history
│   │   │   └── seed.ts               # Database seeding
│   │   ├── test/                     # Integration tests
│   │   └── Dockerfile
│   │
│   └── web/                          # Frontend (React + MUI)
│       ├── src/
│       │   ├── components/           # Reusable UI components
│       │   ├── pages/                # Page components
│       │   ├── contexts/             # React context providers
│       │   ├── hooks/                # Custom hooks
│       │   ├── services/             # API client
│       │   ├── theme/                # MUI theme configuration
│       │   ├── types/                # TypeScript types
│       │   └── __tests__/            # Component tests
│       └── Dockerfile
│
├── docs/                             # Documentation
│   ├── ARCHITECTURE.md               # This document
│   ├── SECURITY-ARCHITECTURE.md      # Security details
│   ├── API.md                        # API reference
│   ├── DEVELOPMENT.md                # Development guide
│   ├── TESTING.md                    # Testing guide
│   ├── DEVICE-AUTH.md                # Device auth guide
│   ├── System_Specification_Document.md  # Full specification
│   └── specs/                        # Implementation specifications
│       ├── 01-project-setup.md
│       ├── 02-database-schema.md
│       └── ... (24 specs total)
│
├── infra/                            # Infrastructure configuration
│   ├── compose/
│   │   ├── base.compose.yml          # Core services
│   │   ├── dev.compose.yml           # Development overrides
│   │   ├── prod.compose.yml          # Production overrides
│   │   ├── otel.compose.yml          # Observability stack
│   │   └── .env.example              # Environment template
│   ├── nginx/
│   │   └── nginx.conf                # Reverse proxy config
│   └── otel/
│       ├── otel-collector-config.yaml
│       └── uptrace.yml
│
├── .claude/                          # AI agent configuration
│   └── agents/
│       ├── backend-dev.md            # Backend specialist
│       ├── frontend-dev.md           # Frontend specialist
│       ├── database-dev.md           # Database specialist
│       ├── testing-dev.md            # Testing specialist
│       └── docs-dev.md               # Documentation specialist
│
├── CLAUDE.md                         # AI assistant guidance
└── README.md                         # Project overview
```

### 5.2 Backend Module Structure

Each NestJS module follows a consistent pattern:

```
module-name/
├── module-name.module.ts         # Module definition
├── module-name.controller.ts     # HTTP endpoints
├── module-name.service.ts        # Business logic
├── dto/                          # Data Transfer Objects
│   ├── create-item.dto.ts
│   └── update-item.dto.ts
├── interfaces/                   # TypeScript interfaces
├── guards/                       # Module-specific guards
└── module-name.controller.spec.ts  # Unit tests
```

### 5.3 Frontend Component Structure

```
components/
├── ComponentName/
│   ├── ComponentName.tsx         # Component implementation
│   ├── ComponentName.test.tsx    # Component tests
│   └── index.ts                  # Barrel export

pages/
├── PageName/
│   ├── PageName.tsx              # Page component
│   ├── PageName.test.tsx         # Page tests
│   └── index.ts                  # Barrel export
```

### 5.4 Storage Subsystem

The storage system provides file upload and management capabilities with support for large files through resumable multipart uploads.

#### Architecture Overview

The storage system uses a provider abstraction pattern to support multiple cloud storage backends while maintaining a consistent API.

```
┌─────────────────────────────────────────────────────────────┐
│                    Storage Module                            │
├─────────────────────────────────────────────────────────────┤
│  Objects Controller                                          │
│  └── Upload/Download/CRUD endpoints                          │
├─────────────────────────────────────────────────────────────┤
│  Objects Service                                             │
│  └── Business logic, ownership validation                    │
├─────────────────────────────────────────────────────────────┤
│  Storage Provider Interface                                  │
│  ├── S3StorageProvider (implemented)                         │
│  └── AzureStorageProvider (future)                          │
├─────────────────────────────────────────────────────────────┤
│  Object Processing Pipeline                                  │
│  └── Async post-upload processing with pluggable processors  │
└─────────────────────────────────────────────────────────────┘
```

#### Upload Flow

**1. Resumable Upload (Large Files)**:
   - Client calls `/api/storage/objects/upload/init` with file metadata
   - Server creates DB record, initializes S3 multipart, returns presigned URLs
   - Client uploads parts directly to S3 (bypasses application server)
   - Client calls `/api/storage/objects/:id/upload/complete` with part ETags
   - Server finalizes upload with S3, triggers processing pipeline

**2. Simple Upload (Small Files < 100MB)**:
   - Client sends file via multipart/form-data to `/api/storage/objects`
   - Server streams directly to S3
   - Processing pipeline triggered on completion

#### Processing Pipeline

Post-upload processing is handled asynchronously via NestJS EventEmitter:

```
ObjectUploadedEvent (emitted)
         ↓
ObjectProcessingService (orchestrator)
         ↓
Registered Processors (run in priority order)
         ↓
Results aggregated into object metadata
         ↓
Status updated: ready | failed
```

**Key Features:**
- Pluggable processor architecture
- Priority-based execution order
- Processors run asynchronously (non-blocking)
- Results stored in object metadata JSONB field
- Extensible for future processing needs (virus scanning, image resizing, etc.)

#### Database Schema

**storage_objects**:
- File metadata, status, storage key
- Owner reference (user_id)
- Processing results in JSONB metadata field

**storage_object_chunks**:
- Tracks multipart upload progress
- Part number, ETag, upload status
- Enables resume capability

#### Module Structure

```
apps/api/src/storage/
├── storage.module.ts                # Module definition
├── objects/
│   ├── objects.controller.ts        # HTTP endpoints
│   ├── objects.service.ts           # Business logic
│   ├── dto/                         # Data transfer objects
│   └── interfaces/
├── providers/
│   ├── storage-provider.interface.ts
│   └── s3-storage.provider.ts
└── processing/
    ├── object-processing.service.ts
    └── processors/
        └── base-processor.interface.ts
```

### 5.5 Readiness Engine

Epic #55 (E6 "Readiness and Progress"). An eight-component weighted score
(0-100) summarizing how ready a learner is for the interview, stored as a
`readiness_snapshots` row rather than computed fresh on every read. Full
design detail — every component's formula, the `capReason` rule, the stage
thresholds, worked examples — lives in
[`docs/specs/readiness-model.md`](specs/readiness-model.md); this section
covers only the architectural shape.

#### Why a snapshot, not a live computation

The epic body gives three independently load-bearing reasons, and the
shipped design follows them exactly:

- **The trend line is the product.** `GET /api/readiness/history` — the
  scored history a learner watches move over weeks — has nothing to show if
  no result is ever stored.
- **A rendered number must stay explicable after its inputs move.** A
  `question_mastery` row a snapshot summarized can be rescheduled or
  re-promoted by the time a learner revisits last week's score; a live
  recompute would silently rewrite history under an old date.
- **Recomputing a learner's entire evidence history on every read is
  neither cheap nor honest** — not cheap, because it means re-aggregating
  every mastery row and the last 20 qualifying attempts on every page load;
  not honest, because "your readiness two weeks ago" rendered from today's
  evidence isn't actually a fact about two weeks ago.

#### Pure engine / service split

`computeReadiness` (`apps/api/src/readiness/readiness-engine.ts`) is pure
TypeScript — no Prisma, no `Clock`, no I/O — taking an already-assembled
evidence object and returning a score, the per-component breakdown, and
`capReason`. It mirrors the same pure-function shape
`practice/mastery/scheduler.ts`'s `nextSchedule` already establishes:
directly unit-testable, table-of-cases and all, with no database in the
loop. `ReadinessService` owns every Prisma read that assembles the evidence,
calls the engine, and persists the result — the engine itself never sees a
`userId`.

**The structural 75-point cap has no clamp.** `english` (0.05) + `spoken`
(0.10) + `interview` (0.10) sum to 0.25 of the total weight and are
mathematically `0` for a learner with no such evidence, so a typed-only
score can never exceed 75 — a fact that falls directly out of the weights
table, not a hand-maintained `min(score, 75)` ceiling that could drift out
of sync with it. `capReason` (`'typed_only'` / `null`) is a separate,
binary signal from `score` itself: it answers "is there a structural reason
you can't move past a number," not "how close are you to that number."

Stage transitions from a snapshot's score (`remembering → practicing` at
50, `practicing → performing` at 65, `performing → ready` at 80 **and**
`capReason === null`) live in a sibling file,
`apps/api/src/journey/readiness-stage-transitions.ts` — deliberately not
folded into `journey/stage-transitions.ts`, whose own header ties it to
per-attempt mastery events specifically. Regression is never automatic: a
score falling back below a cleared threshold never demotes a stage badge.

#### Recompute triggers

Exactly two, no job queue:

1. **Synchronously**, at the end of `PracticeService.completeSession` —
   inside the same request that produced the evidence.
2. **A nightly cron**, `ReadinessRecomputeTask`
   (`apps/api/src/readiness/tasks/readiness-recompute.task.ts`), following
   `apps/api/src/auth/tasks/token-cleanup.task.ts`'s exact shape — a plain
   `@Injectable()` with `@Cron(CronExpression.EVERY_DAY_AT_3AM)`, registered
   directly in `ReadinessModule`'s own `providers` array rather than a
   separate "tasks module." It recomputes every user who has ever engaged
   with the journey, so `consistency`'s 14-day window (and any stage
   transition it triggers) decays honestly while a learner is away, not
   only on a day they happen to open the app.

**The nightly cron never calls AI.** It writes `score`, `stage`,
`components`, `evidenceCounts`, `capReason`, and `topRecommendation`, and
leaves `narrative`/`narrativeGeneratedAt` untouched — a user's BYOK key is
not available outside a request from that user, so narrative generation
(issue #134's Progress Guide paragraph) happens only inside
`GET /api/readiness`'s own request path, and never blocks that response if
generation is unavailable or fails.

#### Web

`/progress` (`apps/web/src/pages/ProgressPage.tsx`) renders the full score,
per-component breakdown, cap notice, trend, top recommendation, and
narrative, alongside E5's existing mastery-by-category sections — two
independent data sources with two independent loading states, not one
combined flag. `ReadinessWidget`
(`apps/web/src/components/readiness/ReadinessWidget.tsx`) is the compact
equivalent on Home (`/`): the same score and recommendation, one glance,
with the `topRecommendation` copy always rendered verbatim rather than
re-templated locally.

**A note on test coverage:** the E2E spec
(`tests/e2e/specs/readiness.spec.ts`, issue #146) verifies the shipped
engine end to end against a self-designed, hand-verifiable evidence table —
it does **not** reproduce the exact 33/50/59 scores from
`docs/specs/readiness-model.md` §12's Dana worked example, because that
example's precise evidence shape (an AI-graded `partial` outcome, an exact
`lapses`-threshold mix) has no honest way to be dialed to through the real
product surface without either configuring `AI_PROVIDER_FAKE` and pinning
this suite to its exact grading behavior, or writing directly to
`practice_attempts` — neither of which is a true end-to-end exercise of the
product. The spec's own header explains the substitution in full.

### 5.6 Engagement Model

Issue #119/#153, epic #56 (E7 "Habit"). Daily goal tracking, streaks, and
streak-freeze protection — a **consistency** surface, not a readiness one.
Full design detail — the accrual formula, the settlement algorithm, the
reminder ladder, the `study` namespace, the copy rules — lives in
[`docs/specs/habit-streaks.md`](specs/habit-streaks.md); this section
covers only the architectural shape.

#### Local days, derived through `Clock`

Every "day" `EngagementService` and `PracticeReminderTask` reason about is a
LOCAL calendar day in the learner's own `learner_profiles.timezone`, never
a UTC instant — the same discipline §5.5 states for `Clock.calendarDateIn`,
extended here by two more `Clock` methods this epic added:
`localHourIn(timeZone)` (the current local hour, `0`-`23`) and
`localDayRangeIn(timeZone)` (that local day's UTC instant bounds, as
`{ start, end }`). All three throw `RangeError` for an unknown timezone
rather than silently falling back to UTC — a stored `timezone` a learner
never actually has is a bug worth surfacing, not a countdown or a reminder
quietly off by one.

Each `daily_activity` row **stores** the IANA zone it was computed in as
`tz_used`, alongside its `activity_date`, rather than re-deriving the zone
from the learner's (possibly since-changed) profile at read time. A learner
who relocates keeps every past row's day exactly as it was written on the
day it happened — `tz_used` is what makes that row self-explaining after
the profile that produced it has moved on, the identical reason a
`readiness_snapshots` row freezes its own inputs (§5.5).

#### The hourly reminder task

`PracticeReminderTask` (`apps/api/src/engagement/tasks/practice-reminder.task.ts`)
is the one trigger behind all three reminder events
(`practice.daily_reminder`, `practice.review_due`, `streak.at_risk`). It
follows `apps/api/src/auth/tasks/token-cleanup.task.ts`'s exact shape — a
plain `@Injectable()` with a `@Cron` decorator, registered directly in its
own feature module's `providers` array rather than a separate "tasks
module" — but where `token-cleanup.task.ts` and `ReadinessRecomputeTask`
(§5.5) both run `EVERY_DAY_AT_3AM`, this task runs
**`@Cron(CronExpression.EVERY_HOUR)`**, and the difference is deliberate:
a single fixed UTC instant is fine for housekeeping and fatal for a
reminder. `EVERY_DAY_AT_3AM` reaches a Tokyo learner at noon and a Madrid
learner at 4am — a different local hour for every zone a learner could be
in, so no single daily expression can express "remind me at 9am" for more
than one of them at a time. An hourly firing sidesteps the problem rather
than approximating it: on each run the question is "whose local hour, right
now, equals the hour they chose" — `Clock.localHourIn`, answerable for
every zone at once, twenty-four times a day.

The task deliberately never settles freezes — that write is reserved for
`GET /api/engagement/summary`'s own request path (habit-streaks.md §4.6's
single recompute trigger), so an hourly background job never spends a
learner's freeze budget on a schedule nobody asked for.

#### `daily_activity` is not an input to the readiness engine

Stated here as a rule, not an aside: **the readiness engine
(`apps/api/src/readiness/readiness-engine.ts`, §5.5) never reads
`daily_activity`, a streak count, or a freeze balance, and never will.**
`PRD.md` states the separation as a product requirement — "Points, streaks,
achievements, and challenges encourage the journey. They must never
artificially increase the user's Readiness Score" — and it is kept
structurally here, not by a filter applied at read time:

- **No schema relation.** `DailyActivity` (`apps/api/prisma/schema.prisma`)
  has no foreign key, relation, or column that lets `readiness_snapshots`
  or `computeReadiness` read out of it.
- **No module import.** `EngagementModule` does not import
  `ReadinessModule` — the dependency the other direction runs one way only,
  `PracticeModule` importing `EngagementModule` to accrue after its own
  writes commit, exactly as it already imports `ReadinessModule` for the
  same shape of call.
- **An integration test holds the line.** The `engagement never moves
  readiness` describe block in
  `apps/api/test/engagement.integration.spec.ts` drives a long streak, a
  spent freeze, and a met goal through the real API and asserts the
  readiness score and **every** component stay byte-identical before and
  after — not merely "the score didn't change" — and separately asserts
  that `GET /api/readiness`'s response carries no streak, freeze, or
  daily-activity field at all.

A future contributor wanting readiness to feel more responsive to daily
practice should not wire `daily_activity` into the readiness engine to get
it — that is the exact coupling this section, the schema comment above
`DailyActivity`, and the test above all exist to prevent.

### 5.7 Mock Interview: the Engine/Model Boundary

Issue #133, epic #57 (E8 "Mock interview — text mode"). A scripted
rehearsal of the civics portion of the naturalization interview, built on
a rule this section states because it is the rule most likely to erode
under a future change that only wants the officer to sound more natural.
Full design — the phase sequence, the seeded question selection, the PII
stance — lives in
[`docs/specs/mock-interview.md`](specs/mock-interview.md); this section
covers the one architectural boundary.

**The engine decides. The model speaks.** `apps/api/src/interviews/engine/`
is a pure module (no Nest, no Prisma, no `Clock`, no `Date` — the same
shape §5.5's `computeReadiness` and §5.6's scheduler already take) that
owns:

- **Question selection** — a deterministic, seeded shuffle of the caller's
  eligible pool, so the same interview always asks the same questions in
  the same order.
- **Phase order** — `smalltalk → n400 → civics → reading → writing →
  closing`, fixed and code-owned.
- **The pass rule, read from a row, never a constant.** How many civics
  questions are asked and how many must be correct both come from the
  `civics_test_versions` row resolved from the caller's own
  `learner_profiles` — as illustration only, today's seeded values are
  2008: 6 of 10, 2025: 12 of 20, with a senior variant of each from its own
  columns (`senior_questions_asked`/`senior_pass_threshold`). The rule that
  matters is not those numbers; it is that the engine has no threshold
  literal anywhere in its own source, ever — a later content correction is
  a row update, never a code change.

The `tutor` role, dispatched through `AiDispatchService.run`/`.runStream`
(§5.5's pure-engine/service split, applied here to a conversational turn),
supplies exactly one thing: the officer's acknowledgement sentence. It is
never asked to choose a question, judge an answer, or decide when the
civics section stops — every decision the turn needs to communicate has
already been made by the time the model is called.

**The structural enforcement.** `assembleOfficerTurn`
(`apps/api/src/interviews/officer-prompt.ts`) builds the officer's civics
turn by string concatenation the code controls:

```
officerTurnText = <the model's acknowledgement sentence>
                   + "\n\n"
                   + <civics_questions.prompt, read VERBATIM from the database>
```

The question text is never part of what the model is asked to produce —
there is no field in its response it could occupy — so it has no channel
through which to paraphrase, translate, simplify, or invent a question.
This is checked mechanically, not merely asserted: a unit test confirms
the question's exact `prompt` string appears byte-for-byte inside the
assembled turn for every civics-phase exchange.

**An `unavailable` or `failed` dispatch result changes the wording, and
never the outcome.** When `AiDispatchService` cannot produce an
acknowledgement, the engine substitutes a fixed, code-owned neutral line
and proceeds exactly as if the call had succeeded — same next question,
same grade, same stop evaluation, same interview result. A learner with no
AI configured still completes a fully, correctly graded interview.

**The failure mode of crossing this boundary.** A model that chose
questions or judged answers would make "you passed the civics section"
unreproducible and unauditable — the single most consequential claim this
product makes. Two runs against identical answers could disagree, with no
way to explain why one run said "passed" and the other said "failed"
beyond "the model felt differently that time." Every other engine in this
product goes to real lengths to keep its central number explainable
(§5.5's frozen snapshot, §5.6's schema-isolated engagement data); a mock
interview whose verdict crossed into model judgment would be the one place
in the product where the most emotionally loaded result a learner ever
receives came from a source that cannot be explained, replayed, or held to
a fixed rule.

**Interview answers are `practice_attempts` rows, not a second evidence
table.** A graded civics answer is written with `source: 'mock_interview'`,
`sessionId: null`, and `mockInterviewId` set to the interview it belongs
to — the identical table `question_mastery` scheduling and the readiness
engine already read for ordinary practice attempts, with no `UNION`
required to answer "this learner's complete answer history to a question."
`PracticeAttempt.sessionId` was made nullable specifically so this epic
would never need a parallel table to hold interview evidence.

**Readiness's `interview` component now has real evidence, and no new
stage rule.** `ReadinessService.assembleEvidence`'s `mockInterviewsPassed`
— previously a literal `0`, with a comment naming this epic as the one
that would supply a grouping key — is now a real count of the caller's
`mock_interviews` rows with `status: 'completed'` and `passedCivics: true`.
`computeReadiness`'s `min(mockInterviewsPassed / 2, 1)` formula (§5.5) is
unchanged; only the number it is handed stopped being hardcoded. Passing a
first interview also lifts the structural 75-point cap the instant any
real evidence exists (§5.5). **E8 adds no new stage transition**: the move
to `performing` remains `readiness-stage-transitions.ts`'s existing
`practicing → performing` transition at score ≥ 65 — this epic supplies
evidence the score formula already knows how to use, never a rule of its
own about when a stage advances.

---

## 6. Data Architecture

### 6.1 Entity Relationship Diagram

```
┌────────────────────┐       ┌────────────────────┐
│       users        │       │   user_identities  │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)      │
│ email (UNIQUE)     │  │    │ user_id (FK)       │──┘
│ display_name       │  └───▶│ provider           │
│ provider_display   │       │ provider_subject   │
│ profile_image_url  │       │ provider_email     │
│ provider_image_url │       │ created_at         │
│ is_active          │       └────────────────────┘
│ created_at         │
│ updated_at         │       ┌────────────────────┐
└────────────────────┘       │    user_settings   │
         │                   ├────────────────────┤
         │                   │ id (PK, UUID)      │
         │                   │ user_id (FK, UNIQUE)│◀─┐
         │                   │ value (JSONB)      │  │
         │                   │ version            │  │
         ▼                   │ updated_at         │  │
┌────────────────────┐       └────────────────────┘  │
│    user_roles      │                               │
├────────────────────┤                               │
│ user_id (FK, PK)   │───────────────────────────────┘
│ role_id (FK, PK)   │──┐
└────────────────────┘  │    ┌────────────────────┐
                        │    │       roles        │
                        │    ├────────────────────┤
                        └───▶│ id (PK, UUID)      │
                             │ name (UNIQUE)      │
                             │ description        │
                             └────────────────────┘
                                       │
                                       ▼
                             ┌────────────────────┐
                             │  role_permissions  │
                             ├────────────────────┤
                             │ role_id (FK, PK)   │
                             │ permission_id (PK) │──┐
                             └────────────────────┘  │
                                                     │
                             ┌────────────────────┐  │
                             │    permissions     │  │
                             ├────────────────────┤  │
                             │ id (PK, UUID)      │◀─┘
                             │ name (UNIQUE)      │
                             │ description        │
                             └────────────────────┘

┌────────────────────┐       ┌────────────────────┐
│  system_settings   │       │   refresh_tokens   │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │       │ id (PK, UUID)      │
│ key (UNIQUE)       │       │ user_id (FK)       │
│ value (JSONB)      │       │ token_hash (UNIQUE)│
│ version            │       │ expires_at         │
│ updated_by_user_id │       │ created_at         │
│ updated_at         │       │ revoked_at         │
└────────────────────┘       └────────────────────┘

┌────────────────────┐       ┌────────────────────┐
│   allowed_emails   │       │    device_codes    │
├────────────────────┤       ├────────────────────┤
│ id (PK, UUID)      │       │ id (PK, UUID)      │
│ email (UNIQUE)     │       │ device_code_hash   │
│ added_by_id (FK)   │       │ user_code (UNIQUE) │
│ added_at           │       │ user_id (FK)       │
│ claimed_by_id (FK) │       │ client_info (JSONB)│
│ claimed_at         │       │ status             │
│ notes              │       │ expires_at         │
└────────────────────┘       │ last_polled_at     │
                             └────────────────────┘

┌────────────────────┐
│    audit_events    │
├────────────────────┤
│ id (PK, UUID)      │
│ actor_user_id (FK) │
│ action             │
│ target_type        │
│ target_id          │
│ meta (JSONB)       │
│ created_at         │
└────────────────────┘

┌────────────────────┐       ┌────────────────────────┐
│  storage_objects   │       │ storage_object_chunks  │
├────────────────────┤       ├────────────────────────┤
│ id (PK, UUID)      │──┐    │ id (PK, UUID)          │
│ owner_id (FK)      │  │    │ object_id (FK)         │──┘
│ name               │  └───▶│ part_number            │
│ size               │       │ e_tag                  │
│ mime_type          │       │ size                   │
│ storage_key        │       │ status                 │
│ storage_provider   │       │ created_at             │
│ upload_id          │       │ completed_at           │
│ status             │       └────────────────────────┘
│ metadata (JSONB)   │
│ created_at         │
│ updated_at         │
└────────────────────┘

┌──────────────────────────────────┐       ┌────────────────────────┐
│         learner_profiles         │       │  civics_test_versions  │
├──────────────────────────────────┤       ├────────────────────────┤
│ id (PK, UUID)                    │       │ code (PK)              │
│ user_id (FK, UNIQUE)             │       │ label                  │
│ stage (enum, default uncertain)  │       │ questions_asked        │
│ interview_date                   │       │ pass_threshold         │
│ state_code                       │       │ senior_questions_asked │
│ test_version_code (FK, RESTRICT) │──────▶│ senior_pass_threshold  │
│ senior_exemption                 │       │ content_hash           │
│ daily_goal_minutes               │       │ created_at             │
│ explanation_language             │       │ updated_at             │
│ timezone                         │       └────────────────────────┘
│ orientation_completed_at         │
│ created_at                       │
│ updated_at                       │
└──────────────────────────────────┘
```

`learner_profiles` and `civics_test_versions` were added by epic #50 (issue
#61) for the journey shell: one row per user tracking onboarding progress and
the eight-stage `JourneyStage` enum, and a small seeded table of civics test
revisions a profile's `test_version_code` resolves against. Full design in
[`docs/specs/journey-shell.md`](specs/journey-shell.md) §3.

### 6.2 JSONB Schema Definitions

#### User Settings Shape

```json
{
  "theme": "light | dark | system",
  "profile": {
    "displayName": "string | null",
    "useProviderImage": true,
    "customImageUrl": "string | null"
  }
}
```

#### System Settings Shape

`system_settings.value` — the JSONB column itself — holds only `ui` and
`features`:

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "features": {
    "exampleFlag": false
  }
}
```

`GET/PUT/PATCH /api/system-settings` project this stored row into
`SystemSettingsResponseDto`, which adds a `security` block on the way out:

```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {
    "exampleFlag": false
  },
  "updatedAt": "...",
  "updatedBy": { "id": "...", "email": "..." },
  "version": 1
}
```

`security` is derived, read-only configuration — `jwtAccessTtlMinutes` and
`refreshTtlDays` are read from the `JWT_ACCESS_TTL_MINUTES` /
`JWT_REFRESH_TTL_DAYS` environment variables via `ConfigService`, not from the
database. It is never written to `system_settings.value`: the write schemas
(`updateSystemSettingsSchema` / `patchSystemSettingsSchema`) don't declare it,
so a client that sends it has the key silently stripped by the global
`ZodValidationPipe` before the request reaches the settings service.

### 6.3 Database Design Principles

| Principle | Implementation |
|-----------|---------------|
| **UUID Primary Keys** | All tables use UUID v4 for primary keys |
| **Timestamptz** | All timestamps use `timestamptz` for timezone awareness |
| **JSONB for Flexibility** | Settings stored as JSONB for schema-less extensibility |
| **Cascade Deletes** | Foreign keys cascade on user deletion |
| **Soft Deletes** | Users deactivated via `is_active` flag, not hard deleted |
| **Audit Trail** | `audit_events` table logs all security-relevant actions |

---

## 7. Security Architecture

### 7.1 Authentication Flow

```
┌─────────┐          ┌─────────┐          ┌─────────┐          ┌─────────┐
│  User   │          │ Frontend│          │   API   │          │ Google  │
└────┬────┘          └────┬────┘          └────┬────┘          └────┬────┘
     │                    │                    │                    │
     │  1. Click Login    │                    │                    │
     │───────────────────▶│                    │                    │
     │                    │                    │                    │
     │                    │ 2. Redirect to     │                    │
     │                    │    /api/auth/google│                    │
     │                    │───────────────────▶│                    │
     │                    │                    │                    │
     │                    │                    │ 3. Redirect to     │
     │◀───────────────────┼────────────────────┼────────────────────│
     │                    │                    │    Google OAuth    │
     │                    │                    │                    │
     │  4. Grant Consent  │                    │                    │
     │────────────────────┼────────────────────┼───────────────────▶│
     │                    │                    │                    │
     │                    │                    │ 5. Callback with   │
     │                    │                    │◀───────────────────│
     │                    │                    │    auth code       │
     │                    │                    │                    │
     │                    │                    │ 6. Exchange code   │
     │                    │                    │    for tokens      │
     │                    │                    │───────────────────▶│
     │                    │                    │                    │
     │                    │                    │◀───────────────────│
     │                    │                    │    User profile    │
     │                    │                    │                    │
     │                    │                    │ 7. Check allowlist │
     │                    │                    │    Provision user  │
     │                    │                    │    Generate JWT    │
     │                    │                    │    Store refresh   │
     │                    │                    │                    │
     │                    │ 8. Redirect with   │                    │
     │                    │◀───────────────────│                    │
     │                    │    access token    │                    │
     │                    │    + refresh cookie│                    │
     │                    │                    │                    │
     │ 9. Authenticated   │                    │                    │
     │◀───────────────────│                    │                    │
     │                    │                    │                    │
```

### 7.2 Token Strategy

| Token Type | Storage (Client) | Storage (Server) | Lifetime | Purpose |
|------------|-----------------|------------------|----------|---------|
| **Access Token** | Memory only | None (stateless) | 15 min | API authorization |
| **Refresh Token** | HttpOnly cookie | SHA256 hash in DB | 14 days | Obtain new access tokens |

**Security Properties:**
- Access tokens never touch localStorage (XSS protection)
- Refresh tokens in HttpOnly cookies (JavaScript cannot access)
- Refresh token rotation on each use (reuse detection)
- Database allows server-side revocation

### 7.3 RBAC Model

```
                    ┌─────────────────────────────────────────────┐
                    │                 PERMISSIONS                  │
                    ├─────────────────────────────────────────────┤
                    │ system_settings:read  │ system_settings:write│
                    │ user_settings:read    │ user_settings:write  │
                    │ users:read            │ users:write          │
                    │ rbac:manage           │ allowlist:read       │
                    │ allowlist:write       │                      │
                    └────────────┬───────────┴──────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│     ADMIN     │      │  CONTRIBUTOR  │      │    VIEWER     │
├───────────────┤      ├───────────────┤      ├───────────────┤
│ ALL           │      │ user_settings:│      │ user_settings:│
│ PERMISSIONS   │      │   read/write  │      │   read        │
│               │      │               │      │               │
│ (Full Access) │      │ (Standard     │      │ (Least        │
│               │      │  User)        │      │  Privilege)   │
└───────────────┘      └───────────────┘      └───────────────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
                                 ▼
                        ┌───────────────┐
                        │     USERS     │
                        │  (Many-to-Many│
                        │   Assignment) │
                        └───────────────┘
```

### 7.4 Access Control Layers

```
Request → Nginx → JwtAuthGuard → RolesGuard → PermissionsGuard → Controller
            │           │             │              │
            │           │             │              └── Check @Permissions()
            │           │             │                  AND logic (all required)
            │           │             │
            │           │             └── Check @Roles() decorator
            │           │                 OR logic (any role matches)
            │           │
            │           └── Validate JWT, load user+roles+permissions
            │               Check user is active
            │
            └── Security headers, rate limiting (optional)
```

### 7.5 Email Allowlist

Before OAuth authentication completes:

1. Check if email matches `INITIAL_ADMIN_EMAIL` (bypass check)
2. Check if email exists in `allowed_emails` table
3. If not found, reject with "Email not authorized"
4. If found, proceed with user provisioning
5. Mark allowlist entry as "claimed" with user ID

**Management:**
- Admins add emails via `/api/allowlist` before users can login
- Claimed entries cannot be removed (protects existing users)
- Use user deactivation (`is_active: false`) to revoke access

---

## 8. API Architecture

### 8.1 Endpoint Categories

| Category | Base Path | Auth Required | Description |
|----------|-----------|---------------|-------------|
| **Health** | `/api/health/*` | No | Liveness/readiness probes |
| **Auth** | `/api/auth/*` | Varies | OAuth, JWT, sessions |
| **Users** | `/api/users/*` | Yes (Admin) | User management |
| **Settings** | `/api/user-settings/*` | Yes | User preferences |
| **System Settings** | `/api/system-settings/*` | Yes (Admin) | App configuration |
| **Allowlist** | `/api/allowlist/*` | Yes (Admin) | Access control |
| **Journey** | `/api/journey/*` | Yes | Learner profile, home screen, stage registry (epic #50) |
| **Readiness** | `/api/readiness*` | Yes | Snapshotted readiness score, history, Progress Guide narrative (epic #55) |

### 8.2 Complete Endpoint Reference

#### Authentication Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/auth/providers` | Public | List enabled OAuth providers |
| `GET` | `/api/auth/google` | Public | Initiate Google OAuth |
| `GET` | `/api/auth/google/callback` | Public | OAuth callback handler |
| `POST` | `/api/auth/refresh` | Cookie | Refresh access token |
| `POST` | `/api/auth/logout` | JWT | Single session logout |
| `POST` | `/api/auth/logout-all` | JWT | All sessions logout |
| `GET` | `/api/auth/me` | JWT | Current user info |
| `POST` | `/api/auth/test/login` | Public | Test login bypass (dev only) |

#### Device Authorization (RFC 8628)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/auth/device/code` | Public | Generate device code |
| `POST` | `/api/auth/device/token` | Public | Poll for authorization |
| `GET` | `/api/auth/device/activate` | JWT | Get activation info |
| `POST` | `/api/auth/device/authorize` | JWT | Approve/deny device |
| `GET` | `/api/auth/device/sessions` | JWT | List device sessions |
| `DELETE` | `/api/auth/device/sessions/:id` | JWT | Revoke device session |

#### User Management (Admin)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/users` | `users:read` | List users (paginated) |
| `GET` | `/api/users/:id` | `users:read` | Get user details |
| `PATCH` | `/api/users/:id` | `users:write` | Update user |
| `PUT` | `/api/users/:id/roles` | `rbac:manage` | Update user roles |

#### Settings

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/user-settings` | `user_settings:read` | Get user settings |
| `PUT` | `/api/user-settings` | `user_settings:write` | Replace settings |
| `PATCH` | `/api/user-settings` | `user_settings:write` | Partial update |
| `GET` | `/api/system-settings` | `system_settings:read` | Get system settings |
| `PUT` | `/api/system-settings` | `system_settings:write` | Replace settings |
| `PATCH` | `/api/system-settings` | `system_settings:write` | Partial update |

#### Allowlist (Admin)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/allowlist` | `allowlist:read` | List allowlisted emails |
| `POST` | `/api/allowlist` | `allowlist:write` | Add email |
| `DELETE` | `/api/allowlist/:id` | `allowlist:write` | Remove email (if pending) |

#### Journey (Per User)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/journey/profile` | `@Auth()`, no permissions | Caller's profile + test versions + states (lazily creates the row) |
| `PUT` | `/api/journey/profile` | `@Auth()`, no permissions | Merge-update the caller's profile; orientation completion is server-inferred |
| `GET` | `/api/journey/home` | `@Auth()`, no permissions | Stage, interview countdown, daily-goal placeholder, next action |
| `GET` | `/api/journey/stages` | `@Auth()`, no permissions | The eight journey stages, in order |

No route takes a user id anywhere — path, query, or body — so there is no
permission that could gate "read/write *any* learner's profile" to add;
`docs/specs/journey-shell.md` §4.1 and §5 have the full argument, mirrored by
CLAUDE.md's RBAC Model section.

#### Readiness (Per User)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/readiness` | `@Auth()`, no permissions | The caller's latest snapshot, lazily (re)computed if none exists or the latest is stale |
| `GET` | `/api/readiness/history` | `@Auth()`, no permissions | The caller's past snapshots, paginated, newest first |

Same posture as Journey/Practice/Progress above — no route takes a user id,
so there is no permission to add. See
[`docs/specs/readiness-model.md`](specs/readiness-model.md) §6 and §5.5
above for the architectural shape.

#### Engagement (Per User)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/engagement/summary` | `@Auth()`, no permissions | The caller's daily goal, streak and freeze budget, after this request's own settlement pass |

Same posture as Journey/Practice/Progress/Readiness above — no route takes
a user id, so there is no permission to add. See
[`docs/specs/habit-streaks.md`](specs/habit-streaks.md) §4.6 and §5.6 above
for the architectural shape.

#### Health

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/health` | Public | Full health check |
| `GET` | `/api/health/live` | Public | Liveness probe |
| `GET` | `/api/health/ready` | Public | Readiness probe (+ DB) |

### 8.3 Response Format

#### Success Response

```json
{
  "data": {
    // Response payload
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

#### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest",
  "details": {
    // Additional context
  }
}
```

---

## 9. Frontend Architecture

### 9.1 Page Structure

As of epic #90, the admin console and the per-user settings surface are each
a single registry-driven **hub** with one route per card, rather than a
tab-strip page per area. See
[`docs/specs/settings-ui.md`](specs/settings-ui.md) for the full pattern —
the registry, the shared `SettingsHub` component, and why tabs are reserved
for genuinely parallel content only.

| Page | Route | Auth | Permission | Purpose |
|------|-------|------|------------|---------|
| Login | `/login` | Public | - | OAuth provider selection |
| Auth Callback | `/auth/callback` | Public | - | Token handling |
| AI Key Setup | `/setup/ai-key` | Required | Any (authenticated) | `RequireAiKey`'s exempt destination; blocks a user with no saved AI key |
| Orientation | `/setup/journey` | Required | Any (authenticated) | `RequireOrientation`'s exempt destination; blocks a learner who has not finished onboarding |
| Home | `/` | Required | Any | The four-destination bar's first stop — stage, countdown, next action (epic #50) |
| Learn | `/learn` | Required | Any | Bar destination (epic #50) |
| Practice | `/practice` | Required | Any | Bar destination (epic #50) |
| Progress | `/progress` | Required | Any | Bar destination (epic #50) |
| User Settings hub | `/settings` | Required | Any (authenticated) | Searchable hub over the user's own settings |
| — Profile | `/settings/profile` | Required | Any (authenticated) | Display name, avatar, email |
| — Appearance | `/settings/appearance` | Required | Any (authenticated) | Personal theme preference |
| — Access Tokens | `/settings/tokens` | Required | Any (authenticated) | Personal access token management |
| Console / Settings hub | `/admin/settings` | Required | `system_settings:read` OR `users:read` | Searchable hub over admin settings |
| — System | `/admin/settings/general` | Required | `system_settings:read` | Core system settings |
| — Appearance | `/admin/settings/appearance` | Required | `system_settings:read` | Default theme for new users |
| — Feature Flags | `/admin/settings/feature-flags` | Required | `system_settings:read` | Toggle optional features |
| — Advanced (JSON) | `/admin/settings/advanced` | Required | `system_settings:write` | Raw settings document editor |
| — Users & Allowlist | `/admin/settings/users` | Required | `users:read` | User accounts, roles, and allowlist |
| `/admin` (redirect) | `/admin` | Required | — | `<Navigate replace>` to `/admin/settings` |
| `/admin/users` (redirect) | `/admin/users` | Required | — | `<Navigate replace>` to `/admin/settings/users` |
| Device Activation | `/activate` | Required | Any | Device auth approval |
| Test Login | `/testing/login` | Public | - | Test auth bypass (dev only) |

**Note:** The `/testing/login` route is excluded from production builds via `import.meta.env.PROD` check.

**Note:** The two redirect routes are real `<Route>` entries in `App.tsx`, not
catch-all fallout — a bookmarked `/admin/users` resolves via `<Navigate
replace>` rather than falling through to the `*` fallback and landing
silently on `/`.

### 9.2 Context Providers

```tsx
<App>
  <ThemeProvider>        {/* MUI theme + dark mode */}
    <AuthProvider>       {/* Authentication state */}
      <SettingsProvider> {/* User settings */}
        <RouterProvider> {/* React Router */}
          <Layout>
            <Pages />
          </Layout>
        </RouterProvider>
      </SettingsProvider>
    </AuthProvider>
  </ThemeProvider>
</App>
```

### 9.3 Authentication State

```typescript
interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  accessToken: string | null;
  login: (provider: string) => void;
  logout: () => Promise<void>;
  refreshToken: () => Promise<void>;
}
```

### 9.4 Protected Routes

Route-level **authorization**, not just authentication, is enforced with
`RequirePermission` (`apps/web/src/components/common/RequirePermission.tsx`),
wrapped around the page element inside the `<Route>`. `ProtectedRoute` above
it in the tree only establishes that someone is signed in; `RequirePermission`
is what denies the page itself to a signed-in user who lacks the permission,
rather than letting them land on the page and watch every API call return
`403`.

`RequirePermission` accepts `permission` (single string), `permissions`
(array, OR'd unless `requireAll` is set), `role`, `roles`, and a `fallback`
to render when the check fails. The real pattern, taken directly from
`apps/web/src/App.tsx`'s `/admin/settings/users` route:

```tsx
<Route
  path="/admin/settings/users"
  element={
    <RequirePermission permission="users:read" fallback={<Navigate to="/" replace />}>
      <AdminUsersPage />
    </RequirePermission>
  }
/>
```

The permission named here is the same string the card declares in
`config/adminSections.tsx` and the same string `users.controller.ts`
enforces — so the hub card, the Console rail row, and the route itself
cannot disagree about who may go where. See
[`docs/specs/settings-ui.md`](specs/settings-ui.md) for the full registry
pattern this route belongs to.

### 9.5 Navigation & the Destination Model

`apps/web/src/config/destinations.ts` is the **single source of truth** for
the app's navigation targets — which routes exist, which one owns a given
path, and which permission (if any) makes it reachable. Before it existed the
same routes were spelled out separately in the rail, the bottom bar, the user
menu, and quick actions, each with its own idea of who could see them; the
file's own header calls this the "three gates, three answers" failure.

Two structures live in that one file, and epic #50 (issue #69) is what pulled
them apart:

- **`DESTINATION_ROUTES`** — six keys (`home`, `learn`, `practice`,
  `progress`, `settings`, `console`), answering "what lights up" (which
  destination is active for a given path). All six routes are still real and
  still owned by exactly one destination.
- **`DESTINATIONS`** — exactly **four** entries (`home`, `learn`, `practice`,
  `progress`), answering "what is in the bar" the learner uses day to day.
  `settings` and `console` keep their keys and route ownership but are no
  longer bar destinations; they are exported individually
  (`SETTINGS_DESTINATION` for the user menu, `RAIL_PINNED_DESTINATIONS` for
  the rail's pinned foot) so the one surface that still draws each has to name
  it explicitly.

None of the four bar destinations carries a `permission` — an unoriented,
keyless, freshly created account still needs to see all four. Whether a
*destination* exists to navigate to and whether the *route* behind it is
reachable are different questions: `RequireAiKey` and `RequireOrientation`
(both layout routes wrapping `<Outlet />` in `App.tsx`) answer the second one,
hard-blocking a user who has not cleared onboarding regardless of what the bar
shows. Full rationale, including the accepted UX cost on narrow screens, is in
[`docs/specs/journey-shell.md`](specs/journey-shell.md) §2 and §5.

### 9.6 The Journey Stage Registry Lives in the API

The eight journey stages (`apps/api/src/journey/journey-stages.ts`,
`JOURNEY_STAGES`) are declared once, in the API, and the web reads them over
`GET /api/journey/stages` — **there is no copy of this list in
`apps/web/src/config`.** This is the same one-registry choice
`apps/api/src/notifications/notification-events.ts` and
`apps/api/src/ai/ai-model-roles.ts` make on their own axes: a duplicated list
with a test asserting the two agree only *detects* drift after it has already
happened in a working tree, a branch, or a build where the test did not run —
it does not prevent it. `docs/specs/journey-shell.md` §11 records the
duplicate-in-`apps/web` alternative and why it lost.

---

## 10. Infrastructure Architecture

### 10.1 Docker Services

```yaml
# Core Services (base.compose.yml)
services:
  nginx:        # Reverse proxy (port 3535)
  api:          # NestJS backend (port 3000)
  web:          # React frontend (port 5173)

# PostgreSQL is not bundled in base.compose.yml - it runs as a separate
# instance reached via POSTGRES_HOST/POSTGRES_PORT (see infra/compose/.env.example)

# Observability (otel.compose.yml)
services:
  otel-collector:  # OpenTelemetry Collector
  uptrace:         # Trace/metric visualization (port 14318)
  clickhouse:      # Uptrace storage backend
```

### 10.2 Network Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network                           │
│                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                  │
│  │  nginx  │───▶│   api   │    │   web   │                  │
│  │  :3535  │    │  :3000  │    │  :5173  │                  │
│  │         │────┼─────────┼───▶│         │                  │
│  └────┬────┘    └────┬────┘    └─────────┘                  │
│       │              │                                      │
│       │              ▼                                      │
│       │         ┌─────────┐                                 │
│       │         │  otel   │   (only with otel.compose.yml)  │
│       │         │collector│                                 │
│       │         └────┬────┘                                 │
│       │              ▼                                      │
│       │         ┌─────────┐    ┌──────────┐                 │
│       │         │ uptrace │───▶│clickhouse│                 │
│       │         │ :14318  │    │          │                 │
│       │         └─────────┘    └──────────┘                 │
└───────┼─────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
   External Access              External PostgreSQL
   http://localhost:3535        (POSTGRES_HOST / POSTGRES_PORT)
```

**PostgreSQL is not part of the Compose stack.** The `api` service connects out
to a database you provide via the `POSTGRES_*` variables. No Compose file
starts a Postgres container for tests — API tests never touch a database at
all (Prisma is mocked in full; see `apps/api/TESTING.md`).

### 10.3 Environment Configuration

Key environment variables (see `infra/compose/.env.example`):

```bash
# Application
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3535

# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=oathpath

# JWT
JWT_SECRET=<min-32-character-secret>
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=14

# OAuth
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback

# Admin Bootstrap
INITIAL_ADMIN_EMAIL=admin@example.com

# Observability
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

---

## 11. Observability Architecture

### 11.1 Signal Types

| Signal | Collection | Storage | Purpose |
|--------|------------|---------|---------|
| **Traces** | OTEL SDK auto-instrumentation | Uptrace/ClickHouse | Request flow tracking |
| **Metrics** | OTEL SDK | Uptrace/ClickHouse | Performance monitoring |
| **Logs** | Pino structured logs | Uptrace/ClickHouse | Debugging, audit |

### 11.2 Trace Propagation

```
Request → Nginx → API → Database
   │         │       │       │
   └─────────┴───────┴───────┴──▶ trace_id: abc123
                                  spans: [nginx, api, db-query]
```

### 11.3 Log Correlation

```json
{
  "level": "info",
  "time": 1704067200000,
  "msg": "User logged in",
  "requestId": "req-123",
  "traceId": "abc123",
  "spanId": "span456",
  "userId": "user-789"
}
```

### 11.4 Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/api/health/live` | Kubernetes liveness | Process running |
| `/api/health/ready` | Kubernetes readiness | Process + DB connection |

---

## 12. Testing Architecture

### 12.1 Testing Strategy Overview

The project uses a **mocked database approach** for all tests by default. This provides fast, isolated tests without requiring a running PostgreSQL instance.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TESTING ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  BACKEND (apps/api/)                    FRONTEND (apps/web/)            │
│  ┌─────────────────────────────┐       ┌─────────────────────────────┐  │
│  │  Jest + Supertest           │       │  Vitest + RTL               │  │
│  │                             │       │                             │  │
│  │  Unit Tests (*.spec.ts)     │       │  Component Tests            │  │
│  │  • Co-located with source   │       │  (*.test.tsx)               │  │
│  │  • Mock all dependencies    │       │  • In __tests__/ folder     │  │
│  │                             │       │  • MSW for API mocking      │  │
│  │  Integration Tests          │       │                             │  │
│  │  (*.integration.spec.ts)    │       │  Context Tests              │  │
│  │  • In test/ directory       │       │  • AuthContext              │  │
│  │  • Full HTTP cycle          │       │  • ThemeContext             │  │
│  │  • Mocked PrismaService     │       │                             │  │
│  │                             │       │                             │  │
│  │  Mocking:                   │       │  Mocking:                   │  │
│  │  • jest-mock-extended       │       │  • MSW (Mock Service Worker)│  │
│  │  • DeepMockProxy<Prisma>    │       │  • vi.fn() for functions    │  │
│  └─────────────────────────────┘       └─────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 12.2 Backend Test Structure

```
apps/api/
├── src/
│   ├── auth/
│   │   ├── auth.service.spec.ts          # Unit test (co-located)
│   │   ├── auth.controller.spec.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.spec.ts
│   │   │   ├── roles.guard.spec.ts
│   │   │   └── permissions.guard.spec.ts
│   │   └── strategies/
│   │       ├── jwt.strategy.spec.ts
│   │       └── google.strategy.spec.ts
│   ├── users/
│   │   └── users.service.spec.ts
│   ├── settings/
│   │   ├── user-settings/
│   │   │   └── user-settings.service.spec.ts
│   │   └── system-settings/
│   │       └── system-settings.service.spec.ts
│   └── common/
│       ├── filters/http-exception.filter.spec.ts
│       └── interceptors/transform.interceptor.spec.ts
│
└── test/
    ├── jest.config.js                    # Jest configuration
    ├── setup.ts                          # Global test setup
    ├── teardown.ts                       # Global cleanup
    ├── helpers/
    │   ├── test-app.helper.ts            # Creates test NestJS app
    │   ├── auth-mock.helper.ts           # Creates mock users with JWTs
    │   └── fixtures.helper.ts            # Test data utilities
    ├── fixtures/
    │   ├── users.fixture.ts              # User test data
    │   ├── roles.fixture.ts              # Role test data
    │   ├── settings.fixture.ts           # Settings test data
    │   ├── test-data.factory.ts          # Factory functions
    │   └── mock-setup.helper.ts          # Base mock configuration
    ├── mocks/
    │   ├── prisma.mock.ts                # Mocked PrismaService
    │   └── google-oauth.mock.ts          # Mocked OAuth strategy
    ├── auth/
    │   ├── auth.integration.spec.ts      # Auth endpoint tests
    │   ├── oauth.integration.spec.ts     # OAuth flow tests
    │   └── allowlist-enforcement.integration.spec.ts
    ├── rbac/
    │   ├── rbac.integration.spec.ts
    │   └── guard-integration.integration.spec.ts
    ├── settings/
    │   ├── user-settings.integration.spec.ts
    │   └── system-settings.integration.spec.ts
    ├── users.integration.spec.ts
    ├── health/
    │   └── health.integration.spec.ts
    └── integration/
        └── device-auth.integration.spec.ts
```

### 12.3 Backend Mocking Strategy

#### Prisma Mocking with jest-mock-extended

All backend tests use a **mocked PrismaService** via `jest-mock-extended`:

```typescript
// test/mocks/prisma.mock.ts
import { DeepMockProxy, mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

export type MockPrismaClient = DeepMockProxy<PrismaClient>;
export const prismaMock: MockPrismaClient = mockDeep<PrismaClient>();

export function resetPrismaMock(): void {
  mockReset(prismaMock);
}
```

#### Test App Helper

The `createTestApp()` helper creates a fully configured NestJS application with mocked database:

```typescript
// test/helpers/test-app.helper.ts
export async function createTestApp(
  options: { useMockDatabase?: boolean } = {}
): Promise<TestContext> {
  const shouldUseMock = options.useMockDatabase ?? true;  // Default: MOCKED

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)  // Inject mock instead of real Prisma
    .compile();

  // ... app configuration
  return { app, prisma, prismaMock, module, isMocked: true };
}
```

#### Integration Test Pattern

```typescript
// test/auth/auth.integration.spec.ts
describe('Auth Controller (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();      // Clear all mock calls
    setupBaseMocks();        // Set up default mock responses
  });

  it('should return current user for authenticated request', async () => {
    const user = await createMockTestUser(context);  // Creates user + JWT

    const response = await request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: user.id,
      email: user.email,
    });
  });
});
```

### 12.4 Frontend Test Structure

```
apps/web/src/
└── __tests__/
    ├── setup.ts                          # Vitest setup (MSW, mocks)
    ├── mocks/
    │   ├── server.ts                     # MSW server instance
    │   ├── handlers.ts                   # API mock handlers
    │   └── data.ts                       # Mock response data
    ├── utils/
    │   ├── test-utils.tsx                # Custom render with providers
    │   ├── mock-providers.tsx            # Test provider wrappers
    │   └── hook-utils.tsx                # Hook testing utilities
    ├── components/
    │   ├── common/
    │   │   ├── LoadingSpinner.test.tsx
    │   │   └── ProtectedRoute.test.tsx
    │   ├── navigation/
    │   │   ├── AppBar.test.tsx
    │   │   ├── Sidebar.test.tsx
    │   │   └── UserMenu.test.tsx
    │   └── admin/
    │       ├── UserList.test.tsx
    │       ├── AllowlistTable.test.tsx
    │       └── AddEmailDialog.test.tsx
    ├── contexts/
    │   ├── AuthContext.test.tsx
    │   └── ThemeContext.test.tsx
    ├── pages/
    │   ├── LoginPage.test.tsx
    │   ├── UserSettingsPage.test.tsx
    │   └── SystemSettingsPage.test.tsx
    └── services/
        └── api.test.ts
```

### 12.5 Frontend Mocking Strategy

#### MSW (Mock Service Worker)

API calls are intercepted at the network level using MSW:

```typescript
// __tests__/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/auth/me', () => {
    return HttpResponse.json({
      data: {
        id: 'user-1',
        email: 'test@example.com',
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
      },
    });
  }),

  http.get('/api/auth/providers', () => {
    return HttpResponse.json({
      data: {
        providers: [{ name: 'google', displayName: 'Google' }],
      },
    });
  }),

  http.post('/api/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

#### Test Setup

```typescript
// __tests__/setup.ts
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, afterAll, vi } from 'vitest';
import { server } from './mocks/server';

// Browser API mocks
Object.defineProperty(window, 'matchMedia', { /* ... */ });
global.ResizeObserver = class ResizeObserverMock { /* ... */ };

// MSW lifecycle
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());
```

#### Custom Render with Providers

```typescript
// __tests__/utils/test-utils.tsx
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { AuthProvider } from '../../contexts/AuthContext';

export function renderWithProviders(ui: React.ReactElement, options = {}) {
  return render(ui, {
    wrapper: ({ children }) => (
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    ),
    ...options,
  });
}
```

### 12.6 Test Commands

#### Backend

```bash
cd apps/api

npm test                    # Run all tests (unit + integration)
npm run test:unit           # Unit tests only (excludes e2e pattern)
npm run test:watch          # Watch mode
npm run test:cov            # With coverage report
npm run test:debug          # Debug mode with inspector
npm run test:ci             # CI mode (coverage + JUnit reporter)
```

#### Frontend

```bash
cd apps/web

npm test                    # Run tests in watch mode
npm run test:run            # Run once and exit
npm run test:watch          # Interactive watch mode
npm run test:coverage       # With coverage report
npm run test:ui             # Open Vitest UI (browser-based)
npm run test:ci             # CI mode (coverage + JUnit reporter)
```

### 12.7 Test Configuration

#### Backend (Jest)

```javascript
// apps/api/test/jest.config.js
module.exports = {
  testRegex: '.*\\.spec\\.ts$',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testTimeout: 30000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
```

#### Frontend (Vitest)

```typescript
// apps/web/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      thresholds: {
        lines: 70, branches: 70, functions: 70, statements: 70,
      },
    },
    testTimeout: 10000,
  },
});
```

### 12.8 Key Testing Patterns

| Pattern | Backend | Frontend |
|---------|---------|----------|
| **Database** | Mocked via jest-mock-extended | N/A |
| **API Calls** | Direct HTTP via Supertest | MSW network interception |
| **Authentication** | Mock JWT tokens generated | MSW handlers return user |
| **Test Isolation** | `resetPrismaMock()` in beforeEach | `server.resetHandlers()` in afterEach |
| **Async Handling** | `async/await` with Jest | `waitFor()` from RTL |
| **User Interactions** | N/A | `userEvent` from @testing-library |

### 12.9 Important Notes

1. **No Real Database Required**: All tests run with mocked Prisma - no PostgreSQL needed
2. **Test File Naming**:
   - Backend unit: `*.spec.ts` (co-located with source)
   - Backend integration: `*.integration.spec.ts` (in test/ directory)
   - Frontend: `*.test.tsx` (in __tests__/ directory)
3. **Coverage Thresholds**: Frontend enforces 70% minimum coverage
4. **MSW Strict Mode**: Unhandled API requests fail tests (`onUnhandledRequest: 'error'`)
5. **Type Safety**: Prisma mocks are fully typed via `DeepMockProxy<PrismaClient>`

---

## 13. Agent-Based Development Model

### 13.1 Specialized Agents

This project uses specialized AI coding agents for different domains:

| Agent | File | Domain | Responsibilities |
|-------|------|--------|------------------|
| `backend-dev` | `.claude/agents/backend-dev.md` | API Layer | NestJS controllers, services, guards, OAuth, JWT |
| `frontend-dev` | `.claude/agents/frontend-dev.md` | UI Layer | React components, pages, hooks, MUI theming |
| `database-dev` | `.claude/agents/database-dev.md` | Data Layer | Prisma schema, migrations, seeds, queries |
| `testing-dev` | `.claude/agents/testing-dev.md` | Quality | Jest, Supertest, Vitest, RTL, type checking |
| `docs-dev` | `.claude/agents/docs-dev.md` | Documentation | Architecture, API, security docs |

### 13.2 Agent Invocation Rules

**MANDATORY**: All development tasks MUST be delegated to the appropriate agent.

| Task Type | Required Agent | Example |
|-----------|---------------|---------|
| Add API endpoint | `backend-dev` | "Implement user search endpoint" |
| Create component | `frontend-dev` | "Build user avatar component" |
| Schema change | `database-dev` | "Add email verification table" |
| Write tests | `testing-dev` | "Add integration tests for auth" |
| Update docs | `docs-dev` | "Document new endpoint in API.md" |

### 13.3 Multi-Agent Workflow

For features spanning multiple domains, invoke agents sequentially:

```
Feature: "Add user notification preferences"

1. database-dev  → Add preferences to user_settings schema
2. backend-dev   → Implement API endpoints
3. frontend-dev  → Build settings UI
4. testing-dev   → Write tests for all layers
5. docs-dev      → Update documentation
```

### 13.4 Agent Context

Each agent has full context of:
- System specification document
- Technology stack requirements
- Code patterns and conventions
- Security requirements
- Testing standards

### 13.5 Orchestration Responsibilities

The orchestrating agent (Claude) handles:
- Reading files to understand context
- Answering questions about the codebase
- Planning and coordinating between agents
- Running simple commands (git, npm)
- Reviewing agent outputs

**What NOT to do directly:**
- Write NestJS code (use `backend-dev`)
- Create React components (use `frontend-dev`)
- Modify Prisma schema (use `database-dev`)
- Write tests (use `testing-dev`)
- Update documentation (use `docs-dev`)

---

## 14. Development Workflows

### 14.1 Local Development Setup

```bash
# 1. Clone repository
git clone <repository-url>
cd oathpath

# 2. Configure environment
cp infra/compose/.env.example infra/compose/.env
# Edit .env with your Google OAuth credentials

# 3. Start services
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up

# 4. Seed database (first time only)
docker compose exec api sh
cd /app/apps/api && npx tsx prisma/seed.ts
exit

# 5. Access application
# UI: http://localhost:3535
# API: http://localhost:3535/api
# API reference: http://localhost:3535/api/docs
```

### 14.2 Database Changes

```bash
# 1. Modify schema
# Edit apps/api/prisma/schema.prisma

# 2. Create migration
cd apps/api
npm run prisma:migrate:dev -- --name descriptive_name

# 3. Generate client
npm run prisma:generate

# 4. Update seeds if needed
# Edit apps/api/prisma/seed.ts
```

### 14.3 Adding New Features

1. **Plan**: Identify which agents are needed
2. **Database**: Schema changes via `database-dev`
3. **Backend**: API implementation via `backend-dev`
4. **Frontend**: UI implementation via `frontend-dev`
5. **Testing**: Test coverage via `testing-dev`
6. **Documentation**: Updates via `docs-dev`

### 14.4 Testing

See [Section 12: Testing Architecture](#12-testing-architecture) for comprehensive testing documentation.

```bash
# Backend tests (all use mocked database)
cd apps/api
npm test                    # All tests (unit + integration)
npm run test:watch          # Watch mode
npm run test:cov            # With coverage

# Frontend tests
cd apps/web
npm test                    # Watch mode
npm run test:run            # Run once
npm run test:coverage       # With coverage
npm run test:ui             # Visual Vitest UI

# Type checking
cd apps/api && npm run typecheck
cd apps/web && npm run typecheck
```

---

## 15. Appendices

### 15.1 Quick Reference

#### Service URLs (Development)

| Service | URL |
|---------|-----|
| Application | http://localhost:3535 |
| API Reference (Scalar) | http://localhost:3535/api/docs |
| Uptrace | http://localhost:14318 |
| PostgreSQL | localhost:5432 |

#### Key Commands

```bash
# Start dev environment
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start with observability
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Run migrations
cd apps/api && npm run prisma:migrate:dev -- --name <name>

# Generate Prisma client
cd apps/api && npm run prisma:generate

# Run tests
cd apps/api && npm test
cd apps/web && npm test
```

### 15.2 Related Documents

| Document | Purpose |
|----------|---------|
| [System_Specification_Document.md](System_Specification_Document.md) | Full system requirements |
| [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) | Detailed security documentation |
| [API.md](API.md) | API endpoint reference |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Development guide |
| [TESTING.md](TESTING.md) | Testing framework guide |
| [DEVICE-AUTH.md](DEVICE-AUTH.md) | Device authorization guide |
| [CLAUDE.md](../CLAUDE.md) | AI assistant guidance |

### 15.3 Specification Index

Implementation specs in `docs/specs/`:

| Phase | Specs | Description |
|-------|-------|-------------|
| Foundation | 01-03 | Project setup, database schema, seeds |
| API Core | 04-07 | NestJS setup, OAuth, JWT, RBAC |
| API Features | 08-12 | Users, settings, health, observability |
| Frontend | 13-18 | React setup, pages, components |
| Testing | 19-24 | Test frameworks, unit/integration tests |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | AI Assistant | Initial comprehensive architecture document |
