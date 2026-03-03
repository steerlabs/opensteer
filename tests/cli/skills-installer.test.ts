import { describe, expect, it } from 'vitest'
import {
    createSkillsInstallInvocation,
    parseOpensteerSkillsArgs,
    runOpensteerSkillsInstaller,
} from '../../src/cli/skills-installer.js'

describe('cli/skills-installer', () => {
    it('parses supported passthrough options for install', () => {
        expect(
            parseOpensteerSkillsArgs([
                'install',
                '--agent',
                'codex',
                'claude-code',
                '--global',
                '--yes',
                '--copy',
                '--all',
            ])
        ).toEqual({
            mode: 'install',
            passthroughArgs: [
                '--agent',
                'codex',
                'claude-code',
                '--global',
                '--yes',
                '--copy',
                '--all',
            ],
        })
    })

    it('treats "add" as an install alias', () => {
        expect(parseOpensteerSkillsArgs(['add', '-a', 'codex'])).toEqual({
            mode: 'install',
            passthroughArgs: ['-a', 'codex'],
        })
    })

    it('returns help mode when no subcommand is provided', () => {
        expect(parseOpensteerSkillsArgs([])).toEqual({
            mode: 'help',
            passthroughArgs: [],
        })
    })

    it('rejects unsupported options', () => {
        expect(parseOpensteerSkillsArgs(['install', '--skill', 'opensteer'])).toEqual({
            mode: 'error',
            passthroughArgs: [],
            error: 'Unsupported option "--skill" for "opensteer skills".',
        })
    })

    it('rejects --agent without values', () => {
        expect(parseOpensteerSkillsArgs(['install', '--agent'])).toEqual({
            mode: 'error',
            passthroughArgs: [],
            error: '--agent requires at least one value.',
        })
    })

    it('builds upstream invocation with implicit opensteer skill', () => {
        expect(
            createSkillsInstallInvocation({
                skillsCliPath: '/tmp/node_modules/skills/bin/cli.mjs',
                localSkillSourcePath: '/tmp/opensteer/skills',
                passthroughArgs: ['--agent', 'codex', '--yes'],
            })
        ).toEqual({
            cliPath: '/tmp/node_modules/skills/bin/cli.mjs',
            cliArgs: [
                'add',
                '/tmp/opensteer/skills',
                '--skill',
                'opensteer',
                '--agent',
                'codex',
                '--yes',
            ],
        })
    })

    it('prints help and exits 0', async () => {
        const stdout: string[] = []
        const stderr: string[] = []

        const code = await runOpensteerSkillsInstaller(['--help'], {
            resolveSkillsCliPath: () => '/unused',
            resolveLocalSkillSourcePath: () => '/unused',
            spawnInvocation: async () => 99,
            writeStdout(message) {
                stdout.push(message)
            },
            writeStderr(message) {
                stderr.push(message)
            },
        })

        expect(code).toBe(0)
        expect(stdout.join('')).toContain('Usage: opensteer skills <install|add> [options]')
        expect(stderr).toEqual([])
    })

    it('runs wrapped skills CLI and propagates its exit code', async () => {
        const invocations: Array<{ cliPath: string; cliArgs: string[] }> = []

        const code = await runOpensteerSkillsInstaller(
            ['install', '--agent', 'codex', '--yes'],
            {
                resolveSkillsCliPath: () => '/tmp/node_modules/skills/bin/cli.mjs',
                resolveLocalSkillSourcePath: () => '/tmp/opensteer/skills',
                spawnInvocation: async (invocation) => {
                    invocations.push(invocation)
                    return 7
                },
                writeStdout() {},
                writeStderr() {},
            }
        )

        expect(invocations).toEqual([
            {
                cliPath: '/tmp/node_modules/skills/bin/cli.mjs',
                cliArgs: [
                    'add',
                    '/tmp/opensteer/skills',
                    '--skill',
                    'opensteer',
                    '--agent',
                    'codex',
                    '--yes',
                ],
            },
        ])
        expect(code).toBe(7)
    })

    it('returns 1 and prints usage hint on parse errors', async () => {
        const stderr: string[] = []

        const code = await runOpensteerSkillsInstaller(['install', '--bad-flag'], {
            resolveSkillsCliPath: () => '/unused',
            resolveLocalSkillSourcePath: () => '/unused',
            spawnInvocation: async () => 0,
            writeStdout() {},
            writeStderr(message) {
                stderr.push(message)
            },
        })

        expect(code).toBe(1)
        expect(stderr.join('')).toContain('Run "opensteer skills --help" for usage.')
    })
})
