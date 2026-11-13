/**
 * Whether `version` is at least `minimum`, compared as dotted numbers. A build
 * suffix (`2026.09.15-d2fe57e`, `0.162.0-alpha.1`) says nothing about age, and
 * a version that does not parse is never accepted.
 */
export function meetsMinimumVersion(version: string, minimum: string): boolean {
  const parse = (value: string) =>
    (value.trim().split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10));
  const found = parse(version);
  const required = parse(minimum);
  if (found.length === 0 || found.some((part) => !Number.isFinite(part))) return false;
  for (const [index, expected] of required.entries()) {
    const actual = found[index];
    if (actual === undefined || !Number.isFinite(actual)) return false;
    if (actual !== expected) return actual > expected;
  }
  return true;
}
