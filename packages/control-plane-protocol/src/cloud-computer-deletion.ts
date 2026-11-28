import { z } from "zod";

export const CloudComputerDeletionSchema = z.strictObject({
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  computerDestroyedAt: z.iso.datetime().nullable(),
  backupsUnreadableAt: z.iso.datetime().nullable(),
  storedBackupDataRemovedAt: z.iso.datetime().nullable(),
});

export type CloudComputerDeletion = z.infer<typeof CloudComputerDeletionSchema>;
