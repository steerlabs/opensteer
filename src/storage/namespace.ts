import path from 'path'

const DEFAULT_NAMESPACE = 'default'

export function normalizeNamespace(input?: string): string {
    const raw = String(input || '')
        .trim()
        .replace(/\\/g, '/')

    if (!raw) return DEFAULT_NAMESPACE

    const segments = raw
        .split('/')
        .map((segment) => sanitizeNamespaceSegment(segment))
        .filter((segment) => Boolean(segment))

    if (!segments.length) return DEFAULT_NAMESPACE
    return segments.join('/')
}

export function resolveNamespaceDir(rootDir: string, namespace: string): string {
    const selectorsRoot = path.resolve(rootDir, '.opensteer', 'selectors')
    const normalizedNamespace = normalizeNamespace(namespace)
    const namespaceDir = path.resolve(selectorsRoot, normalizedNamespace)
    const relative = path.relative(selectorsRoot, namespaceDir)

    if (relative === '' || relative === '.') return namespaceDir
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
            `Namespace "${namespace}" resolves outside selectors root.`
        )
    }

    return namespaceDir
}

function sanitizeNamespaceSegment(segment: string): string {
    const trimmed = String(segment || '').trim()
    if (!trimmed || trimmed === '.' || trimmed === '..') return ''

    const replaced = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const collapsed = replaced.replace(/_+/g, '_')
    const bounded = collapsed.replace(/^_+|_+$/g, '')

    return bounded || ''
}
