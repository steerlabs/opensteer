import { z } from "zod";

/** The explicit authority a Workspace receives over one Browser Profile. */
export const BrowserProfileAccessSchema = z.literal("full-control");
export type BrowserProfileAccess = z.infer<typeof BrowserProfileAccessSchema>;
