export interface PickPageTargetIdOptions {
  readonly requirePreferred?: boolean;
  readonly currentTargetId?: string | null;
  readonly allowArbitraryFallback?: boolean;
}

export function pickPageTargetId(
  targetIds: Iterable<string>,
  preferredTargetId: string | null,
  options: PickPageTargetIdOptions = {},
): string | null {
  const ids = [...targetIds];
  if (ids.length === 0) {
    return null;
  }

  if (preferredTargetId) {
    const preferred = ids.find((targetId) => targetId === preferredTargetId);
    if (preferred) {
      return preferred;
    }
    if (options.requirePreferred) {
      return null;
    }
  }

  if (options.currentTargetId) {
    const currentTarget = ids.find((targetId) => targetId === options.currentTargetId);
    if (currentTarget) {
      return currentTarget;
    }
  }

  if (ids.length === 1) {
    return ids[0]!;
  }

  if (options.allowArbitraryFallback) {
    return ids[0]!;
  }

  return null;
}
