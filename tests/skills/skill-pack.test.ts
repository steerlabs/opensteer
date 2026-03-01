import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL_DIR = path.resolve(process.cwd(), 'skills', 'opensteer')
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md')

describe('opensteer skill pack', () => {
    it('includes canonical skill files', () => {
        const required = [
            SKILL_MD,
            path.join(SKILL_DIR, 'references', 'cli-reference.md'),
            path.join(SKILL_DIR, 'references', 'sdk-reference.md'),
            path.join(SKILL_DIR, 'references', 'examples.md'),
        ]

        for (const file of required) {
            expect(fs.existsSync(file), `Missing skill file: ${file}`).toBe(true)
        }
    })

    it('contains required frontmatter metadata', () => {
        const source = fs.readFileSync(SKILL_MD, 'utf8')
        expect(source).toMatch(/(^|\n)name:\s*opensteer(\n|$)/)
        expect(source).toMatch(/(^|\n)description:\s*.+(\n|$)/)
    })

    it('resolves relative markdown links within the skill folder', () => {
        const source = fs.readFileSync(SKILL_MD, 'utf8')
        const links = [...source.matchAll(/\[[^\]]+\]\((references\/[^)]+\.md)\)/g)]
            .map((match) => match[1])
            .filter(Boolean)

        expect(links.length).toBeGreaterThan(0)

        for (const link of links) {
            const resolved = path.resolve(SKILL_DIR, link)
            expect(
                fs.existsSync(resolved),
                `Broken skill link: ${link} (resolved to ${resolved})`
            ).toBe(true)
        }
    })
})
