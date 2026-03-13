import { Opensteer } from '../opensteer.js'
import { deriveRuntimeProfileFromPlan, normalizeDeterministicPlan } from './compiler.js'
import type {
    ApiPlanIr,
    ApiPlanRuntimeMode,
    ApiPlanSessionRequirement,
    ApiRuntimeCapability,
    ApiValidationFailureKind,
} from './types.js'

export interface PlanRuntimeManagerOptions {
    opensteer?: Opensteer | null
}

export interface PreparePlanRuntimeOptions {
    mode?: ApiPlanRuntimeMode
    interactive?: boolean
}

export interface PreparedPlanRuntime {
    capability: ApiRuntimeCapability
    mode: ApiPlanRuntimeMode
    opensteer: Opensteer | null
    source: 'none' | 'attached' | 'provisioned'
}

export interface PreparePlanRuntimeResult {
    ok: boolean
    failureKind: ApiValidationFailureKind | null
    runtime: PreparedPlanRuntime
    notes: string[]
}

export class PlanRuntimeManager {
    private opensteer: Opensteer | null
    private ownedOpensteer: Opensteer | null = null
    private ownedHeadless: boolean | null = null

    constructor(options: PlanRuntimeManagerOptions = {}) {
        this.opensteer = options.opensteer ?? null
    }

    setOpensteer(opensteer: Opensteer | null): void {
        this.opensteer = opensteer
        if (opensteer == null && this.ownedOpensteer == null) {
            this.ownedHeadless = null
        }
    }

    getOpensteer(): Opensteer | null {
        return this.opensteer
    }

    async prepare(
        plan: ApiPlanIr,
        options: PreparePlanRuntimeOptions = {}
    ): Promise<PreparePlanRuntimeResult> {
        const normalized = normalizeDeterministicPlan(plan)
        const runtimeProfile = normalized.runtimeProfile ?? deriveRuntimeProfileFromPlan(normalized)
        const mode = options.mode ?? 'required'
        if (mode === 'http_only') {
            if (runtimeProfile.capability !== 'http') {
                return {
                    ok: false,
                    failureKind: 'runtime_unavailable',
                    runtime: {
                        capability: 'http',
                        mode,
                        opensteer: null,
                        source: 'none',
                    },
                    notes: ['Plan requires browser capability and cannot run in http_only mode.'],
                }
            }
            return {
                ok: true,
                failureKind: null,
                runtime: {
                    capability: 'http',
                    mode,
                    opensteer: null,
                    source: 'none',
                },
                notes: [],
            }
        }

        if (runtimeProfile.capability === 'http') {
            return {
                ok: true,
                failureKind: null,
                runtime: {
                    capability: 'http',
                    mode,
                    opensteer: null,
                    source: 'none',
                },
                notes: [],
            }
        }

        if (await this.canUseOpensteer(normalized, this.opensteer)) {
            return {
                ok: true,
                failureKind: null,
                runtime: {
                    capability: runtimeProfile.capability,
                    mode,
                    opensteer: this.opensteer,
                    source: 'attached',
                },
                notes: ['Reused the current browser runtime.'],
            }
        }

        const silent = await this.tryProvision(normalized, true)
        if (silent.ok) {
            return {
                ok: true,
                failureKind: null,
                runtime: {
                    capability: runtimeProfile.capability,
                    mode,
                    opensteer: silent.opensteer,
                    source: 'provisioned',
                },
                notes: ['Provisioned a local browser runtime automatically.'],
            }
        }

        if (options.interactive === false) {
            return {
                ok: false,
                failureKind: silent.failureKind,
                runtime: {
                    capability: runtimeProfile.capability,
                    mode,
                    opensteer: null,
                    source: 'none',
                },
                notes: silent.notes,
            }
        }

        const interactive = await this.tryProvision(normalized, false)
        return {
            ok: interactive.ok,
            failureKind: interactive.failureKind,
            runtime: {
                capability: runtimeProfile.capability,
                mode,
                opensteer: interactive.opensteer,
                source: interactive.ok ? 'provisioned' : 'none',
            },
            notes: interactive.notes,
        }
    }

    async ensurePlanSession(
        plan: ApiPlanIr,
        options: PreparePlanRuntimeOptions = {}
    ): Promise<PreparePlanRuntimeResult> {
        return this.prepare(plan, {
            ...options,
            mode: options.mode ?? 'required',
        })
    }

    async shutdown(): Promise<void> {
        const owned = this.ownedOpensteer
        this.ownedOpensteer = null
        this.ownedHeadless = null
        if (owned) {
            await owned.close().catch(() => undefined)
        }
    }

