/**
 * Draws a PNG that looks like a page of study notes, so image ingest can be
 * tested without committing a photograph.
 *
 * Text is rendered as pixel glyphs rather than with a font library, keeping the
 * dependency tree free of native code. Usage:
 *   node tests/fixtures/make-note-image.mjs <outPath>
 */
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

/* A 5x7 pixel font, enough for the characters these notes use. */
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  Z: ['11111', '00010', '00100', '01000', '10000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '01100', '11000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '(': ['00110', '01000', '10000', '10000', '10000', '01000', '00110'],
  ')': ['11000', '00010', '00001', '00001', '00001', '00010', '11000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const LINES = [
  'POTASSIUM NOTES',
  '',
  'NORMAL K+ = 3.5 - 5.0 MEQ/L',
  'LOW K+ < 3.5 = HYPOKALEMIA',
  'HIGH K+ > 5.0 = HYPERKALEMIA',
  '',
  'NEVER GIVE KCL IV PUSH',
  'IT IS FATAL. INFUSION ONLY.',
  '',
  'LOW K+ MAKES DIGOXIN TOXIC',
];

const SCALE = 4;
const CHAR_W = 6 * SCALE;
const CHAR_H = 8 * SCALE;
const PAD = 40;
const WIDTH = PAD * 2 + CHAR_W * 32;
const HEIGHT = PAD * 2 + CHAR_H * LINES.length;

const INK = [26, 35, 90];
const PAPER = [252, 250, 242];

const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
for (let i = 0; i < WIDTH * HEIGHT; i++) {
  pixels[i * 3] = PAPER[0];
  pixels[i * 3 + 1] = PAPER[1];
  pixels[i * 3 + 2] = PAPER[2];
}

function plot(x, y) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const o = (y * WIDTH + x) * 3;
  pixels[o] = INK[0];
  pixels[o + 1] = INK[1];
  pixels[o + 2] = INK[2];
}

LINES.forEach((line, row) => {
  const y0 = PAD + row * CHAR_H;
  [...line.toUpperCase()].forEach((ch, col) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    const x0 = PAD + col * CHAR_W;
    glyph.forEach((bits, gy) => {
      [...bits].forEach((bit, gx) => {
        if (bit !== '1') return;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            plot(x0 + gx * SCALE + sx, y0 + gy * SCALE + sy);
          }
        }
      });
    });
  });
});

/* --- encode as PNG --- */
const raw = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
for (let y = 0; y < HEIGHT; y++) {
  raw[y * (WIDTH * 3 + 1)] = 0;
  pixels.copy(raw, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
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
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;
ihdr[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2];
if (!out) {
  console.error('usage: node make-note-image.mjs <outPath>');
  process.exit(1);
}
await writeFile(out, png);
console.log(`${out} (${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(1)} kB)`);
