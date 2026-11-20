import { BlockedSchema, type Blocked } from "@opensteer/core";
import { agentToolFailureResult, agentToolRecordResult } from "@opensteer/agent-tools";
import { ContentBlockSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HostToolResultSchema, LocalMcpResultSchema } from "./engine-protocol.js";

const outcome = z
  .object({ path: z.string(), ok: z.boolean(), value: z.unknown().optional() })
  .passthrough();
const execution = z
  .object({ ok: z.literal(true), value: z.union([outcome, z.array(outcome)]) })
  .passthrough();
const presentation = z
  .object({ hostPresentation: z.enum(["blocked", "mcp"]), execution })
  .passthrough();
type Outcome = z.infer<typeof outcome>;

function isLocalPath(path: string) {
  return path.startsWith('tools["local-');
}

/** The direct backend envelopes its values before handing them to the engine. */
export function projectDirectPluginTools(
  result: unknown,
  blockedNamespace?: (path: string) => Blocked | undefined,
) {
  const parsed = z.object({ execution }).passthrough().safeParse(result);
  if (!parsed.success) return result;
  let kind: "blocked" | "mcp" | undefined;
  const project = (call: Outcome): Outcome => {
    const blocked = call.ok ? undefined : blockedNamespace?.(call.path);
    if (blocked) {
      kind ??= "blocked";
      return {
        path: call.path,
        ok: false,
        error: blocked,
        ...("callLog" in call ? { callLog: call.callLog } : {}),
      };
    }
    if (!call.ok) return call;
    const local = HostToolResultSchema.safeParse(call.value);
    if (!local.success) return call;
    const { value: _value, ...rest } = call;
    switch (local.data.kind) {
      case "value":
        return { ...rest, value: local.data.value };
      case "blocked":
        kind ??= "blocked";
        return { ...rest, ok: false, error: local.data.blocked };
      case "mcp":
        kind = "mcp";
        return { ...rest, ok: local.data.result.isError !== true, mcp: local.data.result };
    }
  };
  const body = parsed.data.execution;
  const value = Array.isArray(body.value) ? body.value.map(project) : project(body.value);
  return {
    ...parsed.data,
    execution: { ...body, value },
    ...(kind ? { hostPresentation: kind } : {}),
  };
}

export function presentPluginToolResult(record: Record<string, unknown>) {
  const parsed = presentation.safeParse(record.result);
  if (!parsed.success) return agentToolRecordResult(record);
  const { value } = parsed.data.execution;
  const blocked = Array.isArray(value) ? null : BlockedSchema.safeParse(value.error);
  const direct = typeof record.operationId === "string";
  if (!direct && blocked?.success && !Array.isArray(value) && !value.ok)
    return agentToolFailureResult(blocked.data);

  const blocks = (call: Outcome) => {
    const result = LocalMcpResultSchema.safeParse(call.mcp);
    if (!result.success || !isLocalPath(call.path)) return null;
    return { ...result.data, content: z.array(ContentBlockSchema).parse(result.data.content) };
  };
  if (!direct && !Array.isArray(value)) return blocks(value) ?? agentToolRecordResult(record);
  const calls = Array.isArray(value) ? value : [value];
  const attachments = calls.flatMap((call) => blocks(call)?.content ?? []);
  if (!attachments.length) return agentToolRecordResult(record);
  const summary = calls.map(({ mcp, ...call }) => {
    const output = LocalMcpResultSchema.safeParse(mcp);
    return output.success ? { ...call, value: output.data.structuredContent ?? null } : call;
  });
  const formatted = agentToolRecordResult({
    ...record,
    result: {
      ...parsed.data,
      execution: { ...parsed.data.execution, value: Array.isArray(value) ? summary : summary[0] },
    },
  });
  return { ...formatted, content: [...formatted.content, ...attachments] };
}
