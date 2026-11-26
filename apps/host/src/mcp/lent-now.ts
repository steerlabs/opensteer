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

/**
 * A device as a selected grant reads it: what the approvals it holds there need, and nothing of
 * the apps, data stores, permissions or capabilities it does not hold (rule 5). Its name, whether
 * it is online, its Apps switch, and the state of each app it holds; for a Mac app, whether
 * computer use is ready there; for a phone screen, the screen's own state.
 */
export function lentMachineView(
  machine: { readonly id: string } & Record<string, unknown>,
  held: readonly Pick<GrantedDeviceApproval, "definitionId" | "target">[],
): Record<string, unknown> {
  const definitions = new Set(held.flatMap(({ definitionId }) => definitionId ?? []));
  const app = (kind: "mac-app" | "phone-screen") =>
    held.some(({ target }) => target.kind === "computer-app" && target.app.kind === kind);
  const access = machine.access as { readonly policy?: { readonly apps?: unknown } } | undefined;
  const computerUse = machine.computerUse as
    { readonly state?: unknown; readonly detail?: unknown } | undefined;
  const apps = Array.isArray(machine.apps)
    ? (machine.apps as readonly { readonly definitionId?: unknown }[]).filter(
        ({ definitionId }) => typeof definitionId === "string" && definitions.has(definitionId),
      )
    : [];
  return {
    id: machine.id,
    name: machine.name,
    kind: machine.kind,
    status: machine.status,
    access: { policy: { apps: access?.policy?.apps ?? null } },
    apps,
    ...(app("mac-app") && computerUse
      ? { computerUse: { state: computerUse.state ?? null, detail: computerUse.detail ?? null } }
      : {}),
    ...(app("phone-screen") ? { phoneDisplay: machine.phoneDisplay ?? null } : {}),
  };
}
