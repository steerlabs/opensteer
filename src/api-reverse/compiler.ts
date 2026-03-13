import { createHash } from 'node:crypto'
import { stableStringify } from '../utils/stable-stringify.js'
import type {
    ApiBindingResolver,
    ApiExecutionBinding,
    ApiPlanIr,
    ApiPlanLifecycle,
    ApiPlanMeta,
    ApiPlanRuntimeProfile,
    ApiPlanSessionRequirement,
    ApiPlanStatus,
    ApiPlanSuccessOracle,
    ApiPlanSummary,
    ApiRuntimeCapability,
    ApiStepTransport,
    ApiValidationFailureKind,
} from './types.js'

const PLAN_SCHEMA_VERSION = 'deterministic-plan.v2' as const

export interface NormalizeDeterministicPlanOptions {
    sourceRunRef?: string | null
    sourceRunId?: string | null
    lifecycle?: ApiPlanLifecycle
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
    const runtimeProfile = createRuntimeProfile(steps, sessionRequirementDetails)

    const normalized: ApiPlanIr = {
        ...cloneStructured(plan),
        schemaVersion: PLAN_SCHEMA_VERSION,
        version: plan.version ?? options.version ?? 1,
        status: undefined,
        lifecycle: resolvePlanLifecycle(plan, options),
        bindings,
        steps,
        executionMode: resolveExecutionMode(runtimeProfile.capability),
        runtimeProfile,
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
        lifecycle: plan.lifecycle ?? resolveLegacyPlanLifecycle(plan.status),
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
            resolver: getExecutionBindingResolver(binding, ''),
        })),
        successOracle: normalizeSuccessOracle(plan.successOracle),
    }

    return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

export function createPlanMeta(plan: ApiPlanIr, existing?: Partial<ApiPlanMeta>): ApiPlanMeta {
    const updatedAt = Date.now()
    const legacy = existing as
        | (Partial<ApiPlanMeta> & {
              status?: ApiPlanStatus
              lastValidatedAt?: number | null
              lastSuccessAt?: number | null
              lastFailureAt?: number | null
              lastFailureReason?: string | null
          })
        | undefined
    const runtimeProfile = plan.runtimeProfile ?? deriveRuntimeProfileFromPlan(plan)
    return {
        operation: plan.operation,
        version: plan.version ?? 1,
        schemaVersion: plan.schemaVersion ?? PLAN_SCHEMA_VERSION,
        lifecycle:
            plan.lifecycle ??
            existing?.lifecycle ??
            resolveLegacyPlanLifecycle(plan.status ?? legacy?.status) ??
            'draft',
        fingerprint: plan.fingerprint ?? buildPlanFingerprint(plan),
        createdAt: existing?.createdAt ?? plan.createdAt,
        updatedAt,
        createdFromRunRef: plan.sourceRunRef ?? existing?.createdFromRunRef ?? null,
        createdFromRunId: plan.sourceRunId ?? existing?.createdFromRunId ?? null,
        targetOrigin: plan.targetOrigin ?? existing?.targetOrigin ?? null,
        lastValidation:
            existing?.lastValidation ??
            coerceLegacyAttemptMeta({
                at: legacy?.lastValidatedAt ?? null,
                ok:
                    resolveLegacyPlanLifecycle(plan.status ?? legacy?.status) === 'validated' &&
                    !legacy?.lastFailureReason,
                failureReason: legacy?.lastFailureReason ?? null,
                capability: runtimeProfile.capability,
            }),
        lastExecution:
            existing?.lastExecution ??
            coerceLegacyExecutionMeta(legacy, runtimeProfile.capability),
    }
}

export function summarizePlan(plan: ApiPlanIr, dir: string, updatedAt: number): ApiPlanSummary {
    return {
        operation: plan.operation,
        version: plan.version ?? 1,
        lifecycle: plan.lifecycle ?? resolveLegacyPlanLifecycle(plan.status) ?? 'draft',
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
        const resolver = getExecutionBindingResolver(binding, '')
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
        const resolver = getExecutionBindingResolver(binding, '')
        if (resolver.kind !== 'cookie_captured') {
            return true
        }
        if (!cookieNamesToRemove) {
            return false
        }
        return !cookieNamesToRemove.has(resolver.cookieName)
    })

    return recomputePlanDerivedState({
        ...cloneStructured(plan),
        bindings,
    })
}

