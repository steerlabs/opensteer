import { createPublicKey, type KeyObject } from "node:crypto";
import {
  BrowserPoolAgentUnavailable,
  callBrowserPoolAgentAdmin,
  type BrowserPoolAgentAdminRequest,
  type BrowserPoolAgentSlotSummary,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import type {
  BrowserPoolHostId,
  BrowserPoolSlotGuestConfig,
  BrowserPoolSlotId,
  ManagedBrowserPoolPublicKeys,
} from "@opensteer/control-plane-protocol";

export interface PoolAgentTarget {
  readonly hostId: BrowserPoolHostId;
  readonly internalIp: string;
  readonly adminPort: number;
  readonly hostKeySpki: string;
}

export interface PoolAgentDeleteEvidence {
  readonly erased: boolean;
  readonly profileErased: boolean;
  readonly credentialsErased: boolean;
}

export interface PoolAgentClient {
  list(
    target: PoolAgentTarget,
    signal: AbortSignal,
  ): Promise<readonly BrowserPoolAgentSlotSummary[]>;
  create(
    target: PoolAgentTarget,
    input: {
      readonly slotId: BrowserPoolSlotId;
      readonly term: number;
      readonly keys: ManagedBrowserPoolPublicKeys;
      readonly guest: BrowserPoolSlotGuestConfig;
    },
    signal: AbortSignal,
  ): Promise<BrowserPoolAgentSlotSummary>;
  replaceKey(
    target: PoolAgentTarget,
    input: {
      readonly slotId: BrowserPoolSlotId;
      readonly term: number;
      readonly keys: ManagedBrowserPoolPublicKeys;
    },
    signal: AbortSignal,
  ): Promise<BrowserPoolAgentSlotSummary>;
  delete(
    target: PoolAgentTarget,
    input: {
      readonly slotId: BrowserPoolSlotId;
      readonly term: number;
      readonly eraseProfile: boolean;
    },
    signal: AbortSignal,
  ): Promise<PoolAgentDeleteEvidence>;
}

/**
 * Only a verified signed `conflict`, `unknown-slot`, or `profile-disk-missing` proves the agent
 * did not complete the mutation (on `profile-disk-missing`, a create made nothing and a delete
 * never erased the profile or answered `profileErased`, so repeating the same delete once the
 * mount returns finishes cleanly). A signed `unavailable` means the host answered but could not
 * finish; unsigned refusals and transport/signature errors arrive with no refusal code and stay unknown.
 */
export function isDefiniteAgentRefusal(error: unknown): error is BrowserPoolAgentUnavailable {
  return (
    error instanceof BrowserPoolAgentUnavailable &&
    (error.refusal === "conflict" ||
      error.refusal === "unknown-slot" ||
      error.refusal === "profile-disk-missing")
  );
}

export function httpPoolAgentClient(options: {
  readonly provisionerKey: KeyObject;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}): PoolAgentClient {
  const invoke = async (
    target: PoolAgentTarget,
    request: BrowserPoolAgentAdminRequest,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const hostKey = createPublicKey({
      key: Buffer.from(target.hostKeySpki, "base64"),
      format: "der",
      type: "spki",
    });
    const baseFetch = options.fetch ?? fetch;
    const abortAwareFetch: typeof fetch = (input, init) =>
      baseFetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
    return callBrowserPoolAgentAdmin(
      {
        url: `http://${target.internalIp}:${target.adminPort}`,
        host: target.hostId,
        hostKey,
        provisionerKey: options.provisionerKey,
        fetch: abortAwareFetch,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
      request,
    );
  };

  return {
    async list(target, signal) {
      const reply = await invoke(target, { op: "list" }, signal);
      if (reply.op !== "list") {
        throw new BrowserPoolAgentUnavailable("Unexpected reply to browser pool list request.");
      }
      return reply.slots;
    },
    async create(target, input, signal) {
      const reply = await invoke(
        target,
        {
          op: "create",
          slotId: input.slotId,
          term: input.term,
          homeKey: input.keys.homeKey,
          relayKey: input.keys.relayKey,
          ticketKey: input.keys.ticketKey,
          guest: {
            vcpus: input.guest.vcpus,
            memoryMib: input.guest.memoryMib,
            profileMib: input.guest.profileMib,
          },
        },
        signal,
      );
      if (reply.op !== "create") {
        throw new BrowserPoolAgentUnavailable("Unexpected reply to browser pool create request.");
      }
      return reply.slot;
    },
    async replaceKey(target, input, signal) {
      const reply = await invoke(
        target,
        {
          op: "replace-key",
          slotId: input.slotId,
          term: input.term,
          homeKey: input.keys.homeKey,
          relayKey: input.keys.relayKey,
          ticketKey: input.keys.ticketKey,
        },
        signal,
      );
      if (reply.op !== "replace-key") {
        throw new BrowserPoolAgentUnavailable(
          "Unexpected reply to browser pool replace-key request.",
        );
      }
      return reply.slot;
    },
    async delete(target, input, signal) {
      const reply = await invoke(
        target,
        {
          op: "delete",
          slotId: input.slotId,
          term: input.term,
          eraseProfile: input.eraseProfile,
        },
        signal,
      );
      if (reply.op !== "delete") {
        throw new BrowserPoolAgentUnavailable("Unexpected reply to browser pool delete request.");
      }
      return {
        erased: reply.erased,
        profileErased: reply.profileErased === true,
        credentialsErased: reply.credentialsErased === true,
      };
    },
  };
}
