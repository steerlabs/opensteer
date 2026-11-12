import { linkPersonalHostAccount } from "@opensteer/client/host";
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
      throw new Error("Finish signing in in your browser, then press Turn on again.");
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
  const portal = shell.snapshot.identityConfig?.portalOrigin;
  if (!portal) throw new Error("This deployment has no Account portal configured.");
  const origin = new URL(portal).origin;
  const nonce = globalThis.crypto.randomUUID();
  const url = new URL("/personal-host-link", origin);
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("nonce", nonce);
  const popup = window.open(url, "_blank", "popup,width=520,height=640");
  if (!popup) throw new Error("Allow the Account sign-in window, then try again.");
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
      const error = new Error("Account linking was cancelled.");
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
    if (data.error) call.reject(new Error("Account linking did not finish. Try again."));
    else call.resolve(data.result);
  };
  window.addEventListener("message", receive);
  const timeout = setTimeout(() => {
    rejectReady?.(new Error("Account linking expired. Try again."));
    for (const call of pending.values())
      call.reject(new Error("Account linking expired. Try again."));
    popup.close();
  }, 5 * 60_000);
  const call = (kind: string, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(kind, { resolve, reject });
      popup.postMessage({ kind, input, nonce }, origin);
    });
  try {
    await readiness;
    await linkPersonalHostAccount(
      shell.hostClient,
      {
        issuePersonalHostAccountLinkChallenge: async (input) =>
          IssuePersonalHostAccountLinkChallengeResponseSchema.parse(await call("challenge", input)),
        completePersonalHostAccountLink: async (_challengeId, input) =>
          CompletePersonalHostAccountLinkResponseSchema.parse(await call("complete", input)),
      },
      status.authorityEnvelope,
      name,
    );
  } finally {
    clearTimeout(timeout);
    window.removeEventListener("message", receive);
    popup.close();
  }
}
