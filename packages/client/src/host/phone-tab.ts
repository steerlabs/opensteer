import type { MachineSummary } from "@opensteer/protocol";

type PhoneMachine = Pick<MachineSummary, "computerUse" | "tabOpenedAt">;

/** The one row and address a phone has, whoever is in it. */
export function phonePlaceKey(machineId: string): string {
  return `phone:${machineId}`;
}

/** One task holds a phone's whole display at a time. */
export function phoneTaskSession(machine: PhoneMachine) {
  return machine.computerUse?.sessions.find(({ display }) => display) ?? null;
}

export function phoneOwnerView(machine: PhoneMachine) {
  return (
    machine.computerUse?.ownerViews?.find(
      (view) => view.target.kind === "phone" && view.state !== "closed",
    ) ?? null
  );
}

/**
 * Whether a phone has a tab. A live session or view lists it before the Host's
 * record of the tab arrives, and on a Host too old to keep one.
 */
export function phoneTabOpen(machine: PhoneMachine): boolean {
  return (
    Boolean(machine.tabOpenedAt) ||
    phoneTaskSession(machine) !== null ||
    phoneOwnerView(machine) !== null
  );
}
