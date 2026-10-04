/**
 * Generates build/icon.png (1024x1024) with no image-library dependency.
 *
 * electron-builder derives the macOS .icns and Windows .ico from this single
 * PNG, so one file covers both platforms. Written by hand rather than pulling
 * in `sharp` (a native module) because keeping the dependency tree free of
 * native code is what makes the universal Mac build trivial.
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BG = [13, 18, 38];       // deep navy, matches the app background
const CROSS = [108, 140, 255]; // accent blue
const GLOW = [26, 37, 80];

/** Signed distance from a point to a rounded rectangle, for anti-aliasing. */
function roundedRectDist(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** One scanline of RGBA pixels, with a leading filter byte (0 = none). */
function buildRaw() {
  const rows = [];
  const c = SIZE / 2;
  const squircle = SIZE * 0.46;   // half-extent of the app tile
  const corner = SIZE * 0.22;     // macOS-ish corner radius

  // Cross geometry: a clean medical cross, optically centred.
  const armLong = SIZE * 0.30;
  const armShort = SIZE * 0.095;

  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(SIZE * 4 + 1);
    row[0] = 0;
    for (let x = 0; x < SIZE; x++) {
      const o = 1 + x * 4;

      const tileD = roundedRectDist(x, y, c, c, squircle, squircle, corner);
      // Outside the tile: fully transparent.
      const tileA = Math.max(0, Math.min(1, 0.5 - tileD));

      // Subtle diagonal glow so the tile is not a flat block.
      const g = Math.max(0, Math.min(1, (x + y) / (SIZE * 2)));
      let rgb = mix(GLOW, BG, g * 0.85 + 0.15);

      // Cross = union of two rounded bars.
      const vD = roundedRectDist(x, y, c, c, armShort, armLong, armShort * 0.42);
      const hD = roundedRectDist(x, y, c, c, armLong, armShort, armShort * 0.42);
      const crossD = Math.min(vD, hD);
      const crossA = Math.max(0, Math.min(1, 0.5 - crossD));

      if (crossA > 0) rgb = mix(rgb, CROSS, crossA);

      row[o] = rgb[0];
      row[o + 1] = rgb[1];
      row[o + 2] = rgb[2];
      row[o + 3] = Math.round(tileA * 255);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type: RGBA
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // adaptive filtering
ihdr[12] = 0;  // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(buildRaw(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await mkdir(join(root, 'build'), { recursive: true });
await writeFile(join(root, 'build', 'icon.png'), png);
console.log(`build/icon.png written (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} kB)`);
