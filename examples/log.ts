import { extractErrorMessage } from '../src/error-normalization.js'

export function reportError(error: unknown): void {
    console.error(
        extractErrorMessage(error, 'Unexpected error occurred while running example.')
    )
}
