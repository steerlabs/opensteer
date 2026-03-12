import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    createPlanMeta,
    normalizeDeterministicPlan,
    summarizePlan,
} from './compiler.js'
import type {
    ApiPlanFixture,
    ApiPlanIr,
    ApiPlanMeta,
    ApiPlanStatus,
    ApiPlanSummary,
} from './types.js'

export interface PlanRegistryOptions {
    rootDir: string
}

export interface StoredPlanRecord {
    dir: string
    planPath: string
    metaPath: string
    fixturesDir: string
    plan: ApiPlanIr
    meta: ApiPlanMeta
}

export class PlanRegistry {
    private readonly plansDir: string

    constructor(options: PlanRegistryOptions) {
        this.plansDir = path.join(options.rootDir, '.opensteer', 'api', 'plans')
    }

    async savePlan(
        plan: ApiPlanIr,
        meta?: Partial<ApiPlanMeta>
    ): Promise<StoredPlanRecord> {
        const normalized = normalizeDeterministicPlan(plan)
        const version =
            normalized.version ??
            (await this.resolveNextVersion(normalized.operation))
        const persistedPlan = {
            ...normalized,
            version,
        }
        persistedPlan.fingerprint = persistedPlan.fingerprint ?? normalized.fingerprint

        const dir = this.resolvePlanDir(persistedPlan.operation, version)
        const fixturesDir = path.join(dir, 'fixtures')
        await mkdir(fixturesDir, { recursive: true })

        const persistedMeta = createPlanMeta(persistedPlan, meta)
        const planPath = path.join(dir, 'plan.json')
        const metaPath = path.join(dir, 'meta.json')
        await Promise.all([
            writeJson(planPath, persistedPlan),
            writeJson(metaPath, persistedMeta),
        ])

        return {
            dir,
            planPath,
            metaPath,
            fixturesDir,
            plan: persistedPlan,
            meta: persistedMeta,
        }
    }

    async saveFixture(
        operation: string,
        version: number,
        fixture: ApiPlanFixture
    ): Promise<string> {
        const dir = path.join(this.resolvePlanDir(operation, version), 'fixtures')
        await mkdir(dir, { recursive: true })
        const filePath = path.join(dir, `${sanitizeFixtureName(fixture.name)}.json`)
        await writeJson(filePath, fixture)
        return filePath
    }

    async loadLatest(
        operation: string,
        statuses?: ApiPlanStatus[]
    ): Promise<StoredPlanRecord | null> {
        const versions = await this.listVersions(operation)
        const sorted = versions.sort((left, right) => right - left)
        for (const version of sorted) {
            const record = await this.load(operation, version)
            if (!statuses?.length || statuses.includes(record.meta.status)) {
                return record
            }
        }
        return null
    }

    async load(operation: string, version?: number): Promise<StoredPlanRecord> {
        const resolvedVersion =
            version ?? (await this.resolveLatestVersion(operation))
        if (resolvedVersion == null) {
            throw new Error(`No saved API plan found for operation "${operation}".`)
        }

        const dir = this.resolvePlanDir(operation, resolvedVersion)
        return this.loadPlanDir(dir)
    }

    async loadByRef(ref: string): Promise<StoredPlanRecord | null> {
        const operations = await this.listOperations()
        for (const operation of operations) {
            const versions = await this.listVersions(operation)
            for (const version of versions.sort((left, right) => right - left)) {
                const record = await this.load(operation, version)
                if (record.plan.ref === ref) {
                    return record
                }
            }
        }
        return null
    }

    async list(operation?: string): Promise<ApiPlanSummary[]> {
        const operations = operation ? [operation] : await this.listOperations()
        const summaries: ApiPlanSummary[] = []
        for (const currentOperation of operations) {
            const versions = await this.listVersions(currentOperation)
            for (const version of versions.sort((left, right) => right - left)) {
                const record = await this.load(currentOperation, version)
                summaries.push(
                    summarizePlan(record.plan, record.dir, record.meta.updatedAt)
                )
            }
        }
        return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
    }

