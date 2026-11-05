// Small synthetic pages with the same structure as the real Icelandic shops (checked against the
// live sites in Nov 2026), for the price comparison tests. Real pages are not committed.

const nextData = (data) =>
  `<!doctype html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;

/** Líf og List (WebPenguin/Next.js) search page: /leit?q=… */
export function lifoglistSearch(products) {
  return nextData({
    props: {
      pageProps: {
        categories: [{ id: 'c1', name: 'Eldhús', slug: 'eldhus' }],
        products: products.map((p) => ({
          id: p.slug,
          name: p.name,
          slug: p.slug,
          price: p.price,
          sku: p.sku,
          foreignSku: p.foreignSku,
          brand: { id: 'b', name: p.brand, slug: p.brand.toLowerCase() },
          images: [{ id: 'i', url: `https://images.webpenguin.online/${p.slug}` }],
        })),
        total: products.length,
      },
    },
    page: '/leit',
  });
}

/** Líf og List product page: no JSON-LD/price meta, the product is in the page data. */
export function lifoglistProduct(p) {
  return `<!doctype html><html><head><title>${p.name} | Líf og List</title>
<meta property="og:title" content="${p.name}"><meta property="og:image" content="https://images.webpenguin.online/${p.slug}"></head>
<body><h1>${p.name}</h1>${nextData({ props: { pageProps: { product: { ...p, brand: { name: p.brand } } } } }).replace(/^<!doctype html><html><body>|<\/body><\/html>$/g, '')}</body></html>`;
}

/** Kúnígúnd / Byggt og búið (Roanuz/Magento + Next.js) brand page: /brand/<slug> */
export function roanuzBrand(products) {
  const items = products.map((p, i) => ({
    __typename: 'SimpleProduct',
    id: 1000 + i,
    name: p.name,
    sku: p.sku,
    url_key: p.urlKey,
    url_suffix: '.html',
    rz_gallery_meta: `1;0;17000000${i}`,
    image: { url: 'https://backend-v2-ht.roanuz.com/media/catalog/product/placeholder/default/placeholder_1_1.png' },
    price_range: { minimum_price: { final_price: { value: p.price, currency: 'ISK' } } },
  }));
  return nextData({ props: { pageProps: { products: { total_count: items.length, items } } }, page: '/brand/[brand]' });
}

/** Kúnígúnd product page: JSON-LD with the SKU (brand is a numeric id there). */
export function roanuzProduct(p) {
  return `<!doctype html><html><head><title>${p.name}</title>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: p.name,
    sku: p.sku,
    image: [`https://d21glh60bk8ucb.cloudfront.net/product_images_v1/${p.sku}/1/web/large2x_0.jpeg`],
    brand: { '@type': 'Brand', name: '855' },
    offers: { '@type': 'Offer', price: String(p.price), priceCurrency: 'ISK' },
  })}</script></head><body><h1>${p.name}</h1></body></html>`;
}

/** Kokka (WooCommerce/Woodmart) search page: /?s=…&post_type=product */
export function kokkaSearch(products) {
  return `<!doctype html><html><body><div class="products">${products
    .map(
      (p) => `<div class="wd-product product-grid-item"><a href="${p.url}" class="product-image-link"><img src="https://kokka.is/wp-content/uploads/${p.sku}.jpg"></a>
<h3 class="wd-entities-title"><a href="${p.url}">${p.name}</a></h3>
<span class="price">${p.oldPrice ? `<del><span class="amount">${p.oldPrice}</span></del> <ins><span class="amount">${p.price}</span></ins>` : `<span class="amount">${p.price}</span>`}</span>
<a href="?add-to-cart=1" data-product_sku="${p.sku}" class="button">Setja í körfu</a></div>`,
    )
    .join('')}</div></body></html>`;
}
