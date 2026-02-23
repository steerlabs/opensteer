import { useEffect } from 'react'

function defineShadowProductFixtures(): void {
    if (customElements.get('opensteer-shadow-product-shelf')) return

    customElements.define(
        'opensteer-shadow-product-shelf',
        class extends HTMLElement {
            connectedCallback(): void {
                if (this.shadowRoot) return

                const root = this.attachShadow({ mode: 'open' })
                root.innerHTML = `
                    <section id="shadow-product-rail" aria-label="Shadow Product Shelf">
                        <article id="shadow-product-card-shadow-null60">
                            <a id="shadow-product-link-shadow-null60" href="https://fixtures.opensteer.dev/products/shadow-null60" class="product-block__title-link">
                                Shadow Null60
                            </a>
                        </article>
                        <article id="shadow-product-card-shadow-artisan-set">
                            <a id="shadow-product-link-shadow-artisan-set" href="https://fixtures.opensteer.dev/products/shadow-artisan-set" class="product-block__title-link">
                                Shadow Artisan Set
                            </a>
                        </article>
                        <article id="shadow-product-card-shadow-silicone-pad">
                            <a id="shadow-product-link-shadow-silicone-pad" href="https://fixtures.opensteer.dev/products/shadow-silicone-pad" class="product-block__title-link">
                                Shadow Silicone Pad
                            </a>
                        </article>
                    </section>
                `
            }
        }
    )
}

export function ProductContextsPage(): JSX.Element {
    useEffect(() => {
        defineShadowProductFixtures()
    }, [])

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Contextual Product Fixtures</h1>
                <p className="page-subtitle">
                    Product links rendered in iframe and shadow DOM contexts to
                    validate AI extraction parity across DOM boundaries.
                </p>
            </header>

            <section className="grid gap-5 lg:grid-cols-2">
                <article className="card space-y-3">
                    <h2 className="card-title">Iframe Product Shelf</h2>
                    <iframe
                        id="products-iframe"
                        title="Iframe Product Shelf"
                        src="/iframe/products"
                        className="h-[280px] w-full rounded-xl border border-slate-300"
                    />
                </article>

                <article className="card space-y-3">
                    <h2 className="card-title">Shadow Product Shelf</h2>
                    <opensteer-shadow-product-shelf id="shadow-product-host" />
                </article>
            </section>
        </main>
    )
}