export function recomputePlanDerivedState(plan: ApiPlanIr): ApiPlanIr {
    return normalizeDeterministicPlan({
        ...cloneStructured(plan),
        runtimeProfile: undefined,
        sessionRequirementDetails: undefined,
        sessionRequirements: [],
    })
}

export function markPlanLifecycle(plan: ApiPlanIr, lifecycle: ApiPlanLifecycle): ApiPlanIr {
    return {
        ...plan,
        lifecycle,
        status: undefined,
    }
}

export function markPlanStatus(plan: ApiPlanIr, status: ApiPlanStatus): ApiPlanIr {
    return markPlanLifecycle(plan, resolveLegacyPlanLifecycle(status) ?? 'draft')
}

export function getExecutionBindingResolver(
    binding: ApiExecutionBinding,
    slotRawValue: string
): ApiBindingResolver {
    return binding.resolver ?? upgradeLegacyResolver(binding, slotRawValue)
}

export function getExecutionBindingResolverCandidates(
    binding: ApiExecutionBinding,
    slotRawValue: string
): ApiBindingResolver[] {
    const base = binding.resolverCandidates?.length
        ? binding.resolverCandidates
        : [getExecutionBindingResolver(binding, slotRawValue)]
    return dedupeResolvers(base)
}

export function getResolverCost(resolver: ApiBindingResolver): number {
    const candidate = unwrapComputedResolver(resolver)
    switch (candidate.kind) {
        case 'input':
        case 'constant':
            return 0
        case 'response_json':
        case 'response_header':
            return 1
        case 'cookie_live':
        case 'cookie_captured':
        case 'storage_live':
            return 2
        case 'dom_field':
        case 'script_json':
            return 3
        case 'unsupported':
            return 4
    }
}

export function getResolverCapability(resolver: ApiBindingResolver): ApiRuntimeCapability {
    const candidate = unwrapComputedResolver(resolver)
    switch (candidate.kind) {
        case 'cookie_live':
        case 'storage_live':
            return 'browser_fetch'
        case 'dom_field':
        case 'script_json':
        case 'unsupported':
            return 'browser_page'
        default:
            return 'http'
    }
}

function normalizeExecutionBinding(
    binding: ApiExecutionBinding,
    slotRawValue: string
): ApiExecutionBinding {
    const legacyResolver = getExecutionBindingResolver(binding, slotRawValue)
    const transforms = binding.transforms ? [...binding.transforms] : []
    const resolver = normalizeResolverWithTransforms(legacyResolver, transforms)
    const resolverCandidates = dedupeResolvers(
        (binding.resolverCandidates?.length
            ? binding.resolverCandidates
            : [legacyResolver]
        ).map((candidate) => normalizeResolverWithTransforms(candidate, transforms))
    )
    return {
        ...binding,
        transforms: resolver.kind === 'computed' ? resolver.transforms : transforms,
        resolver,
        resolverCandidates,
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
        case 'derived_response_header':
            return {
                kind: 'response_header',
                producerStepId: binding.producerStepId,
                producerRef: binding.producerRef,
                headerName: binding.headerName,
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
        const resolver = getExecutionBindingResolver(binding, '')
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
        const resolver = getExecutionBindingResolver(binding, '')
        const detail = createRequirementFromResolver(resolver)
        return detail?.ref === requirement.ref
    })
}

export function resolveStepTransport(bindings: ApiExecutionBinding[]): ApiStepTransport {
    const capability = bindings.reduce<ApiRuntimeCapability>(
        (current, binding) =>
            maxCapability(current, getResolverCapability(getExecutionBindingResolver(binding, ''))),
        'http'
    )
    if (capability === 'browser_page') {
        return 'browser_page'
    }
    if (capability === 'browser_fetch') {
        return 'browser_fetch'
    }
    return 'node_http'
}

