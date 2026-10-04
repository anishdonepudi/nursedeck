/**
 * Rewrites non-ASCII characters in a source file as \uXXXX escapes.
 *
 * Two reasons this is worth doing in these files:
 *
 * 1. Readability. A literal zero-width space or BOM inside a character class is
 *    invisible in an editor and impossible to review.
 * 2. Toolchain safety. Multi-byte characters make a file's byte length differ
 *    from its character length, which breaks any transform that mixes the two.
 *
 * Usage: node scripts/escape-unicode.mjs <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node escape-unicode.mjs <file...>');
  process.exit(1);
}

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let replaced = 0;

  const after = [...before]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp === undefined || cp < 128) return ch;
      replaced += 1;
      if (cp > 0xffff) {
        // Astral plane: emit the surrogate pair.
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        return `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
      }
      return `\\u${cp.toString(16).padStart(4, '0')}`;
    })
    .join('');

  if (replaced === 0) {
    console.log(`${file}: already ASCII`);
    continue;
  }
  writeFileSync(file, after, 'utf8');
  console.log(`${file}: escaped ${replaced} character(s)`);
}
