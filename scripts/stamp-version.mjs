// Cache busting for GitHub Pages: adds ?v=<version> to the page's own scripts, styles and
// relative ES module imports, so browsers (Safari especially) never mix an old app.js with
// new files after an update. Run by .github/workflows/pages.yml on the copy it publishes.
//
//   node scripts/stamp-version.mjs <dir> <version>

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function stampHtml(html, v) {
  return html.replace(/\b(src|href)="((?!https?:|\/\/|#|data:)[^"?#]+\.(?:js|css|svg))"/g, `$1="$2?v=${v}"`);
}

export function stampJs(js, v) {
  // from './x.js'  ·  import('./x.js')  ·  import './x.js'
  return js.replace(/((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+))(['"])(\.{1,2}\/[^'"?#]+\.js)\2/g, `$1$2$3?v=${v}$2`);
}

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else yield full;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !/^[\w.-]+$/.test(version || '')) {
    console.error('Usage: node scripts/stamp-version.mjs <dir> <version>');
    process.exit(1);
  }
  for await (const file of files(dir)) {
    if (file.endsWith('.html')) await writeFile(file, stampHtml(await readFile(file, 'utf8'), version));
    else if (file.endsWith('.js')) await writeFile(file, stampJs(await readFile(file, 'utf8'), version));
  }
  console.log(`Stamped ${dir} with v=${version}`);
}
