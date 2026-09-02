## Summary

<!-- What changed and why. Lead with the problem, not the diff. -->

## Related issue

<!--
Required. Every feature and bug fix is tracked by an issue filed before the
work started — see the issue-driven development section of CLAUDE.md.
Use `Fixes #123` for a bug, `Relates to #123` otherwise.
-->

Relates to #

## Changes

<!-- The substantive changes, one line each. Skip the mechanical ones. -->

- 

## Testing

<!--
Say what you ran and what it reported. CI runs typecheck, tests and build for
the API, web and CLI workspaces; the Playwright suites under `tests/` are NOT
run by CI, so state explicitly whether you ran them and what happened.
-->

- [ ] `npm test --workspace=api`
- [ ] `npm run test:run --workspace=web`
- [ ] `npm run test:run --workspace=cli`
- [ ] Playwright (`tests/e2e`) — run manually against the compose stack, or state why not

## Checklist

- [ ] Commits follow Conventional Commits with a scope (`feat(api):`, `fix(web):`, …)
- [ ] Behaviour changes are covered by tests
- [ ] A schema change ships a migration created with `npm run prisma:migrate:dev`
- [ ] A new settings page is a registry card plus a route, never a new tab
- [ ] No new permission string was invented; any permission named is one a controller already enforces
- [ ] No secret, key or credential appears in code, tests, logs, fixtures or this description
- [ ] Documentation updated if the change affects setup, the API surface, or a documented behaviour
