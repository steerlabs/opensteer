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
                    context: {
                        addCookies: async () => undefined,
                    },
                }),
                loadLocalProfileCookies: async () => [],
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
        const loadLocalProfileCookies = vi.fn(async () => [
            {
                name: 'sid',
                value: 'v1',
                domain: '.example.com',
                path: '/',
                expires: 999999,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax' as const,
            },
        ])

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
                    launch: async () => undefined,
                    close: async () => undefined,
                    context: {
                        addCookies: async () => undefined,
                    },
                }),
                loadLocalProfileCookies,
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: () => undefined,
            }
        )

        expect(code).toBe(0)
        expect(loadLocalProfileCookies).toHaveBeenCalledOnce()

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
                    context: {
                        addCookies: async () => undefined,
                    },
                }),
                loadLocalProfileCookies: async () => [],
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

    it('preserves reuseIfActive when sync targets the configured browser profile', async () => {
        const seenLaunches: Array<Record<string, unknown>> = []
        const addCookies = vi.fn(async () => undefined)

        const code = await runOpensteerProfileCli(
            [
                'sync',
                '--from-profile-dir',
                '/tmp/profile',
                '--to-profile-id',
                'bp_123',
                '--all-domains',
                '--yes',
            ],
            {
                env: {
                    OPENSTEER_ACCESS_TOKEN: 'ost_token_123',
                    OPENSTEER_CLOUD_PROFILE_ID: 'bp_123',
                    OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE: 'true',
                },
                isInteractive: () => false,
                confirm: async () => false,
                createBrowserProfileClient: createMockBrowserProfileClient,
                createOpensteer: (config) => {
                    return {
                        launch: async (options) => {
                            seenLaunches.push({
                                config,
                                options: options || {},
                            })
                        },
                        close: async () => undefined,
                        context: {
                            addCookies,
                        },
                    }
                },
                loadLocalProfileCookies: async () => [
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
                writeStdout: () => undefined,
                writeStderr: () => undefined,
            }
        )

        expect(code).toBe(0)
        expect(seenLaunches).toHaveLength(1)
        expect(seenLaunches[0]).toEqual(
            expect.objectContaining({
                config: expect.objectContaining({
                    cloud: expect.objectContaining({
                        browserProfile: {
                            profileId: 'bp_123',
                            reuseIfActive: true,
                        },
                    }),
                }),
                options: expect.objectContaining({
                    headless: true,
                    timeout: 120_000,
                }),
            })
        )
        expect(addCookies).toHaveBeenCalled()
    })

    it('passes the sync headless preference to the local cookie loader', async () => {
        const loadLocalProfileCookies = vi.fn(async () => [
            {
                name: 'sid',
                value: 'v1',
                domain: '.example.com',
                path: '/',
                expires: 999999,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax' as const,
            },
        ])
        const createOpensteer = vi.fn(() => ({
            launch: async () => undefined,
            close: async () => undefined,
            context: {
                addCookies: async () => undefined,
            },
        }))

        const code = await runOpensteerProfileCli(
            [
                'sync',
                '--from-profile-dir',
                '/tmp/profile',
                '--domain',
                'example.com',
                '--headless',
                'false',
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
                createOpensteer,
                loadLocalProfileCookies,
                writeStdout: () => undefined,
                writeStderr: () => undefined,
            }
        )

        expect(code).toBe(0)
        expect(loadLocalProfileCookies).toHaveBeenCalledWith('/tmp/profile', {
            headless: false,
            timeout: 120_000,
        })
        expect(createOpensteer).not.toHaveBeenCalled()
    })

    it('surfaces profile loader errors without attempting a local browser launch', async () => {
        const stderr: string[] = []
        const createOpensteer = vi.fn(() => ({
            launch: async () => undefined,
            close: async () => undefined,
            context: {
                addCookies: async () => undefined,
            },
        }))

        const code = await runOpensteerProfileCli(
            [
                'sync',
                '--from-profile-dir',
                '/tmp/not-a-profile',
                '--domain',
                'example.com',
                '--yes',
                '--dry-run',
            ],
            {
                env: {
                    OPENSTEER_API_KEY: 'ork_test_123',
                },
                isInteractive: () => false,
                confirm: async () => false,
                createBrowserProfileClient: createMockBrowserProfileClient,
                createOpensteer,
                loadLocalProfileCookies: async () => {
                    throw new Error('Unsupported profile source "/tmp/not-a-profile".')
                },
                writeStdout: () => undefined,
                writeStderr: (message) => {
                    stderr.push(message)
                },
            }
        )

        expect(code).toBe(1)
        expect(createOpensteer).not.toHaveBeenCalled()
        expect(stderr.join('')).toContain('Unsupported profile source')
    })
})
