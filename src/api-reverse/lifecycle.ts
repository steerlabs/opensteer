import { stableStringify } from '../utils/stable-stringify.js'
import {
    getExecutionBindingResolver,
    getExecutionBindingResolverCandidates,
    getResolverCost,
    markPlanLifecycle,
    normalizeDeterministicPlan,
    recomputePlanDerivedState,
    listPlanPromotionIssues,
} from './compiler.js'
import { PlanExecutor } from './executor.js'
import { PlanRuntimeManager } from './runtime.js'
import type {
    ApiBindingResolver,
    ApiPlanExecutionReport,
    ApiPlanIr,
    ApiPlanLifecycle,
    ApiPlanRuntimeMode,
} from './types.js'

export interface PlanLifecycleServiceOptions {
    executor: PlanExecutor
    runtimeManager: PlanRuntimeManager
}

export interface ExecuteLifecycleOptions {
    inputs?: Record<string, unknown>
    allowDraft?: boolean
    runtimeMode?: ApiPlanRuntimeMode
    interactiveRuntime?: boolean
}

export interface ValidateLifecycleOptions {
    inputs?: Record<string, unknown>
    alternateInputs?: Record<string, unknown>[]
    runtimeMode?: ApiPlanRuntimeMode
    interactiveRuntime?: boolean
}

export interface PlanValidationOutcome {
    plan: ApiPlanIr
    baseline: ApiPlanExecutionReport
    alternate: ApiPlanExecutionReport[]
    promotionIssues: string[]
    lifecycle: ApiPlanLifecycle
}

export class PlanLifecycleService {
    private readonly executor: PlanExecutor
    private readonly runtimeManager: PlanRuntimeManager

    constructor(options: PlanLifecycleServiceOptions) {
        this.executor = options.executor
        this.runtimeManager = options.runtimeManager
    }

    async execute(
        plan: ApiPlanIr,
        options: ExecuteLifecycleOptions = {}
    ): Promise<ApiPlanExecutionReport> {
        const normalized = normalizeDeterministicPlan(plan)
        const runtimeMode = options.runtimeMode ?? 'required'
        const inputs = normalizeInputValues(options.inputs ?? {})
        if (options.allowDraft !== true && normalized.lifecycle !== 'validated') {
            return this.executor.execute(normalized, {
                inputs,
                allowDraft: false,
                runtime: null,
            })
        }
        const prepared = await this.runtimeManager.prepare(normalized, {
            mode: runtimeMode,
            interactive: options.interactiveRuntime,
        })
        if (!prepared.ok) {
            return buildRuntimeFailureReport(
                normalized,
                inputs,
                prepared.failureKind ?? 'runtime_unavailable',
                prepared.notes.join(' ')
            )
        }
        return this.executor.execute(normalized, {
            inputs,
            allowDraft: options.allowDraft,
            runtime: prepared.runtime,
        })
    }

    async validate(
        plan: ApiPlanIr,
        options: ValidateLifecycleOptions = {}
    ): Promise<PlanValidationOutcome> {
        const normalized = normalizeDeterministicPlan(plan)
        const runtimeMode = options.runtimeMode ?? 'required'
        const baselineInputs = buildBaselineInputs(normalized, options.inputs ?? {})
        const alternateInputSets = buildAlternateInputs(
            normalized,
            baselineInputs,
            options.alternateInputs
        )

        const candidatePlan = await this.minimizeBindings(
            normalized,
            baselineInputs,
            alternateInputSets,
            runtimeMode,
            options.interactiveRuntime
        )

        const baseline = await this.execute(candidatePlan, {
            inputs: baselineInputs,
            allowDraft: true,
            runtimeMode,
            interactiveRuntime: options.interactiveRuntime,
        })
        const alternate: ApiPlanExecutionReport[] = []
        for (const candidateInputs of alternateInputSets) {
            alternate.push(
                await this.execute(candidatePlan, {
                    inputs: candidateInputs,
                    allowDraft: true,
                    runtimeMode,
                    interactiveRuntime: options.interactiveRuntime,
                })
            )
        }

        const promotionIssues = [...listPlanPromotionIssues(candidatePlan)]
        if (!baseline.ok) {
            promotionIssues.push(
                `Baseline validation failed with ${baseline.failureKind ?? 'unknown failure'}.`
            )
        }
        if (alternate.some((report) => !report.ok)) {
            promotionIssues.push('Alternate validation inputs did not all succeed.')
        }

        const lifecycle = resolveValidationLifecycle(baseline, alternate, promotionIssues)
        const promotedPlan = normalizeDeterministicPlan(
            markPlanLifecycle(candidatePlan, lifecycle)
        )

        return {
            plan: promotedPlan,
            baseline,
            alternate,
            promotionIssues,
            lifecycle,
        }
    }

