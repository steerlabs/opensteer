import { createId, type RunId, type RunnerId, type UserId } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  machineAccessPolicyDefault,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  ShellDataTicketClaimsSchema,
  type MachineAccessPolicy,
  type RoutedHostToShellModuleMessage,
  type RunnerAuxiliaryFrameFence,
  type ShellAuditEvent,
  type ShellCloseReason,
  type ShellDataTicketClaims,
  type ShellSessionId,
  type ShellSessionSummary,
} from "@opensteer/protocol";
import { vi } from "vitest";
import type { AgentControlRunScope } from "../agents/agent-control-service.js";
import type { ShellByteSocket } from "./shell-byte-pump.js";
import type { ShellControlPeer } from "./shell-control-stream.js";
import type { ShellHubOptions } from "./shell-hub.js";

export function auxiliaryStream(input: {
  readonly leaseExpiresAt?: string;
  readonly name?: string;
  readonly runnerId: RunnerId;
}): RunnerAuxiliaryStream {
  const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(
    `rax_${globalThis.crypto.randomUUID()}`,
  );
  const fence: RunnerAuxiliaryFrameFence = {
    auxiliaryStreamId,
    bootId: RunnerBootIdSchema.parse(`rbt_${globalThis.crypto.randomUUID()}`),
    connectionGeneration: 1,
    connectionId: RunnerConnectionIdSchema.parse(`rcn_${globalThis.crypto.randomUUID()}`),
    connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${globalThis.crypto.randomUUID()}`),
    module: "shell",
    runnerId: input.runnerId,
  };
  return {
    auxiliaryStreamId,
    fence,
    identity: {
      name: input.name ?? "example-mac",
      runnerId: input.runnerId,
    } as RunnerAuxiliaryStream["identity"],
    streamLeaseExpiresAt: input.leaseExpiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  };
}

export function controlPeer(options: { readonly stall?: boolean } = {}): ShellControlPeer & {
  readonly sent: RoutedHostToShellModuleMessage[];
  /** Whether this peer is currently holding a send open forever. */
  readonly stalled: { value: boolean };
} {
  const sent: RoutedHostToShellModuleMessage[] = [];
  const stalled = { value: false };
  return {
    close: vi.fn(),
    id: `peer:${globalThis.crypto.randomUUID()}`,
    send: async (message) => {
      sent.push(message);
      // A computer that accepted the socket and then stopped reading: the send
      // is neither delivered nor refused, it simply never finishes.
      if (options.stall) {
        stalled.value = true;
        await new Promise<void>(() => undefined);
      }
    },
    sent,
    stalled,
  };
}

/** A socket that records what it was told, and never blocks. */
export function byteSocket(): ShellByteSocket & {
  readonly closes: { code: number; reason: string }[];
  deliver(bytes: number): void;
  readonly sent: number[];
  readonly state: { paused: boolean; terminated: boolean };
} {
  const closes: { code: number; reason: string }[] = [];
  const sent: number[] = [];
  const state = { paused: false, terminated: false };
  let listener: ((data: Buffer, isBinary: boolean) => void) | undefined;
  const socket = {
    close: (code: number, reason: string) => closes.push({ code, reason }),
    closes,
    deliver: (bytes: number) => listener?.(Buffer.alloc(bytes, 7), true),
    on: (_event: "message", next: (data: Buffer, isBinary: boolean) => void) => {
      listener = next;
      return socket;
    },
    once: () => socket,
    pause: () => {
      state.paused = true;
    },
    readyState: 1,
    removeAllListeners: () => {
      listener = undefined;
      return socket;
    },
    resume: () => {
      state.paused = false;
    },
    send: (data: Buffer, _options: { readonly binary: true }, callback: () => void) => {
      sent.push(data.byteLength);
      callback();
    },
    sent,
    state,
    terminate: () => {
      state.terminated = true;
    },
  };
  return socket as unknown as ReturnType<typeof byteSocket>;
}

export interface FakeShellStore {
  readonly activated: ShellSessionId[];
  readonly ended: {
    readonly bytesIn: number;
    readonly bytesOut: number;
    readonly reason: ShellCloseReason;
    readonly sessionId: ShellSessionId;
  }[];
  readonly events: Map<ShellSessionId, ShellAuditEvent[]>;
  /** How many more `endShellSession` calls fail before one is allowed to land. */
  failEndWrites: number;
  /** How many more `appendShellEvents` batches fail before one lands. */
  failEventWrites: number;
  /** Held open, the promotion becomes the awaited step activation is inside. */
  gateActivate: (() => Promise<void>) | null;
  /** Held open, one session's ending never finishes being written. */
  gateEnd: ((sessionId: ShellSessionId) => Promise<void>) | null;
  /** Held open, audit persistence has accepted work but not completed it. */
  gateEvents: (() => Promise<void>) | null;
  /** Held open, the reservation row is still being inserted. */
  gateReserve: ((sessionId: ShellSessionId) => Promise<void>) | null;
  /** Held open, a policy read becomes the awaited step activation is inside. */
  gateTarget: (() => Promise<void>) | null;
  machine: {
    lastSeenAt: Date | null;
    name: string;
    policy: MachineAccessPolicy;
    revision: number;
    shell: { fullDiskAccess?: boolean; hostPublicKey: string; platform: "darwin" | "linux" } | null;
  };
  owner: UserId | null;
  /** Whether the target row exists at all, which a revoke takes away. */
  present: boolean;
  readonly reserved: ShellSessionId[];
  readonly rows: Map<ShellSessionId, { endedAt: Date | null; state: string }>;
  threadTitle: string | null;
}

export function fakeShellStore(
  owner: UserId,
): { readonly state: FakeShellStore } & ShellHubOptions["store"] {
  const state: FakeShellStore = {
    activated: [],
    ended: [],
    events: new Map(),
    failEndWrites: 0,
    failEventWrites: 0,
    gateActivate: null,
    gateEnd: null,
    gateEvents: null,
    gateReserve: null,
    gateTarget: null,
    machine: {
      lastSeenAt: new Date("2026-09-13T10:00:00.000Z"),
      name: "example-mac",
      policy: { ...machineAccessPolicyDefault, reach: "owner" },
      revision: 4,
      shell: { hostPublicKey: "ssh-ed25519 AAAA", platform: "darwin" },
    },
    owner,
    present: true,
    reserved: [],
    rows: new Map(),
    threadTitle: "Fix the deploy",
  };
  return {
    activateShellSession: async (sessionId: ShellSessionId) => {
      await state.gateActivate?.();
      const row = state.rows.get(sessionId);
      if (!row || row.state !== "pending" || row.endedAt) return false;
      row.state = "active";
      state.activated.push(sessionId);
      return true;
    },
    appendShellEvents: async (
      sessionId: ShellSessionId,
      entries: readonly { readonly at: Date; readonly event: ShellAuditEvent }[],
    ) => {
      await state.gateEvents?.();
      if (state.failEventWrites > 0) {
        state.failEventWrites -= 1;
        throw new Error("the request history could not be written");
      }
      const stored = state.events.get(sessionId) ?? [];
      stored.push(...entries.map((entry) => entry.event));
      state.events.set(sessionId, stored);
      return entries.length;
    },
    effectiveMachineOwner: async () => ({
      effectiveOwner: state.owner,
      ownerKind: "user" as const,
    }),
    endShellSession: async (input: {
      readonly bytesIn?: number;
      readonly bytesOut?: number;
      readonly reason: ShellCloseReason;
      readonly sessionId: ShellSessionId;
    }) => {
      await state.gateEnd?.(input.sessionId);
      if (state.failEndWrites > 0) {
        state.failEndWrites -= 1;
        throw new Error("the session row could not be written");
      }
      const row = state.rows.get(input.sessionId);
      if (!row || row.endedAt) return { ended: false };
      row.endedAt = new Date();
      row.state = "ended";
      state.ended.push({
        bytesIn: input.bytesIn ?? 0,
        bytesOut: input.bytesOut ?? 0,
        reason: input.reason,
        sessionId: input.sessionId,
      });
      return { ended: true };
    },
    getMachineAccessTarget: async () => {
      await state.gateTarget?.();
      return state.present
        ? {
            lastSeenAt: state.machine.lastSeenAt,
            name: state.machine.name,
            policy: state.machine.policy,
            revision: state.machine.revision,
            shell: state.machine.shell,
          }
        : null;
    },
    getThreadForOwner: async () =>
      state.threadTitle === null ? null : ({ title: state.threadTitle } as never),
    reserveShellSession: async (input: { readonly sessionId: ShellSessionId }) => {
      await state.gateReserve?.(input.sessionId);
      state.reserved.push(input.sessionId);
      state.rows.set(input.sessionId, { endedAt: null, state: "pending" });
    },
    state,
  } as unknown as { readonly state: FakeShellStore } & ShellHubOptions["store"];
}

/** A signer that mints claims directly, so a test can mutate them. */
export function fakeTicketAuthenticator() {
  const issued = new Map<string, ShellDataTicketClaims>();
  const burned = new Set<string>();
  return {
    burned,
    issued,
    issueShellDataTicket: (input: {
      readonly fence: RunnerAuxiliaryFrameFence;
      readonly sessionId: ShellSessionId;
    }) => {
      const claims = ShellDataTicketClaimsSchema.parse({
        ...input.fence,
        audience: "opensteer-shell-data",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        issuedAt: new Date().toISOString(),
        module: "shell",
        nonce: globalThis.crypto.randomUUID().replaceAll("-", "").padEnd(32, "a"),
        sessionId: input.sessionId,
        type: "opensteer.shell.data-ticket",
      });
      const ticket = `ticket-${issued.size}`;
      issued.set(ticket, claims);
      return { claims, ticket };
    },
    verifyShellDataTicket: (ticket: string) => {
      const claims = issued.get(ticket);
      if (!claims) throw new Error("unknown ticket");
      if (burned.has(claims.nonce)) throw new Error("That ticket was already used");
      burned.add(claims.nonce);
      return claims;
    },
  };
}

export function runScope(input: {
  readonly requestedBy: UserId;
  readonly runId?: RunId;
  readonly runnerId: RunnerId;
}): AgentControlRunScope {
  return {
    bindingGeneration: 1,
    capabilityProfileId: "workspace",
    environmentId: createId("environment"),
    membershipGeneration: 1,
    requestedBy: input.requestedBy,
    runId: input.runId ?? createId("run"),
    runnerBootId: "boot",
    runnerId: input.runnerId,
    threadId: createId("thread"),
    workspaceId: createId("workspace"),
  } as AgentControlRunScope;
}

export function recordingNotifier() {
  const started: { readonly runnerId: RunnerId; readonly session: ShellSessionSummary }[] = [];
  const ended: {
    readonly endReason: ShellCloseReason;
    readonly runnerId: RunnerId;
    readonly session: ShellSessionSummary;
  }[] = [];
  return {
    ended: (input: (typeof ended)[number]) => ended.push(input),
    endedCalls: ended,
    started: (input: (typeof started)[number]) => started.push(input),
    startedCalls: started,
  };
}
