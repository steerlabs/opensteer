import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const maxSidebarFileBytes = 1_024;

const SidebarFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hidden: z.boolean(),
});

/**
 * Whether the reader hid the docked sidebar, remembered on this phone across
 * launches and Deployments. It is a choice, not a fact about the window: where
 * there is no room to dock, the sidebar is a drawer whatever this says. A
 * preference that cannot be read leaves the sidebar shown.
 */
export interface SidebarFile {
  read(): Promise<boolean>;
  write(hidden: boolean): Promise<void>;
}

export function createSidebarFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): SidebarFile {
  return {
    async read(): Promise<boolean> {
      try {
        const stored = await options.privateFiles.readFile(options.filePath, maxSidebarFileBytes);
        if (stored === null) return false;
        const parsed = SidebarFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success && parsed.data.hidden;
      } catch {
        return false;
      }
    },

    async write(hidden): Promise<void> {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(SidebarFileSchema.parse({ hidden, schemaVersion: 1 })),
      );
    },
  };
}
