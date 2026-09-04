# OathPath
OathPath is an AI-powered citizenship preparation companion that helps users study, practice, and build confidence for the U.S. naturalization interview and civics test through adaptive learning, voice and text practice, realistic AI mock interviews, and personalized readiness tracking.

## Features

- **Adaptive civics practice** — spaced repetition over the official USCIS question bank, scheduled by verified recall rather than a fixed drill order.
- **Semantic AI grading** — a practice answer is graded for meaning, not exact wording, with an explanation when it misses.
- **Voice practice, always optional** — hear a question read aloud and answer it out loud instead of typing; the transcript is shown for you to confirm or correct before anything is graded, and the recording itself is never kept. See [Practicing With Your Voice](docs/spoken-practice.md).
- **Realistic AI mock interviews** — a text-mode simulated naturalization interview with a debrief afterward.
- **Explainable, capped readiness tracking** — a readiness score that shows its own components and never claims more confidence than the evidence behind it supports.
- **Daily goals and streaks** — habit support that never influences the readiness score itself.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, components, and data model.
- [API Reference](docs/API.md) — every endpoint, request, and response shape.
- [Security Architecture](docs/SECURITY-ARCHITECTURE.md) — authentication, authorization, and data protection.
- [Practicing With Your Voice](docs/spoken-practice.md) — what spoken practice does, and what happens to your voice.
- [Runbook: Configuring voice](docs/runbooks/configuring-voice.md) — for an administrator deciding whether to bind the `transcribe`/`speak` AI roles.
- [Design specs](docs/specs/) — the durable design record for each feature area, including [`voice.md`](docs/specs/voice.md) for how spoken practice works end to end.
- [Deployment](docs/deployment/vps.md) — installing and updating a self-hosted instance.
- [CLAUDE.md](CLAUDE.md) — codebase guidance for AI coding assistants.
