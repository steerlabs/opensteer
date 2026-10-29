import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const maxDoneShelfFileBytes = 1_024;

const DoneShelfFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  open: z.boolean(),
});

/**
 * Whether the sidebar's Done shelf is open, remembered on this phone across
 * launches and Deployments. It starts closed, and a preference that cannot be
 * read is closed too: the tasks behind it are a tap away either way.
 */
export interface DoneShelfFile {
  read(): Promise<boolean>;
  write(open: boolean): Promise<void>;
}

export function createDoneShelfFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): DoneShelfFile {
  return {
    async read(): Promise<boolean> {
      try {
        const stored = await options.privateFiles.readFile(options.filePath, maxDoneShelfFileBytes);
        if (stored === null) return false;
        const parsed = DoneShelfFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success && parsed.data.open;
      } catch {
        return false;
      }
    },

    async write(open): Promise<void> {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(DoneShelfFileSchema.parse({ open, schemaVersion: 1 })),
      );
    },
  };
}
