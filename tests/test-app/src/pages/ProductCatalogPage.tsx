interface ProductFixture {
    id: string
    name: string
    url: string
    price: string
}

const standardProducts: ProductFixture[] = [
    {
        id: 'switches-70',
        name: 'Switches x 70',
        url: 'https://fixtures.opensteer.dev/products/switches-70',
        price: '$39.00',
    },
    {
        id: 'pbt-keycaps',
        name: 'PBT Keycaps Set',
        url: 'https://fixtures.opensteer.dev/products/pbt-keycaps-set',
        price: '$79.00',
    },
    {
        id: 'walnut-wrist-rest',
        name: 'Walnut Wrist Rest',
        url: 'https://fixtures.opensteer.dev/products/walnut-wrist-rest',
        price: '$45.00',
    },
    {
        id: 'aviator-cable',
        name: 'Aviator Cable',
        url: 'https://fixtures.opensteer.dev/products/aviator-cable',
        price: '$24.00',
    },
]

export function ProductCatalogPage(): JSX.Element {
    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Product Catalog Fixtures</h1>
                <p className="page-subtitle">
                    Every product card uses a single anchor for both product
                    name text and URL, mirroring real storefront extraction
                    patterns.
                </p>
            </header>

            <section
                id="standard-product-rail"
                className="card space-y-4"
                aria-label="Standard Product Rail"
            >
                <h2 className="card-title">Standard Product Rail</h2>
                <ul className="grid gap-3 md:grid-cols-2">
                    {standardProducts.map((product) => (
                        <li
                            key={product.id}
                            id={`product-card-${product.id}`}
                            className="rounded-xl border border-slate-200 bg-white p-4"
                        >
                            <a
                                id={`product-link-${product.id}`}
                                href={product.url}
                                className="product-block__title-link text-base font-semibold text-slate-900"
                            >
                                {product.name}
                            </a>
                            <p
                                id={`product-price-${product.id}`}
                                className="mt-1 text-sm text-slate-600"
                            >
                                {product.price}
                            </p>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    )
}
