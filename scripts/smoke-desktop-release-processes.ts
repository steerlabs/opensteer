/** Select only descendants of the process this check launched. */
export function descendantPids(table: string, root: number): number[] {
  const rows = table
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/u).map(Number));
  const owned = new Set([root]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent] of rows) {
      if (pid && parent && owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        added = true;
      }
    }
  }
  owned.delete(root);
  return [...owned];
}
