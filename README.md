# OathPath
OathPath is an AI-powered citizenship preparation companion that helps users study, practice, and build confidence for the U.S. naturalization interview — civics knowledge, English reading and writing, and the interview conversation itself — through adaptive learning, voice and text practice, realistic AI mock interviews, and personalized readiness tracking.

## Features

- **Adaptive civics practice** — spaced repetition over the official USCIS question bank, scheduled by verified recall rather than a fixed drill order.
- **Semantic AI grading** — a practice answer is graded for meaning, not exact wording, with an explanation when it misses.
- **Voice practice, always optional** — hear a question read aloud and answer it out loud instead of typing; the transcript is shown for you to confirm or correct before anything is graded, and the recording itself is never kept. See [Practicing With Your Voice](docs/spoken-practice.md).
- **Reading and writing practice** — one composed sentence read aloud and scored word by word, one sentence dictated and typed back with the text deliberately withheld until after you submit. Near-misses pass, a diff shows which word, and a mishearing is never recorded as a mistake. See [Practicing Reading and Writing](docs/reading-writing-practice.md).
- **Realistic AI mock interviews** — a text-mode simulated naturalization interview with a debrief afterward.
- **Explainable, capped readiness tracking** — a readiness score that shows its own components and never claims more confidence than the evidence behind it supports.
- **Daily goals and streaks** — habit support that never influences the readiness score itself.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, components, and data model.
- [API Reference](docs/API.md) — every endpoint, request, and response shape.
- [Security Architecture](docs/SECURITY-ARCHITECTURE.md) — authentication, authorization, and data protection.
- [Practicing With Your Voice](docs/spoken-practice.md) — what spoken practice does, and what happens to your voice.
- [Practicing Reading and Writing](docs/reading-writing-practice.md) — what the reading and writing segments test, and why the writing sentence is hidden until after you submit.
- [Runbook: Configuring voice](docs/runbooks/configuring-voice.md) — for an administrator deciding whether to bind the `transcribe`/`speak` AI roles, including what reading/writing practice needs (nothing new).
- [Runbook: Updating English content](docs/runbooks/updating-english-content.md) — for a maintainer adding or revising a reading/writing sentence.
- [Design specs](docs/specs/) — the durable design record for each feature area, including [`voice.md`](docs/specs/voice.md) for how spoken practice works end to end and [`english-test.md`](docs/specs/english-test.md) for reading and writing.
- [Deployment](docs/deployment/vps.md) — installing and updating a self-hosted instance.
- [CLAUDE.md](CLAUDE.md) — codebase guidance for AI coding assistants.
