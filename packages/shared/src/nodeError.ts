/** Node error recognition. */

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function nodeErrorCode(error: unknown): string | undefined {
  return isNodeError(error) && error.code !== undefined ? String(error.code) : undefined;
}
