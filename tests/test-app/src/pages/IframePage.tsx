export function IframePage(): JSX.Element {
    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Iframe Context Fixtures</h1>
                <p className="page-subtitle">
                    Two iframes load the same interactive route with independent
                    state.
                </p>
            </header>

            <section className="grid gap-5 lg:grid-cols-2">
                <article className="card space-y-3">
                    <h2 className="card-title">Named iframe</h2>
                    <iframe
                        id="named-iframe"
                        name="supportFrame"
                        title="Named Support Frame"
                        src="/iframe/content?kind=named"
                        className="h-[320px] w-full rounded-xl border border-slate-300"
                    />
                </article>

                <article className="card space-y-3">
                    <h2 className="card-title">Anonymous iframe</h2>
                    <iframe
                        id="anonymous-iframe"
                        title="Anonymous Frame"
                        src="/iframe/content?kind=anonymous"
                        className="h-[320px] w-full rounded-xl border border-slate-300"
                    />
                </article>
            </section>
        </main>
    )
}
