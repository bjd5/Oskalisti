/**
 * Óskalisti – gagnaskrá í Google Sheets.
 *
 * Þessi kóði breytir Google-töflureikni í „gagnagrunn“ fyrir óskalistann á GitHub Pages.
 * Uppsetning (sjá líka README):
 *   1. Búðu til nýjan Google Sheet (sheets.new).
 *   2. Extensions → Apps Script. Eyddu því sem er fyrir og límdu þennan kóða inn. Vistaðu (Ctrl/Cmd+S).
 *   3. Veldu fallið „setup“ efst og ýttu á Run. Samþykktu aðganginn sem Google biður um
 *      („Advanced“ → „Go to … (unsafe)“ ef Google varar við – þetta er þinn eigin kóði).
 *   4. Í töflureikninum er nú flipinn „Aðgangur“. Skrifaðu aðgangskóðann ykkar í reit B1.
 *   5. Deploy → New deployment → tegund „Web app“:
 *        Execute as: Me    ·    Who has access: Anyone
 *      Ýttu á Deploy og afritaðu „Web app URL“ (endar á /exec).
 *   6. Settu slóðina í public/config.json í repoinu (eða sendu hana Claude).
 *
 * Gestir geta bara lesið listann. Til að breyta þarf aðgangskóðann í reit B1 í „Aðgangur“.
 * Kóðanum má breyta hvenær sem er beint í töflureikninum.
 */

var SHEET_ITEMS = 'Gjafir';
var SHEET_CATEGORIES = 'Flokkar';
var SHEET_SETTINGS = 'Stillingar';
var SHEET_ACCESS = 'Aðgangur';

// [field in the JSON, column header in the sheet]
var ITEM_COLUMNS = [
  ['id', 'id'],
  ['name', 'Nafn'],
  ['description', 'Lýsing'],
  ['categoryId', 'Flokkur'],
  ['price', 'Verð (kr.)'],
  ['imageUrl', 'Mynd'],
  ['offers', 'Verslanir'],
  ['favorite', 'Efst á lista'],
  ['purchased', 'Keypt'],
  ['purchasedAt', 'Keypt þann'],
  ['createdAt', 'Búið til'],
  ['updatedAt', 'Breytt'],
];
var CATEGORY_COLUMNS = [
  ['id', 'id'],
  ['name', 'Nafn'],
  ['icon', 'Tákn'],
];
var SETTINGS_ROWS = [
  ['title', 'Titill', 'Óskalistinn okkar'],
  ['subtitle', 'Undirtitill', 'Hugmyndir að gjöfum – jól, afmæli, innflutningur og önnur tilefni'],
  ['intro', 'Kynning', ''],
];
var DEFAULT_CATEGORIES = [
  ['eldhusid', 'Í eldhúsið', '🍳'],
  ['heimilid', 'Fyrir heimilið', '🏡'],
  ['hjonarumid', 'Hjónarúmið', '🛏️'],
  ['bordstofan', 'Borðstofan', '🍽️'],
  ['annad', 'Annað', '🎁'],
];

var MAX_FAILED_LOGINS = 20; // per 10 minutes, across everyone
var MAX_PAGE_CHARS = 3000000;

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/** Public: the whole list as JSON. */
function doGet() {
  return respond(readData());
}

/** Admin actions: { action: "login" | "save" | "fetch", code, ... } sent as text/plain JSON. */
function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ error: 'Ógild beiðni.', status: 400 });
  }
  var denied = checkCode(req.code);
  if (denied) return respond(denied);

  if (req.action === 'login') return respond({ ok: true });
  if (req.action === 'save') return respond(save(req.data, req.version));
  if (req.action === 'fetch') return respond(fetchPage(req.url));
  return respond({ error: 'Óþekkt aðgerð.', status: 400 });
}

/** Run once from the editor: creates the tabs with default categories and settings. */
function setup() {
  ensureSheets();
}

// ---------------------------------------------------------------------------
// Access code
// ---------------------------------------------------------------------------

