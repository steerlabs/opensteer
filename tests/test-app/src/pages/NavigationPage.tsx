import { useState } from 'react'

const tabs = ['Overview', 'Alerts', 'Deploys'] as const

type Tab = (typeof tabs)[number]

export function NavigationPage(): JSX.Element {
    const [activeTab, setActiveTab] = useState<Tab>('Overview')
    const [accordionOpen, setAccordionOpen] = useState(false)
    const [page, setPage] = useState(2)

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Navigation Patterns</h1>
                <p className="page-subtitle">
                    Common navigation structures with active states and region
                    switching.
                </p>
            </header>

            <section className="grid gap-6 lg:grid-cols-[240px_1fr]">
                <aside className="card space-y-2">
                    <h2 className="card-title">Sidebar</h2>
                    {['Dashboard', 'Workflows', 'Incidents', 'Settings'].map(
                        (item) => (
                            <button
                                key={item}
                                id={`sidebar-${item.toLowerCase()}`}
                                className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                                    item === 'Workflows'
                                        ? 'bg-teal-700 text-white'
                                        : 'hover:bg-slate-100'
                                }`}
                            >
                                {item}
                            </button>
                        )
                    )}
                </aside>

                <div className="space-y-5">
                    <nav
                        aria-label="Breadcrumb"
                        className="card flex flex-wrap items-center gap-2 text-sm"
                    >
                        <a id="crumb-home" href="#" className="text-teal-700">
                            Home
                        </a>
                        <span>/</span>
                        <a
                            id="crumb-projects"
                            href="#"
                            className="text-teal-700"
                        >
                            Projects
                        </a>
                        <span>/</span>
                        <span
                            id="crumb-current"
                            className="font-semibold text-slate-700"
                        >
                            Workflow Runner
                        </span>
                    </nav>

                    <section className="card space-y-4">
                        <div role="tablist" className="flex gap-2">
                            {tabs.map((tab) => (
                                <button
                                    key={tab}
                                    id={`tab-${tab.toLowerCase()}`}
                                    role="tab"
                                    aria-selected={activeTab === tab}
                                    className={`rounded-xl px-4 py-2 text-sm ${
                                        activeTab === tab
                                            ? 'bg-teal-700 text-white'
                                            : 'border border-slate-300 bg-white text-slate-700'
                                    }`}
                                    onClick={() => setActiveTab(tab)}
                                >
                                    {tab}
                                </button>
                            ))}
                        </div>

                        <div
                            id="tab-panel"
                            role="tabpanel"
                            className="rounded-xl border border-slate-200 p-4 text-sm"
                        >
                            {activeTab === 'Overview'
                                ? 'Overview metrics and uptime targets.'
                                : null}
                            {activeTab === 'Alerts'
                                ? 'Alert feed and escalation ownership.'
                                : null}
                            {activeTab === 'Deploys'
                                ? 'Deployment history and rollback options.'
                                : null}
                        </div>
                    </section>

                    <section className="card space-y-3">
                        <button
                            id="accordion-trigger"
                            className="flex w-full items-center justify-between rounded-lg border border-slate-300 px-3 py-2 text-left text-sm"
                            onClick={() => setAccordionOpen((prev) => !prev)}
                            aria-expanded={accordionOpen}
                        >
                            Incident response playbook
                            <span>{accordionOpen ? '-' : '+'}</span>
                        </button>
                        {accordionOpen ? (
                            <div
                                id="accordion-panel"
                                className="rounded-lg border border-slate-200 p-3 text-sm text-slate-600"
                            >
                                Notify commander, triage impact, rollback
                                safely, and post timeline updates.
                            </div>
                        ) : null}
                    </section>

                    <section className="card flex items-center gap-2">
                        <button
                            id="pagination-prev"
                            className="btn btn-secondary"
                            onClick={() =>
                                setPage((prev) => Math.max(1, prev - 1))
                            }
                        >
                            Prev
                        </button>
                        <span
                            id="pagination-current"
                            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        >
                            Page {page}
                        </span>
                        <button
                            id="pagination-next"
                            className="btn btn-secondary"
                            onClick={() =>
                                setPage((prev) => Math.min(6, prev + 1))
                            }
                        >
                            Next
                        </button>
                    </section>
                </div>
            </section>
        </main>
    )
}
