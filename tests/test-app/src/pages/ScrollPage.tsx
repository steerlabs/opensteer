const verticalItems = Array.from(
    { length: 24 },
    (_, index) => `Vertical item ${index + 1}`
)
const horizontalItems = Array.from(
    { length: 18 },
    (_, index) => `H-${index + 1}`
)

export function ScrollPage(): JSX.Element {
    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Scroll Container Lab</h1>
                <p className="page-subtitle">
                    Nested and orthogonal scroll regions for scrollability
                    detection and scroll actions.
                </p>
            </header>

            <section
                id="outer-scroll"
                className="scroll-surface h-[430px] overflow-auto p-4"
            >
                <div className="space-y-5">
                    <article className="card">
                        <h2 className="card-title">Overview</h2>
                        <p className="text-sm text-slate-600">
                            The outer container scrolls vertically while hosting
                            nested scroll surfaces.
                        </p>
                    </article>

                    <article
                        id="inner-vertical"
                        className="scroll-surface h-44 overflow-y-auto p-3"
                    >
                        <h3 className="mb-2 text-sm font-semibold">
                            Inner vertical list
                        </h3>
                        <ul className="space-y-2 text-sm">
                            {verticalItems.map((item) => (
                                <li
                                    key={item}
                                    className="rounded-lg border border-slate-200 px-2 py-1"
                                >
                                    {item}
                                </li>
                            ))}
                        </ul>
                    </article>

                    <article
                        id="inner-horizontal"
                        className="scroll-surface overflow-x-auto p-3"
                    >
                        <h3 className="mb-2 text-sm font-semibold">
                            Inner horizontal lane
                        </h3>
                        <div className="flex w-[1300px] gap-2">
                            {horizontalItems.map((item) => (
                                <div
                                    key={item}
                                    className="flex h-20 w-28 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm"
                                >
                                    {item}
                                </div>
                            ))}
                        </div>
                    </article>

                    <article
                        id="nested-outer"
                        className="scroll-surface h-52 overflow-auto p-3"
                    >
                        <h3 className="mb-2 text-sm font-semibold">
                            Nested scroll-in-scroll
                        </h3>
                        <div
                            id="nested-inner"
                            className="h-80 overflow-y-auto rounded-lg border border-slate-200 p-2"
                        >
                            {Array.from({ length: 16 }, (_, index) => (
                                <p
                                    key={index}
                                    className="mb-2 rounded bg-slate-100 px-2 py-1 text-sm"
                                >
                                    Nested paragraph #{index + 1}: Lorem ipsum
                                    dolor sit amet, consectetur adipiscing elit.
                                </p>
                            ))}
                        </div>
                    </article>

                    <article className="card">
                        <h3 className="text-sm font-semibold">Footer marker</h3>
                        <p
                            id="outer-scroll-end"
                            className="text-sm text-slate-600"
                        >
                            You reached the lower region of the outer container.
                        </p>
                    </article>
                </div>
            </section>
        </main>
    )
}
