import type { PrivateFilesystem } from "@opensteer/client/connections";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { z } from "zod";

const maxSignedOutFileBytes = 64 * 1_024;

const SignedOutFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deploymentIds: z.array(DeploymentIdSchema),
});

/** Deployments whose explicit sign-out must survive an app restart. */
export interface SignedOutFile {
  read(): Promise<readonly DeploymentId[]>;
  write(deploymentIds: readonly DeploymentId[]): Promise<void>;
}

export function createSignedOutFile(options: {
  readonly filePath: string;
  readonly privateFiles: PrivateFilesystem;
}): SignedOutFile {
  return {
    async read(): Promise<readonly DeploymentId[]> {
      try {
        const stored = await options.privateFiles.readFile(options.filePath, maxSignedOutFileBytes);
        if (stored === null) return [];
        const parsed = SignedOutFileSchema.safeParse(
          JSON.parse(new TextDecoder().decode(stored)) as unknown,
        );
        return parsed.success ? [...new Set(parsed.data.deploymentIds)] : [];
      } catch {
        // A preference that cannot be read must never prevent the app opening.
        return [];
      }
    },

    async write(deploymentIds): Promise<void> {
      await options.privateFiles.writeFileAtomic(
        options.filePath,
        JSON.stringify(
          SignedOutFileSchema.parse({
            deploymentIds: [...new Set(deploymentIds)].sort(),
            schemaVersion: 1,
          }),
        ),
      );
    },
  };
}
