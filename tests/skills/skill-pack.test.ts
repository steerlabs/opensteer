import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILLS_ROOT = path.resolve(process.cwd(), 'skills')
const SKILL_PACKS: Record<string, string[]> = {
    opensteer: [
        'references/cli-reference.md',
        'references/sdk-reference.md',
        'references/examples.md',
    ],
    electron: [
        'references/opensteer-electron-workflow.md',
        'references/opensteer-electron-recipes.md',
    ],
}

function getSkillDir(skillName: string): string {
    return path.join(SKILLS_ROOT, skillName)
}

function getSkillMarkdown(skillName: string): string {
    return path.join(getSkillDir(skillName), 'SKILL.md')
}

function isNonEmptyString(value: string | undefined): value is string {
    return typeof value === 'string' && value.length > 0
}

describe('skill pack', () => {
    it('includes canonical skill files', () => {
        for (const [skillName, references] of Object.entries(SKILL_PACKS)) {
            const required = [
                getSkillMarkdown(skillName),
                ...references.map((file) => path.join(getSkillDir(skillName), file)),
            ]

            for (const file of required) {
                expect(fs.existsSync(file), `Missing skill file: ${file}`).toBe(true)
            }
        }
    })

    it('contains required frontmatter metadata', () => {
        for (const skillName of Object.keys(SKILL_PACKS)) {
            const source = fs.readFileSync(getSkillMarkdown(skillName), 'utf8')
            expect(source).toMatch(new RegExp(`(^|\\n)name:\\s*${skillName}(\\n|$)`))
            expect(source).toMatch(/(^|\n)description:\s*.+(\n|$)/)
        }
    })

    it('resolves relative markdown links within each skill folder', () => {
        for (const skillName of Object.keys(SKILL_PACKS)) {
            const skillDir = getSkillDir(skillName)
            const source = fs.readFileSync(getSkillMarkdown(skillName), 'utf8')
            const links = [...source.matchAll(/\[[^\]]+\]\((?!https?:|#|mailto:)([^)]+)\)/g)]
                .map((match) => match[1]?.split('#')[0])
                .filter(isNonEmptyString)

            expect(links.length).toBeGreaterThan(0)

            for (const link of links) {
                const resolved = path.resolve(skillDir, link)
                expect(
                    fs.existsSync(resolved),
                    `Broken skill link in ${skillName}: ${link} (resolved to ${resolved})`
                ).toBe(true)
            }
        }
    })
})
