import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const RemovedFromSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
  deploymentName: z.string().min(1).max(160),
});
const RemovedFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  removedFrom: RemovedFromSchema.nullable(),
});

/** The Deployment that removed this phone, until the person chooses Set up again. */
export type RemovedFrom = z.infer<typeof RemovedFromSchema>;

export interface RemovedFile {
  read(): Promise<RemovedFrom | null>;
  write(removedFrom: RemovedFrom | null): Promise<void>;
}

export function createRemovedFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): RemovedFile {
  return {
    async read() {
      try {
        const stored = await options.privateFiles.readFile(options.filePath, 4_096);
        if (stored === null) return null;
        const parsed = RemovedFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success ? parsed.data.removedFrom : null;
      } catch {
        return null;
      }
    },
    async write(removedFrom) {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(RemovedFileSchema.parse({ schemaVersion: 1, removedFrom })),
      );
    },
  };
}
