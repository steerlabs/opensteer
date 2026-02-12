import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { loadLiveWebRunConfig } from './env.js'
import { runLiveWebJudge } from './judge.js'
import { liveWebScenarios } from './scenarios.js'
import type { ScenarioCheck } from './types.js'

const liveWebConfig = loadLiveWebRunConfig()
const describeLiveWeb = liveWebConfig.enabled ? describe : describe.skip

const availableScenarioIds = new Set(
    liveWebScenarios.map((scenario) => scenario.id)
)
if (liveWebConfig.enabled && liveWebConfig.scenarioFilter) {
    const unknown = Array.from(liveWebConfig.scenarioFilter).filter(
        (id) => !availableScenarioIds.has(id)
    )

    if (unknown.length > 0) {
        throw new Error(
            `Unknown LIVE_WEB_SCENARIOS id(s): ${unknown.join(', ')}. Available ids: ${Array.from(availableScenarioIds).join(', ')}`
        )
    }
}

function formatCheckSummary(checks: ScenarioCheck[]): string {
    return checks
        .map((check) => {
            const status = check.ok ? 'PASS' : 'FAIL'
            return `[${status}] ${check.name}\nexpected: ${check.expected}\nactual: ${check.actual}`
        })
        .join('\n\n')
}

describeLiveWeb('live-web/validation', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-web-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    for (const scenario of liveWebScenarios) {
        const selected =
            !liveWebConfig.scenarioFilter ||
            liveWebConfig.scenarioFilter.has(scenario.id)

        const testCase = selected ? it : it.skip

        testCase(
            `${scenario.id}: ${scenario.title}`,
            async () => {
                let ov: Oversteer | null = null

                try {
                    ov = Oversteer.from(page, {
                        name: `live-web-${scenario.id}`,
                        model: liveWebConfig.model,
                        storage: {
                            rootDir,
                        },
                    })

                    const result = await scenario.run({ page, ov })
                    const failedChecks = result.checks.filter(
                        (check) => !check.ok
                    )

                    expect(
                        failedChecks,
                        `Deterministic checks failed for ${scenario.id}\n\n${formatCheckSummary(result.checks)}`
                    ).toEqual([])

                    const judgeVerdict = await runLiveWebJudge(
                        {
                            scenario: {
                                id: scenario.id,
                                title: scenario.title,
                                websiteUrl: scenario.websiteUrl,
                            },
                            checks: result.checks,
                            traces: result.traces,
                            evidence: result.evidence,
                        },
                        liveWebConfig
                    )

                    if (judgeVerdict) {
                        console.info(
                            `[live-web][judge] ${scenario.id}: verdict=${judgeVerdict.verdict}, confidence=${judgeVerdict.confidence.toFixed(2)}`
                        )

                        if (
                            liveWebConfig.judge.mode === 'strict' &&
                            judgeVerdict.verdict === 'fail' &&
                            judgeVerdict.confidence >=
                                liveWebConfig.judge.failConfidence
                        ) {
                            throw new Error(
                                `Judge marked scenario ${scenario.id} as fail with confidence ${judgeVerdict.confidence.toFixed(2)}. Reason: ${judgeVerdict.reasoning}`
                            )
                        }
                    }
                } finally {
                    if (ov) {
                        await ov.close()
                    }
                }
            },
            { timeout: 180000 }
        )
    }
})
