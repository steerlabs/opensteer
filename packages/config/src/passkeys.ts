import { z } from "zod";

export const PasskeysEnvironmentSchema = z.object({
  OPENSTEER_PASSKEYS: z.preprocess((value) => {
    if (value === undefined || value === "" || value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
    return value;
  }, z.boolean()),
});
