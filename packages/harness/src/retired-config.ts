/**
 * Removes account configuration keys a driver no longer reads. A Runner can be
 * newer than the Host it serves — a Desktop lends its computer to whatever
 * Deployment it joins — and that Host may still store a key the Host's own
 * migration would have removed. A strict driver schema must read such an
 * account, not refuse it, so the retired keys are dropped before it parses.
 */
export function withoutRetiredConfigKeys(keys: readonly string[]): (value: unknown) => unknown {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  };
}
