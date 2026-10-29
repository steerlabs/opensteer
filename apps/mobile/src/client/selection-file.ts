import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import type { PrivateFilesystem } from "@opensteer/client/connections";
import { z } from "zod";

const maxSelectionFileBytes = 1_024;

const SelectionFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  selectedDeploymentId: DeploymentIdSchema.nullable(),
});

/**
 * Which Deployment the app opens on, remembered across launches.
 *
 * The catalog has a selection of its own, but it is the record of what was
 * *used* last and is rewritten by directory syncs and reconciliation. What the
 * phone needs is narrower: the one place the person was, so relaunching does
 * not drop them back on the list. Keeping it in its own file means an
 * unreadable preference costs a screen, never a catalog.
 */
export interface SelectionFile {
  /** `undefined` means this phone has never made a selection decision. */
  read(): Promise<DeploymentId | null | undefined>;
  write(deploymentId: DeploymentId | null): Promise<void>;
}

export function createSelectionFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): SelectionFile {
  return {
    async read(): Promise<DeploymentId | null | undefined> {
      const stored = await options.privateFiles.readFile(options.filePath, maxSelectionFileBytes);
      if (stored === null) return undefined;
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(stored));
      } catch {
        return null;
      }
      const parsed = SelectionFileSchema.safeParse(decoded);
      return parsed.success ? parsed.data.selectedDeploymentId : null;
    },

    async write(deploymentId): Promise<void> {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(
          SelectionFileSchema.parse({ schemaVersion: 1, selectedDeploymentId: deploymentId }),
        ),
      );
    },
  };
}
