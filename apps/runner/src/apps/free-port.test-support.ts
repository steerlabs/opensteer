import { freePort } from "@opensteer/shared/test-support/loopbackPort";

/**
 * Claims distinct non-ephemeral loopback ports (held via cross-process UDP claims) so parallel
 * test processes using `listen(0)` or outbound TCP sockets cannot take them before `AppServerManager`
 * probes or binds them.
 */
export async function freeAppPorts(count: number): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => freePort()));
}

export async function freeAppPort(): Promise<number> {
  return freePort();
}
