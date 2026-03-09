import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
    parseOpensteerLocalProfileArgs,
    runOpensteerLocalProfileCli,
} from '../../src/cli/local-profile.js'

describe('cli/local-profile parser', () => {
    it('returns help mode with no args', () => {
        expect(parseOpensteerLocalProfileArgs([])).toEqual({
            mode: 'help',
        })
    })

    it('parses list mode with json output', () => {
        expect(
            parseOpensteerLocalProfileArgs(['list', '--json'])
        ).toEqual({
            mode: 'list',
            json: true,
            userDataDir: undefined,
        })
    })
})

describe('cli/local-profile runner', () => {
    it('prints discovered profiles', async () => {
        const userDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-local-profile-cli-')
        )
        await writeFile(
            join(userDataDir, 'Local State'),
            JSON.stringify({
                profile: {
                    info_cache: {
                        Default: { name: 'Personal' },
                    },
                },
            })
        )

        const stdout: string[] = []
        const code = await runOpensteerLocalProfileCli(
            ['list', '--user-data-dir', userDataDir],
            {
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: () => undefined,
            }
        )

        expect(code).toBe(0)
        expect(stdout.join('')).toContain('Default\tPersonal')
    })
})
