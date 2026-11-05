// Automatic category suggestion from a gift's name (and description).
// Pure ESM, no dependencies: used by the browser (item dialog, "Flokka gjafir sjálfkrafa") and tests.
//
// Each category has keyword stems (lower-case, Icelandic letters folded: þ→th, ð→d, æ→ae, ö→o,
// accents removed). A word in the gift's name matches a stem when it starts with it, or – for
// stems of MIN_INNER+ letters – contains it (Icelandic compounds such as "rafmagnshraerivel").
// Custom categories (e.g. "Útivist") also match their own name.

/** Keyword stems per category id (ids of the default categories plus common custom ones). */
export const CATEGORY_KEYWORDS = {
  bakstur: [
    'maeliskeid', 'maelibol', 'maelikann', 'maeliglas', 'bokun', 'kokuform', 'kokukefli', 'kefli',
    'muffins', 'cupcake', 'braudform', 'formkok', 'tertu', 'kokugrind', 'kokuspad', 'kokudisk',
    'skal', 'hraerivel', 'hraeriv', 'theytar', 'sleikj', 'sigti', 'smjorpapp', 'bokunarpapp',
    'eldhusvog', 'vog', 'deigskaf', 'deig', 'piparkok', 'kokusk', 'skreyt', 'sprautupok', 'kanilsn',
  ],
  eldhusid: [
    'pott', 'pann', 'wok', 'hnif', 'nakiri', 'santoku', 'bretti', 'skurdarbret', 'ausa', 'spadi',
    'tong', 'rifjarn', 'hvitlauk', 'kvorn', 'kaffivel', 'kaffikann', 'pressukann', 'ketil', 'katl',
    'hradsud', 'blandar', 'matvinnslu', 'safapress', 'airfryer', 'braudrist', 'eldfast', 'steypujarn',
    'svunt', 'viskastykk', 'pottalepp', 'ofnhansk', 'brynir', 'bryni', 'hnifablokk', 'hnifasegul',
    'mortel', 'sitronupress', 'dosaopnar', 'grill', 'espresso', 'tekann', 'teketil',
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

// Stems this long may also match inside a compound word ("rafmagnshrærivél" ⊃ "hraerivel");
// shorter ones only at the start ("salatskál" does not match "skal", it matches "salatskal").
const MIN_INNER = 6;

const stemHits = (word, stem) => word.startsWith(stem) || (stem.length >= MIN_INNER && word.includes(stem));

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
