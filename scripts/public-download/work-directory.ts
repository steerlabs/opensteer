import path from "node:path";
import { z } from "zod";

export function journeyWorkDirectory(): string {
  return z
    .string()
    .refine(path.isAbsolute, "OPENSTEER_UPDATE_JOURNEY_DIR must be absolute")
    .parse(process.env.OPENSTEER_UPDATE_JOURNEY_DIR);
}
