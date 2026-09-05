# OathPath
OathPath is an AI-powered citizenship preparation companion that helps users study, practice, and build confidence for the U.S. naturalization interview — civics knowledge, English reading and writing, and the interview conversation itself — through adaptive learning, voice and text practice, realistic AI mock interviews, and personalized readiness tracking.

## Features

- **Adaptive civics practice** — spaced repetition over the official USCIS question bank, scheduled by verified recall rather than a fixed drill order.
- **Semantic AI grading** — a practice answer is graded for meaning, not exact wording, with an explanation when it misses.
- **Voice practice, always optional** — hear a question read aloud and answer it out loud instead of typing; the transcript is shown for you to confirm or correct before anything is graded, and the recording itself is never kept. See [Practicing With Your Voice](docs/spoken-practice.md).
- **Reading and writing practice** — one composed sentence read aloud and scored word by word, one sentence dictated and typed back with the text deliberately withheld until after you submit. Near-misses pass, a diff shows which word, and a mishearing is never recorded as a mistake. See [Practicing Reading and Writing](docs/reading-writing-practice.md).
- **Realistic AI mock interviews** — a simulated naturalization interview with a debrief afterward, typed on every installation and, where an administrator has configured it, spoken as a live, interruptible conversation. See [Practicing a Spoken Mock Interview](docs/spoken-mock-interview.md).
- **Explainable, capped readiness tracking** — a readiness score that shows its own components and never claims more confidence than the evidence behind it supports.
- **Daily goals and streaks** — habit support that never influences the readiness score itself.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, components, and data model.
- [API Reference](docs/API.md) — every endpoint, request, and response shape.
- [Security Architecture](docs/SECURITY-ARCHITECTURE.md) — authentication, authorization, and data protection.
- [Device Authorization](docs/DEVICE-AUTH.md) — the RFC 8628 device flow the CLI signs in with, with copy-pasteable integration examples.
- [Personal Access Tokens](docs/personal-access-tokens.md) — creating, using, and revoking long-lived API tokens.
- [Practicing With Your Voice](docs/spoken-practice.md) — what spoken practice does, and what happens to your voice.
- [Practicing Reading and Writing](docs/reading-writing-practice.md) — what the reading and writing segments test, and why the writing sentence is hidden until after you submit.
- [Practicing a Spoken Mock Interview](docs/spoken-mock-interview.md) — what a live, spoken mock interview is, why OathPath (not the AI) chooses the questions and the result, and what happens to your voice.
- [Runbook: Configuring voice](docs/runbooks/configuring-voice.md) — for an administrator deciding whether to bind the `transcribe`/`speak` AI roles, including what reading/writing practice needs (nothing new).
- [Runbook: Configuring the spoken mock interview](docs/runbooks/configuring-realtime-interview.md) — for an administrator deciding whether to bind the `realtime` AI role, its cost, the ephemeral-secret security boundary, and the nginx headers a custom reverse proxy must reproduce.
- [Runbook: Updating civics content](docs/runbooks/updating-civics-content.md) — for a maintainer correcting a civics answer or revising the question bank.
- [Runbook: Updating English content](docs/runbooks/updating-english-content.md) — for a maintainer adding or revising a reading/writing sentence.
- [Runbook: Rotate SECRETS_ENCRYPTION_KEY](docs/runbooks/rotate-secrets-encryption-key.md) — for an operator rotating the key that encrypts runtime-configured credentials, or recovering from losing it.
- [Design specs](docs/specs/) — the durable design record for each feature area, including [`voice.md`](docs/specs/voice.md) for how spoken practice works end to end, [`english-test.md`](docs/specs/english-test.md) for reading and writing, and [`realtime-interview.md`](docs/specs/realtime-interview.md) for the spoken mock interview's tool contract and ephemeral-secret session lifecycle.
- [Deployment](docs/deployment/vps.md) — installing and updating a self-hosted instance.
- [CLAUDE.md](CLAUDE.md) — codebase guidance for AI coding assistants.
