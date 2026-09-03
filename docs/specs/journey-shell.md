# Design Spec: Journey shell (navigation, learner profile, orientation)

This is the durable design for E1 — the journey shell: the four-destination
navigation bar, the `learner_profiles` table and its stage machine, the
orientation screen that populates it, and the deterministic `nextAction`
contract Home renders. Every later epic in the roadmap (E2–E11) either adds a
destination's real content behind a stub this epic ships, or moves a
learner's `stage` forward through a transition this epic does not itself
implement. An epic and its child issues link here instead of restating the
design — read this first, then the issue you were sent to implement.

Source of truth for every claim below:

- `ROADMAP.md` §2–§4, §7 ("Cross-cutting rules"), and the decision-log entries
  dated 2026-09-02 — the epic table, the dependency reasoning, the
  registry/permission/no-job-queue/mobile-first rules every epic inherits,
  and the specific journey-stage and four-destination decisions this document
  locks in.
- `VISION.md` — "The Journey to Readiness" (the eight-stage sequence and why
  it must not be decorative), "The AI Personality" (the tone every string in
  §7–§9 below is reviewed against), and "Trust Is a Feature" (the footer in
  §9.3).
- `CLAUDE.md`'s Settings UI Pattern — the registry-card rule this document's
  destination and stage registries follow on their own two axes, and the five
  coupled `sm` breakpoint gates §2 below does not touch but must not break.
- `apps/web/src/config/destinations.ts` — the current three-destination
  table (`home`, `settings`, `console`), `owns`/`resolveActiveDestination`'s
  segment-boundary matching, `isDestinationVisible`, and the `pinned` idiom
  `console` already uses — the exact machinery §2 extends to four bar
  destinations.
- `apps/web/src/__tests__/config/destinations.test.ts` — the live test that
  reads `App.tsx`'s route list and enforces `DESTINATIONS.length <= 4`; the
  hard ceiling this document does not reopen.
- `apps/web/src/components/navigation/BottomNav.tsx`,
  `apps/web/src/components/navigation/UserMenu.tsx`, and
  `apps/web/src/components/navigation/NavigationRail.tsx` — the three
  surfaces that read `DESTINATIONS` today; `NavigationRail.tsx` is the only
  one that currently treats `pinned` as anything other than declaration
  order (its `listDestinations`/`pinnedDestinations` split), which is the gap
  §2.2 closes.
- `apps/web/src/components/common/ProtectedRoute.tsx` — the outermost
  authentication gate (`user` present or `/login`), which both `RequireAiKey`
  and this document's `RequireOrientation` sit inside.
- `apps/web/src/components/common/RequireAiKey.tsx` — the gate
  `RequireOrientation` mirrors line for line: fail-open on a failed status
  check, the three-item exemption list, the admin exemption keyed on a
  permission rather than a role, and the `state.from` / `replace` redirect
  shape.
- `apps/web/src/contexts/AiStatusContext.tsx` — the "fetched once, read
  everywhere" idiom `LearnerProfileContext` (§5) copies: mounted above both
  the gate and its exempt setup screen, refreshed only on a known change,
  and fail-open on error.
- `apps/web/src/pages/AiKeySetupPage.tsx` — the worked example of the tone
  and layout every string in §7 is reviewed against, and of "do not trap the
  user" (sign-out always reachable on a full-screen setup route).
- `apps/web/src/App.tsx` — where `AiStatusProvider`, `/setup/ai-key`, and
  `RequireAiKey` are actually composed inside `ProtectedRoute`; §5 slots
  `LearnerProfileProvider`, `/setup/journey`, and `RequireOrientation`
  into this exact tree.
- `apps/api/src/notifications/notification-events.ts` — the one-registry
  idiom and its option-1 reasoning (the API owns the registry; the web reads
  it over an endpoint), which §6 applies to journey stages. Its
  `eventKey`/`channel`-as-plain-string reasoning is the CONTRAST case §3.2 and
  §11 draw against, not a pattern `stage` copies — see below.
- `apps/api/src/ai/ai-model-roles.ts` — the second worked example of the same
  one-registry idiom, including the "web reads over an endpoint, never a
  duplicate" reasoning cited again in §6.
- `apps/api/src/common/constants/roles.constants.ts` — the complete,
  closed permission set. Nothing in this document adds to it.
- `apps/api/prisma/schema.prisma` — `UserSettings` (the `userId @unique …
  onDelete: Cascade` shape `learner_profiles` copies), `Credential` and
  `AiUsageEvent` (the `@db.Uuid` / `@map` / `@db.Timestamptz` conventions a
  new table follows), and `NotificationDelivery.eventKey` /
  `.channel`'s comments (why registry-owned string columns are plain
  `String`, never a Postgres enum, immediately above `AiUsageEvent`).
- `apps/api/src/test-auth/guards/test-environment.guard.ts` — the
  non-production-only gate pattern the `Clock` provider's `X-Test-Clock`
  header (ROADMAP §7) reuses, referenced briefly in §4.4.

