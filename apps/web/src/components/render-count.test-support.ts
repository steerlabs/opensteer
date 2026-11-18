// Import this before anything that loads react-dom: React finds the hook only when it starts.

interface Fiber {
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly return: Fiber | null;
  readonly flags: number;
  readonly key: string | null;
  readonly type: unknown;
  readonly elementType: unknown;
}

/** React marks a fiber whose component ran in this render. */
const performedWork = 1;

let counting: Map<string, Map<string, number>> | null = null;
/**
 * Each root's fibers as last committed. A subtree React skipped keeps its old
 * fibers, flags and all; a fiber it rendered is the other copy, absent here.
 */
const committed = new WeakMap<object, WeakSet<Fiber>>();

function nameOf(fiber: Fiber): string | null {
  const type = (fiber.elementType ?? fiber.type) as {
    readonly displayName?: string;
    readonly name?: string;
    readonly type?: { readonly name?: string };
  } | null;
  if (!type || (typeof type !== "object" && typeof type !== "function")) return null;
  return type.displayName || type.name || type.type?.name || null;
}

/** The key of the row a component draws in: its own, or its nearest keyed parent's. */
function rowKey(fiber: Fiber): string {
  for (let node: Fiber | null = fiber; node; node = node.return) if (node.key) return node.key;
  return "";
}

Object.assign(globalThis, {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE() {},
    onScheduleFiberRoot() {},
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onCommitFiberRoot(_renderer: number, root: { readonly current: Fiber }) {
      const previous = committed.get(root);
      const next = new WeakSet<Fiber>();
      committed.set(root, next);
      const pending: Fiber[] = [root.current];
      while (pending.length) {
        const fiber = pending.pop()!;
        next.add(fiber);
        const rendered = fiber.flags & performedWork && !previous?.has(fiber);
        const name = counting && rendered ? nameOf(fiber) : null;
        if (counting && name) {
          const byKey = counting.get(name) ?? new Map<string, number>();
          const key = rowKey(fiber);
          byKey.set(key, (byKey.get(key) ?? 0) + 1);
          counting.set(name, byKey);
        }
        if (fiber.child) pending.push(fiber.child);
        if (fiber.sibling) pending.push(fiber.sibling);
      }
    },
  },
});

/** How many times each component drew while `work` ran, by the key of the row it is in. */
export async function countRenders(
  work: () => Promise<void>,
): Promise<ReadonlyMap<string, ReadonlyMap<string, number>>> {
  const counts = new Map<string, Map<string, number>>();
  counting = counts;
  try {
    await work();
  } finally {
    counting = null;
  }
  return counts;
}
