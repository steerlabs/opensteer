import { describe, expect, it, vi } from 'vitest'
import {
    parseOpensteerProfileArgs,
    runOpensteerProfileCli,
} from '../../src/cli/profile.js'

type ProfileCliOverrides = NonNullable<
    Parameters<typeof runOpensteerProfileCli>[1]
>
type CreateBrowserProfileClient = NonNullable<
    ProfileCliOverrides['createBrowserProfileClient']
>

const createMockBrowserProfileClient: CreateBrowserProfileClient = () => ({
    list: async () => ({ profiles: [] }),
    create: async () => ({
        profileId: 'bp_123',
        teamId: 'team_1',
        ownerUserId: 'user_1',
        name: 'Profile',
        status: 'active',
        proxyPolicy: 'strict_sticky',
        fingerprintMode: 'auto',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    }),
})

describe('cli/profile parser', () => {
    it('returns help mode when no args are provided', () => {
        expect(parseOpensteerProfileArgs([])).toEqual({
            mode: 'help',
        })
    })

    it('errors when create is missing --name', () => {
        expect(parseOpensteerProfileArgs(['create'])).toEqual({
            mode: 'error',
            error: '--name is required for "opensteer profile create".',
        })
    })

    it('errors when sync mixes --domain and --all-domains', () => {
        expect(
            parseOpensteerProfileArgs([
                'sync',
                '--from-profile-dir',
                '/tmp/profile',
                '--domain',
                'example.com',
                '--all-domains',
            ])
        ).toEqual({
            mode: 'error',
            error: 'Use either --all-domains or --domain, not both.',
        })
    })
})

describe('cli/profile runner', () => {
    it('fails sync in non-interactive mode when --yes is missing', async () => {
        const stderr: string[] = []

        const code = await runOpensteerProfileCli(
            [
                'sync',
                '--from-profile-dir',
                '/tmp/profile',
                '--all-domains',
            ],
            {
                env: {
                    OPENSTEER_API_KEY: 'ork_test_123',
                },
                isInteractive: () => false,
                confirm: async () => false,
                createBrowserProfileClient: createMockBrowserProfileClient,
                createOpensteer: () => ({
                    launch: async () => undefined,
                    close: async () => undefined,
                    getCookies: async () => [],
                    context: {
                        addCookies: async () => undefined,
                    },
                }),
                writeStdout: () => undefined,
                writeStderr: (message) => {
                    stderr.push(message)
                },
            }
        )

        expect(code).toBe(1)
        expect(stderr.join('')).toContain(
            'Non-interactive profile sync requires --yes.'
        )
    })

    it('supports non-interactive dry-run sync with explicit scope and --yes', async () => {
        const stdout: string[] = []
        const localLaunch = vi.fn(async () => undefined)
        const localClose = vi.fn(async () => undefined)

        const code = await runOpensteerProfileCli(
            [
                'sync',
                '--from-profile-dir',
                '/tmp/profile',
                '--domain',
                'example.com',
                '--yes',
                '--dry-run',
                '--json',
            ],
            {
                env: {
                    OPENSTEER_API_KEY: 'ork_test_123',
                },
                isInteractive: () => false,
                confirm: async () => false,
                createBrowserProfileClient: createMockBrowserProfileClient,
                createOpensteer: () => ({
                    launch: localLaunch,
                    close: localClose,
                    getCookies: async () => [
                        {
                            name: 'sid',
                            value: 'v1',
                            domain: '.example.com',
                            path: '/',
                            expires: 999999,
                            httpOnly: true,
                            secure: true,
                            sameSite: 'Lax',
                        },
                    ],
                    context: {
                        addCookies: async () => undefined,
                    },
                }),
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: () => undefined,
            }
        )

        expect(code).toBe(0)
        expect(localLaunch).toHaveBeenCalledOnce()
        expect(localClose).toHaveBeenCalledOnce()

        const payload = JSON.parse(stdout.join(''))
        expect(payload).toEqual(
            expect.objectContaining({
                success: true,
                dryRun: true,
                dedupedCookies: 1,
                filteredDomains: ['example.com'],
            })
        )
    })

    it('supports access-token auth for profile list', async () => {
        const seenContexts: Array<{
            baseUrl: string
            authScheme: string
            token: string
        }> = []

        const code = await runOpensteerProfileCli(
            ['list', '--access-token', 'ost_token_123', '--json'],
            {
                env: {},
                isInteractive: () => false,
                confirm: async () => false,
                createBrowserProfileClient: (context) => {
                    seenContexts.push({
                        baseUrl: context.baseUrl,
                        authScheme: context.authScheme,
                        token: context.token,
                    })
                    return {
                        list: async () => ({ profiles: [] }),
                        create: async () => ({
                            profileId: 'bp_123',
                            teamId: 'team_1',
                            ownerUserId: 'user_1',
                            name: 'Profile',
                            status: 'active',
                            proxyPolicy: 'strict_sticky',
                            fingerprintMode: 'auto',
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        }),
                    }
                },
                createOpensteer: () => ({
                    launch: async () => undefined,
                    close: async () => undefined,
                    getCookies: async () => [],
                    context: {
                        addCookies: async () => undefined,
                    },
                }),
                writeStdout: () => undefined,
                writeStderr: () => undefined,
            }
        )

        expect(code).toBe(0)
        expect(seenContexts).toEqual([
            expect.objectContaining({
                authScheme: 'bearer',
                token: 'ost_token_123',
            }),
        ])
    })
})
