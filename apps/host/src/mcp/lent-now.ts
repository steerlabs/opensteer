import type { AgentGrant, UserId } from "@opensteer/core";
import type { GrantedDeviceApproval, IntegrationRequesterLent } from "@opensteer/database";
import { callerLineage, type AgentCaller } from "./agent-caller.js";

/**
 * What a connection's lineage (the connection, or a Run or automation under its grant) is lent
 * now of the person's device approvals: the one rule's answer (`grantedDeviceApprovals`), with the
 * grant it was read for. Everything that shows or names a device, an app, an approval or a tool to
 * a connection takes it from here, never from the grant's own resources.
 */
export interface LentNow extends IntegrationRequesterLent {
  readonly approvalIds: ReadonlySet<string>;
  readonly deviceIds: ReadonlySet<string>;
}

/** Reads the one rule for an owner and a grant. */
export type LendingReader = (
  ownerUserId: UserId,
  grant: AgentGrant,
) => Promise<readonly GrantedDeviceApproval[]>;

const read = new WeakMap<AgentCaller, Promise<LentNow | null>>();

/**
 * The rule read once per call: every handler and lookup the call reaches with the same caller
 * shares it. Null, with no query, for the person's own work and their own agents.
 */
export function lentNow(caller: AgentCaller, reader: LendingReader): Promise<LentNow | null> {
  const lineage = callerLineage(caller);
  if (!lineage) return Promise.resolve(null);
  let lent = read.get(caller);
  if (!lent) {
    lent = reader(caller.userId, lineage.grant).then((approvals) => ({
      grant: lineage.grant,
      approvals,
      approvalIds: new Set(approvals.map(({ id }) => id.toLowerCase())),
      deviceIds: new Set(approvals.map(({ deviceId }) => deviceId)),
    }));
    // A failed read is not kept: the next asks again.
    lent.catch(() => read.delete(caller));
    read.set(caller, lent);
  }
  return lent;
}

/**
 * What is lent is read once per listing, and never outlives a wait: after the person answered a
 * held Request, and before each call a program makes, the next read asks the rule again. A call
 * that does not wait reads it once, as before.
 */
export function forgetLent(caller: AgentCaller): void {
  read.delete(caller);
}

/**
 * The person's devices this lineage may learn of: a selected grant, the devices of what it is lent
 * now; a grant of everything, every device of the person (a device is not an approval); the
 * person's own work and their own agents, every device.
 */
export function lentDevice(lent: LentNow | null): (deviceId: string) => boolean {
  if (!lent || lent.grant.scope !== "selected") return () => true;
  return (deviceId) => lent.deviceIds.has(deviceId);
}

/** The requester fields that hand a store read what the caller was lent, so it reads no more. */
export function lentRequester(lent: LentNow | null): { readonly lent?: IntegrationRequesterLent } {
  return lent ? { lent: { grant: lent.grant, approvals: lent.approvals } } : {};
}
