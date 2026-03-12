import type { Opensteer } from './opensteer.js'
import {
    listPlanPromotionIssues,
    markPlanStatus,
    normalizeDeterministicPlan,
    stripCapturedCookieBindings,
} from './api-reverse/compiler.js'
import { PlanExecutor } from './api-reverse/executor.js'
import { PlanRegistry, type StoredPlanRecord } from './api-reverse/registry.js'
import { SessionManager, type SessionEnsureOptions, type SessionEnsureResult } from './api-reverse/session.js'
import type {
    ApiPlanExecutionReport,
    ApiPlanIr,
    ApiPlanMeta,
    ApiPlanStatus,
    ApiPlanSummary,
} from './api-reverse/types.js'

export interface OpensteerApiPlansConfig {
    rootDir?: string
    opensteer?: Opensteer | null
}

export interface ExecuteDeterministicPlanOptions {
    refreshSession?: boolean
    allowDraft?: boolean
}

export interface ValidateDeterministicPlanOptions {
    alternateInputs?: Record<string, unknown>[]
    interactiveSessionRefresh?: boolean
}

export interface PlanValidationResult {
    plan: ApiPlanIr
    meta: ApiPlanMeta
    baseline: ApiPlanExecutionReport
    alternate: ApiPlanExecutionReport[]
    promotionIssues: string[]
}

export class OpensteerApiPlans {
    readonly registry: PlanRegistry
    readonly executor: PlanExecutor
    readonly sessionManager: SessionManager

    constructor(config: OpensteerApiPlansConfig = {}) {
        const rootDir = config.rootDir ?? process.cwd()
        const opensteer = config.opensteer ?? null
        this.registry = new PlanRegistry({ rootDir })
        this.sessionManager = new SessionManager({ opensteer })
        this.executor = new PlanExecutor({ opensteer })
    }

    setOpensteer(opensteer: Opensteer | null): void {
        this.sessionManager.setOpensteer(opensteer)
        this.executor.setOpensteer(opensteer)
    }

    async listPlans(): Promise<ApiPlanSummary[]> {
        return this.registry.list()
    }

    async ensureSession(
        operation: string,
        options: SessionEnsureOptions = {}
    ): Promise<SessionEnsureResult> {
        const record = await this.registry.loadLatest(operation)
        if (!record) {
            throw new Error(`No saved API plan found for operation "${operation}".`)
        }
        const result = await this.sessionManager.ensurePlanSession(record.plan, options)
        this.executor.setOpensteer(this.sessionManager.getOpensteer())
        return result
    }

    plan(operation: string, version?: number): OpensteerApiPlanHandle {
        return new OpensteerApiPlanHandle(this, operation, version)
    }
}

export class OpensteerApiPlanHandle {
    private readonly client: OpensteerApiPlans
    private readonly operation: string
    private readonly version?: number

    constructor(client: OpensteerApiPlans, operation: string, version?: number) {
        this.client = client
        this.operation = operation
        this.version = version
    }

    async execute(
        inputs: Record<string, unknown> = {},
        options: ExecuteDeterministicPlanOptions = {}
    ): Promise<ApiPlanExecutionReport> {
        const record = await this.loadRunnablePlan()
        let report = await this.client.executor.execute(record.plan, {
            inputs,
            allowDraft: options.allowDraft,
        })

        if (
            options.refreshSession !== false &&
            isSessionRefreshableFailure(report.failureKind)
        ) {
            const sessionResult = await this.client.sessionManager.ensurePlanSession(record.plan)
            if (sessionResult.ok) {
                this.client.executor.setOpensteer(this.client.sessionManager.getOpensteer())
                report = await this.client.executor.execute(record.plan, {
                    inputs,
                    allowDraft: options.allowDraft,
                })
            }
        }

        await this.persistHealth(record, report)
        return report
    }

