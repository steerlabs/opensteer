export function browserMemoryBudgetBytes(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const megabytes = Number(value);
  if (
    !Number.isSafeInteger(megabytes) ||
    megabytes < 1 ||
    !Number.isSafeInteger(megabytes * 1024 ** 2)
  )
    throw new Error("OPENSTEER_BROWSER_MEMORY_BUDGET_MB must be a positive integer in MiB.");
  return megabytes * 1024 ** 2;
}
