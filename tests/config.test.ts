import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    loadConfigFile,
    resolveCloudSelection,
    resolveConfig,
    resolveNamespace,
} from '../src/config.js'
import type { OpensteerConfig } from '../src/types.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('config', () => {
    it('loadConfigFile returns empty object when file is missing or malformed', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'opensteer-config-missing-')
        )
        expect(loadConfigFile(root)).toEqual({})

        const configDir = path.join(root, '.opensteer')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(path.join(configDir, 'config.json'), '{oops', 'utf8')

        expect(loadConfigFile(root)).toEqual({})
        expect(warnSpy).not.toHaveBeenCalled()
        warnSpy.mockRestore()
    })

    it('loadConfigFile logs malformed files only when debug is enabled', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-debug-'))
        const configDir = path.join(root, '.opensteer')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(path.join(configDir, 'config.json'), '{oops', 'utf8')

        expect(loadConfigFile(root, { debug: true })).toEqual({})
        expect(warnSpy).toHaveBeenCalledTimes(1)
        warnSpy.mockRestore()
    })

    it('resolveConfig lets explicit debug=false override OPENSTEER_DEBUG during startup loading', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'opensteer-config-explicit-debug-')
        )
        const configDir = path.join(root, '.opensteer')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(path.join(configDir, 'config.json'), '{oops', 'utf8')
        process.env.OPENSTEER_DEBUG = '1'

        const resolved = resolveConfig({
            debug: false,
            storage: { rootDir: root },
        })

        expect(resolved.debug).toBe(false)
        expect(warnSpy).not.toHaveBeenCalled()
        warnSpy.mockRestore()
    })

    it('resolveConfig merges defaults, file config, env config, then explicit input', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-merge-'))
        fs.mkdirSync(path.join(root, '.opensteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.opensteer', 'config.json'),
            JSON.stringify(
                {
                    browser: { headless: true, slowMo: 111 },
                    model: 'claude-3-5-sonnet',
                    debug: false,
                },
                null,
                2
            ),
            'utf8'
        )

        process.env.OPENSTEER_HEADLESS = 'false'
        process.env.OPENSTEER_SLOW_MO = '250'
        process.env.OPENSTEER_DEBUG = 'true'
        process.env.OPENSTEER_MODEL = 'gemini-2.0-flash'

        const resolved = resolveConfig({
            storage: { rootDir: root },
            browser: { slowMo: 450 },
            model: 'gpt-5.1',
        })

        expect(resolved.storage?.rootDir).toBe(root)
        expect(resolved.browser?.headless).toBe(false)
        expect(resolved.browser?.slowMo).toBe(450)
        expect(resolved.model).toBe('gpt-5.1')
        expect(resolved.debug).toBe(true)
    })

    it('resolveConfig defaults model to gpt-5.1', () => {
        const resolved = resolveConfig()
        expect(resolved.model).toBe('gpt-5.1')
    })

    it('resolveConfig uses OPENSTEER_MODEL when explicit model is missing', () => {
        process.env.OPENSTEER_MODEL = 'gpt-5-mini'
        const resolved = resolveConfig({})
        expect(resolved.model).toBe('gpt-5-mini')
    })

    it('resolveConfig maps OPENSTEER_CURSOR into cursor.enabled', () => {
        process.env.OPENSTEER_CURSOR = 'true'
        const resolved = resolveConfig({})
        expect(resolved.cursor?.enabled).toBe(true)
    })

    it('resolveConfig lets explicit cursor config override OPENSTEER_CURSOR', () => {
        process.env.OPENSTEER_CURSOR = 'true'
        const resolved = resolveConfig({
            cursor: {
                enabled: false,
            },
        })
        expect(resolved.cursor?.enabled).toBe(false)
    })

    it('resolveCloudSelection defaults to local runtime when unset', () => {
        const selection = resolveCloudSelection({})
        expect(selection).toEqual({
            cloud: false,
            source: 'default',
        })
    })

    it('resolveCloudSelection maps OPENSTEER_MODE=cloud to cloud mode', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        const selection = resolveCloudSelection({})
        expect(selection).toEqual({
            cloud: true,
            source: 'env.OPENSTEER_MODE',
        })
    })

    it('resolveCloudSelection maps OPENSTEER_MODE=local to local runtime', () => {
        process.env.OPENSTEER_MODE = 'local'
        const selection = resolveCloudSelection({})
        expect(selection).toEqual({
            cloud: false,
            source: 'env.OPENSTEER_MODE',
        })
    })

    it('resolveCloudSelection lets config.cloud override OPENSTEER_MODE', () => {
        process.env.OPENSTEER_MODE = 'local'
        const selection = resolveCloudSelection({
            cloud: true,
        })
        expect(selection).toEqual({
            cloud: true,
            source: 'config.cloud',
        })
    })

    it('resolveCloudSelection supports explicit cloud disable overrides', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        const selection = resolveCloudSelection({
            cloud: false,
        })
        expect(selection).toEqual({
            cloud: false,
            source: 'config.cloud',
        })
    })

    it('resolveCloudSelection ignores invalid OPENSTEER_MODE when config.cloud is set', () => {
        process.env.OPENSTEER_MODE = 'edge'
        const selection = resolveCloudSelection({
            cloud: { apiKey: 'ork_test_123' },
        })
        expect(selection).toEqual({
            cloud: true,
            source: 'config.cloud',
        })
    })

    it('resolveConfig auto-loads OPENSTEER cloud env from .env in storage.rootDir', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(
            path.join(root, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_env_file_123'].join(
                '\n'
            ),
            'utf8'
        )

        const resolved = resolveConfig({
            storage: { rootDir: root },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_env_file_123',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig maps OPENSTEER_ACCESS_TOKEN to cloud accessToken', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_ACCESS_TOKEN = 'ost_env_token_123'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toEqual({
            accessToken: 'ost_env_token_123',
            authScheme: 'bearer',
            announce: 'always',
        })
    })

    it('resolveConfig replaces file cloud.apiKey with OPENSTEER_ACCESS_TOKEN cleanly', () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'opensteer-config-token-overrides-file-key-')
        )
        const configDir = path.join(root, '.opensteer')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(
            path.join(configDir, 'config.json'),
            JSON.stringify(
                {
                    cloud: {
                        apiKey: 'ork_file_123',
                    },
                },
                null,
                2
            ),
            'utf8'
        )
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_ACCESS_TOKEN = 'ost_env_token_456'

        const resolved = resolveConfig({
            storage: { rootDir: root },
        })
        expect(resolved.cloud).toEqual({
            accessToken: 'ost_env_token_456',
            authScheme: 'bearer',
            announce: 'always',
        })
    })

    it('resolveConfig keeps bearer compatibility with OPENSTEER_AUTH_SCHEME=bearer + OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_AUTH_SCHEME = 'bearer'
        process.env.OPENSTEER_API_KEY = 'legacy_bearer_token_123'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toEqual({
            accessToken: 'legacy_bearer_token_123',
            authScheme: 'bearer',
            announce: 'always',
        })
    })

    it('resolveConfig rejects OPENSTEER_API_KEY + OPENSTEER_ACCESS_TOKEN together', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_API_KEY = 'ork_123'
        process.env.OPENSTEER_ACCESS_TOKEN = 'ost_123'

        expect(() => resolveConfig({})).toThrow(
            'OPENSTEER_API_KEY and OPENSTEER_ACCESS_TOKEN are mutually exclusive. Set only one.'
        )
    })

    it('resolveConfig rejects cloud.apiKey + cloud.accessToken together', () => {
        expect(() =>
            resolveConfig({
                cloud: {
                    apiKey: 'ork_123',
                    accessToken: 'ost_123',
                },
            })
        ).toThrow(
            'cloud.apiKey and cloud.accessToken are mutually exclusive. Set only one.'
        )
    })

    it('resolveConfig auto-loads OPENSTEER_BASE_URL from .env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(
            path.join(root, '.env'),
            [
                'OPENSTEER_MODE=cloud',
                'OPENSTEER_API_KEY=ork_env_file_123',
                'OPENSTEER_BASE_URL=https://remote.env.example',
            ].join('\n'),
            'utf8'
        )

        const resolved = resolveConfig({
            storage: { rootDir: root },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_env_file_123',
            baseUrl: 'https://remote.env.example',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig keeps existing process env values over .env values', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(
            path.join(root, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_env_file_123'].join(
                '\n'
            ),
            'utf8'
        )
        process.env.OPENSTEER_API_KEY = 'ork_process_456'

        const resolved = resolveConfig({
            storage: { rootDir: root },
        })

        expect(
            typeof resolved.cloud === 'object'
                ? resolved.cloud?.apiKey
                : null
        ).toBe('ork_process_456')
    })

    it('resolveConfig keeps explicit cloud baseUrl over env values', () => {
        process.env.OPENSTEER_BASE_URL = 'https://remote.env.example'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_input_123',
                baseUrl: 'https://remote.input.example',
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_input_123',
            baseUrl: 'https://remote.input.example',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig uses dotenv precedence from most-specific to least-specific', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(path.join(root, '.env'), 'OPENSTEER_API_KEY=ork_env', 'utf8')
        fs.writeFileSync(
            path.join(root, '.env.development'),
            'OPENSTEER_API_KEY=ork_env_mode',
            'utf8'
        )
        fs.writeFileSync(
            path.join(root, '.env.local'),
            'OPENSTEER_API_KEY=ork_local',
            'utf8'
        )
        fs.writeFileSync(
            path.join(root, '.env.development.local'),
            'OPENSTEER_API_KEY=ork_mode_local',
            'utf8'
        )
        process.env.NODE_ENV = 'development'

        const resolved = resolveConfig({
            storage: { rootDir: root },
            cloud: true,
        })

        expect(
            typeof resolved.cloud === 'object'
                ? resolved.cloud?.apiKey
                : null
        ).toBe('ork_mode_local')
    })

    it('resolveConfig does not load .env.local when NODE_ENV=test', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(
            path.join(root, '.env.local'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_local_only'].join('\n'),
            'utf8'
        )
        process.env.NODE_ENV = 'test'

        const resolved = resolveConfig({
            storage: { rootDir: root },
        })

        expect(resolved.cloud).toBeUndefined()
    })

    it('resolveConfig can disable dotenv auto-load explicitly', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(
            path.join(root, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_env_file_123'].join(
                '\n'
            ),
            'utf8'
        )
        process.env.OPENSTEER_DISABLE_DOTENV_AUTOLOAD = 'true'

        const resolved = resolveConfig({
            storage: { rootDir: root },
        })

        expect(resolved.cloud).toBeUndefined()
    })

    it('resolveConfig keeps dotenv values scoped to each storage.rootDir', () => {
        const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-a-'))
        const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-b-'))

        fs.writeFileSync(
            path.join(rootA, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_env_a'].join('\n'),
            'utf8'
        )
        fs.writeFileSync(
            path.join(rootB, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_env_b'].join('\n'),
            'utf8'
        )

        const first = resolveConfig({
            storage: { rootDir: rootA },
        })
        const second = resolveConfig({
            storage: { rootDir: rootB },
        })

        expect(
            typeof first.cloud === 'object'
                ? first.cloud?.apiKey
                : null
        ).toBe('ork_env_a')
        expect(
            typeof second.cloud === 'object'
                ? second.cloud?.apiKey
                : null
        ).toBe('ork_env_b')
    })

    it('resolveConfig does not mutate process.env when loading dotenv files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        fs.writeFileSync(
            path.join(root, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_env_file_123'].join(
                '\n'
            ),
            'utf8'
        )
        delete process.env.OPENSTEER_MODE
        delete process.env.OPENSTEER_API_KEY

        resolveConfig({
            storage: { rootDir: root },
        })

        expect(process.env.OPENSTEER_MODE).toBeUndefined()
        expect(process.env.OPENSTEER_API_KEY).toBeUndefined()
    })

    it('resolveConfig loads dotenv from storage.rootDir set in .opensteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-dotenv-'))
        const effectiveRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'opensteer-config-dotenv-effective-')
        )
        fs.mkdirSync(path.join(root, '.opensteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.opensteer', 'config.json'),
            JSON.stringify(
                {
                    storage: {
                        rootDir: effectiveRoot,
                    },
                },
                null,
                2
            ),
            'utf8'
        )
        fs.writeFileSync(
            path.join(effectiveRoot, '.env'),
            ['OPENSTEER_MODE=cloud', 'OPENSTEER_API_KEY=ork_effective_123'].join(
                '\n'
            ),
            'utf8'
        )

        const originalCwd = process.cwd()
        let resolved: ReturnType<typeof resolveConfig>
        try {
            process.chdir(root)
            resolved = resolveConfig({})
        } finally {
            process.chdir(originalCwd)
        }

        expect(resolved.storage?.rootDir).toBe(effectiveRoot)
        expect(
            typeof resolved.cloud === 'object'
                ? resolved.cloud?.apiKey
                : null
        ).toBe('ork_effective_123')
    })

    it('resolveConfig sets cloud config from OPENSTEER_MODE and OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toEqual({
            apiKey: 'ork_env_123',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig defaults cloud authScheme to api-key when cloud is enabled', () => {
        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig uses OPENSTEER_AUTH_SCHEME when cloud authScheme is not set', () => {
        process.env.OPENSTEER_AUTH_SCHEME = 'bearer'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'bearer',
            announce: 'always',
        })
    })

    it('resolveConfig keeps explicit cloud.authScheme over OPENSTEER_AUTH_SCHEME', () => {
        process.env.OPENSTEER_AUTH_SCHEME = 'api-key'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_test_123',
                authScheme: 'bearer',
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'bearer',
            announce: 'always',
        })
    })

    it('resolveConfig uses OPENSTEER_REMOTE_ANNOUNCE when cloud.announce is not set', () => {
        process.env.OPENSTEER_REMOTE_ANNOUNCE = 'tty'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_test_123',
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'api-key',
            announce: 'tty',
        })
    })

    it('resolveConfig keeps explicit cloud.announce over OPENSTEER_REMOTE_ANNOUNCE', () => {
        process.env.OPENSTEER_REMOTE_ANNOUNCE = 'off'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_test_123',
                announce: 'always',
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig maps OPENSTEER_CLOUD_PROFILE_ID into cloud.browserProfile', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_API_KEY = 'ork_test_123'
        process.env.OPENSTEER_CLOUD_PROFILE_ID = 'bp_env_123'
        process.env.OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE = 'true'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'api-key',
            announce: 'always',
            browserProfile: {
                profileId: 'bp_env_123',
                reuseIfActive: true,
            },
        })
    })

    it('resolveConfig keeps explicit cloud.browserProfile over env profile settings', () => {
        process.env.OPENSTEER_CLOUD_PROFILE_ID = 'bp_env_123'
        process.env.OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE = 'true'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_test_123',
                browserProfile: {
                    profileId: 'bp_config_456',
                    reuseIfActive: false,
                },
            },
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_test_123',
            authScheme: 'api-key',
            announce: 'always',
            browserProfile: {
                profileId: 'bp_config_456',
                reuseIfActive: false,
            },
        })
    })

    it('throws when OPENSTEER_MODE has an invalid value', () => {
        process.env.OPENSTEER_MODE = 'edge'
        expect(() => resolveConfig({})).toThrow(
            'Invalid OPENSTEER_MODE value "edge". Use "local" or "cloud".'
        )
    })

    it('throws when OPENSTEER_AUTH_SCHEME has an invalid value', () => {
        process.env.OPENSTEER_AUTH_SCHEME = 'token'
        expect(() => resolveConfig({})).toThrow(
            'Invalid OPENSTEER_AUTH_SCHEME value "token". Use "api-key" or "bearer".'
        )
    })

    it('throws when OPENSTEER_REMOTE_ANNOUNCE has an invalid value', () => {
        process.env.OPENSTEER_REMOTE_ANNOUNCE = 'sometimes'
        expect(() => resolveConfig({ cloud: true })).toThrow(
            'Invalid OPENSTEER_REMOTE_ANNOUNCE value "sometimes". Use "always", "off", or "tty".'
        )
    })

    it('throws when OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE is set without OPENSTEER_CLOUD_PROFILE_ID', () => {
        process.env.OPENSTEER_MODE = 'cloud'
        process.env.OPENSTEER_API_KEY = 'ork_test_123'
        process.env.OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE = 'true'

        expect(() => resolveConfig({})).toThrow(
            'OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE requires OPENSTEER_CLOUD_PROFILE_ID.'
        )
    })

    it('throws when cloud.browserProfile.profileId is missing', () => {
        expect(() =>
            resolveConfig({
                cloud: {
                    apiKey: 'ork_test_123',
                    browserProfile: {
                        profileId: '',
                    },
                },
            })
        ).toThrow(
            'cloud.browserProfile.profileId must be a non-empty string when browserProfile is provided.'
        )
    })

    it('throws when cloud has an invalid value in .opensteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-cloud-'))
        fs.mkdirSync(path.join(root, '.opensteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.opensteer', 'config.json'),
            JSON.stringify({ cloud: 'enabled' }),
            'utf8'
        )

        expect(() =>
            resolveConfig({
                storage: { rootDir: root },
            })
        ).toThrow(
            'Invalid cloud value "enabled". Use true, false, or a cloud options object.'
        )
    })

    it('throws when OPENSTEER_RUNTIME is set', () => {
        process.env.OPENSTEER_RUNTIME = 'remote'
        expect(() => resolveConfig({})).toThrow(
            'OPENSTEER_RUNTIME is no longer supported. Use OPENSTEER_MODE instead.'
        )
    })

    it('resolveConfig ignores OPENSTEER_API_KEY when cloud mode is not enabled', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toBeUndefined()
    })

    it('resolveConfig uses OPENSTEER_API_KEY when cloud apiKey is missing', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({
            cloud: true,
        })

        expect(resolved.cloud).toEqual({
            apiKey: 'ork_env_123',
            authScheme: 'api-key',
            announce: 'always',
        })
    })

    it('resolveConfig keeps explicit cloud.apiKey over OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({
            cloud: {
                apiKey: 'ork_input_456',
            },
        })

        expect(
            typeof resolved.cloud === 'object'
                ? resolved.cloud?.apiKey
                : null
        ).toBe('ork_input_456')
    })

    it('resolveConfig preserves explicit empty cloud.apiKey over OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({
            cloud: {
                apiKey: '   ',
            },
        })

        expect(
            typeof resolved.cloud === 'object'
                ? resolved.cloud?.apiKey
                : null
        ).toBe('   ')
    })

    it('throws when legacy mode config is passed directly', () => {
        const legacyConfig: OpensteerConfig = {
            // @ts-expect-error - validates rejection of unsupported legacy mode config.
            mode: 'local',
        }

        expect(() =>
            resolveConfig(legacyConfig)
        ).toThrow(
            'Top-level "mode" config is no longer supported in Opensteer constructor config. Use "cloud: true" to enable cloud mode.'
        )
    })

    it('throws when legacy remote config is passed directly', () => {
        const legacyConfig: OpensteerConfig = {
            // @ts-expect-error - validates rejection of unsupported legacy remote config.
            remote: {
                apiKey: 'ork_legacy_123',
            },
        }

        expect(() =>
            resolveConfig(legacyConfig)
        ).toThrow(
            'Top-level "remote" config is no longer supported in Opensteer constructor config. Use "cloud" options instead.'
        )
    })

    it('throws when top-level apiKey config is passed directly', () => {
        const legacyConfig: OpensteerConfig = {
            // @ts-expect-error - validates rejection of unsupported top-level apiKey config.
            apiKey: 'ork_root_123',
        }

        expect(() =>
            resolveConfig(legacyConfig)
        ).toThrow(
            'Top-level "apiKey" config is not supported in Opensteer constructor config. Use "cloud.apiKey" instead.'
        )
    })

    it('throws when legacy ai config is passed directly', () => {
        const legacyConfig: OpensteerConfig = {
            storage: { rootDir: process.cwd() },
            // @ts-expect-error - validates hard rejection of removed legacy config.
            ai: { model: 'gpt-5-mini' },
        }

        expect(() => resolveConfig(legacyConfig)).toThrow(
            'Legacy "ai" config is no longer supported in Opensteer constructor config. Use top-level "model" instead.'
        )
    })

    it('throws when legacy ai config exists in .opensteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-ai-'))
        fs.mkdirSync(path.join(root, '.opensteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.opensteer', 'config.json'),
            JSON.stringify({ ai: { model: 'gpt-5-mini' } }),
            'utf8'
        )

        expect(() =>
            resolveConfig({
                storage: { rootDir: root },
            })
        ).toThrow(
            'Legacy "ai" config is no longer supported in .opensteer/config.json. Use top-level "model" instead.'
        )
    })

    it('throws when OPENSTEER_AI_MODEL is set', () => {
        process.env.OPENSTEER_AI_MODEL = 'gpt-5-mini'
        expect(() => resolveConfig({})).toThrow(
            'OPENSTEER_AI_MODEL is no longer supported. Use OPENSTEER_MODEL instead.'
        )
    })

    it('throws when legacy remote config exists in .opensteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-config-legacy-'))
        fs.mkdirSync(path.join(root, '.opensteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.opensteer', 'config.json'),
            JSON.stringify({ remote: true }),
            'utf8'
        )

        expect(() =>
            resolveConfig({
                storage: { rootDir: root },
            })
        ).toThrow(
            'Top-level "remote" config is no longer supported in .opensteer/config.json. Use "cloud" options instead.'
        )
    })

    it('resolveNamespace prefers explicit name', () => {
        const namespace = resolveNamespace(
            { name: '  my-suite  ' },
            process.cwd()
        )
        expect(namespace).toBe('my-suite')
    })

    it('resolveNamespace keeps safe hierarchy and strips traversal segments', () => {
        const nested = resolveNamespace(
            { name: '  team-a/run-1  ' },
            process.cwd()
        )
        expect(nested).toBe('team-a/run-1')

        const sanitized = resolveNamespace(
            { name: '../../escape' },
            process.cwd()
        )
        expect(sanitized).toBe('escape')
    })

    it('resolveNamespace falls back to caller-derived value when no name is set', () => {
        const namespace = resolveNamespace({}, process.cwd())
        expect(namespace.length).toBeGreaterThan(0)
    })
})
