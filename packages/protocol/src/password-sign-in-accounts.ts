import { z } from "zod";
/** A saved login the person can choose for a site; never its password. */
export const PasswordsBrokerAccountSchema = z.strictObject({
  host: z.string().min(1).max(253),
  id: z.uuid(),
  onPage: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
  label: z.string().min(1).max(200).nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  username: z.string().max(1_024),
});
export type PasswordsBrokerAccount = z.infer<typeof PasswordsBrokerAccountSchema>;
export const PasswordsBrokerAccountsSchema = z.array(PasswordsBrokerAccountSchema).max(100);
