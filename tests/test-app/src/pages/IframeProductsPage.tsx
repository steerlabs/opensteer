interface ProductFixture {
    id: string
    name: string
    url: string
}

const iframeProducts: ProductFixture[] = [
    {
        id: 'frame-dock-mini',
        name: 'Frame Dock Mini',
        url: 'https://fixtures.opensteer.dev/products/frame-dock-mini',
    },
    {
        id: 'frame-cable-kit',
        name: 'Frame Cable Kit',
        url: 'https://fixtures.opensteer.dev/products/frame-cable-kit',
    },
    {
        id: 'frame-plate-polycarbonate',
        name: 'Frame Plate Polycarbonate',
        url: 'https://fixtures.opensteer.dev/products/frame-plate-polycarbonate',
    },
]

export function IframeProductsPage(): JSX.Element {
    return (
        <main className="min-h-screen bg-slate-50 p-3 font-sans text-slate-800">
            <h1
                id="iframe-products-title"
                className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
                Iframe Product Shelf
            </h1>

            <section
                id="iframe-product-rail"
                className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3"
                aria-label="Iframe Product Shelf"
            >
                {iframeProducts.map((product) => (
                    <article
                        key={product.id}
                        id={`iframe-product-card-${product.id}`}
                        className="rounded-lg border border-slate-200 p-3"
                    >
                        <a
                            id={`iframe-product-link-${product.id}`}
                            href={product.url}
                            className="product-block__title-link text-sm font-semibold text-slate-900"
                        >
                            {product.name}
                        </a>
                    </article>
                ))}
            </section>
        </main>
    )
}
