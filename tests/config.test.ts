import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    loadConfigFile,
    resolveConfig,
    resolveNamespace,
    resolveRuntimeSelection,
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

    it('resolveRuntimeSelection defaults to local when unset', () => {
        const selection = resolveRuntimeSelection({})
        expect(selection).toEqual({
            mode: 'local',
            source: 'default',
        })
    })

    it('resolveRuntimeSelection uses OPENSTEER_RUNTIME when cloud is not forced', () => {
        process.env.OPENSTEER_RUNTIME = 'cloud'
        const selection = resolveRuntimeSelection({})
        expect(selection).toEqual({
            mode: 'cloud',
            source: 'env.OPENSTEER_RUNTIME',
        })
    })

    it('resolveRuntimeSelection lets cloud.enabled force cloud mode over OPENSTEER_RUNTIME', () => {
        process.env.OPENSTEER_RUNTIME = 'local'
        const selection = resolveRuntimeSelection({
            cloud: {
                enabled: true,
            },
        })
        expect(selection).toEqual({
            mode: 'cloud',
            source: 'config.cloud.enabled',
        })
    })

    it('resolveConfig sets cloud mode from OPENSTEER_RUNTIME and uses OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_RUNTIME = 'cloud'
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toEqual({
            enabled: true,
            key: 'osk_env_123',
        })
    })

    it('throws when OPENSTEER_RUNTIME is "auto"', () => {
        process.env.OPENSTEER_RUNTIME = 'auto'
        expect(() => resolveConfig({})).toThrow(
            'OPENSTEER_RUNTIME="auto" is not supported. Use "local" or "cloud".'
        )
    })

    it('throws when OPENSTEER_RUNTIME has an invalid value', () => {
        process.env.OPENSTEER_RUNTIME = 'edge'
        expect(() => resolveConfig({})).toThrow(
            'Invalid OPENSTEER_RUNTIME value "edge". Use "local" or "cloud".'
        )
    })

    it('resolveConfig ignores OPENSTEER_API_KEY when cloud mode is not enabled', () => {
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        const resolved = resolveConfig({})
        expect(resolved.cloud).toBeUndefined()
    })

    it('resolveConfig uses OPENSTEER_API_KEY when cloud.key is missing', () => {
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        const resolved = resolveConfig({
            cloud: {
                enabled: true,
            },
        })

        expect(resolved.cloud).toEqual({
            enabled: true,
            key: 'osk_env_123',
        })
    })

    it('resolveConfig keeps explicit cloud.key over OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        const resolved = resolveConfig({
            cloud: {
                enabled: true,
                key: 'osk_input_456',
            },
        })

        expect(resolved.cloud?.key).toBe('osk_input_456')
    })

    it('resolveConfig preserves explicit empty cloud.key over OPENSTEER_API_KEY', () => {
        process.env.OPENSTEER_API_KEY = 'osk_env_123'

        const resolved = resolveConfig({
            cloud: {
                enabled: true,
                key: '   ',
            },
        })

        expect(resolved.cloud?.key).toBe('   ')
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
