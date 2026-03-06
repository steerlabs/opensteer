import { describe, expect, it } from 'vitest'
import {
    ensureCloudCredentialsForCommand,
    parseOpensteerAuthArgs,
    runOpensteerAuthCli,
    type AuthFetchFn,
    type CloudCredentialStore,
} from '../../src/cli/auth.js'

interface StoredCredential {
    baseUrl: string
    siteUrl: string
    scope: string[]
    accessToken: string
    refreshToken: string
    obtainedAt: number
    expiresAt: number
}

function createMemoryStore() {
    let saved: StoredCredential | null = null

    return {
        readCloudCredential: () => saved,
        writeCloudCredential: (value: StoredCredential) => {
            saved = value
        },
        clearCloudCredential: () => {
            saved = null
        },
    }
}

function createFetchMock(): AuthFetchFn {
    return async (input: string): Promise<Response> => {
        const url = String(input)
        if (url.endsWith('/api/cli-auth/device/start')) {
            return new Response(
                JSON.stringify({
                    device_code: 'device_123',
                    user_code: 'ABCD-1234',
                    verification_uri: 'https://opensteer.com/cli/auth/device',
                    verification_uri_complete:
                        'https://opensteer.com/cli/auth/device?user_code=ABCD-1234',
                    expires_in: 600,
                    interval: 1,
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            )
        }
        if (url.endsWith('/api/cli-auth/device/token')) {
            return new Response(
                JSON.stringify({
                    access_token: 'ost_access_123',
                    token_type: 'Bearer',
                    expires_in: 900,
                    refresh_token: 'ost_refresh_123',
                    scope: 'cloud:browser',
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            )
        }
        throw new Error(`Unexpected URL: ${url}`)
    }
}

describe('cli/auth parser', () => {
    it('returns help mode when no args are provided', () => {
        expect(parseOpensteerAuthArgs([])).toEqual({
            mode: 'help',
        })
    })

    it('rejects unsupported subcommands', () => {
        expect(parseOpensteerAuthArgs(['unknown'])).toEqual({
            mode: 'error',
            error: 'Unsupported auth subcommand "unknown".',
        })
    })
})

describe('cli/auth runner', () => {
    it('reports logged-out status when no machine credential is saved', async () => {
        const stdout: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        const code = await runOpensteerAuthCli(['status', '--json'], {
            env: {},
            store,
            fetchFn: fetch as AuthFetchFn,
            writeStdout: (message) => {
                stdout.push(message)
            },
            writeStderr: () => undefined,
            isInteractive: () => false,
            sleep: async () => undefined,
            now: () => Date.now(),
            openExternalUrl: () => true,
        })

        expect(code).toBe(0)
        expect(JSON.parse(stdout.join(''))).toEqual({ loggedIn: false })
    })

    it('runs login flow and persists machine credentials', async () => {
        const stdout: string[] = []
        const stderr: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        const fetchMock = createFetchMock()

        const code = await runOpensteerAuthCli(
            [
                'login',
                '--base-url',
                'https://api.opensteer.com',
                '--site-url',
                'https://opensteer.com',
                '--no-browser',
                '--json',
            ],
            {
                env: {},
                store,
                fetchFn: fetchMock,
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: (message) => {
                    stderr.push(message)
                },
                isInteractive: () => true,
                sleep: async () => undefined,
                now: () => Date.now(),
                openExternalUrl: () => true,
            }
        )

        expect(code).toBe(0)
        expect(JSON.parse(stdout[stdout.length - 1] || '{}')).toEqual(
            expect.objectContaining({
                loggedIn: true,
                baseUrl: 'https://api.opensteer.com',
                siteUrl: 'https://opensteer.com',
            })
        )
        expect(stdout).toHaveLength(1)
        expect(stderr.join('')).toContain(
            'Automatic browser open is disabled (--no-browser).'
        )
        expect(stderr.join('')).toContain('Open this URL to authenticate Opensteer CLI:')
        expect(store.readCloudCredential()).toEqual(
            expect.objectContaining({
                accessToken: 'ost_access_123',
                refreshToken: 'ost_refresh_123',
            })
        )
    })

    it('opens the default browser during login when auto-open succeeds', async () => {
        const stdout: string[] = []
        const fetchMock = createFetchMock()
        const store: CloudCredentialStore = createMemoryStore()
        const openedUrls: string[] = []

        const code = await runOpensteerAuthCli(
            [
                'login',
                '--base-url',
                'https://api.opensteer.com',
                '--site-url',
                'https://opensteer.com',
            ],
            {
                env: {},
                store,
                fetchFn: fetchMock,
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: () => undefined,
                isInteractive: () => true,
                sleep: async () => undefined,
                now: () => Date.now(),
                openExternalUrl: (url) => {
                    openedUrls.push(url)
                    return true
                },
            }
        )

        expect(code).toBe(0)
        expect(openedUrls).toEqual([
            'https://opensteer.com/cli/auth/device?user_code=ABCD-1234',
        ])
        expect(stdout.join('')).toContain(
            'Opened your default browser. Finish authentication there; this terminal will continue automatically.'
        )
    })

    it('falls back cleanly when the browser cannot be opened automatically', async () => {
        const stdout: string[] = []
        const fetchMock = createFetchMock()
        const store: CloudCredentialStore = createMemoryStore()

        const code = await runOpensteerAuthCli(
            [
                'login',
                '--base-url',
                'https://api.opensteer.com',
                '--site-url',
                'https://opensteer.com',
            ],
            {
                env: {},
                store,
                fetchFn: fetchMock,
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: () => undefined,
                isInteractive: () => true,
                sleep: async () => undefined,
                now: () => Date.now(),
                openExternalUrl: () => false,
            }
        )

        expect(code).toBe(0)
        expect(stdout.join('')).toContain(
            'Could not open your default browser automatically. Paste the URL above into a browser to continue.'
        )
        expect(stdout.join('')).not.toContain('Opened your default browser.')
    })

    it('does not try to auto-open a browser in CI', async () => {
        const stdout: string[] = []
        const fetchMock = createFetchMock()
        const store: CloudCredentialStore = createMemoryStore()
        let openCount = 0

        const code = await runOpensteerAuthCli(
            [
                'login',
                '--base-url',
                'https://api.opensteer.com',
                '--site-url',
                'https://opensteer.com',
            ],
            {
                env: {
                    CI: '1',
                },
                store,
                fetchFn: fetchMock,
                writeStdout: (message) => {
                    stdout.push(message)
                },
                writeStderr: () => undefined,
                isInteractive: () => true,
                sleep: async () => undefined,
                now: () => Date.now(),
                openExternalUrl: () => {
                    openCount += 1
                    return true
                },
            }
        )

        expect(code).toBe(0)
        expect(openCount).toBe(0)
        expect(stdout.join('')).toContain(
            'Automatic browser open is disabled (CI).'
        )
        expect(stdout.join('')).toContain(
            'Open this URL to authenticate Opensteer CLI:'
        )
    })
})

describe('ensureCloudCredentialsForCommand', () => {
    it('fails with actionable guidance when credentials are missing in non-interactive mode', async () => {
        const store: CloudCredentialStore = createMemoryStore()
        await expect(
            ensureCloudCredentialsForCommand({
                commandName: 'opensteer profile list',
                env: {},
                store,
                interactive: false,
                autoLoginIfNeeded: false,
                fetchFn: fetch as AuthFetchFn,
            })
        ).rejects.toThrow(
            'opensteer profile list requires cloud authentication. Use --api-key, --access-token, OPENSTEER_API_KEY, OPENSTEER_ACCESS_TOKEN, or run "opensteer auth login".'
        )
    })

    it('auto-logins in interactive mode when no env/flag/saved credentials are present', async () => {
        const store: CloudCredentialStore = createMemoryStore()
        const env: Record<string, string | undefined> = {}
        let nowMs = 1_000
        const fetchMock = createFetchMock()

        const resolved = await ensureCloudCredentialsForCommand({
            commandName: 'opensteer profile list',
            env,
            store,
            interactive: true,
            autoLoginIfNeeded: true,
            siteUrl: 'https://opensteer.com',
            baseUrl: 'https://api.opensteer.com',
            fetchFn: fetchMock,
            sleep: async () => undefined,
            now: () => {
                nowMs += 1
                return nowMs
            },
            openExternalUrl: () => true,
            writeStdout: () => undefined,
            writeStderr: () => undefined,
        })

        expect(resolved).toEqual(
            expect.objectContaining({
                kind: 'access-token',
                authScheme: 'bearer',
                baseUrl: 'https://api.opensteer.com',
                siteUrl: 'https://opensteer.com',
            })
        )
        expect(env.OPENSTEER_ACCESS_TOKEN).toBe('ost_access_123')
        expect(env.OPENSTEER_AUTH_SCHEME).toBe('bearer')
    })
})
