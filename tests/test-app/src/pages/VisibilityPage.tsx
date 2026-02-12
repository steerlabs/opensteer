export function VisibilityPage(): JSX.Element {
    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">
                    Visibility and Interactivity Edge Cases
                </h1>
                <p className="page-subtitle">
                    Includes patterns that frequently break heuristic DOM
                    visibility checks.
                </p>
            </header>

            <section className="grid gap-4 md:grid-cols-2">
                <article className="card space-y-2">
                    <h2 className="card-title">Hidden Variants</h2>
                    <button id="visible-btn" className="btn btn-primary">
                        Clearly visible button
                    </button>
                    <button
                        id="opacity-zero-btn"
                        className="btn btn-secondary"
                        style={{ opacity: 0 }}
                    >
                        Opacity zero
                    </button>
                    <button
                        id="display-none-btn"
                        className="btn btn-secondary"
                        style={{ display: 'none' }}
                    >
                        Display none
                    </button>
                    <button
                        id="visibility-hidden-btn"
                        className="btn btn-secondary"
                        style={{ visibility: 'hidden' }}
                    >
                        Visibility hidden
                    </button>
                    <div style={{ visibility: 'hidden' }}>
                        <button
                            id="visible-child-btn"
                            className="btn btn-secondary"
                            style={{ visibility: 'visible' }}
                        >
                            Visible child of hidden parent
                        </button>
                    </div>
                    <button
                        id="scaled-zero-btn"
                        className="btn btn-secondary"
                        style={{
                            transform: 'scale(0)',
                            transformOrigin: 'left center',
                        }}
                    >
                        Scale zero
                    </button>
                </article>

                <article className="card space-y-3">
                    <h2 className="card-title">Off-canvas and clipping</h2>
                    <button
                        id="offscreen-btn"
                        className="btn btn-secondary"
                        style={{
                            position: 'absolute',
                            left: '-9999px',
                            top: '60px',
                        }}
                    >
                        Offscreen button
                    </button>
                    <button
                        id="clipped-btn"
                        className="btn btn-secondary"
                        style={{
                            clipPath: 'inset(100%)',
                            position: 'relative',
                        }}
                    >
                        Clipped button
                    </button>
                    <div
                        id="collapse-container"
                        style={{ height: 0, overflow: 'hidden' }}
                    >
                        <button
                            id="collapsed-btn"
                            className="btn btn-secondary"
                        >
                            Collapsed child button
                        </button>
                    </div>
                    <div style={{ display: 'contents' }}>
                        <button
                            id="display-contents-btn"
                            className="btn btn-secondary"
                        >
                            Display contents child
                        </button>
                    </div>
                </article>
            </section>

            <section className="grid gap-4 md:grid-cols-2">
                <article className="card space-y-2">
                    <h2 className="card-title">ARIA and pointer behavior</h2>
                    <button
                        id="aria-hidden-btn"
                        aria-hidden="true"
                        className="btn btn-secondary"
                    >
                        ARIA hidden button
                    </button>
                    <button
                        id="pointer-events-none-btn"
                        className="btn btn-secondary"
                        style={{ pointerEvents: 'none' }}
                    >
                        Pointer events none
                    </button>
                    <button
                        id="disabled-edge-btn"
                        className="btn btn-secondary"
                        disabled
                    >
                        Disabled but visible
                    </button>
                </article>

                <article className="card space-y-2">
                    <h2 className="card-title">Stacking context overlap</h2>
                    <div className="relative h-44 rounded-xl border border-slate-200">
                        <button
                            id="behind-overlay-btn"
                            className="btn btn-secondary absolute left-3 top-3"
                        >
                            Behind overlay
                        </button>
                        <div
                            id="blocking-overlay"
                            className="pointer-events-auto absolute inset-0 rounded-xl bg-slate-900/35"
                        />
                    </div>
                    <p className="text-xs text-slate-500">
                        Button remains in DOM but is visually blocked by an
                        overlay layer.
                    </p>
                </article>
            </section>
        </main>
    )
}
