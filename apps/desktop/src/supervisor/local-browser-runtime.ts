import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  defaultAttachTicketReplayLedgerPath,
  Ed25519AttachTicketVerifier,
  HttpBrowserProfileStateClient,
  sessionFilesRoot,
  type BrowserLoginAuthority,
  type BrowserProfileStateClient,
  type NativePresentationSource,
} from "@opensteer/browser-runtime-core";
import { BrowserAttachKeyRegistry } from "../browser/browser-attach-key-registry.js";
import { ElectronBrowserLauncher } from "../browser/electron-browser-launcher.js";
import { logShutdownError } from "../app/desktop-shutdown.js";
import { BoundedPersonalLog, RotatingPersonalLog } from "./personal-process-port.js";
import type { PersonalLocalBrowserHandle } from "./personal-local-runtime.js";

export interface LocalBrowserRuntimeOptions {
  readonly downloads: Pick<DesktopDownloads, "accept">;
  readonly registerPresentationSource?: (source: NativePresentationSource) => () => void;
  /** Absolute path of the bundled `browser-page-preload.cjs`. */
  readonly pagePolicyPreloadPath: string;
  readonly profileRoot: string;
  readonly runtimeId: string;
  /** The file this runtime alone writes its session-start diagnostics to. */
  readonly logPath?: string;
  readonly checkpointIntervalMs?: number;
  readonly profileStateClient?: BrowserProfileStateClient;
  /**
   * Saved-password sign-ins through Opensteer Passwords. Only the Personal
   * Deployment's browser has it: its Runner is this Mac's own, and that is
   * the only path to it the Host can attribute to this Mac today.
   */
  readonly loginAuthority?: BrowserLoginAuthority;
}

/**
 * Starts this computer's Chromium and the loopback bridge a Runner reaches it
 * through.
 *
 * The bridge token is minted here and handed only to the Runner process that
 * relays for it, so nothing else on the machine can drive this browser — and
 * the browser itself never learns a Host credential. Attach keys arrive over
 * the bridge from the Host, through the Runner, and are what this runtime
 * verifies attach tickets against.
 */
export async function startLocalBrowserRuntime(
  options: LocalBrowserRuntimeOptions,
): Promise<PersonalLocalBrowserHandle> {
  assertAbsolutePath(options.profileRoot, "Browser profile root");
  const bridgeToken = randomBytes(32).toString("base64url");
  const attachKeys = new BrowserAttachKeyRegistry(new Map());
  const ticketVerifier = await Ed25519AttachTicketVerifier.create({
    replayLedgerPath: defaultAttachTicketReplayLedgerPath(options.profileRoot),
    resolvePublicKey: (keyId) => attachKeys.resolve(keyId),
  });
  const launcher = new ElectronBrowserLauncher({
    downloads: options.downloads,
    localProfileRoot: options.profileRoot,
    pagePolicyPreloadPath: options.pagePolicyPreloadPath,
  });
  const preparation = launcher.prepare();
  const log = options.logPath ? new RotatingPersonalLog(options.logPath) : null;
  const diagnostics = new BoundedPersonalLog(16 * 1_024, [], (line) => log?.append("stderr", line));
  const profileStorage = { localProfiles: { root: options.profileRoot } };
  const runtime = new BrowserRuntime({
    onCheckpointFailure: ({ error, ...diagnostic }) =>
      logShutdownError(
        (_event, fields) =>
          diagnostics.append(
            `${JSON.stringify({ ...fields, ...diagnostic, event: "browser.profile.checkpoint.failed", reason: error.reason })}\n`,
          ),
        "browser-profile",
        diagnostic.phase,
        error,
        diagnostic.elapsedMs,
      ),
    onStartFailure: ({ correlationId, stage, error }) =>
      diagnostics.append(
        `${JSON.stringify({ event: "browser.session.start.failed", correlationId, stage, error: error instanceof Error ? error.stack : String(error) })}\n`,
      ),
    launcher,
    // Native data and its exclusive root ownership outlive enrollment slots.
    ...profileStorage,
    ...(options.checkpointIntervalMs !== undefined
      ? { checkpointIntervalMs: options.checkpointIntervalMs }
      : {}),
    profileStateClient: options.profileStateClient ?? new HttpBrowserProfileStateClient(),
    runtimeId: options.runtimeId,
    sessionFilesRoot: sessionFilesRoot(options.profileRoot),
    ...(options.loginAuthority ? { loginAuthority: options.loginAuthority } : {}),
    ticketVerifier,
  });
  const server = new BrowserRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    relayBridge: {
      token: bridgeToken,
      updateAttachKeys: (keys) => attachKeys.replaceRelayKeys(keys),
    },
    runtime,
  });
  try {
    await preparation;
    const address = await server.start();
    const unregisterPresentation = options.registerPresentationSource?.(runtime);
    return {
      bridgeToken,
      runtimeId: options.runtimeId,
      signIn: options.loginAuthority !== undefined,
      stop: async (signal) => {
        unregisterPresentation?.();
        const cancel = () => launcher.close();
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
          await server.close();
          launcher.close();
          log?.close();
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
      url: new URL(`http://${address.host}:${address.port}/`),
    };
  } catch (error) {
    await server.close().catch(() => undefined);
    launcher.close();
    log?.close();
    throw error;
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path.`);
  }
}
