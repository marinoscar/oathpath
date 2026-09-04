# Runbook: Configuring voice (`transcribe` / `speak`)

This runbook covers the two model roles E9 (epic #58) added to
`/admin/settings/ai` — `transcribe` and `speak` — for an administrator
deciding whether, and what, to bind them to.

For the underlying design — the confirm-before-grade mechanism, the
`misheard` failure cause, why audio is never stored — see
[`docs/specs/voice.md`](../specs/voice.md). For the model-role registry and
the two-flag readiness gate every role (voice included) is checked against,
see [`docs/specs/ai-settings.md`](../specs/ai-settings.md). This runbook does
not restate either; it only tells you what changes on your installation when
you touch these two settings, and what does not.

Source of truth for every claim below:

- `apps/api/src/ai/ai-model-roles.ts` — `AI_MODEL_ROLES`, `transcribe` and
  `speak` both `wired: true`.
- `apps/api/src/ai/ai-settings.service.ts` (`describeReadiness()`) — the
  `systemReady` formula.
- `apps/api/src/ai/ai-speech.controller.ts`,
  `apps/api/src/ai/ai-speech.service.ts` — the two `/api/ai/speech/*` routes.
- `apps/api/src/ai/ai-dispatch.service.ts` — `.transcribe()` / `.synthesize()`,
  and the credential address each inference call actually runs on.
- `apps/web` — the practice session's spoken-mode UI and its unbound-role
  degraded states (`docs/specs/voice.md` §1's table).

---

## 1. What each role controls

**`transcribe` enables the microphone.** Bind a model to it and the practice
session's mic control appears; a learner can answer a question aloud instead
of typing. Leave it unbound and the mic control does not render at all — not
disabled, not greyed out, simply absent, because there is nothing it could
successfully do. The session runs entirely in text. **This is a normal,
fully working installation, not a degraded one.** Nothing in the product
tells a learner a microphone is missing, because nothing was promised.

**`speak` is an optional upgrade, never a prerequisite.** "Hear this question
aloud" ships on every installation from day one, for free, using the
browser's own `speechSynthesis` API — no credential, no binding, no admin
action, and no cost, because the computation happens entirely in the
learner's browser. Binding `speak` layers a higher-quality, provider-hosted
voice on top of that for learners who prefer it. **Leaving it unbound removes
nothing** — a learner still hears every question read aloud, by the browser
instead of by your bound model.

Put plainly: **you do not need to touch either setting for spoken practice
to work.** `transcribe` is the one decision that actually changes what the
product can do (adds voice input); `speak` only changes which voice reads
the question aloud (the browser's, or your bound model's).

## 2. Binding either role never blocks the rest of the app

`GET /api/ai/status`'s `systemReady` flag — the one the hard-blocking
navigation gate and `AiNotReady` depend on — is a statement about the **text**
roles (`tutor`, `grader`) only. `transcribe` and `speak` can sit unbound
indefinitely with `systemReady` reporting exactly what it always has: a
fresh install that has never touched voice settings reports itself ready on
the same terms it did before E9 shipped. See
[`docs/specs/voice.md`](../specs/voice.md#1-the-degradation-rule) §1 for the
mechanism and the failure it was written to prevent — it is not restated
here.

The practical consequence for you: **binding order does not matter.** You
can configure `tutor` and `grader` and ship, then come back to voice weeks
later, or never. Neither role appearing in `GET /api/ai/status`'s
`unboundRoles` list is something for you to "finish" — it is the normal
state of a deployment that has not opted into either voice feature yet.

## 3. What it costs, in terms you can act on

Both roles run inference **on the learner's own OpenAI key**, exactly like
`tutor` and `grader` — never on your server credential. Your server key at
`('ai', 'openai')` exists only to populate the model catalog on
`/admin/settings/ai` and to prove connectivity from that page's **Test**
button; it is never charged for an actual transcription or synthesis call, no
matter how many learners use voice. Usage lands on each learner's own
`GET /api/ai/usage`, under `roleKey: 'transcribe'` or `roleKey: 'speak'`, so
"how much did voice cost" is a question each learner answers for themselves
from their own OpenAI dashboard — not a number this application shows you in
aggregate (there is no admin-wide usage rollup; see `docs/specs/ai-settings.md`
§18).

What that means for the two roles specifically:

- **`transcribe` runs once per spoken answer.** A learner who answers ten
  questions aloud in a session makes ten transcription calls, each on a
  short recording (capped at 10 MB / 120 seconds — see
  `docs/specs/voice.md` §9). This is the cost that scales with how much
  spoken practice your learners actually do.
- **`speak` runs only for a learner who chooses the premium voice.** Every
  other learner hears the question via the browser's free, local
  `speechSynthesis` and never triggers a `speak` call at all. Binding
  `speak` therefore adds cost only in proportion to how many of your
  learners opt into it, not to your total learner count.

Neither role has a rate limit or a spend cap in this application (carried
over from `docs/specs/ai-settings.md` §18 and `docs/specs/ai-evaluation.md`
§13 — nobody's job yet). If cost matters to you, the caps to know about are
OpenAI's own, on the learner's own account, not anything OathPath enforces.

## 4. If you choose not to bind either

Nothing to undo, nothing to monitor, and nothing missing from the product
that a learner would notice on their own: the practice session runs in text,
questions are read aloud by the browser, and every other AI surface (tutor,
grading) works exactly as it does today. `transcribe`/`speak` appearing in
`unboundRoles` is informational, not a warning — it tells a voice-specific
surface which of the two roles is unconfigured, on the rare occasion one
needs to say so, and nothing more.

## 5. Summary checklist

- [ ] Decide whether spoken practice (voice **input**) is something you want
      to offer — if yes, bind a `transcribe`-capable model
- [ ] Decide separately whether the premium hosted voice is worth its cost
      over the free browser voice — if yes, bind a `speak`-capable model
- [ ] Neither decision affects `systemReady` or blocks any learner from using
      the rest of the app (§2)
- [ ] Both roles bill the learner's own OpenAI key, never yours (§3)
- [ ] If testing locally with `AI_PROVIDER_FAKE=true`
      (`infra/compose/.env.example`), both roles are served by the built-in
      fake provider — no real OpenAI account needed to exercise either flow;
      inert under `NODE_ENV=production` (`CLAUDE.md`, "AI (development/test
      only)")
