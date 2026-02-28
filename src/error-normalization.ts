export interface StructuredErrorInfo {
    message: string
    code?: string
    name?: string
    details?: Record<string, unknown>
    cause?: StructuredErrorInfo
}

export function extractErrorMessage(
    error: unknown,
    fallback = 'Unknown error.'
): string {
    if (error instanceof Error) {
        const message = error.message.trim()
        if (message) return message
        const name = error.name.trim()
        if (name) return name
    }

    if (typeof error === 'string' && error.trim()) {
        return error.trim()
    }

    const record = asRecord(error)
    const recordMessage =
        toNonEmptyString(record?.message) || toNonEmptyString(record?.error)
    if (recordMessage) {
        return recordMessage
    }

    return fallback
}

export function normalizeError(
    error: unknown,
    fallback = 'Unknown error.',
    maxCauseDepth = 2
): StructuredErrorInfo {
    const seen = new WeakSet<object>()
    return normalizeErrorInternal(error, fallback, maxCauseDepth, seen)
}

function normalizeErrorInternal(
    error: unknown,
    fallback: string,
    depthRemaining: number,
    seen: WeakSet<object>
): StructuredErrorInfo {
    const record = asRecord(error)
    if (record) {
        if (seen.has(record)) {
            return {
                message: extractErrorMessage(error, fallback),
            }
        }
        seen.add(record)
    }

    const message = extractErrorMessage(error, fallback)
    const code = extractCode(error)
    const name = extractName(error)
    const details = extractDetails(error)

    if (depthRemaining <= 0) {
        return compactErrorInfo({
            message,
            ...(code ? { code } : {}),
            ...(name ? { name } : {}),
            ...(details ? { details } : {}),
        })
    }

    const cause = extractCause(error)
    if (!cause) {
        return compactErrorInfo({
            message,
            ...(code ? { code } : {}),
            ...(name ? { name } : {}),
            ...(details ? { details } : {}),
        })
    }

    const normalizedCause = normalizeErrorInternal(
        cause,
        'Caused by an unknown error.',
        depthRemaining - 1,
        seen
    )

    return compactErrorInfo({
        message,
        ...(code ? { code } : {}),
        ...(name ? { name } : {}),
        ...(details ? { details } : {}),
        cause: normalizedCause,
    })
}

function compactErrorInfo(info: StructuredErrorInfo): StructuredErrorInfo {
    return {
        message: info.message,
        ...(info.code ? { code: info.code } : {}),
        ...(info.name ? { name: info.name } : {}),
        ...(info.details ? { details: info.details } : {}),
        ...(info.cause ? { cause: info.cause } : {}),
    }
}

function extractCode(error: unknown): string | undefined {
    const record = asRecord(error)
    const raw = record?.code
    if (typeof raw === 'string' && raw.trim()) {
        return raw.trim()
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return String(raw)
    }
    return undefined
}

function extractName(error: unknown): string | undefined {
    if (error instanceof Error && error.name.trim()) {
        return error.name.trim()
    }

    const record = asRecord(error)
    return toNonEmptyString(record?.name)
}

function extractDetails(error: unknown): Record<string, unknown> | undefined {
    const record = asRecord(error)
    if (!record) return undefined

    const details: Record<string, unknown> = {}

    const rawDetails = asRecord(record.details)
    if (rawDetails) {
        Object.assign(details, rawDetails)
    }

    const action = toNonEmptyString(record.action)
    if (action) {
        details.action = action
    }

    const selectorUsed = toNonEmptyString(record.selectorUsed)
    if (selectorUsed) {
        details.selectorUsed = selectorUsed
    }

    if (typeof record.status === 'number' && Number.isFinite(record.status)) {
        details.status = record.status
    }

    const failure = asRecord(record.failure)
    if (failure) {
        const failureCode = toNonEmptyString(failure.code)
        const classificationSource = toNonEmptyString(
            failure.classificationSource
        )
        const failureDetails = asRecord(failure.details)

        if (failureCode || classificationSource || failureDetails) {
            details.actionFailure = {
                ...(failureCode ? { code: failureCode } : {}),
                ...(classificationSource
                    ? { classificationSource }
                    : {}),
                ...(failureDetails ? { details: failureDetails } : {}),
            }
        }
    }

    return Object.keys(details).length ? details : undefined
}

function extractCause(error: unknown): unknown {
    if (error instanceof Error) {
        return (error as Error & { cause?: unknown }).cause
    }

    const record = asRecord(error)
    return record?.cause
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }

    return value as Record<string, unknown>
}

function toNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}