export function deriveRuntimeProfileFromPlan(plan: ApiPlanIr): ApiPlanRuntimeProfile {
    return createRuntimeProfile(
        plan.steps,
        plan.sessionRequirementDetails || plan.runtimeProfile?.requirements || []
    )
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

function dedupeResolvers(values: ApiBindingResolver[]): ApiBindingResolver[] {
    const seen = new Set<string>()
    const output: ApiBindingResolver[] = []
    for (const value of values) {
        const key = stableStringify(value)
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        output.push(value)
    }
    return output
}

function createRuntimeProfile(
    steps: ApiPlanIr['steps'],
    requirements: ApiPlanSessionRequirement[]
): ApiPlanRuntimeProfile {
    const capability = resolveRuntimeCapability(steps, requirements)
    return {
        capability,
        requirements,
        browserlessReplayable: capability === 'http',
    }
}

function resolveRuntimeCapability(
    steps: ApiPlanIr['steps'],
    requirements: ApiPlanSessionRequirement[]
): ApiRuntimeCapability {
    const stepCapability = steps.reduce<ApiRuntimeCapability>((current, step) => {
        const next = transportToCapability(step.transport ?? 'node_http')
        return maxCapability(current, next)
    }, 'http')
    return requirements.reduce<ApiRuntimeCapability>(
        (current, requirement) => maxCapability(current, getRequirementCapability(requirement)),
        stepCapability
    )
}

function transportToCapability(transport: ApiStepTransport): ApiRuntimeCapability {
    switch (transport) {
        case 'browser_fetch':
            return 'browser_fetch'
        case 'browser_page':
            return 'browser_page'
        default:
            return 'http'
    }
}

function getRequirementCapability(
    requirement: ApiPlanSessionRequirement
): ApiRuntimeCapability {
    switch (requirement.kind) {
        case 'cookie_live':
        case 'storage_live':
            return 'browser_fetch'
        case 'dom_field':
        case 'script_json':
            return 'browser_page'
    }
}

function maxCapability(
    left: ApiRuntimeCapability,
    right: ApiRuntimeCapability
): ApiRuntimeCapability {
    const rank = {
        http: 0,
        browser_fetch: 1,
        browser_page: 2,
    } as const
    return rank[left] >= rank[right] ? left : right
}

function resolveExecutionMode(capability: ApiRuntimeCapability): ApiPlanIr['executionMode'] {
    switch (capability) {
        case 'browser_fetch':
            return 'browser_session'
        case 'browser_page':
            return 'browser_dom'
        default:
            return 'direct_http'
    }
}

function resolvePlanLifecycle(
    plan: ApiPlanIr,
    options: NormalizeDeterministicPlanOptions
): ApiPlanLifecycle {
    return (
        plan.lifecycle ??
        options.lifecycle ??
        resolveLegacyPlanLifecycle(plan.status ?? options.status) ??
        'draft'
    )
}

function resolveLegacyPlanLifecycle(status?: ApiPlanStatus): ApiPlanLifecycle | null {
    switch (status) {
        case 'validated':
        case 'healthy':
        case 'needs_session_refresh':
            return 'validated'
        case 'stale':
            return 'stale'
        case 'archived':
            return 'archived'
        case 'draft':
            return 'draft'
        default:
            return null
    }
}

function coerceLegacyAttemptMeta(args: {
    at: number | null
    ok: boolean
    failureReason: string | null
    capability: ApiRuntimeCapability
}): ApiPlanMeta['lastValidation'] {
    if (!args.at) {
        return null
    }
    return {
        at: args.at,
        ok: args.ok,
        failureKind: args.ok ? null : inferFailureKindFromReason(args.failureReason),
        runtimeMode: 'required',
        capability: args.capability,
    }
}

function coerceLegacyExecutionMeta(
    existing:
        | (Partial<ApiPlanMeta> & {
              lastSuccessAt?: number | null
              lastFailureAt?: number | null
              lastFailureReason?: string | null
          })
        | undefined,
    capability: ApiRuntimeCapability
): ApiPlanMeta['lastExecution'] {
    const successAt = existing?.lastSuccessAt ?? null
    const failureAt = existing?.lastFailureAt ?? null
    const at = Math.max(successAt ?? 0, failureAt ?? 0)
    if (!at) {
        return null
    }
    const ok = (successAt ?? 0) >= (failureAt ?? 0)
    return {
        at,
        ok,
        failureKind: ok ? null : inferFailureKindFromReason(existing?.lastFailureReason ?? null),
        runtimeMode: 'required',
        capability,
    }
}

function inferFailureKindFromReason(
    reason: string | null
): ApiValidationFailureKind | null {
    if (!reason) {
        return null
    }
    if (/schema_drift/i.test(reason)) {
        return 'schema_drift'
    }
    if (/session_missing/i.test(reason)) {
        return 'session_missing'
    }
    if (/session_expired/i.test(reason)) {
        return 'session_expired'
    }
    if (/auth_redirect/i.test(reason)) {
        return 'auth_redirect'
    }
    if (/runtime_unavailable|transport_blocked/i.test(reason)) {
        return 'runtime_unavailable'
    }
    if (/unsupported_plan/i.test(reason)) {
        return 'unsupported_plan'
    }
    return 'oracle_failed'
}