function checkCode(code) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('failedLogins') || 0);
  if (fails >= MAX_FAILED_LOGINS) {
    return { error: 'Of margar tilraunir. Reyndu aftur eftir smá stund.', status: 429 };
  }
  var expected = String(sheet(SHEET_ACCESS).getRange('B1').getDisplayValue() || '').trim();
  if (!expected) {
    return { error: 'Aðgangskóði hefur ekki verið settur. Skrifaðu hann í reit B1 í flipanum „Aðgangur“.', status: 401 };
  }
  if (typeof code !== 'string' || code.trim() !== expected) {
    cache.put('failedLogins', String(fails + 1), 600);
    return { error: 'Rangur aðgangskóði.', status: 401 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading and writing the sheets
// ---------------------------------------------------------------------------

function readData() {
  ensureSheets();
  var items = readTable(sheet(SHEET_ITEMS), ITEM_COLUMNS).map(function (row) {
    var offers = [];
    try {
      offers = row.offers ? JSON.parse(row.offers) : [];
    } catch (err) {
      offers = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      categoryId: row.categoryId,
      price: row.price === '' ? null : Number(String(row.price).replace(/[^\d]/g, '')) || null,
      imageUrl: row.imageUrl,
      offers: Array.isArray(offers) ? offers : [],
      favorite: isYes(row.favorite),
      purchased: isYes(row.purchased),
      purchasedAt: row.purchasedAt || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }).filter(function (item) {
    return item.id && item.name;
  });

  var categories = readTable(sheet(SHEET_CATEGORIES), CATEGORY_COLUMNS).filter(function (c) {
    return c.id && c.name;
  });

  var settings = {};
  var settingValues = sheet(SHEET_SETTINGS).getDataRange().getDisplayValues();
  SETTINGS_ROWS.forEach(function (def, i) {
    settings[def[0]] = settingValues[i] ? settingValues[i][1] : def[2];
  });

  return { settings: settings, categories: categories, items: items, version: getVersion() };
}

function save(data, version) {
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.categories) || !data.settings) {
    return { error: 'Ógild gögn.', status: 400 };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (String(version) !== String(getVersion())) {
      return { error: 'Einhver annar var að vista á sama tíma.', status: 409 };
    }
    ensureSheets();
    writeTable(sheet(SHEET_ITEMS), ITEM_COLUMNS, data.items.map(function (item) {
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        categoryId: item.categoryId,
        price: item.price === null || item.price === undefined ? '' : String(item.price),
        imageUrl: item.imageUrl,
        offers: JSON.stringify(item.offers || []),
        favorite: item.favorite ? 'já' : '',
        purchased: item.purchased ? 'já' : '',
        purchasedAt: item.purchasedAt || '',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    }));
    writeTable(sheet(SHEET_CATEGORIES), CATEGORY_COLUMNS, data.categories);
    sheet(SHEET_SETTINGS).getRange(1, 1, SETTINGS_ROWS.length, 2).setValues(
      SETTINGS_ROWS.map(function (def) {
        return [def[1], String(data.settings[def[0]] || '')];
      })
    );
    var next = getVersion() + 1;
    PropertiesService.getScriptProperties().setProperty('version', String(next));
    return { ok: true, version: next };
  } finally {
    lock.releaseLock();
  }
}

function readTable(sh, columns) {
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  var header = values[0];
  var index = columns.map(function (col) {
    return header.indexOf(col[1]);
  });
  return values.slice(1).map(function (row) {
    var obj = {};
    columns.forEach(function (col, i) {
      obj[col[0]] = index[i] === -1 ? '' : String(row[index[i]] || '').trim();
    });
    return obj;
  });
}

function writeTable(sh, columns, rows) {
  var values = rows.map(function (row) {
    return columns.map(function (col) {
      var v = row[col[0]];
      return v === null || v === undefined ? '' : String(v);
    });
  });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), columns.length)).clearContent();
  if (values.length) {
    var range = sh.getRange(2, 1, values.length, columns.length);
    range.setNumberFormat('@'); // plain text: no formulas, no auto-converted numbers/dates
    range.setValues(values);
  }
}

function ensureSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_ITEMS)) {
    var items = ss.insertSheet(SHEET_ITEMS);
    items.getRange(1, 1, 1, ITEM_COLUMNS.length).setValues([ITEM_COLUMNS.map(function (c) { return c[1]; })]).setFontWeight('bold');
    items.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_CATEGORIES)) {
    var cats = ss.insertSheet(SHEET_CATEGORIES);
    cats.getRange(1, 1, 1, 3).setValues([CATEGORY_COLUMNS.map(function (c) { return c[1]; })]).setFontWeight('bold');
    cats.getRange(2, 1, DEFAULT_CATEGORIES.length, 3).setNumberFormat('@').setValues(DEFAULT_CATEGORIES);
    cats.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_SETTINGS)) {
    var settings = ss.insertSheet(SHEET_SETTINGS);
    settings.getRange(1, 1, SETTINGS_ROWS.length, 2).setNumberFormat('@').setValues(
      SETTINGS_ROWS.map(function (def) { return [def[1], def[2]]; })
    );
  }
  if (!ss.getSheetByName(SHEET_ACCESS)) {
    var access = ss.insertSheet(SHEET_ACCESS);
    access.getRange('A1:B1').setValues([['Aðgangskóði', '']]).setNumberFormat('@');
    access.getRange('A1').setFontWeight('bold');
    access.getRange('A3').setValue('Skrifaðu aðgangskóðann í reit B1. Þeir sem kunna hann geta breytt óskalistanum.');
  }
  var blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('Blað1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
}

// ---------------------------------------------------------------------------
// Product lookup: the browser can't read other websites directly, so it asks this
// script to fetch the product page (or search results) and parses the HTML itself.
// ---------------------------------------------------------------------------

function fetchPage(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000) {
    return { error: 'Ógildur hlekkur.', status: 400 };
  }
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'is,en;q=0.8',
      },
    });
    var text = res.getContentText();
    return { status: res.getResponseCode(), text: text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text };
  } catch (err) {
    return { error: 'Gat ekki sótt síðuna.', status: 502 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sheet(name) {
  ensureSheetsOnce();
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

var sheetsChecked = false;
function ensureSheetsOnce() {
  if (!sheetsChecked) {
    sheetsChecked = true;
    ensureSheets();
  }
}

function getVersion() {
  return Number(PropertiesService.getScriptProperties().getProperty('version') || 0);
}

function isYes(value) {
  return /^(já|ja|true|x|1|yes)$/i.test(String(value || '').trim());
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
