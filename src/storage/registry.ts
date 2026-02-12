export interface RegistryEntry {
    file: string
    method: string
    description?: string
    createdAt: number
    updatedAt?: number
}

export interface SelectorRegistry {
    name: string
    selectors: Record<string, RegistryEntry>
}

export function createEmptyRegistry(name: string): SelectorRegistry {
    return {
        name,
        selectors: {},
    }
}
