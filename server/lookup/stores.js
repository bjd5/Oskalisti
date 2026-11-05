// Store naming helpers: turn a product URL's hostname into a nice store name.

/** Known Icelandic (and a few international) stores → display name. Keys are registrable domains. */
export const KNOWN_STORES = Object.freeze({
  'elko.is': 'ELKO',
  'kokka.is': 'Kokka',
  'epal.is': 'Epal',
  'heimkaup.is': 'Heimkaup',
  'byko.is': 'BYKO',
  'husa.is': 'Húsasmiðjan',
  'ikea.is': 'IKEA',
  'hagkaup.is': 'Hagkaup',
  'rumfatalagerinn.is': 'Rúmfatalagerinn',
  'dorma.is': 'Dorma',
  'betrabak.is': 'Betra Bak',
  'hrim.is': 'Hrím',
  'kunigund.is': 'Kúnígúnd',
  'tekk.is': 'Tekk Company',
  'linan.is': 'Línan',
  'ormsson.is': 'Ormsson',
  'ht.is': 'HT',
  'pfaff.is': 'Pfaff',
  'eirvik.is': 'Eirvík',
  'heimilistaeki.is': 'Heimilistæki',
  'snuran.is': 'Snúran',
  'modern.is': 'Módern',
  'ilva.is': 'ILVA',
});

/** Lower-cased hostname without a leading "www.", or "" for unparsable input. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function isIcelandicHost(hostOrUrl) {
  const host = hostOrUrl.includes('/') ? hostOf(hostOrUrl) : hostOrUrl.toLowerCase();
  return host === 'is' || host.endsWith('.is');
}

function knownStoreName(host) {
  if (/(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return 'Amazon';
  for (const [domain, name] of Object.entries(KNOWN_STORES)) {
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  }
  return '';
}

/**
 * Store display name for a product URL: known store map first, then the page's
 * og:site_name (if given), else the hostname without "www." and capitalised.
 */
export function storeNameFromUrl(url, siteName = '') {
  const host = hostOf(url);
  const known = knownStoreName(host);
  if (known) return known;
  const site = typeof siteName === 'string' ? siteName.replace(/\s+/g, ' ').trim() : '';
  if (site && site.length <= 60) return site;
  if (!host) return '';
  return host.charAt(0).toUpperCase() + host.slice(1);
}
