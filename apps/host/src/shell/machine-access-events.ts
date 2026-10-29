import type { RunnerId, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import type {
  ComputerUseSessionId,
  ShellCloseReason,
  ShellSessionSummary,
} from "@opensteer/protocol";

/**
 * Who hears that a session on one computer started or ended.
 *
 * Deliberately not the caller's Workspace: the people who need to know a
 * machine is being used are the people who decide whether it may be, and they
 * are usually nowhere near the Thread that connected. These are notifications
 * about a machine, never durable Workspace events, so they are addressed to
 * managers directly and never enter event replay.
 */
/**
 * Tells every connected client that the computers list changed.
 *
 * The message names nothing — not the machine, not what happened to it —
 * because every client answers it by rereading the list, and the reread is
 * where authorization lives. That is exactly what lets this one go to everybody
 * while the two `host.machine.access.session.*` messages below, which carry
 * facts about one machine, stay addressed to that machine's managers.
 */
export function notifyMachinesChanged(realtime: Pick<RealtimeHub, "broadcast">): void {
  realtime.broadcast({ type: "host.machines.changed" });
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
  }): void;
  started(input: { readonly runnerId: RunnerId; readonly session: ShellSessionSummary }): void;
}

export function machineAccessNotifier(options: {
  readonly onError: (error: unknown) => void;
  readonly realtime: Pick<RealtimeHub, "connectedUserIds" | "sendToUsers">;
  readonly store: Pick<OpensteerStore, "effectiveMachineOwner" | "userById">;
}): MachineAccessNotifier {
  const deliver = (runnerId: RunnerId, message: Parameters<RealtimeHub["sendToUsers"]>[1]) => {
    void (async () => {
      const recipients = await machineManagers(options, runnerId);
      if (recipients.length > 0) options.realtime.sendToUsers(recipients, message);
    })().catch(options.onError);
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

/**
 * The managers of one computer who are connected right now.
 *
 * Administrators are resolved against the live connections rather than the
 * user table: authorization is asked only about someone already listening, so
 * a Deployment with many administrators costs one lookup per open page and not
 * one per account.
 */
async function machineManagers(
  options: {
    readonly realtime: Pick<RealtimeHub, "connectedUserIds">;
    readonly store: Pick<OpensteerStore, "effectiveMachineOwner" | "userById">;
  },
  runnerId: RunnerId,
): Promise<readonly UserId[]> {
  const connected = options.realtime.connectedUserIds();
  if (connected.length === 0) return [];
  const ownership = await options.store.effectiveMachineOwner(runnerId);
  if (!ownership) return [];
  const recipients = new Set<UserId>();
  for (const userId of connected) {
    if (userId === ownership.effectiveOwner) {
      recipients.add(userId);
      continue;
    }
    if (ownership.ownerKind !== "deployment") continue;
    const user = await options.store.userById(userId);
    if (user?.instanceRole === "administrator" && !user.disabledAt) recipients.add(userId);
  }
  return [...recipients];
}
