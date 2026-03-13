import type { Opensteer } from './opensteer.js'
import { deriveRuntimeProfileFromPlan, normalizeDeterministicPlan } from './api-reverse/compiler.js'
import {
    PlanLifecycleService,
    type PlanValidationOutcome,
} from './api-reverse/lifecycle.js'
import { PlanExecutor } from './api-reverse/executor.js'
import { PlanRegistry, type StoredPlanRecord } from './api-reverse/registry.js'
import { PlanRuntimeManager } from './api-reverse/runtime.js'
import type {
    ApiPlanAttemptMeta,
    ApiPlanExecutionReport,
    ApiPlanIr,
    ApiPlanMeta,
    ApiPlanRuntimeMode,
    ApiPlanSummary,
} from './api-reverse/types.js'

export interface OpensteerApiPlansConfig {
    rootDir?: string
    opensteer?: Opensteer | null
}

export interface ExecuteDeterministicPlanOptions {
    allowDraft?: boolean
    runtimeMode?: ApiPlanRuntimeMode
    interactiveRuntime?: boolean
}

export interface ValidateDeterministicPlanOptions {
    alternateInputs?: Record<string, unknown>[]
    runtimeMode?: ApiPlanRuntimeMode
    interactiveRuntime?: boolean
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
    readonly runtimeManager: PlanRuntimeManager
    readonly lifecycle: PlanLifecycleService

    constructor(config: OpensteerApiPlansConfig = {}) {
        const rootDir = config.rootDir ?? process.cwd()
        const opensteer = config.opensteer ?? null
        this.registry = new PlanRegistry({ rootDir })
        this.executor = new PlanExecutor({ opensteer })
        this.runtimeManager = new PlanRuntimeManager({ opensteer })
        this.lifecycle = new PlanLifecycleService({
            executor: this.executor,
            runtimeManager: this.runtimeManager,
        })
    }

    setOpensteer(opensteer: Opensteer | null): void {
        this.executor.setOpensteer(opensteer)
        this.runtimeManager.setOpensteer(opensteer)
    }

    async listPlans(): Promise<ApiPlanSummary[]> {
        return this.registry.list()
    }

    async ensureSession(
        operation: string,
        options: {
            interactive?: boolean
            runtimeMode?: ApiPlanRuntimeMode
        } = {}
    ) {
        const record = await this.registry.loadLatest(operation)
        if (!record) {
            throw new Error(`No saved API plan found for operation "${operation}".`)
        }
        return this.runtimeManager.prepare(record.plan, {
            mode: options.runtimeMode ?? 'required',
            interactive: options.interactive,
        })
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
        const report = await this.client.lifecycle.execute(record.plan, {
            inputs,
            allowDraft: options.allowDraft,
            runtimeMode: options.runtimeMode,
            interactiveRuntime: options.interactiveRuntime,
        })
        await this.persistExecution(record, report, options.runtimeMode ?? 'required')
        return report
    }

    async validate(
        inputs: Record<string, unknown> = {},
        options: ValidateDeterministicPlanOptions = {}
    ): Promise<PlanValidationResult> {
        const record = await this.loadAnyPlan()
        const outcome = await this.client.lifecycle.validate(record.plan, {
            inputs,
            alternateInputs: options.alternateInputs,
            runtimeMode: options.runtimeMode,
            interactiveRuntime: options.interactiveRuntime,
        })
        const saved = await this.persistValidation(
            record,
            outcome,
            options.runtimeMode ?? 'required'
        )
        return {
            plan: saved.plan,
            meta: saved.meta,
            baseline: outcome.baseline,
            alternate: outcome.alternate,
            promotionIssues: outcome.promotionIssues,
        }
    }

    private async loadRunnablePlan(): Promise<StoredPlanRecord> {
        if (this.version != null) {
            return this.client.registry.load(this.operation, this.version)
        }

        const record =
            (await this.client.registry.loadLatest(this.operation, ['validated'])) ??
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

    private async persistValidation(
        record: StoredPlanRecord,
        outcome: PlanValidationOutcome,
        runtimeMode: ApiPlanRuntimeMode
    ): Promise<StoredPlanRecord> {
        const now = Date.now()
        const saved = await this.client.registry.savePlan(outcome.plan, {
            ...record.meta,
            lifecycle: outcome.lifecycle,
            lastValidation: buildAttemptMeta(outcome.baseline, outcome.plan, now, runtimeMode),
        })

        await this.client.registry.saveFixture(saved.plan.operation, saved.plan.version ?? 1, {
            name: 'validation-baseline',
            createdAt: now,
            inputs: outcome.baseline.inputs,
        })
        for (const [index, report] of outcome.alternate.entries()) {
            await this.client.registry.saveFixture(saved.plan.operation, saved.plan.version ?? 1, {
                name: `validation-${index + 1}`,
                createdAt: now,
                inputs: report.inputs,
            })
        }

        return saved
    }

    private async persistExecution(
        record: StoredPlanRecord,
        report: ApiPlanExecutionReport,
        runtimeMode: ApiPlanRuntimeMode
    ): Promise<void> {
        const now = Date.now()
        const nextLifecycle =
            report.failureKind === 'schema_drift' ? 'stale' : record.meta.lifecycle
        await this.client.registry.updateMeta(
            record.plan.operation,
            record.plan.version ?? 1,
            (meta) => ({
                ...meta,
                lifecycle: nextLifecycle,
                lastExecution: buildAttemptMeta(report, record.plan, now, runtimeMode),
            })
        )
    }
}

function buildAttemptMeta(
    report: ApiPlanExecutionReport,
    plan: ApiPlanIr,
    at: number,
    runtimeMode: ApiPlanRuntimeMode
): ApiPlanAttemptMeta {
    const normalized = normalizeDeterministicPlan(plan)
    const runtimeProfile = normalized.runtimeProfile ?? deriveRuntimeProfileFromPlan(normalized)
    return {
        at,
        ok: report.ok,
        failureKind: report.failureKind,
        runtimeMode,
        capability: runtimeProfile.capability,
    }
}
