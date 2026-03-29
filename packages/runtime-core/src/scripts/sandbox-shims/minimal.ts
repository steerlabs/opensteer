export interface SandboxClockApi {
  now(): number;
  performanceNow(): number;
  setTimeout(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): number;
  setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): number;
  clearTimeout(timerId: number): void;
  clearInterval(timerId: number): void;
  advanceClock(ms: number): number;
}

export interface MinimalSandboxShimOptions {
  readonly clock: SandboxClockApi;
  readonly console: Console;
  readonly globals?: Readonly<Record<string, unknown>>;
}

export function createMinimalSandboxGlobals(
  options: MinimalSandboxShimOptions,
): Record<string, unknown> {
  return {
    console: options.console,
    JSON,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    crypto: globalThis.crypto,
    structuredClone,
    atob: globalThis.atob ?? ((value: string) => Buffer.from(value, "base64").toString("binary")),
    btoa: globalThis.btoa ?? ((value: string) => Buffer.from(value, "binary").toString("base64")),
    setTimeout: options.clock.setTimeout.bind(options.clock),
    setInterval: options.clock.setInterval.bind(options.clock),
    clearTimeout: options.clock.clearTimeout.bind(options.clock),
    clearInterval: options.clock.clearInterval.bind(options.clock),
    advanceClock: options.clock.advanceClock.bind(options.clock),
    ...options.globals,
  };
}