**Nothing described past this line exists yet.** There is no
`apps/web/src/config/destinations.ts` fourth destination, no
`learner_profiles` or `civics_test_versions` table, no `/api/journey/*`
route, no `RequireOrientation`, no `/setup/journey`, no `/learn`,
`/practice`, or `/progress` page, and no `Clock` provider anywhere in the
repository. This document is what E1's child issues build *against*, not a
description of code already in the repository. Every fact cited above about
the *existing* codebase has been verified against the files named; the
*proposed* architecture in every other section is a design, and a child
issue is free to find a better answer to a specific sub-problem as long as
it keeps the contracts this document promises to the epics around it — the
eight stage keys, the four-destination ceiling, the `nextAction` shape, and
the gate-ordering invariant.

---

## 1. The eight journey stages

`VISION.md`'s "Journey to Readiness" names the sequence — Uncertain →
Oriented → Learning → Remembering → Speaking → Practicing → Performing →
Ready — and is explicit that it "must never create the impression that a
user is ready simply because they completed a handful of questions
correctly." ROADMAP.md's 2026-09-02 decision log assigns every transition
between these eight values to the epic whose evidence justifies it, so that
none of them is a label nothing ever sets:

| # | `key` | Label | Description (user-facing) | Entered when | Owning epic |
|---|---|---|---|---|---|
| 1 | `uncertain` | Just starting | "You're just getting started — that's the whole point of being here." | Initial value at account creation. | *(none — initial state)* |
| 2 | `oriented` | Oriented | "You've told us where you stand, so we can show you the right test and a real countdown." | The orientation screen (§7) is completed and `orientation_completed_at` is set. | **E1 (#61)** — the only transition reachable in E1 |
| 3 | `learning` | Learning | "You're meeting the material for the first time." | The spaced-repetition scheduler begins tracking questions for this learner. | E5 (#54) |
| 4 | `remembering` | Remembering | "Answers are starting to stick." | A question has been verified as mastered — correct on 3 or more distinct days. | E5 (#54) |
| 5 | `speaking` | Speaking | "You're practicing saying answers out loud, not just typing them." | Real spoken-answer evidence exists — impossible before spoken practice ships. **Deliberately not reversible**: readiness already decays on its own, and demoting a visible stage for a quiet week is the discouragement `VISION.md` rules out. | E9 (#58) |
| 6 | `practicing` | Practicing | "You're building real, repeated evidence toward the interview." | Readiness signals (E6) show sustained practice, spoken evidence included. | E6 (#55) |
| 7 | `performing` | Performing | "You're consistently doing well, including under realistic conditions." | E6 moves a learner from `practicing` to `performing`. | E6 (#55) |
| 8 | `ready` | Ready | "The evidence says you're ready." | The readiness score clears its threshold **and** the typed-only cap has lifted — a learner can never reach `ready` on typed answers alone. Reaching it is not an ending: the score can still fall. | E6 (#55) |

Two things this table states plainly rather than leaving implicit:

**`oriented` is the only transition E1 implements.** Every row past it is
documentation for the epics that own it, not work this issue does. A child
issue in E1 that finds itself writing code to move a profile past `oriented`
has picked up someone else's transition.

**`stage` IS a Postgres enum, `JourneyStage`** — the eight values above, in
journey order, default `uncertain` — and deliberately not the plain-string
registry idiom `apps/api/prisma/schema.prisma`'s comment describes for
`NotificationDelivery.eventKey`. The two look similar (both are a small,
named set a registry also describes) but the axis that decides the column
type is whether the set is OPEN or CLOSED, and they sit on opposite sides of
it: `eventKey` is open — `NOTIFICATION_EVENTS`' whole promise is that adding
a notification costs one registry entry and no migration, so a database enum
there would silently reintroduce the migration the registry exists to avoid.
The eight journey stages are closed — they are `VISION.md`'s named sequence,
not a set any epic is expected to extend, and a ninth stage would be a
product decision on the order of rewriting the journey model itself, not a
routine addition. A decision that rare *should* cost a migration; a Postgres
enum is what makes an invalid ninth value impossible at the database level
rather than merely unvalidated. §3.2 has the column; §11 records the
plain-string alternative and why it lost.

---

## 2. The four-destination bar

### 2.1 What changes in `destinations.ts`

Today `DESTINATIONS` holds three entries: `home`, `settings`, `console`.
ROADMAP's 2026-09-02 decision log locks the replacement:

> E1's `destinations.ts` declares Home, Learn, Practice, and Progress as the
> four bar destinations; Settings moves off `DESTINATIONS` and into the user
> menu (its route stays owned through `DESTINATION_ROUTES`).

Concretely:

- `DestinationKey` widens to `'home' | 'learn' | 'practice' | 'progress' |
  'settings' | 'console'` — six keys, because `resolveActiveDestination`
  still has to answer "what's active" for `/settings/*` and `/admin/*`, even
  though those two no longer appear in the bar.
- `DESTINATIONS` (the array every bar-facing surface reads) becomes **exactly
  four entries** — Home (`/`), Learn (`/learn`), Practice (`/practice`),
  Progress (`/progress`) — with no `permission` on any of them: an
  unoriented, keyless, or freshly-created account still needs to see its own
  four destinations, because the gates that decide whether a *route* is
  reachable (§5) are a different question from whether a *destination*
  exists to navigate to. This is the same reachability-vs-content split
  `CLAUDE.md`'s Settings UI Pattern draws for tabs, one layer up: gating a
  bar destination on a permission and gating a route on a permission are two
  different mechanisms, and only the route needs one here.
- `DESTINATION_ROUTES` still carries all six keys — `home`, `learn`,
  `practice`, `progress`, `settings`, `console` — because highlighting a rail
  row for `/settings/profile` or `/admin/settings/email` does not depend on
  whether that key is a *bar* destination. This is the literal mechanism
  behind "keeps route ownership through `DESTINATION_ROUTES`": the map that
  answers "what lights up" is not the same list as "what's in the bar."
- A `Destination` object still needs to exist for `settings` and for
  `console` (icon, label, path, permission/`anyPermission`) — the User Menu
  and the rail's pinned foot section still have to render *something* — but
  neither belongs in the `DESTINATIONS` array any more. The natural shape is
  a `console`-only rail-pinned export (e.g. `RAIL_PINNED_DESTINATIONS`,
  read by `NavigationRail.tsx` alone) plus a single, ordinary "Settings" row
  the `UserMenu` renders directly from `DESTINATION_ROUTES.settings`'s path
  — it does not need the full permission/icon machinery a bar destination
  does, because every authenticated user can already reach it. (Amended by
  issue #232: the user menu now draws two rows, not one — "User Settings"
  unconditionally, and "System Settings" beneath it behind the permission
  gate. See §2.2's amendment for why.)

### 2.2 The ceiling is the raw array length, and that is the point

`apps/web/src/__tests__/config/destinations.test.ts` already asserts
`DESTINATIONS.length <= 4`. With four real bar destinations and nothing else
in the array, this stops being headroom and becomes an equality in practice
— the test does not need to change to enforce the new shape, and that is
deliberate: **if a later epic ever tries to add a fifth bar destination, the
existing assertion fails immediately**, with no new test to write and no way
to quietly widen the ceiling by editing the array.

This is also why `console` cannot simply gain a fifth slot in `DESTINATIONS`
with `pinned: true`, the way it does today. `pinned` today only changes
*where* the rail draws a destination (`NavigationRail.tsx`'s
`listDestinations`/`pinnedDestinations` split); `BottomNav.tsx` and
`UserMenu.tsx` both read `DESTINATIONS` directly with no `pinned` filter, so
`console` shows in all three surfaces today. "Console stays pinned — rail
only" is a real behavior change, not a restatement of the status quo:
`BottomNav` and `UserMenu` must stop reading `console` at all (it is no
longer in `DESTINATIONS`, so this happens for free), and the rail's pinned
foot section becomes `console`'s **only** appearance anywhere in the nav
chrome — until issue #232 gives it a second, permission-gated appearance in
the user menu; see the amendment below.

**The accepted cost, stated plainly:** an administrator on a phone-width
viewport (`showRail`'s `up('sm')` gate does not apply below 600px) has no
one-tap path to Console from the nav chrome — not the bottom bar, not the
user menu. `ProtectedRoute` and `RequirePermission` still gate the actual
`/admin/settings/*` routes exactly as before, so nothing about *reachability*
regresses — a bookmark or a typed URL still works, and still 403s for anyone
without the permission — only *discoverability* from primary navigation on a
narrow screen does. Admin configuration work is already an `up('sm')`-gated
surface in every other sense (the rail itself), and the four bar destinations
exist for the learner using the product day to day, not for the administrator
configuring it; this narrowing is accepted at MVP for that reason, and named
here rather than left as a silent difference from today's behavior.

**Amended by issue #232:** the paragraph above is the design record of what
#69 decided, and it stays — but the gap it accepted turned out to be a real
reported regression, not just a theoretical one: an administrator could not
find System Settings anywhere in the user menu, at any width, because the
menu never named it. That half of the cost is now reversed. The `UserMenu`
draws a second navigation row, **System Settings**, immediately after **User
Settings**, gated by `isDestinationVisible(CONSOLE_DESTINATION,
hasPermission)` — so visibility turns on `CONSOLE_DESTINATION`'s
`anyPermission` (`system_settings:read` OR `users:read`, the exact strings
`system-settings.controller.ts` and `users.controller.ts` enforce), never on
a role, exactly as §2.1 already required for the rail's pinned foot.

What is **not** reversed: `console` stays out of `DESTINATIONS` and out of
`BottomNav`; the `DESTINATIONS.length <= 4` ceiling above is untouched, and
the rail's pinned foot is still Console's only appearance in the *rail*. The
user menu reaches this without spending a bar slot because it was already
built to name the two destinations it draws (`SETTINGS_DESTINATION`,
`CONSOLE_DESTINATION`) rather than iterate `DESTINATIONS` — the same
"surfaces name what they render instead of inheriting it from an array"
design §2.1 states for exactly this reason.

The user menu is the right home for the second row because it is the one
settings chrome that exists at every width — the rail is unmounted below
`sm` (`showRail`'s `up('sm')` gate) — so it is the only surface that can
close the phone-width gap the original paragraph accepted; the bottom bar
cannot, because it has no settings-chrome row to extend at all.

One more thing changes with it: `CONSOLE_DESTINATION.label` is now `'System
Settings'` (it was `'Console'`), because a menu row sitting directly beneath
"User Settings" only tells an admin which one is theirs if both rows say
what they open. `compactLabel` stays `'Console'` — the 56px collapsed rail
was never going to hold "System Settings" — and the rail's own Console
*mode* vocabulary is unchanged by any of this: its
`aria-label="Console navigation"`, its "Back to library" row, and
`adminSections.tsx`'s framing all still say Console, because the mode (a
swapped-in rail context) and the destination's label (a row you click) are
different things.

Reachability was never affected by either change, #69's or #232's — only
discoverability. `ProtectedRoute` and `RequirePermission` gate
`/admin/settings/*` exactly as before, and a bookmark or typed URL always
worked.

### 2.3 Learn, Practice, and Progress ship as real routes in E1

The three destinations point at real, mounted pages from the start — `/learn`,
`/practice`, `/progress` — not at placeholders that redirect to `/`. Each
renders the designed empty state in §8. This matters structurally, not just
for the honesty rule: §4's `nextAction` invariant depends on these routes
existing and never redirecting, and a stub that instead threw a 404 or
bounced to `/` would make every `nextAction.path` value that points at them
false the moment E1 ships.

---

## 3. Two new tables

Both are created in E1, at design level (the migration itself is a child
issue's job, not this document's):

### 3.1 `civics_test_versions`

A lookup table with real, seeded content-shape rows — not a settings value,
because `learner_profiles.test_version_code` (§3.2) needs a foreign key
target, and E8's interview engine (ROADMAP: "question selection, pass rules
from `civics_test_versions`") reads pass rules **from a row**, not from a
constant duplicated at each call site.

| Column | Type (design level) | Notes |
|---|---|---|
| `code` | `String` `@id` | `'v2008'` \| `'v2025'` — a real primary key, not a Prisma enum: the two-row seed already gives referential integrity through the foreign key, and a table can grow a third row (a future test revision) without a schema-level `ALTER TYPE`. |
| `label` | `String` | e.g. "2008 Civics Test", "2025 Civics Test" — admin- and learner-facing. |
| `questions_asked` | `Int` | How many questions the interview presents. |
| `pass_threshold` | `Int` | Correct answers needed to pass. |
| `senior_questions_asked` | `Int` | The 65/20 accommodation's question count. |
| `senior_pass_threshold` | `Int` | The 65/20 accommodation's passing count. |
| `content_hash` | `String?` | Nullable — populated once E2 loads the versioned, provenance-tracked question content and hashes it (ROADMAP §7's "Content provenance" rule). Null immediately after E1's seed, because E1 seeds the test-version *shape*, not the question bank. |

Seed data, per ROADMAP's 2026-09-02 "Both civics test versions ship" entry:

| `code` | `questions_asked` | `pass_threshold` |
|---|---|---|
| `v2008` | 10 | 6 |
| `v2025` | 20 | 12 |

The senior-accommodation columns are seeded to the same 10-asked/6-to-pass
shape as the 2008 test for both rows, mirroring the long-standing 65/20
accommodation — E2's content load is what verifies this figure against the
authoritative USCIS source and is the design's designated place to correct
it if the real 2025 senior accommodation differs; this document does not
treat the seed value as verified DDL, only as the design-level placeholder a
migration pins.

### 3.2 `learner_profiles`

One row per user, created at account creation (or lazily on first orientation
read) with every field at its default until orientation is completed. Shape
mirrors `UserSettings`'s `userId @unique … onDelete: Cascade` pattern in
`apps/api/prisma/schema.prisma`:

| Column | Type (design level) | Notes |
|---|---|---|
| `user_id` | `String @unique` FK → `users.id`, `onDelete: Cascade` | One profile per user; deleting the user deletes the profile — there is no orphaned-row hazard here the way `docs/specs/ai-settings.md` §4.1 describes for BYOK keys, because this *is* a real foreign key, not a `(purpose, name)` address. |
| `stage` | `JourneyStage` (Postgres enum), default `uncertain` | The eight values from §1, in journey order. **A real enum, not a plain string** — see §1 for why this column sits on the opposite side of the `NotificationDelivery.eventKey` precedent, and §11 for the plain-string alternative and why it lost. |
| `interview_date` | `DateTime? @db.Date` | A calendar date, not a moment — ROADMAP §7's "local days are explicit" rule distinguishes a `@db.Date` from a `@db.Timestamptz`; an interview is booked for a day, not an instant, and shifting the learner's `timezone` later must not silently move which day this is. |
| `state_code` | `String @db.Char(2)`, nullable until orientation | **Must admit `DC`, `PR`, `GU`, `VI`, `AS`, `MP`** alongside the 50 states — not an oversight to catch later, because the 2008 test's civics content already has an accepted answer for "who are your state's senators" that covers residents of these territories explicitly (they have none), so the column has to hold a real value for them from day one. |
| `test_version_code` | `String?` FK → `civics_test_versions.code`, `onDelete: Restrict` | **Nullable**, and null means "not yet resolved" — not knowable before the learner supplies a filing date, so a non-null column would force a default onto every profile at creation that is an unverified claim about that learner (the exact thing §10's honesty rule forbids: nothing on screen could then distinguish "filed before the cutoff" from "nobody has asked yet"). Its presence is one of the facts `orientation_completed_at` attests to. Once set, it is **resolved once, at orientation submit time**, from the filing date the learner enters — not recomputed live on every read; see §11 on why the cutoff-date logic lives in one place, not at each call site. `onDelete: Restrict` — a test version cannot be deleted while any profile still references it. |
| `senior_exemption` | `Boolean`, default `false` | Self-attested at orientation (§7, field 2). |
| `daily_goal_minutes` | `Int`, default `5` | "Five minutes should matter" (§7, field 5) is the product's stated floor, not a placeholder default nobody chose on purpose. |
| `explanation_language` | `String`, default `'en'` | A BCP-47 tag. Governs only AI *explanations* — ROADMAP §8's backlog is explicit that localizing the application chrome itself is out of scope; questions and official answers stay in English. |
| `timezone` | `String` | An IANA zone name, captured at orientation (from the browser, confirmable by the learner). Feeds ROADMAP §7's "local day" rule for E7's streaks — this table is where that value is first collected, even though E1 does not yet compute anything from it. |
| `orientation_completed_at` | `DateTime? @db.Timestamptz` | Null until orientation is submitted. This is the literal field `RequireOrientation` (§5) checks. |

---

## 4. The `nextAction` contract

Home renders one deterministic recommendation at a time. ROADMAP's
2026-09-02 decision log is explicit that the function producing it "is a pure
function over mastery counts, coverage, recency, and journey stage — not a
model call. It must produce an identical, explainable answer on two
consecutive loads." E1 does not have mastery counts or coverage yet (those
are E5), so its version of the function has exactly three things to say:

```ts
interface NextAction {
  kind: 'orientation' | 'interview_countdown' | 'explore';
  title: string;
  reason: string;
  path: string;
}
```

- **`orientation`** — the learner has not finished the orientation screen.
  `path: '/setup/journey'`.
- **`interview_countdown`** — the learner has an `interview_date` set.
  `path: '/learn'`.
- **`explore`** — the learner is oriented, has no interview date yet, and
  E1 has nothing more specific to say. `path: '/learn'`.

**Both non-orientation `kind`s resolve to `/learn` in E1, and that is
deliberate rather than a missed distinction.** E2 (#51) lands the real civics
content at `/learn` in the very next epic; E3's practice loop does not exist
until after it. An interview countdown's honest advice today is "start with
the material," not "go to a page where practice does not exist yet" — even
though `/practice`'s stub (§8.2) is a real, non-redirecting route and would
not technically violate §4.1's invariant. **E3 (#52) re-points
`interview_countdown` to `/practice`** once Practice has real content to send
a learner to; a future contributor finding both kinds pointing at `/learn`
should extend the mapping when E3 ships, not "fix" this into two identical
branches now.

`kind` is a **closed union**, capped at these three for E1. E3/E5/E8 each add
exactly one member when their route exists to receive it — `practice`
(E3), `review` (E5), `interview` (E8) — following the same
extend-the-union-when-the-destination-exists discipline this whole document
uses for the stage and destination registries.

### 4.1 The invariant, stated as a structural rule, not a review note

**A `nextAction` must never point at a route that redirects to `/`.** A
learner who taps "Continue" and lands back on the exact screen the card was
on has just watched the product contradict itself.

The `kind` cap is *how* this is enforced, not merely a tidy type. Each `kind`
maps to exactly one hardcoded path the recommender itself owns — never a
caller-supplied string, never a path assembled from user input — and every
path in that mapping is one of: `/setup/journey` (mounted outside every
gate, §5), or one of the four real destinations from §2.3 (`/`, `/learn`,
`/practice`, `/progress`), none of which redirect anywhere. Adding a new
`kind` in a later epic means adding one more hardcoded, verified path to this
same closed mapping — not opening the field to a general string a future
bug could point at a route that has since been removed or renamed to a
redirect. This is a structural answer, not a "remember to check this in
review" answer, for exactly the reason `docs/specs/ai-settings.md` prefers
structural enforcement over convention wherever it can (§4.2's "no route
accepts a user id parameter" is the same shape of argument, one epic over).

### 4.2 `orientation` and the gate: an honest gap, not an inconsistency

`RequireOrientation` (§5) hard-blocks an unoriented learner before Home ever
mounts — mirroring `RequireAiKey` exactly, per this epic's own gate design.
That means, in the live product, `kind: 'orientation'` **never actually
renders on Home**: a learner who could see it would already have been
redirected to `/setup/journey` first. The member stays in the union
anyway, for the same reason `userKeyConfigured` is a fact `AiStatusContext`
carries even though `RequireAiKey` already prevents a keyless user from
reaching any screen that would read it — the recommender is a pure,
independently unit-tested function over a profile shape, and a profile
missing `orientation_completed_at` is a real input that function must answer
correctly regardless of whether the live gate currently makes that answer
unreachable through the UI. Stating this here is more honest than quietly
dropping the case from the type and hoping nobody asks why.

### 4.3 The goal-ring placeholder is not a `nextAction`

The Home goal ring (§9.2) is a separate widget, not a fourth `kind`. It has
no data to show in E1 at all — not even a real zero — so it is not
"recommending" anything; §8's honesty rule governs it directly.

### 4.4 The `Clock` provider, briefly

`interview_countdown`'s day count and `daily_goal_minutes`'s eventual streak
math (E7) both need a single, mockable notion of "now." ROADMAP §7 names the
`Clock` provider and its non-production-only `X-Test-Clock` header override,
gated the same way `apps/api/src/test-auth/guards/test-environment.guard.ts`
gates `/testing/login` — reachable only when `NODE_ENV` is not
`production`. Its full design (interfaces, injection points beyond this
epic's own countdown math) is out of this document's scope; it is named here
only because §9's countdown copy depends on a real, server-computed day
count existing, never a value computed ad hoc in a component.

---

## 5. The onboarding gate: `RequireOrientation` chains after `RequireAiKey`

`RequireOrientation` is composed **inside** `RequireAiKey`'s `Outlet` in
`App.tsx`, reusing #39's exemption list exactly, per
`apps/web/src/components/common/RequireAiKey.tsx`:

```
<Route element={<AiStatusProvider />}>
  <Route path="/setup/ai-key" element={<AiKeySetupPage />} />       {/* exemption 1a */}
  <Route element={<RequireAiKey />}>
    <Route element={<LearnerProfileProvider />}>
      <Route path="/setup/journey" element={<OrientationPage />} />  {/* exemption 1b */}
      <Route element={<RequireOrientation />}>
        <Route element={<NotificationProvider><Layout /></NotificationProvider>}>
          {/* Home, Learn, Practice, Progress, /settings/*, /admin/settings/* */}
        </Route>
      </Route>
    </Route>
  </Route>
</Route>
```

1. **`/setup/*` is mounted OUTSIDE its gate, structurally.** Exactly as
   `/setup/ai-key` sits outside `RequireAiKey` rather than being exempted by
   a path comparison inside it, `/setup/journey` sits outside
   `RequireOrientation`. A redirect loop is then impossible by construction,
   not prevented by a string a future edit could get wrong.
2. **Logout is always reachable.** It is an app-bar action in `Layout`, not
   a route — unreachable *from* a full-screen setup page by definition,
   which is exactly why both `/setup/ai-key` and `/setup/journey` carry
   their own visible sign-out control (§7's mockups show this), the same way
   `AiKeySetupPage`'s header describes "do not trap the user."
3. **`/admin/settings/*` (prefix `/admin`) is exempt for a caller holding
   `system_settings:read`.** `RequireOrientation` carries the identical
   internal check `RequireAiKey` does —
   `location.pathname.startsWith('/admin') && hasPermission('system_settings:read')`
   — rather than moving admin routes outside the tree, because that is
   where they already live relative to `RequireAiKey` today. This prevents
   the same fresh-install deadlock `RequireAiKey`'s header describes: the
   first administrator must be able to reach `/admin/settings/ai` to bind a
   model, and to reach `/admin/settings/email`, etc., before they have any
   reason to fill out an orientation form for themselves. **No new
   permission string is introduced** — this is the same
   `system_settings:read` string `RequireAiKey` already checks, per
   ROADMAP §7's closed permission set.

**Ordering matters and is deliberate.** A caller reaches `RequireOrientation`
only after clearing `RequireAiKey`, so a keyless, unoriented user is sent to
`/setup/ai-key` first — orientation is a product question ("what test do you
take, when is your interview"), and asking it of someone who cannot yet use
the AI-driven parts of the product at all would be work spent before the
gate that actually blocks them has cleared.

**The profile is read once, not per navigation.** `LearnerProfileProvider`
copies `AiStatusContext`'s idiom exactly: mounted above both
`/setup/journey` and `RequireOrientation` so that saving orientation on
that screen releases the gate without a page reload (both are reading the
same state), fetched on mount via `GET /api/journey/profile` (§6.2) — a
single indexed lookup on `learner_profiles.user_id`'s unique index, as cheap
as `userKeyConfigured`'s lookup — and **fails open** on a failed request,
for the identical reason `RequireAiKey` does: a down endpoint must not lock
every user out of the whole application over a feature gate, when the API
enforces the real authorization boundary on every route regardless of what
this component decides.

---

## 6. The API owns the stage registry

`GET /api/journey/stages` returns the array in §1's table (`key`, `label`,
`description`, in journey order) — `@Auth()`, no permission, since every
authenticated user needs it to render their own stage. The web reads it over
this endpoint and **does not** duplicate it in `apps/web/src/config`.

This is option 1 of the three `apps/api/src/notifications/notification-events.ts`
weighs, applied to a third axis (destinations and settings cards being the
first two, per `CLAUDE.md`): the API owns the one declaration; the web gets
the server's answer rather than a second copy it has to keep in sync. A
duplicate with a test asserting the two agree — the alternative `ai-model-roles.ts`'s
header also rejects — is *detection*, not *prevention*: the copies can still
disagree in a working tree, in a branch, or in any build where the
agreement test does not run. `apps/api/src/ai/ai-model-roles.ts` makes the
identical argument for the six AI model roles; this is the same shape of
registry a third time, and it is deliberately not special-cased.

### 6.1 What lives in the registry vs. what lives on the profile

The registry (`GET /api/journey/stages`) is presentation data — the eight
keys and their user-facing copy. It does **not** carry which epic owns a
transition (§1's "owning epic" column is documentation for contributors, not
a fact the API serves to a browser) and it does not carry a learner's own
`stage` value — that comes from `GET /api/journey/profile`. The two
endpoints answer different questions for the same reason
`docs/specs/ai-settings.md` §5 keeps `userKeyConfigured` and `systemReady`
as two independent facts rather than one merged flag: "what stages exist"
and "which one is this learner in" have different audiences, different
cache lifetimes, and no reason to be fetched together.

### 6.2 `GET /api/journey/profile`

`@Auth()`, no permission — resolves the caller from `@CurrentUser('id')`,
never from a route parameter, per ROADMAP §7's closed-permission-set rule.
Returns the caller's own `learner_profiles` row (creating one with every
default from §3.2 if none exists yet, the same lazy-creation shape
`UserSettings` could use). This is the endpoint `LearnerProfileProvider`
calls once, on mount.

### 6.3 Submitting orientation

A single write endpoint — `PUT /api/journey/profile` is the natural verb
given the app's existing convention (`PUT /api/user-settings` replaces;
`PATCH` partially updates), taking the six fields §7 collects. The handler,
not the client, resolves `test_version_code` from the submitted filing date
against the 20 Oct 2025 cutoff (§3.2), and sets `stage: 'oriented'` and
`orientation_completed_at: now()` in the same write — a learner never POSTs
a `stage` value directly; it is a side effect of the state transition
completing, exactly as `orientation_completed_at` is.

---

## 7. Orientation screen copy

Mockups: [`orientation-360.svg`](journey-shell/orientation-360.svg) ·
[`orientation-600.svg`](journey-shell/orientation-600.svg).

Full-screen, mounted outside `Layout` — no rail, no bottom nav, nothing to
navigate away into — the same treatment `AiKeySetupPage.tsx` gives
`/setup/ai-key`, and reviewed against the identical tone: warm but not
sugary, encouraging but not dishonest, never condescending about English
ability, short plain sentences, comfortable admitting uncertainty. A visible
"Sign out" stays reachable at all times (§5, exemption 2).

**Heading:** "Let's set up your plan"

**Intro:** "A few quick questions help us show you the right test, and a
realistic countdown if you have an interview date. You can change any of
this later in Settings."

| Field | Label | Helper text |
|---|---|---|
| Filing date | "When did you file your Form N-400?" | "This tells us which civics test applies to you — the test changed for people who filed on or after October 20, 2025. We'll pick the right one for you automatically." |
| Senior exemption | "Are you 65 or older, with a green card for 20 years or more?" | "If both are true, you may only need to know a shorter list of questions. Answer honestly — this changes what we ask you to practice." |
| Interview date (optional) | "Do you have an interview date yet? (Optional)" | "If you don't have one yet, that's completely normal — leave this blank and add it later." |
| State/territory | "Which state or territory do you live in?" | "Some civics questions have answers that depend on where you live — like the name of your state's current governor." |
| Daily goal minutes | "How many minutes a day do you want to aim for?" | "Five minutes should matter. Start small — you can always do more, and a short streak beats a skipped week." Default: **5**. |
| Explanation language | "What language should we use to explain a tricky answer?" | "Questions and official answers stay in English — this is only for extra explanations, so it's easier to understand why an answer is correct." |

**Primary action:** "Save and continue."

The filing-date helper is deliberately honest about the dependency rather
than asking the learner to already know their test version: it says the
screen *resolves* the version from the date given, not that the learner
should know which test they take before answering.

---

## 8. Empty-state copy for Learn, Practice, and Progress

Mockups: [`learn-empty-360.svg`](journey-shell/learn-empty-360.svg) ·
[`learn-empty-600.svg`](journey-shell/learn-empty-600.svg) ·
[`practice-empty-360.svg`](journey-shell/practice-empty-360.svg) ·
[`practice-empty-600.svg`](journey-shell/practice-empty-600.svg) ·
[`progress-empty-360.svg`](journey-shell/progress-empty-360.svg) ·
[`progress-empty-600.svg`](journey-shell/progress-empty-600.svg).

Each stub states two things and nothing else: what the destination will
eventually do, and what the learner can do right now instead. **None makes a
promise about a date** — no "soon," no "coming in the next update," no
implied timeline. That omission is deliberate, not an oversight: this
document cannot promise a delivery date any more honestly than a fabricated
number could.

### 8.1 `/learn`

**Superseded.** Issue #121 (epic #51) replaced this stub with the real
destination — categories → question list → question detail, "current as of
{verifiedAt}", the 65/20 marker, a recognition-only flashcard study mode with
no scoring of any kind, and the `state_required` case rendering the question
in full with the answer replaced by an explanation and a link to
`/settings/journey`, never another state's answer standing in. See
`apps/web/src/pages/LearnPage.tsx` and `docs/specs/civics-content.md` §5 and
§8 for the resolution rules this page renders.

### 8.2 `/practice`

"This is where you'll answer questions out loud or in writing and get real
feedback — what you got right, what you missed, and why."

"There's nothing to practice here yet. For now, head back to Home to see
what's ready."

### 8.3 `/progress`

"This is where you'll see how ready you actually are — not just how many
questions you've answered, but real evidence: what you remember, how
consistently, and what's still shaky."

"There's no evidence to show yet, because nothing here is tracked yet.
That's the honest answer, and it's the one this page will always give until
it has something real to show."

---

## 9. Home copy

Mockups: [`home-360.svg`](journey-shell/home-360.svg) ·
[`home-600.svg`](journey-shell/home-600.svg) (shown in the
`interview_countdown` state; §4 covers the other two `kind`s).

### 9.1 Next-up card, by `kind`

- **`orientation`** — Title: "Finish setting up your plan." Reason: "A
  couple of quick questions, then you're ready to start." (See §4.2 for why
  this rarely renders live.)
- **`interview_countdown`** — Title: "*N* days until your interview" (a real,
  server-computed integer from `interview_date` and the `Clock`, §4.4 —
  never a placeholder). Reason: "Start with the material, then build up to
  full practice." Button: "Go to Learn." (§4 explains why this `kind` points
  at `/learn` rather than `/practice` in E1, and which epic re-points it.)
- **`explore`** — Title: "See what's here so far." Reason: "The learning and
  practice tools are on their way. For now, take a look at what's ready."
  Button: "Go to Learn."

### 9.2 The goal-ring placeholder

No numeral, ever — not even an accurate zero, per §10's honesty rule. Label:
"Not tracked yet." Supporting line: "Your daily goal will show here once
practice sessions exist."

### 9.3 Trust footer

"OathPath is not USCIS. This is our own assessment of your preparation —
never an official determination." — always visible on Home, per `VISION.md`'s
"Trust is not legal copy buried in settings. It is part of the user
experience," and ROADMAP §7's "Trust is UI, not legal copy" cross-cutting
rule.

---

## 10. The honesty rule

Every widget whose real data arrives in a later epic ships, in E1, as a
designed empty state that says so in plain language — never as a fabricated
number standing in for one. A ring reading "0 of 5 minutes" because nothing
is tracked yet is **indistinguishable from a learner who genuinely did zero
minutes today**; the zero is technically accurate and functionally a lie,
because the learner has no way to tell the two apart. §8's stub copy and
§9.2's goal ring are both instances of this same rule, and any future E1
child issue that finds itself computing a "0" to display in place of "not
built yet" has picked the wrong branch.

---

## 11. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **Six bar destinations (Home, Learn, Practice, Progress, Settings, Console all in `DESTINATIONS`)** | A phone bottom bar with six targets is not usable, and `destinations.test.ts`'s `DESTINATIONS.length <= 4` assertion exists precisely to make this a build-time failure rather than a design review catch. §2.2. |
| **A single merged onboarding gate instead of two chained ones (`RequireAiKey` + `RequireOrientation`)** | Would conflate two independent unlock conditions — "does this caller have a working AI key" and "has this caller told us about their situation" — the exact mistake `docs/specs/ai-settings.md` §5 rejects for `userKeyConfigured`/`systemReady`. It would also lose the ability to reuse `RequireAiKey`'s exemption reasoning verbatim, and complicate the admin exemption, which needs to apply identically to both. §5. |
| **Fake placeholder numbers on Home (`0/5 minutes`, `0% ready`)** | A displayed zero is indistinguishable from a real zero to the learner looking at it. §10. |
| **Duplicating the stage registry in `apps/web/src/config`** | Detection instead of prevention — the copies can still disagree in a working tree, a branch, or an unrun test — and it breaks the one-registry-entry promise `notification-events.ts` and `ai-model-roles.ts` both keep. §6. |
| **`civics_test_versions` created in E2 (content) instead of E1 (shell)** | `learner_profiles.test_version_code` is a foreign key into it, and that table is created in E1; a table cannot FK into one that does not exist yet. E8 also reads pass rules from this row rather than a hardcoded constant, which only works if the row predates every reader. §3.1. |
| **A plain `String` for `learner_profiles.stage`, validated against the API registry (the `NotificationDelivery.eventKey` idiom)** | The analogy looks sound but the sets are on opposite sides of the axis that decides it: `eventKey` is an OPEN set that a registry entry is meant to extend with no migration, while the eight journey stages are `VISION.md`'s named, CLOSED sequence — a ninth stage is a product decision on the order of rewriting the journey model, not a routine addition, and should cost the migration a real enum requires. A plain string would also let an application-layer bug write an invalid ninth value straight into the column with nothing at the database level to stop it. §1, §3.2. |
| **Computing `test_version_code` live from `filing_date` on every read** | E2's content pipeline and E8's interview engine both need one settled value to join against; recomputing the 20 Oct 2025 cutoff at each call site is a second place that logic can drift from the first the day the cutoff needs a historical carve-out. §3.2. |
| **A free-form string `nextAction.path`** | Breaks the structural "never redirects to `/`" invariant by letting any future caller point the card at an arbitrary route. The closed `kind` union, each mapped to one hardcoded verified path, is what makes the invariant load-bearing rather than a review note. §4.1. |
| **Duplicating Console into the bottom bar for phone reachability** | Would blow the four-destination ceiling (§2.2) — `BottomNav` reads `DESTINATIONS` directly, so a fifth entry there is a fifth bar destination, not a free addition. Still rejected; the accepted cost for the bottom bar is unchanged. |
| **~~Duplicating Console into the user menu for phone reachability~~ — superseded by issue #232** | Rejected here on the assumption it would need a second, `pinned`-ignoring code path and a bar slot like the bottom bar would. Neither turned out to be true: the user menu never read `DESTINATIONS` — it names the destinations it draws — so adding a `CONSOLE_DESTINATION` row behind `isDestinationVisible` cost no ceiling slot and no new code path, only a second named row. §2.2's amendment. |
| **Stub pages for `/learn`, `/practice`, `/progress` that promise a date ("coming soon")** | This document cannot honestly promise a delivery date any more than a fabricated number could; the stub copy says what the page will do and what to do instead, and stops there. §8, §10. |
