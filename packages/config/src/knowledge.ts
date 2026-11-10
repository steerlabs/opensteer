import { z } from "zod";

/** The knowledge trial: off unless set, and refused on anything but a Personal Deployment. */
export const KnowledgeEnvironmentSchema = z.object({
  OPENSTEER_KNOWLEDGE: z.preprocess((value) => {
    if (value === undefined || value === "" || value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    return value;
  }, z.boolean()),
});
