import { spawnSync } from 'node:child_process'
import {
    existsSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const BIN_PATH = path.resolve(process.cwd(), 'bin', 'opensteer.mjs')
const RUNTIME_PREFIX = 'opensteer-'
const PID_SUFFIX = '.pid'
const META_SUFFIX = '.meta.json'

function runOpensteer(
    args: string[],
    options: { cwd?: string } = {}
): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        cwd: options.cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            OPENSTEER_SESSION: '',
            OPENSTEER_CLIENT_ID: '',
        },
    })
}

function parseJsonOutput<T>(stdout: string | Buffer): T {
    const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8')
    return JSON.parse(text.trim()) as T
}

function writeFakeSessionFiles(args: {
    runtimeSession: string
    logicalSession: string
    scopeDir: string
}): void {
    const pidPath = path.join(
        os.tmpdir(),
        `${RUNTIME_PREFIX}${args.runtimeSession}${PID_SUFFIX}`
    )
    const metaPath = path.join(
        os.tmpdir(),
        `${RUNTIME_PREFIX}${args.runtimeSession}${META_SUFFIX}`
    )
    writeFileSync(pidPath, String(process.pid))
    writeFileSync(
        metaPath,
        JSON.stringify(
            {
                runtimeSession: args.runtimeSession,
                logicalSession: args.logicalSession,
                scopeDir: args.scopeDir,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
            null,
            2
        )
    )
}

describe('opensteer CLI cwd-scoped runtime sessions', () => {
    it('derives the same runtimeSession for same cwd + logical session', () => {
        const cwd = mkdtempSync(path.join(os.tmpdir(), 'opensteer-scope-a-'))
        try {
            const first = runOpensteer(['status', '--session', 'yc-scraper'], {
                cwd,
            })
            const second = runOpensteer(['status', '--session', 'yc-scraper'], {
                cwd,
            })

            expect(first.status).toBe(0)
            expect(second.status).toBe(0)

            const firstJson = parseJsonOutput<{
                logicalSession: string
                runtimeSession: string
                scopeDir: string
            }>(first.stdout)
            const secondJson = parseJsonOutput<{
                logicalSession: string
                runtimeSession: string
                scopeDir: string
            }>(second.stdout)

            expect(firstJson.logicalSession).toBe('yc-scraper')
            expect(secondJson.logicalSession).toBe('yc-scraper')
            expect(firstJson.runtimeSession).toBe(secondJson.runtimeSession)
            expect(firstJson.scopeDir).toBe(secondJson.scopeDir)
            expect(firstJson.runtimeSession).toMatch(/^sc-[a-f0-9]{24}$/)
        } finally {
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('derives different runtimeSession values for different cwd with same logical session', () => {
        const cwdA = mkdtempSync(path.join(os.tmpdir(), 'opensteer-scope-b1-'))
        const cwdB = mkdtempSync(path.join(os.tmpdir(), 'opensteer-scope-b2-'))
        try {
            const first = runOpensteer(['status', '--session', 'yc-scraper'], {
                cwd: cwdA,
            })
            const second = runOpensteer(['status', '--session', 'yc-scraper'], {
                cwd: cwdB,
            })

            expect(first.status).toBe(0)
            expect(second.status).toBe(0)

            const firstJson = parseJsonOutput<{ runtimeSession: string }>(
                first.stdout
            )
            const secondJson = parseJsonOutput<{ runtimeSession: string }>(
                second.stdout
            )

            expect(firstJson.runtimeSession).not.toBe(secondJson.runtimeSession)
        } finally {
            rmSync(cwdA, { recursive: true, force: true })
            rmSync(cwdB, { recursive: true, force: true })
        }
    })

    it('includes human-readable metadata in sessions output', () => {
        const scopeA = mkdtempSync(path.join(os.tmpdir(), 'opensteer-scope-c1-'))
        const scopeB = mkdtempSync(path.join(os.tmpdir(), 'opensteer-scope-c2-'))
        const runtimeA = `sc-metatest-a-${Date.now().toString(36)}`
        const runtimeB = `sc-metatest-b-${process.pid.toString(36)}`
        const pidA = path.join(os.tmpdir(), `${RUNTIME_PREFIX}${runtimeA}${PID_SUFFIX}`)
        const pidB = path.join(os.tmpdir(), `${RUNTIME_PREFIX}${runtimeB}${PID_SUFFIX}`)
        const metaA = path.join(
            os.tmpdir(),
            `${RUNTIME_PREFIX}${runtimeA}${META_SUFFIX}`
        )
        const metaB = path.join(
            os.tmpdir(),
            `${RUNTIME_PREFIX}${runtimeB}${META_SUFFIX}`
        )

        try {
            writeFakeSessionFiles({
                runtimeSession: runtimeA,
                logicalSession: 'yc-scraper',
                scopeDir: scopeA,
            })
            writeFakeSessionFiles({
                runtimeSession: runtimeB,
                logicalSession: 'yc-scraper',
                scopeDir: scopeB,
            })

            const sessionsResult = runOpensteer(['sessions'])
            expect(sessionsResult.status).toBe(0)
            const sessionsJson = parseJsonOutput<{
                sessions: Array<{
                    logicalSession: string
                    runtimeSession: string
                    scopeDir: string | null
                    pid: number
                }>
            }>(sessionsResult.stdout)

            const byRuntime = new Map(
                sessionsJson.sessions.map((entry) => [
                    entry.runtimeSession,
                    entry,
                ])
            )

            expect(byRuntime.get(runtimeA)?.logicalSession).toBe('yc-scraper')
            expect(byRuntime.get(runtimeA)?.scopeDir).toBe(scopeA)
            expect(byRuntime.get(runtimeB)?.logicalSession).toBe('yc-scraper')
            expect(byRuntime.get(runtimeB)?.scopeDir).toBe(scopeB)
        } finally {
            rmSync(scopeA, { recursive: true, force: true })
            rmSync(scopeB, { recursive: true, force: true })
            for (const file of [pidA, pidB, metaA, metaB]) {
                rmSync(file, { force: true })
            }
        }
    })

    it('cleans stale metadata when a daemon pid is no longer alive', () => {
        const runtimeSession = `sc-metatest-stale-${Date.now().toString(36)}`
        const pidPath = path.join(
            os.tmpdir(),
            `${RUNTIME_PREFIX}${runtimeSession}${PID_SUFFIX}`
        )
        const metaPath = path.join(
            os.tmpdir(),
            `${RUNTIME_PREFIX}${runtimeSession}${META_SUFFIX}`
        )

        try {
            writeFileSync(pidPath, '99999999')
            writeFileSync(
                metaPath,
                JSON.stringify(
                    {
                        runtimeSession,
                        logicalSession: 'yc-scraper',
                        scopeDir: '/tmp/fake-scope',
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                    null,
                    2
                )
            )

            const sessionsResult = runOpensteer(['sessions'])
            expect(sessionsResult.status).toBe(0)
            expect(existsSync(pidPath)).toBe(false)
            expect(existsSync(metaPath)).toBe(false)
        } finally {
            rmSync(pidPath, { force: true })
            rmSync(metaPath, { force: true })
        }
    })

    it('uses canonical realpath for scopeDir', () => {
        const targetDir = mkdtempSync(path.join(os.tmpdir(), 'opensteer-scope-d-'))
        const linkDir = `${targetDir}-link`
        try {
            try {
                writeFileSync(path.join(targetDir, '.probe'), 'ok')
                rmSync(linkDir, { recursive: true, force: true })
                symlinkSync(targetDir, linkDir)
            } catch {
                const status = runOpensteer(['status', '--session', 'yc-scraper'], {
                    cwd: targetDir,
                })
                expect(status.status).toBe(0)
                const json = parseJsonOutput<{ scopeDir: string }>(status.stdout)
                expect(json.scopeDir).toBe(realpathSync(targetDir))
                return
            }

            const first = runOpensteer(['status', '--session', 'yc-scraper'], {
                cwd: targetDir,
            })
            const second = runOpensteer(['status', '--session', 'yc-scraper'], {
                cwd: linkDir,
            })

            expect(first.status).toBe(0)
            expect(second.status).toBe(0)

            const firstJson = parseJsonOutput<{
                scopeDir: string
                runtimeSession: string
            }>(first.stdout)
            const secondJson = parseJsonOutput<{
                scopeDir: string
                runtimeSession: string
            }>(second.stdout)

            expect(firstJson.scopeDir).toBe(secondJson.scopeDir)
            expect(firstJson.runtimeSession).toBe(secondJson.runtimeSession)
        } finally {
            rmSync(linkDir, { recursive: true, force: true })
            rmSync(targetDir, { recursive: true, force: true })
        }
    })
})
