import { createHash } from 'node:crypto'
import { stableStringify } from '../utils/stable-stringify.js'
import type {
    ApiBindingResolver,
    ApiExecutionBinding,
    ApiPlanIr,
    ApiPlanMeta,
    ApiPlanSessionRequirement,
    ApiPlanStatus,
    ApiPlanSuccessOracle,
    ApiPlanSummary,
    ApiStepTransport,
} from './types.js'

const PLAN_SCHEMA_VERSION = 'deterministic-plan.v1' as const

export interface NormalizeDeterministicPlanOptions {
    sourceRunRef?: string | null
    sourceRunId?: string | null
    status?: ApiPlanStatus
    version?: number
}

export function normalizeDeterministicPlan(
    plan: ApiPlanIr,
    options: NormalizeDeterministicPlanOptions = {}
): ApiPlanIr {
    const slotByRef = new Map(plan.slots.map((slot) => [slot.ref, slot]))
    const bindings = plan.bindings.map((binding) =>
        normalizeExecutionBinding(binding, slotByRef.get(binding.slotRef)?.rawValue ?? '')
    )
    const sessionRequirementDetails = mergeSessionRequirements(
        plan.sessionRequirementDetails || [],
        collectSessionRequirements(bindings)
    )
    const steps = plan.steps.map((step) => {
        const stepBindings = bindings.filter((binding) => binding.stepId === step.id)
        const transport = resolveStepTransport(stepBindings)
        return {
            ...step,
            transport,
            sessionRequirementRefs: sessionRequirementDetails
                .filter((requirement) => bindingNeedsRequirement(stepBindings, requirement))
                .map((requirement) => requirement.ref),
        }
    })

    const normalized: ApiPlanIr = {
        ...cloneStructured(plan),
        schemaVersion: PLAN_SCHEMA_VERSION,
        version: plan.version ?? options.version ?? 1,
        status: plan.status ?? options.status ?? 'draft',
        bindings,
        steps,
        successOracle: normalizeSuccessOracle(plan.successOracle),
        sessionRequirements: dedupeStrings([
            ...(plan.sessionRequirements || []),
            ...sessionRequirementDetails.map((detail) => detail.label),
        ]),
        sessionRequirementDetails,
        sourceRunRef: plan.sourceRunRef ?? options.sourceRunRef ?? null,
        sourceRunId: plan.sourceRunId ?? options.sourceRunId ?? null,
        targetOrigin:
            plan.targetOrigin ??
            inferTargetOrigin(plan.steps.map((step) => step.requestTemplate?.url ?? step.urlTemplate)),
    }

    normalized.fingerprint = buildPlanFingerprint(normalized)
    return normalized
}

