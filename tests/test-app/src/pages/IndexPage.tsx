import { Link } from 'react-router-dom'

const scenarios = [
    {
        href: '/forms',
        title: 'Forms',
        blurb: 'Validation states, mixed input types, disabled controls, and form state updates.',
    },
    {
        href: '/data',
        title: 'Data Extraction',
        blurb: 'Sortable table, card grids, nested lists, and dense content blocks for extraction.',
    },
    {
        href: '/overlays',
        title: 'Overlays',
        blurb: 'Portal modal, cookie banner, tooltip, drawer, dropdown, and auto-dismiss toast.',
    },
    {
        href: '/dynamic',
        title: 'Dynamic Content',
        blurb: 'Skeleton states, suspense-style loading, delayed content, and transitions.',
    },
    {
        href: '/visibility',
        title: 'Visibility Edge Cases',
        blurb: 'Opacity, aria-hidden, display contents, off-screen and pointer-events variants.',
    },
    {
        href: '/widgets',
        title: 'Custom Widgets',
        blurb: 'Combobox, custom checkbox, role buttons, contenteditable, and div-driven controls.',
    },
    {
        href: '/iframe',
        title: 'Iframe Context',
        blurb: 'Named and anonymous iframes, each with nested controls and live state updates.',
    },
    {
        href: '/scroll',
        title: 'Scroll Containers',
        blurb: 'Nested vertical/horizontal scroll regions and independent scroll positions.',
    },
    {
        href: '/navigation',
        title: 'Navigation Patterns',
        blurb: 'Tabs, accordion, breadcrumbs, pagination, and active sidebar navigation.',
    },
]

export function IndexPage(): JSX.Element {
    return (
        <main className="page-shell">
            <h1 id="index-title" className="page-title">
                Oversteer OSS Test Fixtures
            </h1>
            <p className="page-subtitle">
                This app emulates rich production interfaces with many
                interaction patterns. Each route isolates a scenario family for
                integration tests.
            </p>

            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {scenarios.map((scenario) => (
                    <article
                        key={scenario.href}
                        className="card flex h-full flex-col gap-3"
                    >
                        <h2 className="card-title">{scenario.title}</h2>
                        <p className="flex-1 text-sm text-slate-600">
                            {scenario.blurb}
                        </p>
                        <Link
                            id={`link-${scenario.title.toLowerCase().replace(/\s+/g, '-')}`}
                            className="btn btn-primary w-fit"
                            to={scenario.href}
                        >
                            Open scenario
                        </Link>
                    </article>
                ))}
            </section>
        </main>
    )
}
