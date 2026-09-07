import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME } from '@oathpath/shared';
import { renderWebManifest } from './src/config/webManifest';
import { renderOfflineShell } from './src/sw/offlineShell';
import {
  buildServiceWorkerSource,
  buildDevServiceWorkerSource,
  STATIC_SHELL_URLS,
} from './src/sw/buildServiceWorker';

/**
 * Substitutes `%APP_NAME%` in `index.html` with `APP_NAME` from `@oathpath/shared`
 * (issue #164, epic #161).
 *
 * `index.html` is static markup: it carries the <title> and the description
 * meta, and it cannot import TypeScript, so it is the one user-visible surface
 * that could not simply reference the shared constant. The two obvious ways to
 * bridge that gap are both worse than a four-line plugin:
 *
 *   - An env var (`VITE_APP_NAME`), which Vite would interpolate into `%...%`
 *     for free. Rejected: it makes the deployment environment a SECOND source
 *     of truth for the name. `@oathpath/shared` exists precisely so a fork renames
 *     the product in one line; a build that also has to set an env var can
 *     silently disagree with the wordmark the React tree renders.
 *   - Setting `document.title` at runtime from `main.tsx`. Rejected: the
 *     document parses and paints with whatever the literal HTML said before
 *     any script runs, so the user gets a visible flash of the placeholder in
 *     the browser tab.
 *
 * A build-time transform has neither problem: one source of truth, resolved
 * before the HTML is ever served, so nothing at runtime is involved at all.
 * It applies in dev too (`transformIndexHtml` runs on every served request),
 * so the placeholder is never observable anywhere.
 *
 * `order: 'pre'` so this runs ahead of Vite's own built-in `%ENV_VAR%` HTML
 * replacement, which would otherwise be looking at the same token.
 */
function appName(): Plugin {
  return {
    name: 'app-name-html',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('%APP_NAME%', APP_NAME),
    },
  };
}


/**
 * The PWA build step (issue #359, epic #345): the web app manifest, the offline
 * shell and the service worker.
 *
 * WHY A HAND-WRITTEN PLUGIN RATHER THAN `vite-plugin-pwa`.
 *
 * The plugin would have been the default choice, and it does support Vite 8.
 * Two things ruled it out here:
 *
 *   - The load-bearing requirement of this issue is "no API response is ever
 *     written to a cache", asserted by a test. `generateSW` emits a Workbox
 *     worker that exists only in `dist/`, so the code carrying that policy
 *     would never appear in a diff and a test could only read a build artefact.
 *     `injectManifest` puts the worker back in the repository — at which point
 *     the worker is hand-written anyway and the plugin is doing the ~40 lines
 *     below plus three new packages.
 *   - Those three packages (`vite-plugin-pwa`, `workbox-build`,
 *     `workbox-window`) install into a `node_modules` shared, by symlink, with
 *     every other worktree in this repository.
 *
 * What is emitted:
 *
 *   dist/manifest.webmanifest  from `src/config/webManifest.ts`
 *   dist/offline.html          from `src/sw/offlineShell.ts`
 *   dist/sw.js                 from `src/sw/service-worker.js`, with its build
 *                              id and precache manifest substituted in
 *
 * In DEV all three are served from middleware instead, so `/manifest.webmanifest`,
 * `/offline.html` and `/sw.js` are never missing — and `/sw.js` is the REAL
 * worker, unconditionally (issue #397). There is no flag and no placeholder.
 *
 * That is safe because of what the worker itself does: navigations are
 * network-first, `/src/**`, `/@vite/client` and `/@react-refresh` are never
 * intercepted at all, nothing under `/api` is ever cached, and Vite's
 * `?v=`/`?t=` query versioning is part of every cache key. The one genuine
 * hazard — cache names that never changed, so rebuilt `public/` bytes stayed
 * stale forever — is closed by the volatile per-process dev build id in
 * `buildDevServiceWorkerSource` (`src/sw/buildServiceWorker.ts`), which retires
 * the previous run's caches on every restart. See
 * `src/sw/registerServiceWorker.ts` for the matching client-side gate, where
 * `test` is now the only environment the worker is off in.
 */
function pwa(): Plugin {
  const here = resolve(fileURLToPath(import.meta.url), '..');
  const readServiceWorkerSource = () =>
    readFileSync(resolve(here, 'src/sw/service-worker.js'), 'utf8');

  return {
    name: 'oathpath-pwa',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/manifest.webmanifest') {
          res.setHeader('Content-Type', 'application/manifest+json');
          res.end(renderWebManifest(APP_NAME));
          return;
        }
        if (path === '/offline.html') {
          res.setHeader('Content-Type', 'text/html');
          res.end(renderOfflineShell(APP_NAME));
          return;
        }
        if (path === '/sw.js') {
          res.setHeader('Content-Type', 'text/javascript');
          // Never cached — a worker the browser will not re-fetch is a worker
          // that can never be replaced.
          res.setHeader('Cache-Control', 'no-cache');
          res.end(buildDevServiceWorkerSource(readServiceWorkerSource()));
          return;
        }
        next();
      });
    },

    generateBundle(_options, bundle) {
      // THE ENTRY CHUNK AND THE STYLESHEETS ONLY — not every chunk in the
      // bundle. `App.tsx` lazy-loads ~30 route chunks; precaching all of them
      // would download the whole application on first visit to support an
      // offline mode this epic explicitly does not build. Lazy chunks are still
      // cached on demand by the worker's `asset` class, which is cache-first.
      const shellAssets = Object.values(bundle)
        .filter(
          (output) =>
            (output.type === 'chunk' && output.isEntry) ||
            (output.type === 'asset' && output.fileName.endsWith('.css')),
        )
        .map((output) => `/${output.fileName}`)
        .sort();

      const precacheUrls = [...STATIC_SHELL_URLS, ...shellAssets];
      // Derived from the precache list itself, so a deployment that changed
      // nothing produces the same cache names and does not needlessly evict a
      // learner's shell, while any real change retires the old caches on
      // `activate`.
      const buildId = createHash('sha256')
        .update(precacheUrls.join('\n'))
        .digest('hex')
        .slice(0, 12);

      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: renderWebManifest(APP_NAME),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'offline.html',
        source: renderOfflineShell(APP_NAME),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: buildServiceWorkerSource(readServiceWorkerSource(), { buildId, precacheUrls }),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), appName(), pwa()],
  // `@oathpath/shared` is CommonJS, and it reaches us as an npm WORKSPACE SYMLINK.
  // Vite treats a linked package as project source rather than as a dependency,
  // so it skips dep pre-bundling for it and serves `index.js` to the browser as
  // raw ESM — where `exports.APP_NAME = ...` provides no named export and the
  // module throws "does not provide an export named 'APP_NAME'", taking the
  // whole app down with a blank page.
  //
  // Listing it here forces the pre-bundle that an unlinked CommonJS dependency
  // would have got automatically, which is what converts it to ESM.
  //
  // This only bites in DEV. The production build (Rollup's commonjs plugin) and
  // the Vitest suites (their own CJS interop) both handle the same file without
  // help, which is precisely why the failure surfaces in the dev-server-backed
  // visual harness and nowhere else. See `visual/vite.config.ts`, which needs
  // the same line for the same reason.
  optimizeDeps: { include: ['@oathpath/shared'] },
  server: {
    port: 5173,
    host: true,
    // The dev VPS proxies oathpath.dev.marin.cr to this server; without this
    // entry Vite 5+'s Host header check rejects the request and every page
    // load is blocked.
    allowedHosts: ['oathpath.dev.marin.cr', 'localhost', '.localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
