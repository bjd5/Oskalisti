// Entry for public/vendor/lookup.js (npm run build:vendor): the product page parser and
// keyless search, bundled with cheerio for the browser. The Google Sheets backend passes in
// a page fetcher that goes through its Apps Script (browsers can't read other sites directly).
export { extractProductWith } from '../server/lookup/parse.js';
export { searchWith, NOTHING_FOUND_MESSAGE } from '../server/lookup/ddg.js';
export { compareWith } from '../server/lookup/compare.js';
