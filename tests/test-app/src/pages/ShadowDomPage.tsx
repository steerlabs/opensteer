import { useEffect } from 'react'

function defineShadowFixtures(): void {
    if (!customElements.get('ov-shadow-button')) {
        customElements.define(
            'ov-shadow-button',
            class extends HTMLElement {
                connectedCallback(): void {
                    if (this.shadowRoot) return

                    const root = this.attachShadow({ mode: 'open' })
                    root.innerHTML = `
                        <button id="shadow-action-btn" type="button">Shadow Action</button>
                    `

                    const button =
                        root.querySelector<HTMLButtonElement>(
                            '#shadow-action-btn'
                        )
                    button?.addEventListener('click', () => {
                        const output = document.querySelector(
                            '#shadow-click-output'
                        )
                        if (output) {
                            output.textContent = `clicked:${this.id || 'unknown'}`
                        }
                    })
                }
            }
        )
    }

    if (!customElements.get('ov-shadow-input')) {
        customElements.define(
            'ov-shadow-input',
            class extends HTMLElement {
                connectedCallback(): void {
                    if (this.shadowRoot) return

                    const root = this.attachShadow({ mode: 'open' })
                    root.innerHTML = `
                        <label for="shadow-input">Search</label>
                        <input id="shadow-input" placeholder="Type inside shadow" />
                    `

                    const input =
                        root.querySelector<HTMLInputElement>('#shadow-input')
                    input?.addEventListener('input', () => {
                        const output = document.querySelector(
                            '#shadow-input-output'
                        )
                        if (output) {
                            output.textContent = input.value
                        }
                    })
                }
            }
        )
    }

    if (!customElements.get('ov-shadow-card')) {
        customElements.define(
            'ov-shadow-card',
            class extends HTMLElement {
                connectedCallback(): void {
                    if (this.shadowRoot) return

                    const title = this.getAttribute('data-title') || 'Untitled'
                    const status = this.getAttribute('data-status') || 'Unknown'

                    const root = this.attachShadow({ mode: 'open' })
                    root.innerHTML = `
                        <article>
                            <h3 id="shadow-card-title">${title}</h3>
                            <p id="shadow-card-status">${status}</p>
                            <button id="shadow-card-action" type="button">Open</button>
                        </article>
                    `

                    const button = root.querySelector<HTMLButtonElement>(
                        '#shadow-card-action'
                    )
                    button?.addEventListener('click', () => {
                        const output = document.querySelector(
                            '#shadow-card-output'
                        )
                        if (output) {
                            output.textContent = `${this.id}:${title}`
                        }
                    })
                }
            }
        )
    }
}

export function ShadowDomPage(): JSX.Element {
    useEffect(() => {
        defineShadowFixtures()
    }, [])

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Shadow DOM Fixtures</h1>
                <p className="page-subtitle">
                    Open shadow roots expose actionable controls and extraction
                    text for strict path resolution tests.
                </p>
            </header>

            <section className="grid gap-5 lg:grid-cols-2">
                <article className="card space-y-3">
                    <h2 className="card-title">Interactive Shadow Controls</h2>
                    <ov-shadow-button id="shadow-button-host" />
                    <p
                        id="shadow-click-output"
                        className="text-sm text-slate-600"
                    >
                        idle
                    </p>

                    <ov-shadow-input id="shadow-input-host" />
                    <p
                        id="shadow-input-output"
                        className="text-sm text-slate-600"
                    >
                        empty
                    </p>
                </article>

                <article className="card space-y-3">
                    <h2 className="card-title">Duplicated Shadow Cards</h2>
                    <ov-shadow-card
                        id="card-1"
                        data-title="Ops Dashboard"
                        data-status="Healthy"
                    />
                    <ov-shadow-card
                        id="card-2"
                        data-title="Billing Console"
                        data-status="Warning"
                    />
                    <p
                        id="shadow-card-output"
                        className="text-sm text-slate-600"
                    >
                        none
                    </p>
                </article>
            </section>
        </main>
    )
}
