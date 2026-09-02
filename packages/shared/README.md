# `@app/shared`

Constants that more than one app needs. Today that is exactly one thing: the
application's display name.

## Rebranding a fork

Edit **one line** in [`index.js`](./index.js):

```js
exports.APP_NAME = 'OathPath';
```

Then rebuild. That is the whole change — every surface below derives from this
constant rather than restating it, so nothing else needs editing and nothing
can be missed.

Two caveats, both real:

1. **Regenerate the visual baselines.** The app name is rendered into the
   pixel baselines under `tests/visual/specs/**/*-snapshots/`, and that suite
   runs at `maxDiffPixels: 4` — effectively zero tolerance. Baselines are only
   ever regenerated inside the pinned container (see
   `tests/visual/playwright.config.ts` for why a local browser is not
   acceptable):

   ```bash
   docker run --rm -it -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-noble \
     npx playwright test --config=tests/visual/playwright.config.ts --update-snapshots
   ```

   Seven of the eleven baselines are `fullPage` shots that include the AppBar
   wordmark; the rail-scoped and drill-down ones are unaffected.

2. **The name is not the only identity string.** `CLI_NAME` in
   `apps/cli/src/branding.ts` is deliberately separate and is *not* derived
   from `APP_NAME`. It names the executable, and it additionally seeds the
   config directory and the environment-variable prefix, so it carries
   constraints this constant does not (lowercase ASCII, no spaces or dots).
   Renaming the product should rename the banner; renaming the binary is a
   second, independent decision. Its rationale is documented in that file.

   Two things that *were* once listed here as deliberately out of scope no
   longer are, because this repository stopped being a template and became a
   product:
   - The GitHub repository URLs in `apps/api/src/openapi/document.ts` and
     `description.ts` point at *this* repository. They pointed at the upstream
     template until the OathPath rename, which was a real defect — the two
     repositories both exist and have diverged.
   - Prose in `README.md`, `docs/`, and `scripts/dev.ps1` names the product.
     The upstream template scoped that out on purpose; the OathPath rename
     brought it back in.

## Consumers

Keep this list current when you add one.

| Consumer | File | Renders as |
|---|---|---|
| Web wordmark (AppBar) | `apps/web/src/components/navigation/AppBar.tsx` | `APP_NAME` |
| Web page title + meta description | `apps/web/index.html` via the `%APP_NAME%` plugin in `apps/web/vite.config.ts` | `APP_NAME` |
| OpenAPI document title + contact name | `apps/api/src/openapi/document.ts` | `${APP_NAME} API` |
| OpenAPI description prose | `apps/api/src/openapi/description.ts` | `APP_NAME` |
| API reference page heading | `apps/api/src/openapi/docs-page.ts` | `${APP_NAME} API` |
| API reference page `<title>` | `apps/api/src/openapi/register-docs-routes.ts` | `${APP_NAME} API Reference` |
| Email wordmark, footer, and subject lines | `apps/api/src/email/templates/layout.ts` (re-exported to the five templates) | `APP_NAME` |
| CLI banner, `--help`, device name | `apps/cli/src/branding.ts` (`CLI_DISPLAY_NAME`) | `${APP_NAME} CLI` |

## If you consume this from a Vite app

Add the package to `optimizeDeps.include` in that app's Vite config:

```ts
optimizeDeps: { include: ['@app/shared'] },
```

This is **not** optional and it is not a performance tweak. The package is
CommonJS and arrives as an npm workspace symlink; Vite treats a linked package
as project source rather than as a dependency, so it skips dep pre-bundling and
serves `exports.APP_NAME = ...` to the browser as raw ESM. Every importer then
fails with `does not provide an export named 'APP_NAME'` and the page renders
blank.

The trap is what stays green while that is broken: `tsc --noEmit`, the whole
Vitest suite, and `vite build` all pass, because Rollup's commonjs plugin and
Vitest's interop each handle the file unaided. **Only the dev server breaks.**
`apps/web/vite.config.ts` and `apps/web/visual/vite.config.ts` both carry the
line for this reason — see #164.

## Why this package looks the way it does

It ships committed JavaScript and a hand-written `.d.ts`, with **no build
step**, and it is **CommonJS**. Neither is an accident — `apps/api`'s
`rootDir`, its Jest transform rules, `apps/cli`'s real-ESM runtime, and the
fact that CI never compiles a fourth workspace all constrain the choice. The
full reasoning is in the header comment of [`index.js`](./index.js); read it
before changing the packaging.

## Adding a second constant

Export it from `index.js`, declare it in `index.d.ts`, and add a row to the
table above. Anything Node-only, Nest-only, or DOM-only does **not** belong
here — all three apps import this package, and one of them has no DOM while
another has no Node.
