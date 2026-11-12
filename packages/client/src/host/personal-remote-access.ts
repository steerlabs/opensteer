import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";
import type { HostClient } from "./client.js";
import type {
  PersonalRemoteAdministrationIntent,
  PersonalRemoteAdministrationStatus,
  IssuePersonalPairingCodeResponse,
} from "@opensteer/protocol";
import type { AccountDeploymentDirectoryService } from "../connections/account-deployment-directory.js";
import { PersonalHostAccountLinkOperationIdSchema } from "@opensteer/control-plane-protocol";

export const remoteAccessDisconnectWarning =
  "Changing remote access or unlinking the Account can sign out this device and other connected devices. You may need to return to the computer to connect again.";

export async function requestPersonalRemoteAccess(
  client: Pick<HostClient, "dispatch">,
  intent: PersonalRemoteAdministrationIntent,
) {
  const result = await client.dispatch({
    type: "personal.remoteAccess.request",
    intent,
    idempotencyKey: mutationIdempotencyKey("personal-remote-access"),
  });
  if (result.type !== "personal.remoteAccess.request")
    throw new Error("Unexpected remote access response");
  return result.operation;
}

export async function removeHostSession(
  client: Pick<HostClient, "dispatch">,
  sessionId: import("@opensteer/core").AuthSessionId,
): Promise<void> {
  await client.dispatch({
    type: "session.revoke",
    sessionId,
    idempotencyKey: mutationIdempotencyKey("session"),
  });
}

/** The device signing in is the courier; only Host and Account receive link credentials. */
export async function linkPersonalHostAccount(
  client: Pick<HostClient, "dispatch">,
  account: Pick<
    AccountDeploymentDirectoryService,
    "issuePersonalHostAccountLinkChallenge" | "completePersonalHostAccountLink"
  >,
  authorityEnvelope: import("@opensteer/deployment-authority").HostDiscoveryEnvelope,
  name: string,
): Promise<void> {
  const operationId = PersonalHostAccountLinkOperationIdSchema.parse(
    `plo_${globalThis.crypto.randomUUID()}`,
  );
  const challenge = await account.issuePersonalHostAccountLinkChallenge({
    authorityEnvelope,
    name,
    operationId,
  });
  const approved = await client.dispatch({
    type: "personal.accountLink.approve",
    challenge,
    idempotencyKey: mutationIdempotencyKey("account-link-proof"),
  });
  if (approved.type !== "personal.accountLink.approve")
    throw new Error("Unexpected Account proof response");
  const completion = await account.completePersonalHostAccountLink(challenge.challengeId, {
    challengeCredential: challenge.challengeCredential,
    proof: approved.proof,
  });
  await client.dispatch({
    type: "personal.accountLink.complete",
    completion,
    idempotencyKey: mutationIdempotencyKey("account-link-complete"),
  });
}

/** Finishes an `activating` link through the Host; a fresh challenge would be refused. */
export async function resumePersonalHostAccountLink(
  client: Pick<HostClient, "dispatch">,
): Promise<void> {
  const resumed = await client.dispatch({
    type: "personal.accountLink.resume",
    idempotencyKey: mutationIdempotencyKey("account-link-resume"),
  });
  if (resumed.type !== "personal.accountLink.resume")
    throw new Error("Unexpected Account link response");
}

export interface PersonalRemoteAccessClientSnapshot {
  readonly status: PersonalRemoteAdministrationStatus | null;
  readonly error: string | null;
  readonly pairing: IssuePersonalPairingCodeResponse | null;
  readonly working: boolean;
}

export class PersonalRemoteAccessClient {
  readonly #client: Pick<HostClient, "rpc" | "dispatch" | "subscribePersonalRemoteAccess">;
  readonly #listeners = new Set<() => void>();
  #snapshot: PersonalRemoteAccessClientSnapshot = {
    status: null,
    error: null,
    pairing: null,
    working: false,
  };
  #watch: AbortController | null = null;

  constructor(client: Pick<HostClient, "rpc" | "dispatch" | "subscribePersonalRemoteAccess">) {
    this.#client = client;
  }
  getSnapshot = (): PersonalRemoteAccessClientSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): () => void {
    const controller = new AbortController();
    this.#watch?.abort();
    this.#watch = controller;
    this.#observe(controller.signal);
    return () => controller.abort();
  }

  #observe(signal: AbortSignal): void {
    let reading = false;
    let invalidated = false;
    const refresh = async (): Promise<void> => {
      if (signal.aborted) return;
      if (reading) {
        invalidated = true;
        return;
      }
      reading = true;
      invalidated = false;
      try {
        const status = unwrapRpcResult(
          await this.#client.rpc["personal.remoteAccess.get"]({}, { signal }),
        );
        if (signal.aborted) return;
        this.#set({
          status,
          error: null,
          pairing:
            this.#snapshot.status?.access.generation === status.access.generation
              ? this.#snapshot.pairing
              : null,
        });
      } catch (error) {
        if (!signal.aborted)
          this.#set({
            error:
              error instanceof Error ? error.message : "Remote access status could not be loaded.",
          });
      } finally {
        reading = false;
        if (invalidated && !signal.aborted) void refresh();
      }
    };
    const detach = this.#client.subscribePersonalRemoteAccess(() => void refresh());
    signal.addEventListener("abort", detach, { once: true });
    void refresh();
  }

  request = async (intent: PersonalRemoteAdministrationIntent): Promise<void> => {
    await this.#run(async () => {
      await requestPersonalRemoteAccess(this.#client, intent);
      this.#set({ pairing: null });
    });
  };

  pair = async (): Promise<void> => {
    await this.#run(async () => {
      const result = await this.#client.dispatch({
        type: "personal.remoteAccess.pairing.create",
        idempotencyKey: mutationIdempotencyKey("pairing"),
      });
      if (result.type !== "personal.remoteAccess.pairing.create")
        throw new Error("Unexpected pairing response");
      this.#set({ pairing: result.pairing });
    });
  };

  async #run(operation: () => Promise<void>): Promise<void> {
    if (this.#snapshot.working) return;
    this.#set({ working: true, error: null });
    try {
      await operation();
    } catch (error) {
      this.#set({ error: error instanceof Error ? error.message : "Remote access change failed." });
    } finally {
      this.#set({ working: false });
    }
  }

  #set(change: Partial<PersonalRemoteAccessClientSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
