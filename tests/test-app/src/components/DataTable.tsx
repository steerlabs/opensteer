import { useMemo, useState } from 'react'

export interface ProductRow {
    id: string
    name: string
    category: string
    stock: number
    price: number
}

interface DataTableProps {
    rows: ProductRow[]
}

type SortKey = 'name' | 'category' | 'stock' | 'price'

export function DataTable({ rows }: DataTableProps): JSX.Element {
    const [sortKey, setSortKey] = useState<SortKey>('name')
    const [direction, setDirection] = useState<'asc' | 'desc'>('asc')

    const sortedRows = useMemo(() => {
        const sorted = [...rows].sort((a, b) => {
            const aValue = a[sortKey]
            const bValue = b[sortKey]

            if (typeof aValue === 'number' && typeof bValue === 'number') {
                return aValue - bValue
            }

            return String(aValue).localeCompare(String(bValue))
        })

        return direction === 'asc' ? sorted : sorted.reverse()
    }, [rows, sortKey, direction])

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) {
            setDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
            return
        }

        setSortKey(key)
        setDirection('asc')
    }

    return (
        <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table
                id="product-table"
                className="w-full border-collapse text-sm"
            >
                <thead className="bg-slate-50 text-xs uppercase tracking-[0.08em] text-slate-500">
                    <tr>
                        <th className="px-3 py-2 text-left">
                            <button
                                id="sort-name"
                                className="cursor-pointer"
                                onClick={() => toggleSort('name')}
                            >
                                Product
                            </button>
                        </th>
                        <th className="px-3 py-2 text-left">
                            <button
                                id="sort-category"
                                className="cursor-pointer"
                                onClick={() => toggleSort('category')}
                            >
                                Category
                            </button>
                        </th>
                        <th className="px-3 py-2 text-left">
                            <button
                                id="sort-stock"
                                className="cursor-pointer"
                                onClick={() => toggleSort('stock')}
                            >
                                Stock
                            </button>
                        </th>
                        <th className="px-3 py-2 text-left">
                            <button
                                id="sort-price"
                                className="cursor-pointer"
                                onClick={() => toggleSort('price')}
                            >
                                Price
                            </button>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {sortedRows.map((row) => (
                        <tr key={row.id} className="border-t border-slate-100">
                            <td
                                className="px-3 py-2"
                                data-testid={`name-${row.id}`}
                            >
                                {row.name}
                            </td>
                            <td className="px-3 py-2">{row.category}</td>
                            <td className="px-3 py-2">{row.stock}</td>
                            <td className="px-3 py-2">
                                ${row.price.toFixed(2)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
