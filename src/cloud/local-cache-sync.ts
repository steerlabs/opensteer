import fs from 'fs'
import path from 'path'
import type { CloudSelectorCacheImportEntry } from './contracts.js'
import type { SelectorFile } from '../storage/local.js'
import type { LocalSelectorStorage } from '../storage/local.js'
import { extractErrorMessage } from '../error-normalization.js'

export function collectLocalSelectorCacheEntries(
    storage: LocalSelectorStorage,
    options: { debug?: boolean } = {}
): CloudSelectorCacheImportEntry[] {
    const debug = options.debug === true
    const namespace = storage.getNamespace()
    const namespaceDir = storage.getNamespaceDir()
    if (!fs.existsSync(namespaceDir)) return []

    const entries: CloudSelectorCacheImportEntry[] = []
    const fileNames = fs.readdirSync(namespaceDir)

    for (const fileName of fileNames) {
        if (fileName === 'index.json' || !fileName.endsWith('.json')) continue

        const filePath = path.join(namespaceDir, fileName)
        const selector = readSelectorFile(filePath, debug)
        if (!selector) continue

        const descriptionHash = normalizeDescriptionHash(selector.id)
        const method = normalizeMethod(selector.method)
        const siteOrigin = resolveOrigin(selector.metadata?.sourceUrl)
        const createdAt = normalizeTimestamp(selector.metadata?.createdAt)
        const updatedAt = normalizeTimestamp(
            selector.metadata?.updatedAt ?? selector.metadata?.createdAt
        )

        if (
            !descriptionHash ||
            !method ||
            !siteOrigin ||
            selector.path === undefined ||
            createdAt == null ||
            updatedAt == null
        ) {
            continue
        }

        entries.push({
            namespace,
            siteOrigin,
            method,
            descriptionHash,
            path: selector.path,
            schemaHash: normalizeSchemaHash(selector.schemaHash),
            createdAt: Math.min(createdAt, updatedAt),
            updatedAt: Math.max(createdAt, updatedAt),
        })
    }

    return dedupeNewest(entries)
}

function readSelectorFile(
    filePath: string,
    debug: boolean
): SelectorFile<unknown> | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf8')
        return JSON.parse(raw) as SelectorFile<unknown>
    } catch (error) {
        const message = extractErrorMessage(
            error,
            'Unable to parse selector cache file JSON.'
        )
        if (debug) {
            console.warn(
                `[opensteer] failed to read local selector cache file "${filePath}": ${message}`
            )
        }
        return null
    }
}

function normalizeDescriptionHash(value: string | undefined): string | null {
    if (!value) return null
    const normalized = value.trim().toLowerCase()
    return /^[a-f0-9]{16}$/.test(normalized) ? normalized : null
}

function normalizeMethod(value: string | undefined): string | null {
    if (!value) return null

    const normalized = value.trim().toLowerCase()
    if (normalized === 'dblclick' || normalized === 'rightclick') {
        return 'click'
    }
    if (normalized === 'extractfromplan') {
        return 'extract'
    }

    switch (normalized) {
        case 'click':
            return 'click'
        case 'hover':
            return 'hover'
        case 'input':
            return 'input'
        case 'select':
            return 'select'
        case 'scroll':
            return 'scroll'
        case 'getelementtext':
            return 'getElementText'
        case 'getelementvalue':
            return 'getElementValue'
        case 'getelementattributes':
            return 'getElementAttributes'
        case 'getelementboundingbox':
            return 'getElementBoundingBox'
        case 'extract':
            return 'extract'
        default:
            return null
    }
}

function resolveOrigin(sourceUrl: string | null | undefined): string | null {
    if (!sourceUrl || sourceUrl.trim().length === 0) return null

    try {
        const parsed = new URL(sourceUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null
        }
        return parsed.origin
    } catch {
        return null
    }
}

function normalizeTimestamp(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null
    }
    return Math.floor(value)
}

function normalizeSchemaHash(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : undefined
}

function dedupeNewest(
    entries: CloudSelectorCacheImportEntry[]
): CloudSelectorCacheImportEntry[] {
    const byKey = new Map<string, CloudSelectorCacheImportEntry>()
    for (const entry of entries) {
        const key = [
            entry.namespace,
            entry.siteOrigin,
            entry.method,
            entry.descriptionHash,
        ].join(':')
        const existing = byKey.get(key)
        if (!existing || entry.updatedAt > existing.updatedAt) {
            byKey.set(key, entry)
        }
    }
    return [...byKey.values()]
}
