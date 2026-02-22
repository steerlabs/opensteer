export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(
            ([left], [right]) => left.localeCompare(right)
        )
        const serializedEntries = entries
            .map(
                ([key, current]) =>
                    `${JSON.stringify(key)}:${stableStringify(current)}`
            )
            .join(',')
        return `{${serializedEntries}}`
    }

    return JSON.stringify(value)
}
