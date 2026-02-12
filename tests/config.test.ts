import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    loadConfigFile,
    resolveConfig,
    resolveNamespace,
} from '../src/config.js'

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

        const resolved = resolveConfig({
            storage: { rootDir: root },
            browser: { slowMo: 450 },
        })

        expect(resolved.storage?.rootDir).toBe(root)
        expect(resolved.browser?.headless).toBe(false)
        expect(resolved.browser?.slowMo).toBe(450)
        expect(resolved.debug).toBe(true)
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
