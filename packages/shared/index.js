// =============================================================================
// Application identity — the one constant a fork renames  (issue #162, epic #161)
// =============================================================================
//
// This repository is a TEMPLATE. Somebody clones it, calls their product
// something else, and every user-visible string carrying the old name is now
// wrong. Before this package existed the name was written out independently in
// three places that could not see each other:
//
//   - `apps/api/src/email/templates/layout.ts`  (its own `APP_NAME`)
//   - `apps/cli/src/branding.ts`                (its own `CLI_DISPLAY_NAME`)
//   - `apps/web`                                (raw literals, no constant)
//
// ...and they had already drifted to three different strings. Renaming meant
// grepping three packages and hoping. Now it is the ONE LINE at the bottom of
// this file.
//
// -----------------------------------------------------------------------------
// WHY THIS PACKAGE IS PLAIN JAVASCRIPT WITH A HAND-WRITTEN .d.ts
// -----------------------------------------------------------------------------
//
// Because a build step here would have to satisfy three different build
// systems before anything could even typecheck, and every one of them would
// have to be taught about it:
//
//   - `apps/api` compiles with `tsc -p tsconfig.build.json` under
//     `rootDir: ./src`. Importing TypeScript SOURCE from outside that root
//     widens it, and tsc then emits `dist/src/main.js` — which no longer
//     matches `start:prod`'s `node dist/main`. The build stays green and the
//     container breaks.
//   - `apps/api`'s Jest config has no `moduleNameMapper` and the default
//     `transformIgnorePatterns` (`/node_modules/`). A workspace symlink
//     resolving to `.ts` would not be transformed, and every API suite would
//     die at import time.
//   - CI (`.github/workflows/ci.yml`) runs `npm ci` and goes straight to
//     typecheck. Nothing builds a fourth workspace first, so a package that
//     needed compiling would have to add a step to four separate jobs.
//
// Committed `.js` + `.d.ts` sidesteps all of it: there is nothing to build, so
// there is no build to order, no `prepare` script, no `dist/` for
// `.dockerignore` to swallow, and no CI change at all.
//
// -----------------------------------------------------------------------------
// WHY CommonJS SPECIFICALLY
// -----------------------------------------------------------------------------
//
// It is the one module format all three consumers resolve without special
// configuration:
//
//   - `apps/api` is NodeNext WITHOUT `"type": "module"`, i.e. CommonJS, and it
//     runs under ts-jest. Jest's module registry does not reliably support
//     `require()` of an ESM package, so an ESM-only package here would pass
//     `tsc` and fail every API test.
//   - `apps/cli` is real ESM. Node reads named exports out of a CommonJS
//     module via cjs-module-lexer, and `exports.APP_NAME = ...` below is
//     exactly the assignment form that lexer detects.
//   - `apps/web` is Vite, which pre-bundles a CommonJS dependency as a matter
//     of routine.
//
// =============================================================================

/**
 * The application's display name.
 *
 * ▲ THIS IS THE LINE YOU EDIT TO REBRAND A FORK. There is no second copy.
 *
 * Every user-visible surface derives from it rather than restating it — see
 * README.md in this folder for the current consumer list. Two of them append a
 * suffix (`${APP_NAME} API`, `${APP_NAME} CLI`) instead of holding a second
 * literal, so the suffix survives a rename and the name does not have to.
 *
 * ONE THING TO KNOW BEFORE YOU CHANGE IT: the app name is rendered into the
 * visual-regression baselines under `tests/visual/specs/**\/*-snapshots/`, and
 * that suite runs at `maxDiffPixels: 4`. Changing this string is a real pixel
 * change, so the baselines must be regenerated in the pinned container — see
 * this folder's README for the exact command.
 */
exports.APP_NAME = 'OathPath';
