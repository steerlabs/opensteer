import { z } from "zod";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const ComputerUseSessionIdSchema = z
  .string()
  .regex(new RegExp(`^cus_${uuid}$`, "i"))
  .brand<"ComputerUseSessionId">();
export type ComputerUseSessionId = z.infer<typeof ComputerUseSessionIdSchema>;
