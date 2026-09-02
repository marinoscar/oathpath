import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME } from '@app/shared';

/**
 * Substitutes `%APP_NAME%` in `index.html` with `APP_NAME` from `@app/shared`
 * (issue #164, epic #161).
 *
 * `index.html` is static markup: it carries the <title> and the description
 * meta, and it cannot import TypeScript, so it is the one user-visible surface
 * that could not simply reference the shared constant. The two obvious ways to
 * bridge that gap are both worse than a four-line plugin:
 *
 *   - An env var (`VITE_APP_NAME`), which Vite would interpolate into `%...%`
 *     for free. Rejected: it makes the deployment environment a SECOND source
 *     of truth for the name. `@app/shared` exists precisely so a fork renames
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

export default defineConfig({
  plugins: [react(), appName()],
  // `@app/shared` is CommonJS, and it reaches us as an npm WORKSPACE SYMLINK.
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
  optimizeDeps: { include: ['@app/shared'] },
  server: {
    port: 5173,
    host: true,
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
