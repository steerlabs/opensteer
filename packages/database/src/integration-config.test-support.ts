/** File poison state is safe only with isolated, non-retrying fork files. */
export function assertIntegrationTestConfig(config: {
  readonly pool: unknown;
  readonly isolate: unknown;
  readonly retry: unknown;
}): void {
  if (config.pool !== "forks" || config.isolate === false)
    throw new Error("Integration databases require isolated forks");
  if (config.retry !== 0) throw new Error("Integration retries must be 0");
}
