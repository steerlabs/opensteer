import { DataTable, type ProductRow } from '../components/DataTable'

const rows: ProductRow[] = [
    {
        id: 'p-1',
        name: 'Aurora Lamp',
        category: 'Lighting',
        stock: 14,
        price: 89.99,
    },
    {
        id: 'p-2',
        name: 'Atlas Desk',
        category: 'Furniture',
        stock: 6,
        price: 349.0,
    },
    {
        id: 'p-3',
        name: 'Nimbus Chair',
        category: 'Furniture',
        stock: 17,
        price: 229.5,
    },
    {
        id: 'p-4',
        name: 'Quill Notebook',
        category: 'Stationery',
        stock: 72,
        price: 12.75,
    },
    {
        id: 'p-5',
        name: 'Echo Speaker',
        category: 'Electronics',
        stock: 9,
        price: 149.99,
    },
]

const cards = [
    {
        id: 'card-a',
        title: 'North Region',
        revenue: '$284,200',
        trend: '+14.2%',
        health: 'Healthy',
    },
    {
        id: 'card-b',
        title: 'Central Region',
        revenue: '$198,430',
        trend: '+4.8%',
        health: 'Stable',
    },
    {
        id: 'card-c',
        title: 'Coastal Region',
        revenue: '$322,005',
        trend: '+19.1%',
        health: 'Accelerating',
    },
]

export function DataPage(): JSX.Element {
    return (
        <main className="page-shell space-y-8">
            <header>
                <h1 className="page-title">Data Extraction Scenarios</h1>
                <p className="page-subtitle">
                    Includes tables, cards, nested structures, and mixed text
                    formatting used by extraction pipelines.
                </p>
            </header>

            <section className="card space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="card-title">Inventory Table</h2>
                    <span id="inventory-last-updated" className="data-pill">
                        Updated 2 minutes ago
                    </span>
                </div>
                <DataTable rows={rows} />
            </section>

            <section className="grid gap-4 md:grid-cols-3">
                {cards.map((card) => (
                    <article key={card.id} id={card.id} className="card">
                        <h3 className="text-base font-semibold">
                            {card.title}
                        </h3>
                        <p className="mt-3 text-2xl font-semibold">
                            {card.revenue}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                            Growth {card.trend}
                        </p>
                        <p className="mt-3 inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-medium">
                            {card.health}
                        </p>
                    </article>
                ))}
            </section>

            <section className="card">
                <h2 className="card-title">Nested Department Metrics</h2>
                <ul id="nested-metrics" className="mt-3 space-y-3 text-sm">
                    <li>
                        <strong>Operations</strong>
                        <ul className="ml-4 mt-1 list-disc space-y-1 pl-5">
                            <li>Tickets resolved: 482</li>
                            <li>Median response: 2.3h</li>
                            <li>Escalation rate: 1.9%</li>
                        </ul>
                    </li>
                    <li>
                        <strong>Product</strong>
                        <ul className="ml-4 mt-1 list-disc space-y-1 pl-5">
                            <li>Roadmap items shipped: 12</li>
                            <li>Experiment win rate: 54%</li>
                            <li>Bug backlog reduction: 23%</li>
                        </ul>
                    </li>
                </ul>
            </section>
        </main>
    )
}
