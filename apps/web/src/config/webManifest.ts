/**
 * The web app manifest, as data (issue #359, epic #345).
 *
 * WHY THIS IS A MODULE AND NOT `public/manifest.webmanifest`.
 * `name` and `short_name` are the product's display name, and this repository
 * has exactly one of those: `APP_NAME` in `@oathpath/shared`, "the one line a
 * fork edits to rebrand". A static file in `public/` would be a second copy of
 * it — the precise failure that package exists to prevent, and one nothing
 * would catch, because a manifest is only ever read by the browser's install
 * flow. Building it here means the installed home-screen label follows a
 * rename for free, exactly as `index.html`'s `<title>` already does through the
 * `appName()` plugin.
 *
 * `vite.config.ts`'s `pwa()` plugin is the only consumer: it emits this as
 * `dist/manifest.webmanifest` at build time and serves the same bytes from
 * middleware in dev, so there is no mode in which the manifest is absent or
 * stale relative to this file.
 *
 * COLOURS ARE THE APP'S OWN SURFACES, not a brand sheet:
 *   - `theme_color`   → `background.paper` of `src/theme/light.ts` (#ffffff),
 *     which is what `AppBar.tsx` paints itself with (`position: sticky`,
 *     `color="default"`, `backgroundColor: theme.palette.background.paper`).
 *     It is therefore the colour immediately under the status bar in a
 *     standalone window, which is the only thing `theme_color` controls.
 *   - `background_color` → `background.default` (#f5f5f5), the colour the
 *     splash screen paints before the first frame — the shell's own
 *     `backgroundColor` in `common/Layout.tsx`.
 * `index.html` carries the dark counterparts as a second `theme-color` meta
 * behind `media="(prefers-color-scheme: dark)"`; the manifest format has one
 * `theme_color` and no media form, so the light value is the one that goes
 * here.
 */

import { APP_NAME } from '@oathpath/shared';

/** `background.paper`, light — the AppBar's fill. See the header. */
export const THEME_COLOR_LIGHT = '#ffffff';
/** `background.paper`, dark — `src/theme/dark.ts`. */
export const THEME_COLOR_DARK = '#1e1e1e';
/** `background.default`, light — the splash ground. */
export const BACKGROUND_COLOR_LIGHT = '#f5f5f5';

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable';
}

export interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: WebManifestIcon[];
}

export function buildWebManifest(appName: string = APP_NAME): WebManifest {
  return {
    name: appName,
    // Home-screen labels are truncated around 12 characters on both platforms,
    // so `short_name` is the one a launcher actually shows.
    short_name: appName,
    description: `${appName} — study for the U.S. naturalization civics and English tests.`,
    // `/` and not `/index.html`: the SPA is served by an nginx `try_files`
    // fallback, and a launcher that opened `/index.html` would put a URL in the
    // history that `react-router` never generates.
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // `portrait-primary` would lock a phone rotated into landscape out of the
    // layout the rail is designed for at >= 600px. `any` keeps the responsive
    // chrome the app already has.
    orientation: 'any',
    background_color: BACKGROUND_COLOR_LIGHT,
    theme_color: THEME_COLOR_LIGHT,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // REQUIRED for a correct Android home-screen icon. Without a `maskable`
      // entry Android treats the `any` icon as a legacy icon and draws it
      // shrunk inside a white circle; with it, the artwork fills the adaptive
      // shape. `scripts/generate-icons.mjs` renders this one full-bleed and
      // asserts the mark sits inside the 80% safe zone.
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

/** The exact bytes served at `/manifest.webmanifest`, in both dev and build. */
export function renderWebManifest(appName: string = APP_NAME): string {
  return `${JSON.stringify(buildWebManifest(appName), null, 2)}\n`;
}
