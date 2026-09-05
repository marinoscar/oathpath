import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildWebManifest, renderWebManifest } from '../../config/webManifest';

// =============================================================================
// The web app manifest, and the icons it points at  (issue #359, epic #345)
// =============================================================================
//
// Every assertion here corresponds to something Chrome's installability check
// actually reads. The failure mode this guards against is specific and silent:
// an app that looks finished, offers no install prompt, and gives no error on
// the page — the browser simply declines, and the reason is in a devtools panel
// nobody thought to open.
//
// The icons are checked as BYTES, not as paths. A manifest entry pointing at a
// file that is not a decodable image fails installability exactly as a missing
// file does, so "the file exists" is not the property worth asserting.
// =============================================================================

const webRoot = resolve(__dirname, '..', '..', '..');
const publicDir = resolve(webRoot, 'public');

/** The eight-byte PNG signature, per the spec's first paragraph. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads a real PNG's dimensions out of its IHDR, which is always first. */
function readPngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG').toBe(true);
  expect(bytes.subarray(12, 16).toString('ascii'), 'first chunk is not IHDR').toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('web app manifest', () => {
  const manifest = buildWebManifest();

  it('parses as JSON', () => {
    expect(() => JSON.parse(renderWebManifest())).not.toThrow();
    expect(JSON.parse(renderWebManifest())).toEqual(manifest);
  });

  it('declares every field an installability check requires', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('takes its name from @oathpath/shared rather than a second literal', () => {
    // The whole reason this is a module and not `public/manifest.webmanifest`.
    // A fork renames the product in ONE line; the home-screen label has to
    // follow it, and nothing but this would notice if it stopped.
    const renamed = buildWebManifest('Renamed');
    expect(renamed.name).toBe('Renamed');
    expect(renamed.short_name).toBe('Renamed');
    expect(renamed.description).toContain('Renamed');
  });

  it('declares a maskable icon of at least 512px', () => {
    // Without a maskable entry Android draws the `any` icon shrunk inside a
    // white circle. This is the single most commonly missed manifest field.
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
    expect(maskable.length).toBeGreaterThan(0);
    expect(maskable.some((icon) => icon.sizes === '512x512')).toBe(true);
  });

  it('declares both the 192 and 512 `any` icons Chrome looks for', () => {
    const anySizes = manifest.icons
      .filter((icon) => icon.purpose !== 'maskable')
      .map((icon) => icon.sizes);
    expect(anySizes).toContain('192x192');
    expect(anySizes).toContain('512x512');
  });

  it('points every icon at a real, decodable PNG of the size it claims', () => {
    for (const icon of manifest.icons) {
      const file = resolve(publicDir, icon.src.replace(/^\//, ''));
      expect(existsSync(file), `${icon.src} is missing`).toBe(true);

      const bytes = readFileSync(file);
      const { width, height } = readPngSize(bytes);
      const [declaredWidth, declaredHeight] = icon.sizes.split('x').map(Number);
      expect({ width, height }, `${icon.src} is not ${icon.sizes}`).toEqual({
        width: declaredWidth,
        height: declaredHeight,
      });
      // A placeholder that decodes but carries nothing would still pass the
      // header checks above; a few hundred bytes of real artwork will not be
      // this small.
      expect(bytes.length, `${icon.src} is suspiciously small`).toBeGreaterThan(256);
    }
  });

  it('ships an apple-touch-icon at the 180px size iOS asks for', () => {
    // iOS reads none of the manifest for the home-screen icon — only the
    // <link rel="apple-touch-icon"> asserted in the index.html suite below.
    const bytes = readFileSync(resolve(publicDir, 'icons/apple-touch-icon-180.png'));
    expect(readPngSize(bytes)).toEqual({ width: 180, height: 180 });
  });
});

describe('index.html', () => {
  const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');

  it('links the manifest', () => {
    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
  });

  it('sets viewport-fit=cover, without which every env() inset resolves to 0', () => {
    // The one line that makes the safe-area padding in `BottomNav` and
    // `Layout` do anything at all on iOS.
    expect(html).toMatch(/name="viewport"[\s\S]*?viewport-fit=cover/);
  });

  it('declares a theme-color for light AND dark, matching the app surfaces', () => {
    // `background.paper` of each theme — the colour the AppBar paints, which is
    // what sits directly under the window chrome `theme-color` tints.
    expect(html).toMatch(
      /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)"/,
    );
    expect(html).toMatch(
      /<meta name="theme-color" content="#1e1e1e" media="\(prefers-color-scheme: dark\)"/,
    );
  });

  it('declares the apple-touch-icon and the apple-mobile-web-app metas', () => {
    expect(html).toMatch(/rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon-180\.png"/);
    expect(html).toMatch(/name="apple-mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style"/);
    expect(html).toMatch(/name="apple-mobile-web-app-title"/);
    // The modern spelling of the same capability, which Chromium prefers.
    expect(html).toMatch(/name="mobile-web-app-capable" content="yes"/);
  });

  it('declares a favicon', () => {
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/icons\/icon\.svg"/);
    expect(html).toMatch(/<link rel="icon" type="image\/png" sizes="32x32"/);
  });
});
