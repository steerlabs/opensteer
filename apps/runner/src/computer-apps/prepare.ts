import { rmSync } from "node:fs";
import path from "node:path";
import {
  runnerIntegrationsProtocolVersion,
  macOwnerViewVersion,
  type RunnerIntegrationsModule,
} from "@opensteer/protocol";
import { ComputerUseHandler } from "./computer-use-handler.js";
import { LocalMcpServers } from "./local-mcp-servers.js";
import type { ComputerAppProvider } from "./provider.js";
import { computerAppProviders } from "./registry.js";

export interface PreparedIntegrationsModule {
  readonly files?: { readonly dataDirectory: string; readonly helperBinary: string };
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
  /** Runner state root; obsolete local consent caches are removed at startup. */
  readonly dataDirectory: string;
  readonly helperBinary?: string;
  readonly platform: NodeJS.Platform;
}): PreparedIntegrationsModule | undefined {
  // The descriptor names one of three platforms, so a Runner on any other —
  // aix, freebsd, a future one — is narrowed out before the registry is asked:
  // it could only answer with providers none of them declares anyway.
  const { platform } = options;
  rmSync(path.join(options.dataDirectory, "private", "app-files"), {
    recursive: true,
    force: true,
  });
  // Only the Host's exact-launch consent remains authoritative after upgrade.
  try {
    rmSync(path.join(options.dataDirectory, "integrations", "mcp-approvals.json"), { force: true });
  } catch {
    /* Obsolete cache is never read. */
  }

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
    ...(options.helperBinary
      ? { files: { dataDirectory: options.dataDirectory, helperBinary: options.helperBinary } }
      : {}),
    close: () => computerUse?.close(),
    ...(computerUse
      ? {
          computerUse,
          localMcp: new LocalMcpServers({
            stateDirectory: path.join(options.dataDirectory, "private", "harness-state"),
          }),
        }
      : {}),
    descriptor: {
      // The signed descriptor states shipped protocol support. The status
      // cadence reports transient helper readiness on this same connection.
      ...(computerUse
        ? ({ computerUseVersion: 2, ownerViewVersion: macOwnerViewVersion } as const)
        : {}),
      ...(computerUse
        ? {
            macWindowVideoVersion: 1,
            displayProfile: 1,
            macOwnerInputVersion: 2,
            loginText: 1,
            passwordSignIn: 2,
            cardUse: 1,
            pluginDataRemoval: 1,
          }
        : {}),
      ...(options.helperBinary ? { appFiles: 1 as const } : {}),
      platform,
      protocolVersion: runnerIntegrationsProtocolVersion,
    },
    providers,
  };
}