    async updateMeta(
        operation: string,
        version: number,
        updater: (meta: ApiPlanMeta) => ApiPlanMeta
    ): Promise<ApiPlanMeta> {
        const record = await this.load(operation, version)
        const nextMeta = updater(record.meta)
        nextMeta.updatedAt = Date.now()
        await writeJson(record.metaPath, nextMeta)
        return nextMeta
    }

    private async loadPlanDir(dir: string): Promise<StoredPlanRecord> {
        const planPath = path.join(dir, 'plan.json')
        const metaPath = path.join(dir, 'meta.json')
        const fixturesDir = path.join(dir, 'fixtures')
        const [planRaw, metaRaw] = await Promise.all([
            readFile(planPath, 'utf8'),
            readOptionalJson<ApiPlanMeta>(metaPath),
        ])
        const plan = normalizeDeterministicPlan(JSON.parse(planRaw) as ApiPlanIr)
        const meta = metaRaw ? createPlanMeta(plan, metaRaw) : createPlanMeta(plan)
        if (!metaRaw) {
            await writeJson(metaPath, meta)
        }
        return {
            dir,
            planPath,
            metaPath,
            fixturesDir,
            plan,
            meta,
        }
    }

    private async resolveLatestVersion(operation: string): Promise<number | null> {
        const versions = await this.listVersions(operation)
        if (!versions.length) {
            return null
        }
        return versions.sort((left, right) => right - left)[0] ?? null
    }

    private async resolveNextVersion(operation: string): Promise<number> {
        const latest = await this.resolveLatestVersion(operation)
        return latest == null ? 1 : latest + 1
    }

    private async listOperations(): Promise<string[]> {
        if (!existsSync(this.plansDir)) {
            return []
        }
        const entries = await readdir(this.plansDir, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
    }

    private async listVersions(operation: string): Promise<number[]> {
        const dir = path.join(this.plansDir, operation)
        if (!existsSync(dir)) {
            return []
        }
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map((entry) => Number.parseInt(entry.name, 10))
            .filter((value) => Number.isFinite(value))
    }

    private resolvePlanDir(operation: string, version: number): string {
        return path.join(this.plansDir, operation, String(version))
    }
}

export function readPlanRegistrySnapshot(rootDir: string): ApiPlanSummary[] {
    if (!existsSync(path.join(rootDir, '.opensteer', 'api', 'plans'))) {
        return []
    }

    const operations = readdirSync(path.join(rootDir, '.opensteer', 'api', 'plans'))
        .filter((entry) =>
            existsSync(path.join(rootDir, '.opensteer', 'api', 'plans', entry))
        )
        .sort()
    const summaries: ApiPlanSummary[] = []

    for (const operation of operations) {
        const versions = readdirSync(path.join(rootDir, '.opensteer', 'api', 'plans', operation))
            .filter((entry) => /^\d+$/.test(entry))
            .map((entry) => Number.parseInt(entry, 10))
            .sort((left, right) => right - left)
        for (const version of versions) {
            const dir = path.join(rootDir, '.opensteer', 'api', 'plans', operation, String(version))
            const planPath = path.join(dir, 'plan.json')
            const metaPath = path.join(dir, 'meta.json')
            if (!existsSync(planPath) || !existsSync(metaPath)) {
                continue
            }
            const plan = normalizeDeterministicPlan(JSON.parse(readFileSync(planPath, 'utf8')) as ApiPlanIr)
            const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ApiPlanMeta
            summaries.push(summarizePlan(plan, dir, meta.updatedAt))
        }
    }

    return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
    try {
        const raw = await readFile(filePath, 'utf8')
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function sanitizeFixtureName(value: string): string {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_')
    return cleaned || 'fixture'
}
