import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const BIN_PATH = path.resolve(process.cwd(), 'bin', 'opensteer.mjs')

function runOpensteer(args: string[]) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            OPENSTEER_SESSION: '',
            OPENSTEER_CLIENT_ID: '',
        },
    })
}

describe('opensteer CLI auth routing', () => {
    it('routes auth help without requiring runtime session env', () => {
        const result = runOpensteer(['auth', '--help'])
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Usage: opensteer auth <command> [options]')
        expect(result.stderr).toBe('')
    })

    it('routes login alias help without requiring runtime session env', () => {
        const result = runOpensteer(['login', '--help'])
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Usage: opensteer auth <command> [options]')
        expect(result.stderr).toBe('')
    })

    it('routes logout alias help without requiring runtime session env', () => {
        const result = runOpensteer(['logout', '--help'])
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Usage: opensteer auth <command> [options]')
        expect(result.stderr).toBe('')
    })

})