    private async tryProvision(
        plan: ApiPlanIr,
        headless: boolean
    ): Promise<{
        ok: boolean
        failureKind: ApiValidationFailureKind | null
        opensteer: Opensteer | null
        notes: string[]
    }> {
        try {
            const opensteer = await this.ensureLocalBrowser(headless)
            const ready = await this.canUseOpensteer(plan, opensteer)
            if (ready) {
                return {
                    ok: true,
                    failureKind: null,
                    opensteer,
                    notes: [
                        headless
                            ? 'Provisioned a headless local browser runtime.'
                            : 'Provisioned an interactive local browser runtime.',
                    ],
                }
            }
            return {
                ok: false,
                failureKind: 'session_missing',
                opensteer,
                notes: ['Browser runtime started, but required browser state was not present.'],
            }
        } catch (error) {
            return {
                ok: false,
                failureKind: 'runtime_unavailable',
                opensteer: null,
                notes: [
                    error instanceof Error
                        ? error.message
                        : 'Failed to provision a local browser runtime.',
                ],
            }
        }
    }

    private async ensureLocalBrowser(headless: boolean): Promise<Opensteer> {
        if (this.ownedOpensteer && this.ownedHeadless === headless) {
            this.opensteer = this.ownedOpensteer
            return this.ownedOpensteer
        }
        if (this.ownedOpensteer) {
            await this.ownedOpensteer.close().catch(() => undefined)
            this.ownedOpensteer = null
            this.ownedHeadless = null
        }

        const opensteer = Opensteer.fromSystemChrome(
            { headless },
            {
                browser: {
                    mode: 'real',
                    headless,
                },
            }
        )
        await opensteer.launch({
            mode: 'real',
            headless,
        })
        this.ownedOpensteer = opensteer
        this.ownedHeadless = headless
        this.opensteer = opensteer
        return opensteer
    }

    private async canUseOpensteer(
        plan: ApiPlanIr,
        opensteer: Opensteer | null
    ): Promise<boolean> {
        const runtimeProfile = plan.runtimeProfile ?? deriveRuntimeProfileFromPlan(plan)
        if (runtimeProfile.capability === 'http') {
            return true
        }
        if (!opensteer) {
            return false
        }

        await navigatePlanOrigin(opensteer, plan)
        for (const requirement of runtimeProfile.requirements) {
            const satisfied = await isRequirementSatisfied(opensteer, plan, requirement)
            if (!satisfied) {
                return false
            }
        }
        return true
    }
}

async function navigatePlanOrigin(opensteer: Opensteer, plan: ApiPlanIr): Promise<void> {
    if (!plan.targetOrigin) {
        return
    }
    const currentUrl = opensteer.page.url()
    if (!currentUrl.startsWith(plan.targetOrigin)) {
        await opensteer.goto(plan.targetOrigin)
    }
}

async function isRequirementSatisfied(
    opensteer: Opensteer,
    plan: ApiPlanIr,
    requirement: ApiPlanSessionRequirement
): Promise<boolean> {
    switch (requirement.kind) {
        case 'cookie_live': {
            const cookies = await opensteer.context.cookies(
                plan.targetOrigin ? [plan.targetOrigin] : undefined
            )
            return cookies.some((cookie) => cookie.name === requirement.cookieName)
        }
        case 'storage_live': {
            const value = await opensteer.page.evaluate(
                ({ storageType, key }) =>
                    storageType === 'local'
                        ? window.localStorage.getItem(key)
                        : window.sessionStorage.getItem(key),
                {
                    storageType: requirement.storageType,
                    key: requirement.key,
                }
            )
            return value != null
        }
        case 'dom_field': {
            const value = await opensteer.page.evaluate(
                ({ fieldName, fieldId, fieldType, hidden }) => {
                    const elements = Array.from(
                        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
                            'input, textarea, select'
                        )
                    )
                    return elements.some((element) => {
                        const type =
                            'type' in element && typeof element.type === 'string'
                                ? element.type
                                : null
                        const isHidden =
                            type === 'hidden' ||
                            element.hidden ||
                            (element as HTMLElement).offsetParent === null
                        if (hidden !== isHidden) return false
                        if (fieldName && element.getAttribute('name') !== fieldName) return false
                        if (fieldId && element.getAttribute('id') !== fieldId) return false
                        if (fieldType && type !== fieldType) return false
                        return true
                    })
                },
                requirement
            )
            return value === true
        }
        case 'script_json': {
            const value = await opensteer.page.evaluate(
                ({ source, dataPath }) => {
                    const [prefix, selector] = String(source || '').split(':', 2)
                    if (prefix !== 'inline' || !selector) return null
                    const node = document.querySelector(selector)
                    if (!(node instanceof HTMLScriptElement)) return null
                    try {
                        const parsed = JSON.parse(node.textContent || '')
                        const tokens = String(dataPath || '')
                            .split(/(?=\[)|\./)
                            .filter(Boolean)
                        let current: unknown = parsed
                        for (const token of tokens) {
                            if (token.startsWith('[')) {
                                const index = Number.parseInt(token.slice(1, -1), 10)
                                current = Array.isArray(current) ? current[index] : null
                            } else {
                                current =
                                    current && typeof current === 'object'
                                        ? (current as Record<string, unknown>)[token]
                                        : null
                            }
                        }
                        return current
                    } catch {
                        return null
                    }
                },
                requirement
            )
            return value != null
        }
    }
}
