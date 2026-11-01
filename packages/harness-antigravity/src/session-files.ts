import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const SessionMetadataSchema = z.object({ cwd: z.string() });
const nativeSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isNativeAntigravitySessionId(value: string): boolean {
  return nativeSessionId.test(value);
}

/** Removes only the temporary conversation whose metadata proves our scratch cwd owns it. */
export async function removeTemporaryAntigravitySession(input: {
  readonly cwd: string;
  readonly profileDirectory: string;
  readonly sessionId: string | undefined;
}): Promise<void> {
  if (!input.sessionId || !isNativeAntigravitySessionId(input.sessionId)) return;
  const acp = join(input.profileDirectory, "antigravity-acp");
  const base = join(acp, "conversations", input.sessionId);
  let metadata: z.infer<typeof SessionMetadataSchema>;
  try {
    metadata = SessionMetadataSchema.parse(JSON.parse(await readFile(`${base}.meta`, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.cwd !== input.cwd) {
    throw new Error("Antigravity temporary session ownership did not match its scratch directory");
  }
  await Promise.all(
    [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"].map((suffix) =>
      rm(`${base}${suffix}`, { force: true }),
    ),
  );
  await rm(join(acp, "brain", input.sessionId), { force: true, recursive: true });
}
