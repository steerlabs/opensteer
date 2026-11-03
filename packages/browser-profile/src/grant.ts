import { z } from "zod";

/** The explicit authority a Workspace receives over one Browser Profile. */
export const BrowserProfileAccessSchema = z.enum(["read", "read-write"]);
export type BrowserProfileAccess = z.infer<typeof BrowserProfileAccessSchema>;
