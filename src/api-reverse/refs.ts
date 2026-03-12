export const API_REF_PREFIXES = {
    run: '@run',
    span: '@span',
    action: '@action',
    request: '@request',
    download: '@download',
    value: '@value',
    slot: '@slot',
    evidence: '@evidence',
    plan: '@plan',
    probe: '@probe',
    validation: '@validation',
} as const

export type ApiRefKind = keyof typeof API_REF_PREFIXES

export function buildApiRef(kind: ApiRefKind, index: number): string {
    return `${API_REF_PREFIXES[kind]}${index}`
}

export function isApiRefKind(value: string, kind: ApiRefKind): boolean {
    return value.startsWith(API_REF_PREFIXES[kind])
}
