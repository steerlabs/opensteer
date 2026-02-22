import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    loadConfigFile,
    resolveConfig,
    resolveModeSelection,
    resolveNamespace,
} from '../src/config.js'
import type { OpensteerConfig } from '../src/types.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('config', () => {
    it('loadConfigFile returns empty object when file is missing or malformed', () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ov-config-missing-')
        )
        expect(loadConfigFile(root)).toEqual({})

        const configDir = path.join(root, '.opensteer')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(path.join(configDir, 'config.json'), '{oops', 'utf8')

        expect(loadConfigFile(root)).toEqual({})
    })

    it('resolveConfig merges defaults, file config, env config, then explicit input', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-config-merge-'))
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

    it('resolveModeSelection defaults to local when unset', () => {
        const selection = resolveModeSelection({})
        expect(selection).toEqual({
            mode: 'local',
            source: 'default',
        })
    })

    it('resolveModeSelection uses OPENSTEER_MODE when mode is not set in config', () => {
        process.env.OPENSTEER_MODE = 'remote'
        const selection = resolveModeSelection({})
        expect(selection).toEqual({
            mode: 'remote',
            source: 'env.OPENSTEER_MODE',
        })
    })

    it('resolveModeSelection lets config.mode override OPENSTEER_MODE', () => {
        process.env.OPENSTEER_MODE = 'local'
        const selection = resolveModeSelection({
            mode: 'remote',
        })
        expect(selection).toEqual({
            mode: 'remote',
            source: 'config.mode',
        })
    })

    it('resolveConfig sets remote mode from OPENSTEER_MODE and uses OPENSTEER_REMOTE_API_KEY', () => {
        process.env.OPENSTEER_MODE = 'remote'
        process.env.OPENSTEER_REMOTE_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({})
        expect(resolved.remote).toEqual({
            apiKey: 'ork_env_123',
        })
    })

    it('throws when OPENSTEER_MODE has an invalid value', () => {
        process.env.OPENSTEER_MODE = 'edge'
        expect(() => resolveConfig({})).toThrow(
            'Invalid OPENSTEER_MODE value "edge". Use "local" or "remote".'
        )
    })

    it('throws when mode has an invalid value in .opensteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-config-mode-'))
        fs.mkdirSync(path.join(root, '.opensteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.opensteer', 'config.json'),
            JSON.stringify({ mode: 'edge' }),
            'utf8'
        )

        expect(() =>
            resolveConfig({
                storage: { rootDir: root },
            })
        ).toThrow('Invalid mode value "edge". Use "local" or "remote".')
    })

    it('throws when OPENSTEER_RUNTIME is set', () => {
        process.env.OPENSTEER_RUNTIME = 'remote'
        expect(() => resolveConfig({})).toThrow(
            'OPENSTEER_RUNTIME is no longer supported. Use OPENSTEER_MODE instead.'
        )
    })

    it('resolveConfig ignores OPENSTEER_REMOTE_API_KEY when remote mode is not enabled', () => {
        process.env.OPENSTEER_REMOTE_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({})
        expect(resolved.remote).toBeUndefined()
    })

    it('resolveConfig uses OPENSTEER_REMOTE_API_KEY when remote apiKey is missing', () => {
        process.env.OPENSTEER_REMOTE_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({
            mode: 'remote',
        })

        expect(resolved.remote).toEqual({
            apiKey: 'ork_env_123',
        })
    })

    it('resolveConfig keeps explicit remote.apiKey over OPENSTEER_REMOTE_API_KEY', () => {
        process.env.OPENSTEER_REMOTE_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({
            mode: 'remote',
            remote: {
                apiKey: 'ork_input_456',
            },
        })

        expect(
            typeof resolved.remote === 'object'
                ? resolved.remote?.apiKey
                : null
        ).toBe('ork_input_456')
    })

    it('resolveConfig preserves explicit empty remote.apiKey over OPENSTEER_REMOTE_API_KEY', () => {
        process.env.OPENSTEER_REMOTE_API_KEY = 'ork_env_123'

        const resolved = resolveConfig({
            mode: 'remote',
            remote: {
                apiKey: '   ',
            },
        })

        expect(
            typeof resolved.remote === 'object'
                ? resolved.remote?.apiKey
                : null
        ).toBe('   ')
    })

    it('throws when legacy boolean remote config is passed directly', () => {
        expect(() =>
            resolveConfig({
                remote: true as never,
            })
        ).toThrow(
            'Boolean "remote" config is no longer supported in Opensteer constructor config. Use "mode: \\"remote\\"" with "remote" options.'
        )
    })

    it('throws when legacy remote.key config is passed directly', () => {
        expect(() =>
            resolveConfig({
                remote: {
                    key: 'ork_legacy_123',
                } as never,
            })
        ).toThrow(
            'Legacy "remote.key" config is no longer supported in Opensteer constructor config. Use "remote.apiKey" instead.'
        )
    })

    it('throws when top-level apiKey config is passed directly', () => {
        expect(() =>
            resolveConfig({
                apiKey: 'ork_root_123',
            } as never)
        ).toThrow(
            'Top-level "apiKey" config is not supported in Opensteer constructor config. Use "remote.apiKey" instead.'
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
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-config-ai-'))
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

    it('throws when legacy mode config exists in .opensteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-config-legacy-'))
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
            'Boolean "remote" config is no longer supported in .opensteer/config.json. Use "mode: \\"remote\\"" with "remote" options.'
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
