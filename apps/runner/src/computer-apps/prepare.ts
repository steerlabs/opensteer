import {
  runnerIntegrationsProtocolVersion,
  macOwnerViewVersion,
  type RunnerIntegrationsModule,
} from "@opensteer/protocol";
import path from "node:path";
import { ComputerUseHandler } from "./computer-use-handler.js";
import { LocalMcpApprovals, LocalMcpServers } from "./local-mcp-servers.js";
import type { ComputerAppProvider } from "./provider.js";
import { computerAppProviders } from "./registry.js";

export interface PreparedIntegrationsModule {
  /**
   * Present exactly when the desktop app offers this Runner computer use on
   * the Mac they share. It owns the loopback bridge, which is why it is
   * prepared once here rather than per Host connection: the status cadence and
   * the computer-use frames are the same Mac and must be the same socket.
   */
  readonly computerUse?: ComputerUseHandler;
  readonly descriptor: RunnerIntegrationsModule;
  /** The MCP servers this computer runs, present exactly when `computerUse` is. */
  readonly localMcp?: LocalMcpServers;
  readonly providers: readonly ComputerAppProvider[];
  /** Releases what preparation opened. Called when the Runner stops. */
  readonly close?: () => void;
}

export function prepareIntegrationsModule(options: {
  /** The bridge the desktop minted for this slot, on a Mac it supervises. */
  readonly computerUseBridge?: { readonly token: string; readonly url: URL };
  /** Where this Runner keeps what its owner approved on this computer. */
  readonly dataDirectory: string;
  readonly platform: NodeJS.Platform;
}): PreparedIntegrationsModule | undefined {
  // The descriptor names one of three platforms, so a Runner on any other —
  // aix, freebsd, a future one — is narrowed out before the registry is asked:
  // it could only answer with providers none of them declares anyway.
  const { platform } = options;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return undefined;
  // No other platform has a helper behind the bridge, so a pair configured
  // elsewhere opens nothing rather than a socket to a server that cannot exist.
  const computerUse =
    platform === "darwin" && options.computerUseBridge
      ? new ComputerUseHandler({ bridge: options.computerUseBridge })
      : undefined;
  const providers = computerAppProviders(
    platform,
    computerUse
      ? {
          computerUsePermissions: async () => await computerUse.permissions(),
          helperData: computerUse,
        }
      : {},
  );
  if (providers.length === 0) {
    computerUse?.close();
    return undefined;
  }
  return {
    close: () => computerUse?.close(),
    ...(computerUse
      ? {
          computerUse,
          localMcp: new LocalMcpServers({
            approvals: new LocalMcpApprovals(
              path.join(options.dataDirectory, "integrations", "mcp-approvals.json"),
            ),
          }),
        }
      : {}),
    // A desktop on this Mac shows and answers its approvals, so this Runner
    // says it relays them; without one, the Host never sends it any.
    descriptor: {
      // The signed descriptor states shipped protocol support. The status
      // cadence reports transient helper readiness on this same connection.
      ...(computerUse
        ? ({ computerUseVersion: 2, ownerViewVersion: macOwnerViewVersion } as const)
        : {}),
      ...(computerUse
        ? {
            macWindowVideoVersion: 1,
            macOwnerInputVersion: 2,
            computerAppApprovals: true,
            loginText: 1,
            passwordSignIn: 1,
          }
        : {}),
      platform,
      protocolVersion: runnerIntegrationsProtocolVersion,
    },
    providers,
  };
}
