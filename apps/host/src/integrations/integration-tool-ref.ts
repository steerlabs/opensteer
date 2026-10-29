import { IntegrationGrantIdSchema, IntegrationToolIdSchema } from "@opensteer/integration-core";
import { z } from "zod";

/**
 * The opaque toolRef integration search hands a model: the grant, the tool and
 * the digest of the schema the model was shown, joined by dots. The gateway
 * resolves it to call a tool, and the Host resolves it to name what a recorded
 * call addressed; both read it here.
 */
export const IntegrationToolRefSchema = z.preprocess(
  (toolRef) => {
    if (typeof toolRef !== "string") return toolRef;
    const [grantId, toolId, schemaDigest] = toolRef.split(".");
    return { grantId, schemaDigest, toolId };
  },
  z.object({
    grantId: IntegrationGrantIdSchema,
    schemaDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    toolId: IntegrationToolIdSchema,
  }),
);
export type IntegrationToolRef = z.output<typeof IntegrationToolRefSchema>;
