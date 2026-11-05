// Automatic category suggestion from a gift's name (and description).
// Pure ESM, no dependencies: used by the browser (item dialog, "Flokka gjafir sjálfkrafa") and tests.
//
// Each category has keyword stems (lower-case, Icelandic letters folded: þ→th, ð→d, æ→ae, ö→o,
// accents removed). A word in the gift's name matches a stem as described at stemHits().
// Custom categories (e.g. "Útivist") also match their own name.

/** Keyword stems per category id (ids of the default categories plus common custom ones). */
export const CATEGORY_KEYWORDS = {
  bakstur: [
    'maeliskeid', 'maelibol', 'maelikann', 'maeliglas', 'bokun', 'kokuform', 'kokukefli', 'kefli',
    'muffins', 'cupcake', 'braudform', 'formkok', 'tertu', 'kokugrind', 'kokuspad', 'kokudisk',
    'skal', 'hraerivel', 'hraeriv', 'theytar', 'sleikj', 'sigti', 'smjorpapp', 'bokunarpapp',
    'eldhusvog', 'vog', 'deigskaf', 'deig', 'piparkok', 'kokusk', 'skreyt', 'sprautupok', 'kanilsn',
    'pisk', 'bollamal', 'maelibikar', 'hveiti', 'bokunarform', 'formkaka', 'springform',
  ],
  eldhusid: [
    'pott', 'pann', 'wok', 'hnif', 'nakiri', 'santoku', 'bretti', 'skurdarbret', 'ausa', 'spadi',
    'tong', 'rifjarn', 'hvitlauk', 'kvorn', 'kaffivel', 'kaffikann', 'pressukann', 'ketil', 'katl',
    'hradsud', 'blandar', 'matvinnslu', 'safapress', 'airfryer', 'braudrist', 'eldfast', 'steypujarn',
    'svunt', 'viskastykk', 'pottalepp', 'ofnhansk', 'brynir', 'bryni', 'hnifablokk', 'hnifasegul',
    'mortel', 'sitronupress', 'dosaopnar', 'grill', 'espresso', 'tekann', 'teketil',
    'skaeri', 'kokkahnif', 'flysjar', 'skraelar', 'rifjarn', 'ostaskeri', 'eggjaskeri',
  ],
  bordstofan: [
    'disk', 'matardisk', 'glas', 'glos', 'vinglas', 'vinglos', 'bjorglas', 'bjorglos', 'kampavin', 'bolli', 'bollar', 'krus',
    'hnifapor', 'gaffal', 'gafflar', 'skeid', 'teskeid', 'matskeid', 'dukur', 'duk', 'servett',
    'kertastjak', 'karafl', 'kanna', 'konnu', 'salatskal', 'framreidsl', 'matarstell', 'stell',
    'diskamott', 'glasamott', 'salt', 'pipar', 'smjorhnif', 'ostabakk', 'ostahnif', 'bakki',
  ],
  hjonarumid: [
    'saeng', 'kodd', 'rumfot', 'rumfat', 'lak', 'sangurver', 'rumteppi', 'yfirdyn', 'dyna',
    'nattslopp', 'sloppur', 'rumgafl', 'koddaver', 'hlifdarlak', 'naeturl',
  ],
  heimilid: [
    'vasi', 'vasa', 'kerti', 'ilmkert', 'pudi', 'puda', 'lamp', 'ljos', 'spegil', 'blomapott',
    'teppi', 'motta', 'mottu', 'karfa', 'korfu', 'krukk', 'handkl', 'saepu', 'plakat', 'mynd',
    'klukk', 'hilla', 'snag', 'ilm', 'diffuser', 'plant',
  ],
};

/** Words in a name: lower-case, Icelandic letters folded, accents removed. */
export function foldWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/þ/g, 'th')
    .replace(/ð/g, 'd')
    .replace(/æ/g, 'ae')
    .replace(/ö/g, 'o')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

// Stems this long may also match anywhere inside a compound word ("rafmagnshrærivél" ⊃ "hraerivel").
const MIN_INNER = 6;

/**
 * A word matches a stem when it starts with it, contains a long stem, or – Icelandic compounds put
 * the main word last – ends with it plus an inflection ending of up to 3 letters
 * ("kokkahnífur" → "hnif", "eggjapískur" → "pisk"). When several stems match, the longest wins in
 * suggestCategory, so "salatskál" (Borðstofan: "salatskal") beats "skál" (Bakstur: "skal").
 */
function stemHits(word, stem) {
  if (word.startsWith(stem)) return true;
  if (stem.length >= MIN_INNER && word.includes(stem)) return true;
  const at = word.lastIndexOf(stem);
  return stem.length >= 3 && at > 0 && word.length - (at + stem.length) <= 3;
}

/**
 * Best category id for a gift, or '' when nothing matches.
 * `categories`: [{ id, name }]. The longest matching stem wins (most specific: "salatskál" →
 * Borðstofan beats "skál" → Bakstur); ties go to the category with more matching words.
 */
export function suggestCategory(text, categories) {
  const words = foldWords(text);
  if (!words.length || !Array.isArray(categories)) return '';
  let best = { id: '', longest: 0, hits: 0 };
  for (const cat of categories) {
    if (!cat || cat.id === 'annad') continue;
    const stems = [
      ...(CATEGORY_KEYWORDS[cat.id] || []).map((s) => s.trim()),
      // The category's own name, e.g. a custom "Útivist" category matches "útivistarstóll".
      ...foldWords(cat.name).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, w.length - 2))),
    ];
    let longest = 0;
    let hits = 0;
    for (const word of words) {
      const matched = stems.filter((s) => s && stemHits(word, s));
      if (matched.length) {
        hits++;
        longest = Math.max(longest, ...matched.map((s) => s.length));
      }
    }
    if (hits && (longest > best.longest || (longest === best.longest && hits > best.hits))) {
      best = { id: cat.id, longest, hits };
    }
  }
  return best.id;
}
