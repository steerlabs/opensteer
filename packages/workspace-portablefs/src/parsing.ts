/** Schema parsing that reports PortableFS failures in PortableFS's vocabulary. */

import type { z } from "zod";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { PortableFsError, type PortableFsOperation } from "./errors.js";

export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  operation: PortableFsOperation,
): z.output<TSchema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new PortableFsError({
    code: "invalid_input",
    message: `Invalid PortableFS ${operation} input (${formatIssues(parsed.error.issues)})`,
    operation,
  });
}
