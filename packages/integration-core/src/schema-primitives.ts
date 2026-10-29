import { z } from "zod";

/** JSON-shaped metadata and JSON Schemas may carry keywords this build does not know yet. */
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const McpIdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "MCP names cannot contain a null byte");
