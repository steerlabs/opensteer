/**
 * Injected into page context before evaluate() calls that use function bodies
 * compiled by tsx/esbuild. The bundler wraps functions with __name(...) which
 * does not exist in the browser, so this shim prevents ReferenceErrors.
 */
export const ENSURE_NAME_SHIM_SCRIPT = `
(() => {
  if (typeof globalThis.__name !== 'function') {
    Object.defineProperty(globalThis, '__name', {
      value: (value) => value,
      configurable: true,
      writable: true
    })
  }
})()
`

export const OS_FRAME_TOKEN_KEY = '__opensteerFrameToken'
export const OS_INSTANCE_TOKEN_KEY = '__opensteerInstanceToken'