export function buildPlanFingerprint(plan: ApiPlanIr): string {
    const payload = {
        schemaVersion: plan.schemaVersion ?? PLAN_SCHEMA_VERSION,
        operation: plan.operation,
        targetStepId: plan.targetStepId,
        steps: plan.steps.map((step) => ({
            id: step.id,
            method: step.method,
            urlTemplate: step.urlTemplate,
            requestTemplate: step.requestTemplate ?? null,
            transport: step.transport ?? null,
            prerequisiteStepIds: [...step.prerequisiteStepIds],
            slotRefs: [...step.slotRefs],
        })),
        bindings: plan.bindings.map((binding) => ({
            stepId: binding.stepId,
            slotRef: binding.slotRef,
            resolver: binding.resolver ?? upgradeLegacyResolver(binding, ''),
        })),
        successOracle: normalizeSuccessOracle(plan.successOracle),
    }

    return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

export function createPlanMeta(plan: ApiPlanIr, existing?: Partial<ApiPlanMeta>): ApiPlanMeta {
    const updatedAt = Date.now()
    return {
        operation: plan.operation,
        version: plan.version ?? 1,
        schemaVersion: plan.schemaVersion ?? PLAN_SCHEMA_VERSION,
        status: plan.status ?? 'draft',
        fingerprint: plan.fingerprint ?? buildPlanFingerprint(plan),
        createdAt: existing?.createdAt ?? plan.createdAt,
        updatedAt,
        createdFromRunRef: plan.sourceRunRef ?? existing?.createdFromRunRef ?? null,
        createdFromRunId: plan.sourceRunId ?? existing?.createdFromRunId ?? null,
        targetOrigin: plan.targetOrigin ?? existing?.targetOrigin ?? null,
        authRequired: existing?.authRequired ?? Boolean(plan.sessionRequirementDetails?.length),
        lastValidatedAt: existing?.lastValidatedAt ?? null,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastFailureAt: existing?.lastFailureAt ?? null,
        lastFailureReason: existing?.lastFailureReason ?? null,
    }
}

export function summarizePlan(plan: ApiPlanIr, dir: string, updatedAt: number): ApiPlanSummary {
    return {
        operation: plan.operation,
        version: plan.version ?? 1,
        status: plan.status ?? 'draft',
        dir,
        ref: plan.ref,
        fingerprint: plan.fingerprint ?? buildPlanFingerprint(plan),
        updatedAt,
    }
}

export function listPlanPromotionIssues(plan: ApiPlanIr): string[] {
    const issues: string[] = []

    for (const step of plan.steps) {
        if (!step.requestTemplate) {
            issues.push(`Step ${step.id} is missing an executable request template.`)
        }
        if (step.transport == null) {
            issues.push(`Step ${step.id} is missing transport metadata.`)
        }
    }

    for (const binding of plan.bindings) {
        const resolver = binding.resolver ?? upgradeLegacyResolver(binding, '')
        if (resolver.kind === 'unsupported') {
            issues.push(`Binding ${binding.stepId}:${binding.slotRef} is unsupported.`)
        }
        if (resolver.kind === 'cookie_captured') {
            issues.push(`Binding ${binding.stepId}:${binding.slotRef} depends on a captured cookie.`)
        }
    }

    for (const requirement of plan.sessionRequirementDetails || []) {
        if (!requirement.required) {
            continue
        }
        if (!requirement.label.trim()) {
            issues.push(`A session requirement is missing its label.`)
        }
    }

    return dedupeStrings(issues)
}

export function stripCapturedCookieBindings(
    plan: ApiPlanIr,
    cookieNamesToRemove?: Set<string>
): ApiPlanIr {
    const bindings = plan.bindings.filter((binding) => {
        const resolver = binding.resolver ?? upgradeLegacyResolver(binding, '')
        if (resolver.kind !== 'cookie_captured') {
            return true
        }
        if (!cookieNamesToRemove) {
            return false
        }
        return !cookieNamesToRemove.has(resolver.cookieName)
    })

    return normalizeDeterministicPlan({
        ...cloneStructured(plan),
        bindings,
    })
}

export function markPlanStatus(plan: ApiPlanIr, status: ApiPlanStatus): ApiPlanIr {
    return {
        ...plan,
        status,
    }
}

function normalizeExecutionBinding(
    binding: ApiExecutionBinding,
    slotRawValue: string
): ApiExecutionBinding {
    const legacyResolver = binding.resolver ?? upgradeLegacyResolver(binding, slotRawValue)
    const transforms = binding.transforms ? [...binding.transforms] : []
    const resolver = normalizeResolverWithTransforms(legacyResolver, transforms)
    return {
        ...binding,
        transforms: resolver.kind === 'computed' ? resolver.transforms : transforms,
        resolver,
    }
}

function normalizeResolverWithTransforms(
    resolver: ApiBindingResolver,
    transforms: NonNullable<ApiExecutionBinding['transforms']>
): ApiBindingResolver {
    if (resolver.kind === 'computed') {
        return resolver
    }
    if (!transforms.length || resolver.kind === 'unsupported') {
        return resolver
    }
    return {
        kind: 'computed',
        source: resolver,
        transforms,
    }
}

function upgradeLegacyResolver(
    binding: ApiExecutionBinding,
    slotRawValue: string
): ApiBindingResolver {
    switch (binding.kind) {
        case 'caller':
            return {
                kind: 'input',
                inputName: binding.inputName,
            }
        case 'constant':
            return {
                kind: 'constant',
                value: binding.value,
            }
        case 'derived_response':
            return {
                kind: 'response_json',
                producerStepId: binding.producerStepId,
                producerRef: binding.producerRef,
                responsePath: binding.responsePath,
            }
        case 'ambient_cookie':
            return {
                kind: 'cookie_captured',
                cookieName: binding.cookieName,
                capturedValue: slotRawValue,
            }
        case 'session_cookie':
            return {
                kind: 'cookie_live',
                cookieName: binding.cookieName,
            }
        case 'session_storage':
            return {
                kind: 'storage_live',
                storageType: binding.storageType,
                key: binding.key,
            }
        case 'dom_field':
            return {
                kind: 'dom_field',
                fieldName: binding.fieldName,
                fieldId: binding.fieldId,
                fieldType: binding.fieldType,
                hidden: binding.hidden,
            }
        case 'inline_json':
            return {
                kind: 'script_json',
                source: binding.source,
                dataPath: binding.dataPath,
            }
        case 'unknown':
            return {
                kind: 'unsupported',
                reason: binding.reason,
            }
    }
}

function collectSessionRequirements(
    bindings: ApiExecutionBinding[]
): ApiPlanSessionRequirement[] {
    const requirements = new Map<string, ApiPlanSessionRequirement>()

    for (const binding of bindings) {
        const resolver = binding.resolver ?? upgradeLegacyResolver(binding, '')
        const requirement = createRequirementFromResolver(resolver)
        if (!requirement) {
            continue
        }
        requirements.set(requirement.ref, requirement)
    }

    return [...requirements.values()]
}

function mergeSessionRequirements(
    explicit: ApiPlanSessionRequirement[],
    inferred: ApiPlanSessionRequirement[]
): ApiPlanSessionRequirement[] {
    const requirements = new Map<string, ApiPlanSessionRequirement>()
    for (const requirement of [...explicit, ...inferred]) {
        requirements.set(requirement.ref, requirement)
    }
    return [...requirements.values()]
}

function createRequirementFromResolver(
    resolver: ApiBindingResolver
): ApiPlanSessionRequirement | null {
    switch (resolver.kind) {
        case 'cookie_live':
            return {
                ref: `cookie:${resolver.cookieName}`,
                kind: 'cookie_live',
                label: `cookie:${resolver.cookieName}`,
                cookieName: resolver.cookieName,
                required: true,
            }
        case 'storage_live':
            return {
                ref: `${resolver.storageType}:${resolver.key}`,
                kind: 'storage_live',
                label: `${resolver.storageType}Storage:${resolver.key}`,
                storageType: resolver.storageType,
                key: resolver.key,
                required: true,
            }
        case 'dom_field':
            return {
                ref: `dom:${resolver.fieldName || resolver.fieldId || resolver.fieldType || 'field'}`,
                kind: 'dom_field',
                label: `dom:${resolver.fieldName || resolver.fieldId || resolver.fieldType || 'field'}`,
                fieldName: resolver.fieldName,
                fieldId: resolver.fieldId,
                fieldType: resolver.fieldType,
                hidden: resolver.hidden,
                required: true,
            }
        case 'script_json':
            return {
                ref: `script:${resolver.source}:${resolver.dataPath}`,
                kind: 'script_json',
                label: `script:${resolver.source}:${resolver.dataPath}`,
                source: resolver.source,
                dataPath: resolver.dataPath,
                required: true,
            }
        case 'computed':
            return createRequirementFromResolver(resolver.source)
        default:
            return null
    }
}

function bindingNeedsRequirement(
    bindings: ApiExecutionBinding[],
    requirement: ApiPlanSessionRequirement
): boolean {
    return bindings.some((binding) => {
        const resolver = binding.resolver ?? upgradeLegacyResolver(binding, '')
        const detail = createRequirementFromResolver(resolver)
        return detail?.ref === requirement.ref
    })
}

function resolveStepTransport(bindings: ApiExecutionBinding[]): ApiStepTransport {
    const resolvers = bindings.map((binding) => binding.resolver ?? upgradeLegacyResolver(binding, ''))

    if (
        resolvers.some((resolver) => {
            const candidate = unwrapComputedResolver(resolver)
            return (
                candidate.kind === 'dom_field' ||
                candidate.kind === 'script_json' ||
                candidate.kind === 'unsupported'
            )
        })
    ) {
        return 'browser_page'
    }

    if (
        resolvers.some((resolver) => {
            const candidate = unwrapComputedResolver(resolver)
            return candidate.kind === 'cookie_live' || candidate.kind === 'storage_live'
        })
    ) {
        return 'browser_fetch'
    }

    return 'node_http'
}

function unwrapComputedResolver(resolver: ApiBindingResolver): Exclude<ApiBindingResolver, { kind: 'computed' }> {
    if (resolver.kind === 'computed') {
        return unwrapComputedResolver(resolver.source)
    }
    return resolver
}

function normalizeSuccessOracle(oracle: ApiPlanSuccessOracle): ApiPlanSuccessOracle {
    return {
        ...oracle,
        jsonPathChecks: oracle.jsonPathChecks ? [...oracle.jsonPathChecks] : [],
        textMustContain: oracle.textMustContain ? [...oracle.textMustContain] : [],
        textMustNotContain: oracle.textMustNotContain ? [...oracle.textMustNotContain] : [],
        redirectContains: oracle.redirectContains ? [...oracle.redirectContains] : [],
        requireNoAuthRedirect: oracle.requireNoAuthRedirect ?? true,
        download: oracle.download ?? null,
    }
}

function inferTargetOrigin(values: Array<string | undefined | null>): string | null {
    for (const value of values) {
        if (!value) {
            continue
        }
        try {
            return new URL(value).origin
        } catch {
            continue
        }
    }
    return null
}

function cloneStructured<T>(value: T): T {
    if (value == null) {
        return value
    }
    return JSON.parse(JSON.stringify(value)) as T
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values)]
}
