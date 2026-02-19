import { describe, expect, it } from 'vitest'
import { buildPathCandidates } from '../../src/element-path/match-selectors.js'
import type { DomPath, PathNode } from '../../src/element-path/types.js'

function node(partial: Partial<PathNode>): PathNode {
    return {
        tag: partial.tag || 'div',
        attrs: partial.attrs || {},
        position: partial.position || {
            nthChild: 1,
            nthOfType: 1,
        },
        match: partial.match || [],
    }
}

describe('element-path/match-selectors', () => {
    it('builds strict-to-broad suffix candidates in deterministic order', () => {
        const domPath: DomPath = [
            node({
                tag: 'html',
                attrs: { class: 'app' },
                match: [{ kind: 'attr', key: 'class', op: 'exact', value: 'app' }],
            }),
            node({
                tag: 'section',
                attrs: { class: 'card' },
                match: [
                    {
                        kind: 'attr',
                        key: 'class',
                        op: 'exact',
                        value: 'card',
                    },
                ],
            }),
            node({
                tag: 'h1',
                attrs: { class: 'title' },
                match: [
                    {
                        kind: 'attr',
                        key: 'class',
                        op: 'exact',
                        value: 'title',
                    },
                ],
            }),
        ]

        expect(buildPathCandidates(domPath)).toEqual([
            'html[class~="app"] section[class~="card"] h1[class~="title"]',
            'section[class~="card"] h1[class~="title"]',
            'h1[class~="title"]',
        ])
    })

    it('tokenizes exact class selectors and deduplicates duplicate class tokens', () => {
        const domPath: DomPath = [
            node({
                tag: 'button',
                attrs: { class: 'primary primary cta' },
                match: [
                    {
                        kind: 'attr',
                        key: 'class',
                        op: 'exact',
                        value: 'primary primary cta',
                    },
                ],
            }),
        ]

        expect(buildPathCandidates(domPath)).toEqual([
            'button[class~="primary"][class~="cta"]',
        ])
    })

    it('skips invalid css attribute keys in match clauses', () => {
        const domPath: DomPath = [
            node({
                tag: 'input',
                attrs: { name: 'email' },
                match: [
                    {
                        kind: 'attr',
                        key: 'bad key',
                        op: 'exact',
                        value: 'ignored',
                    },
                    {
                        kind: 'attr',
                        key: 'name',
                        op: 'exact',
                        value: 'email',
                    },
                ],
            }),
        ]

        expect(buildPathCandidates(domPath)).toEqual(['input[name="email"]'])
    })

    it('includes position clauses when they are part of the match', () => {
        const domPath: DomPath = [
            node({
                tag: 'li',
                position: {
                    nthChild: 4,
                    nthOfType: 2,
                },
                match: [
                    { kind: 'position', axis: 'nthOfType' },
                    { kind: 'position', axis: 'nthChild' },
                ],
            }),
        ]

        expect(buildPathCandidates(domPath)).toEqual([
            'li:nth-of-type(2):nth-child(4)',
        ])
    })
})
