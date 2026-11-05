import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampHtml, stampJs } from '../scripts/stamp-version.mjs';

test('stamps local scripts and styles, leaves external links alone', () => {
  const html = '<link rel="stylesheet" href="styles.css"><script type="module" src="app.js"></script>' +
    '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"><a href="#gjafir">';
  assert.equal(
    stampHtml(html, 'abc123'),
    '<link rel="stylesheet" href="styles.css?v=abc123"><script type="module" src="app.js?v=abc123"></script>' +
      '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"><a href="#gjafir">',
  );
});

test('stamps relative ES module imports, static and dynamic', () => {
  const js = "import { a } from './shared/listdata.js';\nconst m = await import('./sheets-backend.js');\n" +
    "const l = () => import('./vendor/lookup.js');\nimport x from 'https://cdn.example/x.js';";
  assert.equal(
    stampJs(js, 'v1'),
    "import { a } from './shared/listdata.js?v=v1';\nconst m = await import('./sheets-backend.js?v=v1');\n" +
      "const l = () => import('./vendor/lookup.js?v=v1');\nimport x from 'https://cdn.example/x.js';",
  );
});