    async validate(
        inputs: Record<string, unknown> = {},
        options: ValidateDeterministicPlanOptions = {}
    ): Promise<PlanValidationResult> {
        const record = await this.loadAnyPlan()
        const normalized = normalizeDeterministicPlan(record.plan)
        const baselineInputs = buildBaselineInputs(normalized)
        let candidatePlan = normalized

        let baseline = await this.client.executor.execute(candidatePlan, {
            inputs: baselineInputs,
            allowDraft: true,
        })

        if (isSessionRefreshableFailure(baseline.failureKind)) {
            const session = await this.client.sessionManager.ensurePlanSession(candidatePlan, {
                interactive: options.interactiveSessionRefresh,
            })
            if (session.ok) {
                this.client.executor.setOpensteer(this.client.sessionManager.getOpensteer())
                baseline = await this.client.executor.execute(candidatePlan, {
                    inputs: baselineInputs,
                    allowDraft: true,
                })
            }
        }

        if (baseline.ok) {
            const stripped = stripCapturedCookieBindings(candidatePlan)
            const strippedReport = await this.client.executor.execute(stripped, {
                inputs: baselineInputs,
                allowDraft: true,
            })
            if (strippedReport.ok) {
                candidatePlan = stripped
                baseline = strippedReport
            }
        }

        const alternateInputSets = buildAlternateInputs(candidatePlan, inputs, options.alternateInputs)
        const alternate: ApiPlanExecutionReport[] = []
        for (const candidateInputs of alternateInputSets) {
            const report = await this.client.executor.execute(candidatePlan, {
                inputs: candidateInputs,
                allowDraft: true,
            })
            alternate.push(report)
        }

        const promotionIssues = [
            ...listPlanPromotionIssues(candidatePlan),
        ]
        if (!baseline.ok) {
            promotionIssues.push(`Baseline validation failed with ${baseline.failureKind ?? 'unknown failure'}.`)
        }
        if (alternate.some((report) => !report.ok)) {
            promotionIssues.push('Alternate validation inputs did not all succeed.')
        }

        let status: ApiPlanStatus = candidatePlan.status ?? 'draft'
        if (!promotionIssues.length) {
            status = 'validated'
        } else if (alternate.some((report) => isSessionRefreshableFailure(report.failureKind))) {
            status = 'needs_session_refresh'
        } else if (baseline.failureKind === 'schema_drift' || alternate.some((report) => report.failureKind === 'schema_drift')) {
            status = 'stale'
        }

        candidatePlan = normalizeDeterministicPlan(markPlanStatus(candidatePlan, status))
        const saved = await this.client.registry.savePlan(candidatePlan, {
            ...record.meta,
            status,
            lastValidatedAt: Date.now(),
            lastSuccessAt:
                status === 'validated'
                    ? Date.now()
                    : record.meta.lastSuccessAt,
            lastFailureAt:
                promotionIssues.length > 0
                    ? Date.now()
                    : record.meta.lastFailureAt,
            lastFailureReason:
                promotionIssues.length > 0
                    ? promotionIssues.join(' ')
                    : null,
        })

        await this.client.registry.saveFixture(saved.plan.operation, saved.plan.version ?? 1, {
            name: 'captured-defaults',
            createdAt: Date.now(),
            inputs: baseline.inputs,
        })
        for (const [index, report] of alternate.entries()) {
            await this.client.registry.saveFixture(saved.plan.operation, saved.plan.version ?? 1, {
                name: `validation-${index + 1}`,
                createdAt: Date.now(),
                inputs: report.inputs,
            })
        }

        return {
            plan: saved.plan,
            meta: saved.meta,
            baseline,
            alternate,
            promotionIssues,
        }
    }

    private async loadRunnablePlan(): Promise<StoredPlanRecord> {
        if (this.version != null) {
            const record = await this.client.registry.load(this.operation, this.version)
            return record
        }

        const record =
            (await this.client.registry.loadLatest(this.operation, ['healthy', 'validated'])) ??
            (await this.client.registry.loadLatest(this.operation))
        if (!record) {
            throw new Error(`No saved API plan found for operation "${this.operation}".`)
        }
        return record
    }

    private async loadAnyPlan(): Promise<StoredPlanRecord> {
        if (this.version != null) {
            return this.client.registry.load(this.operation, this.version)
        }
        const record = await this.client.registry.loadLatest(this.operation)
        if (!record) {
            throw new Error(`No saved API plan found for operation "${this.operation}".`)
        }
        return record
    }

    private async persistHealth(
        record: StoredPlanRecord,
        report: ApiPlanExecutionReport
    ): Promise<void> {
        const nextStatus: ApiPlanStatus =
            report.ok
                ? 'healthy'
                : report.failureKind === 'session_missing' ||
                    report.failureKind === 'session_expired' ||
                    report.failureKind === 'auth_redirect'
                  ? 'needs_session_refresh'
                  : report.failureKind === 'schema_drift'
                    ? 'stale'
                    : record.meta.status

        await this.client.registry.updateMeta(
            record.plan.operation,
            record.plan.version ?? 1,
            (meta) => ({
                ...meta,
                status: nextStatus,
                lastSuccessAt: report.ok ? Date.now() : meta.lastSuccessAt,
                lastFailureAt: report.ok ? meta.lastFailureAt : Date.now(),
                lastFailureReason: report.ok
                    ? null
                    : report.failureKind ?? 'execution_failed',
            })
        )
    }
}

function buildBaselineInputs(plan: ApiPlanIr): Record<string, string> {
    return Object.fromEntries(
        plan.callerInputs
            .filter((input) => input.defaultValue != null)
            .map((input) => [input.name, input.defaultValue || ''])
    )
}

function buildAlternateInputs(
    plan: ApiPlanIr,
    primaryInputs: Record<string, unknown>,
    alternates: Record<string, unknown>[] | undefined
): Record<string, unknown>[] {
    const baseline = buildBaselineInputs(plan)
    const output: Record<string, unknown>[] = []
    const normalizedPrimary = normalizeInputValues(primaryInputs)
    if (
        Object.keys(normalizedPrimary).length > 0 &&
        !sameInputSet(normalizedPrimary, baseline)
    ) {
        output.push(normalizedPrimary)
    }
    for (const current of alternates || []) {
        const normalized = normalizeInputValues(current)
        if (Object.keys(normalized).length === 0) {
            continue
        }
        output.push(normalized)
    }
    return dedupeInputSets(output)
}

function normalizeInputValues(inputs: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(inputs)
            .filter(([, value]) => value != null)
            .map(([key, value]) => [key, String(value)])
    )
}

function dedupeInputSets(values: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Set<string>()
    const output: Record<string, unknown>[] = []
    for (const value of values) {
        const key = JSON.stringify(value)
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        output.push(value)
    }
    return output
}

function isSessionRefreshableFailure(kind: ApiPlanExecutionReport['failureKind']): boolean {
    return (
        kind === 'session_missing' ||
        kind === 'session_expired' ||
        kind === 'auth_redirect'
    )
}

function sameInputSet(
    left: Record<string, string>,
    right: Record<string, string>
): boolean {
    const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
    const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
    if (leftEntries.length !== rightEntries.length) {
        return false
    }
    return leftEntries.every(([key, value], index) => {
        const rightEntry = rightEntries[index]
        return rightEntry?.[0] === key && rightEntry[1] === value
    })
}
