import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Opensteer } from '../../src/opensteer.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('agent env resolution', () => {
    it('loads OPENAI_API_KEY from .env in storage.rootDir', () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-agent-env-'))
        fs.writeFileSync(path.join(rootDir, '.env'), 'OPENAI_API_KEY=sk-dotenv', 'utf8')

        delete process.env.OPENAI_API_KEY
        delete process.env.OPENSTEER_DISABLE_DOTENV_AUTOLOAD

        const opensteer = new Opensteer({
            storage: { rootDir },
        })

        expect(() =>
            opensteer.agent({
                mode: 'cua',
                model: 'openai/computer-use-preview',
            })
        ).not.toThrow()
    })

    it('respects OPENSTEER_DISABLE_DOTENV_AUTOLOAD for provider keys', () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-agent-env-'))
        fs.writeFileSync(path.join(rootDir, '.env'), 'OPENAI_API_KEY=sk-dotenv', 'utf8')

        delete process.env.OPENAI_API_KEY
        process.env.OPENSTEER_DISABLE_DOTENV_AUTOLOAD = 'true'

        const opensteer = new Opensteer({
            storage: { rootDir },
        })

        expect(() =>
            opensteer.agent({
                mode: 'cua',
                model: 'openai/computer-use-preview',
            })
        ).toThrow('OPENAI_API_KEY')
    })

    it('keeps process env precedence over .env values for provider key resolution', () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-agent-env-'))
        fs.writeFileSync(path.join(rootDir, '.env'), 'OPENAI_API_KEY=sk-dotenv', 'utf8')

        process.env.OPENAI_API_KEY = '   '
        delete process.env.OPENSTEER_DISABLE_DOTENV_AUTOLOAD

        const opensteer = new Opensteer({
            storage: { rootDir },
        })

        expect(() =>
            opensteer.agent({
                mode: 'cua',
                model: 'openai/computer-use-preview',
            })
        ).toThrow('OPENAI_API_KEY')
    })

    it('keeps constructor runtime env snapshot stable after process env changes', () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-agent-env-'))
        fs.writeFileSync(path.join(rootDir, '.env'), 'OPENAI_API_KEY=sk-dotenv', 'utf8')

        delete process.env.OPENAI_API_KEY
        delete process.env.OPENSTEER_DISABLE_DOTENV_AUTOLOAD

        const opensteer = new Opensteer({
            storage: { rootDir },
        })

        process.env.OPENAI_API_KEY = '   '

        expect(() =>
            opensteer.agent({
                mode: 'cua',
                model: 'openai/computer-use-preview',
            })
        ).not.toThrow()
    })
})
