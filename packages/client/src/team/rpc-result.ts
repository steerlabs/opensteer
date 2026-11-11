export function teamRpcResult<T>(
  result:
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (result.ok) return result.data;
  throw new Error(result.error.message);
}
