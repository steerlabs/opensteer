/** The runtime's own code for a refusal the Runner relayed; the error the Home shows is unchanged. */
const runtimeRefusalCodes = new WeakMap<Error, string>();

/** Records the code the browser runtime itself refused with, on the error that carries it. */
export function recordRuntimeRefusal(error: Error, code: string | undefined): void {
  if (code) runtimeRefusalCodes.set(error, code);
}

/** The code the browser runtime itself refused with, when the Runner relayed its refusal. */
export function runtimeRefusalCode(error: unknown): string | undefined {
  return error instanceof Error ? runtimeRefusalCodes.get(error) : undefined;
}
