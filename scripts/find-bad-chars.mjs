/**
 * Scans source files for characters that JavaScript treats as line terminators
 * inside string literals.
 *
 * U+2028 / U+2029 are the dangerous ones: TypeScript accepts them, but esbuild
 * ends the string there, producing an "unterminated string literal" in the
 * bundle with a line number that points at unrelated code. Easier to find with
 * a scanner than by bisecting the bundle.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', 'out', '.git', 'release', 'dist']);
const EXT = /\.(ts|tsx|mjs|js|css)$/;

// U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, plus stray C0 controls.
const BAD = new RegExp("[\u2028\u2029\u0000-\u0008\u000B\u000C\u000E-\u001F]");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (EXT.test(entry)) out.push(path);
  }
  return out;
}

let found = 0;
const roots = process.argv.slice(2);
const targets = (roots.length > 0 ? roots : ['.']).flatMap((r) => walk(r));

for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (!BAD.test(line)) return;
    const codes = [...new Set([...line].filter((c) => BAD.test(c))
      .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];
    console.log(`${file}:${i + 1}  ${codes.join(', ')}`);
    found += 1;
  });
}

if (found === 0) {
  console.log('clean');
} else {
  console.error(`${found} line(s) contain characters that will break the bundler.`);
  process.exit(1);
}
