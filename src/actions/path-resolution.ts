import { ElementPathError } from '../element-path/errors.js'

const NOT_FOUND_CODES = new Set([
    'ERR_PATH_TARGET_NOT_FOUND',
    'ERR_PATH_CONTEXT_HOST_NOT_FOUND',
])

export function formatPathResolutionError(err: unknown): string {
    if (err instanceof ElementPathError) {
        if (NOT_FOUND_CODES.has(err.code)) {
            return `No matching element found. ${err.message}`
        }
        return err.message
    }
    return err instanceof Error ? err.message : 'Path resolution failed.'
}
