export interface DataPathPropertyToken {
    kind: 'prop'
    key: string
}

export interface DataPathIndexToken {
    kind: 'index'
    index: number
}

export type DataPathToken = DataPathPropertyToken | DataPathIndexToken

export function parseDataPath(path: string): DataPathToken[] | null {
    const input = String(path || '').trim()
    if (!input) return []
    if (input.includes('..')) return null
    if (input.startsWith('.') || input.endsWith('.')) return null

    const tokens: DataPathToken[] = []
    let cursor = 0

    while (cursor < input.length) {
        const char = input[cursor]
        if (char === '.') {
            cursor += 1
            continue
        }

        if (char === '[') {
            const close = input.indexOf(']', cursor + 1)
            if (close === -1) return null
            const rawIndex = input.slice(cursor + 1, close).trim()
            if (!/^\d+$/.test(rawIndex)) return null
            tokens.push({
                kind: 'index',
                index: Number.parseInt(rawIndex, 10),
            })
            cursor = close + 1
            continue
        }

        let end = cursor
        while (end < input.length && input[end] !== '.' && input[end] !== '[') {
            end += 1
        }

        const key = input.slice(cursor, end).trim()
        if (!key) return null
        tokens.push({ kind: 'prop', key })
        cursor = end
    }

    return tokens
}

export function encodeDataPath(tokens: DataPathToken[]): string {
    let out = ''
    for (const token of tokens) {
        if (token.kind === 'prop') {
            out = out ? `${out}.${token.key}` : token.key
            continue
        }
        out += `[${token.index}]`
    }
    return out
}

export function joinDataPath(base: string, key: string): string {
    const normalizedBase = String(base || '').trim()
    const normalizedKey = String(key || '').trim()
    if (!normalizedBase) return normalizedKey
    if (!normalizedKey) return normalizedBase
    return `${normalizedBase}.${normalizedKey}`
}

export function inflateDataPathObject(flat: Record<string, unknown>): unknown {
    let root: unknown = {}
    let initialized = false

    for (const [path, value] of Object.entries(flat || {})) {
        const tokens = parseDataPath(path)
        if (!tokens || !tokens.length) continue

        if (!initialized) {
            root = tokens[0]?.kind === 'index' ? [] : {}
            initialized = true
        }

        if (tokens[0]?.kind === 'index' && !Array.isArray(root)) continue
        if (tokens[0]?.kind === 'prop' && Array.isArray(root)) continue

        assignDataPathValue(root, tokens, value)
    }

    return initialized ? root : {}
}

function assignDataPathValue(
    root: unknown,
    tokens: DataPathToken[],
    value: unknown
): void {
    if (!tokens.length) return
    let current: unknown = root

    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i]
        const next = tokens[i + 1]
        const isLast = i === tokens.length - 1

        if (token.kind === 'prop') {
            if (
                !current ||
                typeof current !== 'object' ||
                Array.isArray(current)
            ) {
                return
            }

            const objectRef = current as Record<string, unknown>
            if (isLast) {
                objectRef[token.key] = value
                return
            }

            if (next?.kind === 'index') {
                if (!Array.isArray(objectRef[token.key])) {
                    objectRef[token.key] = []
                }
            } else {
                const nextValue = objectRef[token.key]
                if (
                    !nextValue ||
                    typeof nextValue !== 'object' ||
                    Array.isArray(nextValue)
                ) {
                    objectRef[token.key] = {}
                }
            }

            current = objectRef[token.key]
            continue
        }

        if (!Array.isArray(current)) return
        if (isLast) {
            current[token.index] = value
            return
        }

        if (next?.kind === 'index') {
            if (!Array.isArray(current[token.index])) {
                current[token.index] = []
            }
        } else {
            const nextValue = current[token.index]
            if (
                !nextValue ||
                typeof nextValue !== 'object' ||
                Array.isArray(nextValue)
            ) {
                current[token.index] = {}
            }
        }

        current = current[token.index]
    }
}
