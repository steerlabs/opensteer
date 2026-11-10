import type { ThreadReachScope } from "@opensteer/core";
import { z } from "zod";

export const OpensteerAgentSkillNameSchema = z.enum([
  "opensteer:integrations",
  "opensteer:computer-use",
  "opensteer:projects",
  "opensteer:threads",
  "opensteer:triggers",
  "opensteer:browser",
  "opensteer:computers",
  "opensteer:devices",
  "opensteer:skills",
  "opensteer:memory",
  "opensteer:knowledge",
]);
export type OpensteerAgentSkillName = z.infer<typeof OpensteerAgentSkillNameSchema>;

/** The skills bundled with every Runner. */
export const opensteerAgentSkillNames: readonly OpensteerAgentSkillName[] = Object.freeze([
  ...OpensteerAgentSkillNameSchema.options,
]);

/**
 * Personal memory lives in Main; Project and specialist Runs never receive it.
 * Knowledge goes with the `sql` tool, which only Main-inheriting Runs hold.
 */
export function opensteerAgentSkillsFor(
  reach: ThreadReachScope["kind"],
  options: { readonly knowledge?: boolean } = {},
): readonly OpensteerAgentSkillName[] {
  return opensteerAgentSkillNames.filter(
    (name) =>
      (name !== "opensteer:memory" || reach === "user") &&
      (name !== "opensteer:knowledge" || (reach === "user" && options.knowledge === true)),
  );
}
