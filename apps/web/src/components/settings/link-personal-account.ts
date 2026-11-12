import {
  linkPersonalHostAccount,
  RemoteAccessPortError,
  type HostClient,
} from "@opensteer/client/host";
import {
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  CompletePersonalHostAccountLinkResponseSchema,
} from "@opensteer/protocol";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import type { ShellContext } from "../app-shell.js";

export async function linkAccountFromWeb(
  shell: ShellContext,
  status: PersonalRemoteAdministrationStatus,
  name: string,
): Promise<void> {
  const bridge = shell.desktopBridge;
  if (bridge?.issuePersonalAccountLinkChallenge && bridge.completePersonalAccountLink) {
    if (shell.deploymentAccess?.account.status !== "signed-in") {
      await bridge.signIn();
      throw new Error("Finish Account sign-in on this device, then tap Link Account again.");
    }
    await linkPersonalHostAccount(
      shell.hostClient,
      {
        issuePersonalHostAccountLinkChallenge: (input) =>
          bridge.issuePersonalAccountLinkChallenge!(input),
        completePersonalHostAccountLink: (_challengeId, input) =>
          bridge.completePersonalAccountLink!(input),
      },
      status.authorityEnvelope,
      name,
    );
    return;
  }
  await linkAccountThroughPortal({
    authorityEnvelope: status.authorityEnvelope,
    hostClient: shell.hostClient,
    name,
    portalOrigin: shell.snapshot.identityConfig?.portalOrigin ?? null,
  });
}

/**
 * A plain browser links through the Account portal in a popup: the portal
 * signs the person in and is the courier for the link credentials. Every
 * failure is a sentence a person can read.
 */
export async function linkAccountThroughPortal(input: {
  readonly authorityEnvelope: PersonalRemoteAdministrationStatus["authorityEnvelope"];
  readonly hostClient: Pick<HostClient, "dispatch">;
  readonly name: string;
  readonly portalOrigin: string | null;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const portal = input.portalOrigin;
  if (!portal) throw new RemoteAccessPortError("Opensteer accounts aren’t available here.");
  const origin = new URL(portal).origin;
  const nonce = globalThis.crypto.randomUUID();
  const url = new URL("/personal-host-link", origin);
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("nonce", nonce);
  const popup = window.open(url, "_blank", "popup,width=520,height=640");
  if (!popup) throw new RemoteAccessPortError("Allow the sign-in window to open, then try again.");
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let ready: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.origin !== origin ||
      event.source !== popup ||
      typeof event.data !== "object" ||
      event.data === null
    )
      return;
    const data = event.data as Record<string, unknown>;
    if (data.nonce !== nonce) return;
    if (data.kind === "cancelled") {
      const error = new RemoteAccessPortError("Signing in was cancelled.");
      rejectReady?.(error);
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      return;
    }
    if (data.kind === "ready") {
      ready?.();
      return;
    }
    const call = typeof data.kind === "string" ? pending.get(data.kind) : undefined;
    if (!call) return;
    pending.delete(String(data.kind));
    if (data.error)
      call.reject(
        new RemoteAccessPortError("Adding this computer to your account didn’t finish. Try again."),
      );
    else call.resolve(data.result);
  };
  window.addEventListener("message", receive);
  const stop = (error: Error) => {
    rejectReady?.(error);
    for (const call of pending.values()) call.reject(error);
    popup.close();
  };
  const timeout = setTimeout(
    () => stop(new RemoteAccessPortError("Signing in took too long. Try again.")),
    5 * 60_000,
  );
  const abort = () => stop(new RemoteAccessPortError("Signing in was cancelled."));
  input.signal?.addEventListener("abort", abort, { once: true });
  const call = (kind: string, payload: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(kind, { resolve, reject });
      popup.postMessage({ kind, input: payload, nonce }, origin);
    });
  try {
    await readiness;
    await linkPersonalHostAccount(
      input.hostClient,
      {
        issuePersonalHostAccountLinkChallenge: async (challenge) =>
          IssuePersonalHostAccountLinkChallengeResponseSchema.parse(
            await call("challenge", challenge),
          ),
        completePersonalHostAccountLink: async (_challengeId, completion) =>
          CompletePersonalHostAccountLinkResponseSchema.parse(await call("complete", completion)),
      },
      input.authorityEnvelope,
      input.name,
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
    window.removeEventListener("message", receive);
    popup.close();
  }
}
