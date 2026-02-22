import fs from 'fs'
import path from 'path'
import { createEmptyRegistry, type SelectorRegistry } from './registry.js'
import { normalizeNamespace, resolveNamespaceDir } from './namespace.js'

export interface SelectorFile<T = unknown> {
    id: string
    method: string
    description: string
    path: T
    schemaHash?: string
    metadata: {
        createdAt: number
        updatedAt?: number
        sourceUrl?: string | null
    }
}

export class LocalSelectorStorage {
    private rootDir: string
    private namespace: string

    constructor(rootDir: string, namespace: string) {
        this.rootDir = rootDir
        this.namespace = normalizeNamespace(namespace)
    }

    getRootDir(): string {
        return this.rootDir
    }

    getNamespace(): string {
        return this.namespace
    }

    getSelectorFileName(id: string): string {
        const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_')
        return `${safe}.json`
    }

    getOpensteerDir(): string {
        return path.join(this.rootDir, '.opensteer')
    }

    getNamespaceDir(): string {
        return resolveNamespaceDir(this.rootDir, this.namespace)
    }

    getRegistryPath(): string {
        return path.join(this.getNamespaceDir(), 'index.json')
    }

    getSelectorPath(id: string): string {
        return path.join(this.getNamespaceDir(), this.getSelectorFileName(id))
    }

    ensureDirs(): void {
        fs.mkdirSync(this.getNamespaceDir(), { recursive: true })
    }

    loadRegistry(): SelectorRegistry {
        this.ensureDirs()
        const file = this.getRegistryPath()
        if (!fs.existsSync(file)) return createEmptyRegistry(this.namespace)
        try {
            const raw = fs.readFileSync(file, 'utf8')
            return JSON.parse(raw) as SelectorRegistry
        } catch {
            return createEmptyRegistry(this.namespace)
        }
    }

    saveRegistry(registry: SelectorRegistry): void {
        this.ensureDirs()
        fs.writeFileSync(
            this.getRegistryPath(),
            JSON.stringify(registry, null, 2)
        )
    }

    readSelector<T = unknown>(id: string): SelectorFile<T> | null {
        const file = this.getSelectorPath(id)
        if (!fs.existsSync(file)) return null
        try {
            const raw = fs.readFileSync(file, 'utf8')
            return JSON.parse(raw) as SelectorFile<T>
        } catch {
            return null
        }
    }

    writeSelector<T = unknown>(payload: SelectorFile<T>): void {
        this.ensureDirs()
        fs.writeFileSync(
            this.getSelectorPath(payload.id),
            JSON.stringify(payload, null, 2)
        )
    }

    clearNamespace(): void {
        const dir = this.getNamespaceDir()
        if (!fs.existsSync(dir)) return
        fs.rmSync(dir, { recursive: true, force: true })
    }
}
