import type { Cookie } from 'playwright'
import type { CookieParam } from '../types.js'

export interface PrepareCookiesForSyncOptions {
    domains?: string[]
}

export interface PreparedCookieSyncPayload {
    cookies: CookieParam[]
    totalCookies: number
    matchedCookies: number
    dedupedCookies: number
    droppedInvalid: number
    filteredDomains: string[]
    domainCounts: Record<string, number>
}

export function normalizeCookieDomain(value: string): string {
    const trimmed = value.trim().toLowerCase()
    return trimmed.replace(/^\.+/, '')
}

export function extractCookieDomain(
    cookie: Pick<Cookie, 'domain'>
): string | null {
    if (typeof cookie.domain === 'string' && cookie.domain.trim()) {
        return normalizeCookieDomain(cookie.domain)
    }

    return null
}

export function cookieMatchesDomainFilters(
    cookie: Pick<Cookie, 'domain'>,
    domainFilters: string[]
): boolean {
    if (!domainFilters.length) return true
    const cookieDomain = extractCookieDomain(cookie)
    if (!cookieDomain) return false

    return domainFilters.some((domain) => {
        if (cookieDomain === domain) return true
        return cookieDomain.endsWith(`.${domain}`)
    })
}

export function toCookieParam(cookie: Cookie): CookieParam | null {
    const name = typeof cookie.name === 'string' ? cookie.name.trim() : ''
    if (!name) return null
    if (typeof cookie.value !== 'string') return null

    const output: CookieParam = {
        name,
        value: cookie.value,
    }

    if (typeof cookie.domain === 'string' && cookie.domain.trim()) {
        output.domain = cookie.domain.trim()
    }
    if (typeof cookie.path === 'string' && cookie.path.trim()) {
        output.path = cookie.path
    }

    if (!output.domain) {
        return null
    }
    if (!output.path) {
        output.path = '/'
    }

    if (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires)) {
        if (cookie.expires > 0) {
            output.expires = cookie.expires
        }
    }

    if (typeof cookie.httpOnly === 'boolean') {
        output.httpOnly = cookie.httpOnly
    }
    if (typeof cookie.secure === 'boolean') {
        output.secure = cookie.secure
    }
    if (
        cookie.sameSite === 'Strict' ||
        cookie.sameSite === 'Lax' ||
        cookie.sameSite === 'None'
    ) {
        output.sameSite = cookie.sameSite
    }

    return output
}

export function prepareCookiesForSync(
    cookies: Cookie[],
    options: PrepareCookiesForSyncOptions = {}
): PreparedCookieSyncPayload {
    const filteredDomains = Array.from(
        new Set(
            (options.domains || [])
                .map((domain) => normalizeCookieDomain(domain))
                .filter(Boolean)
        )
    )
    const domainCounts: Record<string, number> = {}

    let matchedCookies = 0
    let droppedInvalid = 0

    const dedupeMap = new Map<string, CookieParam>()

    for (const cookie of cookies) {
        if (!cookieMatchesDomainFilters(cookie, filteredDomains)) {
            continue
        }

        matchedCookies += 1

        const normalizedCookie = toCookieParam(cookie)
        if (!normalizedCookie) {
            droppedInvalid += 1
            continue
        }

        const domainKey = extractCookieDomain(cookie) || '(unknown)'
        domainCounts[domainKey] = (domainCounts[domainKey] || 0) + 1
        const identityDomain = normalizedCookie.domain
            ? normalizeCookieDomain(normalizedCookie.domain)
            : ''

        const dedupeKey = [
            normalizedCookie.name,
            identityDomain,
            normalizedCookie.path || '/',
        ].join('\u0001')
        dedupeMap.set(dedupeKey, normalizedCookie)
    }

    const dedupedCookies = dedupeMap.size

    return {
        cookies: Array.from(dedupeMap.values()),
        totalCookies: cookies.length,
        matchedCookies,
        dedupedCookies,
        droppedInvalid,
        filteredDomains,
        domainCounts,
    }
}
