import { allowsPlaintextRunnerTransport, type RuntimeMode } from "@opensteer/core";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

const maximumCaBytes = 256 * 1024;

export interface RunnerTransportPolicy {
  readonly controlCaPath?: string | undefined;
  readonly hostOrigin: URL;
  readonly mode: RuntimeMode;
}

export interface RunnerWebSocketTransport {
  readonly ca?: Buffer | undefined;
  readonly url: URL;
}

export async function runnerHttpTransport(
  policy: RunnerTransportPolicy,
  path: string,
): Promise<RunnerWebSocketTransport> {
  validateRunnerTransport(policy);
  const url = new URL(path, policy.hostOrigin);
  if (url.origin !== policy.hostOrigin.origin)
    throw new Error("Runner HTTP request left its Host origin");
  const ca = policy.controlCaPath ? await readControlCa(policy.controlCaPath) : undefined;
  return { ...(ca ? { ca } : {}), url };
}

/** Validates the transport once at each Runner application's environment boundary. */
export function validateRunnerTransport(policy: RunnerTransportPolicy): void {
  const url = policy.hostOrigin;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Runner Host URL must be an HTTP origin without credentials");
  }
  if (url.protocol !== "https:" && !allowsPlaintextRunnerTransport(policy.mode, url)) {
    throw new Error("Runner Host URL must use HTTPS outside loopback in production");
  }
  if (policy.controlCaPath && url.protocol !== "https:") {
    throw new Error("A Runner control CA requires an HTTPS Host origin");
  }
}

export async function runnerWebSocketTransport(
  policy: RunnerTransportPolicy,
  path: string,
): Promise<RunnerWebSocketTransport> {
  const { url, ca } = await runnerHttpTransport(policy, path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    ...(ca ? { ca } : {}),
    url,
  };
}

export function runnerTransportWebSocketUrl(policy: RunnerTransportPolicy, path: string): URL {
  validateRunnerTransport(policy);
  const url = new URL(path, policy.hostOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

async function readControlCa(path: string): Promise<Buffer> {
  const invalid = () => new Error("Runner control CA path is not a bounded regular file");
  return (
    (await readBoundedRegularFile(path, maximumCaBytes, {
      changedError: invalid,
      invalidFileError: invalid,
      sizeError: invalid,
    })) ?? Buffer.alloc(0)
  );
}
