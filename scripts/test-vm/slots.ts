/**
 * How many macOS guests this machine runs at once: two, Apple's licence limit
 * and what the runner's running-guest check allows, unless `OPENSTEER_VM_SLOTS`
 * names one for a machine with less room. Any
 * other value is an error, never a silent default.
 */
export function vmSlotCount(environment: NodeJS.ProcessEnv = process.env): number {
  const value = environment.OPENSTEER_VM_SLOTS;
  if (value === undefined) return 2;
  if (value !== "1" && value !== "2")
    throw new Error(
      `OPENSTEER_VM_SLOTS must be 1 or 2 (Apple's licence allows two macOS guests), not ${JSON.stringify(value)}`,
    );
  return Number(value);
}
