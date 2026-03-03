import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const BIN_PATH = path.resolve(process.cwd(), 'bin', 'opensteer.mjs')

function runOpensteer(args: string[], binPath = BIN_PATH) {
    return spawnSync(process.execPath, [binPath, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            OPENSTEER_SESSION: '',
            OPENSTEER_CLIENT_ID: '',
        },
    })
}

describe('opensteer CLI skills routing', () => {
    it('prints skills help even when the built installer module is unavailable', () => {
        const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'opensteer-cli-'))
        const tempBinDir = path.join(tempRoot, 'bin')
        const tempBinPath = path.join(tempBinDir, 'opensteer.mjs')
        try {
            mkdirSync(tempBinDir, { recursive: true })
            copyFileSync(BIN_PATH, tempBinPath)

            const result = runOpensteer(['skills', '--help'], tempBinPath)
            expect(result.status).toBe(0)
            expect(result.stdout).toContain(
                'Usage: opensteer skills <install|add> [options]'
            )
            expect(result.stderr).toBe('')
        } finally {
            rmSync(tempRoot, { recursive: true, force: true })
        }
    })

    it('routes skills help without requiring runtime session env', () => {
        const result = runOpensteer(['skills', '--help'])
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Usage: opensteer skills <install|add> [options]')
        expect(result.stderr).toBe('')
    })

    it('surfaces upstream validation errors without session-routing failures', () => {
        const result = runOpensteer([
            'skills',
            'install',
            '--yes',
            '--agent',
            'not-a-real-agent',
        ])

        const combined = `${result.stdout}\n${result.stderr}`
        expect(result.status).not.toBe(0)
        expect(combined).toContain('Invalid agents:')
        expect(combined).not.toContain('No session resolved for this non-interactive command')
        expect(combined).not.toContain('Run \'opensteer open\' first')
    })
})
