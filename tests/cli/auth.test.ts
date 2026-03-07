import { describe, expect, it } from 'vitest'
import {
    ensureCloudCredentialsForCommand,
    ensureCloudCredentialsForOpenCommand,
    parseOpensteerAuthArgs,
    runOpensteerAuthCli,
    type AuthFetchFn,
    type CloudCredentialStore,
} from '../../src/cli/auth.js'

interface StoredCredential {
    baseUrl: string
    scope: string[]
    accessToken: string
    refreshToken: string
    obtainedAt: number
    expiresAt: number
}

function createMemoryStore() {
    const saved = new Map<string, StoredCredential>()
    let activeTarget: { baseUrl: string } | null = null

    return {
        readCloudCredential: (target: { baseUrl: string }) =>
            saved.get(target.baseUrl) ?? null,
        writeCloudCredential: (value: StoredCredential) => {
            saved.set(value.baseUrl, value)
        },
        clearCloudCredential: (target: { baseUrl: string }) => {
            saved.delete(target.baseUrl)
        },
        readActiveCloudTarget: () => activeTarget,
        writeActiveCloudTarget: (target: { baseUrl: string }) => {
            activeTarget = {
                baseUrl: target.baseUrl,
            }
        },
    }
}

function createFetchMock(options: { authSiteUrl?: string } = {}): AuthFetchFn {
    const authSiteUrl = options.authSiteUrl ?? 'https://opensteer.com'

    return async (input: string): Promise<Response> => {
        const url = String(input)
        if (url === `${authSiteUrl}/api/cli-auth/device/start`) {
            return new Response(
                JSON.stringify({
                    device_code: 'device_123',
                    user_code: 'ABCD-1234',
                    verification_uri: `${authSiteUrl}/cli/auth/device`,
                    verification_uri_complete:
                        `${authSiteUrl}/cli/auth/device?user_code=ABCD-1234`,
                    expires_in: 600,
                    interval: 1,
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            )
        }
        if (url === `${authSiteUrl}/api/cli-auth/device/token`) {
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
        if (url === `${authSiteUrl}/api/cli-auth/token`) {
            return new Response(
                JSON.stringify({
                    access_token: 'ost_refreshed_access',
                    token_type: 'Bearer',
                    expires_in: 900,
                    refresh_token: 'ost_refreshed_refresh',
                    scope: 'cloud:browser',
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }
            )
        }
        if (url === `${authSiteUrl}/api/cli-auth/revoke`) {
            return new Response(JSON.stringify({ revoked: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
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

    it('rejects the removed --site-url option', () => {
        expect(parseOpensteerAuthArgs(['login', '--site-url', 'https://opensteer.com']))
            .toEqual({
                mode: 'error',
                error: 'Unsupported option "--site-url".',
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
        expect(JSON.parse(stdout.join(''))).toEqual({
            loggedIn: false,
            baseUrl: 'https://api.opensteer.com',
        })
    })

    it('ignores an invalid remembered cloud target and falls back to the default host', async () => {
        const stdout: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        store.writeActiveCloudTarget({
            baseUrl: 'not a url',
        })

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
        expect(JSON.parse(stdout.join(''))).toEqual({
            loggedIn: false,
            baseUrl: 'https://api.opensteer.com',
        })
    })

    it('runs login flow and persists machine credentials', async () => {
        const stdout: string[] = []
        const stderr: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        const fetchMock = createFetchMock()

        const code = await runOpensteerAuthCli(
            ['login', '--base-url', 'https://api.opensteer.com', '--no-browser', '--json'],
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
            })
        )
        expect(stdout).toHaveLength(1)
        expect(stderr.join('')).toContain(
            'Automatic browser open is disabled (--no-browser).'
        )
        expect(stderr.join('')).toContain('Open this URL to authenticate Opensteer CLI:')
        expect(
            store.readCloudCredential({
                baseUrl: 'https://api.opensteer.com',
            })
        ).toEqual(
            expect.objectContaining({
                accessToken: 'ost_access_123',
                refreshToken: 'ost_refresh_123',
            })
        )
    })

    it('keeps human login success output concise', async () => {
        const stdout: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        const fetchMock = createFetchMock()

        const code = await runOpensteerAuthCli(
            ['login', '--base-url', 'https://api.opensteer.com', '--no-browser'],
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
                openExternalUrl: () => true,
            }
        )

        expect(code).toBe(0)
        const output = stdout.join('')
        expect(output).toContain('Opensteer CLI login successful.')
        expect(output).not.toContain('API Base URL:')
        expect(output).not.toContain('Expires At:')
    })

    it('reuses the last selected cloud target for auth status when no host is provided', async () => {
        const store: CloudCredentialStore = createMemoryStore()
        const fetchMock = createFetchMock()
        const loginCode = await runOpensteerAuthCli(
            ['login', '--base-url', 'http://localhost:8080', '--no-browser', '--json'],
            {
                env: {},
                store,
                fetchFn: fetchMock,
                writeStdout: () => undefined,
                writeStderr: () => undefined,
                isInteractive: () => true,
                sleep: async () => undefined,
                now: () => Date.now(),
                openExternalUrl: () => true,
            }
        )

        const stdout: string[] = []
        const statusCode = await runOpensteerAuthCli(['status', '--json'], {
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

        expect(loginCode).toBe(0)
        expect(statusCode).toBe(0)
        expect(JSON.parse(stdout.join(''))).toEqual(
            expect.objectContaining({
                loggedIn: true,
                baseUrl: 'http://localhost:8080',
            })
        )
    })

    it('defaults auth login to the production host when no host is provided', async () => {
        const stdout: string[] = []
        const stderr: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        store.writeActiveCloudTarget({
            baseUrl: 'http://localhost:8080',
        })

        const code = await runOpensteerAuthCli(['login', '--no-browser', '--json'], {
            env: {},
            store,
            fetchFn: createFetchMock(),
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
        })

        expect(code).toBe(0)
        expect(stderr.join('')).toContain(
            'https://opensteer.com/cli/auth/device?user_code=ABCD-1234'
        )
        expect(JSON.parse(stdout[stdout.length - 1] || '{}')).toEqual(
            expect.objectContaining({
                loggedIn: true,
                baseUrl: 'https://api.opensteer.com',
            })
        )
        expect(
            store.readCloudCredential({
                baseUrl: 'https://api.opensteer.com',
            })
        ).toEqual(
            expect.objectContaining({
                accessToken: 'ost_access_123',
                refreshToken: 'ost_refresh_123',
            })
        )
    })

    it('supports an internal auth-site override for local testing', async () => {
        const stderr: string[] = []
        const code = await runOpensteerAuthCli(['login', '--no-browser', '--json'], {
            env: {
                OPENSTEER_INTERNAL_AUTH_SITE_URL: 'http://localhost:3001',
            },
            store: createMemoryStore(),
            fetchFn: createFetchMock({
                authSiteUrl: 'http://localhost:3001',
            }),
            writeStdout: () => undefined,
            writeStderr: (message) => {
                stderr.push(message)
            },
            isInteractive: () => true,
            sleep: async () => undefined,
            now: () => Date.now(),
            openExternalUrl: () => true,
        })

        expect(code).toBe(0)
        expect(stderr.join('')).toContain(
            'http://localhost:3001/cli/auth/device?user_code=ABCD-1234'
        )
    })

    it('opens the default browser during login when auto-open succeeds', async () => {
        const stdout: string[] = []
        const fetchMock = createFetchMock()
        const store: CloudCredentialStore = createMemoryStore()
        const openedUrls: string[] = []

        const code = await runOpensteerAuthCli(
            ['login', '--base-url', 'https://api.opensteer.com'],
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
            ['login', '--base-url', 'https://api.opensteer.com'],
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
            ['login', '--base-url', 'https://api.opensteer.com'],
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
            })
        )
        expect(env.OPENSTEER_ACCESS_TOKEN).toBe('ost_access_123')
        expect(env.OPENSTEER_AUTH_SCHEME).toBe('bearer')
        expect(env.OPENSTEER_BASE_URL).toBe('https://api.opensteer.com')
        expect(env.OPENSTEER_CLOUD_SITE_URL).toBeUndefined()
    })

    it('does not reuse a saved credential from a different cloud host', async () => {
        const store: CloudCredentialStore = createMemoryStore()
        store.writeCloudCredential({
            baseUrl: 'https://api.opensteer.com',
            scope: ['cloud:browser'],
            accessToken: 'ost_saved_prod',
            refreshToken: 'rt_saved_prod',
            obtainedAt: 1,
            expiresAt: Date.now() + 60_000,
        })

        await expect(
            ensureCloudCredentialsForCommand({
                commandName: 'opensteer profile list',
                env: {},
                store,
                interactive: false,
                autoLoginIfNeeded: false,
                baseUrl: 'https://api.staging.example',
                fetchFn: fetch as AuthFetchFn,
            })
        ).rejects.toThrow(
            'opensteer profile list requires cloud authentication. Use --api-key, --access-token, OPENSTEER_API_KEY, OPENSTEER_ACCESS_TOKEN, or run "opensteer auth login".'
        )
    })

    it('reuses the active cloud target for saved credentials when no host is specified', async () => {
        const store: CloudCredentialStore = createMemoryStore()
        store.writeCloudCredential({
            baseUrl: 'http://localhost:8080',
            scope: ['cloud:browser'],
            accessToken: 'ost_saved_local',
            refreshToken: 'rt_saved_local',
            obtainedAt: 1,
            expiresAt: Date.now() + 5 * 60_000,
        })
        store.writeActiveCloudTarget({
            baseUrl: 'http://localhost:8080',
        })

        const env: Record<string, string | undefined> = {}
        const resolved = await ensureCloudCredentialsForCommand({
            commandName: 'opensteer profile list',
            env,
            store,
            interactive: false,
            autoLoginIfNeeded: false,
            fetchFn: fetch as AuthFetchFn,
            writeStdout: () => undefined,
            writeStderr: () => undefined,
        })

        expect(resolved).toEqual(
            expect.objectContaining({
                source: 'saved',
                token: 'ost_saved_local',
                baseUrl: 'http://localhost:8080',
            })
        )
        expect(env.OPENSTEER_BASE_URL).toBe('http://localhost:8080')
    })
})

describe('ensureCloudCredentialsForOpenCommand', () => {
    it('defaults interactive auto-login prompts to stderr', async () => {
        const stderr: string[] = []
        const store: CloudCredentialStore = createMemoryStore()
        const env: Record<string, string | undefined> = {
            OPENSTEER_MODE: 'cloud',
            OPENSTEER_DISABLE_DOTENV_AUTOLOAD: '1',
        }
        let nowMs = 1_000

        const resolved = await ensureCloudCredentialsForOpenCommand({
            scopeDir: process.cwd(),
            env,
            store,
            interactive: true,
            fetchFn: createFetchMock(),
            sleep: async () => undefined,
            now: () => {
                nowMs += 1
                return nowMs
            },
            openExternalUrl: () => true,
            writeStderr: (message) => {
                stderr.push(message)
            },
        })

        expect(resolved).toEqual(
            expect.objectContaining({
                kind: 'access-token',
                authScheme: 'bearer',
                baseUrl: 'https://api.opensteer.com',
            })
        )
        expect(stderr.join('')).toContain(
            'Opening your default browser for Opensteer CLI authentication.'
        )
        expect(stderr.join('')).toContain('Cloud login complete.')
    })
})
