import type { RunnerConfig } from "@opensteer/config";
import { BrowserCdpRelay } from "../browser/browser-cdp-relay.js";
import { CredentialProxy } from "../credentials/credential-proxy.js";
import type { ProgramEndpoints } from "./program-executor.js";

interface CapabilityPlan {
  readonly token: string;
  readonly url: string;
}

/** The Host capabilities a program acts under, current at each call. */
export interface ProgramCapabilities {
  readonly browserCdp: CapabilityPlan | null;
  readonly integrationMcp: CapabilityPlan;
  readonly mcp: CapabilityPlan;
}

export interface ProgramEndpointSet {
  readonly endpoints: ProgramEndpoints;
  /** Authority ended: refuse new calls and end the open ones. */
  revoke(): void;
  close(): Promise<void>;
}

/**
 * What a Trigger or Watch program reaches Opensteer through. Its code is a
 * Workspace member's, so it never holds a Host token: tool calls go through a
 * loopback proxy that adds the current token, and the browser through a relay
 * whose path is its only key. The program's `token` fields carry the proxy's
 * secret, which works nowhere else.
 */
export async function startProgramEndpoints(input: {
  readonly capabilities: () => ProgramCapabilities;
  readonly transport: Pick<RunnerConfig, "mode">;
}): Promise<ProgramEndpointSet> {
  const initial = input.capabilities();
  const proxy = new CredentialProxy({
    routes: {
      "agent-tools": { token: () => input.capabilities().mcp.token, upstream: initial.mcp.url },
      "integration-tools": {
        token: () => input.capabilities().integrationMcp.token,
        upstream: initial.integrationMcp.url,
      },
    },
    transport: input.transport,
  });
  const relay = initial.browserCdp
    ? new BrowserCdpRelay({
        plan: initial.browserCdp,
        token: () => input.capabilities().browserCdp?.token ?? "",
        transport: input.transport,
      })
    : undefined;
  try {
    const proxied = await proxy.start();
    const browserCdpUrl = await relay?.start();
    return {
      async close() {
        await Promise.allSettled([proxy.close(), relay?.close()]);
      },
      endpoints: {
        ...(browserCdpUrl ? { browserCdp: { token: proxied.secret, url: browserCdpUrl } } : {}),
        integrationMcp: { token: proxied.secret, url: proxied.urls["integration-tools"] },
        mcp: { token: proxied.secret, url: proxied.urls["agent-tools"] },
      },
      revoke() {
        proxy.revoke();
        void relay?.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await Promise.allSettled([proxy.close(), relay?.close()]);
    throw error;
  }
}
