import { OpensteerError } from "@opensteer/core";
import { TriggerSourceSchema, type TriggerSource, type TriggerSourceInput } from "./models.js";

/**
 * The agent-facing Trigger tool schemas are flat and union-free so every model
 * runtime can carry them. Per-action requiredness and the schedule/webhook
 * source shape are therefore Host contracts, enforced here — once, in the
 * package that owns both the flat tool shape and the internal one.
 */
export function requiredTriggerToolField<Value>(
  value: Value | undefined,
  field: string,
  context: { readonly action: string; readonly tool: string },
): Value {
  if (value === undefined) {
    throw badRequest(`${context.tool} action "${context.action}" requires ${field}`);
  }
  return value;
}

const scheduleOnlyFields = ["at", "cron", "payload", "timezone"] as const;

export function triggerSourceFromInput(input: TriggerSourceInput): TriggerSource {
  if (input.kind === "webhook" || input.kind === "watch") {
    const rejected = scheduleOnlyFields.filter((field) => input[field] !== undefined);
    if (rejected.length > 0) {
      throw badRequest(`source kind "${input.kind}" does not accept ${rejected.join(", ")}`);
    }
    return TriggerSourceSchema.parse({ kind: input.kind });
  }
  if ((input.at === undefined) === (input.cron === undefined)) {
    throw badRequest('source kind "schedule" requires exactly one of at or cron');
  }
  if (input.cron !== undefined) {
    if (input.timezone === undefined) {
      throw badRequest('source kind "schedule" with cron requires timezone as an IANA name');
    }
    return TriggerSourceSchema.parse({
      kind: "schedule",
      schedule: {
        expression: input.cron,
        kind: "cron",
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        timezone: input.timezone,
      },
    });
  }
  if (input.timezone !== undefined) {
    throw badRequest("source timezone applies only to a cron schedule");
  }
  return TriggerSourceSchema.parse({
    kind: "schedule",
    schedule: {
      at: input.at,
      kind: "at",
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    },
  });
}

function badRequest(message: string): OpensteerError {
  return new OpensteerError({ code: "bad_request", message });
}
