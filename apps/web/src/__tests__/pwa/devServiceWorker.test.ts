import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildDevServiceWorkerSource, STATIC_SHELL_URLS } from '../../sw/buildServiceWorker';

// =============================================================================
// The worker a DEV SERVER serves, always  (issue #397)
// =============================================================================
//
// `VITE_ENABLE_SW` is gone. `buildDevServiceWorkerSource` now takes one
// argument and always returns the real worker — the same function `pwa()`'s
// middleware in `vite.config.ts` calls to answer `/sw.js`. Booting a Vite
// server inside vitest would reach the same code through an HTTP stack that
// has nothing to do with what this suite covers, and re-implementing the
// substitution here would assert against a paraphrase of the shipped file
// rather than the file itself.
//
// What makes always-on safe is NOT that the dev worker is inert — it is the
// real worker, unconditionally — it is (1) the precache list being exactly
// the static shell and nothing Vite serves from its module graph, and (2) the
// dev build id being volatile per process, so a restart or rebuild retires
// the previous run's caches instead of serving stale `public/` bytes forever.
// Both properties are covered below.
// =============================================================================

const rawSource = readFileSync(resolve(__dirname, '..', '..', 'sw', 'service-worker.js'), 'utf8');

/** Reads the precache manifest back out of an emitted worker. */
function precacheUrlsIn(source: string): string[] {
  const match = source.match(/const PRECACHE_URLS = (\[[^\]]*\]);/);
  if (!match) throw new Error('emitted worker has no PRECACHE_URLS assignment');
  return JSON.parse(match[1]) as string[];
}

/** Reads the build id back out of an emitted worker. */
function buildIdIn(source: string): string {
  const match = source.match(/const BUILD_ID = "([^"]*)";/);
  if (!match) throw new Error('emitted worker has no BUILD_ID assignment');
  return match[1];
}

describe('buildDevServiceWorkerSource', () => {
  it('always emits the real worker, unconditionally', () => {
    const source = buildDevServiceWorkerSource(rawSource);

    // The real worker, identified by the policy it carries: a fetch handler
    // and the caching-policy header that only the real worker has. There is
    // no disabled branch left to distinguish this from.
    expect(source).toContain("addEventListener('fetch'");
    expect(source).toContain('CACHING POLICY');
    expect(source).toContain('PRECACHE_URLS');
    expect(source).not.toContain('self.registration.unregister()');

    // Both build placeholders substituted. Shipping either literal would be a
    // worker whose build id is the string `__SW_BUILD_ID__` and whose precache
    // list is the one-entry array `['__PRECACHE_MANIFEST__']` — an install that
    // fails on a URL that does not exist.
    expect(source).not.toContain('__SW_BUILD_ID__');
    expect(source).not.toContain('__PRECACHE_MANIFEST__');
  });

  it('precaches the static shell and NOTHING ELSE', () => {
    // The load-bearing assertion of this file. In dev there is no bundle: the
    // "shell" is a module graph Vite rewrites on every edit, so a precached
    // module URL stops existing the moment a file is saved — and because
    // `addAll` is atomic, that is not a stale entry, it is an install that
    // fails outright and a worker that never activates.
    expect(precacheUrlsIn(buildDevServiceWorkerSource(rawSource))).toEqual(STATIC_SHELL_URLS);
  });

  it('never precaches anything Vite serves from the module graph', () => {
    // Stated separately from the equality above so the intent survives a future
    // edit to STATIC_SHELL_URLS: whatever that list grows to, none of it may be
    // a dev-server URL.
    for (const url of precacheUrlsIn(buildDevServiceWorkerSource(rawSource))) {
      expect(url).not.toMatch(/^\/(src|@vite|@react-refresh|@fs|node_modules)\//);
      expect(url).not.toMatch(/\.(tsx?|jsx)$/);
      expect(url).not.toContain('?v=');
    }
  });

  it('uses a build id shaped like `dev-<timestamp>`, never a fixed literal', () => {
    // A SHAPE check, not the literal `'dev'`: the id is `dev-${Date.now()}`,
    // computed once at module scope, so asserting an exact value here would
    // make the test depend on when it happened to run.
    const buildId = buildIdIn(buildDevServiceWorkerSource(rawSource));
    expect(buildId).toMatch(/^dev-\d+$/);
  });

  it('is not the literal string "dev" and is not a placeholder', () => {
    // Guards against a regression to the exact staleness bug #397 closed: a
    // fixed dev build id meant `PRECACHE_NAME`/`RUNTIME_NAME` never changed,
    // so a container rebuild shipping new `public/` bytes served the old ones
    // forever.
    const buildId = buildIdIn(buildDevServiceWorkerSource(rawSource));
    expect(buildId).not.toBe('dev');
    expect(buildId).not.toBe('__SW_BUILD_ID__');
  });

  it('emits the SAME build id across two calls in one process', () => {
    // This is the property that stops cache churn on every refresh: the id is
    // computed once at module scope (`DEV_BUILD_ID`), so it is stable for the
    // life of this process and only changes across process restarts.
    const first = buildIdIn(buildDevServiceWorkerSource(rawSource));
    const second = buildIdIn(buildDevServiceWorkerSource(rawSource));
    expect(first).toBe(second);
  });
});
