import type { Page } from 'playwright'
import type { Oversteer } from '../../src/oversteer.js'
import type { ActionResult } from '../../src/types.js'

export type JudgeMode = 'advisory' | 'strict'

export interface LiveWebRunConfig {
    enabled: boolean
    model: string
    scenarioFilter: Set<string> | null
    judge: {
        enabled: boolean
        mode: JudgeMode
        model: string
        failConfidence: number
    }
}

export type ScenarioStepOutcome =
    | ActionResult
    | Record<string, unknown>
    | string
    | number
    | boolean
    | null

export interface ScenarioStepTrace {
    step: string
    action: 'goto' | 'click' | 'input' | 'extract'
    description: string
    outcome?: ScenarioStepOutcome
}

export interface ScenarioCheck {
    name: string
    ok: boolean
    expected: string
    actual: string
}

export interface ScenarioEvidence {
    beforeUrl: string
    afterUrl: string
    beforeTitle: string
    afterTitle: string
    extractedData?: Record<string, unknown>
    notes?: string[]
}

export interface ScenarioResult {
    traces: ScenarioStepTrace[]
    checks: ScenarioCheck[]
    evidence: ScenarioEvidence
}

export interface ScenarioContext {
    page: Page
    ov: Oversteer
}

export interface LiveWebScenario {
    id: string
    title: string
    websiteUrl: string
    run: (ctx: ScenarioContext) => Promise<ScenarioResult>
}

export interface JudgeInput {
    scenario: Pick<LiveWebScenario, 'id' | 'title' | 'websiteUrl'>
    checks: ScenarioCheck[]
    traces: ScenarioStepTrace[]
    evidence: ScenarioEvidence
}

export interface JudgeVerdict {
    verdict: 'pass' | 'fail' | 'uncertain'
    confidence: number
    reasoning: string
    missing: string[]
}
