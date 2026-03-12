export const API_REF_PREFIXES = {
    run: '@run',
    span: '@span',
    request: '@request',
    download: '@download',
    value: '@value',
    plan: '@plan',
    validation: '@validation',
} as const

export type ApiRefKind = keyof typeof API_REF_PREFIXES

export function buildApiRef(kind: ApiRefKind, index: number): string {
    return `${API_REF_PREFIXES[kind]}${index}`
}

export function isApiRefKind(value: string, kind: ApiRefKind): boolean {
    return value.startsWith(API_REF_PREFIXES[kind])
}
