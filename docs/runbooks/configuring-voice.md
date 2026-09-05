# Runbook: Configuring voice (`transcribe` / `speak`)

This runbook covers the two model roles E9 (epic #58) added to
`/admin/settings/ai` — `transcribe` and `speak` — for an administrator
deciding whether, and what, to bind them to. E10's reading and writing
practice (epic #59) is a second caller of both roles, added no new role of
its own, and needs no configuration beyond what is already here — §6 below
says exactly what that means for you.

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
- `apps/web/src/pages/ReadingPracticePage.tsx`,
  `WritingPracticePage.tsx` — the E10 (epic #59) screens at
  `/practice/reading` and `/practice/writing`, read directly to confirm §6
  below: reading gates its microphone on the identical `transcribeBound`
  flag the civics practice screen uses, and writing's dictation calls
  `window.speechSynthesis` directly with `speak` as an optional upgrade.
- [`docs/specs/english-test.md`](../specs/english-test.md) §3, §4 — the
  design record for how E10 reuses the accent rule and the dictation
  default; not restated here.
- `apps/api/src/ai/providers/openai.provider.ts` (`OPENAI_TTS_VOICES`,
  `listVoices()`) and `GET /api/ai/speech/voices` — the voice catalog E12
  (epic #280, issue #283) adds; §1.1 below.
- `apps/api/src/ai/speech-audio.service.ts` and the `speech_audio_assets`
  table — the shared civics-clip cache E12 (epic #280, issue #284) adds;
  §3 below.
- [`docs/specs/voice-hands-free.md`](../specs/voice-hands-free.md) — the
  full E12 design record; this runbook states only what changes for you as
  an administrator, not restated here.
- [`docs/specs/conversation-mode.md`](../specs/conversation-mode.md) — the
  full E13 (epic #304) design record for the hands-free loop; §6 for
  `voice.conversationMode`, §8 for the wake lock and its platform limit,
  §10 for the `transcribe`-required degradation, §11 for the cost math;
  §6 below states only what changes for you as an administrator.
- `apps/web/src/hooks/useWakeLock.ts` — the wake lock's own header, read
  directly to confirm §6 below's foreground-only limit rather than assumed
  from the spec.

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

### 1.1 You bind the model; each learner picks the voice (epic #280)

Binding `speak` decides something beyond "is there a premium voice at all" —
it also decides **which voices show up in a learner's own picker**, at
`/settings/voice`. That screen reads `GET /api/ai/speech/voices`, which
returns whatever your configured provider's `speak` capability can
produce (OpenAI's own fixed list today) together with `speakBound`. You do
not choose a voice for your learners: you bind the model, and every learner
who prefers the premium path chooses their own voice and reading speed from
what that model offers, stored as their own preference and applied the next
time a question is read aloud.

An unbound `speak` means that picker has nothing to offer — the same "not a
degraded state" fact §1 already states, restated for the picker
specifically: a learner still sees a voice-and-speed screen, it simply has
no premium option checked, and every question is still read by the
browser at whatever speed the learner has set.

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

**Civics question and answer audio specifically is a different shape of
cost, since epic #280 (issue #284): it is synthesized once per voice across
your whole deployment, not once per learner or per attempt.** The first
learner who asks to hear a given civics question — in a given voice, from
the model currently bound to `speak` — pays for that one synthesis call, on
their own key, exactly as §3 already states above. Every learner after
that, on this deployment, hears the identical cached clip with **no AI call
and no cost to anyone**. So the number that actually scales your cost here
is not your learner count and not your total attempts — it is roughly **the
number of distinct voices your learners actually choose** (each one, at
most once per question, ever needs to be synthesized again). This applies
only to OathPath's own civics content read through `GET /ai/speech/audio`;
`POST /api/ai/speech/synthesize`'s general-purpose "read this text aloud"
route is not cached and runs on the calling learner's key every time, as it
always has. Rebinding `speak` to a different model resets this for free —
the next request for a question your new model hasn't spoken yet is simply
a fresh first-payer, on that learner's own key.

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

## 5. English reading and writing practice needs nothing new here

The reading and writing screens (`/practice/reading`, `/practice/writing`,
epic #59 / E10) are a **second caller** of the exact two roles this runbook
already covers — not a third role, and not a separate decision for you to
make.

**Reading practice reuses `transcribe`, with the identical degradation.**
The reading screen's microphone is gated on the same `transcribeBound` flag
the civics practice screen already reads — verified directly in
`ReadingPracticePage.tsx`. Whatever you decided in §1 for spoken civics
practice is what a learner gets for reading practice too, automatically:
bound, they record their reading and it is transcribed and scored word for
word; unbound, the microphone is simply absent and the learner instead
reads the sentence aloud to themselves and marks their own attempt — a
normal, fully working fallback, not a broken screen. There is nothing to
configure a second time.

**Writing practice's dictation reuses the exact same default and the exact
same optional upgrade §1 already describes for hearing a civics question
aloud** — the browser's own `window.speechSynthesis` by default, with
`speak` as an optional, never-required upgrade if you have bound it. If
neither `speechSynthesis` support nor a bound `speak` model is available,
the writing screen says so plainly and points the learner to reading
practice instead — it never falls back to showing the sentence, which would
silently turn a writing exercise into a copying exercise (`docs/specs/
english-test.md` §4).

**Nothing about `systemReady` changes.** English reading and writing read
the same `unboundRoles`/`transcribeBound` signals every other voice surface
already reads; no new entry was added to `AI_MODEL_ROLES` for it (`CLAUDE.md`,
"Adding a New AI Model Role"), so there is no new row on `/admin/settings/ai`
and §6's checklist below needs only one added line, not a new section of its
own.

## 6. Conversation mode needs one more decision: `transcribe` is required

Conversation mode (E13, epic #304) — the session-wide, one-tap hands-free
loop at `/practice/sessions/:id` — is a **third caller** of the same two
roles this runbook already covers, not a third role and not a third
binding decision, with one difference from §5's "nothing new to configure"
story worth stating on its own: unlike reading/writing practice, which
degrades gracefully with `transcribe` unbound, conversation mode has
nothing to fall back to — its entire premise is listening for a spoken
answer — so `transcribe` is **required**, not merely useful, for this one
surface.

- **`transcribe` unbound.** The session-wide `Text | Voice` control simply
  does not offer `Voice` as a choice — absent, not disabled, the identical
  "hidden, not disabled" rule §1 already states for the per-question mic —
  and `VoiceUnavailableNotice` explains why on the page, the same component
  E9 already ships. This is caught **at the start of a session, never
  mid-walk**: a learner already committed to walking and talking never
  discovers partway through that recording has stopped working under them.
  If you have never bound `transcribe`, conversation mode is simply not
  offered on your installation — an ordinary, fully working state, not a
  broken one.
- **`transcribe` bound.** The `Voice` option renders. Choosing it does not,
  by itself, start the hands-free loop — a learner still taps **Start
  hands-free** to arm the persistent microphone stream, the voice-activity
  detector, and the wake lock. `voice.conversationMode` (the learner's own
  preference, off by default) only decides whether a session *loads* with
  `Voice` already selected, so an opted-in learner's session costs exactly
  one tap instead of two — it never skips the Start tap outright.
- **`speak` is optional here too, on the identical terms §1 above already
  states.** With `speak` unbound, conversation mode still runs
  end to end: every question and every accepted answer is read aloud by
  the browser's own `speechSynthesis`, at the learner's chosen rate — this
  is the ordinary state of a fresh installation, not a degraded one. Binding
  `speak` only upgrades which voice does the reading, exactly as it does
  for the hand-driven flow.

**The foreground-only limit, stated plainly, because a learner or a
support request will eventually ask "why did my session stop":**
conversation mode works only with the screen on and the practice tab in
the foreground. It requests a screen wake lock the moment the loop starts
and releases it the moment the loop stops, specifically so the display
does not time out mid-session — but a wake lock keeps a *screen* awake, and
cannot keep a *locked* device awake. The instant a learner presses the
power button or the phone locks itself in a pocket, the operating system
suspends the tab outright: timers stop, `MediaRecorder` stops, audio
playback stops, and the browser drops the wake lock sentinel on its way
down. **This is a platform constraint every web app on every mobile
browser runs into, not a defect in this product** — a native app with a
background audio session could hold a locked screen open; a web page
cannot. If a learner reports the session "just stopping" for no reason,
the first question to ask is whether the screen went dark or the phone was
put away, not whether something crashed.

**The cost note, worth stating before a bill rather than after one:**
speech-to-text is per-call, on the learner's own key, and — unlike the
civics question/answer audio cache §3 describes — is **not cached at
all**. Every question conversation mode transcribes is a fresh
transcription call, and a wrong or low-confidence answer's one allowed
retry (`docs/specs/conversation-mode.md` §9) means that single question can
cost **up to two** transcription calls rather than one. Put together,
conversation mode costs a learner roughly **1-2× what the same session
would have cost typed and read via the STT path alone** — its
text-to-speech side is nearly free by comparison, because it is the
identical browser-`speechSynthesis`-by-default, cached-civics-audio path
every other spoken surface on this installation already uses, so the first
learner to hear a given question in a given voice pays for it once and
every learner after them, walking or not, hears the cached bytes. See
[`docs/specs/conversation-mode.md`](../specs/conversation-mode.md) §11 for
the full reasoning.

## 7. Summary checklist

- [ ] Decide whether spoken practice (voice **input**) is something you want
      to offer — if yes, bind a `transcribe`-capable model
- [ ] Decide separately whether the premium hosted voice is worth its cost
      over the free browser voice — if yes, bind a `speak`-capable model
- [ ] Neither decision affects `systemReady` or blocks any learner from using
      the rest of the app (§2)
- [ ] Both roles bill the learner's own OpenAI key, never yours (§3)
- [ ] Binding `speak` also populates each learner's own voice picker at
      `/settings/voice` (§1.1) — you choose the model, they choose the voice
- [ ] Civics question/answer audio is cached deployment-wide per voice, so
      its cost scales with distinct voices in use, not with learner count or
      attempts (§3)
- [ ] English reading and writing practice (`/practice/reading`,
      `/practice/writing`) automatically inherit whatever you decided above
      — nothing to configure separately for them (§5)
- [ ] Conversation mode (the session-wide hands-free loop) needs
      `transcribe` bound — with it unbound, `Voice` is simply absent from
      the picker, caught at the start of a session and never mid-walk (§6)
- [ ] Conversation mode works only with the screen on and the tab in the
      foreground — a locked or backgrounded phone suspends it, and no web
      app can prevent that (§6)
- [ ] If testing locally with `AI_PROVIDER_FAKE=true`
      (`infra/compose/.env.example`), both roles are served by the built-in
      fake provider — no real OpenAI account needed to exercise either flow;
      inert under `NODE_ENV=production` (`CLAUDE.md`, "AI (development/test
      only)")
