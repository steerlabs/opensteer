import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const maxQuietSeenFileBytes = 4_096;
/** Each Deployment and person this phone has shown quiet moves for; the oldest give way. */
const keptScopes = 16;

const QuietSeenFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  seen: z
    .record(z.string().max(160), z.string().max(40))
    .refine((seen) => Object.keys(seen).length <= keptScopes),
});

export type QuietSeenThrough = Readonly<Record<string, string>>;

/**
 * The newest quiet move this phone has shown, per `quietSeenScope`, so the
 * sidebar's "+N" counts only what it has not. A file that cannot be read has
 * shown nothing; that costs one chip, never a screen.
 */
export interface QuietSeen {
  /** Null until the file has answered. */
  getSnapshot(): QuietSeenThrough | null;
  subscribe(listener: () => void): () => void;
  see(scope: string, through: string): void;
}

export function createQuietSeen(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): QuietSeen {
  let snapshot: QuietSeenThrough | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: QuietSeenThrough) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const merge = (base: QuietSeenThrough, scope: string, through: string): QuietSeenThrough => {
    const current = base[scope];
    if (current !== undefined && current >= through) return base;
    const { [scope]: _previous, ...rest } = base;
    return Object.fromEntries([...Object.entries(rest), [scope, through]].slice(-keptScopes));
  };
  const save = (next: QuietSeenThrough) => {
    const file = QuietSeenFileSchema.safeParse({ schemaVersion: 1, seen: next });
    if (!file.success) return;
    void options.privateFiles
      .writeFileAtomic(options.filePath, JSON.stringify(file.data))
      .catch(() => undefined);
  };
  const early: [string, string][] = [];
  void readQuietSeen(options).then((stored) => {
    const next = early.reduce((seen, [scope, through]) => merge(seen, scope, through), stored);
    publish(next);
    if (next !== stored) save(next);
  });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    see(scope, through) {
      if (snapshot === null) {
        early.push([scope, through]);
        return;
      }
      const next = merge(snapshot, scope, through);
      if (next === snapshot) return;
      publish(next);
      save(next);
    },
  };
}

async function readQuietSeen(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): Promise<QuietSeenThrough> {
  try {
    const stored = await options.privateFiles.readFile(options.filePath, maxQuietSeenFileBytes);
    if (stored === null) return {};
    const parsed = QuietSeenFileSchema.safeParse(
      JSON.parse(new TextDecoder().decode(stored)) as unknown,
    );
    return parsed.success ? parsed.data.seen : {};
  } catch {
    return {};
  }
}
