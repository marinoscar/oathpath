# Runbook: Configuring the spoken (realtime) mock interview

This runbook covers `realtime`, the model role E11 (epic #60) wired at
`/admin/settings/ai` — for an administrator deciding whether, and what, to
bind it to. It is the third role in this family, after E9's `transcribe` and
`speak` ([`docs/runbooks/configuring-voice.md`](configuring-voice.md)), and it
follows that runbook's shape on purpose: same structure, same questions
answered in the same order, so an administrator who has already read one
already knows how to read the other.

For the underlying design — the tool contract that keeps the model from
inventing a question or a verdict, the ephemeral-secret session lifecycle, the
manual verification checklist, why realtime audio is not automated — see
[`docs/specs/realtime-interview.md`](../specs/realtime-interview.md). For the
model-role registry and the two-flag readiness gate every role is checked
against, see [`docs/specs/ai-settings.md`](../specs/ai-settings.md). This
runbook does not restate either; it only tells you what changes on your
installation when you touch this one setting, and what does not.

Source of truth for every claim below:

- `apps/api/src/ai/ai-model-roles.ts` — `AI_MODEL_ROLES`'s `realtime` entry
  (`capability: 'realtime'`, `wired: true`) and `textModelRoles()`, the
  function that decides `systemReady` reads none of it.
- `apps/api/src/ai/ai-settings.service.ts` (`describeReadiness()`) — the
  `systemReady` formula, unaffected by this role for the identical reason
  it was unaffected by `transcribe`/`speak`.
- `apps/api/src/ai/providers/openai.provider.ts` — `probeModel`'s realtime
  branch, read in full below (§3): what the admin page's **Test** button
  actually checks for this role, and what it does not.
- `apps/api/src/ai/ai-dispatch.service.ts` — `createRealtimeSession`, the one
  door every mint call goes through, and the credential address it runs on.
- `apps/api/src/interviews/interviews.controller.ts` —
  `POST /api/interviews/:id/realtime-session` and
  `POST /api/interviews/:id/realtime/tool-calls`, both `@Auth()` with no
  permissions.
- `apps/web/src/pages/RealtimeInterviewPage.tsx` — the screen at
  `/practice/interviews/:id/voice`, and its `AiNotReady` rendering when
  `realtime` is unbound.
- `infra/nginx/nginx.conf`, `infra/nginx/csp.conf`, `infra/nginx/csp.dev.conf`
  — the `Permissions-Policy` header and the `connect-src`/`media-src`
  allowances this feature needs, read in full below (§4).
- [`docs/specs/realtime-interview.md`](../specs/realtime-interview.md) §11 —
  the manual verification checklist, and when it must be run.

---

## 1. What binding `realtime` controls

**Binding it enables the spoken mock interview.** Bind a model to `realtime`
and a learner sitting a mock interview sees a "practice by voice" option that
opens a live, interruptible, spoken conversation with the officer — the same
deterministic interview engine as the text version, over a different
transport. **Leaving it unbound leaves the text mock interview fully
working**, exactly as it has since E8: the officer's turns arrive as text,
the learner answers by typing (or by the ordinary per-question microphone if
`transcribe` is bound — a separate, unrelated decision, §5), and the
interview reaches the same debrief.

Put plainly, the way [`docs/runbooks/configuring-voice.md`](configuring-voice.md)
puts it for `transcribe`/`speak`: **you do not need to bind `realtime` for
the mock interview to work.** It is one more way to take the interview, not
a prerequisite for taking it at all. `RealtimeInterviewPage.tsx` never
renders a "start voice interview" control when the role is unbound — hidden,
not disabled, the identical posture the practice screen already takes toward
an unbound `transcribe` — so there is no dead button on your installation for
a learner to click and wonder why nothing happens.

**This is also, today, the single most expensive model role in the
catalog.** A realtime speech-to-speech model bills for a live session's worth
of audio in both directions, not a handful of short text completions — the
`grader`'s per-answer cost or the `tutor`'s per-explanation cost, multiplied
by however many minutes an interview actually runs. Deciding not to bind it
is a legitimate, complete answer for an installation that wants the mock
interview without that cost profile, and this runbook exists specifically to
say so in writing rather than leave you to infer it from an empty dropdown.

## 2. Binding it never blocks the rest of the app

`GET /api/ai/status`'s `systemReady` flag is a statement about the **text**
roles (`tutor`, `grader`) only — unchanged by this role, exactly as it was
unchanged when `transcribe` and `speak` were wired. `realtime`'s capability
is `'realtime'`, not `'text'`, so it can sit unbound indefinitely with
`systemReady` reporting exactly what it always has. An installation that has
never touched this setting reports itself ready on the same terms it did
before E11 shipped, and reports itself ready on the same terms after —
`realtime` simply joins `GET /api/ai/status`'s `unboundRoles` list, which is
informational for you, not a warning that something is broken.

The practical consequence: **binding order does not matter here either.**
Configure `tutor` and `grader`, ship, and come back to `realtime` — along
with `transcribe`/`speak` — weeks later, or never. None of the three
appearing in `unboundRoles` is something to "finish"; it is the normal state
of a deployment that has not opted into a given voice feature yet.

## 3. What the admin **Test** button actually checks, once bound

Binding `realtime` adds it to the roles the **Test** button on
`/admin/settings/ai` probes — but the check it runs for this role is weaker
than the one it runs for `tutor` or `grader`, and knowing that in advance
saves you from over-trusting a green result. There is no cheap,
side-effect-free way to open a real realtime session as a connectivity probe
— unlike a text completion, which costs one small round trip — so the probe
instead retrieves the bound model id from your account
(`client.models.retrieve`, `openai.provider.ts`'s `probeModel`). That proves
your key can **see** the model. It does not prove your OpenAI organization
actually has realtime access, or that a session can be minted end to end —
those are questions only a real mint, or the manual checklist in §5, can
answer. A `realtime` binding that passes **Test** can still fail the first
time a learner actually starts a voice interview, on an account without
realtime access; the failure is not a bug in this application, and the
connection test's result never claimed to rule it out.

## 4. Cost, and the ephemeral-secret boundary in operator terms

**Every realtime session runs on the learner's own OpenAI key, never on your
server credential** — identically to every other AI surface in this
application. Your server key at `('ai', 'openai')` exists only to populate
the model catalog and to run the **Test** button above; it is never charged
for an actual interview, no matter how many learners take one by voice.

What is different about this surface, and worth stating plainly rather than
leaving you to infer it: **the browser opens its realtime connection
directly to OpenAI, not through your server.** Your API mints a short-lived
credential — good for roughly a minute, scoped to that one interview, and
never reusable for a second session — and hands it to the browser; the
browser uses that one-time credential to talk to the provider directly, and
your API is never in the audio path at all. In operator terms, this means:

- **You will never see raw audio pass through your own infrastructure**, and
  there is nothing to size, log, or scale for it on your side beyond the one
  small mint call per session (or re-mint, if the learner's connection drops
  mid-interview).
- **The credential your server hands the browser is not the learner's real
  API key.** It cannot be replayed, it cannot be used for anything but that
  one interview, and it is worthless within about a minute even if
  intercepted. Nothing about this design asks you to trust the browser with
  a long-lived secret.
- **The cost of a spoken interview lands on the learner who took it**,
  exactly as the cost of grading their practice answers already does — check
  `GET /api/ai/usage` for `roleKey: 'realtime'` rows if a learner asks what a
  mock interview cost them. There is no admin-wide usage rollup for this or
  any other role (carried over from `docs/specs/ai-settings.md` §18); "how
  much did realtime interviews cost across my whole deployment" is not a
  number this application shows you today.

## 5. The nginx header requirement — read this before you deploy behind your own proxy

**A stock `oathpath deploy install` needs nothing further from you here.**
`infra/nginx/nginx.conf`, the reverse proxy this application's own container
runs, already sets `Permissions-Policy: microphone=(self)` and a
`Content-Security-Policy` whose `connect-src`/`media-src` allow the realtime
handshake (`https://api.openai.com`) and the officer's live audio
(`blob:`/`mediastream:`), and the CLI's shared VPS proxy
(`apps/cli/src/deploy/proxy.ts`) deliberately adds no response headers of its
own for the exact reason its own file header states — nginx's `add_header`
**replaces** an inherited header set rather than merging with it, so the
shared proxy leaves your application's headers alone rather than risk
silently deleting them. If you deployed with the CLI, or with
`infra/compose/`'s stock nginx service untouched, voice already works.

**If you front this application with your own reverse proxy instead** — a
Caddy, Traefik, or hand-rolled nginx config that does not reuse
`infra/nginx/nginx.conf`, or a CDN/WAF layer that rewrites response headers
— you must reproduce two things yourself, or voice fails **silently**, with
no error message a learner can act on:

1. **`Permissions-Policy` must grant the microphone to this origin**:
   `microphone=(self)`, never an empty `microphone=()`. An empty allowlist
   denies the microphone to every origin including your own, so the
   browser's `getUserMedia` call is rejected by policy before the learner is
   ever shown a permission prompt at all — indistinguishable, from the
   learner's side, from a microphone that was silently denied for no
   visible reason. This is not specific to `realtime`: `infra/nginx/nginx.conf`'s
   own comment on this header names both consumers explicitly — push-to-talk
   on the ordinary practice screens (`transcribe`, E9, epic #58) and the
   spoken mock interview (`realtime`, E11, epic #60) — because both features'
   `getUserMedia` call is rejected by policy before any permission prompt is
   ever shown if this header is missing or too narrow.
2. **Your `Content-Security-Policy`'s `connect-src` must allow
   `https://api.openai.com`**, and `media-src` must allow `blob:` and
   `mediastream:`. Without the first, the browser's SDP handshake to open
   the realtime connection is blocked by the browser itself before any
   network request leaves the page — no server-side log entry, no error
   your API ever sees, just a connection that never completes and a screen
   that, after a bounded number of retries, falls back to the text
   interview (§7 of `docs/specs/realtime-interview.md`) with nothing on the
   page explaining why. Without the second, the officer's own voice has no
   `<audio>` element it is allowed to play into.

Read `infra/nginx/nginx.conf` and `infra/nginx/csp.conf` directly for the
exact directives and the comments explaining each one — this runbook points
at them rather than duplicating text that can drift from the file it
describes.

## 6. The manual checklist is not optional, and it is not automated

**No suite in this codebase opens a real realtime connection and asserts on
real speech.** `docs/specs/realtime-interview.md` §10 states this outright,
by design, rather than as a gap nobody noticed: automating it would mean
either real network access and a real OpenAI account from CI, or a
fabricated realtime transport standing in for the very thing the test exists
to verify. What this application relies on instead is
[`docs/specs/realtime-interview.md`](../specs/realtime-interview.md) §11's
eight-item manual checklist — barge-in in both directions, end-to-end
latency, the end control under load, mid-session device switching,
microphone denial, network loss, and secret expiry — each with its own
numbered pass criterion, run by a person against a real deployment, a real
browser, and a real microphone.

**This is not merely a testing detail; it is a release gate.** See the
"Release checklist" note in [`CHANGELOG.md`](../../CHANGELOG.md): §11 must be
run, and its pass/fail result recorded, before any release that changes
voice or realtime code — not on every deploy, and not automatically. If you
maintain a fork that changes anything under `apps/interviews/realtime/` or
`apps/web/src/services/realtimeConnection.ts`, this checklist is yours to run
too, for the identical reason it is the upstream project's: nothing else in
this codebase's test suite will catch a barge-in regression or a broken
fallback path.

That said, this remains a checklist for a **fork that changes the realtime
transport itself** — `apps/api/src/interviews/realtime/`,
`apps/web/src/services/realtimeConnection.ts`, or
`apps/web/src/pages/RealtimeInterviewPage.tsx` — not for every deployment.
Binding or unbinding `realtime` on your own installation, with no code
changes, needs no re-run of this checklist; the eight items test the
transport's behavior, not any one administrator's configuration.

## 7. English reading and writing become real in a voice interview

Unlike the text mock interview, which announces the reading and writing
phases as skipped (`SKIPPED_PHASES`, E8), **a realtime interview conducts
them for real** — the officer's turn presents a reading sentence or dictates
a writing sentence exactly as `/practice/reading`/`/practice/writing` already
do, scored by the identical word-error-rate function and written into the
same `english_attempts` table. This needs no configuration of its own: it is
not a separate role, not a separate binding, and not a separate line on
`/admin/settings/ai` — it falls out of `realtime` being bound at all. See
[`docs/specs/realtime-interview.md`](../specs/realtime-interview.md) §5.

## 8. Summary checklist

- [ ] Decide whether the spoken mock interview is worth its cost profile —
      the most expensive role in the catalog — for your learners; if yes,
      bind a `realtime`-capable model (§1, §4)
- [ ] Leaving it unbound is a complete, working installation: the text mock
      interview is unaffected, and `systemReady` does not move either way
      (§1, §2)
- [ ] Once bound, the admin **Test** button proves your key can see the
      model — not that a session can be minted end to end (§3)
- [ ] If you deploy with the CLI or the stock `infra/compose/` nginx
      service, the microphone and CSP headers this feature needs are already
      set; if you front this application with your own reverse proxy, you
      must reproduce `Permissions-Policy: microphone=(self)` and a
      `connect-src`/`media-src` that allow the realtime provider yourself,
      or voice fails with no visible error (§5)
- [ ] Every session bills the learner's own OpenAI key under
      `roleKey: 'realtime'` on their own `GET /api/ai/usage` — never yours
      (§4)
- [ ] Before shipping any change to voice or realtime code, run
      `docs/specs/realtime-interview.md` §11's manual checklist and record
      the result in `CHANGELOG.md` (§6)
- [ ] If testing locally with `AI_PROVIDER_FAKE=true`
      (`infra/compose/.env.example`), `realtime` is served by the built-in
      fake provider's scripted session mint — no real OpenAI account needed
      to exercise the mint-and-fallback flow; inert under
      `NODE_ENV=production` (`CLAUDE.md`, "AI (development/test only)")
