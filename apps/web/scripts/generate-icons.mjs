// =============================================================================
// PWA icon generator — real PNGs, written with nothing but Node's own zlib
// =============================================================================
//
// Issue #359, epic #345. An installable PWA needs REAL raster icons: Chrome's
// installability check parses the bytes, and a placeholder that fails to decode
// fails the check with no visible error on the page. So these have to be valid
// PNGs, not an SVG renamed or a 1x1 transparent pixel.
//
// WHY THIS SCRIPT EXISTS RATHER THAN A DEPENDENCY.
// `sharp`, `canvas`, `resvg` and friends are all native modules, and none of
// them is in this repository's dependency tree. Adding one buys a compile step
// and a platform-specific binary in CI for four static files that change
// roughly never. A PNG encoder, on the other hand, is about sixty lines on top
// of `node:zlib`: the format is a signature, three chunks, and a CRC32 — and
// `deflateSync` is the only hard part, which the standard library already does.
//
// WHY THE OUTPUT IS COMMITTED.
// The icons are committed to `public/icons/` and this script is NOT part of the
// build. `npm run build` must not depend on regenerating artwork, and a
// reviewer should be able to look at the icons in the diff. Re-run it by hand
// (`node scripts/generate-icons.mjs`) only when the mark or the brand colour
// actually changes.
//
// THE MARK. A white check inside the brand blue (`#1976d2`, the `primary.main`
// of `src/theme/light.ts`). Every path below is expressed in NORMALISED [0,1]
// coordinates so one geometry description serves every size, and so the
// maskable variant can be checked against Android's safe zone arithmetically
// rather than by eye — see `assertInsideMaskableSafeZone` at the bottom.
// =============================================================================

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/** `primary.main` from `src/theme/light.ts`. Kept in sync by hand — it is the
 *  wordmark colour, not a token the artwork can import at generation time. */
const BRAND = [0x19, 0x76, 0xd2];
const WHITE = [0xff, 0xff, 0xff];

/** The check, as a polyline in normalised coordinates, plus its stroke width. */
const CHECK_POINTS = [
  [0.285, 0.515],
  [0.44, 0.67],
  [0.735, 0.335],
];
const CHECK_WIDTH = 0.105;
/** Corner radius of the rounded-square background, as a fraction of the side. */
const CORNER_RADIUS = 0.22;

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** RGBA pixel buffer -> a valid 8-bit truecolour-with-alpha PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline, which is what the spec requires
  // even when no filtering is used.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Distance from a point to a line segment, all in normalised coordinates. */
function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Inside the rounded square of the given corner radius? `radius: 0` = full bleed. */
function insideRoundedSquare(x, y, radius) {
  if (radius <= 0) return true;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Inside the check stroke (round caps and joins fall out of the distance test)? */
function insideCheck(x, y) {
  const half = CHECK_WIDTH / 2;
  for (let i = 0; i < CHECK_POINTS.length - 1; i += 1) {
    if (distanceToSegment(x, y, CHECK_POINTS[i], CHECK_POINTS[i + 1]) <= half) return true;
  }
  return false;
}

/**
 * Renders the mark at `size`, antialiasing by 4x4 supersampling.
 *
 * Supersampling rather than analytic coverage because the shapes here are
 * unions of circles and boxes, and averaging 16 boolean samples per pixel is
 * both shorter and obviously correct at every size we emit.
 */
function renderIcon(size, { radius = CORNER_RADIUS } = {}) {
  const SAMPLES = 4;
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const nx = (x + (sx + 0.5) / SAMPLES) / size;
          const ny = (y + (sy + 0.5) / SAMPLES) / size;
          if (insideRoundedSquare(nx, ny, radius)) bgHits += 1;
          if (insideCheck(nx, ny)) fgHits += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const bg = bgHits / total;
      // The check is clipped to the background, so a stroke that ran off a
      // rounded corner could never leave a white spur outside the tile.
      const fg = (fgHits / total) * bg;

      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        // Composite white over blue, then the whole tile over transparency.
        const colour = BRAND[c] * (1 - fg) + WHITE[c] * fg;
        rgba[offset + c] = Math.round(colour);
      }
      rgba[offset + 3] = Math.round(bg * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/** The same geometry as SVG, for the crisp `rel="icon"` browsers prefer. */
function renderSvg() {
  const d = CHECK_POINTS.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(x * 512).toFixed(1)} ${(y * 512).toFixed(1)}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="OathPath">
  <rect width="512" height="512" rx="${(CORNER_RADIUS * 512).toFixed(1)}" fill="#1976d2"/>
  <path d="${d}" fill="none" stroke="#ffffff" stroke-width="${(CHECK_WIDTH * 512).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// The maskable safe zone, checked rather than eyeballed
// ---------------------------------------------------------------------------
//
// Android may crop a maskable icon to any shape inscribed in the tile; the
// guaranteed-visible region is the CENTRED CIRCLE OF DIAMETER 80%. Artwork
// outside it can be shaved off, so the check has to fit inside that circle with
// its stroke width accounted for — which is exactly what this asserts.
function assertInsideMaskableSafeZone() {
  const safeRadius = 0.4;
  for (const [x, y] of CHECK_POINTS) {
    const distance = Math.hypot(x - 0.5, y - 0.5) + CHECK_WIDTH / 2;
    if (distance > safeRadius) {
      throw new Error(
        `check point (${x}, ${y}) reaches ${distance.toFixed(3)} from centre, outside the 0.4 maskable safe radius`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

assertInsideMaskableSafeZone();
mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  // `purpose: any` — drawn as-is, so it carries its own rounded corners.
  ['icon-192.png', renderIcon(192)],
  ['icon-512.png', renderIcon(512)],
  // `purpose: maskable` — FULL BLEED. Android supplies the mask; shipping a
  // pre-rounded tile as maskable gets it rounded twice, with the visible
  // result being a small badge floating in a coloured square.
  ['icon-maskable-512.png', renderIcon(512, { radius: 0 })],
  // iOS applies its own corner radius to the home-screen icon and does not
  // honour transparency, so this is full bleed too.
  ['apple-touch-icon-180.png', renderIcon(180, { radius: 0 })],
  ['favicon-32.png', renderIcon(32)],
  ['favicon-16.png', renderIcon(16)],
  ['icon.svg', Buffer.from(renderSvg(), 'utf8')],
];

for (const [name, bytes] of outputs) {
  writeFileSync(resolve(OUT_DIR, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
