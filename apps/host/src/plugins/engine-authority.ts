import { Context } from "effect";
import type { PluginCaller } from "./engine-protocol.js";

export const CurrentPluginRequest = Context.Reference<
  { context: PluginCaller; operation: string; plugin?: string; execution?: string } | undefined
>("opensteer/PluginRequest", { defaultValue: () => undefined });