    private async minimizeBindings(
        plan: ApiPlanIr,
        baselineInputs: Record<string, string>,
        alternateInputs: Record<string, string>[],
        runtimeMode: ApiPlanRuntimeMode,
        interactiveRuntime: boolean | undefined
    ): Promise<ApiPlanIr> {
        const slotByRef = new Map(plan.slots.map((slot) => [slot.ref, slot]))
        let candidatePlan = plan

        for (const [index, binding] of candidatePlan.bindings.entries()) {
            const slotRawValue = slotByRef.get(binding.slotRef)?.rawValue ?? ''
            const currentResolver = getExecutionBindingResolver(binding, slotRawValue)
            const currentCost = getResolverCost(currentResolver)
            if (currentCost === 0) {
                continue
            }

            const candidates = getExecutionBindingResolverCandidates(binding, slotRawValue)
                .filter(
                    (resolver) =>
                        getResolverCost(resolver) <= currentCost &&
                        !sameResolver(resolver, currentResolver)
                )
                .sort((left, right) => getResolverCost(left) - getResolverCost(right))

            for (const resolver of candidates) {
                if (
                    resolver.kind === 'constant' &&
                    !(await this.canCollapseBindingToConstant(
                        candidatePlan,
                        binding,
                        baselineInputs,
                        alternateInputs,
                        runtimeMode,
                        interactiveRuntime,
                        resolver.value
                    ))
                ) {
                    continue
                }
                const trialBindings = candidatePlan.bindings.map((current, currentIndex) =>
                    currentIndex === index
                        ? {
                              ...current,
                              resolver,
                          }
                        : current
                )
                const trialPlan = recomputePlanDerivedState({
                    ...candidatePlan,
                    bindings: trialBindings,
                })
                const ok = await this.passesValidationSuite(
                    trialPlan,
                    baselineInputs,
                    alternateInputs,
                    runtimeMode,
                    interactiveRuntime
                )
                if (ok) {
                    candidatePlan = trialPlan
                    break
                }
            }
        }

        return candidatePlan
    }

    private async canCollapseBindingToConstant(
        plan: ApiPlanIr,
        binding: ApiPlanIr['bindings'][number],
        baselineInputs: Record<string, string>,
        alternateInputs: Record<string, string>[],
        runtimeMode: ApiPlanRuntimeMode,
        interactiveRuntime: boolean | undefined,
        expectedValue: unknown
    ): Promise<boolean> {
        const capability = plan.runtimeProfile?.capability ?? 'http'
        if (capability !== 'http' && !this.runtimeManager.getOpensteer()) {
            return true
        }

        const prepared = await this.runtimeManager.prepare(plan, {
            mode: runtimeMode,
            interactive: interactiveRuntime,
        })
        if (!prepared.ok) {
            return true
        }

        for (const inputs of dedupeInputSets([baselineInputs, ...alternateInputs])) {
            try {
                const observed = await this.executor.probeBindingValue(
                    plan,
                    {
                        stepId: binding.stepId,
                        slotRef: binding.slotRef,
                    },
                    {
                        inputs,
                        runtime: prepared.runtime,
                    }
                )
                if (stableStringify(observed) !== stableStringify(expectedValue)) {
                    return false
                }
            } catch {
                return true
            }
        }
        return true
    }

    private async passesValidationSuite(
        plan: ApiPlanIr,
        baselineInputs: Record<string, string>,
        alternateInputs: Record<string, string>[],
        runtimeMode: ApiPlanRuntimeMode,
        interactiveRuntime: boolean | undefined
    ): Promise<boolean> {
        const baseline = await this.execute(plan, {
            inputs: baselineInputs,
            allowDraft: true,
            runtimeMode,
            interactiveRuntime,
        })
        if (!baseline.ok) {
            return false
        }
        for (const inputs of alternateInputs) {
            const report = await this.execute(plan, {
                inputs,
                allowDraft: true,
                runtimeMode,
                interactiveRuntime,
            })
            if (!report.ok) {
                return false
            }
        }
        return true
    }
}

function resolveValidationLifecycle(
    baseline: ApiPlanExecutionReport,
    alternate: ApiPlanExecutionReport[],
    promotionIssues: string[]
): ApiPlanLifecycle {
    if (!promotionIssues.length) {
        return 'validated'
    }
    if (
        baseline.failureKind === 'schema_drift' ||
        alternate.some((report) => report.failureKind === 'schema_drift')
    ) {
        return 'stale'
    }
    return 'draft'
}

function buildRuntimeFailureReport(
    plan: ApiPlanIr,
    inputs: Record<string, string>,
    failureKind: ApiPlanExecutionReport['failureKind'],
    detail: string
): ApiPlanExecutionReport {
    return {
        planRef: plan.ref,
        operation: plan.operation,
        version: plan.version ?? 1,
        executedAt: Date.now(),
        inputs,
        ok: false,
        failureKind,
        steps: [],
        oracleChecks: [
            {
                kind: 'status',
                ok: false,
                detail: detail || 'Required runtime capability is not available.',
            },
        ],
    }
}

function buildCapturedDefaultInputs(plan: ApiPlanIr): Record<string, string> {
    return Object.fromEntries(
        plan.callerInputs
            .filter((input) => input.defaultValue != null)
            .map((input) => [input.name, input.defaultValue || ''])
    )
}

function buildBaselineInputs(
    plan: ApiPlanIr,
    primaryInputs: Record<string, unknown>
): Record<string, string> {
    return {
        ...buildCapturedDefaultInputs(plan),
        ...normalizeInputValues(primaryInputs),
    }
}

function buildAlternateInputs(
    plan: ApiPlanIr,
    baselineInputs: Record<string, string>,
    alternates: Record<string, unknown>[] | undefined
): Record<string, string>[] {
    const output: Record<string, string>[] = []
    const capturedDefaults = buildCapturedDefaultInputs(plan)
    for (const current of alternates || []) {
        const normalized = {
            ...capturedDefaults,
            ...normalizeInputValues(current),
        }
        if (Object.keys(normalized).length === 0) {
            continue
        }
        output.push(normalized)
    }
    return dedupeInputSets(output).filter((current) => !sameInputSet(current, baselineInputs))
}

function normalizeInputValues(inputs: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(inputs)
            .filter(([, value]) => value != null)
            .map(([key, value]) => [key, String(value)])
    )
}

function dedupeInputSets(values: Record<string, string>[]): Record<string, string>[] {
    const seen = new Set<string>()
    const output: Record<string, string>[] = []
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

function sameResolver(left: ApiBindingResolver, right: ApiBindingResolver): boolean {
    return stableStringify(left) === stableStringify(right)
}
