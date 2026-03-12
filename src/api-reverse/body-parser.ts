import { safeJsonParse, summarizeMime } from './normalize.js'
import type { ApiBodyFormat } from './types.js'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'
const JSON_CONTENT_TYPE_PATTERN = /(^|\/|\+)json$/i
const FORM_FIELD_NAME_PATTERN = /^[A-Za-z0-9_.:[\]-]+$/
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9+/_=-]{24,}$/

interface ParsedBodyCandidate {
    format: ApiBodyFormat
    parsedJson?: unknown
    parsedForm?: Record<string, string | string[]>
    score: number
}

interface FormBodyAnalysis {
    parsedForm: Record<string, string | string[]>
    pairCount: number
    meaningfulKeyCount: number
    suspiciousKeyCount: number
}

export interface ParsedCapturedBody {
    format: ApiBodyFormat
    parsedJson?: unknown
    parsedForm?: Record<string, string | string[]>
}

export function parseCapturedBody(
    raw: string,
    contentType: string | null | undefined
): ParsedCapturedBody {
    const trimmed = raw.trim()
    if (!trimmed) {
        return { format: 'text' }
    }

    const mime = summarizeMime(contentType)
    const jsonCandidate = buildJsonCandidate(trimmed, mime)
    const formCandidate = buildFormCandidate(trimmed, mime)
    const best = pickBestCandidate(jsonCandidate, formCandidate)

    if (!best) {
        return { format: 'text' }
    }
    if (best.format === 'json') {
        return {
            format: 'json',
            parsedJson: best.parsedJson,
        }
    }
    return {
        format: 'form',
        parsedForm: best.parsedForm,
    }
}

function buildJsonCandidate(
    raw: string,
    mime: string | null
): ParsedBodyCandidate | null {
    const mimeHintsJson = isJsonContentType(mime)
    const payloadLooksJson = looksLikeJsonDocument(raw)
    if (!mimeHintsJson && !payloadLooksJson) {
        return null
    }
    const parsedJson = safeJsonParse(raw)
    if (parsedJson === null) {
        return null
    }
    return {
        format: 'json',
        parsedJson,
        score: mimeHintsJson ? 6 : 5,
    }
}

function buildFormCandidate(
    raw: string,
    mime: string | null
): ParsedBodyCandidate | null {
    const analysis = analyzeFormBody(raw)
    if (!analysis) {
        return null
    }

    let score = 3
    if (isFormContentType(mime)) {
        score += 2
    }
    if (analysis.pairCount >= 2) {
        score += 1
    }
    if (analysis.meaningfulKeyCount === analysis.pairCount) {
        score += 1
    }
    if (analysis.suspiciousKeyCount > 0) {
        score -= analysis.suspiciousKeyCount * 2
    }
    if (score < 3) {
        return null
    }

    return {
        format: 'form',
        parsedForm: analysis.parsedForm,
        score,
    }
}

function pickBestCandidate(
    jsonCandidate: ParsedBodyCandidate | null,
    formCandidate: ParsedBodyCandidate | null
): ParsedBodyCandidate | null {
    if (!jsonCandidate) return formCandidate
    if (!formCandidate) return jsonCandidate
    return jsonCandidate.score >= formCandidate.score ? jsonCandidate : formCandidate
}

function analyzeFormBody(raw: string): FormBodyAnalysis | null {
    if (!raw.includes('=')) {
        return null
    }
    if (looksLikeJsonDocument(raw)) {
        return null
    }

    const segments = raw
        .split('&')
        .map((segment) => segment.trim())
        .filter(Boolean)
    if (!segments.length) {
        return null
    }

    let meaningfulKeyCount = 0
    let suspiciousKeyCount = 0
    for (const segment of segments) {
        const separatorIndex = segment.indexOf('=')
        if (separatorIndex <= 0) {
            return null
        }
        const key = decodeFormComponent(segment.slice(0, separatorIndex))
        if (!key) {
            return null
        }
        if (isLikelyFormFieldName(key)) {
            meaningfulKeyCount += 1
        } else {
            suspiciousKeyCount += 1
        }
    }

    if (!meaningfulKeyCount) {
        return null
    }

    const params = new URLSearchParams(raw)
    const parsedForm: Record<string, string | string[]> = {}
    for (const key of params.keys()) {
        const values = params.getAll(key)
        parsedForm[key] = values.length <= 1 ? values[0] || '' : values
    }
    if (!Object.keys(parsedForm).length) {
        return null
    }

    return {
        parsedForm,
        pairCount: segments.length,
        meaningfulKeyCount,
        suspiciousKeyCount,
    }
}

function isJsonContentType(mime: string | null): boolean {
    if (!mime) return false
    return JSON_CONTENT_TYPE_PATTERN.test(mime)
}

function isFormContentType(mime: string | null): boolean {
    return mime === FORM_CONTENT_TYPE
}

function looksLikeJsonDocument(raw: string): boolean {
    const trimmed = raw.trim()
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        return false
    }
    return safeJsonParse(trimmed) !== null
}

function decodeFormComponent(value: string): string {
    const normalized = value.replace(/\+/g, ' ')
    try {
        return decodeURIComponent(normalized)
    } catch {
        return normalized
    }
}

function isLikelyFormFieldName(value: string): boolean {
    const key = value.trim()
    if (!key || key.length > 64) {
        return false
    }
    if (!FORM_FIELD_NAME_PATTERN.test(key)) {
        return false
    }
    if (looksLikeOpaqueToken(key)) {
        return false
    }
    return true
}

function looksLikeOpaqueToken(value: string): boolean {
    return OPAQUE_TOKEN_PATTERN.test(value) && !/[_.:[\]-]/.test(value)
}
