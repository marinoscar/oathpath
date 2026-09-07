import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildDevServiceWorkerSource,
  SELF_DESTROYING_SERVICE_WORKER,
  STATIC_SHELL_URLS,
} from '../../sw/buildServiceWorker';

// =============================================================================
// Which worker a DEV SERVER serves  (issue #395)
// =============================================================================
//
// `VITE_ENABLE_SW` was declared and read by issue #359 but never plumbed
// through `infra/compose`, so the containerised dev deployment — the one this
// application is actually exercised on — always took the disabled branch and
// served the self-destroying placeholder. The PWA was inert there: not
// installable, no offline shell, a dead update handshake, and nothing anywhere
// reporting a disabled feature. The branch had no test, so nothing failed.
//
// This suite covers the branch itself, through `buildDevServiceWorkerSource` —
// the exact function `pwa()`'s middleware in `vite.config.ts` calls. Booting a
// Vite server inside vitest would reach the same code through an HTTP stack
// that has nothing to do with what broke, and re-implementing the ternary here
// would assert against a paraphrase of it.
//
// Note what this suite does NOT test: whether the flag is ON anywhere. It is
// off by default and must stay off (see `registerServiceWorker.ts`); the defect
// was that it could not be turned on, not that it was not on.
// =============================================================================

const rawSource = readFileSync(resolve(__dirname, '..', '..', 'sw', 'service-worker.js'), 'utf8');

/** Reads the precache manifest back out of an emitted worker. */
function precacheUrlsIn(source: string): string[] {
  const match = source.match(/const PRECACHE_URLS = (\[[^\]]*\]);/);
  if (!match) throw new Error('emitted worker has no PRECACHE_URLS assignment');
  return JSON.parse(match[1]) as string[];
}

describe('buildDevServiceWorkerSource', () => {
  it('serves the REAL worker when the flag is on', () => {
    const source = buildDevServiceWorkerSource(rawSource, true);

    // The real worker, identified by the policy it carries rather than by its
    // length: the placeholder has no fetch handler and no cache routing at all.
    expect(source).toContain("addEventListener('fetch'");
    expect(source).toContain('PRECACHE_URLS');
    expect(source).not.toBe(SELF_DESTROYING_SERVICE_WORKER);
    expect(source).not.toContain('self.registration.unregister()');

    // Both build placeholders substituted. Shipping either literal would be a
    // worker whose build id is the string `__SW_BUILD_ID__` and whose precache
    // list is the one-entry array `['__PRECACHE_MANIFEST__']` — an install that
    // fails on a URL that does not exist.
    expect(source).not.toContain('__SW_BUILD_ID__');
    expect(source).not.toContain('__PRECACHE_MANIFEST__');
    expect(source).toContain('"dev"');
  });

  it('serves the self-destroying placeholder when the flag is off', () => {
    // Byte-identical, not merely similar: this is the branch a dev stack takes
    // by default, and it is also the only way back out for anyone who has a
    // real worker still installed from a session with the flag on.
    expect(buildDevServiceWorkerSource(rawSource, false)).toBe(SELF_DESTROYING_SERVICE_WORKER);
  });

  it('precaches the static shell and NOTHING ELSE', () => {
    // The load-bearing assertion of this file. In dev there is no bundle: the
    // "shell" is a module graph Vite rewrites on every edit, so a precached
    // module URL stops existing the moment a file is saved — and because
    // `addAll` is atomic, that is not a stale entry, it is an install that
    // fails outright and a worker that never activates.
    expect(precacheUrlsIn(buildDevServiceWorkerSource(rawSource, true))).toEqual(
      STATIC_SHELL_URLS,
    );
  });

  it('never precaches anything Vite serves from the module graph', () => {
    // Stated separately from the equality above so the intent survives a future
    // edit to STATIC_SHELL_URLS: whatever that list grows to, none of it may be
    // a dev-server URL.
    for (const url of precacheUrlsIn(buildDevServiceWorkerSource(rawSource, true))) {
      expect(url).not.toMatch(/^\/(src|@vite|@react-refresh|@fs|node_modules)\//);
      expect(url).not.toMatch(/\.(tsx?|jsx)$/);
      expect(url).not.toContain('?v=');
    }
  });
});

describe('the placeholder worker describes when it is used', () => {
  it('does not claim the real worker only ships in a production build', () => {
    // It used to, in its own first comment, and that was false the day #359
    // shipped: the dev middleware emits the real worker under the flag. The
    // claim mattered because it is the text a developer reads at the exact
    // moment they are looking at /sw.js wondering why the PWA is dead.
    expect(SELF_DESTROYING_SERVICE_WORKER).not.toContain('only for a production build');
    expect(SELF_DESTROYING_SERVICE_WORKER).toContain('VITE_ENABLE_SW=true');
  });
});
