/**
 * A heartbeat: one plain HTTP GET to an address from configuration, at the end of each
 * successful pass of a job that must run, so a monitor that stops hearing it can say the job
 * stopped. Nothing vendor-specific: any dead-man check that accepts a GET works. It never
 * delays or fails the job: the request runs on its own with a short deadline, and a failed
 * one is only reported to `onError`.
 */
export function sendHeartbeat(
  url: URL | undefined,
  options: {
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
    readonly onError?: (status: number | "unreachable") => void;
  } = {},
): void {
  if (!url) return;
  const request = options.fetch ?? fetch;
  void request(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  }).then(
    async (response) => {
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) options.onError?.(response.status);
    },
    () => options.onError?.("unreachable"),
  );
}

/** A heartbeat address: https, no credentials in it. */
export function heartbeatUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("A heartbeat address must be https and carry no user name or password");
  return url;
}
