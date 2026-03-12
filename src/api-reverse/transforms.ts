import type {
    ApiBindingTransform,
    ApiBindingTransformKind,
} from './types.js'

export function applyBindingTransforms(
    value: unknown,
    transforms: ApiBindingTransform[] | undefined
): unknown {
    if (!transforms?.length) {
        return value
    }

    let current = value
    for (const transform of transforms) {
        current = applyBindingTransform(current, transform.kind)
    }
    return current
}

export function applyBindingTransform(
    value: unknown,
    transform: ApiBindingTransformKind
): unknown {
    if (typeof value !== 'string') {
        return value
    }

    switch (transform) {
        case 'trim':
            return value.trim()
        case 'lowercase':
            return value.toLowerCase()
        case 'url_decode':
            return safeDecodeURIComponent(value)
    }
}

export function normalizeBindingTransforms(
    values: string[] | undefined
): ApiBindingTransform[] {
    if (!values?.length) {
        return []
    }

    return values.map((kind) => ({
        kind: normalizeBindingTransformKind(kind),
    }))
}

function normalizeBindingTransformKind(value: string): ApiBindingTransformKind {
    switch (value) {
        case 'trim':
        case 'lowercase':
        case 'url_decode':
            return value
        default:
            throw new Error(`Unsupported binding transform "${value}".`)
    }
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}
