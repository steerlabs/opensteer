import { describe, expect, it } from 'vitest'
import type { Cookie } from 'playwright'
import {
    cookieMatchesDomainFilters,
    normalizeCookieDomain,
    prepareCookiesForSync,
    toCookieParam,
} from '../../src/cli/profile-sync.js'

describe('cli/profile-sync', () => {
    it('normalizes domain strings', () => {
        expect(normalizeCookieDomain('.Example.COM')).toBe('example.com')
        expect(normalizeCookieDomain('..foo.bar')).toBe('foo.bar')
    })

    it('matches direct domains and subdomains', () => {
        expect(
            cookieMatchesDomainFilters(
                {
                    domain: '.accounts.google.com',
                } as Pick<Cookie, 'domain'>,
                ['google.com']
            )
        ).toBe(true)

        expect(
            cookieMatchesDomainFilters(
                {
                    domain: '.github.com',
                } as Pick<Cookie, 'domain'>,
                ['example.com']
            )
        ).toBe(false)
    })

    it('prepares, filters, and deduplicates cookies for sync', () => {
        const cookies = [
            {
                name: 'sid',
                value: 'v1',
                domain: '.github.com',
                path: '/',
                expires: 999999,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
            },
            {
                name: 'sid',
                value: 'v2',
                domain: '.github.com',
                path: '/',
                expires: 999999,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
            },
            {
                name: 'prefs',
                value: 'abc',
                domain: '.example.com',
                path: '/',
                expires: 999999,
                httpOnly: false,
                secure: false,
                sameSite: 'Lax',
            },
            {
                name: '',
                value: 'invalid',
                domain: '.github.com',
                path: '/',
                expires: 999999,
                httpOnly: false,
                secure: false,
                sameSite: 'Lax',
            },
        ] as Cookie[]

        const prepared = prepareCookiesForSync(cookies, {
            domains: ['github.com'],
        })

        expect(prepared.totalCookies).toBe(4)
        expect(prepared.matchedCookies).toBe(3)
        expect(prepared.droppedInvalid).toBe(1)
        expect(prepared.dedupedCookies).toBe(1)
        expect(prepared.cookies).toHaveLength(1)
        expect(prepared.cookies[0]).toEqual(
            expect.objectContaining({
                name: 'sid',
                value: 'v2',
                domain: '.github.com',
            })
        )
    })

    it('drops non-positive expires when converting cookie payloads', () => {
        const normalized = toCookieParam({
            name: 'session',
            value: 'value',
            domain: '.example.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
        } as Cookie)

        expect(normalized).toEqual(
            expect.objectContaining({
                name: 'session',
                domain: '.example.com',
                path: '/',
            })
        )
        expect(normalized).not.toHaveProperty('expires')
    })
})
