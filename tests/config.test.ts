import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    loadConfigFile,
    resolveConfig,
    resolveNamespace,
} from '../src/config.js'
import type { OversteerConfig } from '../src/types.js'

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

        const configDir = path.join(root, '.oversteer')
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(path.join(configDir, 'config.json'), '{oops', 'utf8')

        expect(loadConfigFile(root)).toEqual({})
    })

    it('resolveConfig merges defaults, file config, env config, then explicit input', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-config-merge-'))
        fs.mkdirSync(path.join(root, '.oversteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.oversteer', 'config.json'),
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

        process.env.OVERSTEER_HEADLESS = 'false'
        process.env.OVERSTEER_SLOW_MO = '250'
        process.env.OVERSTEER_DEBUG = 'true'
        process.env.OVERSTEER_MODEL = 'gemini-2.0-flash'

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

    it('resolveConfig uses OVERSTEER_MODEL when explicit model is missing', () => {
        process.env.OVERSTEER_MODEL = 'gpt-5-mini'
        const resolved = resolveConfig({})
        expect(resolved.model).toBe('gpt-5-mini')
    })

    it('throws when legacy ai config is passed directly', () => {
        const legacyConfig: OversteerConfig = {
            storage: { rootDir: process.cwd() },
            // @ts-expect-error - validates hard rejection of removed legacy config.
            ai: { model: 'gpt-5-mini' },
        }

        expect(() => resolveConfig(legacyConfig)).toThrow(
            'Legacy "ai" config is no longer supported in Oversteer constructor config. Use top-level "model" instead.'
        )
    })

    it('throws when legacy ai config exists in .oversteer/config.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-config-ai-'))
        fs.mkdirSync(path.join(root, '.oversteer'), { recursive: true })
        fs.writeFileSync(
            path.join(root, '.oversteer', 'config.json'),
            JSON.stringify({ ai: { model: 'gpt-5-mini' } }),
            'utf8'
        )

        expect(() =>
            resolveConfig({
                storage: { rootDir: root },
            })
        ).toThrow(
            'Legacy "ai" config is no longer supported in .oversteer/config.json. Use top-level "model" instead.'
        )
    })

    it('throws when OVERSTEER_AI_MODEL is set', () => {
        process.env.OVERSTEER_AI_MODEL = 'gpt-5-mini'
        expect(() => resolveConfig({})).toThrow(
            'OVERSTEER_AI_MODEL is no longer supported. Use OVERSTEER_MODEL instead.'
        )
    })

    it('resolveNamespace prefers explicit name', () => {
        const namespace = resolveNamespace(
            { name: '  my-suite  ' },
            process.cwd()
        )
        expect(namespace).toBe('my-suite')
    })

    it('resolveNamespace falls back to caller-derived value when no name is set', () => {
        const namespace = resolveNamespace({}, process.cwd())
        expect(namespace.length).toBeGreaterThan(0)
    })
})
