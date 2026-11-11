import type { BootstrapNoticeSource } from "@opensteer/shared/bootstrapDiagnostics";
import type { RunnerId, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import type {
  ComputerUseSessionId,
  ShellCloseReason,
  ShellSessionSummary,
} from "@opensteer/protocol";

/**
 * Tells every connected client that the computers list changed.
 *
 * The message names nothing — not the machine, not what happened to it —
 * because every client answers it by rereading the list, and the reread is
 * where authorization lives. That is exactly what lets this one go to everybody
 * while the two `host.machine.access.session.*` messages below, which carry
 * facts about one machine, stay addressed to that machine's owner.
 */
export function notifyMachinesChanged(
  realtime: Pick<RealtimeHub, "broadcast">,
  source: BootstrapNoticeSource = "unspecified",
): void {
  realtime.broadcast({ type: "host.machines.changed" }, source);
}

/**
 * Which apps on a Mac an agent is acting in now, for each changed session.
 * Unlike the list notice, it carries facts about one machine, so it goes only
 * to the Mac's owner, whose machines list is where those sessions are shown;
 * the client patches the session in place rather than rereading the list.
 */
export function notifyComputerPresence(
  realtime: Pick<RealtimeHub, "sendToUsers">,
  ownerUserId: UserId,
  sessions: readonly {
    readonly actingAppKeys: readonly string[];
    readonly actingDisplay?: boolean;
    readonly sessionId: ComputerUseSessionId;
  }[],
): void {
  if (sessions.length === 0) return;
  realtime.sendToUsers([ownerUserId], {
    sessions: sessions.map((session) => ({
      actingAppKeys: [...session.actingAppKeys],
      ...(session.actingDisplay === undefined ? {} : { actingDisplay: session.actingDisplay }),
      sessionId: session.sessionId,
    })),
    type: "host.computer-presence",
  });
}

export interface MachineAccessNotifier {
  ended(input: {
    readonly endReason: ShellCloseReason;
    readonly runnerId: RunnerId;
    readonly session: ShellSessionSummary;
  }): Promise<void>;
  started(input: {
    readonly runnerId: RunnerId;
    readonly session: ShellSessionSummary;
  }): Promise<void>;
}

export function machineAccessNotifier(options: {
  readonly onError: (error: unknown) => void;
  readonly realtime: Pick<RealtimeHub, "connectedUserIds" | "sendToUsers">;
  readonly store: Pick<OpensteerStore, "effectiveMachineOwner" | "userById">;
}): MachineAccessNotifier {
  const deliver = async (
    runnerId: RunnerId,
    message: Parameters<RealtimeHub["sendToUsers"]>[1],
  ): Promise<void> => {
    try {
      const recipients = await machineOwners(options, runnerId);
      if (recipients.length) options.realtime.sendToUsers(recipients, message, "machine.access");
    } catch (error) {
      options.onError(error);
    }
  };
  return {
    ended: ({ endReason, runnerId, session }) =>
      deliver(runnerId, {
        endReason,
        runnerId,
        session,
        type: "host.machine.access.session.ended",
      }),
    started: ({ runnerId, session }) =>
      deliver(runnerId, { runnerId, session, type: "host.machine.access.session.started" }),
  };
}

async function machineOwners(
  options: {
    realtime: Pick<RealtimeHub, "connectedUserIds">;
    store: Pick<OpensteerStore, "effectiveMachineOwner" | "userById">;
  },
  runnerId: RunnerId,
): Promise<readonly UserId[]> {
  const ownership = await options.store.effectiveMachineOwner(runnerId);
  const ownerId = ownership?.effectiveOwner;
  if (!ownerId || !options.realtime.connectedUserIds().includes(ownerId)) return [];
  const owner = await options.store.userById(ownerId);
  return owner && !owner.disabledAt ? [ownerId] : [];
}
