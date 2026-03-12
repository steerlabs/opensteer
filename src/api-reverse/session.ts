import { Opensteer } from '../opensteer.js'
import { normalizeDeterministicPlan } from './compiler.js'
import type { ApiPlanIr, ApiPlanSessionRequirement } from './types.js'

export interface SessionManagerOptions {
    opensteer?: Opensteer | null
}

export interface SessionEnsureOptions {
    interactive?: boolean
}

export interface SessionEnsureResult {
    ok: boolean
    refreshed: boolean
    mode: 'not_required' | 'existing' | 'silent' | 'interactive'
    notes: string[]
}

export class SessionManager {
    private opensteer: Opensteer | null
    private ownedOpensteer: Opensteer | null = null

    constructor(options: SessionManagerOptions = {}) {
        this.opensteer = options.opensteer ?? null
    }

    setOpensteer(opensteer: Opensteer | null): void {
        this.opensteer = opensteer
    }

    getOpensteer(): Opensteer | null {
        return this.opensteer
    }

    async ensurePlanSession(
        plan: ApiPlanIr,
        options: SessionEnsureOptions = {}
    ): Promise<SessionEnsureResult> {
        const normalized = normalizeDeterministicPlan(plan)
        const requirements = normalized.sessionRequirementDetails || []
        if (!requirements.length) {
            return {
                ok: true,
                refreshed: false,
                mode: 'not_required',
                notes: [],
            }
        }

        if (await this.hasSatisfiedRequirements(normalized, this.opensteer)) {
            return {
                ok: true,
                refreshed: false,
                mode: 'existing',
                notes: ['Reused the current browser session.'],
            }
        }

        const silent = await this.tryRefresh(normalized, true)
        if (silent) {
            return {
                ok: true,
                refreshed: true,
                mode: 'silent',
                notes: ['Refreshed browser state using a local real-browser profile.'],
            }
        }

        if (options.interactive === false) {
            return {
                ok: false,
                refreshed: false,
                mode: 'silent',
                notes: ['Session requirements are missing and interactive refresh was disabled.'],
            }
        }

        const interactive = await this.tryRefresh(normalized, false)
        return {
            ok: interactive,
            refreshed: interactive,
            mode: 'interactive',
            notes: interactive
                ? ['Interactive browser refresh satisfied the required session state.']
                : ['Interactive browser refresh did not satisfy the required session state.'],
        }
    }

    async shutdown(): Promise<void> {
        const owned = this.ownedOpensteer
        this.ownedOpensteer = null
        if (owned) {
            await owned.close().catch(() => undefined)
        }
    }

    private async tryRefresh(plan: ApiPlanIr, headless: boolean): Promise<boolean> {
        const opensteer = await this.ensureLocalBrowser(headless)
        await navigatePlanOrigin(opensteer, plan)
        return this.hasSatisfiedRequirements(plan, opensteer)
    }

    private async ensureLocalBrowser(headless: boolean): Promise<Opensteer> {
        if (this.ownedOpensteer) {
            return this.ownedOpensteer
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
        this.opensteer = opensteer
        return opensteer
    }

    private async hasSatisfiedRequirements(
        plan: ApiPlanIr,
        opensteer: Opensteer | null
    ): Promise<boolean> {
        const requirements = plan.sessionRequirementDetails || []
        if (!requirements.length) {
            return true
        }
        if (!opensteer) {
            return false
        }

        await navigatePlanOrigin(opensteer, plan)
        for (const requirement of requirements) {
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
